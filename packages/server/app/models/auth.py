"""Authentication models: users, OIDC providers, API keys, sessions, recovery codes."""

from typing import Optional

from sqlalchemy import String, Text, Boolean, BigInteger, Index, ForeignKey
from sqlalchemy.orm import Mapped, mapped_column

from app.models.base import Base, now_ms


class User(Base):
    """Application user — created via local signup or OIDC login."""

    __tablename__ = "users"
    __table_args__ = (Index("idx_users_email", "email", unique=True),)

    id: Mapped[str] = mapped_column(String(64), primary_key=True)
    email: Mapped[str] = mapped_column(String(320), nullable=False, unique=True)
    display_name: Mapped[Optional[str]] = mapped_column(String(256), nullable=True)
    # Nullable — OIDC-only users have no local password.
    password_hash: Mapped[Optional[str]] = mapped_column(Text, nullable=True)
    is_active: Mapped[bool] = mapped_column(Boolean, nullable=False, default=True)
    is_admin: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False)

    # TOTP 2FA — secret is AES-encrypted via app.crypto
    totp_secret: Mapped[Optional[str]] = mapped_column(Text, nullable=True)
    totp_enabled: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False)
    totp_confirmed_at: Mapped[Optional[int]] = mapped_column(BigInteger, nullable=True)

    # Optional: OIDC subject identifier for linking (provider_id:sub)
    oidc_subject: Mapped[Optional[str]] = mapped_column(String(512), nullable=True)

    # Slack member ID for cross-referencing Slack messages to DjinnBot users.
    # e.g. "U0123456789". Users set this in their profile.
    slack_id: Mapped[Optional[str]] = mapped_column(String(64), nullable=True)

    created_at: Mapped[int] = mapped_column(BigInteger, nullable=False)
    updated_at: Mapped[int] = mapped_column(BigInteger, nullable=False)


class UserRecoveryCode(Base):
    """One-time recovery codes for TOTP bypass."""

    __tablename__ = "user_recovery_codes"
    __table_args__ = (Index("idx_recovery_codes_user", "user_id"),)

    id: Mapped[str] = mapped_column(String(64), primary_key=True)
    user_id: Mapped[str] = mapped_column(
        String(64), ForeignKey("users.id", ondelete="CASCADE"), nullable=False
    )
    # SHA-256 hash of the recovery code
    code_hash: Mapped[str] = mapped_column(String(128), nullable=False)
    used_at: Mapped[Optional[int]] = mapped_column(BigInteger, nullable=True)


class OIDCProvider(Base):
    """Configured OpenID Connect provider."""

    __tablename__ = "oidc_providers"
    __table_args__ = (Index("idx_oidc_providers_slug", "slug", unique=True),)

    id: Mapped[str] = mapped_column(String(64), primary_key=True)
    # URL-safe slug used in routes: /v1/auth/oidc/{slug}/authorize
    slug: Mapped[str] = mapped_column(String(64), nullable=False, unique=True)
    name: Mapped[str] = mapped_column(String(256), nullable=False)
    issuer_url: Mapped[str] = mapped_column(Text, nullable=False)

    # OIDC endpoints — auto-populated via discovery or set manually.
    client_id: Mapped[str] = mapped_column(Text, nullable=False)
    # AES-encrypted via app.crypto
    client_secret: Mapped[str] = mapped_column(Text, nullable=False)
    authorization_endpoint: Mapped[Optional[str]] = mapped_column(Text, nullable=True)
    token_endpoint: Mapped[Optional[str]] = mapped_column(Text, nullable=True)
    userinfo_endpoint: Mapped[Optional[str]] = mapped_column(Text, nullable=True)
    jwks_uri: Mapped[Optional[str]] = mapped_column(Text, nullable=True)

    scopes: Mapped[str] = mapped_column(
        String(512), nullable=False, default="openid email profile"
    )

    # UI customisation for the login button
    button_text: Mapped[Optional[str]] = mapped_column(String(128), nullable=True)
    button_color: Mapped[Optional[str]] = mapped_column(String(32), nullable=True)
    icon_url: Mapped[Optional[str]] = mapped_column(Text, nullable=True)

    # If true, endpoints are fetched from .well-known/openid-configuration
    auto_discovery: Mapped[bool] = mapped_column(Boolean, nullable=False, default=True)
    enabled: Mapped[bool] = mapped_column(Boolean, nullable=False, default=True)

    created_at: Mapped[int] = mapped_column(BigInteger, nullable=False)
    updated_at: Mapped[int] = mapped_column(BigInteger, nullable=False)


class APIKey(Base):
    """User or service API key for programmatic access."""

    __tablename__ = "api_keys"
    __table_args__ = (
        Index("idx_api_keys_user", "user_id"),
        Index("idx_api_keys_prefix", "key_prefix"),
    )

    id: Mapped[str] = mapped_column(String(64), primary_key=True)
    # Nullable — service keys are not tied to a user.
    user_id: Mapped[Optional[str]] = mapped_column(
        String(64), ForeignKey("users.id", ondelete="CASCADE"), nullable=True
    )
    name: Mapped[str] = mapped_column(String(256), nullable=False)
    # SHA-256 of the full key
    key_hash: Mapped[str] = mapped_column(String(128), nullable=False, unique=True)
    # First 8 chars for identification in lists
    key_prefix: Mapped[str] = mapped_column(String(16), nullable=False)
    # JSON array of scope strings, e.g. ["admin"] or ["read"]. Null = full access.
    scopes: Mapped[Optional[str]] = mapped_column(Text, nullable=True)
    is_service_key: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False)
    is_active: Mapped[bool] = mapped_column(Boolean, nullable=False, default=True)

    expires_at: Mapped[Optional[int]] = mapped_column(BigInteger, nullable=True)
    last_used_at: Mapped[Optional[int]] = mapped_column(BigInteger, nullable=True)
    created_at: Mapped[int] = mapped_column(BigInteger, nullable=False)


class UserSession(Base):
    """Tracks active refresh token sessions."""

    __tablename__ = "user_sessions"
    __table_args__ = (
        Index("idx_user_sessions_user", "user_id"),
        Index("idx_user_sessions_refresh_hash", "refresh_token_hash", unique=True),
    )

    id: Mapped[str] = mapped_column(String(64), primary_key=True)
    user_id: Mapped[str] = mapped_column(
        String(64), ForeignKey("users.id", ondelete="CASCADE"), nullable=False
    )
    refresh_token_hash: Mapped[str] = mapped_column(
        String(128), nullable=False, unique=True
    )
    expires_at: Mapped[int] = mapped_column(BigInteger, nullable=False)
    created_at: Mapped[int] = mapped_column(BigInteger, nullable=False)
    ip_address: Mapped[Optional[str]] = mapped_column(String(64), nullable=True)
    user_agent: Mapped[Optional[str]] = mapped_column(Text, nullable=True)
