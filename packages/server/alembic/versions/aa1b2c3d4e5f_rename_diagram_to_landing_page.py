"""Rename diagram_state to landing_page_state on onboarding_sessions.

The onboarding panel now shows a live landing page preview instead of a
Mermaid diagram. The JSON payload changes from {"mermaid": "..."} to
{"html": "..."}.

Revision ID: aa1b2c3d4e5f
Revises: z1a2b3c4d5e6
Create Date: 2026-02-23

"""

from typing import Sequence, Union

from alembic import op


# revision identifiers, used by Alembic.
revision: str = "aa1b2c3d4e5f"
down_revision: Union[str, Sequence[str], None] = "z1a2b3c4d5e6"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    """Rename diagram_state -> landing_page_state."""
    op.alter_column(
        "onboarding_sessions",
        "diagram_state",
        new_column_name="landing_page_state",
    )


def downgrade() -> None:
    """Revert: landing_page_state -> diagram_state."""
    op.alter_column(
        "onboarding_sessions",
        "landing_page_state",
        new_column_name="diagram_state",
    )
