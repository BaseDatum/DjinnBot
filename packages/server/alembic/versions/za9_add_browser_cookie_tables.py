"""add_browser_cookie_tables

Add browser_cookie_sets and agent_cookie_grants tables for managing
browser cookies that agents can use via Camofox.

Revision ID: za9_browser_cookies
Revises: za8_merge_heads
Create Date: 2026-02-26 20:00:00.000000
"""

from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision: str = "za9_browser_cookies"
down_revision: Union[str, Sequence[str], None] = "za8_merge_heads"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.create_table(
        "browser_cookie_sets",
        sa.Column("id", sa.String(64), primary_key=True),
        sa.Column("user_id", sa.String(64), nullable=False),
        sa.Column("name", sa.String(256), nullable=False),
        sa.Column("domain", sa.String(512), nullable=False),
        sa.Column("filename", sa.String(256), nullable=False),
        sa.Column("cookie_count", sa.Integer, nullable=False, server_default="0"),
        sa.Column("expires_at", sa.BigInteger, nullable=True),
        sa.Column("created_at", sa.BigInteger, nullable=False),
        sa.Column("updated_at", sa.BigInteger, nullable=False),
    )
    op.create_index("idx_browser_cookie_sets_user", "browser_cookie_sets", ["user_id"])
    op.create_index("idx_browser_cookie_sets_domain", "browser_cookie_sets", ["domain"])

    op.create_table(
        "agent_cookie_grants",
        sa.Column("id", sa.BigInteger, primary_key=True, autoincrement=True),
        sa.Column("agent_id", sa.String(128), nullable=False),
        sa.Column(
            "cookie_set_id",
            sa.String(64),
            sa.ForeignKey("browser_cookie_sets.id", ondelete="CASCADE"),
            nullable=False,
        ),
        sa.Column("granted_by", sa.String(128), nullable=False, server_default="ui"),
        sa.Column("granted_at", sa.BigInteger, nullable=False),
        sa.UniqueConstraint("agent_id", "cookie_set_id", name="uq_agent_cookie_grant"),
    )
    op.create_index(
        "idx_agent_cookie_grants_agent", "agent_cookie_grants", ["agent_id"]
    )
    op.create_index(
        "idx_agent_cookie_grants_cookie",
        "agent_cookie_grants",
        ["cookie_set_id"],
    )


def downgrade() -> None:
    op.drop_table("agent_cookie_grants")
    op.drop_table("browser_cookie_sets")
