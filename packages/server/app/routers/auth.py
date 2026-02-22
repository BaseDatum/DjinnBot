"""Authentication API routes.

Groups:
  - Auth status & setup (public)
  - Login (local + OIDC) with TOTP challenge
  - Token refresh & logout
  - TOTP 2FA management
  - OIDC provider CRUD (admin)
  - API key management
"""

import json
import secrets
import uuid
from typing import Optional, List

from fastapi import APIRouter, Depends, HTTPException, Request, Response, status
from pydantic import BaseModel, EmailStr, Field
from sqlalchemy import select, func, delete
from sqlalchemy.ext.asyncio import AsyncSession

from app.database import get_async_session
from app.models.auth import User, UserRecoveryCode, OIDCProvider, APIKey, UserSession
from app.models.base import now_ms
from app.crypto import encrypt_secret, decrypt_secret, mask_secret
from app.auth.config import auth_settings
from app.auth.jwt import (
    create_access_token,
    create_refresh_token,
    create_pending_totp_token,
    decode_token,
    hash_token,
    TOKEN_TYPE_PENDING_TOTP,
)
from app.auth.passwords import hash_password, verify_password
from app.auth.totp import (
    generate_totp_secret,
    encrypt_totp_secret,
    decrypt_totp_secret,
    get_provisioning_uri,
    verify_totp_code,
    generate_recovery_codes,
    verify_recovery_code,
    generate_recovery_code_id,
)
from app.auth.oidc import OIDCClient, test_oidc_discovery
from app.auth.dependencies import get_current_user, get_current_admin, AuthUser
from app.logging_config import get_logger
from app import dependencies as app_deps

logger = get_logger(__name__)

router = APIRouter()


# ─── Helpers ──────────────────────────────────────────────────────────────────


def _generate_user_id() -> str:
    return f"usr_{uuid.uuid4().hex[:12]}"


def _generate_session_id() -> str:
    return f"ses_{uuid.uuid4().hex[:12]}"


def _generate_apikey_id() -> str:
    return f"ak_{uuid.uuid4().hex[:12]}"


def _generate_oidc_id() -> str:
    return f"oidc_{uuid.uuid4().hex[:12]}"


async def _issue_tokens(
    user: User,
    session: AsyncSession,
    request: Request,
) -> dict:
    """Create access + refresh tokens and persist the refresh session."""
    totp_verified = not user.totp_enabled  # If TOTP disabled, consider verified
    access_token = create_access_token(
        user_id=user.id,
        email=user.email,
        is_admin=user.is_admin,
        totp_verified=totp_verified,
    )
    raw_refresh, refresh_hash = create_refresh_token(user.id)

    now = now_ms()
    user_session = UserSession(
        id=_generate_session_id(),
        user_id=user.id,
        refresh_token_hash=refresh_hash,
        expires_at=now + (auth_settings.refresh_token_ttl_seconds * 1000),
        created_at=now,
        ip_address=request.client.host if request.client else None,
        user_agent=request.headers.get("user-agent"),
    )
    session.add(user_session)

    return {
        "accessToken": access_token,
        "refreshToken": raw_refresh,
        "tokenType": "Bearer",
        "expiresIn": auth_settings.access_token_ttl_seconds,
        "user": {
            "id": user.id,
            "email": user.email,
            "displayName": user.display_name,
            "isAdmin": user.is_admin,
            "totpEnabled": user.totp_enabled,
            "slackId": user.slack_id,
        },
    }


# ─── Schemas ──────────────────────────────────────────────────────────────────


class AuthStatusResponse(BaseModel):
    authEnabled: bool
    setupComplete: bool
    oidcProviders: list


class SetupRequest(BaseModel):
    email: str
    password: str = Field(min_length=8)
    displayName: Optional[str] = None


class LoginRequest(BaseModel):
    email: str
    password: str


class TOTPVerifyRequest(BaseModel):
    pendingToken: str
    code: str


class RecoveryCodeRequest(BaseModel):
    pendingToken: str
    code: str


class RefreshRequest(BaseModel):
    refreshToken: str


class TOTPSetupResponse(BaseModel):
    secret: str
    provisioningUri: str


class TOTPConfirmRequest(BaseModel):
    code: str


class TOTPDisableRequest(BaseModel):
    password: Optional[str] = None
    totpCode: Optional[str] = None


class OIDCProviderCreate(BaseModel):
    name: str
    slug: str = Field(pattern=r"^[a-z0-9][a-z0-9\-]{1,31}$")
    issuerUrl: str
    clientId: str
    clientSecret: str
    scopes: str = "openid email profile"
    buttonText: Optional[str] = None
    buttonColor: Optional[str] = None
    iconUrl: Optional[str] = None
    autoDiscovery: bool = True
    # Optional manual endpoints when autoDiscovery is False
    authorizationEndpoint: Optional[str] = None
    tokenEndpoint: Optional[str] = None
    userinfoEndpoint: Optional[str] = None
    jwksUri: Optional[str] = None


class OIDCProviderUpdate(BaseModel):
    name: Optional[str] = None
    issuerUrl: Optional[str] = None
    clientId: Optional[str] = None
    clientSecret: Optional[str] = None
    scopes: Optional[str] = None
    buttonText: Optional[str] = None
    buttonColor: Optional[str] = None
    iconUrl: Optional[str] = None
    autoDiscovery: Optional[bool] = None
    enabled: Optional[bool] = None
    authorizationEndpoint: Optional[str] = None
    tokenEndpoint: Optional[str] = None
    userinfoEndpoint: Optional[str] = None
    jwksUri: Optional[str] = None


class CreateAPIKeyRequest(BaseModel):
    name: str
    expiresInDays: Optional[int] = None


class CreateServiceKeyRequest(BaseModel):
    name: str
    expiresInDays: Optional[int] = None


# ═════════════════════════════════════════════════════════════════════════════
#  PUBLIC ENDPOINTS (no auth required)
# ═════════════════════════════════════════════════════════════════════════════


@router.get("/status")
async def auth_status(
    session: AsyncSession = Depends(get_async_session),
) -> AuthStatusResponse:
    """Public: returns auth state so the frontend knows what to render."""
    user_count = await session.scalar(select(func.count()).select_from(User))
    setup_complete = (user_count or 0) > 0

    # Fetch enabled OIDC providers for login buttons
    providers = []
    if setup_complete:
        result = await session.execute(
            select(OIDCProvider).where(OIDCProvider.enabled == True)
        )
        for p in result.scalars().all():
            providers.append(
                {
                    "id": p.id,
                    "slug": p.slug,
                    "name": p.name,
                    "buttonText": p.button_text or f"Sign in with {p.name}",
                    "buttonColor": p.button_color,
                    "iconUrl": p.icon_url,
                }
            )

    return AuthStatusResponse(
        authEnabled=auth_settings.enabled,
        setupComplete=setup_complete,
        oidcProviders=providers,
    )


@router.post("/setup")
async def initial_setup(
    body: SetupRequest,
    request: Request,
    session: AsyncSession = Depends(get_async_session),
):
    """Create the first admin user. Only works when no users exist."""
    user_count = await session.scalar(select(func.count()).select_from(User))
    if (user_count or 0) > 0:
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail="Setup already completed — users exist",
        )

    now = now_ms()
    user = User(
        id=_generate_user_id(),
        email=body.email.lower().strip(),
        display_name=body.displayName or body.email.split("@")[0],
        password_hash=hash_password(body.password),
        is_active=True,
        is_admin=True,
        totp_enabled=False,
        created_at=now,
        updated_at=now,
    )
    session.add(user)
    await session.flush()

    tokens = await _issue_tokens(user, session, request)
    return tokens


@router.post("/login")
async def login(
    body: LoginRequest,
    request: Request,
    session: AsyncSession = Depends(get_async_session),
):
    """Email/password login. Returns tokens or a TOTP challenge."""
    result = await session.execute(
        select(User).where(User.email == body.email.lower().strip())
    )
    user = result.scalar_one_or_none()

    if not user or not user.password_hash:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Invalid email or password",
        )
    if not user.is_active:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Account is disabled",
        )
    if not verify_password(body.password, user.password_hash):
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Invalid email or password",
        )

    # If TOTP is enabled, issue a pending token instead of full tokens.
    if user.totp_enabled:
        pending = create_pending_totp_token(user.id)
        return {
            "requiresTOTP": True,
            "pendingToken": pending,
        }

    tokens = await _issue_tokens(user, session, request)
    return tokens


@router.post("/login/totp")
async def login_totp(
    body: TOTPVerifyRequest,
    request: Request,
    session: AsyncSession = Depends(get_async_session),
):
    """Complete login by verifying a TOTP code after password auth."""
    try:
        payload = decode_token(body.pendingToken)
    except Exception:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Invalid or expired pending token",
        )

    if payload.get("type") != TOKEN_TYPE_PENDING_TOTP:
        raise HTTPException(status_code=400, detail="Not a TOTP pending token")

    user_id = payload.get("sub")
    result = await session.execute(select(User).where(User.id == user_id))
    user = result.scalar_one_or_none()
    if not user or not user.totp_enabled or not user.totp_secret:
        raise HTTPException(status_code=400, detail="TOTP not configured for this user")

    secret = decrypt_totp_secret(user.totp_secret)
    if not verify_totp_code(secret, body.code.strip()):
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Invalid TOTP code",
        )

    # TOTP passed — issue full tokens with totp_verified=True
    access_token = create_access_token(
        user_id=user.id,
        email=user.email,
        is_admin=user.is_admin,
        totp_verified=True,
    )
    raw_refresh, refresh_hash = create_refresh_token(user.id)
    now = now_ms()
    user_session = UserSession(
        id=_generate_session_id(),
        user_id=user.id,
        refresh_token_hash=refresh_hash,
        expires_at=now + (auth_settings.refresh_token_ttl_seconds * 1000),
        created_at=now,
        ip_address=request.client.host if request.client else None,
        user_agent=request.headers.get("user-agent"),
    )
    session.add(user_session)

    return {
        "accessToken": access_token,
        "refreshToken": raw_refresh,
        "tokenType": "Bearer",
        "expiresIn": auth_settings.access_token_ttl_seconds,
        "user": {
            "id": user.id,
            "email": user.email,
            "displayName": user.display_name,
            "isAdmin": user.is_admin,
            "totpEnabled": user.totp_enabled,
            "slackId": user.slack_id,
        },
    }


@router.post("/login/recovery")
async def login_recovery(
    body: RecoveryCodeRequest,
    request: Request,
    session: AsyncSession = Depends(get_async_session),
):
    """Complete login using a one-time recovery code instead of TOTP."""
    try:
        payload = decode_token(body.pendingToken)
    except Exception:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Invalid or expired pending token",
        )

    if payload.get("type") != TOKEN_TYPE_PENDING_TOTP:
        raise HTTPException(status_code=400, detail="Not a TOTP pending token")

    user_id = payload.get("sub")
    result = await session.execute(
        select(UserRecoveryCode).where(
            UserRecoveryCode.user_id == user_id,
            UserRecoveryCode.used_at == None,
        )
    )
    codes = result.scalars().all()

    matched_code = None
    for rc in codes:
        if verify_recovery_code(body.code, rc.code_hash):
            matched_code = rc
            break

    if not matched_code:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Invalid recovery code",
        )

    # Mark the code as used
    matched_code.used_at = now_ms()

    # Get user and issue tokens
    user_result = await session.execute(select(User).where(User.id == user_id))
    user = user_result.scalar_one_or_none()
    if not user:
        raise HTTPException(status_code=400, detail="User not found")

    access_token = create_access_token(
        user_id=user.id,
        email=user.email,
        is_admin=user.is_admin,
        totp_verified=True,
    )
    raw_refresh, refresh_hash = create_refresh_token(user.id)
    now = now_ms()
    user_session = UserSession(
        id=_generate_session_id(),
        user_id=user.id,
        refresh_token_hash=refresh_hash,
        expires_at=now + (auth_settings.refresh_token_ttl_seconds * 1000),
        created_at=now,
        ip_address=request.client.host if request.client else None,
        user_agent=request.headers.get("user-agent"),
    )
    session.add(user_session)

    # Count remaining recovery codes
    remaining = sum(
        1 for rc in codes if rc.used_at is None and rc.id != matched_code.id
    )

    return {
        "accessToken": access_token,
        "refreshToken": raw_refresh,
        "tokenType": "Bearer",
        "expiresIn": auth_settings.access_token_ttl_seconds,
        "user": {
            "id": user.id,
            "email": user.email,
            "displayName": user.display_name,
            "isAdmin": user.is_admin,
            "totpEnabled": user.totp_enabled,
            "slackId": user.slack_id,
        },
        "remainingRecoveryCodes": remaining,
    }


@router.post("/refresh")
async def refresh_tokens(
    body: RefreshRequest,
    request: Request,
    session: AsyncSession = Depends(get_async_session),
):
    """Exchange a refresh token for a new access + refresh token pair."""
    token_hash = hash_token(body.refreshToken)
    result = await session.execute(
        select(UserSession).where(UserSession.refresh_token_hash == token_hash)
    )
    user_session = result.scalar_one_or_none()

    if not user_session:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Invalid refresh token",
        )

    now = now_ms()
    if user_session.expires_at < now:
        await session.delete(user_session)
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Refresh token expired",
        )

    # Look up user
    user_result = await session.execute(
        select(User).where(User.id == user_session.user_id)
    )
    user = user_result.scalar_one_or_none()
    if not user or not user.is_active:
        await session.delete(user_session)
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="User not found or inactive",
        )

    # Rotate: delete old session, create new one
    await session.delete(user_session)
    await session.flush()

    tokens = await _issue_tokens(user, session, request)
    return tokens


# ═════════════════════════════════════════════════════════════════════════════
#  OIDC FLOW
# ═════════════════════════════════════════════════════════════════════════════


@router.get("/oidc/{provider_slug}/authorize")
async def oidc_authorize(
    provider_slug: str,
    request: Request,
    session: AsyncSession = Depends(get_async_session),
):
    """Redirect the user to the OIDC provider's authorization page."""
    result = await session.execute(
        select(OIDCProvider).where(
            OIDCProvider.slug == provider_slug,
            OIDCProvider.enabled == True,
        )
    )
    provider = result.scalar_one_or_none()
    if not provider:
        raise HTTPException(status_code=404, detail="OIDC provider not found")

    client_secret = decrypt_secret(provider.client_secret)
    oidc = OIDCClient(
        issuer_url=provider.issuer_url,
        client_id=provider.client_id,
        client_secret=client_secret,
        scopes=provider.scopes,
        authorization_endpoint=provider.authorization_endpoint,
        token_endpoint=provider.token_endpoint,
        userinfo_endpoint=provider.userinfo_endpoint,
        jwks_uri=provider.jwks_uri,
        auto_discovery=provider.auto_discovery,
    )

    # Generate PKCE and state
    code_verifier, code_challenge = OIDCClient.generate_pkce()
    state = secrets.token_urlsafe(32)

    # Store state + verifier in Redis (5 min TTL)
    redis = app_deps.redis_client
    if not redis:
        raise HTTPException(status_code=503, detail="Redis unavailable for OIDC state")

    state_data = json.dumps(
        {
            "code_verifier": code_verifier,
            "provider_id": provider.id,
        }
    )
    await redis.setex(f"oidc:state:{state}", 300, state_data)

    # Build callback URL from the request origin
    # The frontend will call /v1/auth/oidc/{slug}/callback
    callback_url = str(request.url_for("oidc_callback", provider_slug=provider_slug))

    auth_url = await oidc.get_authorization_url(
        redirect_uri=callback_url,
        state=state,
        code_challenge=code_challenge,
    )

    return {"authorizationUrl": auth_url}


@router.get("/oidc/{provider_slug}/callback")
async def oidc_callback(
    provider_slug: str,
    code: str,
    state: str,
    request: Request,
    session: AsyncSession = Depends(get_async_session),
):
    """Handle the OIDC callback after the user authenticates with the provider."""
    # Retrieve and validate state from Redis
    redis = app_deps.redis_client
    if not redis:
        raise HTTPException(status_code=503, detail="Redis unavailable")

    state_json = await redis.get(f"oidc:state:{state}")
    if not state_json:
        raise HTTPException(status_code=400, detail="Invalid or expired OIDC state")

    await redis.delete(f"oidc:state:{state}")
    state_data = json.loads(state_json)
    code_verifier = state_data["code_verifier"]
    provider_id = state_data["provider_id"]

    # Load provider
    result = await session.execute(
        select(OIDCProvider).where(OIDCProvider.id == provider_id)
    )
    provider = result.scalar_one_or_none()
    if not provider:
        raise HTTPException(status_code=400, detail="OIDC provider not found")

    client_secret = decrypt_secret(provider.client_secret)
    oidc = OIDCClient(
        issuer_url=provider.issuer_url,
        client_id=provider.client_id,
        client_secret=client_secret,
        scopes=provider.scopes,
        authorization_endpoint=provider.authorization_endpoint,
        token_endpoint=provider.token_endpoint,
        userinfo_endpoint=provider.userinfo_endpoint,
        jwks_uri=provider.jwks_uri,
        auto_discovery=provider.auto_discovery,
    )

    callback_url = str(request.url_for("oidc_callback", provider_slug=provider_slug))

    # Exchange code for tokens
    try:
        token_response = await oidc.exchange_code(code, callback_url, code_verifier)
    except Exception as e:
        logger.error(f"OIDC token exchange failed: {e}")
        raise HTTPException(status_code=400, detail=f"Token exchange failed: {e}")

    # Get user info — try id_token first, fall back to userinfo endpoint
    email = None
    oidc_sub = None
    display_name = None

    id_token = token_response.get("id_token")
    if id_token:
        try:
            claims = await oidc.decode_id_token(id_token)
            email = claims.get("email")
            oidc_sub = claims.get("sub")
            display_name = claims.get("name") or claims.get("preferred_username")
        except Exception as e:
            logger.warning(f"Failed to decode id_token: {e}")

    if not email:
        # Fall back to userinfo
        access_token = token_response.get("access_token")
        if access_token:
            try:
                userinfo = await oidc.fetch_userinfo(access_token)
                email = userinfo.get("email")
                oidc_sub = oidc_sub or userinfo.get("sub")
                display_name = (
                    display_name
                    or userinfo.get("name")
                    or userinfo.get("preferred_username")
                )
            except Exception as e:
                logger.error(f"Failed to fetch userinfo: {e}")

    if not email:
        raise HTTPException(
            status_code=400,
            detail="Could not obtain email from OIDC provider",
        )

    email = email.lower().strip()
    oidc_subject_key = f"{provider.slug}:{oidc_sub}" if oidc_sub else None

    # Find or create user
    user_result = await session.execute(select(User).where(User.email == email))
    user = user_result.scalar_one_or_none()

    now = now_ms()
    if not user:
        # Auto-create user from OIDC — first user is admin
        user_count = await session.scalar(select(func.count()).select_from(User))
        is_first = (user_count or 0) == 0

        user = User(
            id=_generate_user_id(),
            email=email,
            display_name=display_name or email.split("@")[0],
            password_hash=None,  # OIDC-only user
            is_active=True,
            is_admin=is_first,
            totp_enabled=False,
            oidc_subject=oidc_subject_key,
            created_at=now,
            updated_at=now,
        )
        session.add(user)
        await session.flush()
    else:
        # Update OIDC subject if not set
        if oidc_subject_key and not user.oidc_subject:
            user.oidc_subject = oidc_subject_key
            user.updated_at = now

    # If user has TOTP enabled, return pending token
    if user.totp_enabled:
        pending = create_pending_totp_token(user.id)
        return {
            "requiresTOTP": True,
            "pendingToken": pending,
        }

    tokens = await _issue_tokens(user, session, request)
    return tokens


# ═════════════════════════════════════════════════════════════════════════════
#  AUTHENTICATED ENDPOINTS
# ═════════════════════════════════════════════════════════════════════════════


@router.get("/me")
async def get_me(
    user: AuthUser = Depends(get_current_user),
    session: AsyncSession = Depends(get_async_session),
):
    """Get the current authenticated user's info."""
    # Fetch full user from DB to get slack_id
    slack_id = None
    if not user.is_service and user.id != "anonymous":
        db_user = await session.get(User, user.id)
        if db_user:
            slack_id = db_user.slack_id
    return {
        "id": user.id,
        "email": user.email,
        "displayName": user.display_name,
        "isAdmin": user.is_admin,
        "isService": user.is_service,
        "totpEnabled": user.totp_enabled,
        "slackId": slack_id,
    }


@router.post("/logout")
async def logout(
    body: RefreshRequest,
    session: AsyncSession = Depends(get_async_session),
    _user: AuthUser = Depends(get_current_user),
):
    """Invalidate a refresh token session."""
    token_hash = hash_token(body.refreshToken)
    result = await session.execute(
        select(UserSession).where(UserSession.refresh_token_hash == token_hash)
    )
    user_session = result.scalar_one_or_none()
    if user_session:
        await session.delete(user_session)
    return {"status": "ok"}


# ═════════════════════════════════════════════════════════════════════════════
#  TOTP 2FA MANAGEMENT
# ═════════════════════════════════════════════════════════════════════════════


@router.post("/totp/setup")
async def totp_setup(
    user: AuthUser = Depends(get_current_user),
    session: AsyncSession = Depends(get_async_session),
):
    """Generate a TOTP secret and provisioning URI for QR code display."""
    if user.is_service:
        raise HTTPException(
            status_code=400, detail="Service accounts cannot enable TOTP"
        )

    # Check if already enabled
    db_user = await session.get(User, user.id)
    if not db_user:
        raise HTTPException(status_code=404, detail="User not found")
    if db_user.totp_enabled:
        raise HTTPException(status_code=409, detail="TOTP is already enabled")

    secret = generate_totp_secret()
    uri = get_provisioning_uri(secret, db_user.email)

    # Store encrypted secret (not yet confirmed)
    db_user.totp_secret = encrypt_totp_secret(secret)
    db_user.updated_at = now_ms()

    return TOTPSetupResponse(secret=secret, provisioningUri=uri)


@router.post("/totp/confirm")
async def totp_confirm(
    body: TOTPConfirmRequest,
    user: AuthUser = Depends(get_current_user),
    session: AsyncSession = Depends(get_async_session),
):
    """Verify the first TOTP code to activate 2FA. Returns recovery codes."""
    db_user = await session.get(User, user.id)
    if not db_user:
        raise HTTPException(status_code=404, detail="User not found")
    if db_user.totp_enabled:
        raise HTTPException(status_code=409, detail="TOTP is already enabled")
    if not db_user.totp_secret:
        raise HTTPException(status_code=400, detail="Call /totp/setup first")

    secret = decrypt_totp_secret(db_user.totp_secret)
    if not verify_totp_code(secret, body.code.strip()):
        raise HTTPException(status_code=400, detail="Invalid TOTP code")

    # Activate TOTP
    now = now_ms()
    db_user.totp_enabled = True
    db_user.totp_confirmed_at = now
    db_user.updated_at = now

    # Generate recovery codes
    codes = generate_recovery_codes(10)
    for plaintext, code_hash in codes:
        session.add(
            UserRecoveryCode(
                id=generate_recovery_code_id(),
                user_id=db_user.id,
                code_hash=code_hash,
            )
        )

    plaintext_codes = [c[0] for c in codes]
    return {
        "status": "enabled",
        "recoveryCodes": plaintext_codes,
        "message": "Save these recovery codes — they will not be shown again.",
    }


@router.delete("/totp")
async def totp_disable(
    body: TOTPDisableRequest,
    user: AuthUser = Depends(get_current_user),
    session: AsyncSession = Depends(get_async_session),
):
    """Disable TOTP 2FA. Requires current password or TOTP code."""
    db_user = await session.get(User, user.id)
    if not db_user:
        raise HTTPException(status_code=404, detail="User not found")
    if not db_user.totp_enabled:
        raise HTTPException(status_code=400, detail="TOTP is not enabled")

    # Verify identity — either password or TOTP code
    verified = False
    if body.password and db_user.password_hash:
        verified = verify_password(body.password, db_user.password_hash)
    if not verified and body.totpCode and db_user.totp_secret:
        secret = decrypt_totp_secret(db_user.totp_secret)
        verified = verify_totp_code(secret, body.totpCode.strip())

    if not verified:
        raise HTTPException(status_code=401, detail="Verification failed")

    db_user.totp_enabled = False
    db_user.totp_secret = None
    db_user.totp_confirmed_at = None
    db_user.updated_at = now_ms()

    # Delete recovery codes
    await session.execute(
        delete(UserRecoveryCode).where(UserRecoveryCode.user_id == db_user.id)
    )

    return {"status": "disabled"}


@router.post("/totp/recovery-codes")
async def regenerate_recovery_codes(
    body: TOTPConfirmRequest,  # Requires a current TOTP code
    user: AuthUser = Depends(get_current_user),
    session: AsyncSession = Depends(get_async_session),
):
    """Regenerate recovery codes. Requires a valid TOTP code."""
    db_user = await session.get(User, user.id)
    if not db_user or not db_user.totp_enabled or not db_user.totp_secret:
        raise HTTPException(status_code=400, detail="TOTP not enabled")

    secret = decrypt_totp_secret(db_user.totp_secret)
    if not verify_totp_code(secret, body.code.strip()):
        raise HTTPException(status_code=401, detail="Invalid TOTP code")

    # Delete old codes, generate new ones
    await session.execute(
        delete(UserRecoveryCode).where(UserRecoveryCode.user_id == db_user.id)
    )

    codes = generate_recovery_codes(10)
    for plaintext, code_hash in codes:
        session.add(
            UserRecoveryCode(
                id=generate_recovery_code_id(),
                user_id=db_user.id,
                code_hash=code_hash,
            )
        )

    plaintext_codes = [c[0] for c in codes]
    return {
        "recoveryCodes": plaintext_codes,
        "message": "Save these recovery codes — they will not be shown again.",
    }


# ═════════════════════════════════════════════════════════════════════════════
#  OIDC PROVIDER CRUD (admin only)
# ═════════════════════════════════════════════════════════════════════════════


@router.get("/providers")
async def list_oidc_providers(
    admin: AuthUser = Depends(get_current_admin),
    session: AsyncSession = Depends(get_async_session),
):
    """List all OIDC providers (admin only, secrets masked)."""
    result = await session.execute(select(OIDCProvider))
    providers = []
    for p in result.scalars().all():
        providers.append(
            {
                "id": p.id,
                "slug": p.slug,
                "name": p.name,
                "issuerUrl": p.issuer_url,
                "clientId": p.client_id,
                "maskedClientSecret": mask_secret(decrypt_secret(p.client_secret))
                if p.client_secret
                else None,
                "scopes": p.scopes,
                "buttonText": p.button_text,
                "buttonColor": p.button_color,
                "iconUrl": p.icon_url,
                "autoDiscovery": p.auto_discovery,
                "enabled": p.enabled,
                "authorizationEndpoint": p.authorization_endpoint,
                "tokenEndpoint": p.token_endpoint,
                "userinfoEndpoint": p.userinfo_endpoint,
                "jwksUri": p.jwks_uri,
                "createdAt": p.created_at,
                "updatedAt": p.updated_at,
            }
        )
    return providers


@router.post("/providers")
async def create_oidc_provider(
    body: OIDCProviderCreate,
    admin: AuthUser = Depends(get_current_admin),
    session: AsyncSession = Depends(get_async_session),
):
    """Add a new OIDC provider."""
    # Check slug uniqueness
    existing = await session.execute(
        select(OIDCProvider).where(OIDCProvider.slug == body.slug)
    )
    if existing.scalar_one_or_none():
        raise HTTPException(
            status_code=409, detail=f"Slug '{body.slug}' already exists"
        )

    now = now_ms()
    provider = OIDCProvider(
        id=_generate_oidc_id(),
        slug=body.slug,
        name=body.name,
        issuer_url=body.issuerUrl.rstrip("/"),
        client_id=body.clientId,
        client_secret=encrypt_secret(body.clientSecret),
        scopes=body.scopes,
        button_text=body.buttonText,
        button_color=body.buttonColor,
        icon_url=body.iconUrl,
        auto_discovery=body.autoDiscovery,
        authorization_endpoint=body.authorizationEndpoint,
        token_endpoint=body.tokenEndpoint,
        userinfo_endpoint=body.userinfoEndpoint,
        jwks_uri=body.jwksUri,
        enabled=True,
        created_at=now,
        updated_at=now,
    )
    session.add(provider)
    await session.flush()

    return {"id": provider.id, "slug": provider.slug, "status": "created"}


@router.put("/providers/{provider_id}")
async def update_oidc_provider(
    provider_id: str,
    body: OIDCProviderUpdate,
    admin: AuthUser = Depends(get_current_admin),
    session: AsyncSession = Depends(get_async_session),
):
    """Update an OIDC provider."""
    provider = await session.get(OIDCProvider, provider_id)
    if not provider:
        raise HTTPException(status_code=404, detail="Provider not found")

    if body.name is not None:
        provider.name = body.name
    if body.issuerUrl is not None:
        provider.issuer_url = body.issuerUrl.rstrip("/")
    if body.clientId is not None:
        provider.client_id = body.clientId
    if body.clientSecret is not None:
        provider.client_secret = encrypt_secret(body.clientSecret)
    if body.scopes is not None:
        provider.scopes = body.scopes
    if body.buttonText is not None:
        provider.button_text = body.buttonText
    if body.buttonColor is not None:
        provider.button_color = body.buttonColor
    if body.iconUrl is not None:
        provider.icon_url = body.iconUrl
    if body.autoDiscovery is not None:
        provider.auto_discovery = body.autoDiscovery
    if body.enabled is not None:
        provider.enabled = body.enabled
    if body.authorizationEndpoint is not None:
        provider.authorization_endpoint = body.authorizationEndpoint
    if body.tokenEndpoint is not None:
        provider.token_endpoint = body.tokenEndpoint
    if body.userinfoEndpoint is not None:
        provider.userinfo_endpoint = body.userinfoEndpoint
    if body.jwksUri is not None:
        provider.jwks_uri = body.jwksUri

    provider.updated_at = now_ms()

    return {"id": provider.id, "status": "updated"}


@router.delete("/providers/{provider_id}")
async def delete_oidc_provider(
    provider_id: str,
    admin: AuthUser = Depends(get_current_admin),
    session: AsyncSession = Depends(get_async_session),
):
    """Remove an OIDC provider."""
    provider = await session.get(OIDCProvider, provider_id)
    if not provider:
        raise HTTPException(status_code=404, detail="Provider not found")
    await session.delete(provider)
    return {"status": "deleted", "id": provider_id}


@router.post("/providers/{provider_id}/test")
async def test_oidc_provider(
    provider_id: str,
    admin: AuthUser = Depends(get_current_admin),
    session: AsyncSession = Depends(get_async_session),
):
    """Test OIDC discovery for a provider."""
    provider = await session.get(OIDCProvider, provider_id)
    if not provider:
        raise HTTPException(status_code=404, detail="Provider not found")

    try:
        config = await test_oidc_discovery(provider.issuer_url)
        return {
            "status": "ok",
            "issuer": config.get("issuer"),
            "authorizationEndpoint": config.get("authorization_endpoint"),
            "tokenEndpoint": config.get("token_endpoint"),
            "userinfoEndpoint": config.get("userinfo_endpoint"),
            "jwksUri": config.get("jwks_uri"),
        }
    except Exception as e:
        raise HTTPException(status_code=400, detail=f"Discovery failed: {e}")


# ═════════════════════════════════════════════════════════════════════════════
#  API KEY MANAGEMENT
# ═════════════════════════════════════════════════════════════════════════════


@router.get("/api-keys")
async def list_api_keys(
    user: AuthUser = Depends(get_current_user),
    session: AsyncSession = Depends(get_async_session),
):
    """List the current user's API keys (masked)."""
    query = select(APIKey).where(APIKey.user_id == user.id, APIKey.is_active == True)
    result = await session.execute(query)
    keys = []
    for k in result.scalars().all():
        keys.append(
            {
                "id": k.id,
                "name": k.name,
                "keyPrefix": k.key_prefix,
                "isServiceKey": k.is_service_key,
                "expiresAt": k.expires_at,
                "lastUsedAt": k.last_used_at,
                "createdAt": k.created_at,
            }
        )
    return keys


@router.post("/api-keys")
async def create_api_key(
    body: CreateAPIKeyRequest,
    user: AuthUser = Depends(get_current_user),
    session: AsyncSession = Depends(get_async_session),
):
    """Create a new API key for the current user. The key is shown once."""
    raw_key = f"djb_{secrets.token_urlsafe(32)}"
    key_hash = hash_token(raw_key)

    now = now_ms()
    expires_at = None
    if body.expiresInDays:
        expires_at = now + (body.expiresInDays * 86400 * 1000)

    api_key = APIKey(
        id=_generate_apikey_id(),
        user_id=user.id,
        name=body.name,
        key_hash=key_hash,
        key_prefix=raw_key[:12],
        is_service_key=False,
        is_active=True,
        expires_at=expires_at,
        created_at=now,
    )
    session.add(api_key)

    return {
        "id": api_key.id,
        "name": api_key.name,
        "key": raw_key,  # Shown once only
        "keyPrefix": api_key.key_prefix,
        "expiresAt": expires_at,
        "message": "Save this key — it will not be shown again.",
    }


@router.delete("/api-keys/{key_id}")
async def revoke_api_key(
    key_id: str,
    user: AuthUser = Depends(get_current_user),
    session: AsyncSession = Depends(get_async_session),
):
    """Revoke an API key."""
    api_key = await session.get(APIKey, key_id)
    if not api_key:
        raise HTTPException(status_code=404, detail="API key not found")

    # Users can only revoke their own keys; admins can revoke any
    if api_key.user_id != user.id and not user.is_admin:
        raise HTTPException(status_code=403, detail="Not authorized")

    api_key.is_active = False
    return {"status": "revoked", "id": key_id}


@router.post("/api-keys/service")
async def create_service_key(
    body: CreateServiceKeyRequest,
    admin: AuthUser = Depends(get_current_admin),
    session: AsyncSession = Depends(get_async_session),
):
    """Create a service API key (admin only). Not tied to a user."""
    raw_key = f"djb_svc_{secrets.token_urlsafe(32)}"
    key_hash = hash_token(raw_key)

    now = now_ms()
    expires_at = None
    if body.expiresInDays:
        expires_at = now + (body.expiresInDays * 86400 * 1000)

    api_key = APIKey(
        id=_generate_apikey_id(),
        user_id=None,
        name=body.name,
        key_hash=key_hash,
        key_prefix=raw_key[:16],
        is_service_key=True,
        is_active=True,
        expires_at=expires_at,
        created_at=now,
    )
    session.add(api_key)

    return {
        "id": api_key.id,
        "name": api_key.name,
        "key": raw_key,
        "keyPrefix": api_key.key_prefix,
        "expiresAt": expires_at,
        "message": "Save this service key — it will not be shown again.",
    }


@router.get("/api-keys/all")
async def list_all_api_keys(
    admin: AuthUser = Depends(get_current_admin),
    session: AsyncSession = Depends(get_async_session),
):
    """List all API keys (admin only)."""
    result = await session.execute(select(APIKey).where(APIKey.is_active == True))
    keys = []
    for k in result.scalars().all():
        keys.append(
            {
                "id": k.id,
                "name": k.name,
                "keyPrefix": k.key_prefix,
                "userId": k.user_id,
                "isServiceKey": k.is_service_key,
                "expiresAt": k.expires_at,
                "lastUsedAt": k.last_used_at,
                "createdAt": k.created_at,
            }
        )
    return keys


class EnsureAgentKeyRequest(BaseModel):
    agentId: str


@router.post("/api-keys/agent")
async def ensure_agent_key(
    body: EnsureAgentKeyRequest,
    admin: AuthUser = Depends(get_current_admin),
    session: AsyncSession = Depends(get_async_session),
):
    """Ensure a service API key exists for an agent (idempotent).

    If an active key already exists for this agent, returns its prefix.
    If not, creates one and returns the full plaintext key (shown once).
    Called by the engine on startup for each agent.
    """
    agent_id = body.agentId
    key_name = f"agent:{agent_id}"

    # Check for existing active key
    result = await session.execute(
        select(APIKey).where(
            APIKey.name == key_name,
            APIKey.is_service_key == True,
            APIKey.is_active == True,
        )
    )
    existing = result.scalar_one_or_none()
    if existing:
        return {
            "id": existing.id,
            "agentId": agent_id,
            "keyPrefix": existing.key_prefix,
            "created": False,
        }

    # Create a new agent-scoped service key
    raw_key = f"djb_agent_{secrets.token_urlsafe(32)}"
    key_hash_val = hash_token(raw_key)
    now = now_ms()

    api_key = APIKey(
        id=_generate_apikey_id(),
        user_id=None,
        name=key_name,
        key_hash=key_hash_val,
        key_prefix=raw_key[:16],
        scopes=json.dumps({"agent_id": agent_id}),
        is_service_key=True,
        is_active=True,
        expires_at=None,
        created_at=now,
    )
    session.add(api_key)

    return {
        "id": api_key.id,
        "agentId": agent_id,
        "key": raw_key,
        "keyPrefix": api_key.key_prefix,
        "created": True,
    }
