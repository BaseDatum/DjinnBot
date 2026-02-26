"""Add task work_type, completed_stages, and workflow_policies table.

Phase 1 + 2 of the task-aware stage routing system:
- work_type on tasks: classifies what kind of work a task represents
- completed_stages on tasks: tracks which SDLC stages a task has been through
- workflow_policies table: per-project rules defining which stages are
  required/optional/skip for each work type
- stage_affinity + task_work_types on pulse_routines: agents declare which
  stages and work types they handle

Revision ID: za6_work_type_policy
Revises: za5_tmpl_metadata
Create Date: 2026-02-26

"""

from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision: str = "za6_work_type_policy"
down_revision: Union[str, Sequence[str], None] = "za5_tmpl_metadata"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


# Default workflow policy for software-dev projects.
# Disposition: required = must pass through, optional = agent decides, skip = never
import json

DEFAULT_SOFTWARE_DEV_POLICY = {
    "feature": [
        {"stage": "spec", "disposition": "optional", "agent_role": "po"},
        {"stage": "design", "disposition": "optional", "agent_role": "sa"},
        {"stage": "ux", "disposition": "optional", "agent_role": "ux"},
        {"stage": "implement", "disposition": "required", "agent_role": "swe"},
        {"stage": "review", "disposition": "required", "agent_role": "sa"},
        {"stage": "test", "disposition": "required", "agent_role": "qa"},
        {"stage": "deploy", "disposition": "optional", "agent_role": "sre"},
    ],
    "bugfix": [
        {"stage": "spec", "disposition": "skip"},
        {"stage": "design", "disposition": "skip"},
        {"stage": "ux", "disposition": "skip"},
        {"stage": "implement", "disposition": "required", "agent_role": "swe"},
        {"stage": "review", "disposition": "optional", "agent_role": "sa"},
        {"stage": "test", "disposition": "required", "agent_role": "qa"},
        {"stage": "deploy", "disposition": "optional", "agent_role": "sre"},
    ],
    "test": [
        {"stage": "spec", "disposition": "skip"},
        {"stage": "design", "disposition": "skip"},
        {"stage": "ux", "disposition": "skip"},
        {"stage": "implement", "disposition": "required", "agent_role": "swe"},
        {"stage": "review", "disposition": "optional", "agent_role": "sa"},
        {"stage": "test", "disposition": "required", "agent_role": "qa"},
        {"stage": "deploy", "disposition": "skip"},
    ],
    "refactor": [
        {"stage": "spec", "disposition": "skip"},
        {"stage": "design", "disposition": "optional", "agent_role": "sa"},
        {"stage": "ux", "disposition": "skip"},
        {"stage": "implement", "disposition": "required", "agent_role": "swe"},
        {"stage": "review", "disposition": "required", "agent_role": "sa"},
        {"stage": "test", "disposition": "required", "agent_role": "qa"},
        {"stage": "deploy", "disposition": "optional", "agent_role": "sre"},
    ],
    "docs": [
        {"stage": "spec", "disposition": "skip"},
        {"stage": "design", "disposition": "skip"},
        {"stage": "ux", "disposition": "skip"},
        {"stage": "implement", "disposition": "required", "agent_role": "swe"},
        {"stage": "review", "disposition": "optional", "agent_role": "sa"},
        {"stage": "test", "disposition": "skip"},
        {"stage": "deploy", "disposition": "skip"},
    ],
    "infrastructure": [
        {"stage": "spec", "disposition": "skip"},
        {"stage": "design", "disposition": "optional", "agent_role": "sa"},
        {"stage": "ux", "disposition": "skip"},
        {"stage": "implement", "disposition": "required", "agent_role": "swe"},
        {"stage": "review", "disposition": "required", "agent_role": "sa"},
        {"stage": "test", "disposition": "optional", "agent_role": "qa"},
        {"stage": "deploy", "disposition": "required", "agent_role": "sre"},
    ],
    "design": [
        {"stage": "spec", "disposition": "optional", "agent_role": "po"},
        {"stage": "design", "disposition": "required", "agent_role": "sa"},
        {"stage": "ux", "disposition": "required", "agent_role": "ux"},
        {"stage": "implement", "disposition": "skip"},
        {"stage": "review", "disposition": "optional", "agent_role": "sa"},
        {"stage": "test", "disposition": "skip"},
        {"stage": "deploy", "disposition": "skip"},
    ],
    "custom": [
        {"stage": "spec", "disposition": "optional", "agent_role": "po"},
        {"stage": "design", "disposition": "optional", "agent_role": "sa"},
        {"stage": "ux", "disposition": "optional", "agent_role": "ux"},
        {"stage": "implement", "disposition": "optional", "agent_role": "swe"},
        {"stage": "review", "disposition": "optional", "agent_role": "sa"},
        {"stage": "test", "disposition": "optional", "agent_role": "qa"},
        {"stage": "deploy", "disposition": "optional", "agent_role": "sre"},
    ],
}


def upgrade() -> None:
    # 1. Add work_type and completed_stages to tasks table
    op.add_column("tasks", sa.Column("work_type", sa.String(32), nullable=True))
    op.add_column("tasks", sa.Column("completed_stages", sa.Text(), nullable=True))

    # 2. Add index on work_type for filtering
    op.create_index("idx_tasks_work_type", "tasks", ["work_type"])

    # 3. Create workflow_policies table
    op.create_table(
        "workflow_policies",
        sa.Column("id", sa.String(64), primary_key=True),
        sa.Column(
            "project_id",
            sa.String(64),
            sa.ForeignKey("projects.id", ondelete="CASCADE"),
            nullable=False,
        ),
        sa.Column(
            "stage_rules",
            sa.JSON(),
            nullable=False,
        ),
        sa.Column("created_at", sa.BigInteger(), nullable=False),
        sa.Column("updated_at", sa.BigInteger(), nullable=False),
    )
    op.create_index(
        "idx_workflow_policies_project",
        "workflow_policies",
        ["project_id"],
        unique=True,
    )

    # 4. Add stage_affinity and task_work_types to pulse_routines table
    op.add_column(
        "pulse_routines", sa.Column("stage_affinity", sa.JSON(), nullable=True)
    )
    op.add_column(
        "pulse_routines", sa.Column("task_work_types", sa.JSON(), nullable=True)
    )

    # 5. Seed default workflow policy for existing software-dev projects
    conn = op.get_bind()
    import uuid
    import time

    now = int(time.time() * 1000)

    # Find projects using the software-dev template
    sw_projects = conn.execute(
        sa.text(
            "SELECT p.id FROM projects p "
            "LEFT JOIN project_templates t ON p.template_id = t.id "
            "WHERE t.slug = 'software-dev' OR p.template_id IS NULL"
        )
    ).fetchall()

    for (project_id,) in sw_projects:
        # Check if policy already exists
        existing = conn.execute(
            sa.text("SELECT id FROM workflow_policies WHERE project_id = :pid"),
            {"pid": project_id},
        ).fetchone()

        if not existing:
            policy_id = f"wfp_{uuid.uuid4().hex[:12]}"
            conn.execute(
                sa.text(
                    "INSERT INTO workflow_policies (id, project_id, stage_rules, created_at, updated_at) "
                    "VALUES (:id, :pid, :rules, :now, :now)"
                ),
                {
                    "id": policy_id,
                    "pid": project_id,
                    "rules": json.dumps(DEFAULT_SOFTWARE_DEV_POLICY),
                    "now": now,
                },
            )


def downgrade() -> None:
    op.drop_column("pulse_routines", "task_work_types")
    op.drop_column("pulse_routines", "stage_affinity")
    op.drop_index("idx_workflow_policies_project")
    op.drop_table("workflow_policies")
    op.drop_index("idx_tasks_work_type")
    op.drop_column("tasks", "completed_stages")
    op.drop_column("tasks", "work_type")
