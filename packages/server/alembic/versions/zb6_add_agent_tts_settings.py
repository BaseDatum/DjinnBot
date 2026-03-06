"""add_agent_tts_settings

Create the agent_tts_settings table for DB-persisted per-agent TTS
configuration (voice, provider, enabled flag).  This table was added
to the zb5_tts migration file after it had already been applied to
some databases, so it needs its own migration to cover those instances.

Revision ID: zb6_agent_tts
Revises: zb5_tts
Create Date: 2026-02-28 02:00:00.000000
"""

from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa
from sqlalchemy import inspect


# revision identifiers, used by Alembic.
revision: str = "zb6_agent_tts"
down_revision: Union[str, Sequence[str], None] = "zb5_tts"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    # Guard: skip if the table already exists (created by an updated zb5_tts)
    conn = op.get_bind()
    inspector = inspect(conn)
    if "agent_tts_settings" not in inspector.get_table_names():
        op.create_table(
            "agent_tts_settings",
            sa.Column("agent_id", sa.String(128), primary_key=True),
            sa.Column(
                "tts_enabled",
                sa.Boolean(),
                nullable=False,
                server_default="false",
            ),
            sa.Column("tts_provider", sa.String(64), nullable=True),
            sa.Column("tts_voice_id", sa.String(128), nullable=True),
            sa.Column("tts_voice_name", sa.String(256), nullable=True),
            sa.Column("updated_at", sa.BigInteger(), nullable=False),
        )


def downgrade() -> None:
    op.drop_table("agent_tts_settings")
