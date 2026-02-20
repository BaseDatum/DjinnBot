"""Project and task management endpoints."""
import json
import os
import uuid
from typing import Optional, Literal
from fastapi import APIRouter, HTTPException, Query, Depends

from app.logging_config import get_logger
logger = get_logger(__name__)
from pydantic import BaseModel, field_validator
from sqlalchemy import select, update, delete, func, and_, or_
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import selectinload

from app.database import get_async_session
from app.models import (
    Project, Task, KanbanColumn, DependencyEdge, 
    ProjectWorkflow, TaskRun,
)
from app.models.agent import ProjectAgent as ProjectAgentModel
from app.schemas import AssignAgentRequest, UpdateAgentRoleRequest
from app import dependencies
from app.utils import now_ms, gen_id
from app.git_utils import validate_git_url, normalize_git_url, validate_repo_access, get_remote_branches

router = APIRouter()


# ── Pydantic Models ──────────────────────────────────────────────────────

class CreateProjectRequest(BaseModel):
    name: str
    description: str = ""
    repository: Optional[str] = None
    
    @field_validator('repository')
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
    
    @field_validator('repository')
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
    status: Optional[Literal["backlog", "planning", "ready", "in_progress", "review", "blocked", "done", "failed"]] = None
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
    tasks: list[dict]  # [{title, description, priority, tags, dependencies: [title-ref], subtasks: [...]}]

class PlanProjectRequest(BaseModel):
    pipelineId: str = "planning"     # Which pipeline to use for planning
    context: Optional[str] = None    # Additional context for the planner

class SetRepositoryRequest(BaseModel):
    repoUrl: str
    validateAccess: bool = True  # Test connectivity before saving

class ValidateRepositoryRequest(BaseModel):
    repoUrl: str


# ── Default Columns ──────────────────────────────────────────────────────

DEFAULT_COLUMNS = [
    {"name": "Backlog",     "position": 0, "wip_limit": None, "task_statuses": ["backlog"]},
    {"name": "Planning",    "position": 1, "wip_limit": None, "task_statuses": ["planning"]},
    {"name": "Ready",       "position": 2, "wip_limit": None, "task_statuses": ["ready"]},
    {"name": "In Progress", "position": 3, "wip_limit": 5,    "task_statuses": ["in_progress"]},
    {"name": "Review",      "position": 4, "wip_limit": None, "task_statuses": ["review"]},
    {"name": "Blocked",     "position": 5, "wip_limit": None, "task_statuses": ["blocked"]},
    {"name": "Done",        "position": 6, "wip_limit": None, "task_statuses": ["done"]},
    {"name": "Failed",      "position": 7, "wip_limit": None, "task_statuses": ["failed"]},
]


# ── Helpers ──────────────────────────────────────────────────────────────

async def get_project_or_404(
    session: AsyncSession, 
    project_id: str
) -> Project:
    """Get project by ID or raise 404."""
    result = await session.execute(
        select(Project).where(Project.id == project_id)
    )
    project = result.scalar_one_or_none()
    if not project:
        raise HTTPException(status_code=404, detail=f"Project {project_id} not found")
    return project


async def get_task_or_404(
    session: AsyncSession,
    project_id: str,
    task_id: str
) -> Task:
    """Get task by ID within project or raise 404."""
    result = await session.execute(
        select(Task).where(
            Task.id == task_id,
            Task.project_id == project_id
        )
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
            await dependencies.redis_client.xadd("djinnbot:events:global", {"data": json.dumps(event)})
        except Exception:
            pass  # Best effort


async def _detect_cycle(
    session: AsyncSession,
    project_id: str,
    from_task_id: str,
    to_task_id: str
) -> list[str] | None:
    """Check if adding edge (from → to) would create a cycle. Returns cycle path or None."""
    logger.debug(f"Detecting cycle: project_id={project_id}, from={from_task_id}, to={to_task_id}")
    # Get all existing edges for this project
    result = await session.execute(
        select(DependencyEdge.from_task_id, DependencyEdge.to_task_id)
        .where(DependencyEdge.project_id == project_id)
    )
    edges = result.all()
    
    # Build adjacency list including proposed edge
    adj: dict[str, list[str]] = {}
    for src, dst in edges:
        adj.setdefault(src, []).append(dst)
    adj.setdefault(from_task_id, []).append(to_task_id)
    
    # DFS from to_task_id — if we can reach from_task_id, there's a cycle
    visited = set()
    path = []
    
    def dfs(node: str) -> bool:
        if node == from_task_id:
            path.append(node)
            return True
        if node in visited:
            return False
        visited.add(node)
        path.append(node)
        for neighbor in adj.get(node, []):
            if dfs(neighbor):
                return True
        path.pop()
        return False
    
    if dfs(to_task_id):
        return path
    return None


async def _execute_single_task(
    session: AsyncSession, 
    project_id: str, 
    task: Task, 
    pipeline_id: str, 
    context: Optional[str] = None
) -> dict:
    """Execute a single task by creating a run and updating task status.
    
    Returns: {"task_id": str, "run_id": str, "pipeline_id": str}
    Raises: HTTPException on error
    """
    logger.debug(f"Executing single task: project_id={project_id}, task_id={task.id}, pipeline={pipeline_id}")
    now = now_ms()
    
    # Create the run
    run_id = gen_id("run_")
    task_desc = f"[Project: {project_id}] [Task: {task.title}]\n\n{task.description or ''}"
    if context:
        task_desc += f"\n\nAdditional context:\n{context}"
    
    # Create run in DB (same pattern as runs.py start_run)
    # Include project_id so engine can create proper worktree
    from app.models import Run
    run = Run(
        id=run_id,
        pipeline_id=pipeline_id,
        project_id=project_id,
        task_description=task_desc,
        status="pending",
        outputs="{}",
        human_context=context,
        created_at=now,
        updated_at=now,
    )
    session.add(run)
    
    # Update task: link to run, set status to in_progress, move to in_progress column
    # Find in_progress column
    result = await session.execute(
        select(KanbanColumn)
        .where(KanbanColumn.project_id == project_id)
        .order_by(KanbanColumn.position)
    )
    columns = result.scalars().all()
    in_progress_col = None
    for col in columns:
        statuses = json.loads(col.task_statuses) if col.task_statuses else []
        if "in_progress" in statuses:
            in_progress_col = col
            break
    
    task.run_id = run_id
    task.status = "in_progress"
    task.pipeline_id = pipeline_id
    task.updated_at = now
    if in_progress_col:
        task.column_id = in_progress_col.id
    
    # Record in task_runs history
    task_run = TaskRun(
        task_id=task.id,
        run_id=run_id,
        pipeline_id=pipeline_id,
        status="running",
        started_at=now,
    )
    session.add(task_run)
    
    await session.commit()
    
    # Publish to Redis for engine to pick up
    if dependencies.redis_client:
        try:
            logger.debug(f"Publishing run to Redis: run_id={run_id}, pipeline_id={pipeline_id}")
            await dependencies.redis_client.xadd(
                "djinnbot:events:new_runs",
                {"run_id": run_id, "pipeline_id": pipeline_id}
            )
        except Exception as e:
            logger.warning(f"Failed to publish run to Redis: {e}")
        
        # Also publish to global events
        await _publish_event("TASK_EXECUTION_STARTED", {
            "projectId": project_id,
            "taskId": task.id,
            "runId": run_id,
            "pipelineId": pipeline_id,
        })
    
    return {
        "task_id": task.id,
        "run_id": run_id,
        "pipeline_id": pipeline_id,
    }


async def _recompute_task_readiness(
    session: AsyncSession, 
    project_id: str, 
    changed_task_id: str, 
    new_status: str
):
    """
    After a task status changes, recompute readiness/blocking for dependent tasks.
    - If changed_task_id is now 'done': check dependents, auto-ready if all deps met
    - If changed_task_id is now 'failed': cascade-block dependents
    - If changed_task_id moves OUT of 'failed': unblock dependents
    """
    logger.debug(f"Recomputing task readiness: project_id={project_id}, task_id={changed_task_id}, new_status={new_status}")
    now = now_ms()
    events = []  # Collect events to publish
    
    if new_status == 'done':
        # Find tasks that depend on the completed task (where completed task is from_task_id)
        result = await session.execute(
            select(DependencyEdge.to_task_id)
            .where(
                DependencyEdge.from_task_id == changed_task_id,
                DependencyEdge.project_id == project_id,
                DependencyEdge.type == 'blocks'
            )
        )
        dependent_ids = [row[0] for row in result.all()]
        
        for dep_id in dependent_ids:
            # Check if ALL blocking deps for this task are now done
            dep_result = await session.execute(
                select(DependencyEdge.from_task_id, Task.status)
                .join(Task, DependencyEdge.from_task_id == Task.id)
                .where(DependencyEdge.to_task_id == dep_id, DependencyEdge.type == 'blocks')
            )
            blocking_deps = dep_result.all()
            all_done = all(status == "done" for _, status in blocking_deps)
            
            if all_done:
                # Get current task status
                task_result = await session.execute(
                    select(Task).where(Task.id == dep_id)
                )
                task = task_result.scalar_one_or_none()
                if task and task.status in ('backlog', 'planning', 'blocked'):
                    # Find the "Ready" column
                    ready_col_result = await session.execute(
                        select(KanbanColumn)
                        .where(KanbanColumn.project_id == project_id)
                        .order_by(KanbanColumn.position)
                    )
                    ready_col = None
                    for col in ready_col_result.scalars().all():
                        statuses = json.loads(col.task_statuses) if col.task_statuses else []
                        if 'ready' in statuses:
                            ready_col = col
                            break
                    
                    if ready_col:
                        task.status = 'ready'
                        task.column_id = ready_col.id
                        task.updated_at = now
                        events.append(("TASK_STATUS_CHANGED", {"projectId": project_id, "taskId": dep_id, "status": "ready", "reason": "all_dependencies_met"}))
    
    elif new_status == 'failed':
        # Cascade: block all downstream tasks (recursive)
        to_block = []
        visited = set()
        
        async def find_downstream(task_id):
            result = await session.execute(
                select(DependencyEdge.to_task_id)
                .where(
                    DependencyEdge.from_task_id == task_id,
                    DependencyEdge.project_id == project_id,
                    DependencyEdge.type == 'blocks'
                )
            )
            dep_ids = [row[0] for row in result.all()]
            
            for dep_id in dep_ids:
                if dep_id not in visited:
                    visited.add(dep_id)
                    # Only block tasks that aren't already done or failed
                    task_result = await session.execute(
                        select(Task.status).where(Task.id == dep_id)
                    )
                    task_status = task_result.scalar_one_or_none()
                    if task_status and task_status not in ('done', 'failed'):
                        to_block.append(dep_id)
                        await find_downstream(dep_id)
        
        await find_downstream(changed_task_id)
        
        if to_block:
            # Find the "Failed" column (we'll use it for blocked tasks too, or find a Blocked column if exists)
            blocked_col_result = await session.execute(
                select(KanbanColumn)
                .where(KanbanColumn.project_id == project_id)
                .order_by(KanbanColumn.position)
            )
            blocked_col = None
            for col in blocked_col_result.scalars().all():
                statuses = json.loads(col.task_statuses) if col.task_statuses else []
                if 'blocked' in statuses:
                    blocked_col = col
                    break
            
            # If no blocked column, try the Failed column
            if not blocked_col:
                for col in blocked_col_result.scalars().all():
                    statuses = json.loads(col.task_statuses) if col.task_statuses else []
                    if 'failed' in statuses:
                        blocked_col = col
                        break
            
            if blocked_col:
                for dep_id in to_block:
                    task_result = await session.execute(
                        select(Task).where(Task.id == dep_id)
                    )
                    task = task_result.scalar_one_or_none()
                    if task:
                        task.status = 'blocked'
                        task.column_id = blocked_col.id
                        task.updated_at = now
                        events.append(("TASK_STATUS_CHANGED", {"projectId": project_id, "taskId": dep_id, "status": "blocked", "reason": "dependency_failed"}))
    
    elif new_status in ('in_progress', 'backlog', 'planning', 'ready'):
        # Task moved out of failed/blocked — re-check if dependents should be unblocked
        # Only unblock tasks that were blocked due to this specific task
        result = await session.execute(
            select(DependencyEdge.to_task_id)
            .where(
                DependencyEdge.from_task_id == changed_task_id,
                DependencyEdge.project_id == project_id,
                DependencyEdge.type == 'blocks'
            )
        )
        dependent_ids = [row[0] for row in result.all()]
        
        for dep_id in dependent_ids:
            task_result = await session.execute(
                select(Task).where(Task.id == dep_id)
            )
            task = task_result.scalar_one_or_none()
            if task and task.status == 'blocked':
                # Check if there are other failed/blocked blocking deps
                dep_result = await session.execute(
                    select(DependencyEdge.from_task_id, Task.status)
                    .join(Task, DependencyEdge.from_task_id == Task.id)
                    .where(DependencyEdge.to_task_id == dep_id, DependencyEdge.type == 'blocks')
                )
                blocking_deps = dep_result.all()
                has_failed = any(status in ('failed', 'blocked') for _, status in blocking_deps)
                
                if not has_failed:
                    # Check if all deps are done → ready, otherwise → backlog
                    all_done = all(status == "done" for _, status in blocking_deps)
                    new_task_status = 'ready' if all_done else 'backlog'
                    
                    # Find appropriate column
                    col_result = await session.execute(
                        select(KanbanColumn)
                        .where(KanbanColumn.project_id == project_id)
                        .order_by(KanbanColumn.position)
                    )
                    target_col = None
                    for col in col_result.scalars().all():
                        statuses = json.loads(col.task_statuses) if col.task_statuses else []
                        if new_task_status in statuses:
                            target_col = col
                            break
                    
                    if target_col:
                        task.status = new_task_status
                        task.column_id = target_col.id
                        task.updated_at = now
                        events.append(("TASK_STATUS_CHANGED", {"projectId": project_id, "taskId": dep_id, "status": new_task_status, "reason": "dependency_unblocked"}))
    
    await session.commit()
    
    # Publish all events
    for event_type, data in events:
        await _publish_event(event_type, data)


def _validate_pipeline_exists(pipeline_id: str) -> bool:
    """Validate that a pipeline exists."""
    # Pipeline registry not yet implemented - always return True
    # TODO: Implement pipeline registry
    return True


# ══════════════════════════════════════════════════════════════════════════
# PROJECT ENDPOINTS
# ══════════════════════════════════════════════════════════════════════════

@router.post("/")
async def create_project(req: CreateProjectRequest, session: AsyncSession = Depends(get_async_session)):
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
    
    await _publish_event("PROJECT_CREATED", {"projectId": project.id, "name": project.name})
    
    return {"id": project.id, "name": project.name, "status": "active", "created_at": now}


@router.get("/")
async def list_projects(status: Optional[str] = None, session: AsyncSession = Depends(get_async_session)):
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
        
        response.append({
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
        })
    
    return response


@router.get("/{project_id}")
async def get_project(project_id: str, session: AsyncSession = Depends(get_async_session)):
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
        select(Task)
        .where(Task.project_id == project_id)
        .order_by(Task.column_position)
    )
    tasks = task_result.scalars().all()
    
    # Get dependencies
    dep_result = await session.execute(
        select(DependencyEdge)
        .where(DependencyEdge.project_id == project_id)
    )
    deps_list = dep_result.scalars().all()
    
    # Get workflows
    wf_result = await session.execute(
        select(ProjectWorkflow)
        .where(ProjectWorkflow.project_id == project_id)
    )
    workflows = wf_result.scalars().all()
    
    # Get assigned agents
    agent_result = await session.execute(
        select(ProjectAgentModel)
        .where(ProjectAgentModel.project_id == project_id)
        .order_by(ProjectAgentModel.role, ProjectAgentModel.assigned_at)
    )
    agents = agent_result.scalars().all()
    logger.debug(f"Retrieved project {project_id}: columns={len(columns)}, tasks={len(tasks)}, deps={len(deps_list)}, workflows={len(workflows)}, agents={len(agents)}")
    
    return {
        "id": project.id,
        "name": project.name,
        "description": project.description,
        "status": project.status,
        "repository": project.repository,
        "default_pipeline_id": project.default_pipeline_id,
        "created_at": project.created_at,
        "updated_at": project.updated_at,
        "completed_at": project.completed_at,
        "columns": [_serialize_column(c) for c in columns],
        "tasks": [_serialize_task(t) for t in tasks],
        "dependencies": [
            {"id": d.id, "project_id": d.project_id, "from_task_id": d.from_task_id, "to_task_id": d.to_task_id, "type": d.type}
            for d in deps_list
        ],
        "workflows": [_serialize_workflow(w) for w in workflows],
        "agents": [
            {"project_id": a.project_id, "agent_id": a.agent_id, "role": a.role, "assigned_at": a.assigned_at, "assigned_by": a.assigned_by}
            for a in agents
        ],
    }


@router.put("/{project_id}")
async def update_project(project_id: str, req: UpdateProjectRequest, session: AsyncSession = Depends(get_async_session)):
    """Update project metadata."""
    logger.debug(f"Updating project: project_id={project_id}, name={req.name}, status={req.status}")
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
async def delete_project(project_id: str, session: AsyncSession = Depends(get_async_session)):
    """Permanently delete a project and all associated data."""
    logger.debug(f"Deleting project: project_id={project_id}")
    project = await get_project_or_404(session, project_id)
    await session.delete(project)
    await session.commit()
    
    await _publish_event("PROJECT_DELETED", {"projectId": project_id})
    return {"status": "deleted", "project_id": project_id}


@router.post("/{project_id}/archive")
async def archive_project(project_id: str, session: AsyncSession = Depends(get_async_session)):
    """Archive a project (soft delete)."""
    logger.debug(f"Archiving project: project_id={project_id}")
    now = now_ms()
    project = await get_project_or_404(session, project_id)
    project.status = "archived"
    project.updated_at = now
    await session.commit()
    
    return {"status": "archived"}


# ══════════════════════════════════════════════════════════════════════════
# REPOSITORY ENDPOINTS
# ══════════════════════════════════════════════════════════════════════════

@router.put("/{project_id}/repository")
async def set_project_repository(project_id: str, req: SetRepositoryRequest, session: AsyncSession = Depends(get_async_session)):
    """
    Set or update a project's Git repository URL.
    
    Optionally validates access before saving (default: true).
    Uses GitHub App for private repos when available.
    """
    logger.debug(f"Setting repository: project_id={project_id}, url={req.repoUrl}, validate={req.validateAccess}")
    project = await get_project_or_404(session, project_id)
    
    # Normalize URL
    normalized_url = normalize_git_url(req.repoUrl)
    if not normalized_url:
        raise HTTPException(status_code=400, detail="Invalid repository URL")
    
    # Validate URL format
    is_valid, error = validate_git_url(normalized_url)
    if not is_valid:
        raise HTTPException(status_code=400, detail=error or "Invalid repository URL")
    
    # Validate access if requested
    installation_id = None
    if req.validateAccess:
        # Try GitHub App first
        github_info = await _validate_repo_with_github_app(session, normalized_url)
        if github_info:
            if not github_info.get("accessible"):
                raise HTTPException(
                    status_code=400,
                    detail=f"Repository not accessible: {github_info.get('error', 'Unknown error')}"
                )
            installation_id = github_info.get("installationId")
        else:
            # Fall back to git ls-remote
            info = validate_repo_access(normalized_url)
            if not info.accessible:
                raise HTTPException(
                    status_code=400,
                    detail=f"Repository not accessible: {info.error}"
                )
    
    # Update database
    now = now_ms()
    project.repository = normalized_url
    project.updated_at = now
    
    # Also update project_github if we have installation info
    if installation_id:
        import re
        match = re.search(r'github\.com[/:]([^/]+)/([^/\.]+)', normalized_url)
        if match:
            from app.models.github import ProjectGitHub
            owner, repo_name = match.groups()
            repo_name = repo_name.replace('.git', '')
            
            gh_record = ProjectGitHub(
                id=f"gh_{owner}_{repo_name}".lower(),
                project_id=project_id,
                installation_id=installation_id,
                repo_owner=owner,
                repo_name=repo_name,
                repo_full_name=f"{owner}/{repo_name}",
                default_branch="main",
                connected_at=int(now / 1000),
                is_active=True,
            )
            session.add(gh_record)
    
    await session.commit()
    
    await _publish_event("PROJECT_REPOSITORY_UPDATED", {
        "projectId": project_id,
        "repoUrl": normalized_url,
        "installationId": installation_id
    })
    
    return {
        "status": "updated",
        "repoUrl": normalized_url,
        "validated": req.validateAccess,
        "installationId": installation_id
    }


@router.delete("/{project_id}/repository")
async def remove_project_repository(project_id: str, session: AsyncSession = Depends(get_async_session)):
    """
    Remove repository association from a project.
    
    Does NOT delete the cloned repository files (use workspace cleanup for that).
    """
    project = await get_project_or_404(session, project_id)
    
    now = now_ms()
    project.repository = None
    project.updated_at = now
    await session.commit()
    
    await _publish_event("PROJECT_REPOSITORY_REMOVED", {"projectId": project_id})
    
    return {"status": "removed"}


@router.get("/{project_id}/repository/status")
async def get_project_repository_status(project_id: str, session: AsyncSession = Depends(get_async_session)):
    """
    Check if the project's repository is accessible.
    
    Returns:
        - Repository URL
        - Accessibility status
        - Default branch
        - Latest commit
        - List of branches (up to 10)
        - Error message if not accessible
    """
    project = await get_project_or_404(session, project_id)
    
    repo_url = project.repository
    if not repo_url:
        raise HTTPException(
            status_code=404,
            detail="No repository configured for this project"
        )
    
    # Try GitHub App first, fall back to git ls-remote
    info = await _validate_repo_with_github_app(session, repo_url)
    if info is None:
        # Fall back to standard git validation
        info = validate_repo_access(repo_url)
        branches = get_remote_branches(repo_url, limit=10) if info.accessible else []
    else:
        branches = info.get("branches", [])
    
    return {
        "url": repo_url,
        "accessible": info.accessible if hasattr(info, 'accessible') else info.get("accessible", False),
        "defaultBranch": info.default_branch if hasattr(info, 'default_branch') else info.get("defaultBranch"),
        "latestCommit": info.latest_commit if hasattr(info, 'latest_commit') else info.get("latestCommit"),
        "branches": branches,
        "error": info.error if hasattr(info, 'error') else info.get("error")
    }


@router.post("/{project_id}/repository/status")
async def validate_repository_url(project_id: str, req: ValidateRepositoryRequest, session: AsyncSession = Depends(get_async_session)):
    """
    Validate a repository URL before saving it.
    
    Tests connectivity using GitHub App (if applicable) or git ls-remote.
    """
    logger.debug(f"Validating repository URL: project_id={project_id}, url={req.repoUrl}")
    await get_project_or_404(session, project_id)  # Verify project exists
    
    # Normalize URL
    normalized_url = normalize_git_url(req.repoUrl)
    if not normalized_url:
        raise HTTPException(status_code=400, detail="Invalid repository URL format")
    
    # Validate URL format
    is_valid, error = validate_git_url(normalized_url)
    if not is_valid:
        raise HTTPException(status_code=400, detail=error or "Invalid repository URL")
    
    # Try GitHub App first, fall back to git ls-remote
    info = await _validate_repo_with_github_app(session, normalized_url)
    if info is None:
        # Fall back to standard git validation
        git_info = validate_repo_access(normalized_url)
        branches = get_remote_branches(normalized_url, limit=10) if git_info.accessible else []
        return {
            "url": normalized_url,
            "accessible": git_info.accessible,
            "defaultBranch": git_info.default_branch,
            "latestCommit": git_info.latest_commit,
            "branches": branches,
            "error": git_info.error
        }
    
    return info


async def _validate_repo_with_github_app(session: AsyncSession, repo_url: str) -> dict | None:
    """
    Validate repository access using GitHub App if it's a GitHub repo.
    
    Returns dict with repo info or None if not a GitHub repo / no app configured.
    """
    logger.debug(f"Validating repo with GitHub App: url={repo_url}")
    import re
    import httpx
    
    # Check if it's a GitHub URL
    if "github.com" not in repo_url:
        return None
    
    # Parse owner/repo from URL
    match = re.search(r'github\.com[/:]([^/]+)/([^/\.]+)', repo_url)
    if not match:
        return None
    
    owner, repo_name = match.groups()
    repo_name = repo_name.replace('.git', '')
    
    # Try to get GitHub App installation for this repo
    try:
        from app.github_helper import GitHubHelper
        helper = GitHubHelper()
        
        if not helper.app_id:
            return None  # GitHub App not configured
        
        # Get all installations
        jwt_token = helper.generate_jwt()
        
        async with httpx.AsyncClient() as http:
            # List installations
            resp = await http.get(
                "https://api.github.com/app/installations",
                headers={
                    "Authorization": f"Bearer {jwt_token}",
                    "Accept": "application/vnd.github+json",
                    "X-GitHub-Api-Version": "2022-11-28"
                }
            )
            
            if resp.status_code != 200:
                return None
            
            installations = resp.json()
            
            for install in installations:
                # Get token for this installation
                token_resp = await http.post(
                    f"https://api.github.com/app/installations/{install['id']}/access_tokens",
                    headers={
                        "Authorization": f"Bearer {jwt_token}",
                        "Accept": "application/vnd.github+json",
                        "X-GitHub-Api-Version": "2022-11-28"
                    }
                )
                
                if token_resp.status_code != 201:
                    continue
                
                token = token_resp.json()["token"]
                headers = {
                    "Authorization": f"Bearer {token}",
                    "Accept": "application/vnd.github+json",
                    "X-GitHub-Api-Version": "2022-11-28"
                }
                
                # Try to access the repo with this installation
                repo_resp = await http.get(
                    f"https://api.github.com/repos/{owner}/{repo_name}",
                    headers=headers
                )
                
                if repo_resp.status_code == 200:
                    repo_data = repo_resp.json()
                    
                    # Get branches
                    branches_resp = await http.get(
                        f"https://api.github.com/repos/{owner}/{repo_name}/branches?per_page=10",
                        headers=headers
                    )
                    branches = []
                    if branches_resp.status_code == 200:
                        for b in branches_resp.json():
                            branches.append({
                                "name": b["name"],
                                "commit": b["commit"]["sha"][:8]
                            })
                    
                    return {
                        "url": repo_url,
                        "accessible": True,
                        "defaultBranch": repo_data.get("default_branch", "main"),
                        "latestCommit": repo_data.get("pushed_at"),
                        "branches": branches,
                        "error": None,
                        "githubApp": True,
                        "installationId": install["id"]
                    }
        
        return None  # No installation has access
    except Exception as e:
        # Log but don't fail - fall back to git
        logger.debug(f"GitHub App validation failed, falling back: {e}")
        return None


@router.post("/{project_id}/repository/clone")
async def clone_project_repository(project_id: str, session: AsyncSession = Depends(get_async_session)):
    """
    Clone the project's repository to create the workspace.
    
    This must be called after setting the repository URL to prepare the workspace
    for running tasks. The clone uses GitHub App authentication when available.
    
    Returns:
        - workspace_path: Path where the repository was cloned
        - branch: Default branch of the repository
        - commit: Latest commit hash
    """
    import subprocess
    logger.debug(f"Cloning repository: project_id={project_id}")
    
    project = await get_project_or_404(session, project_id)
    
    repo_url = project.repository
    if not repo_url:
        raise HTTPException(
            status_code=400,
            detail="No repository configured for this project. Set a repository URL first."
        )
    
    # Determine workspace path
    workspaces_dir = os.getenv("WORKSPACES_DIR", "/data/workspaces")
    workspace_path = os.path.join(workspaces_dir, project_id)
    
    # Check if already cloned
    if os.path.exists(os.path.join(workspace_path, ".git")):
        # Already cloned - pull latest
        try:
            subprocess.run(
                ["git", "pull", "--ff-only"],
                cwd=workspace_path,
                capture_output=True,
                timeout=60,
                check=False
            )
            
            # Get branch and commit info
            branch = subprocess.run(
                ["git", "rev-parse", "--abbrev-ref", "HEAD"],
                cwd=workspace_path,
                capture_output=True,
                text=True
            ).stdout.strip()
            
            commit = subprocess.run(
                ["git", "rev-parse", "HEAD"],
                cwd=workspace_path,
                capture_output=True,
                text=True
            ).stdout.strip()
            
            return {
                "status": "updated",
                "workspace_path": workspace_path,
                "branch": branch,
                "commit": commit[:8]
            }
        except Exception as e:
            raise HTTPException(status_code=500, detail=f"Failed to update repository: {str(e)}")
    
    # Clone the repository
    os.makedirs(workspace_path, exist_ok=True)
    
    # Try to get GitHub App token for authentication
    clone_url = repo_url
    try:
        github_info = await _validate_repo_with_github_app(session, repo_url)
        if github_info and github_info.get("accessible"):
            # Get fresh token for clone
            from app.github_helper import GitHubHelper
            helper = GitHubHelper()
            installation_id = github_info.get("installationId")
            if installation_id:
                token, _ = await helper.get_installation_token(installation_id)
                # Build authenticated URL
                import re
                match = re.search(r'github\.com[/:]([^/]+)/([^/\.]+)', repo_url)
                if match:
                    owner, repo_name = match.groups()
                    repo_name = repo_name.replace('.git', '')
                    clone_url = f"https://x-access-token:{token}@github.com/{owner}/{repo_name}.git"
    except Exception as e:
        logger.warning(f"Failed to get GitHub App token, falling back to URL: {e}")
    
    try:
        # Remove the empty directory we created
        import shutil
        if os.path.exists(workspace_path):
            shutil.rmtree(workspace_path)
        
        result = subprocess.run(
            ["git", "clone", clone_url, workspace_path],
            capture_output=True,
            text=True,
            timeout=120,
            env={**os.environ, "GIT_TERMINAL_PROMPT": "0"}
        )
        
        if result.returncode != 0:
            raise HTTPException(
                status_code=500,
                detail=f"Clone failed: {result.stderr or result.stdout}"
            )
        
        # Get branch and commit info
        branch = subprocess.run(
            ["git", "rev-parse", "--abbrev-ref", "HEAD"],
            cwd=workspace_path,
            capture_output=True,
            text=True
        ).stdout.strip()
        
        commit = subprocess.run(
            ["git", "rev-parse", "HEAD"],
            cwd=workspace_path,
            capture_output=True,
            text=True
        ).stdout.strip()
        
        return {
            "status": "cloned",
            "workspace_path": workspace_path,
            "branch": branch,
            "commit": commit[:8]
        }
        
    except subprocess.TimeoutExpired:
        raise HTTPException(status_code=500, detail="Clone timed out")
    except Exception as e:
        # Cleanup on failure
        if os.path.exists(workspace_path):
            import shutil
            shutil.rmtree(workspace_path, ignore_errors=True)
        raise HTTPException(status_code=500, detail=f"Clone failed: {str(e)}")


# ══════════════════════════════════════════════════════════════════════════
# COLUMN ENDPOINTS
# ══════════════════════════════════════════════════════════════════════════

@router.post("/{project_id}/columns")
async def create_column(project_id: str, req: CreateColumnRequest, session: AsyncSession = Depends(get_async_session)):
    """Add a kanban column to a project."""
    logger.debug(f"Creating column: project_id={project_id}, name={req.name}")
    await get_project_or_404(session, project_id)
    
    # Get max position if not provided
    if req.position is None:
        result = await session.execute(
            select(func.max(KanbanColumn.position))
            .where(KanbanColumn.project_id == project_id)
        )
        max_pos = result.scalar() or 0
        position = max_pos + 1
    else:
        position = req.position
    
    column = KanbanColumn(
        id=gen_id("col_"),
        project_id=project_id,
        name=req.name,
        position=position,
        wip_limit=req.wipLimit,
        task_statuses=json.dumps(req.taskStatuses),
    )
    session.add(column)
    await session.commit()
    
    return {"id": column.id, "name": req.name, "position": position}


@router.put("/{project_id}/columns/{column_id}")
async def update_column(project_id: str, column_id: str, req: UpdateColumnRequest, session: AsyncSession = Depends(get_async_session)):
    """Update a kanban column."""
    logger.debug(f"Updating column: project_id={project_id}, column_id={column_id}")
    await get_project_or_404(session, project_id)
    
    result = await session.execute(
        select(KanbanColumn)
        .where(KanbanColumn.id == column_id, KanbanColumn.project_id == project_id)
    )
    column = result.scalar_one_or_none()
    if not column:
        raise HTTPException(status_code=404, detail=f"Column {column_id} not found")
    
    if req.name is not None:
        column.name = req.name
    if req.position is not None:
        column.position = req.position
    if req.wipLimit is not None:
        column.wip_limit = req.wipLimit
    if req.taskStatuses is not None:
        column.task_statuses = json.dumps(req.taskStatuses)
    
    if not any([req.name, req.position, req.wipLimit, req.taskStatuses]):
        return {"status": "no changes"}
    
    await session.commit()
    
    return {"status": "updated"}


@router.delete("/{project_id}/columns/{column_id}")
async def delete_column(project_id: str, column_id: str, session: AsyncSession = Depends(get_async_session)):
    """Delete a kanban column. Fails if tasks are still in it."""
    logger.debug(f"Deleting column: project_id={project_id}, column_id={column_id}")
    await get_project_or_404(session, project_id)
    
    # Check for tasks in this column
    result = await session.execute(
        select(func.count(Task.id))
        .where(Task.column_id == column_id)
    )
    count = result.scalar() or 0
    if count > 0:
        raise HTTPException(status_code=400, detail=f"Cannot delete column with {count} tasks. Move them first.")
    
    # Delete the column
    result = await session.execute(
        delete(KanbanColumn)
        .where(KanbanColumn.id == column_id, KanbanColumn.project_id == project_id)
    )
    await session.commit()
    
    return {"status": "deleted"}


# ══════════════════════════════════════════════════════════════════════════
# TASK ENDPOINTS
# ══════════════════════════════════════════════════════════════════════════

@router.post("/{project_id}/tasks")
async def create_task(project_id: str, req: CreateTaskRequest, session: AsyncSession = Depends(get_async_session)):
    """Create a task in a project."""
    logger.debug(f"Creating task: project_id={project_id}, title={req.title}, priority={req.priority}")
    now = now_ms()
    await get_project_or_404(session, project_id)
    
    # Determine column
    if req.columnId:
        column_id = req.columnId
    else:
        # Use first column (backlog)
        result = await session.execute(
            select(KanbanColumn)
            .where(KanbanColumn.project_id == project_id)
            .order_by(KanbanColumn.position)
            .limit(1)
        )
        column = result.scalar_one_or_none()
        if not column:
            raise HTTPException(status_code=500, detail="Project has no columns")
        column_id = column.id
    
    # Get next position in column
    result = await session.execute(
        select(func.max(Task.column_position))
        .where(Task.column_id == column_id)
    )
    max_pos = result.scalar() or 0
    position = max_pos + 1
    
    # Resolve workflow → pipeline
    pipeline_id = None
    if req.workflowId:
        wf_result = await session.execute(
            select(ProjectWorkflow.pipeline_id)
            .where(ProjectWorkflow.id == req.workflowId)
        )
        pipeline_id = wf_result.scalar_one_or_none()
    
    task = Task(
        id=gen_id("task_"),
        project_id=project_id,
        title=req.title,
        description=req.description,
        status="backlog",
        priority=req.priority,
        assigned_agent=req.assignedAgent,
        workflow_id=req.workflowId,
        pipeline_id=pipeline_id,
        parent_task_id=req.parentTaskId,
        tags=json.dumps(req.tags),
        estimated_hours=req.estimatedHours,
        column_id=column_id,
        column_position=position,
        task_metadata=json.dumps(req.metadata),
        created_at=now,
        updated_at=now,
    )
    session.add(task)
    await session.commit()
    
    await _publish_event("TASK_CREATED", {"projectId": project_id, "taskId": task.id, "title": task.title})
    return {"id": task.id, "title": task.title, "status": "backlog", "column_id": column_id}


@router.get("/{project_id}/tasks")
async def list_tasks(
    project_id: str,
    status: Optional[str] = None,
    priority: Optional[str] = None,
    agent: Optional[str] = None,
    tag: Optional[str] = None,
    session: AsyncSession = Depends(get_async_session)
):
    """List tasks with optional filters."""
    logger.debug(f"Listing tasks: project_id={project_id}, status={status}, priority={priority}, agent={agent}, tag={tag}")
    await get_project_or_404(session, project_id)
    
    query = select(Task).where(Task.project_id == project_id)
    
    if status:
        query = query.where(Task.status == status)
    if priority:
        query = query.where(Task.priority == priority)
    if agent:
        query = query.where(Task.assigned_agent == agent)
    
    query = query.order_by(Task.column_position)
    
    result = await session.execute(query)
    tasks = result.scalars().all()
    
    # Filter by tag if requested (post-filter since tags are JSON)
    filtered_tasks = []
    for t in tasks:
        task_dict = _serialize_task(t)
        if tag and tag not in task_dict["tags"]:
            continue
        filtered_tasks.append(task_dict)
    logger.debug(f"Found {len(filtered_tasks)} tasks for project {project_id}")
    
    return filtered_tasks


@router.get("/{project_id}/tasks/{task_id}")
async def get_task(project_id: str, task_id: str, session: AsyncSession = Depends(get_async_session)):
    """Get task detail with dependencies and run history."""
    logger.debug(f"Getting task: project_id={project_id}, task_id={task_id}")
    task = await get_task_or_404(session, project_id, task_id)
    
    # Get dependencies (tasks this one depends on)
    dep_result = await session.execute(
        select(DependencyEdge, Task)
        .join(Task, DependencyEdge.from_task_id == Task.id)
        .where(DependencyEdge.to_task_id == task_id)
    )
    blocking = [
        {
            "id": edge.id,
            "from_task_id": edge.from_task_id,
            "from_task_title": t.title,
            "from_task_status": t.status,
            "type": edge.type,
        }
        for edge, t in dep_result.all()
    ]
    
    # Get dependents (tasks that depend on this one)
    dep_result2 = await session.execute(
        select(DependencyEdge, Task)
        .join(Task, DependencyEdge.to_task_id == Task.id)
        .where(DependencyEdge.from_task_id == task_id)
    )
    dependents = [
        {
            "id": edge.id,
            "to_task_id": edge.to_task_id,
            "to_task_title": t.title,
            "to_task_status": t.status,
            "type": edge.type,
        }
        for edge, t in dep_result2.all()
    ]
    
    # Get subtasks
    sub_result = await session.execute(
        select(Task.id, Task.title, Task.status, Task.priority)
        .where(Task.parent_task_id == task_id)
        .order_by(Task.column_position)
    )
    subtasks = [
        {"id": r[0], "title": r[1], "status": r[2], "priority": r[3]}
        for r in sub_result.all()
    ]
    
    # Get run history
    run_result = await session.execute(
        select(TaskRun)
        .where(TaskRun.task_id == task_id)
        .order_by(TaskRun.started_at.desc())
    )
    run_history = [
        {
            "id": tr.id,
            "task_id": tr.task_id,
            "run_id": tr.run_id,
            "pipeline_id": tr.pipeline_id,
            "status": tr.status,
            "started_at": tr.started_at,
            "completed_at": tr.completed_at,
        }
        for tr in run_result.scalars().all()
    ]
    
    return {
        **_serialize_task(task),
        "blocking_dependencies": blocking,
        "dependents": dependents,
        "subtasks": subtasks,
        "run_history": run_history,
    }


@router.put("/{project_id}/tasks/{task_id}")
async def update_task(project_id: str, task_id: str, req: UpdateTaskRequest, session: AsyncSession = Depends(get_async_session)):
    """Update task fields."""
    logger.debug(f"Updating task: project_id={project_id}, task_id={task_id}, status={req.status}")
    now = now_ms()
    task = await get_task_or_404(session, project_id, task_id)
    
    if req.title is not None:
        task.title = req.title
    if req.description is not None:
        task.description = req.description
    if req.priority is not None:
        task.priority = req.priority
    if req.assignedAgent is not None:
        task.assigned_agent = req.assignedAgent
    if req.workflowId is not None:
        task.workflow_id = req.workflowId
    if req.tags is not None:
        task.tags = json.dumps(req.tags)
    if req.estimatedHours is not None:
        task.estimated_hours = req.estimatedHours
    if req.metadata is not None:
        task.task_metadata = json.dumps(req.metadata)
    if req.status is not None:
        task.status = req.status
        if req.status == "done":
            task.completed_at = now
    task.updated_at = now
    
    await session.commit()
    
    # Recompute readiness/blocking if status changed
    if req.status:
        await _recompute_task_readiness(session, project_id, task_id, req.status)
    
    event_type = "TASK_STATUS_CHANGED" if req.status else "TASK_UPDATED"
    await _publish_event(event_type, {"projectId": project_id, "taskId": task_id, "status": req.status})
    return {"status": "updated"}


@router.delete("/{project_id}/tasks/{task_id}")
async def delete_task(project_id: str, task_id: str, session: AsyncSession = Depends(get_async_session)):
    """Delete a task and its dependencies."""
    logger.debug(f"Deleting task: project_id={project_id}, task_id={task_id}")
    task = await get_task_or_404(session, project_id, task_id)
    
    # Delete dependencies
    await session.execute(
        delete(DependencyEdge)
        .where(or_(DependencyEdge.from_task_id == task_id, DependencyEdge.to_task_id == task_id))
    )
    
    # Delete task runs
    await session.execute(
        delete(TaskRun).where(TaskRun.task_id == task_id)
    )
    
    # Delete the task
    await session.delete(task)
    await session.commit()
    
    return {"status": "deleted"}


@router.post("/{project_id}/tasks/{task_id}/move")
async def move_task(project_id: str, task_id: str, req: MoveTaskRequest, session: AsyncSession = Depends(get_async_session)):
    """Move a task to a different column/position."""
    logger.debug(f"Moving task: project_id={project_id}, task_id={task_id}, column={req.columnId}, position={req.position}")
    now = now_ms()
    task = await get_task_or_404(session, project_id, task_id)
    
    # Check column exists
    col_result = await session.execute(
        select(KanbanColumn)
        .where(KanbanColumn.id == req.columnId, KanbanColumn.project_id == project_id)
    )
    column = col_result.scalar_one_or_none()
    if not column:
        raise HTTPException(status_code=404, detail=f"Column {req.columnId} not found")
    
    # Check WIP limit
    if column.wip_limit is not None:
        count_result = await session.execute(
            select(func.count(Task.id))
            .where(Task.column_id == req.columnId, Task.id != task_id)
        )
        count = count_result.scalar() or 0
        if count >= column.wip_limit:
            raise HTTPException(status_code=400, detail=f"Column WIP limit ({column.wip_limit}) reached")
    
    # Update task position
    task.column_id = req.columnId
    task.column_position = req.position
    task.updated_at = now
    
    # Auto-update task status based on target column's status mapping
    statuses = json.loads(column.task_statuses) if column.task_statuses else []
    if statuses:
        new_status = statuses[0]  # Use the first mapped status
        if task.status != new_status:
            task.status = new_status
            # Also recompute readiness after commit
            recompute_after = True
        else:
            recompute_after = False
    
    await session.commit()
    
    # Recompute readiness for dependents AFTER commit
    if statuses:
        new_status = statuses[0]
        await _recompute_task_readiness(session, project_id, task_id, new_status)
    
    await _publish_event("TASK_MOVED", {"projectId": project_id, "taskId": task_id, "columnId": req.columnId})
    return {"status": "moved", "column_id": req.columnId, "position": req.position}


@router.get("/{project_id}/ready-tasks")
async def get_ready_tasks(project_id: str, session: AsyncSession = Depends(get_async_session)):
    """Get tasks that are ready to execute (all blocking dependencies met)."""
    logger.debug(f"Getting ready tasks: project_id={project_id}")
    await get_project_or_404(session, project_id)
    
    # Get all tasks that are in backlog or planning
    result = await session.execute(
        select(Task)
        .where(Task.project_id == project_id, Task.status.in_(['backlog', 'planning']))
    )
    candidate_tasks = result.scalars().all()
    
    ready = []
    for task in candidate_tasks:
        # Check all blocking dependencies
        dep_result = await session.execute(
            select(Task.status)
            .join(DependencyEdge, DependencyEdge.from_task_id == Task.id)
            .where(DependencyEdge.to_task_id == task.id, DependencyEdge.type == 'blocks')
        )
        deps = dep_result.all()
        
        if not deps or all(status == "done" for status, in deps):
            ready.append({
                "id": task.id,
                "title": task.title,
                "status": task.status,
                "priority": task.priority,
                "assigned_agent": task.assigned_agent,
            })
    
    logger.debug(f"Found {len(ready)} ready tasks for project {project_id}")
    
    return ready


# ══════════════════════════════════════════════════════════════════════════
# DEPENDENCY ENDPOINTS
# ══════════════════════════════════════════════════════════════════════════

@router.post("/{project_id}/tasks/{task_id}/dependencies")
async def add_dependency(project_id: str, task_id: str, req: AddDependencyRequest, session: AsyncSession = Depends(get_async_session)):
    """Add a dependency: fromTaskId must complete before task_id can start."""
    logger.debug(f"Adding dependency: project_id={project_id}, task_id={task_id}, from={req.fromTaskId}, type={req.type}")
    # Validate both tasks exist
    await get_task_or_404(session, project_id, task_id)
    from_task = await get_task_or_404(session, project_id, req.fromTaskId)
    
    if req.fromTaskId == task_id:
        raise HTTPException(status_code=400, detail="A task cannot depend on itself")
    
    # Check for existing dependency
    result = await session.execute(
        select(DependencyEdge.id)
        .where(
            DependencyEdge.from_task_id == req.fromTaskId,
            DependencyEdge.to_task_id == task_id
        )
    )
    if result.scalar_one_or_none():
        raise HTTPException(status_code=400, detail="Dependency already exists")
    
    # Cycle detection
    cycle = await _detect_cycle(session, project_id, req.fromTaskId, task_id)
    if cycle:
        # Get task titles for the cycle path
        title_map = {}
        for tid in cycle:
            result = await session.execute(
                select(Task.title).where(Task.id == tid)
            )
            title = result.scalar_one_or_none()
            if title:
                title_map[tid] = title
        
        cycle_path = " → ".join(title_map.get(tid, tid) for tid in cycle)
        raise HTTPException(
            status_code=400,
            detail=f"Cannot add dependency: would create a cycle: {cycle_path}"
        )
    
    dep = DependencyEdge(
        id=gen_id("dep_"),
        project_id=project_id,
        from_task_id=req.fromTaskId,
        to_task_id=task_id,
        type=req.type,
    )
    session.add(dep)
    await session.commit()
    
    await _publish_event("DEPENDENCY_ADDED", {
        "projectId": project_id,
        "fromTaskId": req.fromTaskId,
        "toTaskId": task_id,
        "type": req.type,
    })
    return {"id": dep.id, "from": req.fromTaskId, "to": task_id, "type": req.type}


@router.delete("/{project_id}/tasks/{task_id}/dependencies/{dep_id}")
async def remove_dependency(project_id: str, task_id: str, dep_id: str, session: AsyncSession = Depends(get_async_session)):
    """Remove a dependency."""
    logger.debug(f"Removing dependency: project_id={project_id}, dep_id={dep_id}")
    result = await session.execute(
        delete(DependencyEdge)
        .where(DependencyEdge.id == dep_id, DependencyEdge.project_id == project_id)
    )
    await session.commit()
    
    await _publish_event("DEPENDENCY_REMOVED", {"projectId": project_id, "dependencyId": dep_id})
    return {"status": "removed"}


@router.get("/{project_id}/dependency-graph")
async def get_dependency_graph(project_id: str, session: AsyncSession = Depends(get_async_session)):
    """Get the full dependency graph for visualization."""
    logger.debug(f"Getting dependency graph: project_id={project_id}")
    await get_project_or_404(session, project_id)
    
    # Get all tasks (nodes)
    result = await session.execute(
        select(Task)
        .where(Task.project_id == project_id)
    )
    tasks = result.scalars().all()
    tasks_data = [
        {
            "id": t.id,
            "title": t.title,
            "status": t.status,
            "priority": t.priority,
            "assigned_agent": t.assigned_agent,
            "estimated_hours": t.estimated_hours,
        }
        for t in tasks
    ]
    
    # Get all edges
    dep_result = await session.execute(
        select(DependencyEdge)
        .where(DependencyEdge.project_id == project_id)
    )
    edges_data = [
        {
            "id": e.id,
            "project_id": e.project_id,
            "from_task_id": e.from_task_id,
            "to_task_id": e.to_task_id,
            "type": e.type,
        }
        for e in dep_result.scalars().all()
    ]
    
    # Compute critical path
    # Simple longest-path calculation
    task_map = {t["id"]: t for t in tasks_data}
    task_ids = [t["id"] for t in tasks_data]
    blocking_edges = [e for e in edges_data if e["type"] == "blocks"]
    
    # Topological sort (Kahn's)
    in_degree = {tid: 0 for tid in task_ids}
    adj: dict[str, list[str]] = {tid: [] for tid in task_ids}
    for e in blocking_edges:
        if e["from_task_id"] in adj:
            adj[e["from_task_id"]].append(e["to_task_id"])
            in_degree[e["to_task_id"]] = in_degree.get(e["to_task_id"], 0) + 1
    
    queue = [tid for tid, d in in_degree.items() if d == 0]
    sorted_ids = []
    while queue:
        node = queue.pop(0)
        sorted_ids.append(node)
        for neighbor in adj.get(node, []):
            in_degree[neighbor] -= 1
            if in_degree[neighbor] == 0:
                queue.append(neighbor)
    
    # Longest path via DP
    dist = {tid: 0.0 for tid in task_ids}
    prev_map: dict[str, str | None] = {tid: None for tid in task_ids}
    for node in sorted_ids:
        for neighbor in adj.get(node, []):
            hours = task_map.get(neighbor, {}).get("estimated_hours") or 1
            if dist[node] + hours > dist[neighbor]:
                dist[neighbor] = dist[node] + hours
                prev_map[neighbor] = node
    
    # Trace critical path
    max_node = max(dist, key=lambda x: dist[x]) if dist else None
    critical_path = []
    current = max_node
    while current:
        critical_path.insert(0, current)
        current = prev_map.get(current)
    
    return {
        "nodes": tasks_data,
        "edges": edges_data,
        "critical_path": critical_path,
        "topological_order": sorted_ids,
    }


# ══════════════════════════════════════════════════════════════════════════
# WORKFLOW ENDPOINTS
# ══════════════════════════════════════════════════════════════════════════

@router.post("/{project_id}/workflows")
async def create_workflow(project_id: str, req: CreateWorkflowRequest, session: AsyncSession = Depends(get_async_session)):
    """Add a workflow (pipeline mapping) to a project."""
    logger.debug(f"Creating workflow: project_id={project_id}, name={req.name}, pipeline={req.pipelineId}")
    await get_project_or_404(session, project_id)
    
    # If setting as default, unset existing default
    if req.isDefault:
        await session.execute(
            update(ProjectWorkflow)
            .where(ProjectWorkflow.project_id == project_id)
            .values(is_default=False)
        )
    
    workflow = ProjectWorkflow(
        id=gen_id("wf_"),
        project_id=project_id,
        name=req.name,
        pipeline_id=req.pipelineId,
        is_default=req.isDefault,
        task_filter=json.dumps(req.taskFilter),
        trigger=req.trigger,
    )
    session.add(workflow)
    await session.commit()
    
    return {"id": workflow.id, "name": req.name, "pipeline_id": req.pipelineId}


@router.get("/{project_id}/workflows")
async def list_workflows(project_id: str, session: AsyncSession = Depends(get_async_session)):
    """List workflows for a project."""
    logger.debug(f"Listing workflows: project_id={project_id}")
    await get_project_or_404(session, project_id)
    
    result = await session.execute(
        select(ProjectWorkflow)
        .where(ProjectWorkflow.project_id == project_id)
    )
    workflows = result.scalars().all()
    return [_serialize_workflow(w) for w in workflows]


@router.put("/{project_id}/workflows/{workflow_id}")
async def update_workflow(project_id: str, workflow_id: str, req: UpdateWorkflowRequest, session: AsyncSession = Depends(get_async_session)):
    """Update a workflow."""
    logger.debug(f"Updating workflow: project_id={project_id}, workflow_id={workflow_id}")
    await get_project_or_404(session, project_id)
    
    result = await session.execute(
        select(ProjectWorkflow)
        .where(ProjectWorkflow.id == workflow_id, ProjectWorkflow.project_id == project_id)
    )
    workflow = result.scalar_one_or_none()
    if not workflow:
        raise HTTPException(status_code=404, detail="Workflow not found")
    
    if req.name is not None:
        workflow.name = req.name
    if req.pipelineId is not None:
        workflow.pipeline_id = req.pipelineId
    if req.taskFilter is not None:
        workflow.task_filter = json.dumps(req.taskFilter)
    if req.trigger is not None:
        workflow.trigger = req.trigger
    
    if req.isDefault is not None:
        if req.isDefault:
            # Unset other defaults
            await session.execute(
                update(ProjectWorkflow)
                .where(ProjectWorkflow.project_id == project_id)
                .values(is_default=False)
            )
            workflow.is_default = True
        else:
            workflow.is_default = False
    
    await session.commit()
    
    return {"status": "updated"}


@router.delete("/{project_id}/workflows/{workflow_id}")
async def delete_workflow(project_id: str, workflow_id: str, session: AsyncSession = Depends(get_async_session)):
    """Delete a workflow."""
    logger.debug(f"Deleting workflow: project_id={project_id}, workflow_id={workflow_id}")
    result = await session.execute(
        delete(ProjectWorkflow)
        .where(ProjectWorkflow.id == workflow_id, ProjectWorkflow.project_id == project_id)
    )
    await session.commit()
    
    return {"status": "deleted"}


# ══════════════════════════════════════════════════════════════════════════
# EXECUTION ENDPOINTS
# ══════════════════════════════════════════════════════════════════════════

class ExecuteTaskRequest(BaseModel):
    workflowId: Optional[str] = None  # Override the task's assigned workflow
    pipelineId: Optional[str] = None  # Direct pipeline override
    context: Optional[str] = None     # Additional context for the run

@router.post("/{project_id}/tasks/{task_id}/execute")
async def execute_task(project_id: str, task_id: str, req: ExecuteTaskRequest, session: AsyncSession = Depends(get_async_session)):
    """Execute a task by starting a pipeline run for it."""
    logger.debug(f"Executing task: project_id={project_id}, task_id={task_id}, pipeline_override={req.pipelineId}")
    task = await get_task_or_404(session, project_id, task_id)
    
    # Check task is in an executable state
    if task.status not in ('ready', 'backlog', 'planning'):
        raise HTTPException(
            status_code=400, 
            detail=f"Cannot execute task in '{task.status}' status. Must be ready, backlog, or planning."
        )
    
    # Determine which pipeline to use (priority order)
    pipeline_id = req.pipelineId  # 1. Direct override
    
    if not pipeline_id:
        pipeline_id = task.pipeline_id  # 2. Task-level
    
    if not pipeline_id:
        # 3. Workflow lookup (legacy)
        workflow_id = req.workflowId or task.workflow_id
        if workflow_id:
            wf_result = await session.execute(
                select(ProjectWorkflow.pipeline_id)
                .where(ProjectWorkflow.id == workflow_id, ProjectWorkflow.project_id == project_id)
            )
            pipeline_id = wf_result.scalar_one_or_none()
    
    if not pipeline_id:
        # 4. Project default pipeline
        project = await get_project_or_404(session, project_id)
        pipeline_id = project.default_pipeline_id
    
    if not pipeline_id:
        # 5. Legacy default workflow
        wf_result = await session.execute(
            select(ProjectWorkflow.pipeline_id)
            .where(ProjectWorkflow.project_id == project_id, ProjectWorkflow.is_default == True)
            .limit(1)
        )
        pipeline_id = wf_result.scalar_one_or_none()
    
    if not pipeline_id:
        raise HTTPException(
            status_code=400,
            detail="No pipeline assigned. Set a default pipeline for this project or select one when executing."
        )
    
    # Validate pipeline exists
    if not _validate_pipeline_exists(pipeline_id):
        raise HTTPException(status_code=404, detail=f"Pipeline '{pipeline_id}' not found")
    
    # Execute the task using shared helper
    result = await _execute_single_task(session, project_id, task, pipeline_id, req.context)
    
    return {
        "status": "executing",
        **result
    }


@router.post("/{project_id}/execute-ready")
async def execute_ready_tasks(project_id: str, max_tasks: int = 5, session: AsyncSession = Depends(get_async_session)):
    """Execute all ready tasks in a project (up to max_tasks).
    
    Uses each task's assigned workflow/pipeline, or the project default.
    Respects agent concurrency (won't assign more than one task to the same agent simultaneously).
    """
    logger.debug(f"Executing ready tasks: project_id={project_id}, max_tasks={max_tasks}")
    project = await get_project_or_404(session, project_id)
    
    # Get ready tasks
    result = await session.execute(
        select(Task)
        .where(Task.project_id == project_id, Task.status == 'ready')
        .order_by(Task.priority, Task.column_position)
        .limit(max_tasks)
    )
    ready_tasks = result.scalars().all()
    
    if not ready_tasks:
        return {"status": "no_ready_tasks", "executed": 0}
    
    # Check which agents are currently busy (have in_progress tasks)
    busy_result = await session.execute(
        select(Task.assigned_agent)
        .where(
            Task.project_id == project_id,
            Task.status == 'in_progress',
            Task.assigned_agent.isnot(None)
        )
        .distinct()
    )
    busy_agents = {row[0] for row in busy_result.all() if row[0]}
    
    # Get default workflow
    default_wf_result = await session.execute(
        select(ProjectWorkflow.id, ProjectWorkflow.pipeline_id)
        .where(ProjectWorkflow.project_id == project_id, ProjectWorkflow.is_default == True)
        .limit(1)
    )
    default_wf = default_wf_result.first()
    
    # Get all workflows for tag-based matching
    all_wf_result = await session.execute(
        select(ProjectWorkflow)
        .where(ProjectWorkflow.project_id == project_id)
    )
    all_workflows = all_wf_result.scalars().all()
    
    executed = []
    skipped = []
    
    for task in ready_tasks:
        # Skip if assigned agent is busy
        if task.assigned_agent and task.assigned_agent in busy_agents:
            skipped.append({"task_id": task.id, "reason": f"Agent {task.assigned_agent} is busy"})
            continue
        
        # Determine pipeline (priority order)
        pipeline_id = task.pipeline_id  # 1. Task-level pipeline
        
        # 2. Task's explicit workflow
        if not pipeline_id and task.workflow_id:
            wf_result = await session.execute(
                select(ProjectWorkflow.pipeline_id)
                .where(ProjectWorkflow.id == task.workflow_id)
            )
            pipeline_id = wf_result.scalar_one_or_none()
        
        # 3. Tag-based workflow matching
        if not pipeline_id and task.tags:
            task_tags = json.loads(task.tags) if task.tags else []
            for wf in all_workflows:
                filter_tags = json.loads(wf.task_filter).get("tags", []) if wf.task_filter else []
                if filter_tags and any(tag in task_tags for tag in filter_tags):
                    pipeline_id = wf.pipeline_id
                    break
        
        # 4. Project default pipeline
        if not pipeline_id:
            pipeline_id = project.default_pipeline_id
        
        # 5. Legacy default workflow
        if not pipeline_id and default_wf:
            pipeline_id = default_wf[1]
        
        if not pipeline_id:
            skipped.append({"task_id": task.id, "reason": "No pipeline assigned"})
            continue
        
        # Validate pipeline exists
        if not _validate_pipeline_exists(pipeline_id):
            skipped.append({"task_id": task.id, "reason": f"Pipeline '{pipeline_id}' not found"})
            continue
        
        # Execute the task using shared helper
        try:
            result = await _execute_single_task(session, project_id, task, pipeline_id, context=None)
            executed.append(result)
            
            # Mark agent as busy
            if task.assigned_agent:
                busy_agents.add(task.assigned_agent)
                
        except Exception as e:
            skipped.append({"task_id": task.id, "reason": str(e)})
    
    logger.debug(f"Execute ready tasks result: project_id={project_id}, executed={len(executed)}, skipped={len(skipped)}")
    
    return {
        "status": "executed",
        "executed": len(executed),
        "skipped": len(skipped),
        "tasks": executed,
        "skipped_tasks": skipped,
    }


# ══════════════════════════════════════════════════════════════════════════
# RUN COMPLETION WEBHOOK — Update task when its run completes/fails
# ══════════════════════════════════════════════════════════════════════════

@router.post("/{project_id}/tasks/{task_id}/run-completed")
async def task_run_completed(project_id: str, task_id: str, run_id: str, status: str, session: AsyncSession = Depends(get_async_session)):
    """Called when a pipeline run linked to a task completes or fails.
    
    This endpoint is meant to be called by the engine or an event listener.
    Updates the task status and triggers cascade readiness checks.
    """
    logger.debug(f"Task run completed: project_id={project_id}, task_id={task_id}, run_id={run_id}, status={status}")
    now = now_ms()
    task = await get_task_or_404(session, project_id, task_id)
    
    if status == "completed":
        new_status = "done"
    elif status == "failed":
        new_status = "failed"
    else:
        return {"status": "ignored", "reason": f"Unknown run status: {status}"}
    
    # Find appropriate column
    col_result = await session.execute(
        select(KanbanColumn)
        .where(KanbanColumn.project_id == project_id)
        .order_by(KanbanColumn.position)
    )
    target_col = None
    for col in col_result.scalars().all():
        statuses = json.loads(col.task_statuses) if col.task_statuses else []
        if new_status in statuses:
            target_col = col
            break
    
    # Update task
    task.status = new_status
    task.run_id = None  # Clear active run
    task.updated_at = now
    if new_status == "done":
        task.completed_at = now
    if target_col:
        task.column_id = target_col.id
    
    # Update task_runs record
    await session.execute(
        update(TaskRun)
        .where(TaskRun.task_id == task_id, TaskRun.run_id == run_id)
        .values(status=status, completed_at=now)
    )
    
    await session.commit()
    
    # Trigger cascade readiness
    await _recompute_task_readiness(session, project_id, task_id, new_status)
    
    event_type = "TASK_EXECUTION_COMPLETED" if new_status == "done" else "TASK_EXECUTION_FAILED"
    await _publish_event(event_type, {
        "projectId": project_id,
        "taskId": task_id,
        "runId": run_id,
        "status": new_status,
    })
    
    return {"status": "updated", "task_status": new_status}


# ══════════════════════════════════════════════════════════════════════════
# AI PLANNING
# ══════════════════════════════════════════════════════════════════════════

@router.post("/{project_id}/plan")
async def plan_project(project_id: str, req: PlanProjectRequest, session: AsyncSession = Depends(get_async_session)):
    """Start an AI planning pipeline to decompose the project into tasks.
    
    The planning pipeline will:
    1. Analyze the project description
    2. Decompose into tasks with dependencies
    3. Auto-import results into the project's kanban board when complete
    
    The run's output (validated_tasks_json or task_breakdown_json) will be
    automatically imported when the run completes.
    """
    logger.debug(f"Starting AI planning: project_id={project_id}, pipeline={req.pipelineId}")
    now = now_ms()
    project = await get_project_or_404(session, project_id)
    
    # Validate pipeline exists
    if not _validate_pipeline_exists(req.pipelineId):
        raise HTTPException(status_code=404, detail=f"Planning pipeline '{req.pipelineId}' not found")
    
    # Create a planning run
    run_id = str(uuid.uuid4())
    task_desc = f"Plan project: {project.name}\n\n{project.description or ''}"
    if req.context:
        task_desc += f"\n\nAdditional context:\n{req.context}"
    
    # Store project metadata in human_context so the planning pipeline can use template variables
    human_context = json.dumps({
        "project_id": project_id,
        "project_name": project.name,
        "project_description": project.description or "",
        "planning_run": True,  # Flag to identify this as a planning run
        "additional_context": req.context,
    })
    
    from app.models import Run
    run = Run(
        id=run_id,
        pipeline_id=req.pipelineId,
        task_description=task_desc,
        status="pending",
        outputs="{}",
        human_context=human_context,
        created_at=now,
        updated_at=now,
    )
    session.add(run)
    await session.commit()
    
    # Publish to Redis for engine to pick up
    if dependencies.redis_client:
        try:
            logger.debug(f"Publishing planning run to Redis: run_id={run_id}, pipeline_id={req.pipelineId}")
            await dependencies.redis_client.xadd(
                "djinnbot:events:new_runs",
                {"run_id": run_id, "pipeline_id": req.pipelineId}
            )
        except Exception as e:
            logger.warning(f"Failed to publish planning run to Redis: {e}")
        
        await _publish_event("PROJECT_PLANNING_STARTED", {
            "projectId": project_id,
            "runId": run_id,
            "pipelineId": req.pipelineId,
        })
    
    return {
        "status": "planning_started",
        "project_id": project_id,
        "run_id": run_id,
        "pipeline_id": req.pipelineId,
    }


# ══════════════════════════════════════════════════════════════════════════
# TIMELINE / GANTT
# ══════════════════════════════════════════════════════════════════════════

@router.get("/{project_id}/timeline")
async def get_project_timeline(project_id: str, hours_per_day: float = 8.0, session: AsyncSession = Depends(get_async_session)):
    """Compute a Gantt-style timeline for all tasks in the project.
    
    Uses dependency-aware forward scheduling:
    - Tasks with no dependencies start at project creation time
    - Tasks with dependencies start after all deps complete
    - Duration is based on estimated_hours / hours_per_day
    - Returns scheduled start/end for each task, plus overall project timeline
    """
    logger.debug(f"Computing timeline: project_id={project_id}, hours_per_day={hours_per_day}")
    now = now_ms()
    project = await get_project_or_404(session, project_id)
    
    # Get all tasks
    result = await session.execute(
        select(Task)
        .where(Task.project_id == project_id)
        .order_by(Task.priority, Task.column_position)
    )
    tasks = result.scalars().all()
    
    if not tasks:
        return {
            "tasks": [], 
            "project_start": project.created_at, 
            "project_end": project.created_at, 
            "total_hours": 0, 
            "critical_path": []
        }
    
    task_map = {t.id: t for t in tasks}
    
    # Get all dependency edges
    edge_result = await session.execute(
        select(DependencyEdge.from_task_id, DependencyEdge.to_task_id)
        .where(DependencyEdge.project_id == project_id)
    )
    edges = edge_result.all()
    
    # Build adjacency: task_deps[task_id] = list of task IDs it depends on
    task_deps = {t.id: [] for t in tasks}
    task_dependents = {t.id: [] for t in tasks}
    for from_id, to_id in edges:
        if to_id in task_deps:
            task_deps[to_id].append(from_id)
        if from_id in task_dependents:
            task_dependents[from_id].append(to_id)
    
    project_start = project.created_at
    ms_per_day = 86400000  # 24h in ms
    
    # Forward scheduling via topological order
    scheduled = {}
    
    # Kahn's algorithm for topological sort
    in_degree = {t.id: len(task_deps[t.id]) for t in tasks}
    queue = [tid for tid, deg in in_degree.items() if deg == 0]
    topo_order = []
    
    while queue:
        # Sort by priority for consistent ordering
        queue.sort(key=lambda tid: (task_map[tid].priority or "P2", tid))
        tid = queue.pop(0)
        topo_order.append(tid)
        for dep_tid in task_dependents.get(tid, []):
            in_degree[dep_tid] -= 1
            if in_degree[dep_tid] == 0:
                queue.append(dep_tid)
    
    # Handle tasks not in topo_order (cycles — shouldn't happen but be safe)
    for t in tasks:
        if t.id not in topo_order:
            topo_order.append(t.id)
    
    for tid in topo_order:
        task = task_map[tid]
        hours = task.estimated_hours or 4  # default 4h if not set
        duration_days = hours / hours_per_day
        duration_ms = int(duration_days * ms_per_day)
        
        # If task is already done, use actual dates
        if task.status == "done" and task.completed_at:
            actual_start = task.created_at or project_start
            actual_end = task.completed_at
            scheduled[tid] = {
                "start": actual_start,
                "end": actual_end,
                "duration_days": round((actual_end - actual_start) / ms_per_day, 1),
                "actual": True,
            }
            continue
        
        # Compute earliest start: max(end of all deps)
        if task_deps[tid]:
            dep_ends = [scheduled[dep_id]["end"] for dep_id in task_deps[tid] if dep_id in scheduled]
            earliest_start = max(dep_ends) if dep_ends else project_start
        else:
            earliest_start = project_start
        
        scheduled[tid] = {
            "start": earliest_start,
            "end": earliest_start + duration_ms,
            "duration_days": round(duration_days, 1),
            "actual": False,
        }
    
    # Build critical path (longest path through the graph)
    critical_path = []
    if scheduled:
        project_end = max(s["end"] for s in scheduled.values())
        
        # Trace back from the task with the latest end time
        latest_task = max(scheduled.keys(), key=lambda tid: scheduled[tid]["end"])
        path = [latest_task]
        current = latest_task
        while task_dependents.get(current):
            # Pick the dep with the latest end time
            prev = max(task_dependents[current], key=lambda tid: scheduled.get(tid, {}).get("end", 0))
            path.append(prev)
            current = prev
        critical_path = list(reversed(path))
    else:
        project_end = project_start
    
    # Build response
    timeline_tasks = []
    for t in tasks:
        sched = scheduled.get(t.id, {"start": project_start, "end": project_start, "duration_days": 0, "actual": False})
        timeline_tasks.append({
            "id": t.id,
            "title": t.title,
            "status": t.status,
            "priority": t.priority,
            "assigned_agent": t.assigned_agent,
            "tags": json.loads(t.tags) if t.tags else [],
            "estimated_hours": t.estimated_hours,
            "dependencies": task_deps.get(t.id, []),
            "scheduled_start": sched["start"],
            "scheduled_end": sched["end"],
            "duration_days": sched["duration_days"],
            "actual": sched.get("actual", False),
            "is_critical": t.id in critical_path,
        })
    
    total_hours = sum(t.estimated_hours or 4 for t in tasks)
    
    return {
        "tasks": timeline_tasks,
        "project_start": project_start,
        "project_end": project_end,
        "total_hours": total_hours,
        "total_days": round(total_hours / hours_per_day, 1),
        "critical_path": critical_path,
        "hours_per_day": hours_per_day,
    }


# ══════════════════════════════════════════════════════════════════════════
# BULK IMPORT (for AI planner output)
# ══════════════════════════════════════════════════════════════════════════

@router.post("/{project_id}/import")
async def bulk_import_tasks(project_id: str, req: BulkImportTasksRequest, session: AsyncSession = Depends(get_async_session)):
    """Import tasks from AI planner output. Validates dependency graph before importing."""
    logger.debug(f"Bulk importing tasks: project_id={project_id}, count={len(req.tasks)}")
    now = now_ms()
    await get_project_or_404(session, project_id)
    
    # Get backlog column
    result = await session.execute(
        select(KanbanColumn)
        .where(KanbanColumn.project_id == project_id)
        .order_by(KanbanColumn.position)
        .limit(1)
    )
    backlog_col = result.scalar_one_or_none()
    if not backlog_col:
        raise HTTPException(status_code=500, detail="Project has no columns")
    
    # First pass: create task ID mapping (title → id)
    title_to_id: dict[str, str] = {}
    task_data: list[dict] = []
    
    for i, t in enumerate(req.tasks):
        task_id = gen_id("task_")
        title = t.get("title", f"Task {i+1}")
        title_to_id[title] = task_id
        task_data.append({
            "id": task_id,
            "title": title,
            "description": t.get("description", ""),
            "priority": t.get("priority", "P2"),
            "tags": t.get("tags", []),
            "estimated_hours": t.get("estimatedHours"),
            "dependencies": t.get("dependencies", []),  # title refs
        })
    
    # Validate dependency graph before inserting anything
    edges_to_create = []
    for td in task_data:
        for dep_title in td["dependencies"]:
            if dep_title not in title_to_id:
                raise HTTPException(
                    status_code=400,
                    detail=f"Task '{td['title']}' depends on unknown task '{dep_title}'"
                )
            edges_to_create.append({
                "from": title_to_id[dep_title],
                "to": td["id"],
                "type": "blocks",
            })
    
    # Check for cycles
    all_ids = [td["id"] for td in task_data]
    # Build adj list
    adj_check: dict[str, list[str]] = {tid: [] for tid in all_ids}
    in_deg: dict[str, int] = {tid: 0 for tid in all_ids}
    for e in edges_to_create:
        adj_check[e["from"]].append(e["to"])
        in_deg[e["to"]] += 1
    
    q = [tid for tid, d in in_deg.items() if d == 0]
    count = 0
    while q:
        n = q.pop(0)
        count += 1
        for nb in adj_check.get(n, []):
            in_deg[nb] -= 1
            if in_deg[nb] == 0:
                q.append(nb)
    
    if count != len(all_ids):
        raise HTTPException(status_code=400, detail="Import rejected: dependency graph contains a cycle")
    
    # Insert tasks
    for i, td in enumerate(task_data):
        task = Task(
            id=td["id"],
            project_id=project_id,
            title=td["title"],
            description=td["description"],
            status="backlog",
            priority=td["priority"],
            tags=json.dumps(td["tags"]),
            estimated_hours=td["estimated_hours"],
            column_id=backlog_col.id,
            column_position=i,
            task_metadata="{}",
            created_at=now,
            updated_at=now,
        )
        session.add(task)
    
    # Insert dependency edges
    for edge in edges_to_create:
        dep = DependencyEdge(
            id=gen_id("dep_"),
            project_id=project_id,
            from_task_id=edge["from"],
            to_task_id=edge["to"],
            type=edge["type"],
        )
        session.add(dep)
    
    await session.commit()
    
    await _publish_event("TASKS_IMPORTED", {"projectId": project_id, "count": len(task_data)})
    
    return {
        "status": "imported",
        "tasks_created": len(task_data),
        "dependencies_created": len(edges_to_create),
        "task_ids": {td["title"]: td["id"] for td in task_data},
        "title_to_id": title_to_id,  # Return mapping for subtask import
    }


async def bulk_import_subtasks(project_id: str, parent_title_to_id: dict, subtask_list: list, session: AsyncSession):
    """Import subtasks, linking them to parent tasks by title."""
    logger.debug(f"Bulk importing subtasks: project_id={project_id}, count={len(subtask_list)}")
    now = now_ms()
    
    # Get backlog column
    result = await session.execute(
        select(KanbanColumn)
        .where(KanbanColumn.project_id == project_id)
        .order_by(KanbanColumn.position)
        .limit(1)
    )
    backlog_col = result.scalar_one_or_none()
    backlog_col_id = backlog_col.id if backlog_col else None
    
    # Map subtask titles to IDs
    title_to_id = {}
    subtask_data = []
    
    for i, st in enumerate(subtask_list):
        subtask_id = gen_id("task_")
        title = st.get("title", f"Subtask {i+1}")
        parent_title = st.get("parentTaskTitle", "")
        parent_id = parent_title_to_id.get(parent_title)
        
        if not parent_id:
            logger.warning(f"Unknown parent '{parent_title}' for subtask '{title}'")
            continue
        
        title_to_id[title] = subtask_id
        subtask_data.append({
            "id": subtask_id,
            "title": title,
            "description": st.get("description", ""),
            "priority": st.get("priority", "P2"),
            "tags": st.get("tags", []),
            "estimated_hours": st.get("estimatedHours"),
            "dependencies": st.get("dependencies", []),
            "parent_task_id": parent_id,
        })
    
    # Insert subtasks
    for i, td in enumerate(subtask_data):
        task = Task(
            id=td["id"],
            project_id=project_id,
            title=td["title"],
            description=td["description"],
            status="backlog",
            priority=td["priority"],
            parent_task_id=td["parent_task_id"],
            tags=json.dumps(td["tags"]),
            estimated_hours=td["estimated_hours"],
            column_id=backlog_col_id,
            column_position=i + 1000,
            task_metadata="{}",
            created_at=now,
            updated_at=now,
        )
        session.add(task)
    
    # Insert dependency edges among subtasks
    for td in subtask_data:
        for dep_title in td["dependencies"]:
            dep_id = title_to_id.get(dep_title)
            if dep_id:
                edge = DependencyEdge(
                    id=gen_id("dep_"),
                    project_id=project_id,
                    from_task_id=dep_id,
                    to_task_id=td["id"],
                    type="blocks",
                )
                session.add(edge)
    
    await session.commit()
    return {"subtasks_created": len(subtask_data)}


# ══════════════════════════════════════════════════════════════════════════
# AGENT ASSIGNMENT ENDPOINTS
# ══════════════════════════════════════════════════════════════════════════

@router.post("/{project_id}/agents")
async def assign_agent_to_project(project_id: str, req: AssignAgentRequest, session: AsyncSession = Depends(get_async_session)):
    """
    Assign an agent to a project with a role.
    
    Roles:
    - lead: Primary agent, can assign tasks and run pipelines
    - member: Standard team member, can execute tasks
    - reviewer: Reviews completed work
    """
    logger.debug(f"Assigning agent: project_id={project_id}, agent_id={req.agentId}, role={req.role}")
    now = now_ms()
    
    # Verify project exists
    await get_project_or_404(session, project_id)
    
    # Check if already assigned
    result = await session.execute(
        select(ProjectAgentModel)
        .where(ProjectAgentModel.project_id == project_id, ProjectAgentModel.agent_id == req.agentId)
    )
    if result.scalar_one_or_none():
        raise HTTPException(
            status_code=400, 
            detail=f"Agent {req.agentId} is already assigned to this project"
        )
    
    # If assigning as lead, demote existing lead to member
    if req.role == "lead":
        await session.execute(
            update(ProjectAgentModel)
            .where(ProjectAgentModel.project_id == project_id, ProjectAgentModel.role == "lead")
            .values(role="member")
        )
    
    # Create assignment
    agent = ProjectAgentModel(
        project_id=project_id,
        agent_id=req.agentId,
        role=req.role,
        assigned_at=now,
        assigned_by="user",
    )
    session.add(agent)
    await session.commit()
    
    await _publish_event("AGENT_ASSIGNED", {
        "projectId": project_id,
        "agentId": req.agentId,
        "role": req.role
    })
    
    return {
        "status": "assigned",
        "project_id": project_id,
        "agent_id": req.agentId,
        "role": req.role,
        "assigned_at": now
    }


@router.get("/{project_id}/agents")
async def list_project_agents(project_id: str, session: AsyncSession = Depends(get_async_session)):
    """List all agents assigned to a project."""
    logger.debug(f"Listing project agents: project_id={project_id}")
    await get_project_or_404(session, project_id)
    
    result = await session.execute(
        select(ProjectAgentModel)
        .where(ProjectAgentModel.project_id == project_id)
        .order_by(ProjectAgentModel.role, ProjectAgentModel.assigned_at)
    )
    agents = result.scalars().all()
    
    return [
        {
            "project_id": a.project_id,
            "agent_id": a.agent_id,
            "role": a.role,
            "assigned_at": a.assigned_at,
            "assigned_by": a.assigned_by,
        }
        for a in agents
    ]


@router.put("/{project_id}/agents/{agent_id}")
async def update_agent_role(project_id: str, agent_id: str, req: UpdateAgentRoleRequest, session: AsyncSession = Depends(get_async_session)):
    """Update an agent's role on a project."""
    logger.debug(f"Updating agent role: project_id={project_id}, agent_id={agent_id}, new_role={req.role}")
    await get_project_or_404(session, project_id)
    
    # Verify assignment exists
    result = await session.execute(
        select(ProjectAgentModel)
        .where(ProjectAgentModel.project_id == project_id, ProjectAgentModel.agent_id == agent_id)
    )
    agent = result.scalar_one_or_none()
    if not agent:
        raise HTTPException(
            status_code=404,
            detail=f"Agent {agent_id} is not assigned to this project"
        )
    
    # If promoting to lead, demote existing lead
    if req.role == "lead":
        await session.execute(
            update(ProjectAgentModel)
            .where(ProjectAgentModel.project_id == project_id, ProjectAgentModel.role == "lead", ProjectAgentModel.agent_id != agent_id)
            .values(role="member")
        )
    
    # Update role
    agent.role = req.role
    await session.commit()
    
    await _publish_event("AGENT_ROLE_UPDATED", {
        "projectId": project_id,
        "agentId": agent_id,
        "role": req.role
    })
    
    return {"status": "updated", "role": req.role}


@router.delete("/{project_id}/agents/{agent_id}")
async def remove_agent_from_project(project_id: str, agent_id: str, session: AsyncSession = Depends(get_async_session)):
    """Remove an agent from a project."""
    logger.debug(f"Removing agent from project: project_id={project_id}, agent_id={agent_id}")
    await get_project_or_404(session, project_id)
    
    result = await session.execute(
        delete(ProjectAgentModel)
        .where(ProjectAgentModel.project_id == project_id, ProjectAgentModel.agent_id == agent_id)
    )
    await session.commit()
    
    if result.rowcount == 0:
        raise HTTPException(
            status_code=404,
            detail=f"Agent {agent_id} is not assigned to this project"
        )
    
    await _publish_event("AGENT_REMOVED", {
        "projectId": project_id,
        "agentId": agent_id
    })
    
    return {"status": "removed"}
