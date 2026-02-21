"""JWT token creation and validation."""

import hashlib
import secrets
import uuid
from datetime import datetime, timezone, timedelta
from typing import Optional

import jwt as pyjwt

from app.auth.config import auth_settings


# ─── Token types ─────────────────────────────────────────────────────────────

TOKEN_TYPE_ACCESS = "access"
TOKEN_TYPE_REFRESH = "refresh"
# Pending token — issued after password auth when TOTP is required.
# Cannot be used as an access token; only valid for the TOTP verification step.
TOKEN_TYPE_PENDING_TOTP = "pending_totp"


def create_access_token(
    user_id: str,
    email: str,
    is_admin: bool,
    totp_verified: bool = False,
) -> str:
    """Create a short-lived access token."""
    now = datetime.now(timezone.utc)
    payload = {
        "sub": user_id,
        "email": email,
        "is_admin": is_admin,
        "totp_verified": totp_verified,
        "type": TOKEN_TYPE_ACCESS,
        "iat": now,
        "exp": now + timedelta(seconds=auth_settings.access_token_ttl_seconds),
        "jti": uuid.uuid4().hex,
    }
    return pyjwt.encode(payload, auth_settings.secret_key, algorithm="HS256")


def create_refresh_token(user_id: str) -> tuple[str, str]:
    """Create a long-lived refresh token.

    Returns (raw_token, token_hash) — the raw token is sent to the client,
    the hash is stored in the database.
    """
    raw_token = secrets.token_urlsafe(48)
    token_hash = hashlib.sha256(raw_token.encode()).hexdigest()
    return raw_token, token_hash


def create_pending_totp_token(user_id: str) -> str:
    """Create a short-lived token that can only be used to complete TOTP verification."""
    now = datetime.now(timezone.utc)
    payload = {
        "sub": user_id,
        "type": TOKEN_TYPE_PENDING_TOTP,
        "iat": now,
        "exp": now + timedelta(minutes=5),  # 5 min to enter TOTP code
        "jti": uuid.uuid4().hex,
    }
    return pyjwt.encode(payload, auth_settings.secret_key, algorithm="HS256")


def decode_token(token: str) -> dict:
    """Decode and validate a JWT.

    Raises jwt.ExpiredSignatureError, jwt.InvalidTokenError on failure.
    """
    return pyjwt.decode(token, auth_settings.secret_key, algorithms=["HS256"])


def hash_token(raw: str) -> str:
    """SHA-256 hash a raw token string."""
    return hashlib.sha256(raw.encode()).hexdigest()
