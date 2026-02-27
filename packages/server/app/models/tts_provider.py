"""TTS provider models — separate from LLM model providers.

Tables:
  tts_providers              — instance-level TTS API keys
  user_tts_providers         — per-user TTS API keys
  admin_shared_tts_providers — admin shares TTS provider key with users
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

from app.models.base import Base


class TtsProvider(Base):
    """Instance-level TTS provider API key configuration.

    Mirrors ModelProvider but scoped to TTS providers (Fish Audio, etc.)
    so they appear on a separate settings tab.
    """

    __tablename__ = "tts_providers"

    provider_id: Mapped[str] = mapped_column(String(64), primary_key=True)
    enabled: Mapped[bool] = mapped_column(Boolean, nullable=False, default=True)
    api_key: Mapped[Optional[str]] = mapped_column(Text, nullable=True)
    extra_config: Mapped[Optional[str]] = mapped_column(Text, nullable=True)
    created_at: Mapped[int] = mapped_column(BigInteger, nullable=False)
    updated_at: Mapped[int] = mapped_column(BigInteger, nullable=False)


class UserTtsProvider(Base):
    """Per-user TTS API key override.

    Each user can store their own API key for any TTS provider.
    User's own key takes priority over admin-shared keys.
    """

    __tablename__ = "user_tts_providers"
    __table_args__ = (
        Index("idx_user_tts_providers_user", "user_id"),
        Index("idx_user_tts_providers_provider", "provider_id"),
    )

    user_id: Mapped[str] = mapped_column(
        String(64),
        ForeignKey("users.id", ondelete="CASCADE"),
        primary_key=True,
    )
    provider_id: Mapped[str] = mapped_column(String(64), primary_key=True)
    enabled: Mapped[bool] = mapped_column(Boolean, nullable=False, default=True)
    api_key: Mapped[Optional[str]] = mapped_column(Text, nullable=True)
    extra_config: Mapped[Optional[str]] = mapped_column(Text, nullable=True)
    created_at: Mapped[int] = mapped_column(BigInteger, nullable=False)
    updated_at: Mapped[int] = mapped_column(BigInteger, nullable=False)


class AdminSharedTtsProvider(Base):
    """Admin shares a TTS provider key with a user (or all users).

    Mirrors AdminSharedProvider but for TTS keys.
    When target_user_id is NULL, the share is a broadcast grant.
    """

    __tablename__ = "admin_shared_tts_providers"
    __table_args__ = (
        UniqueConstraint(
            "provider_id",
            "target_user_id",
            name="uq_admin_shared_tts_provider_target",
        ),
        Index("idx_admin_shared_tts_providers_admin", "admin_user_id"),
        Index("idx_admin_shared_tts_providers_target", "target_user_id"),
        Index("idx_admin_shared_tts_providers_provider", "provider_id"),
    )

    id: Mapped[str] = mapped_column(String(64), primary_key=True)
    admin_user_id: Mapped[str] = mapped_column(
        String(64),
        ForeignKey("users.id", ondelete="CASCADE"),
        nullable=False,
    )
    provider_id: Mapped[str] = mapped_column(String(64), nullable=False)
    target_user_id: Mapped[Optional[str]] = mapped_column(
        String(64),
        ForeignKey("users.id", ondelete="CASCADE"),
        nullable=True,
    )
    created_at: Mapped[int] = mapped_column(BigInteger, nullable=False)
    expires_at: Mapped[Optional[int]] = mapped_column(BigInteger, nullable=True)
    daily_limit: Mapped[Optional[int]] = mapped_column(Integer, nullable=True)
    daily_cost_limit_usd: Mapped[Optional[float]] = mapped_column(Float, nullable=True)
