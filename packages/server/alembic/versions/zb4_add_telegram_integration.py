"""add_telegram_integration

Add Telegram channel integration tables:
- telegram_config: Per-agent Telegram bot configuration
- telegram_allowlist: Per-agent user access rules

Unlike Signal (one shared phone number), Telegram uses one bot per agent.

Revision ID: zb4_telegram
Revises: zb4_whatsapp
Create Date: 2026-02-27 14:00:00.000000
"""

from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision: str = "zb4_telegram"
down_revision: Union[str, Sequence[str], None] = "zb4_whatsapp"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    # ── telegram_config (one row per agent) ───────────────────────────────
    op.create_table(
        "telegram_config",
        sa.Column("id", sa.Integer(), primary_key=True, autoincrement=True),
        sa.Column("agent_id", sa.String(128), nullable=False, unique=True),
        sa.Column("enabled", sa.Boolean(), nullable=False, server_default="false"),
        sa.Column("bot_token", sa.String(256), nullable=True),
        sa.Column("bot_username", sa.String(128), nullable=True),
        sa.Column("allow_all", sa.Boolean(), nullable=False, server_default="false"),
        sa.Column("updated_at", sa.BigInteger(), nullable=False),
    )

    # ── telegram_allowlist (per-agent entries) ────────────────────────────
    op.create_table(
        "telegram_allowlist",
        sa.Column("id", sa.Integer(), primary_key=True, autoincrement=True),
        sa.Column("agent_id", sa.String(128), nullable=False),
        sa.Column("identifier", sa.String(128), nullable=False),
        sa.Column("label", sa.String(256), nullable=True),
        sa.Column("created_at", sa.BigInteger(), nullable=False),
        sa.Column("updated_at", sa.BigInteger(), nullable=False),
    )

    op.create_index(
        "ix_telegram_allowlist_agent_id",
        "telegram_allowlist",
        ["agent_id"],
    )


def downgrade() -> None:
    op.drop_index("ix_telegram_allowlist_agent_id", table_name="telegram_allowlist")
    op.drop_table("telegram_allowlist")
    op.drop_table("telegram_config")
