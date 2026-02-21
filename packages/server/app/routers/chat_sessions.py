"""Chat session management API endpoints.

Provides CRUD operations for chat sessions and messages.

Note: Session CREATION is handled by chat.py (/agents/{agent_id}/chat/start)
which also signals the Engine to start the container.

This module handles: list, get, update, delete operations.
"""

import json
from typing import Optional, List
from fastapi import APIRouter, HTTPException, Depends, Query
from pydantic import BaseModel
from sqlalchemy import select, func, and_
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import selectinload

from app.database import get_async_session
from app.models.chat import ChatSession, ChatMessage
from app import dependencies
from app.logging_config import get_logger
from app.utils import gen_id, now_ms
from app.constants import DEFAULT_CHAT_MODEL

logger = get_logger(__name__)
router = APIRouter()


# ============================================================================
# Request/Response Models
# ============================================================================


class UpdateChatSessionRequest(BaseModel):
    model: Optional[str] = None
    status: Optional[str] = None


class ChatSessionResponse(BaseModel):
    id: str
    agent_id: str
    status: str
    model: str
    container_id: Optional[str]
    created_at: int
    started_at: Optional[int]
    last_activity_at: int
    completed_at: Optional[int]
    error: Optional[str]
    message_count: int = 0


class ChatMessageResponse(BaseModel):
    id: str
    session_id: str
    role: str
    content: str
    model: Optional[str]
    thinking: Optional[str]
    tool_calls: Optional[List[dict]]
    created_at: int
    completed_at: Optional[int]


class ChatSessionDetailResponse(ChatSessionResponse):
    messages: List[ChatMessageResponse]


class ChatSessionListResponse(BaseModel):
    sessions: List[ChatSessionResponse]
    total: int
    has_more: bool


# ============================================================================
# Endpoints
# ============================================================================


@router.get("/agents/{agent_id}/chat/sessions", response_model=ChatSessionListResponse)
async def list_chat_sessions(
    agent_id: str,
    status: Optional[str] = Query(None, description="Filter by status"),
    limit: int = Query(20, ge=1, le=100),
    offset: int = Query(0, ge=0),
    db: AsyncSession = Depends(get_async_session),
):
    """List chat sessions for an agent with optional filtering."""
    logger.debug(f"list_chat_sessions: agent_id={agent_id}, status={status}")

    # Build query
    query = select(ChatSession).where(ChatSession.agent_id == agent_id)

    if status:
        query = query.where(ChatSession.status == status)

    # Get total count
    count_query = select(func.count()).select_from(query.subquery())
    total_result = await db.execute(count_query)
    total = total_result.scalar() or 0

    # Apply pagination and ordering
    query = query.order_by(ChatSession.created_at.desc()).limit(limit).offset(offset)

    # Execute
    result = await db.execute(query)
    sessions = result.scalars().all()

    # Get message counts
    session_ids = [s.id for s in sessions]
    if session_ids:
        count_query = (
            select(ChatMessage.session_id, func.count(ChatMessage.id))
            .where(ChatMessage.session_id.in_(session_ids))
            .group_by(ChatMessage.session_id)
        )
        count_result = await db.execute(count_query)
        message_counts = dict(count_result.all())
    else:
        message_counts = {}

    return ChatSessionListResponse(
        sessions=[
            ChatSessionResponse(
                id=s.id,
                agent_id=s.agent_id,
                status=s.status,
                model=s.model,
                container_id=s.container_id,
                created_at=s.created_at,
                started_at=s.started_at,
                last_activity_at=s.last_activity_at,
                completed_at=s.completed_at,
                error=s.error,
                message_count=message_counts.get(s.id, 0),
            )
            for s in sessions
        ],
        total=total,
        has_more=(offset + len(sessions)) < total,
    )


@router.get("/chat/sessions/{session_id}", response_model=ChatSessionDetailResponse)
async def get_chat_session(
    session_id: str, db: AsyncSession = Depends(get_async_session)
):
    """Get chat session details with all messages."""
    logger.debug(f"get_chat_session: session_id={session_id}")

    result = await db.execute(
        select(ChatSession)
        .options(selectinload(ChatSession.messages))
        .where(ChatSession.id == session_id)
    )
    session = result.scalar_one_or_none()

    if not session:
        raise HTTPException(
            status_code=404, detail=f"Chat session {session_id} not found"
        )

    return ChatSessionDetailResponse(
        id=session.id,
        agent_id=session.agent_id,
        status=session.status,
        model=session.model,
        container_id=session.container_id,
        created_at=session.created_at,
        started_at=session.started_at,
        last_activity_at=session.last_activity_at,
        completed_at=session.completed_at,
        error=session.error,
        message_count=len(session.messages),
        messages=[
            ChatMessageResponse(
                id=m.id,
                session_id=m.session_id,
                role=m.role,
                content=m.content,
                model=m.model,
                thinking=m.thinking,
                tool_calls=json.loads(m.tool_calls) if m.tool_calls else None,
                created_at=m.created_at,
                completed_at=m.completed_at,
            )
            for m in sorted(session.messages, key=lambda m: m.created_at)
        ],
    )


@router.patch("/chat/sessions/{session_id}", response_model=ChatSessionResponse)
async def update_chat_session(
    session_id: str,
    request: UpdateChatSessionRequest,
    db: AsyncSession = Depends(get_async_session),
):
    """Update chat session (model, status).

    Model can be changed at any time - the new model will be used for
    subsequent messages. Status changes may trigger container actions.
    """
    logger.info(
        f"update_chat_session: session_id={session_id}, updates={request.dict(exclude_none=True)}"
    )

    result = await db.execute(select(ChatSession).where(ChatSession.id == session_id))
    session = result.scalar_one_or_none()

    if not session:
        raise HTTPException(
            status_code=404, detail=f"Chat session {session_id} not found"
        )

    # Apply updates
    if request.model is not None:
        session.model = request.model

    if request.status is not None:
        old_status = session.status
        session.status = request.status

        # Handle status transitions
        if request.status == "completed" and session.completed_at is None:
            session.completed_at = now_ms()

        # Publish status change
        if dependencies.redis_client and old_status != request.status:
            try:
                await dependencies.redis_client.publish(
                    "djinnbot:chat:sessions:live",
                    json.dumps(
                        {
                            "type": "status_changed",
                            "sessionId": session_id,
                            "agentId": session.agent_id,
                            "oldStatus": old_status,
                            "newStatus": request.status,
                            "timestamp": now_ms(),
                        }
                    ),
                )
            except Exception as e:
                logger.warning(f"Failed to publish status change: {e}")

    session.last_activity_at = now_ms()
    await db.commit()
    await db.refresh(session)

    # Get message count
    count_result = await db.execute(
        select(func.count(ChatMessage.id)).where(ChatMessage.session_id == session_id)
    )
    message_count = count_result.scalar() or 0

    return ChatSessionResponse(
        id=session.id,
        agent_id=session.agent_id,
        status=session.status,
        model=session.model,
        container_id=session.container_id,
        created_at=session.created_at,
        started_at=session.started_at,
        last_activity_at=session.last_activity_at,
        completed_at=session.completed_at,
        error=session.error,
        message_count=message_count,
    )


@router.delete("/chat/sessions/{session_id}")
async def delete_chat_session(
    session_id: str, db: AsyncSession = Depends(get_async_session)
):
    """Delete a chat session and all its messages.

    If the session has a running container, it will be stopped.
    """
    logger.info(f"delete_chat_session: session_id={session_id}")

    result = await db.execute(select(ChatSession).where(ChatSession.id == session_id))
    session = result.scalar_one_or_none()

    if not session:
        raise HTTPException(
            status_code=404, detail=f"Chat session {session_id} not found"
        )

    agent_id = session.agent_id

    # If running, signal container to stop
    if session.status in ("starting", "running") and dependencies.redis_client:
        try:
            await dependencies.redis_client.xadd(
                "djinnbot:events:chat_sessions",
                {
                    "event": "chat:stop",
                    "session_id": session_id,
                    "agent_id": agent_id,
                },
            )
        except Exception as e:
            logger.warning(f"Failed to signal container stop: {e}")

    # Delete session (cascades to messages and events)
    await db.delete(session)
    await db.commit()

    # Publish deletion event
    if dependencies.redis_client:
        try:
            await dependencies.redis_client.publish(
                "djinnbot:chat:sessions:live",
                json.dumps(
                    {
                        "type": "deleted",
                        "sessionId": session_id,
                        "agentId": agent_id,
                        "timestamp": now_ms(),
                    }
                ),
            )
        except Exception as e:
            logger.warning(f"Failed to publish deletion event: {e}")

    return {"status": "deleted", "session_id": session_id}


# ============================================================================
# Internal Endpoints (called by engine)
# ============================================================================


@router.get("/internal/chat/sessions", response_model=ChatSessionListResponse)
async def list_chat_sessions_internal(
    status: Optional[List[str]] = Query(
        None, description="Filter by status (repeatable)"
    ),
    limit: int = Query(100, ge=1, le=500),
    offset: int = Query(0, ge=0),
    db: AsyncSession = Depends(get_async_session),
):
    """List chat sessions across all agents (engine-internal use only)."""
    logger.debug(f"list_chat_sessions_internal: status={status}, limit={limit}")

    query = select(ChatSession)

    if status:
        query = query.where(ChatSession.status.in_(status))

    count_query = select(func.count()).select_from(query.subquery())
    total_result = await db.execute(count_query)
    total = total_result.scalar() or 0

    query = query.order_by(ChatSession.created_at.desc()).limit(limit).offset(offset)
    result = await db.execute(query)
    sessions = result.scalars().all()

    session_ids = [s.id for s in sessions]
    if session_ids:
        msg_count_query = (
            select(ChatMessage.session_id, func.count(ChatMessage.id))
            .where(ChatMessage.session_id.in_(session_ids))
            .group_by(ChatMessage.session_id)
        )
        count_result = await db.execute(msg_count_query)
        message_counts = dict(count_result.all())
    else:
        message_counts = {}

    return ChatSessionListResponse(
        sessions=[
            ChatSessionResponse(
                id=s.id,
                agent_id=s.agent_id,
                status=s.status,
                model=s.model,
                container_id=s.container_id,
                created_at=s.created_at,
                started_at=s.started_at,
                last_activity_at=s.last_activity_at,
                completed_at=s.completed_at,
                error=s.error,
                message_count=message_counts.get(s.id, 0),
            )
            for s in sessions
        ],
        total=total,
        has_more=(offset + len(sessions)) < total,
    )


class UpdateContainerRequest(BaseModel):
    container_id: str
    status: str


@router.patch("/internal/chat/sessions/{session_id}/container")
async def update_session_container(
    session_id: str,
    request: UpdateContainerRequest,
    db: AsyncSession = Depends(get_async_session),
):
    """Update container info for a chat session (called by engine)."""
    logger.debug(
        f"update_session_container: session_id={session_id}, container={request.container_id}"
    )

    result = await db.execute(select(ChatSession).where(ChatSession.id == session_id))
    session = result.scalar_one_or_none()

    if not session:
        raise HTTPException(
            status_code=404, detail=f"Chat session {session_id} not found"
        )

    session.container_id = request.container_id
    session.status = request.status
    session.last_activity_at = now_ms()

    if request.status == "running" and session.started_at is None:
        session.started_at = now_ms()

    await db.commit()
    return {"ok": True}


class EnsureSessionRequest(BaseModel):
    """Create a chat session if it doesn't already exist.

    Used by the engine for Slack-originated sessions which bypass the normal
    ``POST /agents/{agent_id}/chat/start`` flow (that endpoint creates the DB
    row).  Without a DB row the orphan-recovery logic cannot find the session
    after an engine restart, leaving Docker containers running indefinitely.
    """

    agent_id: str
    model: str
    status: str = "starting"


@router.put("/internal/chat/sessions/{session_id}/ensure")
async def ensure_chat_session(
    session_id: str,
    request: EnsureSessionRequest,
    db: AsyncSession = Depends(get_async_session),
):
    """Upsert a chat session row — create it if missing, update if exists.

    Called by the engine's ChatSessionManager.startSession() so that every
    session (including Slack-originated ones) has a DB presence that the
    orphan-recovery path can discover after a restart.
    """
    result = await db.execute(select(ChatSession).where(ChatSession.id == session_id))
    session = result.scalar_one_or_none()

    now = now_ms()
    if session:
        # Row exists — touch last_activity_at and update status
        session.status = request.status
        session.last_activity_at = now
    else:
        # Create a new row
        session = ChatSession(
            id=session_id,
            agent_id=request.agent_id,
            status=request.status,
            model=request.model,
            created_at=now,
            last_activity_at=now,
        )
        db.add(session)

    await db.commit()
    return {"ok": True, "created": session.created_at == now}


class AddMessageRequest(BaseModel):
    role: str
    content: str
    model: Optional[str] = None
    thinking: Optional[str] = None
    tool_calls: Optional[List[dict]] = None


class CompleteMessageRequest(BaseModel):
    content: str
    thinking: Optional[str] = None
    tool_calls: Optional[List[dict]] = None


@router.post("/internal/chat/sessions/{session_id}/messages")
async def add_chat_message(
    session_id: str,
    request: AddMessageRequest,
    db: AsyncSession = Depends(get_async_session),
):
    """Add a message to a chat session (called by engine)."""
    logger.debug(f"add_chat_message: session_id={session_id}, role={request.role}")

    now = now_ms()
    message = ChatMessage(
        id=gen_id("msg_"),
        session_id=session_id,
        role=request.role,
        content=request.content,
        model=request.model,
        thinking=request.thinking,
        tool_calls=json.dumps(request.tool_calls) if request.tool_calls else None,
        created_at=now,
        completed_at=now
        if request.role != "assistant"
        else None,  # User messages complete immediately
    )

    db.add(message)

    # Update session last activity
    result = await db.execute(select(ChatSession).where(ChatSession.id == session_id))
    session = result.scalar_one_or_none()
    if session:
        session.last_activity_at = now

    await db.commit()
    await db.refresh(message)

    return {"ok": True, "message_id": message.id}


@router.patch("/internal/chat/messages/{message_id}/complete")
async def complete_chat_message(
    message_id: str,
    request: CompleteMessageRequest,
    db: AsyncSession = Depends(get_async_session),
):
    """Mark an assistant message as complete with final content."""
    logger.debug(f"complete_chat_message: message_id={message_id}")

    result = await db.execute(select(ChatMessage).where(ChatMessage.id == message_id))
    message = result.scalar_one_or_none()

    if not message:
        raise HTTPException(status_code=404, detail=f"Message {message_id} not found")

    message.content = request.content
    message.thinking = request.thinking
    message.tool_calls = json.dumps(request.tool_calls) if request.tool_calls else None
    message.completed_at = now_ms()

    await db.commit()
    return {"ok": True}
