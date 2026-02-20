"""add_mcp_tables

Adds the mcp_servers registry and agent_mcp_tools access-control tables for
the MCP/mcpo integration.

Revision ID: f1a2b3c4d5e6
Revises: e1f2a3b4c5d6
Create Date: 2026-02-19 12:00:00.000000
"""

from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision: str = "f1a2b3c4d5e6"
down_revision: Union[str, Sequence[str], None] = "e1f2a3b4c5d6"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    # ── mcp_servers ────────────────────────────────────────────────────────────
    op.create_table(
        "mcp_servers",
        sa.Column("id", sa.String(length=64), nullable=False),  # slug PK
        sa.Column("name", sa.String(length=256), nullable=False),
        sa.Column("description", sa.Text(), nullable=False, server_default=""),
        # JSON blob — the mcpServers entry for config.json
        sa.Column("config", sa.Text(), nullable=False, server_default="{}"),
        # Cached JSON array of discovered tool names from mcpo OpenAPI
        sa.Column("discovered_tools", sa.Text(), nullable=False, server_default="[]"),
        sa.Column(
            "status",
            sa.String(length=32),
            nullable=False,
            server_default="configuring",
        ),
        sa.Column("enabled", sa.Boolean(), nullable=False, server_default="true"),
        sa.Column("setup_agent_id", sa.String(length=128), nullable=True),
        sa.Column("created_at", sa.BigInteger(), nullable=False),
        sa.Column("updated_at", sa.BigInteger(), nullable=False),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_index("idx_mcp_servers_status", "mcp_servers", ["status"])
    op.create_index("idx_mcp_servers_enabled", "mcp_servers", ["enabled"])

    # ── agent_mcp_tools ────────────────────────────────────────────────────────
    op.create_table(
        "agent_mcp_tools",
        sa.Column("id", sa.BigInteger(), autoincrement=True, nullable=False),
        sa.Column("agent_id", sa.String(length=128), nullable=False),
        sa.Column("server_id", sa.String(length=64), nullable=False),
        sa.Column(
            "tool_name", sa.String(length=256), nullable=False, server_default="*"
        ),
        sa.Column("granted", sa.Boolean(), nullable=False, server_default="true"),
        sa.Column("granted_at", sa.BigInteger(), nullable=False),
        sa.Column(
            "granted_by",
            sa.String(length=128),
            nullable=False,
            server_default="ui",
        ),
        sa.ForeignKeyConstraint(["server_id"], ["mcp_servers.id"], ondelete="CASCADE"),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint(
            "agent_id", "server_id", "tool_name", name="uq_agent_mcp_tool"
        ),
    )
    op.create_index("idx_agent_mcp_tools_agent", "agent_mcp_tools", ["agent_id"])
    op.create_index("idx_agent_mcp_tools_server", "agent_mcp_tools", ["server_id"])


def downgrade() -> None:
    op.drop_index("idx_agent_mcp_tools_server", table_name="agent_mcp_tools")
    op.drop_index("idx_agent_mcp_tools_agent", table_name="agent_mcp_tools")
    op.drop_table("agent_mcp_tools")

    op.drop_index("idx_mcp_servers_enabled", table_name="mcp_servers")
    op.drop_index("idx_mcp_servers_status", table_name="mcp_servers")
    op.drop_table("mcp_servers")
