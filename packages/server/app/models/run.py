"""Run and step execution models."""

from typing import Optional
from sqlalchemy import String, Text, Integer, BigInteger, ForeignKey, Index
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.models.base import Base, TimestampWithCompletedMixin


class Run(Base, TimestampWithCompletedMixin):
    """Pipeline run execution."""

    __tablename__ = "runs"

    id: Mapped[str] = mapped_column(String(64), primary_key=True)
    pipeline_id: Mapped[str] = mapped_column(String(128), nullable=False, index=True)
    project_id: Mapped[Optional[str]] = mapped_column(String(64), nullable=True)
    task_description: Mapped[str] = mapped_column(Text, nullable=False)
    status: Mapped[str] = mapped_column(String(32), nullable=False, default="pending")
    outputs: Mapped[str] = mapped_column(Text, nullable=False, default="{}")
    current_step_id: Mapped[Optional[str]] = mapped_column(String(64), nullable=True)
    human_context: Mapped[Optional[str]] = mapped_column(Text, nullable=True)

    # Git branch for this run's worktree (e.g. "feat/task_abc123-oauth").
    # When set, the engine creates the worktree on this branch instead of
    # an ephemeral run/{runId} branch.  Shared across retries of the same task.
    task_branch: Mapped[Optional[str]] = mapped_column(String(256), nullable=True)

    # Workspace strategy inherited from the project at run creation time.
    # Stored on the run so the engine doesn't need to look up the project
    # to decide which workspace manager to use. Values match Project.workspace_type.
    workspace_type: Mapped[Optional[str]] = mapped_column(String(32), nullable=True)

    # Multi-user key resolution fields
    initiated_by_user_id: Mapped[Optional[str]] = mapped_column(
        String(64),
        ForeignKey("users.id", ondelete="SET NULL"),
        nullable=True,
    )
    model_override: Mapped[Optional[str]] = mapped_column(String(256), nullable=True)
    key_resolution: Mapped[Optional[str]] = mapped_column(Text, nullable=True)

    # Relationships
    steps: Mapped[list["Step"]] = relationship(
        back_populates="run", cascade="all, delete-orphan"
    )
    knowledge_items: Mapped[list["Knowledge"]] = relationship(
        back_populates="run", cascade="all, delete-orphan"
    )
    output_items: Mapped[list["Output"]] = relationship(
        back_populates="run", cascade="all, delete-orphan"
    )


class Step(Base):
    """Individual step within a pipeline run."""

    __tablename__ = "steps"
    __table_args__ = (Index("idx_steps_run", "run_id"),)

    id: Mapped[str] = mapped_column(String(64), nullable=False)
    run_id: Mapped[str] = mapped_column(
        String(64), ForeignKey("runs.id"), nullable=False, primary_key=True
    )
    step_id: Mapped[str] = mapped_column(String(64), nullable=False, primary_key=True)
    agent_id: Mapped[str] = mapped_column(String(128), nullable=False)
    status: Mapped[str] = mapped_column(String(32), nullable=False, default="pending")
    session_id: Mapped[Optional[str]] = mapped_column(String(128), nullable=True)
    inputs: Mapped[str] = mapped_column(Text, nullable=False, default="{}")
    outputs: Mapped[str] = mapped_column(Text, nullable=False, default="{}")
    error: Mapped[Optional[str]] = mapped_column(Text, nullable=True)
    retry_count: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    max_retries: Mapped[int] = mapped_column(Integer, nullable=False, default=3)
    started_at: Mapped[Optional[int]] = mapped_column(BigInteger, nullable=True)
    completed_at: Mapped[Optional[int]] = mapped_column(BigInteger, nullable=True)
    human_context: Mapped[Optional[str]] = mapped_column(Text, nullable=True)
    model_used: Mapped[Optional[str]] = mapped_column(String(256), nullable=True)

    # Relationships
    run: Mapped["Run"] = relationship(back_populates="steps")


class LoopState(Base):
    """Loop iteration state for pipeline runs."""

    __tablename__ = "loop_state"

    run_id: Mapped[str] = mapped_column(String(64), primary_key=True)
    step_id: Mapped[str] = mapped_column(String(64), primary_key=True)
    items: Mapped[str] = mapped_column(Text, nullable=False)
    current_index: Mapped[int] = mapped_column(Integer, nullable=False, default=0)


class Knowledge(Base):
    """Knowledge items captured during runs."""

    __tablename__ = "knowledge"
    __table_args__ = (Index("idx_knowledge_run", "run_id"),)

    id: Mapped[str] = mapped_column(String(64), primary_key=True)
    run_id: Mapped[str] = mapped_column(
        String(64), ForeignKey("runs.id"), nullable=False
    )
    agent_id: Mapped[str] = mapped_column(String(128), nullable=False)
    category: Mapped[str] = mapped_column(String(64), nullable=False)
    content: Mapped[str] = mapped_column(Text, nullable=False)
    importance: Mapped[str] = mapped_column(
        String(32), nullable=False, default="medium"
    )
    created_at: Mapped[int] = mapped_column(BigInteger, nullable=False)

    # Relationships
    run: Mapped["Run"] = relationship(back_populates="knowledge_items")


class Output(Base):
    """Key-value outputs from pipeline runs."""

    __tablename__ = "outputs"
    __table_args__ = (Index("idx_outputs_run", "run_id"),)

    run_id: Mapped[str] = mapped_column(
        String(64), ForeignKey("runs.id"), primary_key=True
    )
    step_id: Mapped[str] = mapped_column(String(64), nullable=False)
    key: Mapped[str] = mapped_column(String(256), primary_key=True)
    value: Mapped[str] = mapped_column(Text, nullable=False)

    # Relationships
    run: Mapped["Run"] = relationship(back_populates="output_items")
