"""Project and task management models."""

from typing import Optional
from sqlalchemy import (
    String,
    Text,
    Integer,
    BigInteger,
    Float,
    ForeignKey,
    Index,
    UniqueConstraint,
    JSON,
)
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.models.base import Base, TimestampWithCompletedMixin, TimestampMixin


class Project(Base, TimestampWithCompletedMixin):
    """Project entity."""

    __tablename__ = "projects"

    id: Mapped[str] = mapped_column(String(64), primary_key=True)
    name: Mapped[str] = mapped_column(String(256), nullable=False)
    description: Mapped[str] = mapped_column(Text, nullable=False, default="")
    status: Mapped[str] = mapped_column(String(32), nullable=False, default="active")
    repository: Mapped[Optional[str]] = mapped_column(Text, nullable=True)
    default_pipeline_id: Mapped[Optional[str]] = mapped_column(
        String(128), nullable=True
    )
    # JSON blob — accumulated context from agent-guided onboarding interview.
    # Structured as: { project_name, goal, repo, open_source, strategy, tech, scope, ... }
    onboarding_context: Mapped[Optional[str]] = mapped_column(Text, nullable=True)
    # Slack notification settings — where pipeline run updates are posted.
    # slack_channel_id: Slack channel ID (e.g. C0123456789) for run threads.
    # slack_notify_user_id: Slack user ID (e.g. U0123456789) set as recipient
    #   for chatStream (required for channel-thread streaming).
    slack_channel_id: Mapped[Optional[str]] = mapped_column(String(64), nullable=True)
    slack_notify_user_id: Mapped[Optional[str]] = mapped_column(
        String(64), nullable=True
    )
    # Project vision — a living markdown document that describes the project's
    # goals, architecture, constraints, and current priorities.  Editable by users
    # at any time in the dashboard; agents read it before starting work via
    # the get_project_vision tool.
    vision: Mapped[Optional[str]] = mapped_column(Text, nullable=True)
    # Template this project was created from (null for legacy projects).
    template_id: Mapped[Optional[str]] = mapped_column(
        String(64),
        ForeignKey("project_templates.id", ondelete="SET NULL"),
        nullable=True,
    )
    # Status semantics — copied from template at creation, editable per project.
    # Tells the engine which statuses have special meaning.
    # {
    #   "initial": ["backlog"],
    #   "terminal_done": ["done"],
    #   "terminal_fail": ["failed"],
    #   "blocked": ["blocked"],
    #   "in_progress": ["in_progress"],
    #   "claimable": ["backlog", "ready", "planning"],
    # }
    # When NULL, falls back to the legacy hardcoded semantics for backward compat.
    status_semantics: Mapped[Optional[dict]] = mapped_column(JSON, nullable=True)
    # Multi-user: DjinnBot user whose API keys are used for automated runs
    # (pipeline steps, pulse sessions) in this project. When NULL, the system
    # falls back to instance-level keys.
    key_user_id: Mapped[Optional[str]] = mapped_column(
        String(64), ForeignKey("users.id", ondelete="SET NULL"), nullable=True
    )

    # Relationships
    columns: Mapped[list["KanbanColumn"]] = relationship(
        back_populates="project", cascade="all, delete-orphan"
    )
    tasks: Mapped[list["Task"]] = relationship(
        back_populates="project", cascade="all, delete-orphan"
    )
    dependency_edges: Mapped[list["DependencyEdge"]] = relationship(
        back_populates="project", cascade="all, delete-orphan"
    )
    workflows: Mapped[list["ProjectWorkflow"]] = relationship(
        back_populates="project", cascade="all, delete-orphan"
    )
    agents: Mapped[list["ProjectAgent"]] = relationship(
        back_populates="project", cascade="all, delete-orphan"
    )
    github_connection: Mapped[Optional["ProjectGitHub"]] = relationship(
        back_populates="project", cascade="all, delete-orphan", uselist=False
    )


class KanbanColumn(Base):
    """Kanban board column."""

    __tablename__ = "kanban_columns"
    __table_args__ = (Index("idx_kanban_project", "project_id"),)

    id: Mapped[str] = mapped_column(String(64), primary_key=True)
    project_id: Mapped[str] = mapped_column(
        String(64), ForeignKey("projects.id", ondelete="CASCADE"), nullable=False
    )
    name: Mapped[str] = mapped_column(String(128), nullable=False)
    position: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    wip_limit: Mapped[Optional[int]] = mapped_column(Integer, nullable=True)
    task_statuses: Mapped[str] = mapped_column(
        Text, nullable=False, default="[]"
    )  # JSON array

    # Relationships
    project: Mapped["Project"] = relationship(back_populates="columns")
    tasks: Mapped[list["Task"]] = relationship(back_populates="column")


class Task(Base, TimestampWithCompletedMixin):
    """Task entity."""

    __tablename__ = "tasks"
    __table_args__ = (
        Index("idx_tasks_project", "project_id"),
        Index("idx_tasks_status", "status"),
        Index("idx_tasks_column", "column_id"),
    )

    id: Mapped[str] = mapped_column(String(64), primary_key=True)
    project_id: Mapped[str] = mapped_column(
        String(64), ForeignKey("projects.id", ondelete="CASCADE"), nullable=False
    )
    title: Mapped[str] = mapped_column(String(512), nullable=False)
    description: Mapped[str] = mapped_column(Text, nullable=False, default="")
    status: Mapped[str] = mapped_column(String(32), nullable=False, default="backlog")
    priority: Mapped[str] = mapped_column(String(8), nullable=False, default="P2")
    assigned_agent: Mapped[Optional[str]] = mapped_column(String(128), nullable=True)
    workflow_id: Mapped[Optional[str]] = mapped_column(String(64), nullable=True)
    pipeline_id: Mapped[Optional[str]] = mapped_column(String(128), nullable=True)
    run_id: Mapped[Optional[str]] = mapped_column(String(64), nullable=True)
    parent_task_id: Mapped[Optional[str]] = mapped_column(String(64), nullable=True)
    tags: Mapped[str] = mapped_column(Text, nullable=False, default="[]")  # JSON array
    estimated_hours: Mapped[Optional[float]] = mapped_column(Float, nullable=True)
    column_id: Mapped[str] = mapped_column(
        String(64), ForeignKey("kanban_columns.id"), nullable=False
    )
    column_position: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    task_metadata: Mapped[str] = mapped_column(
        "metadata", Text, nullable=False, default="{}"
    )  # JSON object
    # Two-stage review tracking (spec compliance + code quality)
    spec_review_status: Mapped[Optional[str]] = mapped_column(
        String(32), nullable=True
    )  # pending | passed | failed | skipped
    quality_review_status: Mapped[Optional[str]] = mapped_column(
        String(32), nullable=True
    )  # pending | passed | failed | skipped
    spec_review_notes: Mapped[Optional[str]] = mapped_column(Text, nullable=True)
    quality_review_notes: Mapped[Optional[str]] = mapped_column(Text, nullable=True)

    # Relationships
    project: Mapped["Project"] = relationship(back_populates="tasks")
    column: Mapped["KanbanColumn"] = relationship(back_populates="tasks")
    task_runs: Mapped[list["TaskRun"]] = relationship(
        back_populates="task", cascade="all, delete-orphan"
    )


class DependencyEdge(Base):
    """Task dependency edge."""

    __tablename__ = "dependency_edges"
    __table_args__ = (
        Index("idx_deps_project", "project_id"),
        Index("idx_deps_from", "from_task_id"),
        Index("idx_deps_to", "to_task_id"),
        UniqueConstraint("from_task_id", "to_task_id", name="uq_dependency_edge"),
    )

    id: Mapped[str] = mapped_column(String(64), primary_key=True)
    project_id: Mapped[str] = mapped_column(
        String(64), ForeignKey("projects.id", ondelete="CASCADE"), nullable=False
    )
    from_task_id: Mapped[str] = mapped_column(
        String(64), ForeignKey("tasks.id", ondelete="CASCADE"), nullable=False
    )
    to_task_id: Mapped[str] = mapped_column(
        String(64), ForeignKey("tasks.id", ondelete="CASCADE"), nullable=False
    )
    type: Mapped[str] = mapped_column(String(32), nullable=False, default="blocks")

    # Relationships
    project: Mapped["Project"] = relationship(back_populates="dependency_edges")


class ProjectWorkflow(Base):
    """Project workflow definition."""

    __tablename__ = "project_workflows"
    __table_args__ = (Index("idx_workflows_project", "project_id"),)

    id: Mapped[str] = mapped_column(String(64), primary_key=True)
    project_id: Mapped[str] = mapped_column(
        String(64), ForeignKey("projects.id", ondelete="CASCADE"), nullable=False
    )
    name: Mapped[str] = mapped_column(String(256), nullable=False)
    pipeline_id: Mapped[str] = mapped_column(String(128), nullable=False)
    is_default: Mapped[int] = mapped_column(
        Integer, nullable=False, default=0
    )  # SQLite bool
    task_filter: Mapped[str] = mapped_column(Text, nullable=False, default="{}")  # JSON
    trigger: Mapped[str] = mapped_column(String(64), nullable=False, default="manual")

    # Relationships
    project: Mapped["Project"] = relationship(back_populates="workflows")


class TaskRun(Base):
    """Task execution history."""

    __tablename__ = "task_runs"
    __table_args__ = (Index("idx_task_runs_task", "task_id"),)

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    task_id: Mapped[str] = mapped_column(
        String(64), ForeignKey("tasks.id", ondelete="CASCADE"), nullable=False
    )
    run_id: Mapped[str] = mapped_column(String(64), nullable=False)
    pipeline_id: Mapped[str] = mapped_column(String(128), nullable=False)
    status: Mapped[str] = mapped_column(String(32), nullable=False, default="pending")
    started_at: Mapped[Optional[int]] = mapped_column(BigInteger, nullable=True)
    completed_at: Mapped[Optional[int]] = mapped_column(BigInteger, nullable=True)

    # Relationships
    task: Mapped["Task"] = relationship(back_populates="task_runs")


class OnboardingSession(Base):
    """Multi-agent onboarding session for guided project creation.

    Tracks the full state of an agent-guided project creation interview,
    including current agent, accumulated context, and message history.
    """

    __tablename__ = "onboarding_sessions"
    __table_args__ = (
        Index("idx_onboarding_sessions_status", "status"),
        Index("idx_onboarding_sessions_project", "project_id"),
    )

    id: Mapped[str] = mapped_column(String(64), primary_key=True)
    status: Mapped[str] = mapped_column(String(32), nullable=False, default="active")
    # The project this session is creating (null until finalized)
    project_id: Mapped[Optional[str]] = mapped_column(String(64), nullable=True)
    # Which agent is currently talking to the user
    current_agent_id: Mapped[str] = mapped_column(String(128), nullable=False)
    # Phase: intake | strategy | product | done
    phase: Mapped[str] = mapped_column(String(32), nullable=False, default="intake")
    # JSON blob — accumulated context from all agents (project_name, goal, repo, etc.)
    context: Mapped[str] = mapped_column(Text, nullable=False, default="{}")
    # The underlying chat session ID for the current agent container
    chat_session_id: Mapped[Optional[str]] = mapped_column(String(128), nullable=True)
    # Template to use when creating the project (null = legacy software-dev default)
    template_id: Mapped[Optional[str]] = mapped_column(String(64), nullable=True)
    # Model used for this onboarding session
    model: Mapped[str] = mapped_column(
        String(128), nullable=False, default="openrouter/anthropic/claude-sonnet-4-5"
    )
    # JSON blob storing the evolving landing page built collaboratively
    # by agents throughout the onboarding process:
    # { "html": "<!DOCTYPE html>...", "caption": "...", "last_agent_id": "stas", "version": 3 }
    landing_page_state: Mapped[Optional[str]] = mapped_column(Text, nullable=True)

    created_at: Mapped[int] = mapped_column(BigInteger, nullable=False)
    updated_at: Mapped[int] = mapped_column(BigInteger, nullable=False)
    completed_at: Mapped[Optional[int]] = mapped_column(BigInteger, nullable=True)

    # Relationships
    messages: Mapped[list["OnboardingMessage"]] = relationship(
        back_populates="session",
        cascade="all, delete-orphan",
        order_by="OnboardingMessage.created_at",
    )


class OnboardingMessage(Base):
    """Individual message in an onboarding conversation.

    Records all messages (user and agent) across all agent handoffs,
    maintaining a single continuous transcript even as agents change.
    """

    __tablename__ = "onboarding_messages"
    __table_args__ = (
        Index("idx_onboarding_messages_session_created", "session_id", "created_at"),
    )

    id: Mapped[str] = mapped_column(String(64), primary_key=True)
    session_id: Mapped[str] = mapped_column(
        String(64),
        ForeignKey("onboarding_sessions.id", ondelete="CASCADE"),
        nullable=False,
    )
    role: Mapped[str] = mapped_column(
        String(16), nullable=False
    )  # user | assistant | system
    content: Mapped[str] = mapped_column(Text, nullable=False)
    # Which agent produced this message (null for user messages)
    agent_id: Mapped[Optional[str]] = mapped_column(String(128), nullable=True)
    agent_name: Mapped[Optional[str]] = mapped_column(String(128), nullable=True)
    agent_emoji: Mapped[Optional[str]] = mapped_column(String(16), nullable=True)
    # JSON array of tool calls, same format as chat_messages
    tool_calls: Mapped[Optional[str]] = mapped_column(Text, nullable=True)
    thinking: Mapped[Optional[str]] = mapped_column(Text, nullable=True)
    # If this message triggered a handoff, record where to
    handoff_to_agent: Mapped[Optional[str]] = mapped_column(String(128), nullable=True)
    created_at: Mapped[int] = mapped_column(BigInteger, nullable=False)

    # Relationships
    session: Mapped["OnboardingSession"] = relationship(back_populates="messages")


# Import here to avoid circular imports
from app.models.agent import ProjectAgent
from app.models.github import ProjectGitHub
