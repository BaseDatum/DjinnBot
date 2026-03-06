"""add auth tables

Revision ID: f7a8b9c0d1e2
Revises: b0c1d2e3f4a5
Create Date: 2026-02-21 12:00:00.000000

"""

from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision: str = "f7a8b9c0d1e2"
down_revision: Union[str, None] = "b0c1d2e3f4a5"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    # Users
    op.create_table(
        "users",
        sa.Column("id", sa.String(64), primary_key=True),
        sa.Column("email", sa.String(320), nullable=False, unique=True),
        sa.Column("display_name", sa.String(256), nullable=True),
        sa.Column("password_hash", sa.Text(), nullable=True),
        sa.Column(
            "is_active", sa.Boolean(), nullable=False, server_default=sa.text("true")
        ),
        sa.Column(
            "is_admin", sa.Boolean(), nullable=False, server_default=sa.text("false")
        ),
        sa.Column("totp_secret", sa.Text(), nullable=True),
        sa.Column(
            "totp_enabled",
            sa.Boolean(),
            nullable=False,
            server_default=sa.text("false"),
        ),
        sa.Column("totp_confirmed_at", sa.BigInteger(), nullable=True),
        sa.Column("oidc_subject", sa.String(512), nullable=True),
        sa.Column("created_at", sa.BigInteger(), nullable=False),
        sa.Column("updated_at", sa.BigInteger(), nullable=False),
    )
    op.create_index("idx_users_email", "users", ["email"], unique=True)

    # User recovery codes
    op.create_table(
        "user_recovery_codes",
        sa.Column("id", sa.String(64), primary_key=True),
        sa.Column(
            "user_id",
            sa.String(64),
            sa.ForeignKey("users.id", ondelete="CASCADE"),
            nullable=False,
        ),
        sa.Column("code_hash", sa.String(128), nullable=False),
        sa.Column("used_at", sa.BigInteger(), nullable=True),
    )
    op.create_index("idx_recovery_codes_user", "user_recovery_codes", ["user_id"])

    # OIDC providers
    op.create_table(
        "oidc_providers",
        sa.Column("id", sa.String(64), primary_key=True),
        sa.Column("slug", sa.String(64), nullable=False, unique=True),
        sa.Column("name", sa.String(256), nullable=False),
        sa.Column("issuer_url", sa.Text(), nullable=False),
        sa.Column("client_id", sa.Text(), nullable=False),
        sa.Column("client_secret", sa.Text(), nullable=False),
        sa.Column("authorization_endpoint", sa.Text(), nullable=True),
        sa.Column("token_endpoint", sa.Text(), nullable=True),
        sa.Column("userinfo_endpoint", sa.Text(), nullable=True),
        sa.Column("jwks_uri", sa.Text(), nullable=True),
        sa.Column(
            "scopes",
            sa.String(512),
            nullable=False,
            server_default="openid email profile",
        ),
        sa.Column("button_text", sa.String(128), nullable=True),
        sa.Column("button_color", sa.String(32), nullable=True),
        sa.Column("icon_url", sa.Text(), nullable=True),
        sa.Column(
            "auto_discovery",
            sa.Boolean(),
            nullable=False,
            server_default=sa.text("true"),
        ),
        sa.Column(
            "enabled", sa.Boolean(), nullable=False, server_default=sa.text("true")
        ),
        sa.Column("created_at", sa.BigInteger(), nullable=False),
        sa.Column("updated_at", sa.BigInteger(), nullable=False),
    )
    op.create_index("idx_oidc_providers_slug", "oidc_providers", ["slug"], unique=True)

    # API keys
    op.create_table(
        "api_keys",
        sa.Column("id", sa.String(64), primary_key=True),
        sa.Column(
            "user_id",
            sa.String(64),
            sa.ForeignKey("users.id", ondelete="CASCADE"),
            nullable=True,
        ),
        sa.Column("name", sa.String(256), nullable=False),
        sa.Column("key_hash", sa.String(128), nullable=False, unique=True),
        sa.Column("key_prefix", sa.String(16), nullable=False),
        sa.Column("scopes", sa.Text(), nullable=True),
        sa.Column(
            "is_service_key",
            sa.Boolean(),
            nullable=False,
            server_default=sa.text("false"),
        ),
        sa.Column(
            "is_active", sa.Boolean(), nullable=False, server_default=sa.text("true")
        ),
        sa.Column("expires_at", sa.BigInteger(), nullable=True),
        sa.Column("last_used_at", sa.BigInteger(), nullable=True),
        sa.Column("created_at", sa.BigInteger(), nullable=False),
    )
    op.create_index("idx_api_keys_user", "api_keys", ["user_id"])
    op.create_index("idx_api_keys_prefix", "api_keys", ["key_prefix"])

    # User sessions (refresh tokens)
    op.create_table(
        "user_sessions",
        sa.Column("id", sa.String(64), primary_key=True),
        sa.Column(
            "user_id",
            sa.String(64),
            sa.ForeignKey("users.id", ondelete="CASCADE"),
            nullable=False,
        ),
        sa.Column("refresh_token_hash", sa.String(128), nullable=False, unique=True),
        sa.Column("expires_at", sa.BigInteger(), nullable=False),
        sa.Column("created_at", sa.BigInteger(), nullable=False),
        sa.Column("ip_address", sa.String(64), nullable=True),
        sa.Column("user_agent", sa.Text(), nullable=True),
    )
    op.create_index("idx_user_sessions_user", "user_sessions", ["user_id"])
    op.create_index(
        "idx_user_sessions_refresh_hash",
        "user_sessions",
        ["refresh_token_hash"],
        unique=True,
    )


def downgrade() -> None:
    op.drop_table("user_sessions")
    op.drop_table("api_keys")
    op.drop_table("oidc_providers")
    op.drop_table("user_recovery_codes")
    op.drop_table("users")
