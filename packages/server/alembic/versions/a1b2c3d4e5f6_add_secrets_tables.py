"""add_secrets_tables

Adds:
  - secrets: user-defined credentials stored AES-256-GCM encrypted at rest
  - agent_secret_grants: scopes a secret to a specific agent

The ``encrypted_value`` column stores AES-256-GCM ciphertext produced by
``app.crypto.encrypt_secret``.  The raw plaintext is never returned via the
API — only the ``masked_preview`` short preview is exposed.

Revision ID: a1b2c3d4e5f6
Revises: e1f2a3b4c5d6
Create Date: 2026-02-19 14:00:00.000000
"""

from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision: str = "a1b2c3d4e5f6"
down_revision: Union[str, Sequence[str], None] = "e1f2a3b4c5d6"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.create_table(
        "secrets",
        sa.Column("id", sa.String(length=64), primary_key=True),
        sa.Column("name", sa.String(length=256), nullable=False),
        sa.Column("description", sa.Text(), nullable=True),
        sa.Column(
            "secret_type",
            sa.String(length=32),
            nullable=False,
            server_default="env_var",
        ),
        sa.Column("env_key", sa.String(length=256), nullable=False),
        sa.Column("encrypted_value", sa.Text(), nullable=False),
        sa.Column("masked_preview", sa.String(length=64), nullable=True),
        sa.Column("created_at", sa.BigInteger(), nullable=False),
        sa.Column("updated_at", sa.BigInteger(), nullable=False),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_index("idx_secrets_env_key", "secrets", ["env_key"])
    op.create_index("idx_secrets_secret_type", "secrets", ["secret_type"])

    op.create_table(
        "agent_secret_grants",
        sa.Column("id", sa.String(length=64), primary_key=True),
        sa.Column("secret_id", sa.String(length=64), nullable=False),
        sa.Column("agent_id", sa.String(length=128), nullable=False),
        sa.Column("granted_at", sa.BigInteger(), nullable=False),
        sa.Column("granted_by", sa.String(length=128), nullable=True),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint("secret_id", "agent_id", name="uq_agent_secret_grant"),
    )
    op.create_index(
        "idx_agent_secret_grants_agent", "agent_secret_grants", ["agent_id"]
    )
    op.create_index(
        "idx_agent_secret_grants_secret", "agent_secret_grants", ["secret_id"]
    )


def downgrade() -> None:
    op.drop_index("idx_agent_secret_grants_secret", table_name="agent_secret_grants")
    op.drop_index("idx_agent_secret_grants_agent", table_name="agent_secret_grants")
    op.drop_table("agent_secret_grants")

    op.drop_index("idx_secrets_secret_type", table_name="secrets")
    op.drop_index("idx_secrets_env_key", table_name="secrets")
    op.drop_table("secrets")
