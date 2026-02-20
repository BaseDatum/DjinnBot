"""Secrets management models.

Secrets are user-defined credentials (PATs, SSH keys, env vars, etc.) that can
be scoped to specific agents. The secret *value* is stored encrypted (AES-256-GCM)
and is never returned via the API — only a masked preview is exposed.
"""

from typing import Optional
from sqlalchemy import (
    String,
    Text,
    BigInteger,
    Index,
    UniqueConstraint,
    Boolean,
    ForeignKey,
)
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.models.base import Base, TimestampMixin


# Recognised secret types — used for display hints and injection behaviour.
SECRET_TYPES = {
    "pat": "Personal Access Token",
    "ssh_key": "SSH Private Key",
    "env_var": "Environment Variable",
    "password": "Password",
    "api_key": "API Key",
    "token": "Token",
    "other": "Other",
}


class Secret(Base, TimestampMixin):
    """A user-defined secret stored encrypted at rest.

    The ``env_key`` field controls the environment variable name that is
    injected into agent containers, e.g. ``GITHUB_TOKEN``, ``GITLAB_TOKEN``.

    The ``encrypted_value`` is AES-256-GCM ciphertext produced by
    ``app.crypto.encrypt_secret``.  The raw plaintext is **never** returned
    by the API — only a short masked preview (e.g. ``ghp_...abc1``) is exposed.
    """

    __tablename__ = "secrets"
    __table_args__ = (
        Index("idx_secrets_env_key", "env_key"),
        Index("idx_secrets_secret_type", "secret_type"),
    )

    id: Mapped[str] = mapped_column(String(64), primary_key=True)
    name: Mapped[str] = mapped_column(String(256), nullable=False)
    description: Mapped[Optional[str]] = mapped_column(Text, nullable=True)
    # One of the keys in SECRET_TYPES
    secret_type: Mapped[str] = mapped_column(
        String(32), nullable=False, default="env_var"
    )
    # Environment variable name injected into agent containers, e.g. GITHUB_TOKEN
    env_key: Mapped[str] = mapped_column(String(256), nullable=False)
    # AES-256-GCM ciphertext (base64-encoded nonce + tag + ciphertext)
    encrypted_value: Mapped[str] = mapped_column(Text, nullable=False)
    # Short preview for display: first 4 + "..." + last 4 chars of the plaintext
    masked_preview: Mapped[Optional[str]] = mapped_column(String(64), nullable=True)

    # Relationships
    grants: Mapped[list["AgentSecretGrant"]] = relationship(
        back_populates="secret", cascade="all, delete-orphan"
    )


class AgentSecretGrant(Base):
    """Grant a secret to a specific agent.

    When the engine launches a container for ``agent_id``, it queries all
    active grants for that agent and injects the decrypted secret values as
    environment variables (keyed by ``secret.env_key``).
    """

    __tablename__ = "agent_secret_grants"
    __table_args__ = (
        UniqueConstraint("secret_id", "agent_id", name="uq_agent_secret_grant"),
        Index("idx_agent_secret_grants_agent", "agent_id"),
        Index("idx_agent_secret_grants_secret", "secret_id"),
    )

    id: Mapped[str] = mapped_column(String(64), primary_key=True)
    secret_id: Mapped[str] = mapped_column(
        String(64), ForeignKey("secrets.id", ondelete="CASCADE"), nullable=False
    )
    # Agent ID as discovered from the agents/ directory (e.g. "finn", "eric")
    agent_id: Mapped[str] = mapped_column(String(128), nullable=False)
    granted_at: Mapped[int] = mapped_column(BigInteger, nullable=False)
    granted_by: Mapped[Optional[str]] = mapped_column(String(128), nullable=True)

    # Relationships
    secret: Mapped["Secret"] = relationship(back_populates="grants")
