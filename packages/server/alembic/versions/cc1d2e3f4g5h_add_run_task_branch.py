"""Add task_branch column to runs table.

Stores the git branch name for a run's worktree (e.g. "feat/task_abc123-oauth").
When set, the engine creates the worktree on this persistent task branch instead
of an ephemeral run/{runId} branch.  This is critical for swarm executors so
their work lands on retrievable, PR-able branches.

Revision ID: cc1d2e3f4g5h
Revises: bb1c2d3e4f5g
Create Date: 2026-02-23

"""

from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision: str = "cc1d2e3f4g5h"
down_revision: Union[str, None] = "bb1c2d3e4f5g"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.add_column(
        "runs",
        sa.Column("task_branch", sa.String(256), nullable=True),
    )


def downgrade() -> None:
    op.drop_column("runs", "task_branch")
