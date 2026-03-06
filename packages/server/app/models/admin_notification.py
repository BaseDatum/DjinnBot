"""Admin notification model for system-level alerts visible in the admin panel."""

from typing import Optional
from sqlalchemy import String, Text, Boolean, BigInteger, Index
from sqlalchemy.orm import Mapped, mapped_column

from app.models.base import Base, PrefixedIdMixin, now_ms


class AdminNotification(PrefixedIdMixin, Base):
    """System notification surfaced in the admin panel.

    Created by the engine when infrastructure-level issues occur
    (e.g. failed image pull, resource exhaustion) so admins can
    take action without tailing logs.
    """

    __tablename__ = "admin_notifications"
    _id_prefix = "notif_"

    __table_args__ = (
        Index("idx_admin_notifications_created", "created_at"),
        Index("idx_admin_notifications_read", "read"),
    )

    level: Mapped[str] = mapped_column(String(16), nullable=False, default="info")
    """Severity: info, warning, error."""

    title: Mapped[str] = mapped_column(String(256), nullable=False)
    """Short summary shown in the notification list."""

    detail: Mapped[Optional[str]] = mapped_column(Text, nullable=True)
    """Optional longer description with technical context."""

    read: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False)
    """Whether an admin has dismissed / acknowledged this notification."""

    created_at: Mapped[int] = mapped_column(BigInteger, nullable=False, default=now_ms)
