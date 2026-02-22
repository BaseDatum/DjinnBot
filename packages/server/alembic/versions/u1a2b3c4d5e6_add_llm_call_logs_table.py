"""Add llm_call_logs table for per-API-call tracking.

Records individual LLM API calls within sessions and runs, including
token usage, cost estimates, latency, and which API key type was used.

Revision ID: u1a2b3c4d5e6
Revises: t1a2b3c4d5e6
Create Date: 2026-02-22

"""

from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision: str = "u1a2b3c4d5e6"
down_revision: Union[str, None] = "t1a2b3c4d5e6"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.create_table(
        "llm_call_logs",
        sa.Column("id", sa.String(128), primary_key=True),
        # Context
        sa.Column("session_id", sa.String(256), nullable=True),
        sa.Column("run_id", sa.String(256), nullable=True),
        sa.Column("agent_id", sa.String(128), nullable=False),
        sa.Column("request_id", sa.String(256), nullable=True),
        # Model info
        sa.Column("provider", sa.String(64), nullable=False),
        sa.Column("model", sa.String(128), nullable=False),
        # Key source
        sa.Column("key_source", sa.String(32), nullable=True),
        sa.Column("key_masked", sa.String(64), nullable=True),
        # Token usage
        sa.Column("input_tokens", sa.Integer, nullable=False, server_default="0"),
        sa.Column("output_tokens", sa.Integer, nullable=False, server_default="0"),
        sa.Column("cache_read_tokens", sa.Integer, nullable=False, server_default="0"),
        sa.Column("cache_write_tokens", sa.Integer, nullable=False, server_default="0"),
        sa.Column("total_tokens", sa.Integer, nullable=False, server_default="0"),
        # Cost (USD)
        sa.Column("cost_input", sa.Float, nullable=True),
        sa.Column("cost_output", sa.Float, nullable=True),
        sa.Column("cost_total", sa.Float, nullable=True),
        # Performance
        sa.Column("duration_ms", sa.Integer, nullable=True),
        # Metadata
        sa.Column("tool_call_count", sa.Integer, nullable=False, server_default="0"),
        sa.Column("has_thinking", sa.Boolean, nullable=False, server_default="false"),
        sa.Column("stop_reason", sa.String(32), nullable=True),
        # Timestamps
        sa.Column("created_at", sa.BigInteger, nullable=False),
    )

    op.create_index("idx_llm_call_logs_session", "llm_call_logs", ["session_id"])
    op.create_index("idx_llm_call_logs_run", "llm_call_logs", ["run_id"])
    op.create_index("idx_llm_call_logs_created", "llm_call_logs", ["created_at"])


def downgrade() -> None:
    op.drop_index("idx_llm_call_logs_created", table_name="llm_call_logs")
    op.drop_index("idx_llm_call_logs_run", table_name="llm_call_logs")
    op.drop_index("idx_llm_call_logs_session", table_name="llm_call_logs")
    op.drop_table("llm_call_logs")
