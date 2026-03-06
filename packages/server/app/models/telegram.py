"""Telegram integration models: per-agent config and allowlist.

TelegramConfig stores per-agent Telegram bot settings.
TelegramAllowlistEntry stores per-agent access rules.

Unlike Signal (one shared phone number), Telegram uses one bot per agent.
Each agent gets its own BotFather bot token.
"""

from typing import Optional
from sqlalchemy import String, Boolean, BigInteger, Integer, Index
from sqlalchemy.orm import Mapped, mapped_column

from app.models.base import Base, now_ms


class TelegramConfig(Base):
    """Per-agent Telegram bot configuration."""

    __tablename__ = "telegram_config"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    # Agent ID — unique constraint ensures one config per agent
    agent_id: Mapped[str] = mapped_column(String(128), nullable=False, unique=True)
    enabled: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False)
    # BotFather bot token (encrypted at rest by the DB layer)
    bot_token: Mapped[Optional[str]] = mapped_column(String(256), nullable=True)
    # Resolved via getMe() on first successful connect
    bot_username: Mapped[Optional[str]] = mapped_column(String(128), nullable=True)
    # When true, skip allowlist entirely — respond to all senders
    allow_all: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False)
    updated_at: Mapped[int] = mapped_column(BigInteger, nullable=False)


class TelegramAllowlistEntry(Base):
    """Per-agent allowlist entry for Telegram users.

    Identifiers can be:
      - '*'          -> accept all senders
      - '12345678'   -> exact Telegram user ID
      - '@username'  -> exact username match
      - '@prefix*'   -> username prefix wildcard
    """

    __tablename__ = "telegram_allowlist"
    __table_args__ = (Index("ix_telegram_allowlist_agent_id", "agent_id"),)

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    # Which agent this entry belongs to
    agent_id: Mapped[str] = mapped_column(String(128), nullable=False)
    # User ID (numeric string), @username, @prefix*, or '*'
    identifier: Mapped[str] = mapped_column(String(128), nullable=False)
    # Friendly label for the dashboard UI
    label: Mapped[Optional[str]] = mapped_column(String(256), nullable=True)
    created_at: Mapped[int] = mapped_column(BigInteger, nullable=False)
    updated_at: Mapped[int] = mapped_column(BigInteger, nullable=False)
