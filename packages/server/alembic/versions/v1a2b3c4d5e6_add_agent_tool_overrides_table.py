"""Add agent_tool_overrides table for per-agent built-in tool enable/disable.

Each row records that a built-in tool is disabled for a specific agent.
Absence of a row means the tool is enabled (allow-list by default).

Revision ID: v1a2b3c4d5e6
Revises: u1a2b3c4d5e6
Create Date: 2026-02-22

"""

from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision: str = "v1a2b3c4d5e6"
down_revision: Union[str, None] = "u1a2b3c4d5e6"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.create_table(
        "agent_tool_overrides",
        sa.Column("id", sa.BigInteger(), autoincrement=True, nullable=False),
        sa.Column("agent_id", sa.String(length=128), nullable=False),
        sa.Column("tool_name", sa.String(length=256), nullable=False),
        sa.Column("enabled", sa.Boolean(), nullable=False, server_default=sa.false()),
        sa.Column("updated_at", sa.BigInteger(), nullable=False),
        sa.Column(
            "updated_by", sa.String(length=128), nullable=False, server_default="ui"
        ),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint("agent_id", "tool_name", name="uq_agent_tool_override"),
    )
    op.create_index(
        "idx_agent_tool_overrides_agent",
        "agent_tool_overrides",
        ["agent_id"],
    )


def downgrade() -> None:
    op.drop_index("idx_agent_tool_overrides_agent", table_name="agent_tool_overrides")
    op.drop_table("agent_tool_overrides")
