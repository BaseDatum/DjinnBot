"""add_signal_integration

Add Signal channel integration tables:
- signal_config: System-wide Signal configuration (singleton)
- signal_allowlist: Per-number access rules with optional agent binding
- users.phone_number: User phone number for Signal notifications

Revision ID: zb3_signal
Revises: zb2_pdf_fields
Create Date: 2026-02-27 12:00:00.000000
"""

from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision: str = "zb3_signal"
down_revision: Union[str, Sequence[str], None] = "zb2_pdf_fields"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    # ── signal_config (singleton table) ───────────────────────────────────
    op.create_table(
        "signal_config",
        sa.Column("id", sa.Integer(), primary_key=True, default=1),
        sa.Column("enabled", sa.Boolean(), nullable=False, server_default="false"),
        sa.Column("phone_number", sa.String(32), nullable=True),
        sa.Column("linked", sa.Boolean(), nullable=False, server_default="false"),
        sa.Column("default_agent_id", sa.String(128), nullable=True),
        sa.Column(
            "sticky_ttl_minutes", sa.Integer(), nullable=False, server_default="30"
        ),
        sa.Column("allow_all", sa.Boolean(), nullable=False, server_default="false"),
        sa.Column("updated_at", sa.BigInteger(), nullable=False),
    )

    # Insert the singleton row
    op.execute(
        sa.text(
            "INSERT INTO signal_config (id, enabled, linked, sticky_ttl_minutes, allow_all, updated_at) "
            "VALUES (1, false, false, 30, false, 0)"
        )
    )

    # ── signal_allowlist ──────────────────────────────────────────────────
    op.create_table(
        "signal_allowlist",
        sa.Column("id", sa.Integer(), primary_key=True, autoincrement=True),
        sa.Column("phone_number", sa.String(32), nullable=False),
        sa.Column("label", sa.String(256), nullable=True),
        sa.Column("default_agent_id", sa.String(128), nullable=True),
        sa.Column("created_at", sa.BigInteger(), nullable=False),
        sa.Column("updated_at", sa.BigInteger(), nullable=False),
    )

    # ── users.phone_number ────────────────────────────────────────────────
    op.add_column(
        "users",
        sa.Column("phone_number", sa.String(32), nullable=True),
    )


def downgrade() -> None:
    op.drop_column("users", "phone_number")
    op.drop_table("signal_allowlist")
    op.drop_table("signal_config")
