"""Signal integration models: config and allowlist.

SignalConfig is a singleton (id=1) holding system-wide Signal settings.
SignalAllowlistEntry stores per-number access rules with optional agent binding.
"""

from typing import Optional
from sqlalchemy import String, Text, Boolean, BigInteger, Integer
from sqlalchemy.orm import Mapped, mapped_column

from app.models.base import Base, now_ms


class SignalConfig(Base):
    """System-wide Signal channel configuration (singleton, id=1)."""

    __tablename__ = "signal_config"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, default=1)
    enabled: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False)
    # The linked Signal phone number (set after QR linking succeeds)
    phone_number: Mapped[Optional[str]] = mapped_column(String(32), nullable=True)
    linked: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False)
    # Fallback agent for unrouted messages
    default_agent_id: Mapped[Optional[str]] = mapped_column(String(128), nullable=True)
    # How long a conversation stays "sticky" to one agent (minutes)
    sticky_ttl_minutes: Mapped[int] = mapped_column(Integer, nullable=False, default=30)
    # When true, skip allowlist entirely — accept all incoming messages
    allow_all: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False)
    updated_at: Mapped[int] = mapped_column(BigInteger, nullable=False)


class SignalAllowlistEntry(Base):
    """Per-number allowlist entry with optional agent binding.

    Phone numbers are stored in E.164 format (+15551234567).
    Supports wildcards: '+1555*' (prefix) or '*' (accept all).
    """

    __tablename__ = "signal_allowlist"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    # E.164 phone number, prefix pattern (+1555*), or '*'
    phone_number: Mapped[str] = mapped_column(String(32), nullable=False)
    # Friendly label for the dashboard UI
    label: Mapped[Optional[str]] = mapped_column(String(256), nullable=True)
    # Optional: route this sender to a specific agent by default
    default_agent_id: Mapped[Optional[str]] = mapped_column(String(128), nullable=True)
    created_at: Mapped[int] = mapped_column(BigInteger, nullable=False)
    updated_at: Mapped[int] = mapped_column(BigInteger, nullable=False)
