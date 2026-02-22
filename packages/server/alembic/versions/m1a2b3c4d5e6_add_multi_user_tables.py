"""Add multi-user tables and columns.

New tables:
  - user_model_providers: per-user API keys for model providers
  - admin_shared_providers: admin shares instance keys with users
  - user_secret_grants: admin grants instance secrets to users

Modified tables:
  - users: add slack_id column
  - secrets: add scope and owner_user_id columns
  - skills: add approval_status and submitted_by_user_id columns
  - mcp_servers: add approval_status and submitted_by_user_id columns
  - sessions: add user_id column

Data migration:
  - Move userSlackId from global_settings to first admin user's slack_id
  - Set all existing secrets to scope='instance'
  - Set all existing skills to approval_status='approved'
  - Set all existing MCP servers to approval_status='approved'

Revision ID: m1a2b3c4d5e6
Revises: 799467231df9
Create Date: 2026-02-21

"""

from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision: str = "m1a2b3c4d5e6"
down_revision: Union[str, Sequence[str], None] = "799467231df9"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    """Create multi-user tables and add columns."""

    # ── New tables ────────────────────────────────────────────────────────

    op.create_table(
        "user_model_providers",
        sa.Column(
            "user_id",
            sa.String(64),
            sa.ForeignKey("users.id", ondelete="CASCADE"),
            primary_key=True,
        ),
        sa.Column("provider_id", sa.String(64), primary_key=True),
        sa.Column(
            "enabled", sa.Boolean, nullable=False, server_default=sa.text("true")
        ),
        sa.Column("api_key", sa.Text, nullable=True),
        sa.Column("extra_config", sa.Text, nullable=True),
        sa.Column("created_at", sa.BigInteger, nullable=False),
        sa.Column("updated_at", sa.BigInteger, nullable=False),
    )
    op.create_index(
        "idx_user_model_providers_user", "user_model_providers", ["user_id"]
    )
    op.create_index(
        "idx_user_model_providers_provider", "user_model_providers", ["provider_id"]
    )

    op.create_table(
        "admin_shared_providers",
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
        sa.Column("created_at", sa.BigInteger, nullable=False),
    )
    op.create_index(
        "idx_admin_shared_providers_admin", "admin_shared_providers", ["admin_user_id"]
    )
    op.create_index(
        "idx_admin_shared_providers_target",
        "admin_shared_providers",
        ["target_user_id"],
    )
    op.create_index(
        "idx_admin_shared_providers_provider", "admin_shared_providers", ["provider_id"]
    )
    op.create_unique_constraint(
        "uq_admin_shared_provider_target",
        "admin_shared_providers",
        ["provider_id", "target_user_id"],
    )

    op.create_table(
        "user_secret_grants",
        sa.Column("id", sa.String(64), primary_key=True),
        sa.Column(
            "secret_id",
            sa.String(64),
            sa.ForeignKey("secrets.id", ondelete="CASCADE"),
            nullable=False,
        ),
        sa.Column(
            "user_id",
            sa.String(64),
            sa.ForeignKey("users.id", ondelete="CASCADE"),
            nullable=False,
        ),
        sa.Column("granted_at", sa.BigInteger, nullable=False),
        sa.Column("granted_by", sa.String(128), nullable=True),
    )
    op.create_index("idx_user_secret_grants_user", "user_secret_grants", ["user_id"])
    op.create_index(
        "idx_user_secret_grants_secret", "user_secret_grants", ["secret_id"]
    )
    op.create_unique_constraint(
        "uq_user_secret_grant",
        "user_secret_grants",
        ["secret_id", "user_id"],
    )

    # ── Add columns to existing tables ────────────────────────────────────

    # users.slack_id
    op.add_column("users", sa.Column("slack_id", sa.String(64), nullable=True))

    # secrets.scope + secrets.owner_user_id
    op.add_column(
        "secrets",
        sa.Column("scope", sa.String(16), nullable=False, server_default="instance"),
    )
    op.add_column(
        "secrets",
        sa.Column(
            "owner_user_id",
            sa.String(64),
            sa.ForeignKey("users.id", ondelete="SET NULL"),
            nullable=True,
        ),
    )

    # skills.approval_status + skills.submitted_by_user_id
    op.add_column(
        "skills",
        sa.Column(
            "approval_status", sa.String(16), nullable=False, server_default="approved"
        ),
    )
    op.add_column(
        "skills",
        sa.Column(
            "submitted_by_user_id",
            sa.String(64),
            sa.ForeignKey("users.id", ondelete="SET NULL"),
            nullable=True,
        ),
    )

    # mcp_servers.approval_status + mcp_servers.submitted_by_user_id
    op.add_column(
        "mcp_servers",
        sa.Column(
            "approval_status", sa.String(16), nullable=False, server_default="approved"
        ),
    )
    op.add_column(
        "mcp_servers",
        sa.Column(
            "submitted_by_user_id",
            sa.String(64),
            sa.ForeignKey("users.id", ondelete="SET NULL"),
            nullable=True,
        ),
    )

    # projects.key_user_id — user whose API keys are used for automated runs
    op.add_column(
        "projects",
        sa.Column(
            "key_user_id",
            sa.String(64),
            sa.ForeignKey("users.id", ondelete="SET NULL"),
            nullable=True,
        ),
    )

    # sessions.user_id
    op.add_column(
        "sessions",
        sa.Column(
            "user_id",
            sa.String(64),
            sa.ForeignKey("users.id", ondelete="SET NULL"),
            nullable=True,
        ),
    )
    op.create_index("idx_sessions_user", "sessions", ["user_id"])

    # ── Data migration ────────────────────────────────────────────────────
    # Move userSlackId from global_settings to the first admin user's slack_id.
    # This is a best-effort migration — if no admin user or no setting exists,
    # it's a no-op.
    conn = op.get_bind()

    # Read the current userSlackId from global_settings
    result = conn.execute(
        sa.text("SELECT value FROM global_settings WHERE key = 'userSlackId'")
    )
    row = result.fetchone()
    if row and row[0] and row[0].strip():
        slack_id = row[0].strip()
        # Find the first admin user
        admin_result = conn.execute(
            sa.text(
                "SELECT id FROM users WHERE is_admin = true ORDER BY created_at ASC LIMIT 1"
            )
        )
        admin_row = admin_result.fetchone()
        if admin_row:
            conn.execute(
                sa.text("UPDATE users SET slack_id = :slack_id WHERE id = :uid"),
                {"slack_id": slack_id, "uid": admin_row[0]},
            )


def downgrade() -> None:
    """Remove multi-user tables and columns."""

    # Drop new columns
    op.drop_index("idx_sessions_user", table_name="sessions")
    op.drop_column("sessions", "user_id")

    op.drop_column("projects", "key_user_id")

    op.drop_column("mcp_servers", "submitted_by_user_id")
    op.drop_column("mcp_servers", "approval_status")

    op.drop_column("skills", "submitted_by_user_id")
    op.drop_column("skills", "approval_status")

    op.drop_column("secrets", "owner_user_id")
    op.drop_column("secrets", "scope")

    op.drop_column("users", "slack_id")

    # Drop new tables
    op.drop_table("user_secret_grants")
    op.drop_table("admin_shared_providers")
    op.drop_table("user_model_providers")
