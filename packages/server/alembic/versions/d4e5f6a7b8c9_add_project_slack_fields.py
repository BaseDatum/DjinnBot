"""add_project_slack_fields

Adds slack_channel_id and slack_notify_user_id columns to the projects
table so pipeline run updates can be posted to a project-specific Slack
channel with the correct recipient for chatStream streaming.

Revision ID: d4e5f6a7b8c9
Revises: f7a8b9c0d1e2
Create Date: 2026-02-21 18:00:00.000000

"""

from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision: str = "d4e5f6a7b8c9"
down_revision: Union[str, Sequence[str], None] = "f7a8b9c0d1e2"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.add_column(
        "projects",
        sa.Column("slack_channel_id", sa.String(length=64), nullable=True),
    )
    op.add_column(
        "projects",
        sa.Column("slack_notify_user_id", sa.String(length=64), nullable=True),
    )


def downgrade() -> None:
    op.drop_column("projects", "slack_notify_user_id")
    op.drop_column("projects", "slack_channel_id")
