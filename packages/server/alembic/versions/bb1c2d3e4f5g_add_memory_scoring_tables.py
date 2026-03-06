"""Add memory retrieval scoring tables.

Implements the Retrieval Outcome Tracking system:
- memory_retrieval_log: Append-only log of every memory surfaced during
  recall/wake, tagged with step outcome (success/failure).
- memory_scores: Materialized aggregates per (agent_id, memory_id),
  updated via upsert on each retrieval batch. Queried at recall time
  to blend adaptive scores with raw BM25/vector scores.

Revision ID: bb1c2d3e4f5g
Revises: aa1b2c3d4e5f
Create Date: 2026-02-23

"""

from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision: str = "bb1c2d3e4f5g"
down_revision: Union[str, None] = "aa1b2c3d4e5f"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    # ── memory_retrieval_log ────────────────────────────────────────────────
    op.create_table(
        "memory_retrieval_log",
        sa.Column("id", sa.String(128), primary_key=True),
        # Context
        sa.Column("agent_id", sa.String(128), nullable=False),
        sa.Column("session_id", sa.String(256), nullable=True),
        sa.Column("run_id", sa.String(256), nullable=True),
        sa.Column("request_id", sa.String(256), nullable=True),
        # Memory identification
        sa.Column("memory_id", sa.String(512), nullable=False),
        sa.Column("memory_title", sa.String(512), nullable=True),
        # Retrieval metadata
        sa.Column("query", sa.Text, nullable=True),
        sa.Column(
            "retrieval_source",
            sa.String(32),
            nullable=False,
            server_default="bm25",
        ),
        sa.Column("raw_score", sa.Float, nullable=False, server_default="0.0"),
        # Outcome (filled in after step completes)
        sa.Column("step_success", sa.Boolean, nullable=True),
        # Timestamps
        sa.Column("created_at", sa.BigInteger, nullable=False),
    )

    op.create_index("idx_mrl_agent", "memory_retrieval_log", ["agent_id"])
    op.create_index("idx_mrl_memory", "memory_retrieval_log", ["agent_id", "memory_id"])
    op.create_index("idx_mrl_created", "memory_retrieval_log", ["created_at"])

    # ── memory_scores ───────────────────────────────────────────────────────
    op.create_table(
        "memory_scores",
        sa.Column("id", sa.String(128), primary_key=True),
        sa.Column("agent_id", sa.String(128), nullable=False),
        sa.Column("memory_id", sa.String(512), nullable=False),
        # Counters
        sa.Column("access_count", sa.Integer, nullable=False, server_default="0"),
        sa.Column("success_count", sa.Integer, nullable=False, server_default="0"),
        sa.Column("failure_count", sa.Integer, nullable=False, server_default="0"),
        # Derived scores
        sa.Column("success_rate", sa.Float, nullable=False, server_default="0.5"),
        sa.Column("adaptive_score", sa.Float, nullable=False, server_default="0.5"),
        # Timestamps
        sa.Column("last_accessed", sa.BigInteger, nullable=False),
        sa.Column("created_at", sa.BigInteger, nullable=False),
        sa.Column("updated_at", sa.BigInteger, nullable=False),
    )

    op.create_index("idx_ms_agent", "memory_scores", ["agent_id"])
    op.create_index("idx_ms_adaptive", "memory_scores", ["agent_id", "adaptive_score"])
    # Unique constraint for upsert lookups
    op.create_index(
        "idx_ms_agent_memory",
        "memory_scores",
        ["agent_id", "memory_id"],
        unique=True,
    )


def downgrade() -> None:
    op.drop_index("idx_ms_agent_memory", table_name="memory_scores")
    op.drop_index("idx_ms_adaptive", table_name="memory_scores")
    op.drop_index("idx_ms_agent", table_name="memory_scores")
    op.drop_table("memory_scores")

    op.drop_index("idx_mrl_created", table_name="memory_retrieval_log")
    op.drop_index("idx_mrl_memory", table_name="memory_retrieval_log")
    op.drop_index("idx_mrl_agent", table_name="memory_retrieval_log")
    op.drop_table("memory_retrieval_log")
