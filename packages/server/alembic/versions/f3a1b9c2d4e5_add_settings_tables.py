"""add_settings_tables

Adds:
- model_providers: persistent API key config per provider (replaces Redis PROVIDERS_KEY)
- global_settings: key-value store for global app settings (replaces Redis SETTINGS_KEY)

Revision ID: f3a1b9c2d4e5
Revises: a9f3b2c81e54
Create Date: 2026-02-19 00:00:00.000000

"""

from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision: str = "f3a1b9c2d4e5"
down_revision: Union[str, Sequence[str], None] = "a9f3b2c81e54"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.create_table(
        "model_providers",
        sa.Column("provider_id", sa.String(length=64), primary_key=True),
        sa.Column("enabled", sa.Boolean(), nullable=False, server_default="true"),
        sa.Column("api_key", sa.Text(), nullable=True),
        sa.Column("created_at", sa.BigInteger(), nullable=False),
        sa.Column("updated_at", sa.BigInteger(), nullable=False),
        sa.PrimaryKeyConstraint("provider_id"),
    )
    op.create_index(
        "idx_model_providers_provider_id",
        "model_providers",
        ["provider_id"],
        unique=True,
    )

    op.create_table(
        "global_settings",
        sa.Column("key", sa.String(length=128), primary_key=True),
        sa.Column("value", sa.Text(), nullable=False),
        sa.Column("updated_at", sa.BigInteger(), nullable=False),
        sa.PrimaryKeyConstraint("key"),
    )


def downgrade() -> None:
    op.drop_index("idx_model_providers_provider_id", table_name="model_providers")
    op.drop_table("model_providers")
    op.drop_table("global_settings")
