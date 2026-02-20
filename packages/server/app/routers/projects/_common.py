"""Shared utilities, models, and helpers for project routers."""

from __future__ import annotations

import json
import os
import uuid
from typing import Optional, Literal

from fastapi import APIRouter, HTTPException, Query, Depends
from pydantic import BaseModel, field_validator
from sqlalchemy import select, update, delete, func, and_, or_
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import selectinload

from app.database import get_async_session
from app.logging_config import get_logger
from app.models import (
    Project,
    Task,
    KanbanColumn,
    DependencyEdge,
    ProjectWorkflow,
    TaskRun,
)
from app.models.agent import ProjectAgent as ProjectAgentModel
from app.schemas import AssignAgentRequest, UpdateAgentRoleRequest
from app import dependencies
from app.utils import now_ms, gen_id
from app.git_utils import (
    validate_git_url,
    normalize_git_url,
    validate_repo_access,
    get_remote_branches,
)

logger = get_logger(__name__)

__all__ = [
    # Router
    "router",
    # Logger
    "logger",
    # Pydantic Models
    "CreateProjectRequest",
    "UpdateProjectRequest",
    "CreateTaskRequest",
    "UpdateTaskRequest",
    "MoveTaskRequest",
    "AddDependencyRequest",
    "CreateColumnRequest",
    "UpdateColumnRequest",
    "CreateWorkflowRequest",
    "UpdateWorkflowRequest",
    "BulkImportTasksRequest",
    "PlanProjectRequest",
    "SetRepositoryRequest",
    "ValidateRepositoryRequest",
    # Constants
    "DEFAULT_COLUMNS",
    # Helper functions
    "get_project_or_404",
    "get_task_or_404",
    "_serialize_task",
    "_serialize_column",
    "_serialize_workflow",
    "_publish_event",
    "_validate_pipeline_exists",
]

router = APIRouter()


# ══════════════════════════════════════════════════════════════════════════
# PYDANTIC MODELS
# ══════════════════════════════════════════════════════════════════════════


class CreateProjectRequest(BaseModel):
    name: str
    description: str = ""
    repository: Optional[str] = None

    @field_validator("repository")
    @classmethod
    def validate_repository(cls, v: Optional[str]) -> Optional[str]:
        """Validate and normalize repository URL."""
        if v is None:
            return None
        is_valid, error = validate_git_url(v)
        if not is_valid:
            raise ValueError(error or "Invalid repository URL")
        return normalize_git_url(v)


class UpdateProjectRequest(BaseModel):
    name: Optional[str] = None
    description: Optional[str] = None
    status: Optional[Literal["active", "completed", "archived", "paused"]] = None
    repository: Optional[str] = None
    defaultPipelineId: Optional[str] = None

    @field_validator("repository")
    @classmethod
    def validate_repository(cls, v: Optional[str]) -> Optional[str]:
        """Validate and normalize repository URL."""
        if v is None:
            return None
        is_valid, error = validate_git_url(v)
        if not is_valid:
            raise ValueError(error or "Invalid repository URL")
        return normalize_git_url(v)


class CreateTaskRequest(BaseModel):
    title: str
    description: str = ""
    priority: Literal["P0", "P1", "P2", "P3"] = "P2"
    assignedAgent: Optional[str] = None
    workflowId: Optional[str] = None
    parentTaskId: Optional[str] = None
    tags: list[str] = []
    estimatedHours: Optional[float] = None
    columnId: Optional[str] = None  # if not provided, use first column (backlog)
    metadata: dict = {}


class UpdateTaskRequest(BaseModel):
    title: Optional[str] = None
    description: Optional[str] = None
    status: Optional[
        Literal[
            "backlog",
            "planning",
            "ready",
            "in_progress",
            "review",
            "blocked",
            "done",
            "failed",
        ]
    ] = None
    priority: Optional[Literal["P0", "P1", "P2", "P3"]] = None
    assignedAgent: Optional[str] = None
    workflowId: Optional[str] = None
    tags: Optional[list[str]] = None
    estimatedHours: Optional[float] = None
    metadata: Optional[dict] = None


class MoveTaskRequest(BaseModel):
    columnId: str
    position: int = 0


class AddDependencyRequest(BaseModel):
    fromTaskId: str
    type: Literal["blocks", "informs"] = "blocks"


class CreateColumnRequest(BaseModel):
    name: str
    position: Optional[int] = None
    wipLimit: Optional[int] = None
    taskStatuses: list[str] = []


class UpdateColumnRequest(BaseModel):
    name: Optional[str] = None
    position: Optional[int] = None
    wipLimit: Optional[int] = None
    taskStatuses: Optional[list[str]] = None


class CreateWorkflowRequest(BaseModel):
    name: str
    pipelineId: str
    isDefault: bool = False
    taskFilter: dict = {}
    trigger: str = "manual"


class UpdateWorkflowRequest(BaseModel):
    name: Optional[str] = None
    pipelineId: Optional[str] = None
    isDefault: Optional[bool] = None
    taskFilter: Optional[dict] = None
    trigger: Optional[str] = None


class BulkImportTasksRequest(BaseModel):
    tasks: list[
        dict
    ]  # [{title, description, priority, tags, dependencies: [title-ref], subtasks: [...]}]


class PlanProjectRequest(BaseModel):
    pipelineId: str = "planning"  # Which pipeline to use for planning
    context: Optional[str] = None  # Additional context for the planner


class SetRepositoryRequest(BaseModel):
    repoUrl: str
    validateAccess: bool = True  # Test connectivity before saving


class ValidateRepositoryRequest(BaseModel):
    repoUrl: str


# ══════════════════════════════════════════════════════════════════════════
# CONSTANTS
# ══════════════════════════════════════════════════════════════════════════

DEFAULT_COLUMNS = [
    {
        "name": "Backlog",
        "position": 0,
        "wip_limit": None,
        "task_statuses": ["backlog"],
    },
    {
        "name": "Planning",
        "position": 1,
        "wip_limit": None,
        "task_statuses": ["planning"],
    },
    {
        "name": "Blocked",
        "position": 2,
        "wip_limit": None,
        "task_statuses": ["blocked"],
    },
    {
        "name": "Ready",
        "position": 3,
        "wip_limit": None,
        "task_statuses": ["ready"],
    },
    {
        "name": "In Progress",
        "position": 4,
        "wip_limit": 5,
        "task_statuses": ["in_progress"],
    },
    {
        "name": "Review",
        "position": 5,
        "wip_limit": None,
        "task_statuses": ["review"],
    },
    {
        "name": "Done",
        "position": 6,
        "wip_limit": None,
        "task_statuses": ["done"],
    },
    {
        "name": "Failed",
        "position": 7,
        "wip_limit": None,
        "task_statuses": ["failed"],
    },
]


# ══════════════════════════════════════════════════════════════════════════
# HELPER FUNCTIONS
# ══════════════════════════════════════════════════════════════════════════


async def get_project_or_404(session: AsyncSession, project_id: str) -> Project:
    """Get project by ID or raise 404."""
    result = await session.execute(select(Project).where(Project.id == project_id))
    project = result.scalar_one_or_none()
    if not project:
        raise HTTPException(status_code=404, detail=f"Project {project_id} not found")
    return project


async def get_task_or_404(session: AsyncSession, project_id: str, task_id: str) -> Task:
    """Get task by ID within project or raise 404."""
    result = await session.execute(
        select(Task).where(Task.id == task_id, Task.project_id == project_id)
    )
    task = result.scalar_one_or_none()
    if not task:
        raise HTTPException(status_code=404, detail=f"Task {task_id} not found")
    return task


def _serialize_task(task: Task) -> dict:
    """Serialize a Task model to dict."""
    return {
        "id": task.id,
        "project_id": task.project_id,
        "title": task.title,
        "description": task.description,
        "status": task.status,
        "priority": task.priority,
        "assigned_agent": task.assigned_agent,
        "workflow_id": task.workflow_id,
        "pipeline_id": task.pipeline_id,
        "run_id": task.run_id,
        "parent_task_id": task.parent_task_id,
        "tags": json.loads(task.tags) if task.tags else [],
        "estimated_hours": task.estimated_hours,
        "column_id": task.column_id,
        "column_position": task.column_position,
        "metadata": json.loads(task.task_metadata) if task.task_metadata else {},
        "created_at": task.created_at,
        "updated_at": task.updated_at,
        "completed_at": task.completed_at,
    }


def _serialize_column(col: KanbanColumn) -> dict:
    """Serialize a KanbanColumn model to dict."""
    return {
        "id": col.id,
        "project_id": col.project_id,
        "name": col.name,
        "position": col.position,
        "wip_limit": col.wip_limit,
        "task_statuses": json.loads(col.task_statuses) if col.task_statuses else [],
    }


def _serialize_workflow(wf: ProjectWorkflow) -> dict:
    """Serialize a ProjectWorkflow model to dict."""
    return {
        "id": wf.id,
        "project_id": wf.project_id,
        "name": wf.name,
        "pipeline_id": wf.pipeline_id,
        "is_default": bool(wf.is_default),
        "task_filter": json.loads(wf.task_filter) if wf.task_filter else {},
        "trigger": wf.trigger,
    }


async def _publish_event(event_type: str, data: dict):
    """Publish event to global stream for real-time dashboard updates."""
    if dependencies.redis_client:
        try:
            logger.debug(f"Publishing Redis event: type={event_type}")
            event = {"type": event_type, **data, "timestamp": now_ms()}
            await dependencies.redis_client.xadd(
                "djinnbot:events:global", {"data": json.dumps(event)}
            )
        except Exception:
            pass  # Best effort


def _validate_pipeline_exists(pipeline_id: str) -> bool:
    """Validate that a pipeline exists."""
    # Pipeline registry not yet implemented - always return True
    # TODO: Implement pipeline registry
    return True
