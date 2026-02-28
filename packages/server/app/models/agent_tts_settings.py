"""Per-agent TTS settings — stored in DB so they persist across restarts."""

from typing import Optional
from sqlalchemy import String, Boolean, BigInteger
from sqlalchemy.orm import Mapped, mapped_column

from app.models.base import Base


class AgentTtsSettings(Base):
    """Per-agent text-to-speech configuration.

    Stored in the database (not YAML) so settings persist across
    container restarts and image rebuilds.
    """

    __tablename__ = "agent_tts_settings"

    agent_id: Mapped[str] = mapped_column(String(128), primary_key=True)
    tts_enabled: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False)
    tts_provider: Mapped[Optional[str]] = mapped_column(String(64), nullable=True)
    tts_voice_id: Mapped[Optional[str]] = mapped_column(String(128), nullable=True)
    tts_voice_name: Mapped[Optional[str]] = mapped_column(String(256), nullable=True)
    updated_at: Mapped[int] = mapped_column(BigInteger, nullable=False)
