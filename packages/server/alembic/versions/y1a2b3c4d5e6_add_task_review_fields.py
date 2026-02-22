"""Add two-stage review fields to tasks table.

Supports the spec-compliance + code-quality review workflow:
- spec_review_status: did the implementation match the spec?
- quality_review_status: is the code well-constructed?
- spec_review_notes: feedback from spec review
- quality_review_notes: feedback from quality review

Revision ID: y1a2b3c4d5e6
Revises: x1a2b3c4d5e6
Create Date: 2026-02-22

"""

from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision: str = "y1a2b3c4d5e6"
down_revision: Union[str, Sequence[str], None] = "x1a2b3c4d5e6"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    """Add two-stage review columns to tasks."""
    op.add_column(
        "tasks",
        sa.Column(
            "spec_review_status",
            sa.String(32),
            nullable=True,
            comment="pending | passed | failed | skipped",
        ),
    )
    op.add_column(
        "tasks",
        sa.Column(
            "quality_review_status",
            sa.String(32),
            nullable=True,
            comment="pending | passed | failed | skipped",
        ),
    )
    op.add_column(
        "tasks",
        sa.Column(
            "spec_review_notes",
            sa.Text(),
            nullable=True,
            comment="Feedback from spec compliance review",
        ),
    )
    op.add_column(
        "tasks",
        sa.Column(
            "quality_review_notes",
            sa.Text(),
            nullable=True,
            comment="Feedback from code quality review",
        ),
    )


def downgrade() -> None:
    """Remove two-stage review columns."""
    op.drop_column("tasks", "quality_review_notes")
    op.drop_column("tasks", "spec_review_notes")
    op.drop_column("tasks", "quality_review_status")
    op.drop_column("tasks", "spec_review_status")
