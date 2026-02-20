"""Task execution engine endpoints."""

import asyncio
import json
import re
from typing import Optional
from fastapi import APIRouter, HTTPException, Depends, Query
from pydantic import BaseModel
from sqlalchemy import select, update, and_
from sqlalchemy.ext.asyncio import AsyncSession

from app.database import get_async_session
from app.models import (
    Project,
    Task,
    KanbanColumn,
    DependencyEdge,
    ProjectWorkflow,
    TaskRun,
    Run,
)
from app import dependencies
from app.utils import now_ms, gen_id
from app.logging_config import get_logger
from app.github_helper import github_helper
from ._common import (
    get_project_or_404,
    get_task_or_404,
    _serialize_task,
    _publish_event,
    _validate_pipeline_exists,
)

logger = get_logger(__name__)
router = APIRouter()


# ══════════════════════════════════════════════════════════════════════════
# PYDANTIC MODELS
# ══════════════════════════════════════════════════════════════════════════


class ExecuteTaskRequest(BaseModel):
    workflowId: Optional[str] = None  # Override the task's assigned workflow
    pipelineId: Optional[str] = None  # Direct pipeline override
    context: Optional[str] = None  # Additional context for the run


class ClaimTaskRequest(BaseModel):
    agentId: str  # Agent claiming the task


# ══════════════════════════════════════════════════════════════════════════
# BRANCH HELPERS
# ══════════════════════════════════════════════════════════════════════════


def _task_branch_name(task_id: str, task_title: str) -> str:
    """Generate a stable, filesystem-safe git branch name for a task.

    Format: feat/{task_id}-{slug}
    Example: feat/task_abc123-implement-oauth-login
    """
    slug = re.sub(r"[^a-z0-9]+", "-", task_title.lower()).strip("-")[:40]
    return f"feat/{task_id}-{slug}" if slug else f"feat/{task_id}"


def _get_task_branch(task: Task) -> Optional[str]:
    """Read the stored git branch from task metadata."""
    try:
        meta = json.loads(task.task_metadata) if task.task_metadata else {}
        return meta.get("git_branch")
    except (json.JSONDecodeError, TypeError):
        return None


def _set_task_branch(task: Task, branch: str) -> None:
    """Write git branch into task metadata (in-place, does not commit)."""
    try:
        meta = json.loads(task.task_metadata) if task.task_metadata else {}
    except (json.JSONDecodeError, TypeError):
        meta = {}
    meta["git_branch"] = branch
    task.task_metadata = json.dumps(meta)


# ══════════════════════════════════════════════════════════════════════════
# HELPER FUNCTIONS
# ══════════════════════════════════════════════════════════════════════════


async def _execute_single_task(
    session: AsyncSession,
    project_id: str,
    task: Task,
    pipeline_id: str,
    context: Optional[str] = None,
) -> dict:
    """Execute a single task by creating a run and updating task status.

    Returns: {"task_id": str, "run_id": str, "pipeline_id": str}
    Raises: HTTPException on error
    """
    logger.debug(
        f"Executing single task: project_id={project_id}, task_id={task.id}, pipeline={pipeline_id}"
    )
    now = now_ms()

    # Create the run
    run_id = gen_id("run_")
    task_desc = (
        f"[Project: {project_id}] [Task: {task.title}]\n\n{task.description or ''}"
    )
    if context:
        task_desc += f"\n\nAdditional context:\n{context}"

    # Create run in DB (same pattern as runs.py start_run)
    # Include project_id so engine can create proper worktree
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
            logger.debug(
                f"Publishing run to Redis: run_id={run_id}, pipeline_id={pipeline_id}"
            )
            await dependencies.redis_client.xadd(
                "djinnbot:events:new_runs",
                {"run_id": run_id, "pipeline_id": pipeline_id},
            )
        except Exception as e:
            logger.warning(f"Failed to publish run to Redis: {e}")

        # Also publish to global events
        await _publish_event(
            "TASK_EXECUTION_STARTED",
            {
                "projectId": project_id,
                "taskId": task.id,
                "runId": run_id,
                "pipelineId": pipeline_id,
            },
        )

    return {
        "task_id": task.id,
        "run_id": run_id,
        "pipeline_id": pipeline_id,
    }


async def _recompute_task_readiness(
    session: AsyncSession, project_id: str, changed_task_id: str, new_status: str
):
    """
    After a task status changes, recompute readiness/blocking for dependent tasks.
    - If changed_task_id is now 'done': check dependents, auto-ready if all deps met
    - If changed_task_id is now 'failed': cascade-block dependents
    - If changed_task_id moves OUT of 'failed': unblock dependents
    """
    logger.debug(
        f"Recomputing task readiness: project_id={project_id}, task_id={changed_task_id}, new_status={new_status}"
    )
    now = now_ms()
    events = []  # Collect events to publish

    if new_status == "done":
        # Find tasks that depend on the completed task (where completed task is from_task_id)
        result = await session.execute(
            select(DependencyEdge.to_task_id).where(
                DependencyEdge.from_task_id == changed_task_id,
                DependencyEdge.project_id == project_id,
                DependencyEdge.type == "blocks",
            )
        )
        dependent_ids = [row[0] for row in result.all()]

        for dep_id in dependent_ids:
            # Check if ALL blocking deps for this task are now done
            dep_result = await session.execute(
                select(DependencyEdge.from_task_id, Task.status)
                .join(Task, DependencyEdge.from_task_id == Task.id)
                .where(
                    DependencyEdge.to_task_id == dep_id, DependencyEdge.type == "blocks"
                )
            )
            blocking_deps = dep_result.all()
            all_done = all(status == "done" for _, status in blocking_deps)

            if all_done:
                # Get current task status
                task_result = await session.execute(
                    select(Task).where(Task.id == dep_id)
                )
                task = task_result.scalar_one_or_none()
                if task and task.status in ("backlog", "planning", "blocked"):
                    # Find the "Ready" column
                    ready_col_result = await session.execute(
                        select(KanbanColumn)
                        .where(KanbanColumn.project_id == project_id)
                        .order_by(KanbanColumn.position)
                    )
                    ready_col = None
                    for col in ready_col_result.scalars().all():
                        statuses = (
                            json.loads(col.task_statuses) if col.task_statuses else []
                        )
                        if "ready" in statuses:
                            ready_col = col
                            break

                    if ready_col:
                        task.status = "ready"
                        task.column_id = ready_col.id
                        task.updated_at = now
                        events.append(
                            (
                                "TASK_STATUS_CHANGED",
                                {
                                    "projectId": project_id,
                                    "taskId": dep_id,
                                    "status": "ready",
                                    "reason": "all_dependencies_met",
                                },
                            )
                        )

    elif new_status == "failed":
        # Cascade: block all downstream tasks (recursive)
        to_block = []
        visited = set()

        async def find_downstream(task_id):
            result = await session.execute(
                select(DependencyEdge.to_task_id).where(
                    DependencyEdge.from_task_id == task_id,
                    DependencyEdge.project_id == project_id,
                    DependencyEdge.type == "blocks",
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
                    if task_status and task_status not in ("done", "failed"):
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
                if "blocked" in statuses:
                    blocked_col = col
                    break

            # If no blocked column, try the Failed column
            if not blocked_col:
                for col in blocked_col_result.scalars().all():
                    statuses = (
                        json.loads(col.task_statuses) if col.task_statuses else []
                    )
                    if "failed" in statuses:
                        blocked_col = col
                        break

            if blocked_col:
                for dep_id in to_block:
                    task_result = await session.execute(
                        select(Task).where(Task.id == dep_id)
                    )
                    task = task_result.scalar_one_or_none()
                    if task:
                        task.status = "blocked"
                        task.column_id = blocked_col.id
                        task.updated_at = now
                        events.append(
                            (
                                "TASK_STATUS_CHANGED",
                                {
                                    "projectId": project_id,
                                    "taskId": dep_id,
                                    "status": "blocked",
                                    "reason": "dependency_failed",
                                },
                            )
                        )

    elif new_status in ("in_progress", "backlog", "planning", "ready"):
        # Task moved out of failed/blocked — re-check if dependents should be unblocked
        # Only unblock tasks that were blocked due to this specific task
        result = await session.execute(
            select(DependencyEdge.to_task_id).where(
                DependencyEdge.from_task_id == changed_task_id,
                DependencyEdge.project_id == project_id,
                DependencyEdge.type == "blocks",
            )
        )
        dependent_ids = [row[0] for row in result.all()]

        for dep_id in dependent_ids:
            task_result = await session.execute(select(Task).where(Task.id == dep_id))
            task = task_result.scalar_one_or_none()
            if task and task.status == "blocked":
                # Check if there are other failed/blocked blocking deps
                dep_result = await session.execute(
                    select(DependencyEdge.from_task_id, Task.status)
                    .join(Task, DependencyEdge.from_task_id == Task.id)
                    .where(
                        DependencyEdge.to_task_id == dep_id,
                        DependencyEdge.type == "blocks",
                    )
                )
                blocking_deps = dep_result.all()
                has_failed = any(
                    status in ("failed", "blocked") for _, status in blocking_deps
                )

                if not has_failed:
                    # Check if all deps are done → ready, otherwise → backlog
                    all_done = all(status == "done" for _, status in blocking_deps)
                    new_task_status = "ready" if all_done else "backlog"

                    # Find appropriate column
                    col_result = await session.execute(
                        select(KanbanColumn)
                        .where(KanbanColumn.project_id == project_id)
                        .order_by(KanbanColumn.position)
                    )
                    target_col = None
                    for col in col_result.scalars().all():
                        statuses = (
                            json.loads(col.task_statuses) if col.task_statuses else []
                        )
                        if new_task_status in statuses:
                            target_col = col
                            break

                    if target_col:
                        task.status = new_task_status
                        task.column_id = target_col.id
                        task.updated_at = now
                        events.append(
                            (
                                "TASK_STATUS_CHANGED",
                                {
                                    "projectId": project_id,
                                    "taskId": dep_id,
                                    "status": new_task_status,
                                    "reason": "dependency_unblocked",
                                },
                            )
                        )

    await session.commit()

    # Publish all events
    for event_type, data in events:
        await _publish_event(event_type, data)


# ══════════════════════════════════════════════════════════════════════════
# EXECUTION ENDPOINTS
# ══════════════════════════════════════════════════════════════════════════


@router.post("/{project_id}/tasks/{task_id}/execute")
async def execute_task(
    project_id: str,
    task_id: str,
    req: ExecuteTaskRequest,
    session: AsyncSession = Depends(get_async_session),
):
    """Execute a task by starting a pipeline run for it."""
    logger.debug(
        f"Executing task: project_id={project_id}, task_id={task_id}, pipeline_override={req.pipelineId}"
    )
    task = await get_task_or_404(session, project_id, task_id)

    # Check task is in an executable state
    if task.status not in ("ready", "backlog", "planning"):
        raise HTTPException(
            status_code=400,
            detail=f"Cannot execute task in '{task.status}' status. Must be ready, backlog, or planning.",
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
                select(ProjectWorkflow.pipeline_id).where(
                    ProjectWorkflow.id == workflow_id,
                    ProjectWorkflow.project_id == project_id,
                )
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
            .where(
                ProjectWorkflow.project_id == project_id,
                ProjectWorkflow.is_default == True,
            )
            .limit(1)
        )
        pipeline_id = wf_result.scalar_one_or_none()

    if not pipeline_id:
        raise HTTPException(
            status_code=400,
            detail="No pipeline assigned. Set a default pipeline for this project or select one when executing.",
        )

    # Validate pipeline exists
    if not _validate_pipeline_exists(pipeline_id):
        raise HTTPException(
            status_code=404, detail=f"Pipeline '{pipeline_id}' not found"
        )

    # Execute the task using shared helper
    result = await _execute_single_task(
        session, project_id, task, pipeline_id, req.context
    )

    return {"status": "executing", **result}


@router.post("/{project_id}/execute-ready")
async def execute_ready_tasks(
    project_id: str,
    max_tasks: int = 5,
    session: AsyncSession = Depends(get_async_session),
):
    """Execute all ready tasks in a project (up to max_tasks).

    Uses each task's assigned workflow/pipeline, or the project default.
    Respects agent concurrency (won't assign more than one task to the same agent simultaneously).
    """
    logger.debug(
        f"Executing ready tasks: project_id={project_id}, max_tasks={max_tasks}"
    )
    project = await get_project_or_404(session, project_id)

    # Get ready tasks
    result = await session.execute(
        select(Task)
        .where(Task.project_id == project_id, Task.status == "ready")
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
            Task.status == "in_progress",
            Task.assigned_agent.isnot(None),
        )
        .distinct()
    )
    busy_agents = {row[0] for row in busy_result.all() if row[0]}

    # Get default workflow
    default_wf_result = await session.execute(
        select(ProjectWorkflow.id, ProjectWorkflow.pipeline_id)
        .where(
            ProjectWorkflow.project_id == project_id, ProjectWorkflow.is_default == True
        )
        .limit(1)
    )
    default_wf = default_wf_result.first()

    # Get all workflows for tag-based matching
    all_wf_result = await session.execute(
        select(ProjectWorkflow).where(ProjectWorkflow.project_id == project_id)
    )
    all_workflows = all_wf_result.scalars().all()

    executed = []
    skipped = []

    for task in ready_tasks:
        # Skip if assigned agent is busy
        if task.assigned_agent and task.assigned_agent in busy_agents:
            skipped.append(
                {"task_id": task.id, "reason": f"Agent {task.assigned_agent} is busy"}
            )
            continue

        # Determine pipeline (priority order)
        pipeline_id = task.pipeline_id  # 1. Task-level pipeline

        # 2. Task's explicit workflow
        if not pipeline_id and task.workflow_id:
            wf_result = await session.execute(
                select(ProjectWorkflow.pipeline_id).where(
                    ProjectWorkflow.id == task.workflow_id
                )
            )
            pipeline_id = wf_result.scalar_one_or_none()

        # 3. Tag-based workflow matching
        if not pipeline_id and task.tags:
            task_tags = json.loads(task.tags) if task.tags else []
            for wf in all_workflows:
                filter_tags = (
                    json.loads(wf.task_filter).get("tags", []) if wf.task_filter else []
                )
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
            skipped.append(
                {"task_id": task.id, "reason": f"Pipeline '{pipeline_id}' not found"}
            )
            continue

        # Execute the task using shared helper
        try:
            result = await _execute_single_task(
                session, project_id, task, pipeline_id, context=None
            )
            executed.append(result)

            # Mark agent as busy
            if task.assigned_agent:
                busy_agents.add(task.assigned_agent)

        except Exception as e:
            skipped.append({"task_id": task.id, "reason": str(e)})

    logger.debug(
        f"Execute ready tasks result: project_id={project_id}, executed={len(executed)}, skipped={len(skipped)}"
    )

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
async def task_run_completed(
    project_id: str,
    task_id: str,
    run_id: str,
    status: str,
    session: AsyncSession = Depends(get_async_session),
):
    """Called when a pipeline run linked to a task completes or fails.

    This endpoint is meant to be called by the engine or an event listener.
    Updates the task status and triggers cascade readiness checks.
    """
    logger.debug(
        f"Task run completed: project_id={project_id}, task_id={task_id}, run_id={run_id}, status={status}"
    )
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

    event_type = (
        "TASK_EXECUTION_COMPLETED" if new_status == "done" else "TASK_EXECUTION_FAILED"
    )
    await _publish_event(
        event_type,
        {
            "projectId": project_id,
            "taskId": task_id,
            "runId": run_id,
            "status": new_status,
        },
    )

    return {"status": "updated", "task_status": new_status}


# ══════════════════════════════════════════════════════════════════════════
# TASK BRANCH — Get or create the persistent git branch for a task
# ══════════════════════════════════════════════════════════════════════════


@router.get("/{project_id}/tasks/{task_id}/branch")
async def get_task_branch(
    project_id: str,
    task_id: str,
    session: AsyncSession = Depends(get_async_session),
):
    """Get the persistent git branch name for a task.

    Creates and stores the branch name in task metadata if it doesn't exist yet.
    The branch follows the naming convention: feat/{task_id}-{slug}

    Agents should call this before starting work on a task to get the branch
    they should check out / create.
    """
    task = await get_task_or_404(session, project_id, task_id)
    now = now_ms()

    branch = _get_task_branch(task)
    created = False

    if not branch:
        branch = _task_branch_name(task.id, task.title)
        _set_task_branch(task, branch)
        task.updated_at = now
        await session.commit()
        created = True
        logger.debug(f"Created branch name for task {task_id}: {branch}")

    return {
        "task_id": task_id,
        "project_id": project_id,
        "branch": branch,
        "created": created,
    }


# ══════════════════════════════════════════════════════════════════════════
# CLAIM TASK — Atomically assign an agent to an unclaimed task
# ══════════════════════════════════════════════════════════════════════════


@router.post("/{project_id}/tasks/{task_id}/claim")
async def claim_task(
    project_id: str,
    task_id: str,
    req: ClaimTaskRequest,
    session: AsyncSession = Depends(get_async_session),
):
    """Atomically claim a task for an agent.

    Prevents multiple agents from racing to pick up the same unassigned task.
    Uses SELECT FOR UPDATE so concurrent requests are serialized at the DB row
    level — the second claimer will see the already-assigned agent and 409.

    Rules:
    - If the task is already assigned to req.agentId → idempotent success
    - If the task is unassigned and in a claimable status → assign + return branch
    - If the task is assigned to a DIFFERENT agent → 409 Conflict
    - If the task status is not claimable → 400 Bad Request

    Claimable statuses: backlog, planning, ready
    """
    now = now_ms()

    # Fetch with a row-level write lock so concurrent claim requests are
    # serialized by the database — the second caller blocks until the first
    # transaction commits, then reads the updated assigned_agent value.
    result = await session.execute(
        select(Task)
        .where(Task.project_id == project_id, Task.id == task_id)
        .with_for_update()
    )
    task = result.scalar_one_or_none()
    if not task:
        raise HTTPException(
            status_code=404, detail=f"Task {task_id} not found in project {project_id}"
        )

    # Already claimed by this agent — idempotent
    if task.assigned_agent == req.agentId:
        branch = _get_task_branch(task)
        if not branch:
            branch = _task_branch_name(task.id, task.title)
            _set_task_branch(task, branch)
            task.updated_at = now
            await session.commit()
        return {
            "status": "already_claimed",
            "task_id": task_id,
            "agent_id": req.agentId,
            "branch": branch,
        }

    # Claimed by someone else
    if task.assigned_agent and task.assigned_agent != req.agentId:
        raise HTTPException(
            status_code=409,
            detail=f"Task is already claimed by agent '{task.assigned_agent}'",
        )

    # Not claimable in current status
    claimable_statuses = {"backlog", "planning", "ready"}
    if task.status not in claimable_statuses:
        raise HTTPException(
            status_code=400,
            detail=f"Task cannot be claimed in '{task.status}' status. Must be one of: {claimable_statuses}",
        )

    # Assign the task and ensure branch exists in metadata
    branch = _get_task_branch(task)
    if not branch:
        branch = _task_branch_name(task.id, task.title)
        _set_task_branch(task, branch)

    task.assigned_agent = req.agentId
    task.updated_at = now
    await session.commit()

    await _publish_event(
        "TASK_CLAIMED",
        {
            "projectId": project_id,
            "taskId": task_id,
            "agentId": req.agentId,
            "branch": branch,
        },
    )

    logger.debug(f"Task {task_id} claimed by {req.agentId}, branch: {branch}")
    return {
        "status": "claimed",
        "task_id": task_id,
        "agent_id": req.agentId,
        "branch": branch,
    }


# ══════════════════════════════════════════════════════════════════════════
# TASK WORKSPACE — Create / remove a persistent worktree in agent's sandbox
# ══════════════════════════════════════════════════════════════════════════


class TaskWorkspaceRequest(BaseModel):
    agentId: str  # Agent that will own the worktree


@router.post("/{project_id}/tasks/{task_id}/workspace")
async def create_task_workspace(
    project_id: str,
    task_id: str,
    req: TaskWorkspaceRequest,
    session: AsyncSession = Depends(get_async_session),
):
    """Create a persistent git worktree for a task in the agent's sandbox.

    Called automatically by the claim_task response so pulse agents have an
    authenticated git workspace at /home/agent/task-workspaces/{task_id}/.

    The engine:
      1. Ensures the project repo exists (clones if needed, with GitHub App auth).
      2. Creates a worktree on feat/{task_id} inside the agent's persistent sandbox.
      3. The worktree inherits the authenticated remote URL — the agent can push
         using the installed git credential helper.

    Publishes TASK_WORKSPACE_REQUESTED to the engine via Redis global events stream
    and polls for the result (max 30 s).
    """
    task = await get_task_or_404(session, project_id, task_id)

    branch = _get_task_branch(task)
    if not branch:
        branch = _task_branch_name(task.id, task.title)
        _set_task_branch(task, branch)
        task.updated_at = now_ms()
        await session.commit()

    if not dependencies.redis_client:
        raise HTTPException(status_code=503, detail="Redis not available")

    # Clear any stale result key
    result_key = f"djinnbot:workspace:{req.agentId}:{task_id}"
    await dependencies.redis_client.delete(result_key)

    # Ask the engine to create the worktree
    await _publish_event(
        "TASK_WORKSPACE_REQUESTED",
        {
            "agentId": req.agentId,
            "projectId": project_id,
            "taskId": task_id,
            "taskBranch": branch,
        },
    )

    # Poll for result (engine is async — usually < 5 s for a local fetch+worktree)
    for _ in range(60):  # 60 × 0.5 s = 30 s max
        await asyncio.sleep(0.5)
        raw = await dependencies.redis_client.get(result_key)
        if raw:
            result = json.loads(raw)
            if not result.get("success"):
                raise HTTPException(
                    status_code=500,
                    detail=f"Engine failed to create task workspace: {result.get('error', 'unknown')}",
                )
            # Container path — inside the container the sandbox is /home/agent
            # Engine path is /data/sandboxes/{agentId}/task-workspaces/{taskId}
            # Container sees it as /home/agent/task-workspaces/{taskId}
            container_path = f"/home/agent/task-workspaces/{task_id}"
            return {
                "status": "ready",
                "task_id": task_id,
                "agent_id": req.agentId,
                "branch": result["branch"],
                "worktree_path": container_path,
                "already_existed": result.get("alreadyExists", False),
            }

    raise HTTPException(
        status_code=504,
        detail="Timed out waiting for engine to create task workspace (30 s)",
    )


@router.delete("/{project_id}/tasks/{task_id}/workspace")
async def remove_task_workspace(
    project_id: str,
    task_id: str,
    agent_id: str = Query(..., description="Agent ID whose workspace to remove"),
):
    """Remove a task worktree from an agent's sandbox.

    Called after a task's PR is merged or the task is closed.
    Fire-and-forget — the engine removes the worktree asynchronously.
    """
    if not dependencies.redis_client:
        raise HTTPException(status_code=503, detail="Redis not available")

    await _publish_event(
        "TASK_WORKSPACE_REMOVE_REQUESTED",
        {
            "agentId": agent_id,
            "projectId": project_id,
            "taskId": task_id,
        },
    )
    return {"status": "remove_requested", "task_id": task_id, "agent_id": agent_id}


# ══════════════════════════════════════════════════════════════════════════
# PULL REQUEST — Open a PR for a task branch
# ══════════════════════════════════════════════════════════════════════════


class OpenPullRequestRequest(BaseModel):
    agentId: str
    title: str
    body: Optional[str] = ""
    draft: Optional[bool] = False
    base_branch: Optional[str] = "main"


@router.post("/{project_id}/tasks/{task_id}/pull-request")
async def open_task_pull_request(
    project_id: str,
    task_id: str,
    req: OpenPullRequestRequest,
    session: AsyncSession = Depends(get_async_session),
):
    """Open a GitHub pull request for a task's feature branch.

    Called by pulse agents via the open_pull_request tool after their
    implementation is complete. Uses the project's GitHub App installation
    token — no personal access token required.

    Stores the PR URL in task.metadata.pr_url so other agents can find it.
    """
    task = await get_task_or_404(session, project_id, task_id)

    branch = _get_task_branch(task)
    if not branch:
        branch = _task_branch_name(task.id, task.title)
        _set_task_branch(task, branch)

    try:
        result = await github_helper.create_pull_request(
            project_id=project_id,
            head_branch=branch,
            base_branch=req.base_branch or "main",
            title=req.title,
            body=req.body or "",
            draft=req.draft or False,
        )
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Failed to create PR: {e}")

    # Persist PR URL in task metadata
    try:
        meta = json.loads(task.task_metadata) if task.task_metadata else {}
    except (json.JSONDecodeError, TypeError):
        meta = {}
    meta["pr_url"] = result["pr_url"]
    meta["pr_number"] = result["pr_number"]
    task.task_metadata = json.dumps(meta)
    task.updated_at = now_ms()
    await session.commit()

    await _publish_event(
        "TASK_PR_OPENED",
        {
            "projectId": project_id,
            "taskId": task_id,
            "agentId": req.agentId,
            "prNumber": result["pr_number"],
            "prUrl": result["pr_url"],
            "branch": branch,
        },
    )

    logger.debug(
        "PR #%d opened for task %s by %s", result["pr_number"], task_id, req.agentId
    )
    return {
        "pr_number": result["pr_number"],
        "pr_url": result["pr_url"],
        "title": result["title"],
        "draft": result["draft"],
        "branch": branch,
    }


# ══════════════════════════════════════════════════════════════════════════
# TRANSITION TASK — Move a task to a new status / kanban column
# ══════════════════════════════════════════════════════════════════════════


class TransitionTaskRequest(BaseModel):
    status: (
        str  # Target status: ready, in_progress, review, done, failed, blocked, backlog
    )
    note: Optional[str] = None  # Optional note to store in metadata


@router.post("/{project_id}/tasks/{task_id}/transition")
async def transition_task(
    project_id: str,
    task_id: str,
    req: TransitionTaskRequest,
    session: AsyncSession = Depends(get_async_session),
):
    """Transition a task to a new status and move it to the appropriate column.

    Called by agents during their pulse routine to advance tasks through the kanban.
    Also triggers cascade readiness checks for dependent tasks.
    """
    valid_statuses = {
        "backlog",
        "planning",
        "ready",
        "in_progress",
        "review",
        "blocked",
        "done",
        "failed",
    }
    if req.status not in valid_statuses:
        raise HTTPException(
            status_code=400,
            detail=f"Invalid status '{req.status}'. Must be one of: {valid_statuses}",
        )

    now = now_ms()
    task = await get_task_or_404(session, project_id, task_id)

    old_status = task.status

    # Find the target column
    col_result = await session.execute(
        select(KanbanColumn)
        .where(KanbanColumn.project_id == project_id)
        .order_by(KanbanColumn.position)
    )
    target_col = None
    for col in col_result.scalars().all():
        statuses = json.loads(col.task_statuses) if col.task_statuses else []
        if req.status in statuses:
            target_col = col
            break

    if not target_col:
        raise HTTPException(
            status_code=400,
            detail=f"No kanban column found for status '{req.status}' in this project",
        )

    # Update task
    task.status = req.status
    task.column_id = target_col.id
    task.updated_at = now

    if req.status == "done":
        task.completed_at = now

    # Store note in metadata if provided
    if req.note:
        try:
            meta = json.loads(task.task_metadata) if task.task_metadata else {}
        except (json.JSONDecodeError, TypeError):
            meta = {}
        meta.setdefault("transition_notes", []).append(
            {
                "from": old_status,
                "to": req.status,
                "note": req.note,
                "timestamp": now,
            }
        )
        task.task_metadata = json.dumps(meta)

    await session.commit()

    # Cascade readiness if needed
    if req.status in ("done", "failed"):
        await _recompute_task_readiness(session, project_id, task_id, req.status)

    await _publish_event(
        "TASK_STATUS_CHANGED",
        {
            "projectId": project_id,
            "taskId": task_id,
            "fromStatus": old_status,
            "toStatus": req.status,
            "note": req.note,
        },
    )

    return {
        "status": "transitioned",
        "task_id": task_id,
        "from_status": old_status,
        "to_status": req.status,
        "column_id": target_col.id,
    }
