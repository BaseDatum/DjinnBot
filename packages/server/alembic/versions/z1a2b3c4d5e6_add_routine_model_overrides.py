"""Add per-routine model overrides to pulse_routines table.

Allows setting planning_model and executor_model per pulse routine,
overriding the agent-level defaults. Resolution chain:
  routine → agent config → global fallback

Revision ID: z1a2b3c4d5e6
Revises: y1a2b3c4d5e6
Create Date: 2026-02-22

"""

from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision: str = "z1a2b3c4d5e6"
down_revision: Union[str, Sequence[str], None] = "y1a2b3c4d5e6"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    """Add planning_model and executor_model to pulse_routines."""
    op.add_column(
        "pulse_routines",
        sa.Column("planning_model", sa.String(256), nullable=True),
    )
    op.add_column(
        "pulse_routines",
        sa.Column("executor_model", sa.String(256), nullable=True),
    )


def downgrade() -> None:
    """Remove model override columns."""
    op.drop_column("pulse_routines", "executor_model")
    op.drop_column("pulse_routines", "planning_model")
