"""Core project CRUD endpoints."""

import json
from typing import Optional

from fastapi import APIRouter, Depends
from sqlalchemy import select, func
from sqlalchemy.ext.asyncio import AsyncSession

from app.database import get_async_session
from app.models import Project, Task, KanbanColumn
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
    """Create a new project with default kanban columns."""
    logger.debug(f"Creating project: name={req.name}, repository={req.repository}")
    now = now_ms()

    project = Project(
        id=gen_id("proj_"),
        name=req.name,
        description=req.description,
        status="active",
        repository=req.repository,
        created_at=now,
        updated_at=now,
    )
    session.add(project)

    # Create default kanban columns
    for col_def in DEFAULT_COLUMNS:
        column = KanbanColumn(
            id=gen_id("col_"),
            project_id=project.id,
            name=col_def["name"],
            position=col_def["position"],
            wip_limit=col_def["wip_limit"],
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
        "onboarding_context": project.onboarding_context,
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
