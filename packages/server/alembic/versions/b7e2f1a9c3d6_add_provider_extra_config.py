"""add_provider_extra_config

Adds extra_config JSON column to model_providers to store supplemental
environment variables for providers that need more than a single API key
(e.g. Azure OpenAI requires AZURE_OPENAI_BASE_URL / AZURE_OPENAI_RESOURCE_NAME).

Stored as JSON text: {"AZURE_OPENAI_BASE_URL": "https://..."}.
Injected into agent containers and process.env alongside the main api_key.

Revision ID: b7e2f1a9c3d6
Revises: f3a1b9c2d4e5
Create Date: 2026-02-19 00:00:00.000000

"""

from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision: str = "b7e2f1a9c3d6"
down_revision: Union[str, Sequence[str], None] = "f3a1b9c2d4e5"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.add_column(
        "model_providers",
        sa.Column(
            "extra_config",
            sa.Text(),
            nullable=True,
            comment="JSON map of extra env vars for this provider",
        ),
    )


def downgrade() -> None:
    op.drop_column("model_providers", "extra_config")
