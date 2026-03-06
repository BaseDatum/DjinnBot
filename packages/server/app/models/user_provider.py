"""Multi-user provider and secret grant models.

Tables:
  user_model_providers   — per-user API keys for model providers
  admin_shared_providers — admin shares their instance-level provider key with users
  user_secret_grants     — admin grants an instance-level secret to a specific user
"""

from typing import Optional

from sqlalchemy import (
    String,
    Text,
    Boolean,
    Integer,
    BigInteger,
    Float,
    Index,
    ForeignKey,
    UniqueConstraint,
)
from sqlalchemy.orm import Mapped, mapped_column

from app.models.base import Base, now_ms


class UserModelProvider(Base):
    """Per-user API key override for a model provider.

    Each user can store their own API key (and optional extra config) for any
    provider in the catalog.  When resolving keys for a session, the user's
    own key takes priority over admin-shared keys.

    Primary key: (user_id, provider_id).
    """

    __tablename__ = "user_model_providers"
    __table_args__ = (
        Index("idx_user_model_providers_user", "user_id"),
        Index("idx_user_model_providers_provider", "provider_id"),
    )

    user_id: Mapped[str] = mapped_column(
        String(64),
        ForeignKey("users.id", ondelete="CASCADE"),
        primary_key=True,
    )
    provider_id: Mapped[str] = mapped_column(String(64), primary_key=True)
    enabled: Mapped[bool] = mapped_column(Boolean, nullable=False, default=True)
    # Primary API key — stored as plain text (same as model_providers).
    api_key: Mapped[Optional[str]] = mapped_column(Text, nullable=True)
    # Extra configuration env vars as JSON (same schema as model_providers.extra_config).
    extra_config: Mapped[Optional[str]] = mapped_column(Text, nullable=True)
    created_at: Mapped[int] = mapped_column(BigInteger, nullable=False)
    updated_at: Mapped[int] = mapped_column(BigInteger, nullable=False)


class AdminSharedProvider(Base):
    """Admin shares an instance-level provider key with a user (or all users).

    The admin_user_id identifies **which admin** authorized the share — this is
    an audit trail.  The actual API key lives in the global ``model_providers``
    table keyed by ``provider_id``.

    When ``target_user_id`` is NULL, the share is a broadcast grant (all users
    may use this provider's instance-level key).
    """

    __tablename__ = "admin_shared_providers"
    __table_args__ = (
        # Prevent duplicate shares for the same (provider, target_user) pair.
        UniqueConstraint(
            "provider_id",
            "target_user_id",
            name="uq_admin_shared_provider_target",
        ),
        Index("idx_admin_shared_providers_admin", "admin_user_id"),
        Index("idx_admin_shared_providers_target", "target_user_id"),
        Index("idx_admin_shared_providers_provider", "provider_id"),
    )

    id: Mapped[str] = mapped_column(String(64), primary_key=True)
    admin_user_id: Mapped[str] = mapped_column(
        String(64),
        ForeignKey("users.id", ondelete="CASCADE"),
        nullable=False,
    )
    provider_id: Mapped[str] = mapped_column(String(64), nullable=False)
    # NULL = broadcast to all users; set = specific user.
    target_user_id: Mapped[Optional[str]] = mapped_column(
        String(64),
        ForeignKey("users.id", ondelete="CASCADE"),
        nullable=True,
    )
    created_at: Mapped[int] = mapped_column(BigInteger, nullable=False)

    # Granularity controls (all optional — NULL = no restriction)
    expires_at: Mapped[Optional[int]] = mapped_column(BigInteger, nullable=True)
    # JSON array of model IDs, e.g. '["claude-sonnet-4", "claude-haiku-3-5"]'
    allowed_models: Mapped[Optional[str]] = mapped_column(Text, nullable=True)
    # Max LLM API calls per day — NULL = unlimited.
    daily_limit: Mapped[Optional[int]] = mapped_column(Integer, nullable=True)
    # Max USD cost per day — NULL = unlimited.
    # Enforced by summing llm_call_logs.cost_total for the current UTC day.
    daily_cost_limit_usd: Mapped[Optional[float]] = mapped_column(Float, nullable=True)


class UserSecretGrant(Base):
    """Admin grants an instance-level secret to a specific user.

    This is the first hop in the two-hop grant chain:
      admin creates instance secret → grants to user (this table)
      user grants secret to agent   → agent_secret_grants table

    Users can only grant secrets they own (user-scoped) or have been granted
    (instance-scoped via this table) to agents.
    """

    __tablename__ = "user_secret_grants"
    __table_args__ = (
        UniqueConstraint("secret_id", "user_id", name="uq_user_secret_grant"),
        Index("idx_user_secret_grants_user", "user_id"),
        Index("idx_user_secret_grants_secret", "secret_id"),
    )

    id: Mapped[str] = mapped_column(String(64), primary_key=True)
    secret_id: Mapped[str] = mapped_column(
        String(64),
        ForeignKey("secrets.id", ondelete="CASCADE"),
        nullable=False,
    )
    user_id: Mapped[str] = mapped_column(
        String(64),
        ForeignKey("users.id", ondelete="CASCADE"),
        nullable=False,
    )
    granted_at: Mapped[int] = mapped_column(BigInteger, nullable=False)
    granted_by: Mapped[Optional[str]] = mapped_column(String(128), nullable=True)
