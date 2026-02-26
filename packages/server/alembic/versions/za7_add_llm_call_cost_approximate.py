"""Add cost_approximate column to llm_call_logs.

Flags LLM call cost entries that were computed from sibling model
pricing or OpenRouter's live API rather than exact registry data.
The dashboard uses this to show an approximate ("~") indicator.

Revision ID: za7_cost_approximate
Revises: za6_work_type_policy
Create Date: 2026-02-26

"""

from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision: str = "za7_cost_approximate"
down_revision: Union[str, Sequence[str], None] = "za6_work_type_policy"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.add_column(
        "llm_call_logs",
        sa.Column(
            "cost_approximate",
            sa.Boolean,
            nullable=False,
            server_default="false",
        ),
    )


def downgrade() -> None:
    op.drop_column("llm_call_logs", "cost_approximate")
