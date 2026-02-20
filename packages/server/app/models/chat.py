"""Chat session and message models for interactive agent conversations."""
from typing import Optional, List
from sqlalchemy import String, Text, Integer, BigInteger, ForeignKey, Index, JSON
from sqlalchemy.orm import Mapped, mapped_column, relationship
from app.models.base import Base


class ChatSession(Base):
    """Interactive chat session with an agent."""
    __tablename__ = "chat_sessions"
    __table_args__ = (
        Index("idx_chat_sessions_agent_status", "agent_id", "status"),
        Index("idx_chat_sessions_agent_created", "agent_id", "created_at"),
    )
    
    id: Mapped[str] = mapped_column(String(128), primary_key=True)  # chat_{agentId}_{timestamp}
    agent_id: Mapped[str] = mapped_column(String(128), nullable=False, index=True)
    status: Mapped[str] = mapped_column(String(32), nullable=False, default="ready")
    # Status values: ready, starting, running, paused, completed, failed
    
    model: Mapped[str] = mapped_column(String(128), nullable=False)  # Can be changed mid-session
    container_id: Mapped[Optional[str]] = mapped_column(String(128), nullable=True)  # Docker container ID
    
    created_at: Mapped[int] = mapped_column(BigInteger, nullable=False)
    started_at: Mapped[Optional[int]] = mapped_column(BigInteger, nullable=True)  # When container started
    last_activity_at: Mapped[int] = mapped_column(BigInteger, nullable=False)  # For timeout detection
    completed_at: Mapped[Optional[int]] = mapped_column(BigInteger, nullable=True)
    
    error: Mapped[Optional[str]] = mapped_column(Text, nullable=True)  # Error message if failed
    
    # Relationships
    messages: Mapped[List["ChatMessage"]] = relationship(
        back_populates="session",
        cascade="all, delete-orphan",
        order_by="ChatMessage.created_at"
    )


class ChatMessage(Base):
    """Individual message in a chat session."""
    __tablename__ = "chat_messages"
    __table_args__ = (
        Index("idx_chat_messages_session_created", "session_id", "created_at"),
    )
    
    id: Mapped[str] = mapped_column(String(64), primary_key=True)
    session_id: Mapped[str] = mapped_column(
        String(128),
        ForeignKey("chat_sessions.id", ondelete="CASCADE"),
        nullable=False
    )
    
    role: Mapped[str] = mapped_column(String(16), nullable=False)  # user, assistant, system
    content: Mapped[str] = mapped_column(Text, nullable=False)  # The message content
    model: Mapped[Optional[str]] = mapped_column(String(128), nullable=True)  # Model used (for assistant)
    
    # For assistant messages - store structured data
    thinking: Mapped[Optional[str]] = mapped_column(Text, nullable=True)  # Accumulated thinking
    tool_calls: Mapped[Optional[str]] = mapped_column(Text, nullable=True)  # JSON array of tool calls
    
    created_at: Mapped[int] = mapped_column(BigInteger, nullable=False)
    completed_at: Mapped[Optional[int]] = mapped_column(BigInteger, nullable=True)  # When response finished
    
    # Relationships
    session: Mapped["ChatSession"] = relationship(back_populates="messages")


# TODO: Future feature - Event replay
# For streaming event replay functionality, we could add a ChatEvent model
# to persist individual streaming chunks (thinking, output, tool calls) with
# timestamps. This would enable session replay in the UI but requires:
# - Persisting every streaming chunk during message generation
# - A replay endpoint to stream historical events
# - UI components to visualize the replay
