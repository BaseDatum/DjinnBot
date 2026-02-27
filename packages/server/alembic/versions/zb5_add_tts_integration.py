"""add_tts_integration

Add Fish Audio text-to-speech integration:
- tts_call_logs: Track TTS API calls and costs
- tts_providers: Instance-level TTS provider API keys
- user_tts_providers: Per-user TTS provider API keys
- admin_shared_tts_providers: Admin TTS key sharing grants

Revision ID: zb5_tts
Revises: zb4_telegram
Create Date: 2026-02-27 18:00:00.000000
"""

from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision: str = "zb5_tts"
down_revision: Union[str, Sequence[str], None] = "zb4_telegram"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    # ── tts_call_logs — track every TTS API call for cost tracking ────────
    op.create_table(
        "tts_call_logs",
        sa.Column("id", sa.String(128), primary_key=True),
        sa.Column("session_id", sa.String(256), nullable=True),
        sa.Column("agent_id", sa.String(128), nullable=False),
        sa.Column("user_id", sa.String(64), nullable=True),
        sa.Column("provider", sa.String(64), nullable=False),
        sa.Column("model", sa.String(128), nullable=False),
        sa.Column("key_source", sa.String(32), nullable=True),
        sa.Column("key_masked", sa.String(64), nullable=True),
        sa.Column("input_text_bytes", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("input_characters", sa.Integer(), nullable=False, server_default="0"),
        sa.Column(
            "output_audio_bytes", sa.Integer(), nullable=False, server_default="0"
        ),
        sa.Column("output_format", sa.String(16), nullable=False, server_default="mp3"),
        sa.Column("voice_id", sa.String(128), nullable=True),
        sa.Column("voice_name", sa.String(256), nullable=True),
        sa.Column("cost_total", sa.Float(), nullable=True),
        sa.Column("duration_ms", sa.Integer(), nullable=True),
        sa.Column("channel", sa.String(32), nullable=True),
        sa.Column("created_at", sa.BigInteger(), nullable=False),
    )
    op.create_index("idx_tts_call_logs_session", "tts_call_logs", ["session_id"])
    op.create_index("idx_tts_call_logs_agent", "tts_call_logs", ["agent_id"])
    op.create_index("idx_tts_call_logs_created", "tts_call_logs", ["created_at"])
    op.create_index("idx_tts_call_logs_user", "tts_call_logs", ["user_id"])

    # ── tts_providers — instance-level TTS provider keys ─────────────────
    # Mirrors model_providers but scoped to TTS so they appear on a separate tab.
    op.create_table(
        "tts_providers",
        sa.Column("provider_id", sa.String(64), primary_key=True),
        sa.Column("enabled", sa.Boolean(), nullable=False, server_default="true"),
        sa.Column("api_key", sa.Text(), nullable=True),
        sa.Column("extra_config", sa.Text(), nullable=True),
        sa.Column("created_at", sa.BigInteger(), nullable=False),
        sa.Column("updated_at", sa.BigInteger(), nullable=False),
    )

    # ── user_tts_providers — per-user TTS provider keys ──────────────────
    op.create_table(
        "user_tts_providers",
        sa.Column(
            "user_id",
            sa.String(64),
            sa.ForeignKey("users.id", ondelete="CASCADE"),
            primary_key=True,
        ),
        sa.Column("provider_id", sa.String(64), primary_key=True),
        sa.Column("enabled", sa.Boolean(), nullable=False, server_default="true"),
        sa.Column("api_key", sa.Text(), nullable=True),
        sa.Column("extra_config", sa.Text(), nullable=True),
        sa.Column("created_at", sa.BigInteger(), nullable=False),
        sa.Column("updated_at", sa.BigInteger(), nullable=False),
    )
    op.create_index("idx_user_tts_providers_user", "user_tts_providers", ["user_id"])
    op.create_index(
        "idx_user_tts_providers_provider", "user_tts_providers", ["provider_id"]
    )

    # ── admin_shared_tts_providers — admin TTS key sharing ───────────────
    op.create_table(
        "admin_shared_tts_providers",
        sa.Column("id", sa.String(64), primary_key=True),
        sa.Column(
            "admin_user_id",
            sa.String(64),
            sa.ForeignKey("users.id", ondelete="CASCADE"),
            nullable=False,
        ),
        sa.Column("provider_id", sa.String(64), nullable=False),
        sa.Column(
            "target_user_id",
            sa.String(64),
            sa.ForeignKey("users.id", ondelete="CASCADE"),
            nullable=True,
        ),
        sa.Column("created_at", sa.BigInteger(), nullable=False),
        sa.Column("expires_at", sa.BigInteger(), nullable=True),
        sa.Column("daily_limit", sa.Integer(), nullable=True),
        sa.Column("daily_cost_limit_usd", sa.Float(), nullable=True),
    )
    op.create_index(
        "idx_admin_shared_tts_providers_admin",
        "admin_shared_tts_providers",
        ["admin_user_id"],
    )
    op.create_index(
        "idx_admin_shared_tts_providers_target",
        "admin_shared_tts_providers",
        ["target_user_id"],
    )
    op.create_index(
        "idx_admin_shared_tts_providers_provider",
        "admin_shared_tts_providers",
        ["provider_id"],
    )
    op.create_unique_constraint(
        "uq_admin_shared_tts_provider_target",
        "admin_shared_tts_providers",
        ["provider_id", "target_user_id"],
    )


def downgrade() -> None:
    op.drop_table("admin_shared_tts_providers")
    op.drop_index("idx_user_tts_providers_provider", table_name="user_tts_providers")
    op.drop_index("idx_user_tts_providers_user", table_name="user_tts_providers")
    op.drop_table("user_tts_providers")
    op.drop_table("tts_providers")
    op.drop_index("idx_tts_call_logs_user", table_name="tts_call_logs")
    op.drop_index("idx_tts_call_logs_created", table_name="tts_call_logs")
    op.drop_index("idx_tts_call_logs_agent", table_name="tts_call_logs")
    op.drop_index("idx_tts_call_logs_session", table_name="tts_call_logs")
    op.drop_table("tts_call_logs")
