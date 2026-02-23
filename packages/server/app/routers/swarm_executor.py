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

import asyncio
import json
import uuid
from typing import Optional

from fastapi import APIRouter, HTTPException, Request
from fastapi.responses import StreamingResponse
from pydantic import BaseModel, Field

from app import dependencies
from app.logging_config import get_logger

logger = get_logger(__name__)

router = APIRouter()


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


@router.get("/swarms")
async def list_swarms():
    """List recent swarm sessions (from Redis).

    Scans for djinnbot:swarm:*:state keys. Results are ephemeral
    (TTL 1 hour) — only active and recently-finished swarms appear.
    """
    if not dependencies.redis_client:
        raise HTTPException(status_code=503, detail="Redis not available")

    try:
        swarms = []
        cursor = 0
        while True:
            cursor, keys = await dependencies.redis_client.scan(
                cursor, match="djinnbot:swarm:*:state", count=100
            )
            for key in keys:
                raw = await dependencies.redis_client.get(key)
                if raw:
                    try:
                        state = json.loads(
                            raw if isinstance(raw, str) else raw.decode("utf-8")
                        )
                        swarms.append(state)
                    except (json.JSONDecodeError, AttributeError):
                        pass
            if cursor == 0:
                break

        # Sort by created_at descending (most recent first)
        swarms.sort(key=lambda s: s.get("created_at", 0), reverse=True)
        return {"swarms": swarms}
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Failed to list swarms: {e}")
        raise HTTPException(status_code=500, detail="Failed to list swarms")


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


@router.get("/swarm/{swarm_id}/stream")
async def stream_swarm_events(swarm_id: str, request: Request):
    """SSE endpoint — streams real-time swarm progress events.

    On connect, emits the full current state as a 'state' event, then
    subscribes to djinnbot:swarm:{swarm_id}:progress for live updates.
    Sends keepalive pings every 15s. Closes when the swarm completes
    or the client disconnects.

    Event types:
    - state: Full SwarmSessionState snapshot (sent on connect)
    - swarm:task_started: A task executor was spawned
    - swarm:task_completed: A task executor finished successfully
    - swarm:task_failed: A task executor failed
    - swarm:task_skipped: A task was skipped (dependency failed)
    - swarm:completed: All tasks finished (success)
    - swarm:failed: Swarm finished with failures
    """
    if not dependencies.redis_client:
        raise HTTPException(status_code=503, detail="Redis not available")

    async def event_generator():
        pubsub = dependencies.redis_client.pubsub()
        channel = f"djinnbot:swarm:{swarm_id}:progress"
        state_key = f"djinnbot:swarm:{swarm_id}:state"

        await pubsub.subscribe(channel)

        try:
            # Bootstrap: send current state snapshot so the client has
            # the full picture immediately, even if events were missed.
            raw_state = await dependencies.redis_client.get(state_key)
            if raw_state:
                state_data = (
                    raw_state
                    if isinstance(raw_state, str)
                    else raw_state.decode("utf-8")
                )
                yield f"event: state\ndata: {state_data}\n\n"
            else:
                yield f"event: state\ndata: {json.dumps({'swarm_id': swarm_id, 'status': 'pending', 'tasks': []})}\n\n"

            terminal = False
            while not terminal:
                # Check if client disconnected
                if await request.is_disconnected():
                    break

                try:
                    message = await asyncio.wait_for(
                        pubsub.get_message(
                            ignore_subscribe_messages=True, timeout=None
                        ),
                        timeout=15.0,
                    )
                    if message and message["type"] == "message":
                        data = message["data"]
                        if isinstance(data, bytes):
                            data = data.decode("utf-8")
                        yield f"data: {data}\n\n"

                        # Check if this is a terminal event
                        try:
                            parsed = json.loads(data)
                            evt_type = parsed.get("type", "")
                            if evt_type in ("swarm:completed", "swarm:failed"):
                                # Send one final full state snapshot
                                final_state = await dependencies.redis_client.get(
                                    state_key
                                )
                                if final_state:
                                    fs = (
                                        final_state
                                        if isinstance(final_state, str)
                                        else final_state.decode("utf-8")
                                    )
                                    yield f"event: state\ndata: {fs}\n\n"
                                terminal = True
                        except (json.JSONDecodeError, AttributeError):
                            pass
                    # No message within timeout — send keepalive
                    else:
                        yield ": ping\n\n"

                except asyncio.TimeoutError:
                    yield ": ping\n\n"

        except asyncio.CancelledError:
            raise
        finally:
            await pubsub.unsubscribe(channel)
            await pubsub.close()

    return StreamingResponse(
        event_generator(),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache",
            "Connection": "keep-alive",
            "X-Accel-Buffering": "no",
        },
    )


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
