"""Session management endpoints."""

import json
import asyncio
from typing import Optional
from fastapi import APIRouter, HTTPException, Depends
from pydantic import BaseModel
from sqlalchemy import select, func
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import selectinload
from fastapi.responses import StreamingResponse

from app.database import get_async_session
from app.models.session import Session, SessionEvent
from app import dependencies
from app.logging_config import get_logger
from app.utils import gen_id, now_ms

logger = get_logger(__name__)
router = APIRouter()


# ============================================================================
# Internal API Models (called by engine SessionPersister)
# ============================================================================


class CreateSessionRequest(BaseModel):
    id: str
    agentId: str
    source: str
    sourceId: Optional[str] = None
    userPrompt: str
    model: str


class UpdateStatusRequest(BaseModel):
    status: str


class AddEventRequest(BaseModel):
    type: str
    timestamp: int
    data: dict


class CompleteSessionRequest(BaseModel):
    output: str
    success: bool
    error: Optional[str] = None


# ============================================================================
# Internal Endpoints (called by engine SessionPersister)
# ============================================================================


@router.post("/internal/sessions")
async def create_session(
    request: CreateSessionRequest, session: AsyncSession = Depends(get_async_session)
):
    """Create a new session (called by engine).

    Uses upsert semantics so that re-running a step (same runId_stepId) resets
    the session to 'starting' instead of raising a PK conflict error.
    """
    logger.debug(f"create_session: id={request.id}, agent={request.agentId}")

    # Fetch existing row first so we can decide whether to insert or reset.
    result = await session.execute(select(Session).where(Session.id == request.id))
    db_session = result.scalar_one_or_none()

    if db_session is None:
        db_session = Session(
            id=request.id,
            agent_id=request.agentId,
            source=request.source,
            source_id=request.sourceId,
            status="starting",
            user_prompt=request.userPrompt,
            model=request.model,
            turn_count=0,
            created_at=now_ms(),
        )
        session.add(db_session)
    else:
        # Re-run: reset the existing session to a clean starting state.
        db_session.agent_id = request.agentId
        db_session.source = request.source
        db_session.source_id = request.sourceId
        db_session.status = "starting"
        db_session.user_prompt = request.userPrompt
        db_session.model = request.model
        db_session.turn_count = 0
        db_session.output = None
        db_session.error = None
        db_session.started_at = None
        db_session.completed_at = None
        db_session.created_at = now_ms()

    await session.commit()

    return {"ok": True, "id": request.id}


@router.patch("/internal/sessions/{session_id}/status")
async def update_session_status(
    session_id: str,
    request: UpdateStatusRequest,
    session: AsyncSession = Depends(get_async_session),
):
    """Update session status (called by engine)."""
    logger.debug(f"update_session_status: id={session_id}, status={request.status}")

    result = await session.execute(select(Session).where(Session.id == session_id))
    db_session = result.scalar_one_or_none()

    if not db_session:
        raise HTTPException(status_code=404, detail=f"Session {session_id} not found")

    db_session.status = request.status
    if request.status == "running" and not db_session.started_at:
        db_session.started_at = now_ms()

    await session.commit()
    return {"ok": True}


@router.post("/internal/sessions/{session_id}/events")
async def add_session_event(
    session_id: str,
    request: AddEventRequest,
    session: AsyncSession = Depends(get_async_session),
):
    """Add an event to a session (called by engine)."""
    logger.debug(f"add_session_event: session={session_id}, type={request.type}")

    event = SessionEvent(
        id=gen_id(),
        session_id=session_id,
        event_type=request.type,
        timestamp=request.timestamp,
        data=json.dumps(request.data),
    )
    session.add(event)
    await session.commit()

    return {"ok": True, "id": event.id}


@router.patch("/internal/sessions/{session_id}/complete")
async def complete_session(
    session_id: str,
    request: CompleteSessionRequest,
    session: AsyncSession = Depends(get_async_session),
):
    """Mark session as completed or failed (called by engine)."""
    logger.debug(f"complete_session: id={session_id}, success={request.success}")

    result = await session.execute(select(Session).where(Session.id == session_id))
    db_session = result.scalar_one_or_none()

    if not db_session:
        raise HTTPException(status_code=404, detail=f"Session {session_id} not found")

    db_session.status = "completed" if request.success else "failed"
    db_session.output = request.output
    db_session.error = request.error
    db_session.completed_at = now_ms()

    await session.commit()
    return {"ok": True}


@router.get("/sessions")
async def list_all_sessions(
    agent_ids: Optional[str] = None,  # comma-separated list of agent IDs to filter by
    limit: int = 100,
    offset: int = 0,
    status: Optional[str] = None,
    session: AsyncSession = Depends(get_async_session),
):
    """List sessions across all agents, optionally filtered by agent IDs."""
    logger.debug(
        f"list_all_sessions: agent_ids={agent_ids}, limit={limit}, offset={offset}, status={status}"
    )

    # Build base query
    query = select(Session)

    # Apply agent filter if provided
    if agent_ids:
        id_list = [a.strip() for a in agent_ids.split(",") if a.strip()]
        if id_list:
            query = query.where(Session.agent_id.in_(id_list))

    # Apply status filter
    if status:
        query = query.where(Session.status == status)

    # Get total count for pagination
    count_query = select(func.count()).select_from(query.subquery())
    total_result = await session.execute(count_query)
    total = total_result.scalar() or 0

    # Apply pagination and ordering
    query = query.order_by(Session.created_at.desc()).limit(limit).offset(offset)

    # Execute query
    result = await session.execute(query)
    sessions = result.scalars().all()

    logger.debug(f"list_all_sessions: found {len(sessions)} sessions (total={total})")

    return {
        "sessions": [
            {
                "id": s.id,
                "agent_id": s.agent_id,
                "source": s.source,
                "source_id": s.source_id,
                "status": s.status,
                "user_prompt": s.user_prompt,
                "output": s.output,
                "error": s.error,
                "model": s.model,
                "turn_count": s.turn_count,
                "created_at": s.created_at,
                "started_at": s.started_at,
                "completed_at": s.completed_at,
            }
            for s in sessions
        ],
        "total": total,
        "hasMore": (offset + len(sessions)) < total,
    }


@router.get("/agents/{agent_id}/sessions")
async def list_agent_sessions(
    agent_id: str,
    limit: int = 50,
    offset: int = 0,
    status: Optional[str] = None,
    session: AsyncSession = Depends(get_async_session),
):
    """List sessions for an agent with optional status filter."""
    logger.debug(
        f"list_agent_sessions: agent_id={agent_id}, limit={limit}, offset={offset}, status={status}"
    )

    # Build base query
    query = select(Session).where(Session.agent_id == agent_id)

    # Apply status filter
    if status:
        query = query.where(Session.status == status)

    # Get total count for pagination
    count_query = select(func.count()).select_from(query.subquery())
    total_result = await session.execute(count_query)
    total = total_result.scalar() or 0

    # Apply pagination and ordering
    query = query.order_by(Session.created_at.desc()).limit(limit).offset(offset)

    # Execute query
    result = await session.execute(query)
    sessions = result.scalars().all()

    logger.debug(f"list_agent_sessions: found {len(sessions)} sessions (total={total})")

    return {
        "sessions": [
            {
                "id": s.id,
                "agent_id": s.agent_id,
                "source": s.source,
                "source_id": s.source_id,
                "status": s.status,
                "user_prompt": s.user_prompt,
                "output": s.output,
                "error": s.error,
                "model": s.model,
                "turn_count": s.turn_count,
                "created_at": s.created_at,
                "started_at": s.started_at,
                "completed_at": s.completed_at,
            }
            for s in sessions
        ],
        "total": total,
        "hasMore": (offset + len(sessions)) < total,
    }


@router.get("/sessions/{session_id}")
async def get_session(
    session_id: str, db_session: AsyncSession = Depends(get_async_session)
):
    """Get session detail with all events."""
    logger.debug(f"get_session: session_id={session_id}")

    # Load session with events
    result = await db_session.execute(
        select(Session)
        .options(selectinload(Session.events))
        .where(Session.id == session_id)
    )
    session = result.scalar_one_or_none()

    if not session:
        raise HTTPException(status_code=404, detail=f"Session {session_id} not found")

    # Sort events by timestamp
    sorted_events = sorted(session.events, key=lambda e: e.timestamp)

    logger.debug(f"get_session: session_id={session_id}, events={len(sorted_events)}")

    return {
        "id": session.id,
        "agent_id": session.agent_id,
        "source": session.source,
        "source_id": session.source_id,
        "status": session.status,
        "user_prompt": session.user_prompt,
        "output": session.output,
        "error": session.error,
        "model": session.model,
        "turn_count": session.turn_count,
        "created_at": session.created_at,
        "started_at": session.started_at,
        "completed_at": session.completed_at,
        "events": [
            {
                "id": e.id,
                "event_type": e.event_type,
                "timestamp": e.timestamp,
                "data": json.loads(e.data) if e.data else {},
            }
            for e in sorted_events
        ],
    }


@router.post("/sessions/{session_id}/stop")
async def stop_session(
    session_id: str, db_session: AsyncSession = Depends(get_async_session)
):
    """Stop a running session by terminating its container.

    This sends a shutdown signal through Redis which the engine/container picks up.
    The session ID in DjinnBot is actually the run ID.
    """
    logger.info(f"stop_session: session_id={session_id}")

    # Get session to verify it exists and is running
    result = await db_session.execute(select(Session).where(Session.id == session_id))
    session = result.scalar_one_or_none()

    if not session:
        raise HTTPException(status_code=404, detail=f"Session {session_id} not found")

    if session.status not in ("starting", "running"):
        raise HTTPException(
            status_code=400,
            detail=f"Session {session_id} is not running (status: {session.status})",
        )

    now = now_ms()

    # Update session status to stopped
    session.status = "failed"
    session.error = "Stopped by user"
    session.completed_at = now
    await db_session.commit()

    # Send shutdown signal via Redis
    # The session ID is the run ID, and containers listen on run:{runId}:cmd
    if dependencies.redis_client:
        try:
            # Send shutdown command to container via Redis pub/sub
            # Using the same channel format as packages/core/src/redis-protocol/channels.ts
            cmd_channel = f"run:{session_id}:cmd"
            shutdown_cmd = json.dumps(
                {"type": "shutdown", "timestamp": now, "reason": "User requested stop"}
            )
            await dependencies.redis_client.publish(cmd_channel, shutdown_cmd)
            logger.debug(f"stop_session: published shutdown to {cmd_channel}")

            # Also publish to the run's event stream for the pipeline engine
            run_stream = f"djinnbot:events:run:{session_id}"
            stop_event = {
                "type": "HUMAN_INTERVENTION",
                "runId": session_id,
                "stepId": "",
                "action": "stop",
                "context": "Stopped via session stop button",
                "timestamp": now,
            }
            await dependencies.redis_client.xadd(
                run_stream, {"data": json.dumps(stop_event)}
            )
            logger.debug(f"stop_session: published stop event to {run_stream}")

            # Publish status change for live updates
            live_channel = "djinnbot:sessions:live"
            await dependencies.redis_client.publish(
                live_channel,
                json.dumps(
                    {
                        "type": "status_changed",
                        "sessionId": session_id,
                        "agentId": session.agent_id,
                        "status": "failed",
                        "timestamp": now,
                    }
                ),
            )

        except Exception as e:
            logger.warning(f"Failed to publish stop signals to Redis: {e}")

    logger.info(f"stop_session: session {session_id} stopped successfully")

    return {
        "session_id": session_id,
        "status": "stopped",
        "message": "Session stop signal sent",
    }


@router.get("/sessions/{session_id}/stream")
async def stream_session_events(session_id: str):
    """SSE stream for session events in real-time."""
    logger.debug(f"stream_session_events: session_id={session_id}")

    if not dependencies.redis_client:
        raise HTTPException(status_code=503, detail="Redis not connected")

    async def event_generator():
        """Generate SSE events from Redis pubsub.

        Uses get_message(timeout=None) so the coroutine truly blocks on the
        Redis socket between messages. This gives the asyncio event loop time
        to flush TCP write buffers between each token, preventing burst delivery.
        Heartbeats are implemented via asyncio.wait_for timeout.
        """
        channel_name = f"djinnbot:sessions:{session_id}"
        pubsub = dependencies.redis_client.pubsub()

        HEARTBEAT_INTERVAL = 20.0

        try:
            await pubsub.subscribe(channel_name)
            logger.debug(f"Subscribed to Redis channel: {channel_name}")

            while True:
                try:
                    message = await asyncio.wait_for(
                        pubsub.get_message(
                            ignore_subscribe_messages=True, timeout=None
                        ),
                        timeout=HEARTBEAT_INTERVAL,
                    )

                    if message and message["type"] == "message":
                        try:
                            event_data = json.loads(message["data"])
                            yield f"data: {json.dumps(event_data)}\n\n"
                            await asyncio.sleep(0)
                        except json.JSONDecodeError:
                            logger.warning(
                                f"Invalid JSON from Redis: {message['data']}"
                            )

                except asyncio.TimeoutError:
                    yield ": heartbeat\n\n"
                except asyncio.CancelledError:
                    raise
                except Exception as e:
                    logger.error(f"Error in event generator: {e}")
                    break

        except asyncio.CancelledError:
            raise
        finally:
            await pubsub.unsubscribe(channel_name)
            await pubsub.close()
            logger.debug(f"Unsubscribed from Redis channel: {channel_name}")

    return StreamingResponse(
        event_generator(),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache",
            "Connection": "keep-alive",
            "X-Accel-Buffering": "no",
        },
    )
