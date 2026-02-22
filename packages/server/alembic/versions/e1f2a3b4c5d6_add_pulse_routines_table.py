"""add_pulse_routines_table

Adds pulse_routines table for per-agent named pulse routines.  Each agent can
have multiple routines with independent instructions, schedules, and execution
settings.

Revision ID: e1f2a3b4c5d6
Revises: c9d3e5f7a2b1
Create Date: 2026-02-22 00:00:00.000000

"""

from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision: str = "e1f2a3b4c5d6"
down_revision: Union[str, Sequence[str], None] = "c9d3e5f7a2b1"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.create_table(
        "pulse_routines",
        # identity
        sa.Column("id", sa.String(length=64), nullable=False),
        sa.Column("agent_id", sa.String(length=128), nullable=False),
        sa.Column("name", sa.String(length=256), nullable=False),
        sa.Column("description", sa.Text(), nullable=True),
        # prompt
        sa.Column("instructions", sa.Text(), nullable=False, server_default=""),
        sa.Column("source_file", sa.String(length=256), nullable=True),
        # schedule
        sa.Column(
            "enabled", sa.Boolean(), nullable=False, server_default=sa.text("true")
        ),
        sa.Column(
            "interval_minutes",
            sa.Integer(),
            nullable=False,
            server_default=sa.text("30"),
        ),
        sa.Column(
            "offset_minutes", sa.Integer(), nullable=False, server_default=sa.text("0")
        ),
        sa.Column("blackouts", sa.JSON(), nullable=True),
        sa.Column("one_offs", sa.JSON(), nullable=True),
        # execution
        sa.Column("timeout_ms", sa.Integer(), nullable=True),
        sa.Column(
            "max_concurrent", sa.Integer(), nullable=False, server_default=sa.text("1")
        ),
        sa.Column("pulse_columns", sa.JSON(), nullable=True),
        # ordering
        sa.Column(
            "sort_order", sa.Integer(), nullable=False, server_default=sa.text("0")
        ),
        # stats
        sa.Column("last_run_at", sa.BigInteger(), nullable=True),
        sa.Column(
            "total_runs", sa.Integer(), nullable=False, server_default=sa.text("0")
        ),
        # color
        sa.Column("color", sa.String(length=32), nullable=True),
        # timestamps
        sa.Column("created_at", sa.BigInteger(), nullable=False),
        sa.Column("updated_at", sa.BigInteger(), nullable=False),
        # constraints
        sa.PrimaryKeyConstraint("id"),
    )

    op.create_index("idx_pulse_routines_agent", "pulse_routines", ["agent_id"])
    op.create_index(
        "idx_pulse_routines_agent_name",
        "pulse_routines",
        ["agent_id", "name"],
        unique=True,
    )


def downgrade() -> None:
    op.drop_index("idx_pulse_routines_agent_name", table_name="pulse_routines")
    op.drop_index("idx_pulse_routines_agent", table_name="pulse_routines")
    op.drop_table("pulse_routines")
