"""Project template models.

Templates define reusable project structures: kanban columns, status semantics,
default pipelines, and optional onboarding agent chains.

Built-in templates (is_builtin=True) are seeded on startup and cannot be deleted.
Users can create custom templates (is_builtin=False) from scratch or by cloning
a built-in template.
"""

from typing import Optional

from sqlalchemy import String, Text, Integer, Boolean, JSON, Index
from sqlalchemy.orm import Mapped, mapped_column

from app.models.base import Base, PrefixedIdMixin, TimestampMixin


class ProjectTemplate(Base, PrefixedIdMixin, TimestampMixin):
    """Reusable project template.

    A template defines:
    - columns: Kanban board column definitions (name, position, wip_limit, statuses)
    - status_semantics: Which statuses have special meaning for the engine
    - metadata: Template-specific flags (git_integration, etc.)
    - Optionally: default pipeline, onboarding agent chain
    """

    __tablename__ = "project_templates"
    _id_prefix = "tmpl_"

    __table_args__ = (Index("idx_project_templates_slug", "slug", unique=True),)

    # --- identity ---
    slug: Mapped[str] = mapped_column(String(128), nullable=False, unique=True)
    name: Mapped[str] = mapped_column(String(256), nullable=False)
    description: Mapped[str] = mapped_column(Text, nullable=False, default="")
    icon: Mapped[Optional[str]] = mapped_column(String(16), nullable=True)

    # --- built-in flag ---
    is_builtin: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False)

    # --- column definitions ---
    # JSON array of: {name: str, position: int, wip_limit: int|null, statuses: [str]}
    # NOTE: Column name is "board_columns" to avoid clash with SQLAlchemy's
    # reserved "columns" attribute on DeclarativeBase/Table.
    board_columns: Mapped[dict] = mapped_column("board_columns", JSON, nullable=False)

    # --- status semantics ---
    # Tells the engine which statuses have special meaning.
    # {
    #   "initial": ["backlog"],          -- where new tasks land
    #   "terminal_done": ["done"],       -- dependency resolution: "all deps done"
    #   "terminal_fail": ["failed"],     -- cascade blocking trigger
    #   "blocked": ["blocked"],          -- where blocked tasks are moved
    #   "in_progress": ["in_progress"],  -- active work (agent concurrency checks)
    #   "claimable": ["backlog", "ready", "planning"],  -- agents can claim these
    # }
    status_semantics: Mapped[dict] = mapped_column(JSON, nullable=False)

    # --- defaults ---
    default_pipeline_id: Mapped[Optional[str]] = mapped_column(
        String(128), nullable=True
    )

    # --- onboarding ---
    # JSON array of agent IDs for the onboarding flow, or null for no onboarding.
    # e.g. ["stas", "jim", "eric", "finn"]
    onboarding_agent_chain: Mapped[Optional[dict]] = mapped_column(JSON, nullable=True)

    # --- template-specific config ---
    # Extensible JSON blob for template-specific features.
    # e.g. {"git_integration": true, "review_stages": ["spec", "quality"]}
    # NOTE: Column name is "template_metadata" to avoid clash with SQLAlchemy's
    # reserved "metadata" attribute on DeclarativeBase.
    template_metadata: Mapped[dict] = mapped_column(
        "template_metadata", JSON, nullable=False, default=dict
    )

    # --- ordering ---
    sort_order: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
