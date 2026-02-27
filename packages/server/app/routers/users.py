"""User profile and per-user provider configuration API.

Endpoints:
  GET    /v1/users/me/profile                   current user profile
  PUT    /v1/users/me/profile                   update profile (display_name, slack_id)
  GET    /v1/users/me/providers                 list user's own provider configs (masked)
  PUT    /v1/users/me/providers/{provider_id}   upsert user's provider API key
  DELETE /v1/users/me/providers/{provider_id}   remove user's provider config
  GET    /v1/users/me/secrets                   list user's accessible secrets
"""

import json
import uuid
from typing import Optional, Dict, List

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from sqlalchemy import select, or_
from sqlalchemy.ext.asyncio import AsyncSession

from app.database import get_async_session
from app.auth.dependencies import get_current_user, AuthUser
from app.models.auth import User
from app.models.settings import ModelProvider
from app.models.user_provider import (
    UserModelProvider,
    AdminSharedProvider,
    UserSecretGrant,
)
from app.models.secret import Secret
from app.models.base import now_ms
from app.logging_config import get_logger

logger = get_logger(__name__)

router = APIRouter()


# ── Schemas ───────────────────────────────────────────────────────────────────


class UserProfile(BaseModel):
    id: str
    email: str
    displayName: Optional[str] = None
    isAdmin: bool
    slackId: Optional[str] = None
    phoneNumber: Optional[str] = None
    totpEnabled: bool


class UpdateProfileRequest(BaseModel):
    displayName: Optional[str] = None
    slackId: Optional[str] = None
    phoneNumber: Optional[str] = None


class UserProviderConfig(BaseModel):
    providerId: str
    enabled: bool = True
    apiKey: Optional[str] = None
    extraConfig: Optional[Dict[str, str]] = None


class UserProviderResponse(BaseModel):
    providerId: str
    enabled: bool
    configured: bool
    maskedApiKey: Optional[str] = None
    maskedExtraConfig: Optional[Dict[str, str]] = None
    # Whether this provider is available via admin sharing (not user's own key)
    sharedByAdmin: bool = False


# ── Helpers ───────────────────────────────────────────────────────────────────


def _mask_key(key: str) -> str:
    if not key or len(key) < 8:
        return "***"
    return f"{key[:8]}...{key[-4:]}"


# ── Profile endpoints ─────────────────────────────────────────────────────────


@router.get("/me/profile", response_model=UserProfile)
async def get_profile(
    user: AuthUser = Depends(get_current_user),
    session: AsyncSession = Depends(get_async_session),
) -> UserProfile:
    """Get the current user's profile."""
    db_user = await session.get(User, user.id)
    if not db_user:
        raise HTTPException(status_code=404, detail="User not found")
    return UserProfile(
        id=db_user.id,
        email=db_user.email,
        displayName=db_user.display_name,
        isAdmin=db_user.is_admin,
        slackId=db_user.slack_id,
        phoneNumber=getattr(db_user, "phone_number", None),
        totpEnabled=db_user.totp_enabled,
    )


@router.put("/me/profile", response_model=UserProfile)
async def update_profile(
    body: UpdateProfileRequest,
    user: AuthUser = Depends(get_current_user),
    session: AsyncSession = Depends(get_async_session),
) -> UserProfile:
    """Update the current user's profile."""
    db_user = await session.get(User, user.id)
    if not db_user:
        raise HTTPException(status_code=404, detail="User not found")

    if body.displayName is not None:
        db_user.display_name = body.displayName.strip()
    if body.slackId is not None:
        db_user.slack_id = body.slackId.strip() or None
    if body.phoneNumber is not None:
        db_user.phone_number = body.phoneNumber.strip() or None
    db_user.updated_at = now_ms()

    await session.commit()
    await session.refresh(db_user)
    return UserProfile(
        id=db_user.id,
        email=db_user.email,
        displayName=db_user.display_name,
        isAdmin=db_user.is_admin,
        slackId=db_user.slack_id,
        phoneNumber=getattr(db_user, "phone_number", None),
        totpEnabled=db_user.totp_enabled,
    )


# ── User provider endpoints ──────────────────────────────────────────────────


@router.get("/me/providers", response_model=List[UserProviderResponse])
async def list_user_providers(
    user: AuthUser = Depends(get_current_user),
    session: AsyncSession = Depends(get_async_session),
) -> List[UserProviderResponse]:
    """List the current user's provider configurations + admin-shared providers."""
    # 1. User's own provider configs
    result = await session.execute(
        select(UserModelProvider).where(UserModelProvider.user_id == user.id)
    )
    user_providers = {row.provider_id: row for row in result.scalars().all()}

    # 2. Admin-shared providers accessible to this user
    result = await session.execute(
        select(AdminSharedProvider).where(
            or_(
                AdminSharedProvider.target_user_id == user.id,
                AdminSharedProvider.target_user_id == None,  # broadcast
            )
        )
    )
    shared_provider_ids = {row.provider_id for row in result.scalars().all()}

    # Build response — combine user's own + shared
    responses: List[UserProviderResponse] = []

    # User's own configs
    for provider_id, row in user_providers.items():
        extra = {}
        if row.extra_config:
            try:
                extra = json.loads(row.extra_config)
            except (json.JSONDecodeError, TypeError):
                pass
        responses.append(
            UserProviderResponse(
                providerId=provider_id,
                enabled=row.enabled,
                configured=bool(row.api_key),
                maskedApiKey=_mask_key(row.api_key) if row.api_key else None,
                maskedExtraConfig={k: _mask_key(v) for k, v in extra.items() if v}
                if extra
                else None,
                sharedByAdmin=False,
            )
        )

    # Admin-shared providers (only those the user doesn't have their own config for)
    for provider_id in shared_provider_ids:
        if provider_id not in user_providers:
            responses.append(
                UserProviderResponse(
                    providerId=provider_id,
                    enabled=True,
                    configured=True,
                    maskedApiKey=None,  # Don't expose admin's key details
                    sharedByAdmin=True,
                )
            )

    return responses


@router.put("/me/providers/{provider_id}")
async def upsert_user_provider(
    provider_id: str,
    config: UserProviderConfig,
    user: AuthUser = Depends(get_current_user),
    session: AsyncSession = Depends(get_async_session),
) -> UserProviderResponse:
    """Add or update the user's own API key for a provider."""
    now = now_ms()
    row = await session.get(UserModelProvider, (user.id, provider_id))
    if row:
        row.enabled = config.enabled
        if config.apiKey:
            row.api_key = config.apiKey
        if config.extraConfig:
            existing = {}
            if row.extra_config:
                try:
                    existing = json.loads(row.extra_config)
                except (json.JSONDecodeError, TypeError):
                    pass
            merged = {**existing}
            for k, v in config.extraConfig.items():
                if v:
                    merged[k] = v
                elif k in merged:
                    del merged[k]
            row.extra_config = json.dumps(merged) if merged else None
        row.updated_at = now
    else:
        row = UserModelProvider(
            user_id=user.id,
            provider_id=provider_id,
            enabled=config.enabled,
            api_key=config.apiKey or None,
            extra_config=json.dumps(config.extraConfig) if config.extraConfig else None,
            created_at=now,
            updated_at=now,
        )
        session.add(row)

    await session.commit()
    await session.refresh(row)

    extra = {}
    if row.extra_config:
        try:
            extra = json.loads(row.extra_config)
        except (json.JSONDecodeError, TypeError):
            pass

    return UserProviderResponse(
        providerId=provider_id,
        enabled=row.enabled,
        configured=bool(row.api_key),
        maskedApiKey=_mask_key(row.api_key) if row.api_key else None,
        maskedExtraConfig={k: _mask_key(v) for k, v in extra.items() if v}
        if extra
        else None,
        sharedByAdmin=False,
    )


@router.delete("/me/providers/{provider_id}")
async def remove_user_provider(
    provider_id: str,
    user: AuthUser = Depends(get_current_user),
    session: AsyncSession = Depends(get_async_session),
) -> dict:
    """Remove the user's own provider configuration."""
    row = await session.get(UserModelProvider, (user.id, provider_id))
    if row:
        await session.delete(row)
        await session.commit()
    return {"status": "ok", "providerId": provider_id}


# ── Slack ID lookup (used by Slack bridge) ────────────────────────────────────


@router.get("/by-slack-id/{slack_id}")
async def get_user_by_slack_id(
    slack_id: str,
    session: AsyncSession = Depends(get_async_session),
) -> dict:
    """Look up a DjinnBot user by their Slack member ID.

    Called by the Slack bridge to cross-reference incoming Slack messages
    with DjinnBot user accounts for per-user key resolution.
    This endpoint does not require authentication — it only returns the user ID.
    """
    result = await session.execute(select(User).where(User.slack_id == slack_id))
    user_row = result.scalar_one_or_none()
    if not user_row:
        raise HTTPException(status_code=404, detail="No user with this Slack ID")
    return {"userId": user_row.id, "email": user_row.email}


# ── User secrets (accessible secrets) ─────────────────────────────────────────


@router.get("/me/secrets")
async def list_user_accessible_secrets(
    user: AuthUser = Depends(get_current_user),
    session: AsyncSession = Depends(get_async_session),
) -> List[dict]:
    """List secrets the current user has access to.

    Includes:
      - User's own secrets (scope='user', owner_user_id=current user)
      - Instance secrets granted to the user via user_secret_grants
    """
    # User-owned secrets
    result = await session.execute(
        select(Secret).where(
            Secret.scope == "user",
            Secret.owner_user_id == user.id,
        )
    )
    user_secrets = result.scalars().all()

    # Instance secrets granted to this user
    result = await session.execute(
        select(Secret)
        .join(UserSecretGrant, UserSecretGrant.secret_id == Secret.id)
        .where(
            Secret.scope == "instance",
            UserSecretGrant.user_id == user.id,
        )
    )
    granted_secrets = result.scalars().all()

    secrets = []
    for s in user_secrets:
        secrets.append(
            {
                "id": s.id,
                "name": s.name,
                "description": s.description,
                "secretType": s.secret_type,
                "envKey": s.env_key,
                "maskedPreview": s.masked_preview,
                "scope": s.scope,
                "isOwned": True,
                "createdAt": s.created_at,
                "updatedAt": s.updated_at,
            }
        )
    for s in granted_secrets:
        secrets.append(
            {
                "id": s.id,
                "name": s.name,
                "description": s.description,
                "secretType": s.secret_type,
                "envKey": s.env_key,
                "maskedPreview": s.masked_preview,
                "scope": s.scope,
                "isOwned": False,
                "createdAt": s.created_at,
                "updatedAt": s.updated_at,
            }
        )

    return secrets
