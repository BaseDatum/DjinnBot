"""Add project_templates table and template_id/status_semantics to projects.

Introduces modular project templates so projects are no longer hardcoded
to the software-development kanban workflow. Each template defines:
- Column layout (names, positions, statuses)
- Status semantics (which statuses are terminal, blocking, etc.)
- Default pipeline and onboarding agent chain

Existing projects get template_id=NULL and status_semantics=NULL,
which triggers legacy fallback behavior (backward compatible).

Revision ID: za1_templates
Revises: z1a2b3c4d5e6
Create Date: 2026-02-24

"""

from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision: str = "za1_templates"
down_revision: Union[str, Sequence[str], None] = "z1a2b3c4d5e6"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    """Create project_templates table and add FK to projects."""

    # Create project_templates table
    op.create_table(
        "project_templates",
        sa.Column("id", sa.String(64), primary_key=True),
        sa.Column("slug", sa.String(128), nullable=False, unique=True),
        sa.Column("name", sa.String(256), nullable=False),
        sa.Column("description", sa.Text, nullable=False, server_default=""),
        sa.Column("icon", sa.String(16), nullable=True),
        sa.Column("is_builtin", sa.Boolean, nullable=False, server_default="0"),
        sa.Column("board_columns", sa.JSON, nullable=False),
        sa.Column("status_semantics", sa.JSON, nullable=False),
        sa.Column("default_pipeline_id", sa.String(128), nullable=True),
        sa.Column("onboarding_agent_chain", sa.JSON, nullable=True),
        sa.Column("template_metadata", sa.JSON, nullable=False, server_default="{}"),
        sa.Column("sort_order", sa.Integer, nullable=False, server_default="0"),
        sa.Column("created_at", sa.BigInteger, nullable=False),
        sa.Column("updated_at", sa.BigInteger, nullable=False),
    )
    op.create_index(
        "idx_project_templates_slug", "project_templates", ["slug"], unique=True
    )

    # Add template_id and status_semantics to projects table
    op.add_column(
        "projects",
        sa.Column(
            "template_id",
            sa.String(64),
            sa.ForeignKey("project_templates.id", ondelete="SET NULL"),
            nullable=True,
        ),
    )
    op.add_column(
        "projects",
        sa.Column("status_semantics", sa.JSON, nullable=True),
    )


def downgrade() -> None:
    """Remove template columns and table."""
    op.drop_column("projects", "status_semantics")
    op.drop_column("projects", "template_id")
    op.drop_index("idx_project_templates_slug", table_name="project_templates")
    op.drop_table("project_templates")
