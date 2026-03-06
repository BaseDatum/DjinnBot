"""add chat attachments table and message attachments column

Revision ID: h2b3c4d5e6f7
Revises: g1a2b3c4d5e6
Create Date: 2026-02-21 20:00:00.000000

"""

from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision: str = "h2b3c4d5e6f7"
down_revision: Union[str, None] = "g1a2b3c4d5e6"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    # Create chat_attachments table
    op.create_table(
        "chat_attachments",
        sa.Column("id", sa.String(length=64), nullable=False),
        sa.Column("session_id", sa.String(length=128), nullable=False),
        sa.Column("message_id", sa.String(length=64), nullable=True),
        sa.Column("filename", sa.String(length=512), nullable=False),
        sa.Column("mime_type", sa.String(length=128), nullable=False),
        sa.Column("size_bytes", sa.BigInteger(), nullable=False),
        sa.Column("storage_path", sa.String(length=1024), nullable=False),
        sa.Column(
            "processing_status",
            sa.String(length=32),
            nullable=False,
            server_default="uploaded",
        ),
        sa.Column("extracted_text", sa.Text(), nullable=True),
        sa.Column("estimated_tokens", sa.Integer(), nullable=True),
        sa.Column("created_at", sa.BigInteger(), nullable=False),
        sa.PrimaryKeyConstraint("id"),
        sa.ForeignKeyConstraint(
            ["session_id"], ["chat_sessions.id"], ondelete="CASCADE"
        ),
        sa.ForeignKeyConstraint(
            ["message_id"], ["chat_messages.id"], ondelete="SET NULL"
        ),
    )
    op.create_index("idx_chat_attachments_session", "chat_attachments", ["session_id"])
    op.create_index("idx_chat_attachments_message", "chat_attachments", ["message_id"])

    # Add attachments column to chat_messages (JSON array of attachment IDs)
    op.add_column("chat_messages", sa.Column("attachments", sa.Text(), nullable=True))


def downgrade() -> None:
    op.drop_column("chat_messages", "attachments")
    op.drop_index("idx_chat_attachments_message", table_name="chat_attachments")
    op.drop_index("idx_chat_attachments_session", table_name="chat_attachments")
    op.drop_table("chat_attachments")
