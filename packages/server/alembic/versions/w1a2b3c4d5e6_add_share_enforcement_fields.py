"""Add share enforcement fields.

New columns:
  llm_call_logs:
    - user_id: FK to users.id — who this call was billed to
  admin_shared_providers:
    - daily_cost_limit_usd: optional per-day cost cap in USD

New indexes:
  - idx_llm_call_logs_user_provider_created: composite for efficient daily usage queries
  - idx_llm_call_logs_key_source: for filtering by key source type

Revision ID: w1a2b3c4d5e6
Revises: v1a2b3c4d5e6
Create Date: 2026-02-22

"""

from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision: str = "w1a2b3c4d5e6"
down_revision: Union[str, None] = "v1a2b3c4d5e6"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    # ── llm_call_logs: add user_id for per-user usage queries ──
    op.add_column(
        "llm_call_logs",
        sa.Column("user_id", sa.String(64), nullable=True),
    )
    # Composite index for the daily usage enforcement query:
    #   WHERE user_id = ? AND provider = ? AND key_source = 'admin_shared'
    #         AND created_at >= start_of_day
    op.create_index(
        "idx_llm_call_logs_user_provider_created",
        "llm_call_logs",
        ["user_id", "provider", "created_at"],
    )
    op.create_index(
        "idx_llm_call_logs_key_source",
        "llm_call_logs",
        ["key_source"],
    )

    # ── admin_shared_providers: add daily cost limit ──
    op.add_column(
        "admin_shared_providers",
        sa.Column("daily_cost_limit_usd", sa.Float(), nullable=True),
    )


def downgrade() -> None:
    op.drop_column("admin_shared_providers", "daily_cost_limit_usd")
    op.drop_index("idx_llm_call_logs_key_source", table_name="llm_call_logs")
    op.drop_index("idx_llm_call_logs_user_provider_created", table_name="llm_call_logs")
    op.drop_column("llm_call_logs", "user_id")
