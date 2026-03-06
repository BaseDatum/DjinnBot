"""Add context usage columns to llm_call_logs.

Stores a point-in-time snapshot of context window utilisation
(tokens used / window size / percentage) with each LLM call so the
dashboard can display a live context gauge alongside cost.

Revision ID: zb8_ctx_usage
Revises: zb7_msg_perms
Create Date: 2026-02-28 14:00:00.000000
"""

from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa
from sqlalchemy import inspect


# revision identifiers, used by Alembic.
revision: str = "zb8_ctx_usage"
down_revision: Union[str, Sequence[str], None] = "zb7_msg_perms"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    conn = op.get_bind()
    inspector = inspect(conn)
    columns = {c["name"] for c in inspector.get_columns("llm_call_logs")}

    if "context_used_tokens" not in columns:
        op.add_column(
            "llm_call_logs",
            sa.Column("context_used_tokens", sa.Integer(), nullable=True),
        )
    if "context_window_tokens" not in columns:
        op.add_column(
            "llm_call_logs",
            sa.Column("context_window_tokens", sa.Integer(), nullable=True),
        )
    if "context_percent" not in columns:
        op.add_column(
            "llm_call_logs",
            sa.Column("context_percent", sa.Integer(), nullable=True),
        )


def downgrade() -> None:
    op.drop_column("llm_call_logs", "context_percent")
    op.drop_column("llm_call_logs", "context_window_tokens")
    op.drop_column("llm_call_logs", "context_used_tokens")
