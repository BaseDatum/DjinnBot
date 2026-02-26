"""Chat session and message models for interactive agent conversations."""

from typing import Optional, List
from sqlalchemy import String, Text, Integer, BigInteger, ForeignKey, Index, JSON
from sqlalchemy.orm import Mapped, mapped_column, relationship
from app.models.base import Base


# ── Allowed file types for chat attachments ────────────────────────────────────

ALLOWED_IMAGE_TYPES = {"image/jpeg", "image/png", "image/gif", "image/webp"}
ALLOWED_DOCUMENT_TYPES = {
    "application/pdf",
    "text/plain",
    "text/markdown",
    "text/csv",
    "application/json",
}
ALLOWED_CODE_TYPES = {
    "text/x-python",
    "text/javascript",
    "text/typescript",
    "text/html",
    "text/css",
    "text/xml",
    "application/xml",
    "application/x-yaml",
    "text/yaml",
}
ALLOWED_MIME_TYPES = ALLOWED_IMAGE_TYPES | ALLOWED_DOCUMENT_TYPES | ALLOWED_CODE_TYPES

# 30 MB — matches Anthropic's per-file limit
MAX_ATTACHMENT_SIZE = 30 * 1024 * 1024


class ChatSession(Base):
    """Interactive chat session with an agent."""

    __tablename__ = "chat_sessions"
    __table_args__ = (
        Index("idx_chat_sessions_agent_status", "agent_id", "status"),
        Index("idx_chat_sessions_agent_created", "agent_id", "created_at"),
    )

    id: Mapped[str] = mapped_column(
        String(128), primary_key=True
    )  # chat_{agentId}_{timestamp}
    agent_id: Mapped[str] = mapped_column(String(128), nullable=False, index=True)
    status: Mapped[str] = mapped_column(String(32), nullable=False, default="ready")
    # Status values: ready, starting, running, paused, completed, failed

    model: Mapped[str] = mapped_column(
        String(128), nullable=False
    )  # Can be changed mid-session
    container_id: Mapped[Optional[str]] = mapped_column(
        String(128), nullable=True
    )  # Docker container ID

    created_at: Mapped[int] = mapped_column(BigInteger, nullable=False)
    started_at: Mapped[Optional[int]] = mapped_column(
        BigInteger, nullable=True
    )  # When container started
    last_activity_at: Mapped[int] = mapped_column(
        BigInteger, nullable=False
    )  # For timeout detection
    completed_at: Mapped[Optional[int]] = mapped_column(BigInteger, nullable=True)

    error: Mapped[Optional[str]] = mapped_column(
        Text, nullable=True
    )  # Error message if failed

    # JSON blob recording which API keys were resolved for this session
    # e.g. {"source": "executing_user", "userId": "...", "resolvedProviders": ["anthropic", "openai"]}
    key_resolution: Mapped[Optional[str]] = mapped_column(Text, nullable=True)

    # Relationships
    messages: Mapped[List["ChatMessage"]] = relationship(
        back_populates="session",
        cascade="all, delete-orphan",
        order_by="ChatMessage.created_at",
    )
    attachments: Mapped[List["ChatAttachment"]] = relationship(
        back_populates="session",
        cascade="all, delete-orphan",
    )


class ChatMessage(Base):
    """Individual message in a chat session."""

    __tablename__ = "chat_messages"
    __table_args__ = (
        Index("idx_chat_messages_session_created", "session_id", "created_at"),
    )

    id: Mapped[str] = mapped_column(String(64), primary_key=True)
    session_id: Mapped[str] = mapped_column(
        String(128), ForeignKey("chat_sessions.id", ondelete="CASCADE"), nullable=False
    )

    role: Mapped[str] = mapped_column(
        String(16), nullable=False
    )  # user, assistant, system
    content: Mapped[str] = mapped_column(Text, nullable=False)  # The message content
    model: Mapped[Optional[str]] = mapped_column(
        String(128), nullable=True
    )  # Model used (for assistant)

    # For assistant messages - store structured data
    thinking: Mapped[Optional[str]] = mapped_column(
        Text, nullable=True
    )  # Accumulated thinking
    tool_calls: Mapped[Optional[str]] = mapped_column(
        Text, nullable=True
    )  # JSON array of tool calls

    # JSON array of attachment IDs linked to this message (for user messages)
    attachments: Mapped[Optional[str]] = mapped_column(Text, nullable=True)

    created_at: Mapped[int] = mapped_column(BigInteger, nullable=False)
    completed_at: Mapped[Optional[int]] = mapped_column(
        BigInteger, nullable=True
    )  # When response finished

    # Relationships
    session: Mapped["ChatSession"] = relationship(back_populates="messages")


class ChatAttachment(Base):
    """File attached to a chat session (images, documents, code files)."""

    __tablename__ = "chat_attachments"
    __table_args__ = (
        Index("idx_chat_attachments_session", "session_id"),
        Index("idx_chat_attachments_message", "message_id"),
    )

    id: Mapped[str] = mapped_column(String(64), primary_key=True)  # att_xxxx
    session_id: Mapped[str] = mapped_column(
        String(128),
        ForeignKey("chat_sessions.id", ondelete="CASCADE"),
        nullable=False,
    )
    message_id: Mapped[Optional[str]] = mapped_column(
        String(64),
        ForeignKey("chat_messages.id", ondelete="SET NULL"),
        nullable=True,
    )

    filename: Mapped[str] = mapped_column(String(512), nullable=False)
    mime_type: Mapped[str] = mapped_column(String(128), nullable=False)
    size_bytes: Mapped[int] = mapped_column(BigInteger, nullable=False)
    storage_path: Mapped[str] = mapped_column(String(1024), nullable=False)

    # Processing state: uploaded → processing → ready → failed
    processing_status: Mapped[str] = mapped_column(
        String(32), nullable=False, default="uploaded"
    )
    # For documents: plain-text extraction of the file contents
    extracted_text: Mapped[Optional[str]] = mapped_column(Text, nullable=True)
    # Estimated token count of the attachment content (for context budget)
    estimated_tokens: Mapped[Optional[int]] = mapped_column(Integer, nullable=True)

    # ── PDF-specific fields (OpenDataLoader integration) ──────────────────
    # Structured JSON data from opendataloader-pdf (bounding boxes, types, etc.)
    structured_json: Mapped[Optional[str]] = mapped_column(Text, nullable=True)
    # PDF metadata
    pdf_title: Mapped[Optional[str]] = mapped_column(String(512), nullable=True)
    pdf_author: Mapped[Optional[str]] = mapped_column(String(256), nullable=True)
    pdf_page_count: Mapped[Optional[int]] = mapped_column(Integer, nullable=True)
    # Vault ingest status: null (not a PDF), pending, ingested, failed
    vault_ingest_status: Mapped[Optional[str]] = mapped_column(
        String(32), nullable=True
    )
    # Slug used for the vault directory (documents/{slug}/)
    vault_doc_slug: Mapped[Optional[str]] = mapped_column(String(128), nullable=True)
    # Number of chunks created in the vault
    vault_chunk_count: Mapped[Optional[int]] = mapped_column(Integer, nullable=True)

    created_at: Mapped[int] = mapped_column(BigInteger, nullable=False)

    # Relationships
    session: Mapped["ChatSession"] = relationship(back_populates="attachments")
