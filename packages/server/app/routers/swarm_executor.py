"""Swarm Executor — Internal API for parallel plan-then-execute workflow.

An agent (the planner) calls this endpoint to spawn multiple executors in
parallel, respecting a dependency DAG. The engine orchestrates dispatch,
monitors completion, and streams progress events back via Redis pub/sub.

Flow:
1. Planner agent calls swarm_execute tool → POST /v1/internal/swarm-execute
2. This endpoint validates the DAG and creates a swarm session
3. The engine picks up the swarm and dispatches ready tasks in parallel
4. Progress events stream to Redis channel djinnbot:swarm:{swarmId}:progress
5. The planner subscribes to the channel and receives real-time updates
6. GET /v1/internal/swarm/{swarmId} returns the current state (polling fallback)

The key innovation: instead of spawning one executor at a time and polling,
the planner submits a full DAG and the engine handles parallelism, dependency
resolution, and cascade skipping automatically.
"""

import json
import os
import uuid
from typing import Optional

from fastapi import APIRouter, HTTPException, Depends
from pydantic import BaseModel, Field
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.database import get_async_session
from app.models import Task, Project
from app import dependencies
from app.utils import now_ms
from app.logging_config import get_logger

logger = get_logger(__name__)

router = APIRouter()

VAULTS_DIR = os.getenv("VAULTS_DIR", "/data/vaults")


# ══════════════════════════════════════════════════════════════════════════
# REQUEST / RESPONSE MODELS
# ══════════════════════════════════════════════════════════════════════════


class SwarmTaskDefModel(BaseModel):
    key: str = Field(..., description="Unique key for this task within the swarm")
    title: str = Field(..., description="Human-readable task title")
    project_id: str = Field(..., description="Project ID for workspace provisioning")
    task_id: str = Field(..., description="Task ID in the kanban")
    execution_prompt: str = Field(
        ..., description="The execution prompt the executor receives"
    )
    dependencies: list[str] = Field(
        default_factory=list, description="Keys of tasks this depends on"
    )
    model: Optional[str] = Field(None, description="Model override for this executor")
    timeout_seconds: Optional[int] = Field(
        None, ge=30, le=600, description="Timeout for this executor"
    )


class SwarmExecuteRequest(BaseModel):
    agent_id: str = Field(
        ..., description="Agent ID of the planner (executors inherit identity)"
    )
    tasks: list[SwarmTaskDefModel] = Field(
        ..., min_length=1, max_length=20, description="Tasks forming the DAG"
    )
    max_concurrent: int = Field(
        default=3, ge=1, le=8, description="Max concurrent executors"
    )
    deviation_rules: str = Field(
        default="", description="Deviation rules injected into every executor"
    )
    global_timeout_seconds: int = Field(
        default=1800, ge=60, le=3600, description="Global timeout for the entire swarm"
    )


class SwarmTaskStateResponse(BaseModel):
    key: str
    title: str
    task_id: str
    project_id: str
    status: str
    run_id: Optional[str] = None
    dependencies: list[str]
    outputs: Optional[dict] = None
    error: Optional[str] = None
    started_at: Optional[int] = None
    completed_at: Optional[int] = None


class SwarmStateResponse(BaseModel):
    swarm_id: str
    agent_id: str
    status: str
    tasks: list[SwarmTaskStateResponse]
    max_concurrent: int
    active_count: int
    completed_count: int
    failed_count: int
    total_count: int
    created_at: int
    updated_at: int


# ══════════════════════════════════════════════════════════════════════════
# DAG VALIDATION
# ══════════════════════════════════════════════════════════════════════════


def _validate_dag(tasks: list[SwarmTaskDefModel]) -> list[str]:
    """Validate the task DAG. Returns list of error messages (empty if valid)."""
    errors: list[str] = []
    keys = {t.key for t in tasks}

    # Check for duplicate keys
    if len(keys) != len(tasks):
        seen = set()
        for t in tasks:
            if t.key in seen:
                errors.append(f"Duplicate task key: {t.key}")
            seen.add(t.key)

    # Check for missing dependency references
    for t in tasks:
        for dep in t.dependencies:
            if dep not in keys:
                errors.append(
                    f'Task "{t.key}" depends on "{dep}" which is not in the swarm'
                )

    # Check for self-dependencies
    for t in tasks:
        if t.key in t.dependencies:
            errors.append(f'Task "{t.key}" depends on itself')

    # Check for cycles using DFS
    adj: dict[str, list[str]] = {t.key: t.dependencies for t in tasks}
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
            if has_cycle(dep):
                return True
        in_stack.discard(node)
        return False

    for t in tasks:
        if has_cycle(t.key):
            errors.append(f'Circular dependency detected involving task "{t.key}"')
            break  # One cycle error is enough

    return errors


# ══════════════════════════════════════════════════════════════════════════
# ENDPOINTS
# ══════════════════════════════════════════════════════════════════════════


@router.post("/swarm-execute")
async def swarm_execute(
    req: SwarmExecuteRequest,
    session: AsyncSession = Depends(get_async_session),
):
    """Create a parallel swarm execution session.

    Validates the task DAG and dispatches it to the engine for parallel
    execution. Returns the swarm_id — the planner subscribes to
    djinnbot:swarm:{swarm_id}:progress for real-time events, or polls
    GET /v1/internal/swarm/{swarm_id} for state.
    """
    logger.info(
        f"Swarm execute: agent={req.agent_id}, tasks={len(req.tasks)}, "
        f"max_concurrent={req.max_concurrent}"
    )

    # Validate DAG
    errors = _validate_dag(req.tasks)
    if errors:
        raise HTTPException(status_code=400, detail=f"Invalid DAG: {'; '.join(errors)}")

    # Generate swarm ID
    swarm_id = f"swarm_{uuid.uuid4().hex[:12]}"

    # Build the swarm payload for the engine
    swarm_payload = {
        "swarm_id": swarm_id,
        "agent_id": req.agent_id,
        "tasks": [
            {
                "key": t.key,
                "title": t.title,
                "projectId": t.project_id,
                "taskId": t.task_id,
                "executionPrompt": t.execution_prompt,
                "dependencies": t.dependencies,
                "model": t.model,
                "timeoutSeconds": t.timeout_seconds,
            }
            for t in req.tasks
        ],
        "maxConcurrent": req.max_concurrent,
        "deviationRules": req.deviation_rules,
        "globalTimeoutSeconds": req.global_timeout_seconds,
    }

    # Dispatch to engine via Redis
    if dependencies.redis_client:
        try:
            await dependencies.redis_client.xadd(
                "djinnbot:events:new_swarms",
                {"payload": json.dumps(swarm_payload)},
            )
            logger.info(f"Swarm dispatched: {swarm_id} ({len(req.tasks)} tasks)")
        except Exception as e:
            logger.error(f"Failed to dispatch swarm to Redis: {e}")
            raise HTTPException(
                status_code=503, detail="Failed to dispatch swarm — Redis unavailable"
            )
    else:
        raise HTTPException(
            status_code=503, detail="Redis not available — cannot dispatch swarm"
        )

    # Compute initial DAG info for response
    root_tasks = [t.key for t in req.tasks if not t.dependencies]
    max_depth = _compute_dag_depth(req.tasks)

    return {
        "swarm_id": swarm_id,
        "status": "dispatched",
        "total_tasks": len(req.tasks),
        "max_concurrent": req.max_concurrent,
        "root_tasks": root_tasks,
        "max_depth": max_depth,
        "progress_channel": f"djinnbot:swarm:{swarm_id}:progress",
    }


@router.get("/swarm/{swarm_id}")
async def get_swarm_state(swarm_id: str):
    """Get the current state of a swarm execution session.

    Reads from Redis (written by the engine's SwarmSessionManager).
    Used as a polling fallback when Redis pub/sub is not available.
    """
    if not dependencies.redis_client:
        raise HTTPException(status_code=503, detail="Redis not available")

    state_key = f"djinnbot:swarm:{swarm_id}:state"
    try:
        raw = await dependencies.redis_client.get(state_key)
        if not raw:
            raise HTTPException(status_code=404, detail=f"Swarm {swarm_id} not found")
        return json.loads(raw)
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Failed to read swarm state: {e}")
        raise HTTPException(status_code=500, detail="Failed to read swarm state")


@router.post("/swarm/{swarm_id}/cancel")
async def cancel_swarm(swarm_id: str):
    """Cancel a running swarm execution session.

    Publishes a cancel command to the engine via Redis.
    """
    if not dependencies.redis_client:
        raise HTTPException(status_code=503, detail="Redis not available")

    try:
        await dependencies.redis_client.publish(
            f"djinnbot:swarm:{swarm_id}:control",
            json.dumps({"action": "cancel"}),
        )
        return {"status": "cancel_requested", "swarm_id": swarm_id}
    except Exception as e:
        logger.error(f"Failed to cancel swarm: {e}")
        raise HTTPException(status_code=500, detail="Failed to send cancel command")


# ══════════════════════════════════════════════════════════════════════════
# HELPERS
# ══════════════════════════════════════════════════════════════════════════


def _compute_dag_depth(tasks: list[SwarmTaskDefModel]) -> int:
    """Compute the critical path depth of the DAG."""
    depths: dict[str, int] = {}
    adj: dict[str, list[str]] = {t.key: t.dependencies for t in tasks}

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

    return max(depth(t.key) for t in tasks) if tasks else 0
