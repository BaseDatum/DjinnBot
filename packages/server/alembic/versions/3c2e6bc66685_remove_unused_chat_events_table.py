"""remove_unused_chat_events_table

Revision ID: 3c2e6bc66685
Revises: 1d6064c32fc7
Create Date: 2026-02-18 10:12:21.960124

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision: str = '3c2e6bc66685'
down_revision: Union[str, Sequence[str], None] = '1d6064c32fc7'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    """Remove unused chat_events table.
    
    The ChatEvent model was created for streaming event replay functionality,
    but was never actually used - no code writes to this table. Removing it
    to keep the schema clean.
    """
    # Drop index first, then table
    op.drop_index('idx_chat_events_message_ts', table_name='chat_events')
    op.drop_table('chat_events')


def downgrade() -> None:
    """Recreate chat_events table if needed.
    
    This recreates the table structure from the original migration
    (1d6064c32fc7_add_chat_tables.py) in case rollback is needed.
    """
    op.create_table('chat_events',
        sa.Column('id', sa.String(length=64), nullable=False),
        sa.Column('message_id', sa.String(length=64), nullable=False),
        sa.Column('event_type', sa.String(length=32), nullable=False),
        sa.Column('timestamp', sa.BigInteger(), nullable=False),
        sa.Column('data', sa.Text(), nullable=False),
        sa.ForeignKeyConstraint(['message_id'], ['chat_messages.id'], ondelete='CASCADE'),
        sa.PrimaryKeyConstraint('id')
    )
    op.create_index('idx_chat_events_message_ts', 'chat_events', ['message_id', 'timestamp'], unique=False)
