from pydantic import BaseModel, field_validator
from typing import Any, Optional, Literal
from enum import Enum

from app.git_utils import validate_git_url, normalize_git_url


class PipelineResponse(BaseModel):
    """Response model for pipeline data."""
    id: str
    name: str
    description: str | None = None
    version: str | None = None
    steps: list[Any] = []
    agents: list[Any] = []


class ErrorResponse(BaseModel):
    """Response model for errors."""
    error: str
    detail: str | None = None


class ProjectAgentRole(str, Enum):
    """Roles for agents assigned to projects."""
    LEAD = "lead"
    MEMBER = "member"
    REVIEWER = "reviewer"


class ProjectAgent(BaseModel):
    """Model for project-agent assignment."""
    project_id: str
    agent_id: str
    role: ProjectAgentRole
    assigned_at: int
    assigned_by: Optional[str] = None


class AssignAgentRequest(BaseModel):
    """Request to assign an agent to a project."""
    agentId: str
    role: Literal["lead", "member", "reviewer"] = "member"


class UpdateAgentRoleRequest(BaseModel):
    """Request to update an agent's role on a project."""
    role: Literal["lead", "member", "reviewer"]


class ProjectCreate(BaseModel):
    """Model for creating a new project."""
    name: str
    description: str = ""
    repo_url: Optional[str] = None
    
    @field_validator('repo_url')
    @classmethod
    def validate_repo_url(cls, v: Optional[str]) -> Optional[str]:
        """Validate and normalize repository URL."""
        if v is None:
            return None
        is_valid, error = validate_git_url(v)
        if not is_valid:
            raise ValueError(error or "Invalid repository URL")
        return normalize_git_url(v)


class ProjectResponse(BaseModel):
    """Model for project response data."""
    id: str
    name: str
    description: str = ""
    status: str = "active"
    repo_url: Optional[str] = None
    default_pipeline_id: Optional[str] = None
    created_at: int
    updated_at: int
    completed_at: Optional[int] = None
