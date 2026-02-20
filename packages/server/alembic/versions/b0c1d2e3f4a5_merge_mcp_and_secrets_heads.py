"""merge_mcp_and_secrets_heads

Merges the add_mcp_tables and add_secrets_tables branches into a single head.

Revision ID: b0c1d2e3f4a5
Revises: f1a2b3c4d5e6, a1b2c3d4e5f6
Create Date: 2026-02-19 23:00:00.000000
"""

from typing import Sequence, Union


# revision identifiers, used by Alembic.
revision: str = "b0c1d2e3f4a5"
down_revision: Union[str, Sequence[str], None] = ("f1a2b3c4d5e6", "a1b2c3d4e5f6")
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    pass


def downgrade() -> None:
    pass
