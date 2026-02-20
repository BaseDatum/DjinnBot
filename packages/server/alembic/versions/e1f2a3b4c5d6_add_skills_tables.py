"""add_skills_tables

Adds the skills library and agent_skills access-control tables for V2 of
the skill system.  Skills are now stored in the database (not just on the
filesystem) and each agent's access is explicitly granted via agent_skills.

Revision ID: e1f2a3b4c5d6
Revises: c9d3e5f7a2b1
Create Date: 2026-02-19 12:00:00.000000

"""

from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision: str = "e1f2a3b4c5d6"
down_revision: Union[str, Sequence[str], None] = "c9d3e5f7a2b1"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    # ── skills ─────────────────────────────────────────────────────────────────
    op.create_table(
        "skills",
        sa.Column("id", sa.String(length=64), nullable=False),  # slug PK
        sa.Column("description", sa.Text(), nullable=False, server_default=""),
        sa.Column("tags", sa.Text(), nullable=False, server_default="[]"),  # JSON array
        sa.Column("content", sa.Text(), nullable=False, server_default=""),
        sa.Column("enabled", sa.Boolean(), nullable=False, server_default="true"),
        sa.Column(
            "scope", sa.String(length=16), nullable=False, server_default="global"
        ),
        sa.Column("owner_agent_id", sa.String(length=128), nullable=True),
        sa.Column(
            "created_by", sa.String(length=128), nullable=False, server_default="ui"
        ),
        sa.Column("created_at", sa.BigInteger(), nullable=False),
        sa.Column("updated_at", sa.BigInteger(), nullable=False),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_index("idx_skills_scope", "skills", ["scope"])
    op.create_index("idx_skills_owner", "skills", ["owner_agent_id"])
    op.create_index("idx_skills_enabled", "skills", ["enabled"])

    # ── agent_skills ───────────────────────────────────────────────────────────
    op.create_table(
        "agent_skills",
        sa.Column("id", sa.BigInteger(), autoincrement=True, nullable=False),
        sa.Column("agent_id", sa.String(length=128), nullable=False),
        sa.Column("skill_id", sa.String(length=64), nullable=False),
        sa.Column("granted", sa.Boolean(), nullable=False, server_default="true"),
        sa.Column("granted_at", sa.BigInteger(), nullable=False),
        sa.Column(
            "granted_by", sa.String(length=128), nullable=False, server_default="ui"
        ),
        sa.ForeignKeyConstraint(["skill_id"], ["skills.id"], ondelete="CASCADE"),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint("agent_id", "skill_id", name="uq_agent_skill"),
    )
    op.create_index("idx_agent_skills_agent", "agent_skills", ["agent_id"])
    op.create_index("idx_agent_skills_skill", "agent_skills", ["skill_id"])


def downgrade() -> None:
    op.drop_index("idx_agent_skills_skill", table_name="agent_skills")
    op.drop_index("idx_agent_skills_agent", table_name="agent_skills")
    op.drop_table("agent_skills")

    op.drop_index("idx_skills_enabled", table_name="skills")
    op.drop_index("idx_skills_owner", table_name="skills")
    op.drop_index("idx_skills_scope", table_name="skills")
    op.drop_table("skills")
