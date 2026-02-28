"""Add agent_messaging_permissions table.

Per-agent, per-channel messaging target permissions for Telegram, WhatsApp,
and Signal tools.  Supports wildcard (*) for unrestricted access or specific
chat IDs / phone numbers / group IDs.

Revision ID: zb7_msg_perms
Revises: zb6_agent_tts
Create Date: 2026-02-28 12:00:00.000000
"""

from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa
from sqlalchemy import inspect


# revision identifiers, used by Alembic.
revision: str = "zb7_msg_perms"
down_revision: Union[str, Sequence[str], None] = "zb6_agent_tts"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    conn = op.get_bind()
    inspector = inspect(conn)
    if "agent_messaging_permissions" not in inspector.get_table_names():
        op.create_table(
            "agent_messaging_permissions",
            sa.Column("id", sa.BigInteger, primary_key=True, autoincrement=True),
            sa.Column("agent_id", sa.String(128), nullable=False),
            sa.Column("channel", sa.String(32), nullable=False),
            sa.Column("target", sa.String(256), nullable=False),
            sa.Column("label", sa.String(256), nullable=True),
            sa.Column("created_at", sa.BigInteger, nullable=False),
            sa.Column("updated_at", sa.BigInteger, nullable=False),
        )
        op.create_unique_constraint(
            "uq_agent_messaging_perm",
            "agent_messaging_permissions",
            ["agent_id", "channel", "target"],
        )
        op.create_index(
            "idx_agent_messaging_perm_agent_channel",
            "agent_messaging_permissions",
            ["agent_id", "channel"],
        )


def downgrade() -> None:
    op.drop_index(
        "idx_agent_messaging_perm_agent_channel",
        table_name="agent_messaging_permissions",
    )
    op.drop_constraint(
        "uq_agent_messaging_perm",
        "agent_messaging_permissions",
        type_="unique",
    )
    op.drop_table("agent_messaging_permissions")
