"""Add Planned, UX, and Test kanban columns to existing projects.

Inserts the three new columns (Planned, UX, Test) into every project's
kanban board and re-numbers existing column positions to match the new
default ordering:

  Backlog(0) → Planning(1) → Planned(2) → UX(3) → Blocked(4) → Ready(5) →
  In Progress(6) → Review(7) → Test(8) → Done(9) → Failed(10)

Revision ID: dd1e2f3g4h5i
Revises: cc1d2e3f4g5h
Create Date: 2026-02-24

"""

from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa
from sqlalchemy import text
import json
import uuid


# revision identifiers, used by Alembic.
revision: str = "dd1e2f3g4h5i"
down_revision: Union[str, None] = "cc1d2e3f4g5h"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


# Target column order — name → (position, wip_limit, task_statuses)
TARGET_COLUMNS = {
    "Backlog": (0, None, ["backlog"]),
    "Planning": (1, None, ["planning"]),
    "Planned": (2, None, ["planned"]),
    "UX": (3, None, ["ux"]),
    "Blocked": (4, None, ["blocked"]),
    "Ready": (5, None, ["ready"]),
    "In Progress": (6, 5, ["in_progress"]),
    "Review": (7, None, ["review"]),
    "Test": (8, None, ["test"]),
    "Done": (9, None, ["done"]),
    "Failed": (10, None, ["failed"]),
}

NEW_COLUMNS = ["Planned", "UX", "Test"]


def upgrade() -> None:
    conn = op.get_bind()

    # Get all project IDs
    projects = conn.execute(text("SELECT id FROM projects")).fetchall()

    for (project_id,) in projects:
        # Get existing column names for this project
        existing = conn.execute(
            text("SELECT name FROM kanban_columns WHERE project_id = :pid"),
            {"pid": project_id},
        ).fetchall()
        existing_names = {row[0] for row in existing}

        # Insert missing columns
        for col_name in NEW_COLUMNS:
            if col_name not in existing_names:
                pos, wip, statuses = TARGET_COLUMNS[col_name]
                col_id = str(uuid.uuid4())
                conn.execute(
                    text(
                        "INSERT INTO kanban_columns "
                        "(id, project_id, name, position, wip_limit, task_statuses) "
                        "VALUES (:id, :pid, :name, :pos, :wip, :statuses)"
                    ),
                    {
                        "id": col_id,
                        "pid": project_id,
                        "name": col_name,
                        "pos": pos,
                        "wip": wip,
                        "statuses": json.dumps(statuses),
                    },
                )

        # Re-number all columns to the target positions
        for col_name, (pos, _wip, _statuses) in TARGET_COLUMNS.items():
            conn.execute(
                text(
                    "UPDATE kanban_columns SET position = :pos "
                    "WHERE project_id = :pid AND name = :name"
                ),
                {"pos": pos, "pid": project_id, "name": col_name},
            )


def downgrade() -> None:
    conn = op.get_bind()

    # Remove the three new columns from all projects
    for col_name in NEW_COLUMNS:
        conn.execute(
            text("DELETE FROM kanban_columns WHERE name = :name"),
            {"name": col_name},
        )

    # Re-number remaining columns back to old positions
    OLD_POSITIONS = {
        "Backlog": 0,
        "Planning": 1,
        "Blocked": 2,
        "Ready": 3,
        "In Progress": 4,
        "Review": 5,
        "Done": 6,
        "Failed": 7,
    }
    for col_name, pos in OLD_POSITIONS.items():
        conn.execute(
            text("UPDATE kanban_columns SET position = :pos WHERE name = :name"),
            {"pos": pos, "name": col_name},
        )
