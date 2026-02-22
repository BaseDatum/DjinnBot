"""Add onboarding diagram_state column.

Stores the evolving Mermaid diagram that agents collaboratively build
during the onboarding process. Updated via
PATCH /onboarding/sessions/{id}/diagram.

Revision ID: x1a2b3c4d5e6
Revises: w1a2b3c4d5e6
Create Date: 2026-02-22

"""

from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision: str = "x1a2b3c4d5e6"
down_revision: Union[str, Sequence[str], None] = "w1a2b3c4d5e6"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    """Add diagram_state to onboarding_sessions."""
    # JSON blob storing the evolving diagram:
    # { "mermaid": "graph TD\n  ...", "caption": "...", "last_agent_id": "stas", "version": 3 }
    op.add_column(
        "onboarding_sessions",
        sa.Column("diagram_state", sa.Text(), nullable=True),
    )


def downgrade() -> None:
    """Remove diagram_state column."""
    op.drop_column("onboarding_sessions", "diagram_state")
