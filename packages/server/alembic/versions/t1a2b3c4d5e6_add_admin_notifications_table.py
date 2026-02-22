"""Add admin_notifications table.

System-level alerts surfaced in the admin panel — created by the engine
when infrastructure issues occur (failed image pull, etc.).

Revision ID: t1a2b3c4d5e6
Revises: s1a2b3c4d5e6
Create Date: 2026-02-22

"""

from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision: str = "t1a2b3c4d5e6"
down_revision: Union[str, None] = "s1a2b3c4d5e6"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.create_table(
        "admin_notifications",
        sa.Column("id", sa.String(64), primary_key=True),
        sa.Column("level", sa.String(16), nullable=False, server_default="info"),
        sa.Column("title", sa.String(256), nullable=False),
        sa.Column("detail", sa.Text(), nullable=True),
        sa.Column("read", sa.Boolean(), nullable=False, server_default=sa.text("0")),
        sa.Column("created_at", sa.BigInteger(), nullable=False),
    )
    op.create_index(
        "idx_admin_notifications_created", "admin_notifications", ["created_at"]
    )
    op.create_index("idx_admin_notifications_read", "admin_notifications", ["read"])


def downgrade() -> None:
    op.drop_index("idx_admin_notifications_read", table_name="admin_notifications")
    op.drop_index("idx_admin_notifications_created", table_name="admin_notifications")
    op.drop_table("admin_notifications")
