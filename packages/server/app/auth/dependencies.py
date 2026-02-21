"""FastAPI authentication dependencies.

Three main dependencies for route handlers:

  get_current_user    — requires a valid JWT or API key (user must exist)
  get_current_admin   — same as above + user must be admin
  get_service_or_user — accepts JWT, API key, OR ENGINE_INTERNAL_TOKEN
"""

import hmac
from dataclasses import dataclass
from typing import Optional

import jwt as pyjwt
from fastapi import Depends, HTTPException, Request, status
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.auth.config import auth_settings
from app.auth.jwt import decode_token, hash_token, TOKEN_TYPE_ACCESS
from app.database import get_async_session
from app.logging_config import get_logger
from app.models.auth import User, APIKey
from app.models.base import now_ms

logger = get_logger(__name__)


@dataclass
class AuthUser:
    """Represents the authenticated caller — real user or service identity."""

    id: str
    email: Optional[str]
    display_name: Optional[str]
    is_admin: bool
    is_service: bool = False
    totp_verified: bool = False
    totp_enabled: bool = False

    @staticmethod
    def service_user() -> "AuthUser":
        """Synthetic user for ENGINE_INTERNAL_TOKEN callers."""
        return AuthUser(
            id="service:engine",
            email=None,
            display_name="Engine Service",
            is_admin=True,
            is_service=True,
            totp_verified=True,
            totp_enabled=False,
        )


def _extract_bearer_token(request: Request) -> Optional[str]:
    """Extract the Bearer token from the Authorization header or query param."""
    auth_header = request.headers.get("authorization")
    if auth_header and auth_header.lower().startswith("bearer "):
        return auth_header[7:].strip()
    # Fallback: query parameter (for SSE / WebSocket)
    return request.query_params.get("token")


def _is_engine_internal_token(token: str) -> bool:
    """Constant-time comparison against ENGINE_INTERNAL_TOKEN."""
    if not auth_settings.engine_internal_token:
        return False
    return hmac.compare_digest(token, auth_settings.engine_internal_token)


async def _resolve_api_key(
    token: str,
    session: AsyncSession,
) -> Optional[AuthUser]:
    """Try to resolve a token as a database-stored API key.

    Returns AuthUser on match, None if the token isn't an API key.
    """
    token_hash = hash_token(token)
    result = await session.execute(
        select(APIKey).where(APIKey.key_hash == token_hash, APIKey.is_active == True)
    )
    api_key = result.scalar_one_or_none()
    if not api_key:
        return None

    # Check expiration
    if api_key.expires_at and api_key.expires_at < now_ms():
        return None

    # Update last_used_at (fire-and-forget, don't block auth)
    api_key.last_used_at = now_ms()

    # Service keys act as admin with no real user behind them
    if api_key.is_service_key:
        return AuthUser(
            id=f"service:apikey:{api_key.id}",
            email=None,
            display_name=api_key.name,
            is_admin=True,
            is_service=True,
            totp_verified=True,
            totp_enabled=False,
        )

    # User-bound API key — look up the user
    if not api_key.user_id:
        return None
    user_result = await session.execute(select(User).where(User.id == api_key.user_id))
    user = user_result.scalar_one_or_none()
    if not user or not user.is_active:
        return None

    return AuthUser(
        id=user.id,
        email=user.email,
        display_name=user.display_name,
        is_admin=user.is_admin,
        is_service=False,
        # API keys bypass TOTP — the key itself is the second factor.
        totp_verified=True,
        totp_enabled=user.totp_enabled,
    )


async def _resolve_jwt(token: str, session: AsyncSession) -> Optional[AuthUser]:
    """Try to decode a token as a JWT and look up the user.

    Returns AuthUser on success, None if the token is not a valid JWT.
    """
    try:
        payload = decode_token(token)
    except pyjwt.ExpiredSignatureError:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Token expired",
            headers={"WWW-Authenticate": "Bearer"},
        )
    except pyjwt.InvalidTokenError:
        return None  # Not a JWT — maybe it's an API key

    # Only accept access tokens (not pending_totp, refresh, etc.)
    if payload.get("type") != TOKEN_TYPE_ACCESS:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Invalid token type",
        )

    user_id = payload.get("sub")
    if not user_id:
        return None

    result = await session.execute(select(User).where(User.id == user_id))
    user = result.scalar_one_or_none()
    if not user or not user.is_active:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="User not found or inactive",
        )

    return AuthUser(
        id=user.id,
        email=user.email,
        display_name=user.display_name,
        is_admin=user.is_admin,
        is_service=False,
        totp_verified=payload.get("totp_verified", False),
        totp_enabled=user.totp_enabled,
    )


async def get_current_user(
    request: Request,
    session: AsyncSession = Depends(get_async_session),
) -> AuthUser:
    """Resolve the current user from JWT or API key.

    Raises 401 if no valid credential is provided.
    """
    if not auth_settings.enabled:
        # Auth disabled — return a synthetic admin user.
        return AuthUser(
            id="anonymous",
            email=None,
            display_name="Anonymous",
            is_admin=True,
            is_service=False,
            totp_verified=True,
            totp_enabled=False,
        )

    token = _extract_bearer_token(request)
    if not token:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Not authenticated",
            headers={"WWW-Authenticate": "Bearer"},
        )

    # 1. ENGINE_INTERNAL_TOKEN
    if _is_engine_internal_token(token):
        return AuthUser.service_user()

    # 2. JWT
    auth_user = await _resolve_jwt(token, session)
    if auth_user:
        return auth_user

    # 3. API key (DB lookup)
    auth_user = await _resolve_api_key(token, session)
    if auth_user:
        return auth_user

    raise HTTPException(
        status_code=status.HTTP_401_UNAUTHORIZED,
        detail="Invalid or expired token",
        headers={"WWW-Authenticate": "Bearer"},
    )


async def get_current_admin(
    user: AuthUser = Depends(get_current_user),
) -> AuthUser:
    """Require an admin user."""
    if not user.is_admin:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="Admin access required",
        )
    return user


async def get_service_or_user(
    request: Request,
    session: AsyncSession = Depends(get_async_session),
) -> AuthUser:
    """Accept JWT, API key, or ENGINE_INTERNAL_TOKEN.

    Same as get_current_user — kept as a distinct name for semantic clarity
    at call sites that specifically document service-to-service auth.
    """
    return await get_current_user(request, session)
