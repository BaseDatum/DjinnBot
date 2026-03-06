"""Settings and model provider configuration models."""

from typing import Optional
from sqlalchemy import String, Text, Boolean, BigInteger, Index
from sqlalchemy.orm import Mapped, mapped_column

from app.models.base import Base, now_ms


class ModelProvider(Base):
    """Configured model provider with stored API key and optional extra config."""

    __tablename__ = "model_providers"
    __table_args__ = (
        Index("idx_model_providers_provider_id", "provider_id", unique=True),
    )

    provider_id: Mapped[str] = mapped_column(String(64), primary_key=True)
    enabled: Mapped[bool] = mapped_column(Boolean, nullable=False, default=True)
    # Primary API key stored as plain text.
    api_key: Mapped[Optional[str]] = mapped_column(Text, nullable=True)
    # Extra configuration env vars as JSON, e.g. {"AZURE_OPENAI_BASE_URL": "https://..."}.
    # Used for providers that require more than a single API key (Azure, etc.).
    extra_config: Mapped[Optional[str]] = mapped_column(Text, nullable=True)
    created_at: Mapped[int] = mapped_column(BigInteger, nullable=False)
    updated_at: Mapped[int] = mapped_column(BigInteger, nullable=False)


class GlobalSetting(Base):
    """Key-value store for global application settings."""

    __tablename__ = "global_settings"

    key: Mapped[str] = mapped_column(String(128), primary_key=True)
    value: Mapped[str] = mapped_column(Text, nullable=False)
    updated_at: Mapped[int] = mapped_column(BigInteger, nullable=False)


class AgentChannelCredential(Base):
    """Per-agent channel credentials (Slack bot token, app token, etc.).

    Mirrors the model_providers pattern: env vars are synced from the engine
    at startup; values can be overridden via the dashboard UI without a restart.

    Primary key is (agent_id, channel) — e.g. ("finn", "slack").
    """

    __tablename__ = "agent_channel_credentials"
    __table_args__ = (
        Index("idx_agent_channel_credentials_agent", "agent_id"),
        Index("idx_agent_channel_credentials_channel", "channel"),
    )

    agent_id: Mapped[str] = mapped_column(String(128), primary_key=True)
    channel: Mapped[str] = mapped_column(String(64), primary_key=True)
    # Primary token — bot_token for Slack
    primary_token: Mapped[Optional[str]] = mapped_column(Text, nullable=True)
    # Secondary token — app_token for Slack Socket Mode
    secondary_token: Mapped[Optional[str]] = mapped_column(Text, nullable=True)
    # Extra JSON config e.g. {"bot_user_id": "U0ABC123"}
    extra_config: Mapped[Optional[str]] = mapped_column(Text, nullable=True)
    enabled: Mapped[bool] = mapped_column(Boolean, nullable=False, default=True)
    created_at: Mapped[int] = mapped_column(BigInteger, nullable=False)
    updated_at: Mapped[int] = mapped_column(BigInteger, nullable=False)
