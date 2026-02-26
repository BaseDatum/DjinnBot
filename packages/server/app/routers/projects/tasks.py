"""Task and column management endpoints."""

import json
from typing import Optional
from fastapi import APIRouter, HTTPException, Query, Depends
from sqlalchemy import select, update, func, delete, or_
from sqlalchemy.ext.asyncio import AsyncSession

from app.database import get_async_session
from app.models import (
    Project,
    Task,
    KanbanColumn,
    DependencyEdge,
    TaskRun,
    ProjectWorkflow,
)
from app.utils import now_ms, gen_id
from app.logging_config import get_logger
from ._common import (
    get_project_or_404,
    get_task_or_404,
    _serialize_task,
    _serialize_column,
    _publish_event,
    CreateTaskRequest,
    UpdateTaskRequest,
    MoveTaskRequest,
    CreateColumnRequest,
    UpdateColumnRequest,
    VALID_WORK_TYPES,
)

# Import helper from execution module (avoids circular import)
from .execution import _recompute_task_readiness

logger = get_logger(__name__)
router = APIRouter()


# ══════════════════════════════════════════════════════════════════════════
# WORK TYPE AUTO-INFERENCE
# ══════════════════════════════════════════════════════════════════════════


def infer_work_type(
    title: str, tags: list[str], description: str = ""
) -> Optional[str]:
    """Auto-infer task work type from title, tags, and description.

    Returns None if no confident match — agents or users can classify later.
    Uses simple keyword heuristics as a fallback when no explicit type is set.
    """
    title_lower = title.lower()
    tags_lower = {t.lower() for t in tags}
    desc_lower = description.lower()[:500]  # Only check first 500 chars

    # Tag-based inference (highest confidence)
    tag_mapping = {
        "bugfix": "bugfix",
        "bug": "bugfix",
        "fix": "bugfix",
        "hotfix": "bugfix",
        "test": "test",
        "testing": "test",
        "qa": "test",
        "e2e": "test",
        "integration-test": "test",
        "unit-test": "test",
        "refactor": "refactor",
        "refactoring": "refactor",
        "cleanup": "refactor",
        "docs": "docs",
        "documentation": "docs",
        "readme": "docs",
        "infra": "infrastructure",
        "infrastructure": "infrastructure",
        "devops": "infrastructure",
        "ci": "infrastructure",
        "cd": "infrastructure",
        "deploy": "infrastructure",
        "deployment": "infrastructure",
        "design": "design",
        "ux": "design",
        "ui": "design",
        "wireframe": "design",
        "feature": "feature",
    }
    for tag in tags_lower:
        if tag in tag_mapping:
            return tag_mapping[tag]

    # Title-based inference (medium confidence)
    bugfix_patterns = [
        "fix ",
        "fix:",
        "bugfix",
        "bug:",
        "hotfix",
        "patch ",
        "resolve ",
        "repair ",
        "crash ",
        "error in",
        "broken ",
    ]
    if any(p in title_lower for p in bugfix_patterns):
        return "bugfix"

    test_patterns = [
        "add test",
        "write test",
        "integration test",
        "unit test",
        "e2e test",
        "test coverage",
        "test for ",
        "tests for ",
        "add spec",
        "test:",
        "testing ",
    ]
    if any(p in title_lower for p in test_patterns):
        return "test"

    refactor_patterns = [
        "refactor",
        "cleanup",
        "clean up",
        "reorganize",
        "simplify",
        "extract ",
        "rename ",
        "move ",
    ]
    if any(p in title_lower for p in refactor_patterns):
        return "refactor"

    doc_patterns = [
        "document",
        "docs:",
        "readme",
        "update docs",
        "add documentation",
        "api docs",
        "jsdoc",
        "docstring",
    ]
    if any(p in title_lower for p in doc_patterns):
        return "docs"

    infra_patterns = [
        "deploy",
        "ci/cd",
        "pipeline",
        "docker",
        "kubernetes",
        "terraform",
        "ansible",
        "monitoring",
        "alerting",
        "infrastructure",
        "devops",
        "nginx",
        "ssl",
    ]
    if any(p in title_lower for p in infra_patterns):
        return "infrastructure"

    design_patterns = [
        "design ",
        "ux ",
        "ui ",
        "wireframe",
        "mockup",
        "user flow",
        "prototype",
        "design system",
    ]
    if any(p in title_lower for p in design_patterns):
        return "design"

    feature_patterns = [
        "implement ",
        "add ",
        "create ",
        "build ",
        "develop ",
        "new ",
        "feature:",
        "feat:",
    ]
    if any(p in title_lower for p in feature_patterns):
        return "feature"

    # No confident match — return None (unclassified)
    return None


# ══════════════════════════════════════════════════════════════════════════
# COLUMN ENDPOINTS
# ══════════════════════════════════════════════════════════════════════════


@router.post("/{project_id}/columns")
async def create_column(
    project_id: str,
    req: CreateColumnRequest,
    session: AsyncSession = Depends(get_async_session),
):
    """Add a kanban column to a project."""
    logger.debug(f"Creating column: project_id={project_id}, name={req.name}")
    await get_project_or_404(session, project_id)

    # Get max position if not provided
    if req.position is None:
        result = await session.execute(
            select(func.max(KanbanColumn.position)).where(
                KanbanColumn.project_id == project_id
            )
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
async def update_column(
    project_id: str,
    column_id: str,
    req: UpdateColumnRequest,
    session: AsyncSession = Depends(get_async_session),
):
    """Update a kanban column."""
    logger.debug(f"Updating column: project_id={project_id}, column_id={column_id}")
    await get_project_or_404(session, project_id)

    result = await session.execute(
        select(KanbanColumn).where(
            KanbanColumn.id == column_id, KanbanColumn.project_id == project_id
        )
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
async def delete_column(
    project_id: str, column_id: str, session: AsyncSession = Depends(get_async_session)
):
    """Delete a kanban column. Fails if tasks are still in it."""
    logger.debug(f"Deleting column: project_id={project_id}, column_id={column_id}")
    await get_project_or_404(session, project_id)

    # Check for tasks in this column
    result = await session.execute(
        select(func.count(Task.id)).where(Task.column_id == column_id)
    )
    count = result.scalar() or 0
    if count > 0:
        raise HTTPException(
            status_code=400,
            detail=f"Cannot delete column with {count} tasks. Move them first.",
        )

    # Delete the column
    result = await session.execute(
        delete(KanbanColumn).where(
            KanbanColumn.id == column_id, KanbanColumn.project_id == project_id
        )
    )
    await session.commit()

    return {"status": "deleted"}


# ══════════════════════════════════════════════════════════════════════════
# TASK ENDPOINTS
# ══════════════════════════════════════════════════════════════════════════


@router.post("/{project_id}/tasks")
async def create_task(
    project_id: str,
    req: CreateTaskRequest,
    session: AsyncSession = Depends(get_async_session),
):
    """Create a task in a project."""
    logger.debug(
        f"Creating task: project_id={project_id}, title={req.title}, priority={req.priority}"
    )
    now = now_ms()
    project = await get_project_or_404(session, project_id)

    # Determine column and initial status.
    # Load all columns so we can derive the correct status from the column's
    # task_statuses instead of hardcoding status names like "backlog"/"ready".
    cols_result = await session.execute(
        select(KanbanColumn)
        .where(KanbanColumn.project_id == project_id)
        .order_by(KanbanColumn.position)
    )
    all_cols = cols_result.scalars().all()
    if not all_cols:
        raise HTTPException(status_code=500, detail="Project has no columns")

    # Load project status_semantics for semantic column resolution
    semantics = project.status_semantics or {}
    initial_statuses = set(semantics.get("initial", []))

    def _col_statuses(col: KanbanColumn) -> list[str]:
        return json.loads(col.task_statuses) if col.task_statuses else []

    if req.columnId:
        column_id = req.columnId
        # Derive status from the target column's statuses
        target_col = next((c for c in all_cols if c.id == req.columnId), None)
        col_sts = _col_statuses(target_col) if target_col else []
        initial_status = col_sts[0] if col_sts else "backlog"
    else:
        # Find the best column: prefer a "ready" column for tasks without deps,
        # otherwise use the initial/first column.
        first_col = all_cols[0]
        ready_col = None
        initial_col = None

        for col in all_cols:
            sts = _col_statuses(col)
            if "ready" in sts and ready_col is None:
                ready_col = col
            # Find a column whose statuses overlap with semantic initial statuses
            if (
                initial_col is None
                and initial_statuses
                and any(s in initial_statuses for s in sts)
            ):
                initial_col = col

        has_deps = bool(req.parentTaskId)
        if not has_deps and ready_col:
            column_id = ready_col.id
            initial_status = _col_statuses(ready_col)[0]
        elif initial_col:
            column_id = initial_col.id
            initial_status = _col_statuses(initial_col)[0]
        else:
            # Ultimate fallback: first column, first status
            column_id = first_col.id
            col_sts = _col_statuses(first_col)
            initial_status = col_sts[0] if col_sts else "backlog"

    # Get next position in column
    result = await session.execute(
        select(func.max(Task.column_position)).where(Task.column_id == column_id)
    )
    max_pos = result.scalar() or 0
    position = max_pos + 1

    # Resolve workflow → pipeline
    pipeline_id = None
    if req.workflowId:
        wf_result = await session.execute(
            select(ProjectWorkflow.pipeline_id).where(
                ProjectWorkflow.id == req.workflowId
            )
        )
        pipeline_id = wf_result.scalar_one_or_none()

    # Resolve work type: explicit > auto-inferred > None
    work_type = req.workType or infer_work_type(req.title, req.tags, req.description)

    task = Task(
        id=gen_id("task_"),
        project_id=project_id,
        title=req.title,
        description=req.description,
        status=initial_status,
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
        work_type=work_type,
        completed_stages=json.dumps([]),
        created_at=now,
        updated_at=now,
    )
    session.add(task)
    await session.commit()

    await _publish_event(
        "TASK_CREATED",
        {"projectId": project_id, "taskId": task.id, "title": task.title},
    )
    return {
        "id": task.id,
        "title": task.title,
        "status": initial_status,
        "column_id": column_id,
        "work_type": work_type,
    }


@router.get("/{project_id}/tasks")
async def list_tasks(
    project_id: str,
    status: Optional[str] = None,
    priority: Optional[str] = None,
    agent: Optional[str] = None,
    tag: Optional[str] = None,
    session: AsyncSession = Depends(get_async_session),
):
    """List tasks with optional filters."""
    logger.debug(
        f"Listing tasks: project_id={project_id}, status={status}, priority={priority}, agent={agent}, tag={tag}"
    )
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
async def get_task(
    project_id: str, task_id: str, session: AsyncSession = Depends(get_async_session)
):
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
async def update_task(
    project_id: str,
    task_id: str,
    req: UpdateTaskRequest,
    session: AsyncSession = Depends(get_async_session),
):
    """Update task fields."""
    logger.debug(
        f"Updating task: project_id={project_id}, task_id={task_id}, status={req.status}"
    )
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
    await _publish_event(
        event_type, {"projectId": project_id, "taskId": task_id, "status": req.status}
    )
    return {"status": "updated"}


@router.delete("/{project_id}/tasks/{task_id}")
async def delete_task(
    project_id: str, task_id: str, session: AsyncSession = Depends(get_async_session)
):
    """Delete a task and its dependencies."""
    logger.debug(f"Deleting task: project_id={project_id}, task_id={task_id}")
    task = await get_task_or_404(session, project_id, task_id)

    # Delete dependencies
    await session.execute(
        delete(DependencyEdge).where(
            or_(
                DependencyEdge.from_task_id == task_id,
                DependencyEdge.to_task_id == task_id,
            )
        )
    )

    # Delete task runs
    await session.execute(delete(TaskRun).where(TaskRun.task_id == task_id))

    # Delete the task
    await session.delete(task)
    await session.commit()

    return {"status": "deleted"}


@router.post("/{project_id}/tasks/{task_id}/move")
async def move_task(
    project_id: str,
    task_id: str,
    req: MoveTaskRequest,
    session: AsyncSession = Depends(get_async_session),
):
    """Move a task to a different column/position."""
    logger.debug(
        f"Moving task: project_id={project_id}, task_id={task_id}, column={req.columnId}, position={req.position}"
    )
    now = now_ms()
    task = await get_task_or_404(session, project_id, task_id)

    # Check column exists
    col_result = await session.execute(
        select(KanbanColumn).where(
            KanbanColumn.id == req.columnId, KanbanColumn.project_id == project_id
        )
    )
    column = col_result.scalar_one_or_none()
    if not column:
        raise HTTPException(status_code=404, detail=f"Column {req.columnId} not found")

    # Check WIP limit
    if column.wip_limit is not None:
        count_result = await session.execute(
            select(func.count(Task.id)).where(
                Task.column_id == req.columnId, Task.id != task_id
            )
        )
        count = count_result.scalar() or 0
        if count >= column.wip_limit:
            raise HTTPException(
                status_code=400, detail=f"Column WIP limit ({column.wip_limit}) reached"
            )

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

    await _publish_event(
        "TASK_MOVED",
        {"projectId": project_id, "taskId": task_id, "columnId": req.columnId},
    )
    return {"status": "moved", "column_id": req.columnId, "position": req.position}


@router.get("/{project_id}/ready-tasks")
async def get_ready_tasks(
    project_id: str,
    agent_id: Optional[str] = Query(
        None, description="Filter to tasks assigned to this agent or unassigned"
    ),
    limit: int = Query(20, description="Max tasks to return"),
    statuses: Optional[str] = Query(
        None,
        description="Comma-separated task statuses to include (default: backlog,planning,ready)",
    ),
    work_types: Optional[str] = Query(
        None,
        description="Comma-separated work types to include (e.g. feature,bugfix,test). "
        "When set, only tasks with matching work_type are returned.",
    ),
    session: AsyncSession = Depends(get_async_session),
):
    """Get tasks that are ready to execute (all blocking dependencies met).

    Returns tasks in 'backlog', 'planning', or 'ready' status whose blocking
    dependencies are all 'done'.  Optionally filters to tasks assigned to a
    specific agent (or unassigned tasks that agent can claim).

    Tasks already in 'ready' status are included directly without re-checking
    dependencies (they were already validated when transitioned to ready).

    Each task includes:
    - blocking_tasks: tasks this one BLOCKS (downstream dependents) with their current status.
      Used by agents to avoid picking up work that would create a dependency conflict with
      tasks already in flight.
    - in_progress_tasks: tasks already being worked on by agent_id (if provided), returned
      alongside candidates so the agent can reason about parallel independence in one call.
    """
    logger.debug(
        f"Getting ready tasks: project_id={project_id}, agent_id={agent_id}, limit={limit}, statuses={statuses}"
    )
    await get_project_or_404(session, project_id)

    # Parse statuses filter (default: backlog, planning, ready)
    _valid = {
        "backlog",
        "planning",
        "ready",
        "in_progress",
        "review",
        "blocked",
        "done",
        "failed",
    }
    if statuses:
        _requested = {s.strip() for s in statuses.split(",") if s.strip()}
        status_filter = list(_requested & _valid) or ["backlog", "planning", "ready"]
    else:
        status_filter = ["backlog", "planning", "ready"]

    # ── Identify container parents (tasks that have subtasks) ──
    # These are never directly executed — their status is derived from children.
    subtask_parents_result = await session.execute(
        select(Task.parent_task_id)
        .where(Task.project_id == project_id, Task.parent_task_id.isnot(None))
        .distinct()
    )
    container_parent_ids = {row[0] for row in subtask_parents_result.all()}

    # Parse work_types filter
    work_type_filter: list[str] | None = None
    if work_types:
        _requested_types = {s.strip() for s in work_types.split(",") if s.strip()}
        work_type_filter = list(_requested_types & VALID_WORK_TYPES) or None

    # Build base query — include specified status tasks
    query = select(Task).where(
        Task.project_id == project_id,
        Task.status.in_(status_filter),
    )

    # Filter by work type if specified
    if work_type_filter:
        # Include tasks with matching work_type OR null work_type (unclassified)
        query = query.where(
            or_(Task.work_type.in_(work_type_filter), Task.work_type.is_(None))
        )

    # Exclude container parents — they have subtasks and are never directly picked up
    if container_parent_ids:
        query = query.where(Task.id.notin_(container_parent_ids))

    # Filter by agent assignment: tasks assigned to this agent OR unassigned
    if agent_id:
        query = query.where(
            or_(Task.assigned_agent == agent_id, Task.assigned_agent.is_(None))
        )

    # Order by priority (P0 first) then position
    query = query.order_by(Task.priority, Task.column_position)

    result = await session.execute(query)
    candidate_tasks = result.scalars().all()

    # Fetch in-progress tasks for this agent so they appear alongside candidates.
    # This lets the agent reason about parallel independence without extra round-trips.
    in_progress_for_agent: list[dict] = []
    if agent_id:
        ip_result = await session.execute(
            select(Task).where(
                Task.project_id == project_id,
                Task.assigned_agent == agent_id,
                Task.status.in_(["in_progress", "review"]),
            )
        )
        for ip_task in ip_result.scalars().all():
            # Fetch what this in-progress task blocks (downstream dependents)
            downstream_result = await session.execute(
                select(Task.id, Task.title, Task.status)
                .join(DependencyEdge, DependencyEdge.to_task_id == Task.id)
                .where(
                    DependencyEdge.from_task_id == ip_task.id,
                    DependencyEdge.type == "blocks",
                )
            )
            downstream = [
                {"id": r[0], "title": r[1], "status": r[2]}
                for r in downstream_result.all()
            ]
            in_progress_for_agent.append(
                {
                    "id": ip_task.id,
                    "title": ip_task.title,
                    "status": ip_task.status,
                    "priority": ip_task.priority,
                    "blocks": downstream,
                }
            )

    # Statuses that are already "actionable" — no dependency check needed
    actionable_statuses = {"ready", "in_progress", "review"}

    ready = []
    for task in candidate_tasks:
        # Tasks in actionable statuses are included directly (no dep re-check)
        if task.status in actionable_statuses:
            # Fetch downstream tasks this one blocks
            downstream_result = await session.execute(
                select(Task.id, Task.title, Task.status)
                .join(DependencyEdge, DependencyEdge.to_task_id == Task.id)
                .where(
                    DependencyEdge.from_task_id == task.id,
                    DependencyEdge.type == "blocks",
                )
            )
            downstream = [
                {"id": r[0], "title": r[1], "status": r[2]}
                for r in downstream_result.all()
            ]
            ready.append(
                {
                    "id": task.id,
                    "title": task.title,
                    "description": task.description,
                    "status": task.status,
                    "priority": task.priority,
                    "assigned_agent": task.assigned_agent,
                    "tags": json.loads(task.tags) if task.tags else [],
                    "estimated_hours": task.estimated_hours,
                    "work_type": task.work_type,
                    "completed_stages": json.loads(task.completed_stages)
                    if task.completed_stages
                    else [],
                    "blocking_tasks": downstream,
                }
            )
            if len(ready) >= limit:
                break
            continue

        # For backlog/planning/blocked tasks, check all blocking dependencies are done.
        # This includes the task's own deps AND (for subtasks) the parent's deps.
        dep_result = await session.execute(
            select(Task.status)
            .join(DependencyEdge, DependencyEdge.from_task_id == Task.id)
            .where(
                DependencyEdge.to_task_id == task.id, DependencyEdge.type == "blocks"
            )
        )
        deps = dep_result.all()

        # For subtasks: also check that the parent task's blocking deps are all done.
        # This implements implicit cross-level dependency inheritance — subtasks can't
        # start until the parent's upstream blockers are satisfied.
        parent_deps_met = True
        if task.parent_task_id:
            parent_dep_result = await session.execute(
                select(Task.status)
                .join(DependencyEdge, DependencyEdge.from_task_id == Task.id)
                .where(
                    DependencyEdge.to_task_id == task.parent_task_id,
                    DependencyEdge.type == "blocks",
                )
            )
            parent_deps = parent_dep_result.all()
            if parent_deps and not all(status == "done" for (status,) in parent_deps):
                parent_deps_met = False

        if parent_deps_met and (
            not deps or all(status == "done" for (status,) in deps)
        ):
            # Fetch downstream tasks this one blocks
            downstream_result = await session.execute(
                select(Task.id, Task.title, Task.status)
                .join(DependencyEdge, DependencyEdge.to_task_id == Task.id)
                .where(
                    DependencyEdge.from_task_id == task.id,
                    DependencyEdge.type == "blocks",
                )
            )
            downstream = [
                {"id": r[0], "title": r[1], "status": r[2]}
                for r in downstream_result.all()
            ]
            ready.append(
                {
                    "id": task.id,
                    "title": task.title,
                    "description": task.description,
                    "status": task.status,
                    "priority": task.priority,
                    "assigned_agent": task.assigned_agent,
                    "tags": json.loads(task.tags) if task.tags else [],
                    "estimated_hours": task.estimated_hours,
                    "work_type": task.work_type,
                    "completed_stages": json.loads(task.completed_stages)
                    if task.completed_stages
                    else [],
                    "blocking_tasks": downstream,
                }
            )

        if len(ready) >= limit:
            break

    logger.debug(f"Found {len(ready)} ready tasks for project {project_id}")
    return {
        "tasks": ready,
        "in_progress": in_progress_for_agent,
    }
