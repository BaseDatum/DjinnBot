"""Workflow policy model.

Defines per-project stage routing rules: which SDLC stages are
required, optional, or skipped for each task work type.

This is the enforcement layer that ensures tasks flow through the
correct stages based on their type (feature, bugfix, test, etc.).
"""

from typing import Optional

from sqlalchemy import String, BigInteger, JSON, ForeignKey, Index
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.models.base import Base


class WorkflowPolicy(Base):
    """Per-project workflow routing policy.

    stage_rules is a JSON object mapping work_type to a list of stage rules:
    {
        "feature": [
            {"stage": "spec", "disposition": "optional", "agent_role": "po"},
            {"stage": "design", "disposition": "optional", "agent_role": "sa"},
            {"stage": "ux", "disposition": "optional", "agent_role": "ux"},
            {"stage": "implement", "disposition": "required", "agent_role": "swe"},
            {"stage": "review", "disposition": "required", "agent_role": "sa"},
            {"stage": "test", "disposition": "required", "agent_role": "qa"},
            {"stage": "deploy", "disposition": "optional", "agent_role": "sre"},
        ],
        "bugfix": [...],
        "test": [...],
        ...
    }

    Dispositions:
    - "required": Task MUST pass through this stage. Transition enforcement
      will block skipping it.
    - "optional": Agent can decide whether to use this stage. No enforcement.
    - "skip": This stage is not applicable for this work type. Transition
      enforcement will block transitioning to it.
    """

    __tablename__ = "workflow_policies"
    __table_args__ = (
        Index("idx_workflow_policies_project", "project_id", unique=True),
    )

    id: Mapped[str] = mapped_column(String(64), primary_key=True)
    project_id: Mapped[str] = mapped_column(
        String(64),
        ForeignKey("projects.id", ondelete="CASCADE"),
        nullable=False,
    )
    # JSON: { work_type: [{ stage, disposition, agent_role? }] }
    stage_rules: Mapped[dict] = mapped_column(JSON, nullable=False)

    created_at: Mapped[int] = mapped_column(BigInteger, nullable=False)
    updated_at: Mapped[int] = mapped_column(BigInteger, nullable=False)
