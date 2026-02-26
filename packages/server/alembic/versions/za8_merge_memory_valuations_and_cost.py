"""merge_memory_valuations_and_cost_approximate

Merges the add_agent_memory_valuations and add_llm_call_cost_approximate
branches into a single head.

Revision ID: za8_merge_heads
Revises: cc2d3e4f5g6h, za7_cost_approximate
Create Date: 2026-02-26 12:00:00.000000
"""

from typing import Sequence, Union


# revision identifiers, used by Alembic.
revision: str = "za8_merge_heads"
down_revision: Union[str, Sequence[str], None] = (
    "cc2d3e4f5g6h",
    "za7_cost_approximate",
)
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    pass


def downgrade() -> None:
    pass
