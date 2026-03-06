"""add_code_graph_indexes

Create the code_graph_indexes table for tracking knowledge graph
indexing state per project.

Revision ID: za9_code_graph
Revises: za8_merge_heads
Create Date: 2026-02-26 18:00:00.000000
"""

from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa

revision: str = "za9_code_graph"
down_revision: Union[str, Sequence[str], None] = "za8_merge_heads"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.create_table(
        "code_graph_indexes",
        sa.Column("id", sa.String(64), primary_key=True),
        sa.Column("project_id", sa.String(64), nullable=False, unique=True),
        sa.Column("status", sa.String(32), nullable=False, server_default="pending"),
        sa.Column("last_indexed_at", sa.BigInteger, nullable=True),
        sa.Column("last_commit_hash", sa.String(64), nullable=True),
        sa.Column("node_count", sa.Integer, nullable=False, server_default="0"),
        sa.Column("relationship_count", sa.Integer, nullable=False, server_default="0"),
        sa.Column("community_count", sa.Integer, nullable=False, server_default="0"),
        sa.Column("process_count", sa.Integer, nullable=False, server_default="0"),
        sa.Column("error", sa.Text, nullable=True),
        sa.Column("created_at", sa.BigInteger, nullable=False),
        sa.Column("updated_at", sa.BigInteger, nullable=False),
    )
    op.create_index(
        "idx_code_graph_project", "code_graph_indexes", ["project_id"], unique=True
    )


def downgrade() -> None:
    op.drop_index("idx_code_graph_project", table_name="code_graph_indexes")
    op.drop_table("code_graph_indexes")
