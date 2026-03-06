"""Add executor_timeout_sec to pulse_routines.

Separate timeout for spawned executor sessions, independent of the
pulse/planner session timeout (timeout_ms). Work lock TTL should
match this value so stalled executors are detected promptly.

Revision ID: zb9_exec_timeout
Revises: zb8_ctx_usage
Create Date: 2026-03-05 16:00:00.000000
"""

from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa
from sqlalchemy import inspect


# revision identifiers, used by Alembic.
revision: str = "zb9_exec_timeout"
down_revision: Union[str, Sequence[str], None] = "zb8_ctx_usage"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    conn = op.get_bind()
    inspector = inspect(conn)
    columns = {c["name"] for c in inspector.get_columns("pulse_routines")}

    if "executor_timeout_sec" not in columns:
        op.add_column(
            "pulse_routines",
            sa.Column("executor_timeout_sec", sa.Integer(), nullable=True),
        )


def downgrade() -> None:
    op.drop_column("pulse_routines", "executor_timeout_sec")
