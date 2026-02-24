"""Add template_id to onboarding_sessions.

Allows the onboarding flow to create projects from a specific template
instead of always using the legacy software-dev defaults.

Revision ID: za3_onb_template
Revises: za2_routine_tools
Create Date: 2026-02-24

"""

from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision: str = "za3_onb_template"
down_revision: Union[str, Sequence[str], None] = "za2_routine_tools"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    """Add template_id to onboarding_sessions."""
    op.add_column(
        "onboarding_sessions",
        sa.Column("template_id", sa.String(64), nullable=True),
    )


def downgrade() -> None:
    """Remove template_id from onboarding_sessions."""
    op.drop_column("onboarding_sessions", "template_id")
