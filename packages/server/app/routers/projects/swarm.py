"""Board-initiated swarm execution for projects.

Allows launching a parallel swarm directly from the project board by selecting
tasks. The server builds the dependency DAG from existing DependencyEdge records
and dispatches it to the engine's swarm executor.

This is the dashboard-facing counterpart of the internal /swarm-execute endpoint
(which is agent-initiated). The key difference: this endpoint auto-builds the DAG
from the project's existing dependency graph instead of requiring the caller to
construct it.

Endpoints (nested under /v1/projects/{project_id}):
- POST /swarm-execute           - Launch a swarm from selected tasks
- GET  /swarms                  - List swarms for this project
"""

import json
import uuid
from typing import Optional, List

from fastapi import APIRouter, HTTPException, Depends
from pydantic import BaseModel, Field
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.database import get_async_session
from app.models import Project, Task, DependencyEdge
from app import dependencies
from app.utils import now_ms
from app.logging_config import get_logger
from ._common import (
    get_project_or_404,
    _publish_event,
    get_project_semantics,
    get_semantic_statuses,
)

logger = get_logger(__name__)
router = APIRouter()


# ============================================================================
# Request / Response models
# ============================================================================


class BoardSwarmExecuteRequest(BaseModel):
    """Launch a swarm from the project board."""

    # Task IDs to include in the swarm. If empty, auto-selects all ready tasks.
    taskIds: List[str] = Field(
        default_factory=list,
        description="Task IDs to execute. Empty = all ready tasks.",
    )
    # Agent ID whose identity the executors inherit
    agentId: str = Field(..., description="Agent ID for execution")
    maxConcurrent: int = Field(default=3, ge=1, le=8)
    deviationRules: str = Field(default="")
    globalTimeoutSeconds: int = Field(default=1800, ge=60, le=3600)
    # Model override for all executors
    model: Optional[str] = None


class SwarmPreviewResponse(BaseModel):
    """Preview of what a swarm would look like before launching."""

    tasks: list
    dag_depth: int
    root_tasks: list
    total_tasks: int
    warnings: list


# ============================================================================
# DAG builder
# ============================================================================


async def _build_swarm_dag(
    session: AsyncSession,
    project_id: str,
    task_ids: List[str],
) -> tuple[list[dict], list[str]]:
    """Build a swarm DAG from the project's dependency graph.

    Returns (tasks_for_swarm, warnings).

    For each selected task:
    - key = task ID
    - dependencies = task IDs of blocking deps that are also in the selection
    - execution_prompt = task description

    Tasks whose blocking deps are NOT in the selection but are not yet done
    generate warnings (they'll block the swarm).
    """
    # Load tasks
    tasks_result = await session.execute(
        select(Task).where(Task.id.in_(task_ids), Task.project_id == project_id)
    )
    tasks = {t.id: t for t in tasks_result.scalars().all()}

    # Resolve which statuses mean "done" for this project
    semantics = await get_project_semantics(session, project_id)
    terminal_done = get_semantic_statuses(semantics, "terminal_done")

    # Load dependency edges within the selection
    edges_result = await session.execute(
        select(DependencyEdge).where(
            DependencyEdge.project_id == project_id,
            DependencyEdge.type == "blocks",
        )
    )
    all_edges = edges_result.scalars().all()

    selected_ids = set(task_ids)
    warnings: list[str] = []
    swarm_tasks = []

    for task_id in task_ids:
        task = tasks.get(task_id)
        if not task:
            warnings.append(f"Task {task_id} not found in project")
            continue

        # Find blocking deps for this task
        blocking_deps = [e for e in all_edges if e.to_task_id == task_id]

        swarm_deps = []
        for edge in blocking_deps:
            dep_id = edge.from_task_id
            if dep_id in selected_ids:
                # Dep is in the swarm — add as dependency
                swarm_deps.append(dep_id)
            else:
                # Dep is outside the swarm — check if it's already done
                dep_task = tasks.get(dep_id)
                if not dep_task:
                    # Load it
                    dep_result = await session.execute(
                        select(Task.status).where(Task.id == dep_id)
                    )
                    dep_status = dep_result.scalar_one_or_none()
                    if dep_status and dep_status not in terminal_done:
                        warnings.append(
                            f"Task '{task.title}' depends on task {dep_id} which is "
                            f"not in the swarm and not done (status: {dep_status})"
                        )
                elif dep_task.status not in terminal_done:
                    warnings.append(
                        f"Task '{task.title}' depends on '{dep_task.title}' which is "
                        f"not in the swarm and not done (status: {dep_task.status})"
                    )

        swarm_tasks.append(
            {
                "key": task.id,
                "title": task.title,
                "projectId": project_id,
                "taskId": task.id,
                "executionPrompt": task.description or f"Execute task: {task.title}",
                "dependencies": swarm_deps,
                "status": task.status,
                "priority": task.priority,
            }
        )

    return swarm_tasks, warnings


def _compute_dag_depth(tasks: list[dict]) -> int:
    """Compute the critical path depth of the DAG."""
    depths: dict[str, int] = {}
    adj: dict[str, list[str]] = {t["key"]: t.get("dependencies", []) for t in tasks}

    def depth(key: str) -> int:
        if key in depths:
            return depths[key]
        deps = adj.get(key, [])
        if not deps:
            depths[key] = 0
            return 0
        d = 1 + max(depth(dep) for dep in deps)
        depths[key] = d
        return d

    return max(depth(t["key"]) for t in tasks) if tasks else 0


def _validate_dag(tasks: list[dict]) -> list[str]:
    """Validate the DAG for cycles."""
    errors: list[str] = []
    keys = {t["key"] for t in tasks}
    adj = {t["key"]: t.get("dependencies", []) for t in tasks}

    visited: set[str] = set()
    in_stack: set[str] = set()

    def has_cycle(node: str) -> bool:
        if node in in_stack:
            return True
        if node in visited:
            return False
        visited.add(node)
        in_stack.add(node)
        for dep in adj.get(node, []):
            if dep in keys and has_cycle(dep):
                return True
        in_stack.discard(node)
        return False

    for t in tasks:
        if has_cycle(t["key"]):
            errors.append(f"Circular dependency detected involving task '{t['title']}'")
            break

    return errors


# ============================================================================
# Endpoints
# ============================================================================


@router.post("/{project_id}/swarm-execute")
async def board_swarm_execute(
    project_id: str,
    req: BoardSwarmExecuteRequest,
    session: AsyncSession = Depends(get_async_session),
):
    """Launch a parallel swarm from the project board.

    If taskIds is empty, auto-selects all tasks in claimable statuses
    that have all dependencies met.

    Returns the swarm_id for tracking progress via SSE or polling.
    """
    project = await get_project_or_404(session, project_id)

    # Resolve task selection
    task_ids = req.taskIds
    if not task_ids:
        # Auto-select: all tasks in claimable statuses with deps met
        semantics = await get_project_semantics(session, project_id)
        claimable = get_semantic_statuses(semantics, "claimable")
        terminal_done = get_semantic_statuses(semantics, "terminal_done")

        if not claimable:
            claimable = {"backlog", "ready", "planning"}

        tasks_result = await session.execute(
            select(Task).where(
                Task.project_id == project_id,
                Task.status.in_(claimable),
            )
        )
        candidates = tasks_result.scalars().all()

        # Filter to tasks with all blocking deps done
        edges_result = await session.execute(
            select(DependencyEdge).where(
                DependencyEdge.project_id == project_id,
                DependencyEdge.type == "blocks",
            )
        )
        all_edges = edges_result.scalars().all()

        # Get all task statuses in the project
        all_tasks_result = await session.execute(
            select(Task.id, Task.status).where(Task.project_id == project_id)
        )
        status_map = {tid: st for tid, st in all_tasks_result.all()}

        ready_ids = []
        for task in candidates:
            blocking = [e for e in all_edges if e.to_task_id == task.id]
            all_met = all(
                status_map.get(e.from_task_id) in terminal_done for e in blocking
            )
            if all_met:
                ready_ids.append(task.id)

        task_ids = ready_ids

    if not task_ids:
        raise HTTPException(
            status_code=400,
            detail="No tasks available for swarm execution. Select tasks or ensure ready tasks exist.",
        )

    # Build DAG
    swarm_tasks, warnings = await _build_swarm_dag(session, project_id, task_ids)

    if not swarm_tasks:
        raise HTTPException(status_code=400, detail="No valid tasks for swarm")

    # Validate DAG
    dag_errors = _validate_dag(swarm_tasks)
    if dag_errors:
        raise HTTPException(
            status_code=400,
            detail=f"Invalid dependency graph: {'; '.join(dag_errors)}",
        )

    # Generate swarm ID
    swarm_id = f"swarm_{uuid.uuid4().hex[:12]}"

    # Build payload for engine
    swarm_payload = {
        "swarm_id": swarm_id,
        "agent_id": req.agentId,
        "project_id": project_id,
        "tasks": [
            {
                "key": t["key"],
                "title": t["title"],
                "projectId": t["projectId"],
                "taskId": t["taskId"],
                "executionPrompt": t["executionPrompt"],
                "dependencies": t["dependencies"],
                "model": req.model,
            }
            for t in swarm_tasks
        ],
        "maxConcurrent": req.maxConcurrent,
        "deviationRules": req.deviationRules,
        "globalTimeoutSeconds": req.globalTimeoutSeconds,
    }

    # Dispatch to engine via Redis
    if not dependencies.redis_client:
        raise HTTPException(status_code=503, detail="Redis not available")

    try:
        await dependencies.redis_client.xadd(
            "djinnbot:events:new_swarms",
            {"payload": json.dumps(swarm_payload)},
        )
    except Exception as e:
        logger.error(f"Failed to dispatch swarm: {e}")
        raise HTTPException(status_code=503, detail="Failed to dispatch swarm")

    # Track swarm association with project (for listing)
    try:
        await dependencies.redis_client.sadd(
            f"djinnbot:project:{project_id}:swarms", swarm_id
        )
        await dependencies.redis_client.expire(
            f"djinnbot:project:{project_id}:swarms", 86400
        )
    except Exception:
        pass  # Non-critical

    root_tasks = [t["key"] for t in swarm_tasks if not t.get("dependencies")]
    dag_depth = _compute_dag_depth(swarm_tasks)

    logger.info(
        f"Board swarm launched: {swarm_id}, project={project_id}, "
        f"tasks={len(swarm_tasks)}, agent={req.agentId}"
    )

    await _publish_event(
        "SWARM_LAUNCHED",
        {
            "projectId": project_id,
            "swarmId": swarm_id,
            "agentId": req.agentId,
            "totalTasks": len(swarm_tasks),
        },
    )

    return {
        "swarm_id": swarm_id,
        "status": "dispatched",
        "project_id": project_id,
        "total_tasks": len(swarm_tasks),
        "max_concurrent": req.maxConcurrent,
        "root_tasks": root_tasks,
        "dag_depth": dag_depth,
        "warnings": warnings,
        "tasks": [
            {
                "key": t["key"],
                "title": t["title"],
                "status": t.get("status"),
                "priority": t.get("priority"),
                "dependencies": t["dependencies"],
            }
            for t in swarm_tasks
        ],
        "progress_channel": f"djinnbot:swarm:{swarm_id}:progress",
        "stream_url": f"/v1/internal/swarm/{swarm_id}/stream",
    }


@router.post("/{project_id}/swarm-preview")
async def preview_swarm(
    project_id: str,
    req: BoardSwarmExecuteRequest,
    session: AsyncSession = Depends(get_async_session),
):
    """Preview what a swarm execution would look like without launching.

    Returns the DAG structure, depth, root tasks, and any warnings about
    unmet external dependencies. Use this to show a confirmation dialog.
    """
    await get_project_or_404(session, project_id)

    task_ids = req.taskIds
    if not task_ids:
        raise HTTPException(
            status_code=400,
            detail="Provide taskIds for preview",
        )

    swarm_tasks, warnings = await _build_swarm_dag(session, project_id, task_ids)
    dag_errors = _validate_dag(swarm_tasks)
    if dag_errors:
        warnings.extend(dag_errors)

    root_tasks = [t["key"] for t in swarm_tasks if not t.get("dependencies")]
    dag_depth = _compute_dag_depth(swarm_tasks)

    return {
        "tasks": [
            {
                "key": t["key"],
                "title": t["title"],
                "status": t.get("status"),
                "priority": t.get("priority"),
                "dependencies": t["dependencies"],
            }
            for t in swarm_tasks
        ],
        "dag_depth": dag_depth,
        "root_tasks": root_tasks,
        "total_tasks": len(swarm_tasks),
        "warnings": warnings,
    }


@router.get("/{project_id}/swarms")
async def list_project_swarms(
    project_id: str,
):
    """List swarm executions for a project.

    Reads from Redis (ephemeral — only recent swarms).
    """
    if not dependencies.redis_client:
        raise HTTPException(status_code=503, detail="Redis not available")

    try:
        # Get swarm IDs associated with this project
        swarm_ids = await dependencies.redis_client.smembers(
            f"djinnbot:project:{project_id}:swarms"
        )

        swarms = []
        for swarm_id in swarm_ids:
            raw = await dependencies.redis_client.get(
                f"djinnbot:swarm:{swarm_id}:state"
            )
            if raw:
                try:
                    state = json.loads(
                        raw if isinstance(raw, str) else raw.decode("utf-8")
                    )
                    swarms.append(state)
                except (json.JSONDecodeError, AttributeError):
                    pass

        # Sort by created_at descending
        swarms.sort(key=lambda s: s.get("created_at", 0), reverse=True)
        return {"swarms": swarms, "project_id": project_id}
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Failed to list project swarms: {e}")
        raise HTTPException(status_code=500, detail="Failed to list swarms")
