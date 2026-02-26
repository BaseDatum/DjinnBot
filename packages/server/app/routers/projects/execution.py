"""Task execution engine endpoints."""

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
from app.auth.dependencies import get_current_user, AuthUser
from ._common import (
    get_project_or_404,
    get_task_or_404,
    _serialize_task,
    _publish_event,
    _validate_pipeline_exists,
    get_valid_statuses_for_project,
    get_project_semantics,
    get_semantic_statuses,
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
    modelOverride: Optional[str] = None  # Override agent/pipeline model for this run
    keyUserId: Optional[str] = None  # Override whose API keys to use (user ID)


class ExecuteAgentRequest(BaseModel):
    agentId: str  # Agent to execute this task
    modelOverride: Optional[str] = None  # Override the agent's default model
    keyUserId: Optional[str] = None  # Override whose API keys to use


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
    initiated_by_user_id: Optional[str] = None,
    model_override: Optional[str] = None,
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
        initiated_by_user_id=initiated_by_user_id,
        model_override=model_override,
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
    Uses project status semantics to determine terminal_done, terminal_fail, and blocked
    statuses dynamically instead of hardcoding "done"/"failed"/"blocked".
    """
    logger.debug(
        f"Recomputing task readiness: project_id={project_id}, task_id={changed_task_id}, new_status={new_status}"
    )
    now = now_ms()
    events = []  # Collect events to publish

    # Resolve semantic status sets for this project
    semantics = await get_project_semantics(session, project_id)
    terminal_done = get_semantic_statuses(semantics, "terminal_done")
    terminal_fail = get_semantic_statuses(semantics, "terminal_fail")
    blocked_statuses = get_semantic_statuses(semantics, "blocked")
    initial_statuses = get_semantic_statuses(semantics, "initial")

    if new_status in terminal_done:
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
            all_done = all(status in terminal_done for _, status in blocking_deps)

            if all_done:
                # Get current task status
                task_result = await session.execute(
                    select(Task).where(Task.id == dep_id)
                )
                task = task_result.scalar_one_or_none()
                # Unblock if task is in initial, blocked, or other non-terminal statuses
                non_terminal = (
                    initial_statuses | blocked_statuses | {"planning", "planned", "ux"}
                )
                if task and (
                    task.status in non_terminal or task.status in blocked_statuses
                ):
                    # Restore to pre-block status if available, otherwise default to "ready"
                    try:
                        meta = (
                            json.loads(task.task_metadata) if task.task_metadata else {}
                        )
                    except (json.JSONDecodeError, TypeError):
                        meta = {}

                    restore_status = meta.pop("pre_block_status", "ready")
                    restore_column_id = meta.pop("pre_block_column_id", None)
                    task.task_metadata = json.dumps(meta)

                    # Find the column for the restored status
                    target_col = None
                    if restore_column_id:
                        col_result = await session.execute(
                            select(KanbanColumn).where(
                                KanbanColumn.id == restore_column_id,
                                KanbanColumn.project_id == project_id,
                            )
                        )
                        target_col = col_result.scalar_one_or_none()

                    # Fallback: find column by status
                    if not target_col:
                        col_result = await session.execute(
                            select(KanbanColumn)
                            .where(KanbanColumn.project_id == project_id)
                            .order_by(KanbanColumn.position)
                        )
                        for col in col_result.scalars().all():
                            statuses = (
                                json.loads(col.task_statuses)
                                if col.task_statuses
                                else []
                            )
                            if restore_status in statuses:
                                target_col = col
                                break

                    if target_col:
                        task.status = restore_status
                        task.column_id = target_col.id
                        task.updated_at = now
                        events.append(
                            (
                                "TASK_STATUS_CHANGED",
                                {
                                    "projectId": project_id,
                                    "taskId": dep_id,
                                    "status": restore_status,
                                    "reason": "all_dependencies_met",
                                },
                            )
                        )

    elif new_status in terminal_fail:
        # Cascade: block all downstream tasks (recursive)
        to_block = []
        visited = set()
        all_terminal = terminal_done | terminal_fail

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
                    # Only block tasks that aren't already in a terminal state
                    task_result = await session.execute(
                        select(Task.status).where(Task.id == dep_id)
                    )
                    task_status = task_result.scalar_one_or_none()
                    if task_status and task_status not in all_terminal:
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

            # If no blocked column, try finding a terminal_fail column
            if not blocked_col:
                for col in blocked_col_result.scalars().all():
                    statuses = (
                        json.loads(col.task_statuses) if col.task_statuses else []
                    )
                    if any(s in terminal_fail for s in statuses):
                        blocked_col = col
                        break

            if blocked_col:
                for dep_id in to_block:
                    task_result = await session.execute(
                        select(Task).where(Task.id == dep_id)
                    )
                    task = task_result.scalar_one_or_none()
                    if task:
                        # Store pre-block status so we can restore it when
                        # the dependency is resolved (instead of always
                        # going to "ready").
                        try:
                            meta = (
                                json.loads(task.task_metadata)
                                if task.task_metadata
                                else {}
                            )
                        except (json.JSONDecodeError, TypeError):
                            meta = {}
                        meta["pre_block_status"] = task.status
                        meta["pre_block_column_id"] = task.column_id
                        task.task_metadata = json.dumps(meta)

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

    elif new_status not in (terminal_done | terminal_fail | blocked_statuses):
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
            if task and task.status in blocked_statuses:
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
                    status in (terminal_fail | blocked_statuses)
                    for _, status in blocking_deps
                )

                if not has_failed:
                    # Check if all deps are done → first claimable status, otherwise → first initial status
                    all_done = all(
                        status in terminal_done for _, status in blocking_deps
                    )
                    claimable = get_semantic_statuses(semantics, "claimable")
                    # Pick a sensible restore status
                    new_task_status = (
                        (list(claimable)[0] if claimable else "ready")
                        if all_done
                        else (
                            list(initial_statuses)[0] if initial_statuses else "backlog"
                        )
                    )

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


async def _recompute_parent_status(
    session: AsyncSession, project_id: str, subtask_id: str
):
    """Derive parent task status from its subtasks when a subtask status changes.

    Rules:
    - ALL subtasks done → parent → done
    - ANY subtask in_progress/review/test → parent → in_progress
    - ANY subtask failed, none in_progress → parent → failed
    - Otherwise parent stays as-is (backlog/planning/planned/ready)

    Only fires when the changed task is a subtask (has parent_task_id).
    """
    now = now_ms()

    # Get the subtask to find its parent
    result = await session.execute(select(Task).where(Task.id == subtask_id))
    subtask = result.scalar_one_or_none()
    if not subtask or not subtask.parent_task_id:
        return

    parent_id = subtask.parent_task_id

    # Get all sibling subtasks (including this one)
    siblings_result = await session.execute(
        select(Task.status).where(
            Task.project_id == project_id,
            Task.parent_task_id == parent_id,
        )
    )
    sibling_statuses = [row[0] for row in siblings_result.all()]

    if not sibling_statuses:
        return

    # Resolve semantic status sets
    semantics = await get_project_semantics(session, project_id)
    terminal_done = get_semantic_statuses(semantics, "terminal_done")
    terminal_fail = get_semantic_statuses(semantics, "terminal_fail")
    active_statuses = {"in_progress", "review", "test"}

    # Determine derived parent status
    all_done = all(s in terminal_done for s in sibling_statuses)
    any_active = any(s in active_statuses for s in sibling_statuses)
    any_failed = any(s in terminal_fail for s in sibling_statuses)

    if all_done:
        new_parent_status = "done"
    elif any_active:
        new_parent_status = "in_progress"
    elif any_failed and not any_active:
        new_parent_status = "failed"
    else:
        # Subtasks are still in backlog/planning/ready — don't change parent
        return

    # Get current parent
    parent_result = await session.execute(select(Task).where(Task.id == parent_id))
    parent = parent_result.scalar_one_or_none()
    if not parent:
        return

    # Skip if parent is already in the derived status
    if parent.status == new_parent_status:
        return

    old_status = parent.status

    # Find the target column for the new status
    col_result = await session.execute(
        select(KanbanColumn)
        .where(KanbanColumn.project_id == project_id)
        .order_by(KanbanColumn.position)
    )
    target_col = None
    for col in col_result.scalars().all():
        statuses = json.loads(col.task_statuses) if col.task_statuses else []
        if new_parent_status in statuses:
            target_col = col
            break

    if not target_col:
        logger.warning(
            f"No column found for derived parent status '{new_parent_status}' "
            f"in project {project_id}"
        )
        return

    parent.status = new_parent_status
    parent.column_id = target_col.id
    parent.updated_at = now
    if new_parent_status == "done":
        parent.completed_at = now

    await session.commit()

    logger.info(
        f"Parent task {parent_id} status derived: {old_status} → {new_parent_status} "
        f"(subtask {subtask_id} changed)"
    )
    await _publish_event(
        "TASK_STATUS_CHANGED",
        {
            "projectId": project_id,
            "taskId": parent_id,
            "fromStatus": old_status,
            "toStatus": new_parent_status,
            "reason": "derived_from_subtasks",
        },
    )

    # If parent reached done, cascade readiness for tasks depending on the parent
    if new_parent_status in terminal_done:
        await _recompute_task_readiness(
            session, project_id, parent_id, new_parent_status
        )


# ══════════════════════════════════════════════════════════════════════════
# EXECUTION ENDPOINTS
# ══════════════════════════════════════════════════════════════════════════


@router.post("/{project_id}/tasks/{task_id}/execute")
async def execute_task(
    project_id: str,
    task_id: str,
    req: ExecuteTaskRequest,
    session: AsyncSession = Depends(get_async_session),
    user: AuthUser = Depends(get_current_user),
):
    """Execute a task by starting a pipeline run for it."""
    logger.debug(
        f"Executing task: project_id={project_id}, task_id={task_id}, pipeline_override={req.pipelineId}"
    )
    task = await get_task_or_404(session, project_id, task_id)

    # Check task is in an executable state — use project semantics
    exec_semantics = await get_project_semantics(session, project_id)
    executable_statuses = get_semantic_statuses(
        exec_semantics, "claimable"
    ) | get_semantic_statuses(exec_semantics, "initial")
    if not executable_statuses:
        executable_statuses = {"ready", "backlog", "planning"}
    if task.status not in executable_statuses:
        raise HTTPException(
            status_code=400,
            detail=f"Cannot execute task in '{task.status}' status. Must be one of: {sorted(executable_statuses)}",
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

    # Determine who initiated this run: explicit keyUserId override > current user > None
    # Engine/service callers (pulse tools) have is_service=True and store None.
    # Anonymous user (auth disabled) doesn't exist in users table, so skip.
    initiated_by = req.keyUserId or (
        user.id if not user.is_service and user.id != "anonymous" else None
    )

    # Execute the task using shared helper
    result = await _execute_single_task(
        session,
        project_id,
        task,
        pipeline_id,
        req.context,
        initiated_by_user_id=initiated_by,
        model_override=req.modelOverride,
    )

    return {"status": "executing", **result}


@router.post("/{project_id}/tasks/{task_id}/execute-agent")
async def execute_task_with_agent(
    project_id: str,
    task_id: str,
    req: ExecuteAgentRequest,
    session: AsyncSession = Depends(get_async_session),
    user: AuthUser = Depends(get_current_user),
):
    """Execute a task by spawning a standalone agent session.

    Creates a single-step run using the 'execute' pipeline with the specified
    agent's identity. Includes pre-flight memory injection and task branch
    resolution (same as spawn_executor but user-facing).
    """
    from app.routers.spawn_executor import _build_lessons_section

    logger.info(
        f"Execute-agent: project={project_id}, task={task_id}, agent={req.agentId}"
    )
    task = await get_task_or_404(session, project_id, task_id)

    # Check task is in an executable state
    exec_semantics = await get_project_semantics(session, project_id)
    executable_statuses = get_semantic_statuses(
        exec_semantics, "claimable"
    ) | get_semantic_statuses(exec_semantics, "initial")
    if not executable_statuses:
        executable_statuses = {"ready", "backlog", "planning"}
    if task.status not in executable_statuses:
        raise HTTPException(
            status_code=400,
            detail=f"Cannot execute task in '{task.status}' status. Must be one of: {sorted(executable_statuses)}",
        )

    now = now_ms()

    # Assign agent to task
    task.assigned_agent = req.agentId
    task.updated_at = now

    # Build execution prompt from task
    task_desc = (
        f"[Project: {project_id}] [Task: {task.title}]\n\n{task.description or ''}"
    )

    # Pre-flight memory injection
    task_tags = json.loads(task.tags) if task.tags else []
    lessons = _build_lessons_section(
        req.agentId, task.title or "", task_tags, task.description or ""
    )
    if lessons:
        task_desc += f"\n\n{lessons}"

    # Resolve task branch — only for projects with a git repository.
    # Non-git projects skip worktree creation in the engine; setting a task_branch
    # would trigger a safety check that verifies a git remote exists and fail.
    project = await get_project_or_404(session, project_id)
    task_branch = None
    if project.repository:
        task_branch = _get_task_branch(task)
        if not task_branch:
            task_branch = _task_branch_name(task.id, task.title)
            _set_task_branch(task, task_branch)

    # Store metadata in human_context for the engine
    human_context = json.dumps(
        {
            "spawn_executor": True,
            "planner_agent_id": req.agentId,
            "project_id": project_id,
            "task_id": task_id,
            "memory_injection": bool(lessons),
        }
    )

    # Determine initiator — skip for anonymous users (auth disabled)
    initiated_by = req.keyUserId or (
        user.id if not user.is_service and user.id != "anonymous" else None
    )

    # Create the run using 'execute' pipeline (single-step)
    run_id = gen_id("run_")
    run = Run(
        id=run_id,
        pipeline_id="execute",
        project_id=project_id,
        task_description=task_desc,
        status="pending",
        outputs="{}",
        human_context=human_context,
        initiated_by_user_id=initiated_by,
        model_override=req.modelOverride,
        task_branch=task_branch,
        workspace_type=project.workspace_type,
        created_at=now,
        updated_at=now,
    )
    session.add(run)

    # Update task: link to run, move to in_progress
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
    task.pipeline_id = "execute"
    task.updated_at = now
    if in_progress_col:
        task.column_id = in_progress_col.id

    # Record in task_runs history
    task_run = TaskRun(
        task_id=task.id,
        run_id=run_id,
        pipeline_id="execute",
        status="running",
        started_at=now,
    )
    session.add(task_run)

    await session.commit()

    # Dispatch to engine via Redis
    if dependencies.redis_client:
        try:
            await dependencies.redis_client.xadd(
                "djinnbot:events:new_runs",
                {"run_id": run_id, "pipeline_id": "execute"},
            )
        except Exception as e:
            logger.warning(f"Failed to dispatch agent run to Redis: {e}")

        await _publish_event(
            "TASK_EXECUTION_STARTED",
            {
                "projectId": project_id,
                "taskId": task_id,
                "runId": run_id,
                "agentId": req.agentId,
                "pipelineId": "execute",
            },
        )

    return {
        "status": "executing",
        "task_id": task_id,
        "run_id": run_id,
        "agent_id": req.agentId,
        "pipeline_id": "execute",
    }


@router.post("/{project_id}/execute-ready")
async def execute_ready_tasks(
    project_id: str,
    max_tasks: int = 5,
    session: AsyncSession = Depends(get_async_session),
    user: AuthUser = Depends(get_current_user),
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
        initiated_by = user.id if not user.is_service else None
        try:
            result = await _execute_single_task(
                session,
                project_id,
                task,
                pipeline_id,
                context=None,
                initiated_by_user_id=initiated_by,
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

    # Map run status to task status using project semantics
    run_semantics = await get_project_semantics(session, project_id)
    done_statuses = get_semantic_statuses(run_semantics, "terminal_done")
    fail_statuses = get_semantic_statuses(run_semantics, "terminal_fail")

    if status == "completed":
        new_status = list(done_statuses)[0] if done_statuses else "done"
    elif status == "failed":
        new_status = list(fail_statuses)[0] if fail_statuses else "failed"
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
    if new_status in done_statuses:
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

    # Not claimable in current status — use semantic statuses
    claim_semantics = await get_project_semantics(session, project_id)
    claimable_statuses = get_semantic_statuses(claim_semantics, "claimable")
    if not claimable_statuses:
        # Fallback for projects without claimable semantics
        claimable_statuses = {
            "backlog",
            "planning",
            "planned",
            "ux",
            "ready",
            "test",
            "failed",
        }
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
    # Dynamic status validation — read valid statuses from project columns
    valid_statuses = await get_valid_statuses_for_project(session, project_id)
    if not valid_statuses:
        # Fallback for legacy projects without columns (shouldn't happen)
        valid_statuses = {
            "backlog",
            "planning",
            "planned",
            "ux",
            "ready",
            "in_progress",
            "review",
            "test",
            "blocked",
            "done",
            "failed",
        }
    if req.status not in valid_statuses:
        raise HTTPException(
            status_code=400,
            detail=f"Invalid status '{req.status}'. Must be one of: {sorted(valid_statuses)}",
        )

    now = now_ms()
    task = await get_task_or_404(session, project_id, task_id)

    old_status = task.status

    # ── Workflow policy enforcement ────────────────────────────────────────
    # If the project has a workflow policy and the task has a work_type,
    # validate that this transition is allowed (not to a skipped stage).
    from app.models import WorkflowPolicy
    from app.routers.workflow_policies import (
        get_stage_for_status,
        resolve_task_workflow,
    )

    policy_result = await session.execute(
        select(WorkflowPolicy).where(WorkflowPolicy.project_id == project_id)
    )
    workflow_policy = policy_result.scalar_one_or_none()

    target_stage = get_stage_for_status(req.status)
    completed_stages = (
        json.loads(task.completed_stages) if task.completed_stages else []
    )

    if workflow_policy and task.work_type and target_stage:
        rules = workflow_policy.stage_rules.get(task.work_type, [])
        target_rule = next((r for r in rules if r.get("stage") == target_stage), None)

        # Block transitions to skipped stages
        if target_rule and target_rule.get("disposition") == "skip":
            # Compute valid next stages for the error message
            workflow = resolve_task_workflow(
                work_type=task.work_type,
                completed_stages=completed_stages,
                current_status=task.status,
                stage_rules=workflow_policy.stage_rules,
            )
            raise HTTPException(
                status_code=400,
                detail=(
                    f"Stage '{target_stage}' is skipped for {task.work_type} tasks. "
                    f"Valid next stages: {workflow['next_valid_stages']}"
                ),
            )

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

    # Track completed stages: when leaving a stage, record it as completed
    old_stage = get_stage_for_status(old_status)
    if old_stage and old_stage not in completed_stages:
        completed_stages.append(old_stage)
        task.completed_stages = json.dumps(completed_stages)

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

    # Cascade readiness if needed — use semantic statuses
    semantics = await get_project_semantics(session, project_id)
    terminal_done = get_semantic_statuses(semantics, "terminal_done")
    terminal_fail = get_semantic_statuses(semantics, "terminal_fail")
    if req.status in terminal_done or req.status in terminal_fail:
        await _recompute_task_readiness(session, project_id, task_id, req.status)

    # Derive parent task status when a subtask changes.
    # This makes parent tasks with subtasks into "container" tasks whose status
    # is automatically computed: all_done→done, any_active→in_progress, any_failed→failed.
    if task.parent_task_id:
        await _recompute_parent_status(session, project_id, task_id)

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

    # ── Transition-triggered agent pulses ──────────────────────────────────
    # When certain statuses are reached, automatically wake the responsible
    # agent so work flows through the pipeline without waiting for scheduled
    # pulses.  This is the heartbeat of the autonomous loop.
    #
    # Uses the workflow policy's agent_role mapping when available, falling
    # back to legacy hardcoded triggers for backward compatibility.
    LEGACY_TRANSITION_TRIGGERS: dict[str, list[str]] = {
        "planned": ["shigeo"],  # Architecture done → Shigeo does UX
        "test": ["chieko"],  # Finn approved → Chieko runs QA
        "failed": ["yukihiro"],  # QA failed → Yukihiro fixes bugs
    }

    # Role → agent ID mapping (configurable per-project in the future)
    ROLE_TO_AGENT: dict[str, str] = {
        "po": "eric",
        "sa": "finn",
        "ux": "shigeo",
        "swe": "yukihiro",
        "qa": "chieko",
        "sre": "stas",
    }

    triggered_agents: list[str] = []
    if workflow_policy and task.work_type and target_stage:
        # Use workflow policy to find agent for the target stage
        rules = workflow_policy.stage_rules.get(task.work_type, [])
        target_rule = next((r for r in rules if r.get("stage") == target_stage), None)
        if target_rule and target_rule.get("agent_role"):
            agent = ROLE_TO_AGENT.get(target_rule["agent_role"])
            if agent:
                triggered_agents = [agent]
    if not triggered_agents:
        triggered_agents = LEGACY_TRANSITION_TRIGGERS.get(req.status, [])
    for agent_id in triggered_agents:
        await _publish_event(
            "PULSE_TRIGGERED",
            {
                "agentId": agent_id,
                "source": "transition_trigger",
                "context": (
                    f"Task '{task.title}' moved to {req.status} in project {project_id}"
                ),
            },
        )

    # When a task reaches a terminal_done status, request worktree cleanup.
    if req.status in terminal_done and task.assigned_agent:
        await _publish_event(
            "TASK_WORKSPACE_REMOVE_REQUESTED",
            {
                "agentId": task.assigned_agent,
                "projectId": project_id,
                "taskId": task_id,
            },
        )

    # Compute next valid stages for the response
    next_valid_stages = None
    if workflow_policy and task.work_type:
        workflow = resolve_task_workflow(
            work_type=task.work_type,
            completed_stages=completed_stages,
            current_status=req.status,
            stage_rules=workflow_policy.stage_rules,
        )
        next_valid_stages = workflow.get("next_valid_stages")

    return {
        "status": "transitioned",
        "task_id": task_id,
        "from_status": old_status,
        "to_status": req.status,
        "column_id": target_col.id,
        "work_type": task.work_type,
        "completed_stages": completed_stages,
        "next_valid_stages": next_valid_stages,
    }
