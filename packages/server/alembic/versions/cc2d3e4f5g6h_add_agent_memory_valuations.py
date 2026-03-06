"""Add agent-driven memory valuation tables and columns.

Replaces step-success-based scoring with explicit agent valuations:
- memory_valuations: Agent-authored "useful / not useful" ratings, the
  PRIMARY signal for adaptive memory scoring.
- memory_gaps: Knowledge the agent needed but couldn't find — surfaced
  in the dashboard for gap analysis.
- New columns on memory_scores: valuation_count, useful_count,
  not_useful_count, usefulness_rate, last_valued.
- Drops legacy columns from memory_scores: success_count, failure_count,
  success_rate (no longer used — scoring is agent-driven).
- Drops legacy column from memory_retrieval_log: step_success.

Revision ID: cc2d3e4f5g6h
Revises: za5_tmpl_metadata
Create Date: 2026-02-25

"""

from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision: str = "cc2d3e4f5g6h"
down_revision: Union[str, Sequence[str], None] = "za5_tmpl_metadata"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    # ── memory_valuations ───────────────────────────────────────────────────
    op.create_table(
        "memory_valuations",
        sa.Column("id", sa.String(128), primary_key=True),
        # Context
        sa.Column("agent_id", sa.String(128), nullable=False),
        sa.Column("session_id", sa.String(256), nullable=True),
        sa.Column("run_id", sa.String(256), nullable=True),
        # Memory identification
        sa.Column("memory_id", sa.String(512), nullable=False),
        sa.Column("memory_title", sa.String(512), nullable=True),
        # Valuation
        sa.Column("useful", sa.Boolean, nullable=False),
        # Timestamps
        sa.Column("created_at", sa.BigInteger, nullable=False),
    )

    op.create_index("idx_mv_agent", "memory_valuations", ["agent_id"])
    op.create_index("idx_mv_memory", "memory_valuations", ["agent_id", "memory_id"])
    op.create_index("idx_mv_created", "memory_valuations", ["created_at"])

    # ── memory_gaps ─────────────────────────────────────────────────────────
    op.create_table(
        "memory_gaps",
        sa.Column("id", sa.String(128), primary_key=True),
        # Context
        sa.Column("agent_id", sa.String(128), nullable=False),
        sa.Column("session_id", sa.String(256), nullable=True),
        sa.Column("run_id", sa.String(256), nullable=True),
        # Gap description
        sa.Column("description", sa.Text, nullable=False),
        sa.Column("query_attempted", sa.Text, nullable=True),
        # Timestamps
        sa.Column("created_at", sa.BigInteger, nullable=False),
    )

    op.create_index("idx_mg_agent", "memory_gaps", ["agent_id"])
    op.create_index("idx_mg_created", "memory_gaps", ["created_at"])

    # ── Add valuation columns to memory_scores ──────────────────────────────
    op.add_column(
        "memory_scores",
        sa.Column("valuation_count", sa.Integer, nullable=False, server_default="0"),
    )
    op.add_column(
        "memory_scores",
        sa.Column("useful_count", sa.Integer, nullable=False, server_default="0"),
    )
    op.add_column(
        "memory_scores",
        sa.Column("not_useful_count", sa.Integer, nullable=False, server_default="0"),
    )
    op.add_column(
        "memory_scores",
        sa.Column("usefulness_rate", sa.Float, nullable=False, server_default="0.5"),
    )
    op.add_column(
        "memory_scores",
        sa.Column("last_valued", sa.BigInteger, nullable=True),
    )

    # ── Drop legacy step-success columns ────────────────────────────────────
    op.drop_column("memory_scores", "success_count")
    op.drop_column("memory_scores", "failure_count")
    op.drop_column("memory_scores", "success_rate")
    op.drop_column("memory_retrieval_log", "step_success")


def downgrade() -> None:
    # Restore legacy columns
    op.add_column(
        "memory_retrieval_log",
        sa.Column("step_success", sa.Boolean, nullable=True),
    )
    op.add_column(
        "memory_scores",
        sa.Column("success_rate", sa.Float, nullable=False, server_default="0.5"),
    )
    op.add_column(
        "memory_scores",
        sa.Column("failure_count", sa.Integer, nullable=False, server_default="0"),
    )
    op.add_column(
        "memory_scores",
        sa.Column("success_count", sa.Integer, nullable=False, server_default="0"),
    )

    # Drop new columns from memory_scores
    op.drop_column("memory_scores", "last_valued")
    op.drop_column("memory_scores", "usefulness_rate")
    op.drop_column("memory_scores", "not_useful_count")
    op.drop_column("memory_scores", "useful_count")
    op.drop_column("memory_scores", "valuation_count")

    # Drop memory_gaps
    op.drop_index("idx_mg_created", table_name="memory_gaps")
    op.drop_index("idx_mg_agent", table_name="memory_gaps")
    op.drop_table("memory_gaps")

    # Drop memory_valuations
    op.drop_index("idx_mv_created", table_name="memory_valuations")
    op.drop_index("idx_mv_memory", table_name="memory_valuations")
    op.drop_index("idx_mv_agent", table_name="memory_valuations")
    op.drop_table("memory_valuations")
