"""GitHub integration models."""
from typing import Optional
from sqlalchemy import String, Text, Integer, BigInteger, ForeignKey, Index, UniqueConstraint
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.models.base import Base, TimestampMixin


class GitHubAppConfig(Base, TimestampMixin):
    """GitHub App configuration."""
    __tablename__ = "github_app_config"
    __table_args__ = (
        Index("idx_github_app_config_app_id", "app_id"),
    )
    
    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    app_id: Mapped[int] = mapped_column(Integer, nullable=False, unique=True)
    app_name: Mapped[str] = mapped_column(String(128), nullable=False)
    client_id: Mapped[str] = mapped_column(String(128), nullable=False)
    webhook_secret: Mapped[str] = mapped_column(String(256), nullable=False)
    private_key_path: Mapped[str] = mapped_column(String(512), nullable=False)


class WebhookEvent(Base):
    """GitHub webhook event log."""
    __tablename__ = "webhook_events"
    __table_args__ = (
        Index("idx_webhook_delivery", "delivery_id"),
        Index("idx_webhook_event_type", "event_type", "action"),
        Index("idx_webhook_repo", "repository_full_name"),
        Index("idx_webhook_processed", "processed", "received_at"),
    )
    
    id: Mapped[str] = mapped_column(String(64), primary_key=True)
    delivery_id: Mapped[str] = mapped_column(String(64), nullable=False, unique=True)
    event_type: Mapped[str] = mapped_column(String(64), nullable=False)
    action: Mapped[Optional[str]] = mapped_column(String(64), nullable=True)
    installation_id: Mapped[Optional[str]] = mapped_column(String(64), nullable=True)
    repository_full_name: Mapped[Optional[str]] = mapped_column(String(256), nullable=True)
    repository_id: Mapped[Optional[int]] = mapped_column(Integer, nullable=True)
    sender_login: Mapped[Optional[str]] = mapped_column(String(128), nullable=True)
    payload: Mapped[str] = mapped_column(Text, nullable=False)
    signature: Mapped[str] = mapped_column(String(256), nullable=False)
    verified: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    processed: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    processing_error: Mapped[Optional[str]] = mapped_column(Text, nullable=True)
    received_at: Mapped[int] = mapped_column(BigInteger, nullable=False)
    processed_at: Mapped[Optional[int]] = mapped_column(BigInteger, nullable=True)


class WebhookSecret(Base, TimestampMixin):
    """Webhook secrets per installation."""
    __tablename__ = "webhook_secrets"
    
    id: Mapped[str] = mapped_column(String(64), primary_key=True)
    installation_id: Mapped[Optional[str]] = mapped_column(String(64), nullable=True, unique=True)
    secret_hash: Mapped[str] = mapped_column(String(256), nullable=False)
    last_used_at: Mapped[Optional[int]] = mapped_column(BigInteger, nullable=True)


class ProjectGitHub(Base):
    """Project-GitHub repository connection."""
    __tablename__ = "project_github"
    __table_args__ = (
        Index("idx_project_github_project", "project_id"),
        Index("idx_project_github_installation", "installation_id"),
        Index("idx_project_github_repo", "repo_full_name"),
        Index("idx_project_github_active", "is_active"),
    )
    
    id: Mapped[str] = mapped_column(String(64), primary_key=True)
    project_id: Mapped[str] = mapped_column(String(64), ForeignKey("projects.id", ondelete="CASCADE"), nullable=False, unique=True)
    installation_id: Mapped[int] = mapped_column(Integer, nullable=False)
    repo_owner: Mapped[str] = mapped_column(String(128), nullable=False)
    repo_name: Mapped[str] = mapped_column(String(256), nullable=False)
    repo_full_name: Mapped[str] = mapped_column(String(384), nullable=False)
    default_branch: Mapped[str] = mapped_column(String(128), nullable=False, default="main")
    connected_at: Mapped[int] = mapped_column(BigInteger, nullable=False)
    connected_by: Mapped[Optional[str]] = mapped_column(String(128), nullable=True)
    last_push_at: Mapped[Optional[int]] = mapped_column(BigInteger, nullable=True)
    last_sync_at: Mapped[Optional[int]] = mapped_column(BigInteger, nullable=True)
    is_active: Mapped[int] = mapped_column(Integer, nullable=False, default=1)
    github_metadata: Mapped[str] = mapped_column(String(512), nullable=False, default="{}")
    
    # Relationships
    project: Mapped["Project"] = relationship(back_populates="github_connection")


class GitHubInstallationState(Base):
    """OAuth CSRF state tokens."""
    __tablename__ = "github_installation_states"
    __table_args__ = (
        Index("idx_github_states_token", "state_token"),
        Index("idx_github_states_expires", "expires_at"),
        Index("idx_github_states_project", "project_id"),
    )
    
    id: Mapped[str] = mapped_column(String(64), primary_key=True)
    state_token: Mapped[str] = mapped_column(String(128), nullable=False, unique=True)
    project_id: Mapped[str] = mapped_column(String(64), ForeignKey("projects.id", ondelete="CASCADE"), nullable=False)
    user_id: Mapped[str] = mapped_column(String(128), nullable=False)
    created_at: Mapped[int] = mapped_column(BigInteger, nullable=False)
    expires_at: Mapped[int] = mapped_column(BigInteger, nullable=False)
    used: Mapped[int] = mapped_column(Integer, nullable=False, default=0)


class ProjectGitHubAgent(Base, TimestampMixin):
    """GitHub event to agent assignment."""
    __tablename__ = "project_github_agents"
    __table_args__ = (
        Index("idx_github_agent_project", "project_id"),
        Index("idx_github_agent_event", "event_type", "event_action"),
    )
    
    id: Mapped[str] = mapped_column(String(64), primary_key=True)
    project_id: Mapped[str] = mapped_column(String(64), ForeignKey("projects.id", ondelete="CASCADE"), nullable=False)
    agent_id: Mapped[str] = mapped_column(String(128), nullable=False)
    event_type: Mapped[str] = mapped_column(String(64), nullable=False)
    event_action: Mapped[Optional[str]] = mapped_column(String(64), nullable=True)
    filter_labels: Mapped[Optional[str]] = mapped_column(Text, nullable=True)  # JSON
    filter_file_patterns: Mapped[Optional[str]] = mapped_column(Text, nullable=True)  # JSON
    filter_authors: Mapped[Optional[str]] = mapped_column(Text, nullable=True)  # JSON
    auto_respond: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    created_by: Mapped[Optional[str]] = mapped_column(String(128), nullable=True)


class GitHubAgentTrigger(Base):
    """Audit log of agent triggers from GitHub events."""
    __tablename__ = "github_agent_triggers"
    __table_args__ = (
        Index("idx_trigger_webhook", "webhook_event_id"),
        Index("idx_trigger_task", "task_id"),
        Index("idx_trigger_status", "status"),
        Index("idx_trigger_project", "project_id"),
    )
    
    id: Mapped[str] = mapped_column(String(64), primary_key=True)
    agent_assignment_id: Mapped[str] = mapped_column(String(64), ForeignKey("project_github_agents.id", ondelete="CASCADE"), nullable=False)
    webhook_event_id: Mapped[str] = mapped_column(String(64), ForeignKey("webhook_events.id"), nullable=False)
    project_id: Mapped[str] = mapped_column(String(64), nullable=False)
    agent_id: Mapped[str] = mapped_column(String(128), nullable=False)
    event_type: Mapped[str] = mapped_column(String(64), nullable=False)
    event_action: Mapped[Optional[str]] = mapped_column(String(64), nullable=True)
    repository_full_name: Mapped[Optional[str]] = mapped_column(String(384), nullable=True)
    trigger_reason: Mapped[Optional[str]] = mapped_column(Text, nullable=True)
    task_id: Mapped[Optional[str]] = mapped_column(String(64), ForeignKey("tasks.id"), nullable=True)
    session_id: Mapped[Optional[str]] = mapped_column(String(128), nullable=True)
    status: Mapped[str] = mapped_column(String(32), nullable=False, default="pending")
    triggered_at: Mapped[int] = mapped_column(BigInteger, nullable=False)
    completed_at: Mapped[Optional[int]] = mapped_column(BigInteger, nullable=True)


# Avoid circular import
from app.models.project import Project
