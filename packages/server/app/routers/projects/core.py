"""Core project CRUD endpoints."""

import json
from typing import Optional

from fastapi import APIRouter, Depends
from sqlalchemy import select, func
from sqlalchemy.ext.asyncio import AsyncSession

from app.database import get_async_session
from app.models import Project, Task, KanbanColumn
from app.models.project_template import ProjectTemplate
from app.utils import now_ms, gen_id
from app.logging_config import get_logger

from ._common import (
    logger,
    get_project_or_404,
    _serialize_task,
    _serialize_column,
    _publish_event,
    CreateProjectRequest,
    UpdateProjectRequest,
    DEFAULT_COLUMNS,
)

logger = get_logger(__name__)
router = APIRouter()


@router.post("/")
async def create_project(
    req: CreateProjectRequest, session: AsyncSession = Depends(get_async_session)
):
    """Create a new project from a template, custom columns, or legacy defaults.

    Priority:
    1. templateId — load columns + semantics from template
    2. columns + statusSemantics — custom project definition
    3. Neither — fall back to legacy DEFAULT_COLUMNS (software-dev)
    """
    logger.debug(
        f"Creating project: name={req.name}, repository={req.repository}, "
        f"templateId={req.templateId}"
    )
    now = now_ms()

    template_id = None
    status_semantics = None
    columns_to_create = None
    default_pipeline_id = None

    if req.templateId:
        # --- Template-based creation ---
        result = await session.execute(
            select(ProjectTemplate).where(
                (ProjectTemplate.id == req.templateId)
                | (ProjectTemplate.slug == req.templateId)
            )
        )
        template = result.scalar_one_or_none()
        if not template:
            from fastapi import HTTPException

            raise HTTPException(
                status_code=404,
                detail=f"Template '{req.templateId}' not found",
            )

        template_id = template.id
        status_semantics = template.status_semantics
        default_pipeline_id = template.default_pipeline_id

        # Template columns use "statuses" key; convert to DB format "task_statuses"
        columns_to_create = []
        for col_def in template.board_columns:
            columns_to_create.append(
                {
                    "name": col_def["name"],
                    "position": col_def["position"],
                    "wip_limit": col_def.get("wip_limit"),
                    "task_statuses": col_def.get(
                        "statuses", col_def.get("task_statuses", [])
                    ),
                }
            )

    elif req.columns:
        # --- Custom columns ---
        columns_to_create = []
        for col_def in req.columns:
            columns_to_create.append(
                {
                    "name": col_def["name"],
                    "position": col_def["position"],
                    "wip_limit": col_def.get("wip_limit") or col_def.get("wipLimit"),
                    "task_statuses": col_def.get(
                        "statuses", col_def.get("task_statuses", [])
                    ),
                }
            )
        if req.statusSemantics:
            status_semantics = req.statusSemantics
        else:
            # Auto-derive basic semantics from columns
            all_statuses = []
            for c in columns_to_create:
                all_statuses.extend(c["task_statuses"])
            status_semantics = {
                "initial": [all_statuses[0]] if all_statuses else [],
                "terminal_done": [all_statuses[-1]] if all_statuses else [],
                "terminal_fail": [],
                "blocked": [],
                "in_progress": [],
                "claimable": [all_statuses[0]] if all_statuses else [],
            }

    else:
        # --- Legacy fallback ---
        columns_to_create = DEFAULT_COLUMNS

    project = Project(
        id=gen_id("proj_"),
        name=req.name,
        description=req.description,
        status="active",
        repository=req.repository,
        template_id=template_id,
        status_semantics=status_semantics,
        default_pipeline_id=default_pipeline_id,
        created_at=now,
        updated_at=now,
    )
    session.add(project)

    # Create kanban columns
    for col_def in columns_to_create:
        column = KanbanColumn(
            id=gen_id("col_"),
            project_id=project.id,
            name=col_def["name"],
            position=col_def["position"],
            wip_limit=col_def.get("wip_limit"),
            task_statuses=json.dumps(col_def["task_statuses"]),
        )
        session.add(column)

    await session.commit()

    await _publish_event(
        "PROJECT_CREATED", {"projectId": project.id, "name": project.name}
    )

    return {
        "id": project.id,
        "name": project.name,
        "status": "active",
        "template_id": template_id,
        "created_at": now,
    }


@router.get("/")
async def list_projects(
    status: Optional[str] = None, session: AsyncSession = Depends(get_async_session)
):
    """List all projects, optionally filtered by status."""
    logger.debug(f"Listing projects, status_filter={status}")
    query = select(Project)

    if status:
        query = query.where(Project.status == status)
    else:
        query = query.where(Project.status != "archived")

    query = query.order_by(Project.updated_at.desc())

    result = await session.execute(query)
    projects = result.scalars().all()
    logger.debug(f"Found {len(projects)} projects")

    # Get task counts for each project
    response = []
    for p in projects:
        # Subquery for task counts
        count_result = await session.execute(
            select(Task.status, func.count(Task.id))
            .where(Task.project_id == p.id)
            .group_by(Task.status)
        )
        task_counts = {status: count for status, count in count_result.all()}

        response.append(
            {
                "id": p.id,
                "name": p.name,
                "description": p.description,
                "status": p.status,
                "repository": p.repository,
                "default_pipeline_id": p.default_pipeline_id,
                "slack_channel_id": p.slack_channel_id,
                "slack_notify_user_id": p.slack_notify_user_id,
                "created_at": p.created_at,
                "updated_at": p.updated_at,
                "task_counts": task_counts,
                "total_tasks": sum(task_counts.values()),
                "completed_tasks": task_counts.get("done", 0),
            }
        )

    return response


@router.get("/{project_id}")
async def get_project(
    project_id: str, session: AsyncSession = Depends(get_async_session)
):
    """Get project with full board state (columns, tasks, dependencies, workflows, agents)."""
    logger.debug(f"Getting project: project_id={project_id}")
    project = await get_project_or_404(session, project_id)

    # Get columns
    col_result = await session.execute(
        select(KanbanColumn)
        .where(KanbanColumn.project_id == project_id)
        .order_by(KanbanColumn.position)
    )
    columns = col_result.scalars().all()

    # Get all tasks
    task_result = await session.execute(
        select(Task).where(Task.project_id == project_id).order_by(Task.column_position)
    )
    tasks = task_result.scalars().all()

    # Get dependencies
    from app.models import DependencyEdge

    dep_result = await session.execute(
        select(DependencyEdge).where(DependencyEdge.project_id == project_id)
    )
    deps_list = dep_result.scalars().all()

    # Get workflows
    from app.models import ProjectWorkflow

    wf_result = await session.execute(
        select(ProjectWorkflow).where(ProjectWorkflow.project_id == project_id)
    )
    workflows = wf_result.scalars().all()

    # Get assigned agents
    from app.models.agent import ProjectAgent as ProjectAgentModel

    agent_result = await session.execute(
        select(ProjectAgentModel)
        .where(ProjectAgentModel.project_id == project_id)
        .order_by(ProjectAgentModel.role, ProjectAgentModel.assigned_at)
    )
    agents = agent_result.scalars().all()
    logger.debug(
        f"Retrieved project {project_id}: columns={len(columns)}, tasks={len(tasks)}, deps={len(deps_list)}, workflows={len(workflows)}, agents={len(agents)}"
    )

    from ._common import _serialize_workflow

    return {
        "id": project.id,
        "name": project.name,
        "description": project.description,
        "status": project.status,
        "repository": project.repository,
        "default_pipeline_id": project.default_pipeline_id,
        "slack_channel_id": project.slack_channel_id,
        "slack_notify_user_id": project.slack_notify_user_id,
        "template_id": project.template_id,
        "status_semantics": project.status_semantics,
        "key_user_id": project.key_user_id,
        "onboarding_context": project.onboarding_context,
        "vision": project.vision,
        "created_at": project.created_at,
        "updated_at": project.updated_at,
        "completed_at": project.completed_at,
        "columns": [_serialize_column(c) for c in columns],
        "tasks": [_serialize_task(t) for t in tasks],
        "dependencies": [
            {
                "id": d.id,
                "project_id": d.project_id,
                "from_task_id": d.from_task_id,
                "to_task_id": d.to_task_id,
                "type": d.type,
            }
            for d in deps_list
        ],
        "workflows": [_serialize_workflow(w) for w in workflows],
        "agents": [
            {
                "project_id": a.project_id,
                "agent_id": a.agent_id,
                "role": a.role,
                "assigned_at": a.assigned_at,
                "assigned_by": a.assigned_by,
            }
            for a in agents
        ],
    }


@router.put("/{project_id}")
async def update_project(
    project_id: str,
    req: UpdateProjectRequest,
    session: AsyncSession = Depends(get_async_session),
):
    """Update project metadata."""
    logger.debug(
        f"Updating project: project_id={project_id}, name={req.name}, status={req.status}"
    )
    now = now_ms()
    project = await get_project_or_404(session, project_id)

    if req.name is not None:
        project.name = req.name
    if req.description is not None:
        project.description = req.description
    if req.status is not None:
        project.status = req.status
        if req.status == "completed":
            project.completed_at = now
    if req.repository is not None:
        project.repository = req.repository
    if req.defaultPipelineId is not None:
        project.default_pipeline_id = req.defaultPipelineId
    project.updated_at = now

    await session.commit()

    await _publish_event("PROJECT_UPDATED", {"projectId": project_id})
    return {"status": "updated"}


@router.delete("/{project_id}")
async def delete_project(
    project_id: str, session: AsyncSession = Depends(get_async_session)
):
    """Permanently delete a project and all associated data."""
    logger.debug(f"Deleting project: project_id={project_id}")
    project = await get_project_or_404(session, project_id)
    await session.delete(project)
    await session.commit()

    await _publish_event("PROJECT_DELETED", {"projectId": project_id})
    return {"status": "deleted", "project_id": project_id}


@router.post("/{project_id}/archive")
async def archive_project(
    project_id: str, session: AsyncSession = Depends(get_async_session)
):
    """Archive a project (soft delete)."""
    logger.debug(f"Archiving project: project_id={project_id}")
    now = now_ms()
    project = await get_project_or_404(session, project_id)
    project.status = "archived"
    project.updated_at = now
    await session.commit()

    return {"status": "archived"}


# ══════════════════════════════════════════════════════════════════════════
# SLACK NOTIFICATION SETTINGS
# ══════════════════════════════════════════════════════════════════════════


from pydantic import BaseModel


class SlackSettingsRequest(BaseModel):
    slack_channel_id: Optional[str] = None
    slack_notify_user_id: Optional[str] = None


@router.get("/{project_id}/slack")
async def get_project_slack_settings(
    project_id: str, session: AsyncSession = Depends(get_async_session)
):
    """Get Slack notification settings for a project."""
    project = await get_project_or_404(session, project_id)
    return {
        "slack_channel_id": project.slack_channel_id,
        "slack_notify_user_id": project.slack_notify_user_id,
    }


@router.put("/{project_id}/slack")
async def update_project_slack_settings(
    project_id: str,
    req: SlackSettingsRequest,
    session: AsyncSession = Depends(get_async_session),
):
    """Set or update Slack notification settings for a project.

    - slack_channel_id: Slack channel where pipeline run threads are posted.
    - slack_notify_user_id: Slack user ID used as recipient_user_id for
      chatStream (required for streaming updates in channel threads).

    Pass null/empty string to clear a field.
    """
    project = await get_project_or_404(session, project_id)
    now = now_ms()

    if req.slack_channel_id is not None:
        project.slack_channel_id = req.slack_channel_id or None
    if req.slack_notify_user_id is not None:
        project.slack_notify_user_id = req.slack_notify_user_id or None
    project.updated_at = now

    await session.commit()

    await _publish_event(
        "PROJECT_SLACK_UPDATED",
        {
            "projectId": project_id,
            "slackChannelId": project.slack_channel_id,
            "slackNotifyUserId": project.slack_notify_user_id,
        },
    )

    return {
        "status": "updated",
        "slack_channel_id": project.slack_channel_id,
        "slack_notify_user_id": project.slack_notify_user_id,
    }


# ══════════════════════════════════════════════════════════════════════════
# API KEY USER (multi-user: whose keys are used for automated runs)
# ══════════════════════════════════════════════════════════════════════════


class KeyUserRequest(BaseModel):
    key_user_id: Optional[str] = None


@router.get("/{project_id}/key-user")
async def get_project_key_user(
    project_id: str, session: AsyncSession = Depends(get_async_session)
):
    """Get the API key user for automated runs in this project."""
    project = await get_project_or_404(session, project_id)
    return {"key_user_id": project.key_user_id}


@router.put("/{project_id}/key-user")
async def set_project_key_user(
    project_id: str,
    req: KeyUserRequest,
    session: AsyncSession = Depends(get_async_session),
):
    """Set or clear the API key user for automated runs.

    When set, pipeline steps and pulse sessions in this project will use
    the specified user's API keys (resolved via the per-user key chain).
    When null/empty, system-level instance keys are used.
    """
    project = await get_project_or_404(session, project_id)
    project.key_user_id = req.key_user_id or None
    project.updated_at = now_ms()
    await session.commit()
    return {"status": "updated", "key_user_id": project.key_user_id}


# ══════════════════════════════════════════════════════════════════════════
# PROJECT VISION (living markdown document)
# ══════════════════════════════════════════════════════════════════════════


class VisionRequest(BaseModel):
    vision: str


@router.get("/{project_id}/vision")
async def get_project_vision(
    project_id: str, session: AsyncSession = Depends(get_async_session)
):
    """Get the project vision document.

    Returns the markdown vision text that describes the project's goals,
    architecture, constraints, and current priorities.  Agents call this
    before starting work to align with the project's direction.
    """
    project = await get_project_or_404(session, project_id)
    return {"vision": project.vision or ""}


@router.put("/{project_id}/vision")
async def update_project_vision(
    project_id: str,
    req: VisionRequest,
    session: AsyncSession = Depends(get_async_session),
):
    """Set or update the project vision document.

    The vision is a living markdown document editable by the project owner
    at any time.  Agents read it via the get_project_vision tool before
    starting work on tasks.
    """
    project = await get_project_or_404(session, project_id)
    project.vision = req.vision or None
    project.updated_at = now_ms()
    await session.commit()

    await _publish_event(
        "PROJECT_VISION_UPDATED",
        {"projectId": project_id},
    )

    return {"status": "updated"}
