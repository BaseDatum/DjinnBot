"""Pulse routine models - per-agent named pulse routines with independent schedules."""

from typing import Optional

from sqlalchemy import String, BigInteger, Integer, Boolean, Text, Index, JSON
from sqlalchemy.orm import Mapped, mapped_column

from app.models.base import Base, PrefixedIdMixin, TimestampMixin, now_ms


class PulseRoutine(Base, PrefixedIdMixin, TimestampMixin):
    """A named pulse routine belonging to an agent.

    Each agent can have multiple routines, each with its own instructions
    (prompt), schedule, and configuration.  The scheduler fires each routine
    independently according to its own interval/offset/blackout settings.
    """

    __tablename__ = "pulse_routines"
    _id_prefix = "pr_"

    __table_args__ = (
        Index("idx_pulse_routines_agent", "agent_id"),
        Index("idx_pulse_routines_agent_name", "agent_id", "name", unique=True),
    )

    # --- identity ---
    agent_id: Mapped[str] = mapped_column(String(128), nullable=False)
    name: Mapped[str] = mapped_column(String(256), nullable=False)
    description: Mapped[Optional[str]] = mapped_column(Text, nullable=True)

    # --- prompt ---
    instructions: Mapped[str] = mapped_column(Text, nullable=False, default="")

    # If this was auto-migrated from a PULSE.md file on disk, this field
    # records the source filename.  While set AND instructions have not been
    # edited via the dashboard, the runtime will prefer to read from the file
    # (so manual edits to the file are picked up).  Cleared on first dashboard
    # edit.
    source_file: Mapped[Optional[str]] = mapped_column(String(256), nullable=True)

    # --- schedule ---
    enabled: Mapped[bool] = mapped_column(Boolean, nullable=False, default=True)
    interval_minutes: Mapped[int] = mapped_column(Integer, nullable=False, default=30)
    offset_minutes: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    blackouts: Mapped[Optional[dict]] = mapped_column(JSON, nullable=True, default=list)
    one_offs: Mapped[Optional[dict]] = mapped_column(JSON, nullable=True, default=list)

    # --- execution ---
    timeout_ms: Mapped[Optional[int]] = mapped_column(Integer, nullable=True)
    max_concurrent: Mapped[int] = mapped_column(Integer, nullable=False, default=1)
    pulse_columns: Mapped[Optional[dict]] = mapped_column(JSON, nullable=True)

    # --- ordering ---
    sort_order: Mapped[int] = mapped_column(Integer, nullable=False, default=0)

    # --- stats (denormalised for quick display) ---
    last_run_at: Mapped[Optional[int]] = mapped_column(BigInteger, nullable=True)
    total_runs: Mapped[int] = mapped_column(Integer, nullable=False, default=0)

    # --- color for UI ---
    color: Mapped[Optional[str]] = mapped_column(String(32), nullable=True)
