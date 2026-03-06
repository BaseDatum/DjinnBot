"""add skill has_files column

Adds has_files boolean column to the skills table to indicate when a skill
has companion files stored on disk at SKILLS_DIR/{skill_id}/.

Revision ID: g1a2b3c4d5e6
Revises: f7a8b9c0d1e2
Create Date: 2026-02-21 18:00:00.000000

"""

from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision: str = "g1a2b3c4d5e6"
down_revision: Union[str, None] = "f7a8b9c0d1e2"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.add_column(
        "skills",
        sa.Column("has_files", sa.Boolean(), nullable=False, server_default="false"),
    )


def downgrade() -> None:
    op.drop_column("skills", "has_files")
