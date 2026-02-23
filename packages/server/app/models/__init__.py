"""SQLAlchemy ORM models for DjinnBot."""

import importlib.util
import os

# Dynamically load Pydantic models from app/models.py file
# This maintains backward compatibility for imports like: from app.models import PipelineResponse
_models_file = os.path.join(os.path.dirname(os.path.dirname(__file__)), "models.py")
spec = importlib.util.spec_from_file_location("app.models_file", _models_file)
_pydantic_models = importlib.util.module_from_spec(spec)
spec.loader.exec_module(_pydantic_models)

# Re-export Pydantic models
PipelineResponse = _pydantic_models.PipelineResponse
ErrorResponse = _pydantic_models.ErrorResponse
ProjectAgentRole = _pydantic_models.ProjectAgentRole
ProjectAgent = _pydantic_models.ProjectAgent
AssignAgentRequest = _pydantic_models.AssignAgentRequest
UpdateAgentRoleRequest = _pydantic_models.UpdateAgentRoleRequest
ProjectCreate = _pydantic_models.ProjectCreate
ProjectResponse = _pydantic_models.ProjectResponse

# Import SQLAlchemy models
from app.models.base import (
    Base,
    TimestampMixin,
    TimestampWithCompletedMixin,
    PrefixedIdMixin,
    AutoIncrementIdMixin,
    generate_prefixed_id,
    now_ms,
)
from app.models.run import Run, Step
from app.models.session import Session, SessionEvent
from app.models.project import (
    Project,
    KanbanColumn,
    Task,
    DependencyEdge,
    ProjectWorkflow,
    TaskRun,
    OnboardingSession,
    OnboardingMessage,
)
from app.models.agent import ProjectAgent as ProjectAgentModel
from app.models.github import (
    GitHubAppConfig,
    WebhookEvent,
    WebhookSecret,
    ProjectGitHub,
    GitHubInstallationState,
    ProjectGitHubAgent,
    GitHubAgentTrigger,
)
from app.models.session import Session, SessionEvent
from app.models.chat import ChatSession, ChatMessage, ChatAttachment
from app.models.settings import ModelProvider, GlobalSetting, AgentChannelCredential
from app.models.skill import Skill, AgentSkill
from app.models.secret import Secret, AgentSecretGrant
from app.models.mcp import McpServer, AgentMcpTool
from app.models.auth import User, UserRecoveryCode, OIDCProvider, APIKey, UserSession
from app.models.user_provider import (
    UserModelProvider,
    AdminSharedProvider,
    UserSecretGrant,
)
from app.models.waitlist import WaitlistEntry, EmailSettings
from app.models.pulse_routine import PulseRoutine
from app.models.admin_notification import AdminNotification
from app.models.agent_tool_override import AgentToolOverride
from app.models.memory_score import MemoryRetrievalLog, MemoryScore

__all__ = [
    # Pydantic models (backward compatibility)
    "PipelineResponse",
    "ErrorResponse",
    "ProjectAgentRole",
    "ProjectAgent",
    "AssignAgentRequest",
    "UpdateAgentRoleRequest",
    "ProjectCreate",
    "ProjectResponse",
    # SQLAlchemy base
    "Base",
    "TimestampMixin",
    "TimestampWithCompletedMixin",
    "PrefixedIdMixin",
    "AutoIncrementIdMixin",
    "generate_prefixed_id",
    "now_ms",
    # SQLAlchemy models
    "Run",
    "Step",
    "Session",
    "SessionEvent",
    "Project",
    "KanbanColumn",
    "Task",
    "DependencyEdge",
    "ProjectWorkflow",
    "TaskRun",
    "ProjectAgentModel",
    "GitHubAppConfig",
    "WebhookEvent",
    "WebhookSecret",
    "ProjectGitHub",
    "GitHubInstallationState",
    "ProjectGitHubAgent",
    "GitHubAgentTrigger",
    "ChatSession",
    "ChatMessage",
    "ChatAttachment",
    "OnboardingSession",
    "OnboardingMessage",
    "ModelProvider",
    "GlobalSetting",
    "AgentChannelCredential",
    "Skill",
    "AgentSkill",
    "Secret",
    "AgentSecretGrant",
    "McpServer",
    "AgentMcpTool",
    # Auth models
    "User",
    "UserRecoveryCode",
    "OIDCProvider",
    "APIKey",
    "UserSession",
    # Multi-user models
    "UserModelProvider",
    "AdminSharedProvider",
    "UserSecretGrant",
    # Waitlist
    "WaitlistEntry",
    "EmailSettings",
    # Pulse routines
    "PulseRoutine",
    # Admin notifications
    "AdminNotification",
    # Built-in tool overrides
    "AgentToolOverride",
    # Memory scoring
    "MemoryRetrievalLog",
    "MemoryScore",
]
