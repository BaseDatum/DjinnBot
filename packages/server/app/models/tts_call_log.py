"""TTS call log model — tracks Fish Audio API calls for cost tracking."""

from typing import Optional
from sqlalchemy import String, Text, Integer, BigInteger, Float, Index
from sqlalchemy.orm import Mapped, mapped_column

from app.models.base import Base


class TtsCallLog(Base):
    """Individual TTS API call record.

    Each row records one round-trip to a TTS provider (Fish Audio), capturing:
    - Which session/agent triggered it
    - Provider + model used
    - Input text size (UTF-8 bytes — Fish Audio billing unit)
    - Output audio size and format
    - Estimated cost (calculated: utf8_bytes / 1M * price_per_M)
    - Latency
    - Which API key type was used (personal / admin_shared / instance)
    """

    __tablename__ = "tts_call_logs"
    __table_args__ = (
        Index("idx_tts_call_logs_session", "session_id"),
        Index("idx_tts_call_logs_agent", "agent_id"),
        Index("idx_tts_call_logs_created", "created_at"),
        Index("idx_tts_call_logs_user", "user_id"),
    )

    id: Mapped[str] = mapped_column(String(128), primary_key=True)

    # ── Context ─────────────────────────────────────────────────────────────
    session_id: Mapped[Optional[str]] = mapped_column(String(256), nullable=True)
    agent_id: Mapped[str] = mapped_column(String(128), nullable=False)
    user_id: Mapped[Optional[str]] = mapped_column(String(64), nullable=True)

    # ── Provider info ───────────────────────────────────────────────────────
    provider: Mapped[str] = mapped_column(
        String(64), nullable=False
    )  # e.g. "fish-audio"
    model: Mapped[str] = mapped_column(String(128), nullable=False)  # e.g. "s1"

    # ── Key source ──────────────────────────────────────────────────────────
    key_source: Mapped[Optional[str]] = mapped_column(
        String(32), nullable=True
    )  # "personal", "admin_shared", "instance"
    key_masked: Mapped[Optional[str]] = mapped_column(String(64), nullable=True)

    # ── Input/Output metrics ────────────────────────────────────────────────
    input_text_bytes: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    input_characters: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    output_audio_bytes: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    output_format: Mapped[str] = mapped_column(
        String(16), nullable=False, default="mp3"
    )

    # ── Voice info ──────────────────────────────────────────────────────────
    voice_id: Mapped[Optional[str]] = mapped_column(String(128), nullable=True)
    voice_name: Mapped[Optional[str]] = mapped_column(String(256), nullable=True)

    # ── Cost (USD) ──────────────────────────────────────────────────────────
    cost_total: Mapped[Optional[float]] = mapped_column(Float, nullable=True)

    # ── Performance ─────────────────────────────────────────────────────────
    duration_ms: Mapped[Optional[int]] = mapped_column(Integer, nullable=True)

    # ── Channel context ─────────────────────────────────────────────────────
    # Which channel triggered the TTS (telegram, signal, whatsapp, discord, slack, dashboard)
    channel: Mapped[Optional[str]] = mapped_column(String(32), nullable=True)

    # ── Timestamps ──────────────────────────────────────────────────────────
    created_at: Mapped[int] = mapped_column(BigInteger, nullable=False)
