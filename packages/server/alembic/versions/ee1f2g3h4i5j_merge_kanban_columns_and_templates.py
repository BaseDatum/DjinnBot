"""merge_kanban_columns_and_project_templates

Merges the add_planned_ux_test_columns and add_project_templates branches
into a single head.

Revision ID: ee1f2g3h4i5j
Revises: dd1e2f3g4h5i, za1_templates
Create Date: 2026-02-24 15:30:00.000000
"""

from typing import Sequence, Union


# revision identifiers, used by Alembic.
revision: str = "ee1f2g3h4i5j"
down_revision: Union[str, Sequence[str], None] = ("dd1e2f3g4h5i", "za1_templates")
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    pass


def downgrade() -> None:
    pass
