"""Add run key resolution and audit fields.

New columns on `runs`:
  - initiated_by_user_id: FK to users.id — who triggered this run
  - model_override: optional model override for all steps in this run
  - key_resolution: JSON blob recording which keys were resolved

New column on `steps`:
  - model_used: the actual model string used for this step

New columns on `admin_shared_providers`:
  - expires_at: optional expiry timestamp
  - allowed_models: optional JSON array of model IDs
  - daily_limit: optional per-day request cap

Revision ID: q1a2b3c4d5e6
Revises: p1a2b3c4d5e6
Create Date: 2026-02-22

"""

from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision: str = "q1a2b3c4d5e6"
down_revision: Union[str, None] = "p1a2b3c4d5e6"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    # ── runs table ──
    op.add_column(
        "runs",
        sa.Column(
            "initiated_by_user_id",
            sa.String(64),
            sa.ForeignKey("users.id", ondelete="SET NULL"),
            nullable=True,
        ),
    )
    op.add_column(
        "runs",
        sa.Column("model_override", sa.String(256), nullable=True),
    )
    op.add_column(
        "runs",
        sa.Column("key_resolution", sa.Text(), nullable=True),
    )

    # ── steps table ──
    op.add_column(
        "steps",
        sa.Column("model_used", sa.String(256), nullable=True),
    )

    # ── admin_shared_providers table ──
    op.add_column(
        "admin_shared_providers",
        sa.Column("expires_at", sa.BigInteger(), nullable=True),
    )
    op.add_column(
        "admin_shared_providers",
        sa.Column("allowed_models", sa.Text(), nullable=True),
    )
    op.add_column(
        "admin_shared_providers",
        sa.Column("daily_limit", sa.Integer(), nullable=True),
    )


def downgrade() -> None:
    op.drop_column("admin_shared_providers", "daily_limit")
    op.drop_column("admin_shared_providers", "allowed_models")
    op.drop_column("admin_shared_providers", "expires_at")
    op.drop_column("steps", "model_used")
    op.drop_column("runs", "key_resolution")
    op.drop_column("runs", "model_override")
    op.drop_column("runs", "initiated_by_user_id")
