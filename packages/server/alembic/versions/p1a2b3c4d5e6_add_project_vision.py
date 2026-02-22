"""Add project vision column.

Adds a `vision` TEXT column to the projects table for storing a living
markdown document that describes project goals, architecture, constraints,
and current priorities.  Users can edit this at any time in the dashboard
and agents read it before starting work.

Revision ID: p1a2b3c4d5e6
Revises: n1a2b3c4d5e6
Create Date: 2026-02-22

"""

from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision: str = "p1a2b3c4d5e6"
down_revision: Union[str, None] = "n1a2b3c4d5e6"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.add_column("projects", sa.Column("vision", sa.Text(), nullable=True))


def downgrade() -> None:
    op.drop_column("projects", "vision")
