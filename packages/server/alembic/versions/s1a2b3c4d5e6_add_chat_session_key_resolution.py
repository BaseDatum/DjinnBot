"""Add key_resolution to chat_sessions.

New column on `chat_sessions`:
  - key_resolution: JSON blob recording which keys were resolved for this session

Revision ID: s1a2b3c4d5e6
Revises: r1a2b3c4d5e6
Create Date: 2026-02-22

"""

from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision: str = "s1a2b3c4d5e6"
down_revision: Union[str, None] = "r1a2b3c4d5e6"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.add_column(
        "chat_sessions",
        sa.Column("key_resolution", sa.Text(), nullable=True),
    )


def downgrade() -> None:
    op.drop_column("chat_sessions", "key_resolution")
