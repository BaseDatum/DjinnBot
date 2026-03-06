"""merge_browser_cookies_and_code_graph

Merges the add_browser_cookie_tables and add_code_graph_indexes
branches into a single head.

Revision ID: zb1_merge_heads
Revises: za9_browser_cookies, za9_code_graph
Create Date: 2026-02-26 21:00:00.000000
"""

from typing import Sequence, Union


# revision identifiers, used by Alembic.
revision: str = "zb1_merge_heads"
down_revision: Union[str, Sequence[str], None] = (
    "za9_browser_cookies",
    "za9_code_graph",
)
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    pass


def downgrade() -> None:
    pass
