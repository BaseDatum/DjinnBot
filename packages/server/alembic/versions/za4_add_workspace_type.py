"""Add workspace_type to projects and runs.

Allows projects to specify which workspace strategy the engine should use
(e.g. 'git_worktree' for code projects, 'simple' for non-VCS projects).
The value is copied to runs at creation time so the engine doesn't need
to look up the project to decide which workspace manager to use.

Revision ID: za4_workspace_type
Revises: za3_onb_template
Create Date: 2026-02-25

"""

from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision: str = "za4_workspace_type"
down_revision: Union[str, Sequence[str], None] = "za3_onb_template"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    """Add workspace_type to projects and runs."""
    op.add_column(
        "projects",
        sa.Column("workspace_type", sa.String(32), nullable=True),
    )
    op.add_column(
        "runs",
        sa.Column("workspace_type", sa.String(32), nullable=True),
    )


def downgrade() -> None:
    """Remove workspace_type from projects and runs."""
    op.drop_column("runs", "workspace_type")
    op.drop_column("projects", "workspace_type")
