"""Skill library and agent access-control models.

Two tables:
  skills       — the canonical skill library (global + agent-owned)
  agent_skills — join table: which agents have access to which skills
"""

from typing import Optional
from sqlalchemy import (
    String,
    Text,
    Boolean,
    BigInteger,
    Index,
    ForeignKey,
    UniqueConstraint,
)
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.models.base import Base, now_ms


class Skill(Base):
    """A skill in the library.

    scope='global'  → created by the UI / any agent; no agent owns it
    scope='agent'   → created by / for a specific agent (owner_agent_id set)

    enabled=False is a global kill-switch; no agent can load it while disabled
    regardless of their agent_skills grant.
    """

    __tablename__ = "skills"
    __table_args__ = (
        Index("idx_skills_scope", "scope"),
        Index("idx_skills_owner", "owner_agent_id"),
        Index("idx_skills_enabled", "enabled"),
    )

    id: Mapped[str] = mapped_column(
        String(64), primary_key=True
    )  # slug e.g. "github-pr"
    description: Mapped[str] = mapped_column(Text, nullable=False, default="")
    tags: Mapped[str] = mapped_column(Text, nullable=False, default="[]")  # JSON array
    content: Mapped[str] = mapped_column(Text, nullable=False, default="")
    enabled: Mapped[bool] = mapped_column(Boolean, nullable=False, default=True)
    scope: Mapped[str] = mapped_column(
        String(16), nullable=False, default="global"
    )  # 'global' | 'agent'
    owner_agent_id: Mapped[Optional[str]] = mapped_column(String(128), nullable=True)
    # True when the skill has companion files on disk at SKILLS_DIR/{id}/
    has_files: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False)
    created_by: Mapped[str] = mapped_column(String(128), nullable=False, default="ui")

    # Approval workflow: admin-created skills are auto-approved; user-submitted
    # skills start as 'pending' and require admin approval.
    #   'approved'  — active and usable by agents
    #   'pending'   — submitted by user, awaiting admin review
    #   'rejected'  — admin rejected the submission
    approval_status: Mapped[str] = mapped_column(
        String(16), nullable=False, default="approved"
    )
    # The user who submitted this skill (NULL for system/disk-imported skills).
    submitted_by_user_id: Mapped[Optional[str]] = mapped_column(
        String(64), ForeignKey("users.id", ondelete="SET NULL"), nullable=True
    )

    created_at: Mapped[int] = mapped_column(BigInteger, nullable=False)
    updated_at: Mapped[int] = mapped_column(BigInteger, nullable=False)

    # Relationships
    grants: Mapped[list["AgentSkill"]] = relationship(
        back_populates="skill",
        cascade="all, delete-orphan",
    )


class AgentSkill(Base):
    """Access-control join: which agents may use which skills.

    A skill must have a row here (with granted=True) for an agent to see it
    in their manifest and load it via load_skill().

    granted=False is a soft-revoke: the row stays for audit purposes but the
    agent loses access immediately.
    """

    __tablename__ = "agent_skills"
    __table_args__ = (
        UniqueConstraint("agent_id", "skill_id", name="uq_agent_skill"),
        Index("idx_agent_skills_agent", "agent_id"),
        Index("idx_agent_skills_skill", "skill_id"),
    )

    id: Mapped[int] = mapped_column(BigInteger, primary_key=True, autoincrement=True)
    agent_id: Mapped[str] = mapped_column(String(128), nullable=False)
    skill_id: Mapped[str] = mapped_column(
        String(64), ForeignKey("skills.id", ondelete="CASCADE"), nullable=False
    )
    granted: Mapped[bool] = mapped_column(Boolean, nullable=False, default=True)
    granted_at: Mapped[int] = mapped_column(BigInteger, nullable=False)
    granted_by: Mapped[str] = mapped_column(String(128), nullable=False, default="ui")

    # Relationships
    skill: Mapped["Skill"] = relationship(back_populates="grants")
