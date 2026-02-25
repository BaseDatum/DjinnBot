"""Update built-in template metadata and backfill project workspace_type.

Existing built-in templates were seeded before workspace_type was added to
template metadata. This migration:
1. Updates template_metadata on built-in templates to include workspace_type.
2. Backfills workspace_type on projects created from those templates that
   currently have workspace_type = NULL.

Revision ID: za5_tmpl_metadata
Revises: za4_workspace_type
Create Date: 2026-02-25

"""

from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision: str = "za5_tmpl_metadata"
down_revision: Union[str, Sequence[str], None] = "za4_workspace_type"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


# Maps template slug → workspace_type that should be in its metadata.
TEMPLATE_WORKSPACE_TYPES = {
    "software-dev": "git_worktree",
    "kanban-simple": "persistent_directory",
    "content-pipeline": "persistent_directory",
    "research": "persistent_directory",
}


def upgrade() -> None:
    """Update built-in template metadata and backfill project workspace_type."""
    conn = op.get_bind()

    # 1. Update template_metadata on built-in templates
    templates = conn.execute(
        sa.text(
            "SELECT id, slug, template_metadata FROM project_templates "
            "WHERE is_builtin = true"
        )
    ).fetchall()

    for tmpl_id, slug, raw_meta in templates:
        workspace_type = TEMPLATE_WORKSPACE_TYPES.get(slug)
        if workspace_type is None:
            continue

        # Parse existing metadata (could be JSON string or dict depending on driver)
        import json

        if isinstance(raw_meta, str):
            meta = json.loads(raw_meta)
        elif raw_meta is None:
            meta = {}
        else:
            meta = dict(raw_meta)

        if meta.get("workspace_type") == workspace_type:
            continue  # Already correct

        meta["workspace_type"] = workspace_type

        conn.execute(
            sa.text(
                "UPDATE project_templates SET template_metadata = :meta, "
                "updated_at = extract(epoch from now()) * 1000 "
                "WHERE id = :tid"
            ),
            {"meta": json.dumps(meta), "tid": tmpl_id},
        )

    # 2. Backfill workspace_type on projects created from these templates
    #    that currently have workspace_type = NULL.
    for slug, ws_type in TEMPLATE_WORKSPACE_TYPES.items():
        conn.execute(
            sa.text(
                "UPDATE projects SET workspace_type = :ws_type "
                "WHERE workspace_type IS NULL "
                "AND template_id IN ("
                "  SELECT id FROM project_templates WHERE slug = :slug"
                ")"
            ),
            {"ws_type": ws_type, "slug": slug},
        )

    # 3. Backfill workspace_type on runs belonging to those projects.
    conn.execute(
        sa.text(
            "UPDATE runs SET workspace_type = p.workspace_type "
            "FROM projects p "
            "WHERE runs.project_id = p.id "
            "AND runs.workspace_type IS NULL "
            "AND p.workspace_type IS NOT NULL"
        )
    )


def downgrade() -> None:
    """No-op downgrade — metadata updates are safe to leave in place."""
    pass
