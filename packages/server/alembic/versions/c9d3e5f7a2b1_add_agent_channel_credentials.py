"""add_agent_channel_credentials

Adds agent_channel_credentials table for per-agent channel (Slack, etc.)
credential storage. Mirrors model_providers pattern: env vars are synced
from the engine at startup; values can be overridden via the dashboard UI.

Revision ID: c9d3e5f7a2b1
Revises: b7e2f1a9c3d6
Create Date: 2026-02-19 00:00:00.000000

"""

from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision: str = "c9d3e5f7a2b1"
down_revision: Union[str, Sequence[str], None] = "b7e2f1a9c3d6"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.create_table(
        "agent_channel_credentials",
        sa.Column("agent_id", sa.String(length=128), nullable=False),
        sa.Column("channel", sa.String(length=64), nullable=False),
        # Primary token (e.g. bot_token for Slack)
        sa.Column("primary_token", sa.Text(), nullable=True),
        # Secondary token (e.g. app_token for Slack Socket Mode)
        sa.Column("secondary_token", sa.Text(), nullable=True),
        # Extra JSON config (e.g. {"bot_user_id": "U0ABC123"})
        sa.Column("extra_config", sa.Text(), nullable=True),
        sa.Column("enabled", sa.Boolean(), nullable=False, server_default="true"),
        sa.Column("created_at", sa.BigInteger(), nullable=False),
        sa.Column("updated_at", sa.BigInteger(), nullable=False),
        sa.PrimaryKeyConstraint("agent_id", "channel"),
    )
    op.create_index(
        "idx_agent_channel_credentials_agent",
        "agent_channel_credentials",
        ["agent_id"],
    )
    op.create_index(
        "idx_agent_channel_credentials_channel",
        "agent_channel_credentials",
        ["channel"],
    )


def downgrade() -> None:
    op.drop_index(
        "idx_agent_channel_credentials_channel", table_name="agent_channel_credentials"
    )
    op.drop_index(
        "idx_agent_channel_credentials_agent", table_name="agent_channel_credentials"
    )
    op.drop_table("agent_channel_credentials")
