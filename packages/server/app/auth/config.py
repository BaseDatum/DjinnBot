"""Auth configuration — reads from environment variables."""

import os
from dataclasses import dataclass, field


@dataclass
class AuthSettings:
    """Centralised auth configuration read from env vars at import time."""

    # Master toggle — when False, auth middleware is a no-op.
    enabled: bool = field(
        default_factory=lambda: os.getenv("AUTH_ENABLED", "true").lower() == "true"
    )

    # Secret key used to sign JWTs (HS256). Required when auth is enabled.
    secret_key: str = field(default_factory=lambda: os.getenv("AUTH_SECRET_KEY", ""))

    # Token lifetimes
    access_token_ttl_seconds: int = field(
        default_factory=lambda: int(os.getenv("AUTH_ACCESS_TOKEN_TTL", "900"))  # 15 min
    )
    refresh_token_ttl_seconds: int = field(
        default_factory=lambda: int(
            os.getenv("AUTH_REFRESH_TOKEN_TTL", "604800")
        )  # 7 days
    )

    # TOTP issuer name shown in authenticator apps
    totp_issuer: str = field(
        default_factory=lambda: os.getenv("AUTH_TOTP_ISSUER", "DjinnBot")
    )

    # Pre-shared service token — accepted as a first-class API key.
    engine_internal_token: str = field(
        default_factory=lambda: os.getenv("ENGINE_INTERNAL_TOKEN", "")
    )

    def validate(self) -> None:
        """Raise if critical settings are missing while auth is enabled."""
        if not self.enabled:
            return
        if not self.secret_key:
            raise RuntimeError(
                "AUTH_SECRET_KEY must be set when AUTH_ENABLED=true. "
                'Generate one with: python -c "import secrets; print(secrets.token_urlsafe(64))"'
            )
        if not self.engine_internal_token:
            raise RuntimeError(
                "ENGINE_INTERNAL_TOKEN must be set when AUTH_ENABLED=true. "
                "The engine and agent-runtime need this token to authenticate with the API. "
                'Generate one with: python -c "import secrets; print(secrets.token_urlsafe(32))"'
            )


# Singleton — imported everywhere.
auth_settings = AuthSettings()
