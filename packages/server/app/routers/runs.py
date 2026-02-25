"""Run management endpoints."""

import json
from typing import Any
from fastapi import APIRouter, HTTPException, Depends

from app.logging_config import get_logger

logger = get_logger(__name__)
from pydantic import BaseModel
from sqlalchemy import select, update, delete, func
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import selectinload

from app.database import get_async_session
from app.models.run import Run, Step, LoopState, Output
from app.models.project import Project, Task
from app import dependencies
from app.utils import validate_pipeline_exists, now_ms, gen_id

router = APIRouter()


class StartRunRequest(BaseModel):
    pipeline_id: str
    task: str
    context: str | None = None
    project_id: str | None = None  # Optional: link run to project for worktree support


class RestartStepRequest(BaseModel):
    context: str | None = None


class RestartRunRequest(BaseModel):
    context: str | None = None


class LoopItem(BaseModel):
    id: str
    value: Any  # Can be dict, string, etc.
    status: str = "pending"  # pending, running, completed, failed
    output: Any | None = None


class CreateLoopStateRequest(BaseModel):
    step_id: str
    items: list[LoopItem]
    current_index: int = 0


class UpdateLoopItemRequest(BaseModel):
    status: str | None = None
    output: Any | None = None


class CreateStepRequest(BaseModel):
    id: str  # unique step execution id
    step_id: str  # step definition id from pipeline
    agent_id: str
    inputs: dict = {}
    human_context: str | None = None
    max_retries: int = 3


class UpdateStepRequest(BaseModel):
    status: str | None = None
    session_id: str | None = None
    inputs: dict | None = None
    outputs: dict | None = None
    error: str | None = None
    retry_count: int | None = None
    started_at: int | None = None
    completed_at: int | None = None
    human_context: str | None = None


class SetOutputRequest(BaseModel):
    step_id: str
    key: str
    value: str


class UpdateRunRequest(BaseModel):
    status: str | None = None
    outputs: dict | None = None
    current_step_id: str | None = None
    human_context: str | None = None
    completed_at: int | None = None
    key_resolution: str | None = None
    initiated_by_user_id: str | None = None
    model_override: str | None = None


@router.post("/")
async def start_run(
    req: StartRunRequest, session: AsyncSession = Depends(get_async_session)
):
    """Start a new pipeline run."""
    logger.debug(f"start_run: pipeline_id={req.pipeline_id}, task={req.task[:50]}...")

    # Validate pipeline exists by checking filesystem
    if not validate_pipeline_exists(req.pipeline_id):
        raise HTTPException(
            status_code=404, detail=f"Pipeline {req.pipeline_id} not found"
        )

    # Create run record using ORM
    now = now_ms()

    # Look up project workspace_type so it propagates to the run
    run_workspace_type: str | None = None
    if req.project_id:
        try:
            proj_result = await session.execute(
                select(Project.workspace_type).where(Project.id == req.project_id)
            )
            run_workspace_type = proj_result.scalar_one_or_none()
        except Exception:
            pass  # Non-fatal — engine falls back to inference

    run = Run(
        id=gen_id("run_"),
        pipeline_id=req.pipeline_id,
        project_id=req.project_id,  # Link to project for worktree support
        task_description=req.task,
        status="pending",
        current_step_id=None,
        outputs="{}",
        human_context=req.context,
        workspace_type=run_workspace_type,
        created_at=now,
        updated_at=now,
    )
    session.add(run)
    await session.flush()  # Get ID before commit

    # Publish notification to Redis for the engine worker to pick up
    if dependencies.redis_client:
        try:
            # Signal only - Engine fetches full data via API
            await dependencies.redis_client.xadd(
                "djinnbot:events:new_runs",
                {"event": "run:new", "run_id": run.id, "pipeline_id": run.pipeline_id},
            )
            logger.debug(f"start_run: published signal to new_runs, run_id={run.id}")
            # Count current active runs for live counter
            from app.database import AsyncSessionLocal
            from sqlalchemy import text as _text

            active_count = 0
            try:
                async with AsyncSessionLocal() as _s:
                    _r = await _s.execute(
                        _text("SELECT COUNT(*) FROM runs WHERE status = 'running'")
                    )
                    active_count = _r.scalar() or 0
            except Exception:
                pass
            # Also publish to global events stream for dashboard SSE
            global_event = {
                "type": "RUN_CREATED",
                "runId": run.id,
                "pipelineId": req.pipeline_id,
                "taskDescription": req.task,
                "activeRuns": active_count,
                "timestamp": now,
            }
            await dependencies.redis_client.xadd(
                "djinnbot:events:global", {"data": json.dumps(global_event)}
            )
            logger.debug(f"start_run: published global event, run_id={run.id}")
        except Exception as e:
            # Log but don't fail the request if Redis is down
            logger.warning(f"Failed to publish run notification to Redis: {e}")

    return {
        "id": run.id,
        "pipeline_id": run.pipeline_id,
        "task": run.task_description,
        "status": run.status,
        "created_at": run.created_at,
        "updated_at": run.updated_at,
    }


@router.get("/")
async def list_runs(
    pipeline_id: str | None = None,
    status: str | None = None,
    session: AsyncSession = Depends(get_async_session),
):
    """List pipeline runs with optional filters."""
    logger.debug(f"list_runs: pipeline_id={pipeline_id}, status={status}")

    query = select(Run)

    if pipeline_id:
        query = query.where(Run.pipeline_id == pipeline_id)
    if status:
        query = query.where(Run.status == status)

    query = query.order_by(Run.created_at.desc())

    result = await session.execute(query)
    runs = result.scalars().all()

    logger.debug(f"list_runs: found {len(runs)} runs")

    return [
        {
            "id": r.id,
            "pipeline_id": r.pipeline_id,
            "project_id": r.project_id,
            "task": r.task_description,
            "status": r.status,
            "current_step": r.current_step_id,
            "outputs": json.loads(r.outputs) if r.outputs else {},
            "created_at": r.created_at,
            "updated_at": r.updated_at,
            "completed_at": r.completed_at,
            "human_context": r.human_context,
            "key_resolution": json.loads(r.key_resolution)
            if getattr(r, "key_resolution", None)
            else None,
            "initiated_by_user_id": getattr(r, "initiated_by_user_id", None),
        }
        for r in runs
    ]


@router.get("/{run_id}")
async def get_run(run_id: str, session: AsyncSession = Depends(get_async_session)):
    """Get run details including step progress."""
    import os
    from pathlib import Path

    logger.debug(f"get_run: run_id={run_id}")

    result = await session.execute(
        select(Run).options(selectinload(Run.steps)).where(Run.id == run_id)
    )
    run = result.scalar_one_or_none()

    if not run:
        raise HTTPException(status_code=404, detail=f"Run {run_id} not found")

    # Check if workspace exists (helps dashboard show status).
    # For persistent_directory runs, the workspace is the project directory.
    runs_dir = os.getenv("SHARED_RUNS_DIR", "/data/runs")
    workspaces_dir = os.getenv("WORKSPACES_DIR", "/data/workspaces")
    ws_type = getattr(run, "workspace_type", None)
    if ws_type == "persistent_directory" and run.project_id:
        workspace_path = Path(workspaces_dir) / run.project_id
    else:
        workspace_path = Path(runs_dir) / run_id
    workspace_exists = workspace_path.exists()
    workspace_has_git = (
        (workspace_path / ".git").exists() if workspace_exists else False
    )

    # Sort steps by rowid
    sorted_steps = sorted(run.steps, key=lambda s: getattr(s, "rowid", 0) or 0)

    # Resolve the effective key_user_id for per-user key resolution in the engine.
    # Priority: 1) Run-level initiated_by_user_id (who triggered this run)
    #           2) Project-level key_user_id (configured in project settings)
    #           3) None (system-level instance keys)
    key_user_id = getattr(run, "initiated_by_user_id", None)
    if not key_user_id and run.project_id:
        from app.models.project import Project

        proj_result = await session.execute(
            select(Project.key_user_id).where(Project.id == run.project_id)
        )
        proj_row = proj_result.scalar_one_or_none()
        if proj_row:
            key_user_id = proj_row

    return {
        "id": run.id,
        "pipeline_id": run.pipeline_id,
        "project_id": run.project_id,  # CRITICAL: Engine needs this for worktree creation
        "key_user_id": key_user_id,  # Multi-user: whose API keys to use for this run
        "initiated_by_user_id": getattr(run, "initiated_by_user_id", None),
        "model_override": getattr(run, "model_override", None),
        "key_resolution": json.loads(run.key_resolution)
        if getattr(run, "key_resolution", None)
        else None,
        "task": run.task_description,
        "status": run.status,
        "current_step": run.current_step_id,
        "outputs": json.loads(run.outputs) if run.outputs else {},
        "created_at": run.created_at,
        "updated_at": run.updated_at,
        "completed_at": run.completed_at,
        "human_context": run.human_context,
        "task_branch": getattr(run, "task_branch", None),
        "workspace_type": getattr(run, "workspace_type", None),
        "workspace_exists": workspace_exists,
        "workspace_has_git": workspace_has_git,
        "steps": [
            {
                "id": s.id,
                "step_id": s.step_id,
                "agent_id": s.agent_id,
                "status": s.status,
                "outputs": json.loads(s.outputs) if s.outputs else {},
                "inputs": json.loads(s.inputs) if s.inputs else {},
                "error": s.error,
                "retry_count": s.retry_count,
                "max_retries": s.max_retries,
                "session_id": s.session_id,
                "started_at": s.started_at,
                "completed_at": s.completed_at,
                "human_context": s.human_context,
                "model_used": getattr(s, "model_used", None),
            }
            for s in sorted_steps
        ],
    }


@router.patch("/{run_id}")
async def update_run(
    run_id: str,
    req: UpdateRunRequest,
    session: AsyncSession = Depends(get_async_session),
):
    """Update run status, outputs, or current step."""
    logger.debug(
        f"update_run: run_id={run_id}, updates={req.model_dump(exclude_none=True)}"
    )

    # Fetch existing run
    result = await session.execute(select(Run).where(Run.id == run_id))
    run = result.scalar_one_or_none()
    if not run:
        raise HTTPException(status_code=404, detail=f"Run {run_id} not found")

    # Apply updates
    if req.status is not None:
        run.status = req.status
    if req.outputs is not None:
        run.outputs = json.dumps(req.outputs)
    if req.current_step_id is not None:
        run.current_step_id = req.current_step_id
    if req.human_context is not None:
        run.human_context = req.human_context
    if req.completed_at is not None:
        run.completed_at = req.completed_at
    if req.key_resolution is not None:
        run.key_resolution = req.key_resolution
    if req.initiated_by_user_id is not None:
        run.initiated_by_user_id = req.initiated_by_user_id
    if req.model_override is not None:
        run.model_override = req.model_override

    run.updated_at = now_ms()

    await session.flush()

    # Publish update event to Redis for dashboard SSE
    if dependencies.redis_client:
        try:
            # Compute active_runs so dashboard can update live counter
            from app.database import AsyncSessionLocal
            from sqlalchemy import text as _text

            active_count = 0
            try:
                async with AsyncSessionLocal() as _s:
                    _r = await _s.execute(
                        _text("SELECT COUNT(*) FROM runs WHERE status = 'running'")
                    )
                    active_count = _r.scalar() or 0
            except Exception:
                pass
            event = {
                "type": "RUN_UPDATED",
                "runId": run_id,
                "status": run.status,
                "activeRuns": active_count,
                "timestamp": run.updated_at,
            }
            await dependencies.redis_client.xadd(
                "djinnbot:events:global", {"data": json.dumps(event)}
            )
        except Exception as e:
            logger.warning(f"Failed to publish run update to Redis: {e}")

    return {
        "id": run.id,
        "pipeline_id": run.pipeline_id,
        "status": run.status,
        "outputs": json.loads(run.outputs),
        "current_step_id": run.current_step_id,
        "updated_at": run.updated_at,
    }


@router.post("/{run_id}/cancel")
async def cancel_run(run_id: str, session: AsyncSession = Depends(get_async_session)):
    """Cancel a running pipeline."""
    logger.debug(f"cancel_run: run_id={run_id}")

    now = now_ms()

    # Get run
    result = await session.execute(select(Run).where(Run.id == run_id))
    run = result.scalar_one_or_none()

    if not run:
        raise HTTPException(status_code=404, detail=f"Run {run_id} not found")

    current_step_id = run.current_step_id
    previous_status = run.status

    # Update run status
    run.status = "cancelled"
    run.updated_at = now
    run.completed_at = now

    await session.flush()

    logger.debug(f"cancel_run: run_id={run_id}, status {previous_status} -> cancelled")

    # Notify engine via Redis
    if dependencies.redis_client:
        stream_key = f"djinnbot:events:run:{run_id}"
        event = {
            "type": "HUMAN_INTERVENTION",
            "runId": run_id,
            "stepId": current_step_id or "",
            "action": "stop",
            "context": "Cancelled via API",
            "timestamp": now,
        }
        try:
            await dependencies.redis_client.xadd(
                stream_key, {"data": json.dumps(event)}
            )
            # Also publish to global stream for dashboard
            from app.database import AsyncSessionLocal
            from sqlalchemy import text as _text

            active_count = 0
            try:
                async with AsyncSessionLocal() as _s:
                    _r = await _s.execute(
                        _text("SELECT COUNT(*) FROM runs WHERE status = 'running'")
                    )
                    active_count = _r.scalar() or 0
            except Exception:
                pass
            global_event = {
                "type": "RUN_STATUS_CHANGED",
                "runId": run_id,
                "status": "cancelled",
                "activeRuns": active_count,
                "timestamp": now,
            }
            await dependencies.redis_client.xadd(
                "djinnbot:events:global", {"data": json.dumps(global_event)}
            )
            logger.debug(f"cancel_run: published events to Redis, run_id={run_id}")
        except Exception as e:
            logger.warning(f"Failed to publish cancel event: {e}")

    return {"run_id": run_id, "status": "cancelled"}


@router.post("/{run_id}/restart")
async def restart_run(
    run_id: str,
    req: RestartRunRequest | None = None,
    session: AsyncSession = Depends(get_async_session),
):
    """Restart an entire run from scratch."""
    logger.debug(f"restart_run: run_id={run_id}")

    now = now_ms()

    # Get run
    result = await session.execute(select(Run).where(Run.id == run_id))
    run = result.scalar_one_or_none()

    if not run:
        raise HTTPException(status_code=404, detail=f"Run {run_id} not found")

    pipeline_id = run.pipeline_id
    task = run.task_description
    previous_status = run.status

    # Reset all steps to pending, clear errors/outputs
    await session.execute(
        update(Step)
        .where(Step.run_id == run_id)
        .values(
            status="pending",
            error=None,
            outputs="{}",
            started_at=None,
            completed_at=None,
            retry_count=0,
            human_context=req.context if req else None,
        )
    )

    # Reset run status to pending, clear completed_at
    run.status = "pending"
    run.updated_at = now
    run.completed_at = None
    run.human_context = req.context if req else None

    await session.flush()

    logger.debug(f"restart_run: run_id={run_id}, status {previous_status} -> pending")

    # Publish Redis events
    if dependencies.redis_client:
        stream_key = f"djinnbot:events:run:{run_id}"

        # RUN_CREATED event (so engine picks it up)
        run_created_event = {
            "type": "RUN_CREATED",
            "runId": run_id,
            "pipelineId": pipeline_id,
            "task": task,
            "timestamp": now,
        }

        try:
            await dependencies.redis_client.xadd(
                stream_key, {"data": json.dumps(run_created_event)}
            )
            # Signal only - Engine fetches full data via API
            await dependencies.redis_client.xadd(
                "djinnbot:events:new_runs",
                {"event": "run:new", "run_id": run.id, "pipeline_id": run.pipeline_id},
            )
            logger.debug(f"restart_run: published events to Redis, run_id={run_id}")
        except Exception as e:
            logger.warning(f"Failed to publish restart events: {e}")

    return await get_run(run_id, session)


@router.post("/{run_id}/pause")
async def pause_run(run_id: str, session: AsyncSession = Depends(get_async_session)):
    """Pause a running pipeline."""
    logger.debug(f"pause_run: run_id={run_id}")

    now = now_ms()

    # Get run
    result = await session.execute(select(Run).where(Run.id == run_id))
    run = result.scalar_one_or_none()

    if not run:
        raise HTTPException(status_code=404, detail=f"Run {run_id} not found")

    current_step_id = run.current_step_id
    previous_status = run.status

    # Set run status to paused
    run.status = "paused"
    run.updated_at = now

    await session.flush()

    logger.debug(f"pause_run: run_id={run_id}, status {previous_status} -> paused")

    # Publish HUMAN_INTERVENTION event
    if dependencies.redis_client:
        stream_key = f"djinnbot:events:run:{run_id}"
        event = {
            "type": "HUMAN_INTERVENTION",
            "runId": run_id,
            "stepId": current_step_id or "",
            "action": "stop",
            "context": "Paused via API",
            "timestamp": now,
        }
        try:
            await dependencies.redis_client.xadd(
                stream_key, {"data": json.dumps(event)}
            )
            # Also publish to global stream for dashboard
            global_event = {
                "type": "RUN_STATUS_CHANGED",
                "runId": run_id,
                "status": "paused",
                "timestamp": now,
            }
            await dependencies.redis_client.xadd(
                "djinnbot:events:global", {"data": json.dumps(global_event)}
            )
            logger.debug(f"pause_run: published events to Redis, run_id={run_id}")
        except Exception as e:
            logger.warning(f"Failed to publish pause event: {e}")

    return {"run_id": run_id, "status": "paused"}


@router.post("/{run_id}/resume")
async def resume_run(run_id: str, session: AsyncSession = Depends(get_async_session)):
    """Resume a paused pipeline."""
    logger.debug(f"resume_run: run_id={run_id}")

    now = now_ms()

    # Get run
    result = await session.execute(select(Run).where(Run.id == run_id))
    run = result.scalar_one_or_none()

    if not run:
        raise HTTPException(status_code=404, detail=f"Run {run_id} not found")

    previous_status = run.status

    # Set run status back to running
    run.status = "running"
    run.updated_at = now

    # Get queued steps to re-queue them
    result = await session.execute(
        select(Step.step_id, Step.agent_id)
        .where(Step.run_id == run_id)
        .where(Step.status == "queued")
    )
    queued_steps = result.all()

    await session.flush()

    logger.debug(f"resume_run: run_id={run_id}, status {previous_status} -> running")

    # Re-queue any steps that were queued when paused
    if dependencies.redis_client and queued_steps:
        stream_key = f"djinnbot:events:run:{run_id}"

        try:
            for step_row in queued_steps:
                step_queued_event = {
                    "type": "STEP_QUEUED",
                    "runId": run_id,
                    "stepId": step_row.step_id,
                    "agentId": step_row.agent_id,
                    "timestamp": now,
                }
                await dependencies.redis_client.xadd(
                    stream_key, {"data": json.dumps(step_queued_event)}
                )
            # Also publish to global stream for dashboard
            global_event = {
                "type": "RUN_STATUS_CHANGED",
                "runId": run_id,
                "status": "running",
                "timestamp": now,
            }
            await dependencies.redis_client.xadd(
                "djinnbot:events:global", {"data": json.dumps(global_event)}
            )
            logger.debug(
                f"resume_run: requeued {len(queued_steps)} steps, run_id={run_id}"
            )
        except Exception as e:
            logger.warning(f"Failed to publish resume events: {e}")

    return {
        "run_id": run_id,
        "status": "running",
        "requeued_steps": len(queued_steps) if queued_steps else 0,
    }


@router.post("/{run_id}/steps/{step_id}/restart")
async def restart_step(
    run_id: str,
    step_id: str,
    req: RestartStepRequest | None = None,
    session: AsyncSession = Depends(get_async_session),
):
    """Restart a specific step with optional human context."""
    logger.debug(f"restart_step: run_id={run_id}, step_id={step_id}")

    now = now_ms()

    # Get run
    result = await session.execute(select(Run).where(Run.id == run_id))
    run = result.scalar_one_or_none()

    if not run:
        raise HTTPException(status_code=404, detail=f"Run {run_id} not found")

    # Get step
    result = await session.execute(
        select(Step).where(Step.run_id == run_id).where(Step.step_id == step_id)
    )
    step = result.scalar_one_or_none()

    if not step:
        raise HTTPException(
            status_code=404, detail=f"Step {step_id} not found in run {run_id}"
        )

    agent_id = step.agent_id
    previous_step_status = step.status
    previous_run_status = run.status

    # Update step status to pending
    step.status = "pending"
    step.retry_count = 0
    step.error = None
    step.started_at = None
    step.completed_at = None
    step.human_context = req.context if req else None

    # Update run status to running if it was completed or failed
    if run.status in ("completed", "failed"):
        run.status = "running"
        run.updated_at = now
        run.completed_at = None
    else:
        run.status = "running"
        run.updated_at = now

    await session.commit()

    logger.debug(
        f"restart_step: run_id={run_id}, step_id={step_id}, step {previous_step_status} -> pending, run {previous_run_status} -> running"
    )

    # Publish Redis events — commit MUST happen before this so the engine
    # sees the updated run/step status immediately when it resumes.
    if dependencies.redis_client:
        stream_key = f"djinnbot:events:run:{run_id}"

        # HUMAN_INTERVENTION event (picked up if engine is still subscribed)
        intervention_event = {
            "type": "HUMAN_INTERVENTION",
            "runId": run_id,
            "stepId": step_id,
            "action": "restart",
            "context": req.context or "",
            "timestamp": now,
        }

        try:
            await dependencies.redis_client.xadd(
                stream_key, {"data": json.dumps(intervention_event)}
            )
            # Signal the engine to resume this run via the new_runs stream.
            # This is necessary when the run was already completed/stopped —
            # the engine will have torn down its subscription (stopRun) and
            # the HUMAN_INTERVENTION event above would be missed. By posting
            # to new_runs, resumeRun() re-subscribes and picks up the pending step.
            await dependencies.redis_client.xadd(
                "djinnbot:events:new_runs",
                {"run_id": run_id, "pipeline_id": run.pipeline_id},
            )
            logger.debug(
                f"restart_step: published events to Redis, run_id={run_id}, step_id={step_id}"
            )
        except Exception as e:
            logger.warning(f"Failed to publish restart events: {e}")

    # Return updated run
    return await get_run(run_id, session)


@router.get("/{run_id}/logs")
async def get_run_logs(run_id: str):
    """Get event log for a run from Redis stream."""
    logger.debug(f"get_run_logs: run_id={run_id}")

    if not dependencies.redis_client:
        raise HTTPException(status_code=503, detail="Redis not connected")

    stream_key = f"djinnbot:events:run:{run_id}"

    try:
        # Read all messages from stream
        messages = await dependencies.redis_client.xrange(stream_key)

        logs = []
        for msg_id, fields in messages:
            data = fields.get("data", "{}")
            try:
                event = json.loads(data)
                logs.append(event)
            except json.JSONDecodeError:
                logs.append({"raw": data})

        logger.debug(f"get_run_logs: retrieved {len(logs)} events, run_id={run_id}")

        return logs
    except Exception as e:
        # Stream might not exist yet
        return []


@router.delete("/{run_id}")
async def delete_run(run_id: str, session: AsyncSession = Depends(get_async_session)):
    """Delete a run and its steps."""
    logger.debug(f"delete_run: run_id={run_id}")

    # Get run
    result = await session.execute(select(Run).where(Run.id == run_id))
    run = result.scalar_one_or_none()

    if not run:
        raise HTTPException(status_code=404, detail="Run not found")

    # Delete run (cascade deletes steps)
    await session.delete(run)
    await session.flush()

    # Publish to Redis for dashboard updates
    if dependencies.redis_client:
        try:
            event = {"type": "RUN_DELETED", "runId": run_id, "timestamp": now_ms()}
            await dependencies.redis_client.xadd(
                "djinnbot:events:global", {"data": json.dumps(event)}
            )
            logger.debug(f"delete_run: published RUN_DELETED event, run_id={run_id}")
        except Exception:
            pass

    return {"status": "deleted", "run_id": run_id}


@router.delete("/")
async def bulk_delete_runs(
    status: str | None = None,
    before: int | None = None,
    session: AsyncSession = Depends(get_async_session),
):
    """Bulk delete runs by status and/or age."""
    logger.debug(f"bulk_delete_runs: status={status}, before={before}")

    if not status and not before:
        raise HTTPException(
            status_code=400, detail="Must specify status or before filter"
        )

    # Build query to find matching runs
    query = select(Run.id).where(Run.id != None)  # Base condition

    if status:
        query = query.where(Run.status == status)
    if before:
        query = query.where(Run.created_at < before)

    result = await session.execute(query)
    run_ids = result.scalars().all()

    if run_ids:
        # Delete associated rows first (cascade handles ORM deletes, but not bulk SQL deletes)
        await session.execute(delete(Output).where(Output.run_id.in_(run_ids)))
        await session.execute(delete(Step).where(Step.run_id.in_(run_ids)))

        # Delete runs
        delete_query = delete(Run).where(Run.id.in_(run_ids))
        result = await session.execute(delete_query)
        rowcount = result.rowcount
    else:
        rowcount = 0

    logger.debug(f"bulk_delete_runs: deleted {rowcount} runs")

    # Publish to Redis
    if dependencies.redis_client:
        try:
            event = {
                "type": "RUNS_BULK_DELETED",
                "count": rowcount,
                "filters": {"status": status, "before": before},
                "timestamp": now_ms(),
            }
            await dependencies.redis_client.xadd(
                "djinnbot:events:global", {"data": json.dumps(event)}
            )
            logger.debug(
                f"bulk_delete_runs: published bulk delete event, count={rowcount}"
            )
        except Exception:
            pass

    return {"status": "deleted", "count": rowcount}


@router.post("/{run_id}/loop-state")
async def create_loop_state(
    run_id: str,
    req: CreateLoopStateRequest,
    session: AsyncSession = Depends(get_async_session),
):
    """Create or replace loop state for a step."""
    logger.debug(
        f"create_loop_state: run_id={run_id}, step_id={req.step_id}, items={len(req.items)}"
    )

    # Verify run exists
    run_result = await session.execute(select(Run).where(Run.id == run_id))
    if not run_result.scalar_one_or_none():
        raise HTTPException(status_code=404, detail=f"Run {run_id} not found")

    # Check if loop state already exists
    existing = await session.execute(
        select(LoopState).where(
            LoopState.run_id == run_id, LoopState.step_id == req.step_id
        )
    )
    loop_state = existing.scalar_one_or_none()

    items_json = json.dumps([item.model_dump() for item in req.items])

    if loop_state:
        # Update existing
        loop_state.items = items_json
        loop_state.current_index = req.current_index
    else:
        # Create new
        loop_state = LoopState(
            run_id=run_id,
            step_id=req.step_id,
            items=items_json,
            current_index=req.current_index,
        )
        session.add(loop_state)

    await session.flush()

    return {
        "run_id": run_id,
        "step_id": req.step_id,
        "items": json.loads(loop_state.items),
        "current_index": loop_state.current_index,
    }


@router.get("/{run_id}/loop-state/{step_id}")
async def get_loop_state(
    run_id: str, step_id: str, session: AsyncSession = Depends(get_async_session)
):
    """Get loop state for a step."""
    logger.debug(f"get_loop_state: run_id={run_id}, step_id={step_id}")

    result = await session.execute(
        select(LoopState).where(
            LoopState.run_id == run_id, LoopState.step_id == step_id
        )
    )
    loop_state = result.scalar_one_or_none()

    if not loop_state:
        raise HTTPException(
            status_code=404, detail=f"Loop state not found for step {step_id}"
        )

    return {
        "run_id": loop_state.run_id,
        "step_id": loop_state.step_id,
        "items": json.loads(loop_state.items),
        "current_index": loop_state.current_index,
    }


@router.patch("/{run_id}/loop-state/{step_id}/items/{item_id}")
async def update_loop_item(
    run_id: str,
    step_id: str,
    item_id: str,
    req: UpdateLoopItemRequest,
    session: AsyncSession = Depends(get_async_session),
):
    """Update a specific loop item's status or output."""
    logger.debug(
        f"update_loop_item: run_id={run_id}, step_id={step_id}, item_id={item_id}"
    )

    result = await session.execute(
        select(LoopState).where(
            LoopState.run_id == run_id, LoopState.step_id == step_id
        )
    )
    loop_state = result.scalar_one_or_none()

    if not loop_state:
        raise HTTPException(
            status_code=404, detail=f"Loop state not found for step {step_id}"
        )

    items = json.loads(loop_state.items)
    item_found = False

    for item in items:
        if item["id"] == item_id:
            if req.status is not None:
                item["status"] = req.status
            if req.output is not None:
                item["output"] = req.output
            item_found = True
            break

    if not item_found:
        raise HTTPException(status_code=404, detail=f"Loop item {item_id} not found")

    loop_state.items = json.dumps(items)
    await session.flush()

    return {"run_id": run_id, "step_id": step_id, "item_id": item_id, "updated": True}


@router.post("/{run_id}/loop-state/{step_id}/advance")
async def advance_loop(
    run_id: str, step_id: str, session: AsyncSession = Depends(get_async_session)
):
    """Advance to next pending item in the loop. Returns the next item or null if done."""
    logger.debug(f"advance_loop: run_id={run_id}, step_id={step_id}")

    result = await session.execute(
        select(LoopState).where(
            LoopState.run_id == run_id, LoopState.step_id == step_id
        )
    )
    loop_state = result.scalar_one_or_none()

    if not loop_state:
        raise HTTPException(
            status_code=404, detail=f"Loop state not found for step {step_id}"
        )

    items = json.loads(loop_state.items)

    # Find next pending item starting from current_index
    for i in range(loop_state.current_index, len(items)):
        if items[i]["status"] == "pending":
            loop_state.current_index = i
            await session.flush()
            return {"next_item": items[i], "index": i}

    # No more pending items
    return {"next_item": None, "index": None}


@router.get("/{run_id}/outputs")
async def get_run_outputs(
    run_id: str, session: AsyncSession = Depends(get_async_session)
):
    """Get all accumulated outputs for a run."""
    logger.debug(f"get_run_outputs: run_id={run_id}")

    # Verify run exists
    run_result = await session.execute(select(Run).where(Run.id == run_id))
    run = run_result.scalar_one_or_none()
    if not run:
        raise HTTPException(status_code=404, detail=f"Run {run_id} not found")

    # Get outputs
    result = await session.execute(select(Output).where(Output.run_id == run_id))
    outputs = result.scalars().all()

    # Return as key-value dict
    return {o.key: o.value for o in outputs}


@router.put("/{run_id}/outputs")
async def set_run_output(
    run_id: str,
    req: SetOutputRequest,
    session: AsyncSession = Depends(get_async_session),
):
    """Set or update an output key-value for a run (upsert)."""
    logger.debug(f"set_run_output: run_id={run_id}, key={req.key}")

    # Verify run exists
    run_result = await session.execute(select(Run).where(Run.id == run_id))
    run = run_result.scalar_one_or_none()
    if not run:
        raise HTTPException(status_code=404, detail=f"Run {run_id} not found")

    # Check if output exists
    existing = await session.execute(
        select(Output).where(Output.run_id == run_id, Output.key == req.key)
    )
    output = existing.scalar_one_or_none()

    if output:
        # Update existing
        output.value = req.value
        output.step_id = req.step_id
    else:
        # Create new
        output = Output(
            run_id=run_id,
            step_id=req.step_id,
            key=req.key,
            value=req.value,
        )
        session.add(output)

    await session.commit()

    return {"run_id": run_id, "key": req.key, "value": req.value}


@router.get("/{run_id}/steps")
async def list_run_steps(
    run_id: str,
    status: str | None = None,
    session: AsyncSession = Depends(get_async_session),
):
    """List all steps for a run, optionally filtered by status."""
    logger.debug(f"list_run_steps: run_id={run_id}, status={status}")

    query = select(Step).where(Step.run_id == run_id)
    if status:
        query = query.where(Step.status == status)
    query = query.order_by(Step.started_at.asc().nullslast())

    result = await session.execute(query)
    steps = result.scalars().all()

    return [
        {
            "id": s.id,
            "run_id": s.run_id,
            "step_id": s.step_id,
            "agent_id": s.agent_id,
            "status": s.status,
            "session_id": s.session_id,
            "inputs": json.loads(s.inputs),
            "outputs": json.loads(s.outputs),
            "error": s.error,
            "retry_count": s.retry_count,
            "max_retries": s.max_retries,
            "started_at": s.started_at,
            "completed_at": s.completed_at,
            "human_context": s.human_context,
        }
        for s in steps
    ]


@router.post("/{run_id}/steps")
async def create_step(
    run_id: str,
    req: CreateStepRequest,
    session: AsyncSession = Depends(get_async_session),
):
    """Create a new step execution for a run."""
    logger.debug(
        f"create_step: run_id={run_id}, step_id={req.step_id}, agent_id={req.agent_id}"
    )

    # Verify run exists
    run_result = await session.execute(select(Run).where(Run.id == run_id))
    run = run_result.scalar_one_or_none()
    if not run:
        raise HTTPException(status_code=404, detail=f"Run {run_id} not found")

    # Check if step already exists (handles retries)
    existing = await session.execute(
        select(Step).where(Step.run_id == run_id, Step.step_id == req.step_id)
    )
    existing_step = existing.scalar_one_or_none()

    if existing_step:
        # Reset the step for retry
        logger.debug(
            f"create_step: step already exists, resetting for retry (retry_count={existing_step.retry_count})"
        )
        existing_step.status = "pending"
        existing_step.retry_count = (existing_step.retry_count or 0) + 1
        existing_step.error = None
        existing_step.outputs = "{}"
        existing_step.started_at = None
        existing_step.completed_at = None
        existing_step.human_context = req.human_context
        existing_step.inputs = json.dumps(req.inputs)
        existing_step.agent_id = req.agent_id
        existing_step.max_retries = req.max_retries
        await session.flush()
        step = existing_step
    else:
        # Create new step
        step = Step(
            id=req.id,
            run_id=run_id,
            step_id=req.step_id,
            agent_id=req.agent_id,
            status="pending",
            inputs=json.dumps(req.inputs),
            outputs="{}",
            retry_count=0,
            max_retries=req.max_retries,
            human_context=req.human_context,
        )
        session.add(step)
        await session.flush()

    return {
        "id": step.id,
        "run_id": step.run_id,
        "step_id": step.step_id,
        "agent_id": step.agent_id,
        "status": step.status,
        "inputs": json.loads(step.inputs),
        "outputs": json.loads(step.outputs),
        "retry_count": step.retry_count,
        "max_retries": step.max_retries,
    }


@router.patch("/{run_id}/steps/{step_id}")
async def update_step(
    run_id: str,
    step_id: str,
    req: UpdateStepRequest,
    session: AsyncSession = Depends(get_async_session),
):
    """Update step execution state."""
    logger.debug(f"update_step: run_id={run_id}, step_id={step_id}")

    result = await session.execute(
        select(Step).where(Step.run_id == run_id, Step.step_id == step_id)
    )
    step = result.scalar_one_or_none()
    if not step:
        raise HTTPException(
            status_code=404, detail=f"Step {step_id} not found in run {run_id}"
        )

    if req.status is not None:
        step.status = req.status
    if req.session_id is not None:
        step.session_id = req.session_id
    if req.inputs is not None:
        step.inputs = json.dumps(req.inputs)
    if req.outputs is not None:
        step.outputs = json.dumps(req.outputs)
    if req.error is not None:
        step.error = req.error
    if req.retry_count is not None:
        step.retry_count = req.retry_count
    if req.started_at is not None:
        step.started_at = req.started_at
    if req.completed_at is not None:
        step.completed_at = req.completed_at
    if req.human_context is not None:
        step.human_context = req.human_context

    await session.flush()

    # Publish step update event
    if dependencies.redis_client:
        try:
            event = {
                "type": "STEP_UPDATED",
                "runId": run_id,
                "stepId": step_id,
                "status": step.status,
                "timestamp": now_ms(),
            }
            await dependencies.redis_client.xadd(
                f"djinnbot:events:run:{run_id}", {"data": json.dumps(event)}
            )
        except Exception as e:
            logger.warning(f"Failed to publish step update to Redis: {e}")

    return {
        "id": step.id,
        "run_id": step.run_id,
        "step_id": step.step_id,
        "agent_id": step.agent_id,
        "status": step.status,
        "session_id": step.session_id,
        "inputs": json.loads(step.inputs),
        "outputs": json.loads(step.outputs),
        "error": step.error,
        "retry_count": step.retry_count,
        "started_at": step.started_at,
        "completed_at": step.completed_at,
    }
