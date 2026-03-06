"""Project-Agent-Routine mapping model.

Links a pulse routine to a specific project for a specific agent, defining:
- Which kanban columns the routine watches in this project
- Per-project tool overrides for this routine
- Whether the mapping is enabled

This is the key join table for the modular workflow system. When a pulse fires
for routine R on agent A, the system looks up all ProjectAgentRoutine rows
for (A, R) to discover which projects/columns this routine should process.
"""

from typing import Optional

from sqlalchemy import (
    String,
    BigInteger,
    Boolean,
    JSON,
    Index,
    ForeignKey,
    UniqueConstraint,
)
from sqlalchemy.orm import Mapped, mapped_column

from app.models.base import Base, PrefixedIdMixin


class ProjectAgentRoutine(Base, PrefixedIdMixin):
    """Maps a pulse routine to a project for an agent.

    When a routine fires, the runtime queries this table to find:
    1. Which projects this routine covers for this agent
    2. Which columns (statuses) the routine watches per project
    3. What tool overrides apply per project

    A single routine can be mapped to multiple projects (one row per project).
    A single project-agent pair can have multiple routine mappings.
    """

    __tablename__ = "project_agent_routines"
    _id_prefix = "par_"

    __table_args__ = (
        # Ensure one mapping per project-agent-routine triple
        UniqueConstraint(
            "project_id",
            "agent_id",
            "routine_id",
            name="uq_project_agent_routine",
        ),
        Index("idx_par_project_agent", "project_id", "agent_id"),
        Index("idx_par_agent_routine", "agent_id", "routine_id"),
        Index("idx_par_routine", "routine_id"),
    )

    # --- foreign keys ---
    project_id: Mapped[str] = mapped_column(
        String(64), ForeignKey("projects.id", ondelete="CASCADE"), nullable=False
    )
    agent_id: Mapped[str] = mapped_column(String(128), nullable=False)
    routine_id: Mapped[str] = mapped_column(
        String(64), ForeignKey("pulse_routines.id", ondelete="CASCADE"), nullable=False
    )

    # --- column mapping ---
    # JSON array of column IDs (col_xxx) that this routine watches in this project.
    # When the routine fires, it queries tasks in these columns.
    # When null → uses the routine's default pulse_columns (which are column names,
    # resolved against the project's column definitions).
    column_ids: Mapped[Optional[dict]] = mapped_column(JSON, nullable=True)

    # --- tool overrides ---
    # JSON array of tool names. When set, adds/removes tools for this specific
    # project-routine combination, layered on top of the routine's base tools.
    # Format: ["tool_name", ...] — if set, replaces the routine's tool set for this project.
    # When null → uses the routine's tools (or agent default if routine tools are also null).
    tool_overrides: Mapped[Optional[dict]] = mapped_column(JSON, nullable=True)

    # --- enabled flag ---
    # Allows disabling a routine for a specific project without removing the mapping.
    enabled: Mapped[bool] = mapped_column(Boolean, nullable=False, default=True)

    # --- timestamps ---
    created_at: Mapped[int] = mapped_column(BigInteger, nullable=False)
    updated_at: Mapped[int] = mapped_column(BigInteger, nullable=False)
