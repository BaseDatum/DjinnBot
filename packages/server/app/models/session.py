"""Session and SessionEvent models for agent session tracking."""
from typing import Optional
from sqlalchemy import String, Text, Integer, BigInteger, ForeignKey, Index
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.models.base import Base


class Session(Base):
    """Agent session execution tracking."""
    __tablename__ = "sessions"
    __table_args__ = (
        Index("idx_sessions_agent_created", "agent_id", "created_at", postgresql_using="btree"),
    )
    
    id: Mapped[str] = mapped_column(String(128), primary_key=True)
    agent_id: Mapped[str] = mapped_column(String(128), nullable=False, index=True)
    source: Mapped[str] = mapped_column(String(32), nullable=False)
    source_id: Mapped[Optional[str]] = mapped_column(String(256), nullable=True)
    status: Mapped[str] = mapped_column(String(32), nullable=False, default="starting")
    user_prompt: Mapped[Optional[str]] = mapped_column(Text, nullable=True)
    output: Mapped[Optional[str]] = mapped_column(Text, nullable=True)
    error: Mapped[Optional[str]] = mapped_column(Text, nullable=True)
    model: Mapped[Optional[str]] = mapped_column(String(128), nullable=True)
    turn_count: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    created_at: Mapped[int] = mapped_column(BigInteger, nullable=False)
    started_at: Mapped[Optional[int]] = mapped_column(BigInteger, nullable=True)
    completed_at: Mapped[Optional[int]] = mapped_column(BigInteger, nullable=True)
    
    # Relationships
    events: Mapped[list["SessionEvent"]] = relationship(
        back_populates="session",
        cascade="all, delete-orphan"
    )


class SessionEvent(Base):
    """Individual events within a session."""
    __tablename__ = "session_events"
    __table_args__ = (
        Index("idx_session_events_session_ts", "session_id", "timestamp"),
    )
    
    id: Mapped[str] = mapped_column(String(64), primary_key=True)
    session_id: Mapped[str] = mapped_column(
        String(128),
        ForeignKey("sessions.id", ondelete="CASCADE"),
        nullable=False
    )
    event_type: Mapped[str] = mapped_column(String(32), nullable=False)
    timestamp: Mapped[int] = mapped_column(BigInteger, nullable=False)
    data: Mapped[str] = mapped_column(Text, nullable=False)
    
    # Relationships
    session: Mapped["Session"] = relationship(back_populates="events")
