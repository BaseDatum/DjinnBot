"""Step management endpoints."""
import json
from fastapi import APIRouter, HTTPException, Depends
from pydantic import BaseModel
from sqlalchemy import select, or_
from sqlalchemy.ext.asyncio import AsyncSession

from app.database import get_async_session
from app.models import Step
from app import dependencies
from app.utils import now_ms
from app.logging_config import get_logger
logger = get_logger(__name__)

router = APIRouter()


class RestartStepRequest(BaseModel):
    context: str | None = None


@router.get("/{run_id}/{step_id}")
async def get_step(
    run_id: str,
    step_id: str,
    session: AsyncSession = Depends(get_async_session)
):
    """Get step execution details."""
    result = await session.execute(
        select(Step).where(
            Step.run_id == run_id,
            or_(Step.step_id == step_id, Step.id == step_id)
        )
    )
    step = result.scalar_one_or_none()
    
    if not step:
        raise HTTPException(
            status_code=404,
            detail=f"Step {step_id} not found for run {run_id}"
        )
    
    return {
        "id": step.id,
        "step_id": step.step_id,
        "agent_id": step.agent_id,
        "status": step.status,
        "outputs": json.loads(step.outputs) if step.outputs else {},
        "inputs": json.loads(step.inputs) if step.inputs else {},
        "error": step.error,
        "retry_count": step.retry_count,
        "max_retries": step.max_retries,
        "session_id": step.session_id,
        "started_at": step.started_at,
        "completed_at": step.completed_at,
        "human_context": step.human_context,
    }


@router.post("/{run_id}/{step_id}/restart")
async def restart_step(
    run_id: str,
    step_id: str,
    req: RestartStepRequest | None = None,
    session: AsyncSession = Depends(get_async_session)
):
    """Restart a step with optional additional context."""
    result = await session.execute(
        select(Step).where(
            Step.run_id == run_id,
            or_(Step.step_id == step_id, Step.id == step_id)
        )
    )
    step = result.scalar_one_or_none()
    
    if not step:
        raise HTTPException(
            status_code=404,
            detail=f"Step {step_id} not found for run {run_id}"
        )
    
    # Update step
    step.status = "pending"
    step.retry_count += 1
    
    # Notify engine via Redis
    if dependencies.redis_client:
        stream_key = f"djinnbot:events:run:{run_id}"
        event = {
            "type": "HUMAN_INTERVENTION",
            "runId": run_id,
            "stepId": step_id,
            "action": "restart",
            "context": req.context if req and req.context else "Restarted via API",
            "timestamp": now_ms()
        }
        try:
            await dependencies.redis_client.xadd(stream_key, {"data": json.dumps(event)})
        except Exception as e:
            logger.warning(f"Failed to publish restart event: {e}")
    
    return {"run_id": run_id, "step_id": step_id, "status": "restarting"}


@router.get("/{run_id}/{step_id}/logs")
async def get_step_logs(run_id: str, step_id: str):
    """Get logs for a specific step execution from Redis stream."""
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
                # Filter by step_id if present in event
                if event.get("stepId") == step_id or event.get("step_id") == step_id:
                    logs.append(event)
            except json.JSONDecodeError:
                continue
        
        return logs
    except Exception:
        # Stream might not exist yet
        return []