"""add_whatsapp_integration

Add WhatsApp channel integration tables:
- whatsapp_config: System-wide WhatsApp configuration (singleton)
- whatsapp_allowlist: Per-number access rules with optional agent binding

Revision ID: zb4_whatsapp
Revises: zb3_signal
Create Date: 2026-02-27 18:00:00.000000
"""

from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision: str = "zb4_whatsapp"
down_revision: Union[str, Sequence[str], None] = "zb3_signal"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    # ── whatsapp_config (singleton table) ─────────────────────────────────
    op.create_table(
        "whatsapp_config",
        sa.Column("id", sa.Integer(), primary_key=True, default=1),
        sa.Column("enabled", sa.Boolean(), nullable=False, server_default="false"),
        sa.Column("phone_number", sa.String(32), nullable=True),
        sa.Column("linked", sa.Boolean(), nullable=False, server_default="false"),
        sa.Column("default_agent_id", sa.String(128), nullable=True),
        sa.Column(
            "sticky_ttl_minutes", sa.Integer(), nullable=False, server_default="30"
        ),
        sa.Column("allow_all", sa.Boolean(), nullable=False, server_default="false"),
        sa.Column("ack_emoji", sa.String(8), nullable=True),
        sa.Column("updated_at", sa.BigInteger(), nullable=False),
    )

    # Insert the singleton row
    op.execute(
        sa.text(
            "INSERT INTO whatsapp_config (id, enabled, linked, sticky_ttl_minutes, allow_all, updated_at) "
            "VALUES (1, false, false, 30, false, 0)"
        )
    )

    # ── whatsapp_allowlist ────────────────────────────────────────────────
    op.create_table(
        "whatsapp_allowlist",
        sa.Column("id", sa.Integer(), primary_key=True, autoincrement=True),
        sa.Column("phone_number", sa.String(32), nullable=False),
        sa.Column("label", sa.String(256), nullable=True),
        sa.Column("default_agent_id", sa.String(128), nullable=True),
        sa.Column("created_at", sa.BigInteger(), nullable=False),
        sa.Column("updated_at", sa.BigInteger(), nullable=False),
    )


def downgrade() -> None:
    op.drop_table("whatsapp_allowlist")
    op.drop_table("whatsapp_config")
