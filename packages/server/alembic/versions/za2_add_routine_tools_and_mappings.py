"""Add per-routine tools and project-agent-routine mappings.

Phase 2 of the modular workflow redesign:
- Adds 'tools' JSON column to pulse_routines for per-routine tool selection
- Creates project_agent_routines table for mapping routines to project columns

Revision ID: za2_routine_tools
Revises: ee1f2g3h4i5j
Create Date: 2026-02-24

"""

from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision: str = "za2_routine_tools"
down_revision: Union[str, Sequence[str], None] = "ee1f2g3h4i5j"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    """Add tools to pulse_routines and create project_agent_routines."""

    # Add tools column to pulse_routines
    op.add_column(
        "pulse_routines",
        sa.Column("tools", sa.JSON, nullable=True),
    )

    # Create project_agent_routines table
    op.create_table(
        "project_agent_routines",
        sa.Column("id", sa.String(64), primary_key=True),
        sa.Column(
            "project_id",
            sa.String(64),
            sa.ForeignKey("projects.id", ondelete="CASCADE"),
            nullable=False,
        ),
        sa.Column("agent_id", sa.String(128), nullable=False),
        sa.Column(
            "routine_id",
            sa.String(64),
            sa.ForeignKey("pulse_routines.id", ondelete="CASCADE"),
            nullable=False,
        ),
        sa.Column("column_ids", sa.JSON, nullable=True),
        sa.Column("tool_overrides", sa.JSON, nullable=True),
        sa.Column("enabled", sa.Boolean, nullable=False, server_default="1"),
        sa.Column("created_at", sa.BigInteger, nullable=False),
        sa.Column("updated_at", sa.BigInteger, nullable=False),
        sa.UniqueConstraint(
            "project_id",
            "agent_id",
            "routine_id",
            name="uq_project_agent_routine",
        ),
    )
    op.create_index(
        "idx_par_project_agent",
        "project_agent_routines",
        ["project_id", "agent_id"],
    )
    op.create_index(
        "idx_par_agent_routine",
        "project_agent_routines",
        ["agent_id", "routine_id"],
    )
    op.create_index(
        "idx_par_routine",
        "project_agent_routines",
        ["routine_id"],
    )


def downgrade() -> None:
    """Remove project_agent_routines table and tools column."""
    op.drop_index("idx_par_routine", table_name="project_agent_routines")
    op.drop_index("idx_par_agent_routine", table_name="project_agent_routines")
    op.drop_index("idx_par_project_agent", table_name="project_agent_routines")
    op.drop_table("project_agent_routines")
    op.drop_column("pulse_routines", "tools")
