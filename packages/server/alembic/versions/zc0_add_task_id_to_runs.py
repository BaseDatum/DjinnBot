"""Add task_id column to runs table.

Allows querying executor runs by task ID. Set by spawn_executor when
creating executor runs, so the planner can check on previous executor
attempts for a task across pulse cycles.

Revision ID: zc0_task_id_runs
Revises: zb9_exec_timeout
Create Date: 2026-03-05 20:00:00.000000
"""

from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa
from sqlalchemy import inspect


# revision identifiers, used by Alembic.
revision: str = "zc0_task_id_runs"
down_revision: Union[str, Sequence[str], None] = "zb9_exec_timeout"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    conn = op.get_bind()
    inspector = inspect(conn)
    columns = {c["name"] for c in inspector.get_columns("runs")}

    if "task_id" not in columns:
        op.add_column(
            "runs",
            sa.Column("task_id", sa.String(64), nullable=True),
        )
        op.create_index("idx_runs_task_id", "runs", ["task_id"])


def downgrade() -> None:
    op.drop_index("idx_runs_task_id", table_name="runs")
    op.drop_column("runs", "task_id")
