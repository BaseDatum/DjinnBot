"""Waitlist and email configuration models."""

from typing import Optional
from sqlalchemy import String, Text, Boolean, BigInteger, Index
from sqlalchemy.orm import Mapped, mapped_column

from app.models.base import Base, now_ms


class WaitlistEntry(Base):
    """Someone who signed up for the waitlist."""

    __tablename__ = "waitlist_entries"
    __table_args__ = (
        Index("idx_waitlist_entries_email", "email", unique=True),
        Index("idx_waitlist_entries_status", "status"),
    )

    id: Mapped[str] = mapped_column(String(64), primary_key=True)
    email: Mapped[str] = mapped_column(String(320), nullable=False, unique=True)
    status: Mapped[str] = mapped_column(
        String(32), nullable=False, default="waiting"
    )  # waiting, invited, registered
    invited_at: Mapped[Optional[int]] = mapped_column(BigInteger, nullable=True)
    registered_at: Mapped[Optional[int]] = mapped_column(BigInteger, nullable=True)
    created_at: Mapped[int] = mapped_column(BigInteger, nullable=False)


class EmailSettings(Base):
    """SMTP email provider configuration (singleton-style, keyed by 'default')."""

    __tablename__ = "email_settings"

    id: Mapped[str] = mapped_column(String(64), primary_key=True, default="default")
    smtp_host: Mapped[str] = mapped_column(String(256), nullable=False, default="")
    smtp_port: Mapped[int] = mapped_column(BigInteger, nullable=False, default=587)
    smtp_username: Mapped[str] = mapped_column(String(256), nullable=False, default="")
    # Stored encrypted or plain depending on deployment.
    smtp_password: Mapped[str] = mapped_column(Text, nullable=False, default="")
    smtp_use_tls: Mapped[bool] = mapped_column(Boolean, nullable=False, default=True)
    from_email: Mapped[str] = mapped_column(String(320), nullable=False, default="")
    from_name: Mapped[str] = mapped_column(
        String(256), nullable=False, default="DjinnBot"
    )
    updated_at: Mapped[int] = mapped_column(BigInteger, nullable=False)
