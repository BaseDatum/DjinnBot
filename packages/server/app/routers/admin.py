"""Admin panel API — user management, key sharing, approvals, instance secrets.

All endpoints require admin access (``get_current_admin`` dependency).

Endpoints:
  User management:
    GET    /v1/admin/users                            list all users
    POST   /v1/admin/users                            create a new user
    PUT    /v1/admin/users/{user_id}                  update user (role, active)
    DELETE /v1/admin/users/{user_id}                  deactivate user

  Key sharing:
    GET    /v1/admin/shared-providers                 list admin's shared provider grants
    POST   /v1/admin/shared-providers                 share provider key with user(s)
    DELETE /v1/admin/shared-providers/{grant_id}      revoke a share

  Approval workflow:
    GET    /v1/admin/pending-approvals                list pending skills + MCP servers
    PATCH  /v1/admin/skills/{skill_id}/approve        approve a skill
    PATCH  /v1/admin/skills/{skill_id}/reject         reject a skill
    PATCH  /v1/admin/mcp/{server_id}/approve          approve an MCP server
    PATCH  /v1/admin/mcp/{server_id}/reject           reject an MCP server

  Instance secrets:
    POST   /v1/admin/secrets/{secret_id}/grant-user/{user_id}   grant instance secret to user
    DELETE /v1/admin/secrets/{secret_id}/grant-user/{user_id}   revoke
"""

import uuid
from typing import Optional, List

from fastapi import APIRouter, Depends, HTTPException, status
from pydantic import BaseModel, Field
from sqlalchemy import select, func
from sqlalchemy.ext.asyncio import AsyncSession

from app.database import get_async_session
from app.auth.dependencies import get_current_admin, AuthUser
from app.auth.passwords import hash_password
from app.models.auth import User
from app.models.user_provider import AdminSharedProvider, UserSecretGrant
from app.models.secret import Secret
from app.models.skill import Skill
from app.models.mcp import McpServer
from app.models.base import now_ms
from app.logging_config import get_logger

logger = get_logger(__name__)

router = APIRouter()


# ── Schemas ───────────────────────────────────────────────────────────────────


class CreateUserRequest(BaseModel):
    email: str
    password: str = Field(min_length=8)
    displayName: Optional[str] = None
    isAdmin: bool = False


class UpdateUserRequest(BaseModel):
    displayName: Optional[str] = None
    isAdmin: Optional[bool] = None
    isActive: Optional[bool] = None


class UserResponse(BaseModel):
    id: str
    email: str
    displayName: Optional[str]
    isAdmin: bool
    isActive: bool
    slackId: Optional[str]
    totpEnabled: bool
    createdAt: int
    updatedAt: int


class ShareProviderRequest(BaseModel):
    """Share a provider key with a specific user or all users."""

    providerId: str
    # NULL = share with all users (broadcast)
    targetUserId: Optional[str] = None
    # Granularity controls
    expiresAt: Optional[int] = None  # Unix ms timestamp — NULL = never expires
    allowedModels: Optional[list] = None  # e.g. ["claude-sonnet-4", "claude-haiku-3-5"]
    dailyLimit: Optional[int] = None  # Max requests per day — NULL = unlimited


class SharedProviderResponse(BaseModel):
    id: str
    adminUserId: str
    providerId: str
    targetUserId: Optional[str]
    createdAt: int
    expiresAt: Optional[int] = None
    allowedModels: Optional[list] = None
    dailyLimit: Optional[int] = None


class PendingApprovalItem(BaseModel):
    id: str
    type: str  # 'skill' or 'mcp'
    name: str
    description: str
    submittedByUserId: Optional[str]
    createdAt: int


# ── Helpers ───────────────────────────────────────────────────────────────────


def _user_to_response(u: User) -> UserResponse:
    return UserResponse(
        id=u.id,
        email=u.email,
        displayName=u.display_name,
        isAdmin=u.is_admin,
        isActive=u.is_active,
        slackId=u.slack_id,
        totpEnabled=u.totp_enabled,
        createdAt=u.created_at,
        updatedAt=u.updated_at,
    )


def _gen_id(prefix: str) -> str:
    return f"{prefix}_{uuid.uuid4().hex[:12]}"


# ═════════════════════════════════════════════════════════════════════════════
#  USER MANAGEMENT
# ═════════════════════════════════════════════════════════════════════════════


@router.get("/users", response_model=List[UserResponse])
async def list_users(
    admin: AuthUser = Depends(get_current_admin),
    session: AsyncSession = Depends(get_async_session),
) -> List[UserResponse]:
    """List all users."""
    result = await session.execute(select(User).order_by(User.created_at.desc()))
    return [_user_to_response(u) for u in result.scalars().all()]


@router.post("/users", response_model=UserResponse, status_code=201)
async def create_user(
    body: CreateUserRequest,
    admin: AuthUser = Depends(get_current_admin),
    session: AsyncSession = Depends(get_async_session),
) -> UserResponse:
    """Create a new user account (admin only)."""
    # Check email uniqueness
    existing = await session.execute(
        select(User).where(User.email == body.email.lower().strip())
    )
    if existing.scalar_one_or_none():
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail=f"User with email '{body.email}' already exists",
        )

    now = now_ms()
    user = User(
        id=_gen_id("usr"),
        email=body.email.lower().strip(),
        display_name=body.displayName or body.email.split("@")[0],
        password_hash=hash_password(body.password),
        is_active=True,
        is_admin=body.isAdmin,
        totp_enabled=False,
        created_at=now,
        updated_at=now,
    )
    session.add(user)
    await session.commit()
    await session.refresh(user)
    logger.info(f"Admin {admin.id} created user {user.id} ({user.email})")
    return _user_to_response(user)


@router.put("/users/{user_id}", response_model=UserResponse)
async def update_user(
    user_id: str,
    body: UpdateUserRequest,
    admin: AuthUser = Depends(get_current_admin),
    session: AsyncSession = Depends(get_async_session),
) -> UserResponse:
    """Update a user's role or active status."""
    user = await session.get(User, user_id)
    if not user:
        raise HTTPException(status_code=404, detail="User not found")

    if body.displayName is not None:
        user.display_name = body.displayName.strip()
    if body.isAdmin is not None:
        # Prevent admin from removing their own admin status
        if user_id == admin.id and not body.isAdmin:
            raise HTTPException(
                status_code=400,
                detail="Cannot remove your own admin privileges",
            )
        user.is_admin = body.isAdmin
    if body.isActive is not None:
        # Prevent admin from deactivating themselves
        if user_id == admin.id and not body.isActive:
            raise HTTPException(
                status_code=400,
                detail="Cannot deactivate your own account",
            )
        user.is_active = body.isActive
    user.updated_at = now_ms()

    await session.commit()
    await session.refresh(user)
    logger.info(f"Admin {admin.id} updated user {user_id}")
    return _user_to_response(user)


@router.delete("/users/{user_id}")
async def deactivate_user(
    user_id: str,
    admin: AuthUser = Depends(get_current_admin),
    session: AsyncSession = Depends(get_async_session),
) -> dict:
    """Deactivate a user (soft delete)."""
    if user_id == admin.id:
        raise HTTPException(
            status_code=400, detail="Cannot deactivate your own account"
        )
    user = await session.get(User, user_id)
    if not user:
        raise HTTPException(status_code=404, detail="User not found")
    user.is_active = False
    user.updated_at = now_ms()
    await session.commit()
    logger.info(f"Admin {admin.id} deactivated user {user_id}")
    return {"status": "deactivated", "userId": user_id}


# ═════════════════════════════════════════════════════════════════════════════
#  KEY SHARING
# ═════════════════════════════════════════════════════════════════════════════


@router.get("/shared-providers", response_model=List[SharedProviderResponse])
async def list_shared_providers(
    admin: AuthUser = Depends(get_current_admin),
    session: AsyncSession = Depends(get_async_session),
) -> List[SharedProviderResponse]:
    """List all provider key shares."""
    result = await session.execute(
        select(AdminSharedProvider).order_by(AdminSharedProvider.created_at.desc())
    )
    import json as _json

    return [
        SharedProviderResponse(
            id=row.id,
            adminUserId=row.admin_user_id,
            providerId=row.provider_id,
            targetUserId=row.target_user_id,
            createdAt=row.created_at,
            expiresAt=row.expires_at,
            allowedModels=_json.loads(row.allowed_models)
            if row.allowed_models
            else None,
            dailyLimit=row.daily_limit,
        )
        for row in result.scalars().all()
    ]


@router.post(
    "/shared-providers", response_model=SharedProviderResponse, status_code=201
)
async def share_provider(
    body: ShareProviderRequest,
    admin: AuthUser = Depends(get_current_admin),
    session: AsyncSession = Depends(get_async_session),
) -> SharedProviderResponse:
    """Share an instance-level provider key with a specific user or all users.

    If target_user_id is None, this is a broadcast share (all users can use
    this provider's instance key).
    """
    # Validate target user exists if specified
    if body.targetUserId:
        target = await session.get(User, body.targetUserId)
        if not target:
            raise HTTPException(status_code=404, detail="Target user not found")

    # Check for duplicate
    existing = await session.execute(
        select(AdminSharedProvider).where(
            AdminSharedProvider.provider_id == body.providerId,
            AdminSharedProvider.target_user_id == body.targetUserId,
        )
    )
    if existing.scalar_one_or_none():
        raise HTTPException(
            status_code=409,
            detail="This provider is already shared with this user/broadcast",
        )

    import json as _json

    now = now_ms()
    share = AdminSharedProvider(
        id=_gen_id("asp"),
        admin_user_id=admin.id,
        provider_id=body.providerId,
        target_user_id=body.targetUserId,
        created_at=now,
        expires_at=body.expiresAt,
        allowed_models=_json.dumps(body.allowedModels) if body.allowedModels else None,
        daily_limit=body.dailyLimit,
    )
    session.add(share)
    await session.commit()
    await session.refresh(share)

    target_desc = body.targetUserId or "all users"
    logger.info(
        f"Admin {admin.id} shared provider '{body.providerId}' with {target_desc}"
    )
    return SharedProviderResponse(
        id=share.id,
        adminUserId=share.admin_user_id,
        providerId=share.provider_id,
        targetUserId=share.target_user_id,
        createdAt=share.created_at,
        expiresAt=share.expires_at,
        allowedModels=_json.loads(share.allowed_models)
        if share.allowed_models
        else None,
        dailyLimit=share.daily_limit,
    )


@router.delete("/shared-providers/{grant_id}")
async def revoke_shared_provider(
    grant_id: str,
    admin: AuthUser = Depends(get_current_admin),
    session: AsyncSession = Depends(get_async_session),
) -> dict:
    """Revoke a provider key share."""
    share = await session.get(AdminSharedProvider, grant_id)
    if not share:
        raise HTTPException(status_code=404, detail="Share not found")
    await session.delete(share)
    await session.commit()
    logger.info(f"Admin {admin.id} revoked provider share {grant_id}")
    return {"status": "revoked", "id": grant_id}


# ═════════════════════════════════════════════════════════════════════════════
#  APPROVAL WORKFLOW
# ═════════════════════════════════════════════════════════════════════════════


@router.get("/pending-approvals", response_model=List[PendingApprovalItem])
async def list_pending_approvals(
    admin: AuthUser = Depends(get_current_admin),
    session: AsyncSession = Depends(get_async_session),
) -> List[PendingApprovalItem]:
    """List all pending skills and MCP servers awaiting admin approval."""
    items: List[PendingApprovalItem] = []

    # Pending skills
    result = await session.execute(
        select(Skill).where(Skill.approval_status == "pending")
    )
    for s in result.scalars().all():
        items.append(
            PendingApprovalItem(
                id=s.id,
                type="skill",
                name=s.id,
                description=s.description,
                submittedByUserId=s.submitted_by_user_id,
                createdAt=s.created_at,
            )
        )

    # Pending MCP servers
    result = await session.execute(
        select(McpServer).where(McpServer.approval_status == "pending")
    )
    for m in result.scalars().all():
        items.append(
            PendingApprovalItem(
                id=m.id,
                type="mcp",
                name=m.name,
                description=m.description,
                submittedByUserId=m.submitted_by_user_id,
                createdAt=m.created_at,
            )
        )

    return items


@router.patch("/skills/{skill_id}/approve")
async def approve_skill(
    skill_id: str,
    admin: AuthUser = Depends(get_current_admin),
    session: AsyncSession = Depends(get_async_session),
) -> dict:
    """Approve a pending skill."""
    skill = await session.get(Skill, skill_id)
    if not skill:
        raise HTTPException(status_code=404, detail="Skill not found")
    if skill.approval_status != "pending":
        raise HTTPException(status_code=400, detail="Skill is not pending approval")
    skill.approval_status = "approved"
    skill.updated_at = now_ms()
    await session.commit()
    logger.info(f"Admin {admin.id} approved skill '{skill_id}'")
    return {"status": "approved", "id": skill_id}


@router.patch("/skills/{skill_id}/reject")
async def reject_skill(
    skill_id: str,
    admin: AuthUser = Depends(get_current_admin),
    session: AsyncSession = Depends(get_async_session),
) -> dict:
    """Reject a pending skill."""
    skill = await session.get(Skill, skill_id)
    if not skill:
        raise HTTPException(status_code=404, detail="Skill not found")
    if skill.approval_status != "pending":
        raise HTTPException(status_code=400, detail="Skill is not pending approval")
    skill.approval_status = "rejected"
    skill.updated_at = now_ms()
    await session.commit()
    logger.info(f"Admin {admin.id} rejected skill '{skill_id}'")
    return {"status": "rejected", "id": skill_id}


@router.patch("/mcp/{server_id}/approve")
async def approve_mcp_server(
    server_id: str,
    admin: AuthUser = Depends(get_current_admin),
    session: AsyncSession = Depends(get_async_session),
) -> dict:
    """Approve a pending MCP server."""
    server = await session.get(McpServer, server_id)
    if not server:
        raise HTTPException(status_code=404, detail="MCP server not found")
    if server.approval_status != "pending":
        raise HTTPException(status_code=400, detail="Server is not pending approval")
    server.approval_status = "approved"
    server.updated_at = now_ms()
    await session.commit()
    logger.info(f"Admin {admin.id} approved MCP server '{server_id}'")
    return {"status": "approved", "id": server_id}


@router.patch("/mcp/{server_id}/reject")
async def reject_mcp_server(
    server_id: str,
    admin: AuthUser = Depends(get_current_admin),
    session: AsyncSession = Depends(get_async_session),
) -> dict:
    """Reject a pending MCP server."""
    server = await session.get(McpServer, server_id)
    if not server:
        raise HTTPException(status_code=404, detail="MCP server not found")
    if server.approval_status != "pending":
        raise HTTPException(status_code=400, detail="Server is not pending approval")
    server.approval_status = "rejected"
    server.updated_at = now_ms()
    await session.commit()
    logger.info(f"Admin {admin.id} rejected MCP server '{server_id}'")
    return {"status": "rejected", "id": server_id}


# ═════════════════════════════════════════════════════════════════════════════
#  INSTANCE SECRET GRANTS (admin → user)
# ═════════════════════════════════════════════════════════════════════════════


@router.post("/secrets/{secret_id}/grant-user/{user_id}", status_code=201)
async def grant_instance_secret_to_user(
    secret_id: str,
    user_id: str,
    admin: AuthUser = Depends(get_current_admin),
    session: AsyncSession = Depends(get_async_session),
) -> dict:
    """Grant an instance-level secret to a user."""
    secret = await session.get(Secret, secret_id)
    if not secret:
        raise HTTPException(status_code=404, detail="Secret not found")
    if secret.scope != "instance":
        raise HTTPException(
            status_code=400,
            detail="Only instance-level secrets can be granted to users",
        )

    target = await session.get(User, user_id)
    if not target:
        raise HTTPException(status_code=404, detail="User not found")

    # Check for existing grant (idempotent)
    existing = await session.execute(
        select(UserSecretGrant).where(
            UserSecretGrant.secret_id == secret_id,
            UserSecretGrant.user_id == user_id,
        )
    )
    if existing.scalar_one_or_none():
        return {"status": "already_granted", "secretId": secret_id, "userId": user_id}

    grant = UserSecretGrant(
        id=_gen_id("usg"),
        secret_id=secret_id,
        user_id=user_id,
        granted_at=now_ms(),
        granted_by=admin.id,
    )
    session.add(grant)
    await session.commit()
    logger.info(
        f"Admin {admin.id} granted instance secret {secret_id} to user {user_id}"
    )
    return {"status": "granted", "secretId": secret_id, "userId": user_id}


@router.delete("/secrets/{secret_id}/grant-user/{user_id}", status_code=204)
async def revoke_instance_secret_from_user(
    secret_id: str,
    user_id: str,
    admin: AuthUser = Depends(get_current_admin),
    session: AsyncSession = Depends(get_async_session),
) -> None:
    """Revoke an instance-level secret from a user."""
    result = await session.execute(
        select(UserSecretGrant).where(
            UserSecretGrant.secret_id == secret_id,
            UserSecretGrant.user_id == user_id,
        )
    )
    grant = result.scalar_one_or_none()
    if not grant:
        raise HTTPException(status_code=404, detail="Grant not found")
    await session.delete(grant)
    await session.commit()
    logger.info(
        f"Admin {admin.id} revoked instance secret {secret_id} from user {user_id}"
    )
