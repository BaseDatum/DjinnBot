"""merge_heads_slack_fields_and_chat_attachments

Revision ID: 799467231df9
Revises: d4e5f6a7b8c9, h2b3c4d5e6f7
Create Date: 2026-02-21 21:49:31.190828

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision: str = '799467231df9'
down_revision: Union[str, Sequence[str], None] = ('d4e5f6a7b8c9', 'h2b3c4d5e6f7')
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    """Upgrade schema."""
    pass


def downgrade() -> None:
    """Downgrade schema."""
    pass
