"""Interactive chat endpoints for agent sessions.

Provides endpoints for real-time chat with agents via containerized sessions.
The actual agent execution happens in the Engine (TypeScript) via containers.
This API handles:
- Starting/stopping sessions (signals to Engine via Redis)
- Sending messages (pub/sub to container)
- Session state management (database)
"""

import json
import asyncio
from typing import Optional
from fastapi import APIRouter, HTTPException, BackgroundTasks, Depends
from pydantic import BaseModel
from sqlalchemy import select, update
from sqlalchemy.ext.asyncio import AsyncSession

from app.database import get_async_session
from app.database import AsyncSessionLocal
from app.models.chat import ChatSession, ChatMessage
from app.models.settings import GlobalSetting
from app import dependencies
from app.logging_config import get_logger
from app.utils import gen_id, now_ms
from app.constants import DEFAULT_CHAT_MODEL
from app.services.agent_config import get_agent_config

logger = get_logger(__name__)
router = APIRouter()


# ============================================================================
# Request/Response Models
# ============================================================================


class StartChatRequest(BaseModel):
    """Request to start a new chat session."""

    model: Optional[str] = None
    # Optional text appended to the agent's system prompt (after their persona).
    # Use this to inject project context, onboarding summaries, etc.
    system_prompt_supplement: Optional[str] = None
    # Extended thinking level for the model ('minimal'|'low'|'medium'|'high'|'xhigh').
    # When set, the agent runtime requests reasoning/thinking tokens from the model.
    thinking_level: Optional[str] = None


class SendMessageRequest(BaseModel):
    """Request to send a message in an existing chat session."""

    message: str
    model: Optional[str] = None  # Override model for this message
    attachment_ids: Optional[list[str]] = (
        None  # File attachment IDs from upload endpoint
    )


class ChatSessionResponse(BaseModel):
    """Response for chat session operations."""

    sessionId: str
    status: str
    message: Optional[str] = None


# ============================================================================
# Chat Session Endpoints
# ============================================================================


@router.post("/agents/{agent_id}/chat/start")
async def start_chat_session(
    agent_id: str,
    request: Optional[StartChatRequest] = None,
    db: AsyncSession = Depends(get_async_session),
):
    """
    Start a new interactive chat session with an agent.

    This is the primary endpoint for creating chat sessions. It:
    1. Creates a session record in the database (status: starting)
    2. Signals the Engine via Redis stream to start a container
    3. Returns immediately - container will be ready shortly

    The container status updates to 'running' once ready.
    Use GET /agents/{agent_id}/chat/{session_id}/status to poll.

    For listing/updating/deleting sessions, see chat_sessions.py endpoints.
    """
    logger.info(f"start_chat_session: agent_id={agent_id}")

    if not dependencies.redis_client:
        raise HTTPException(status_code=503, detail="Redis not available")

    # Generate session ID
    now = now_ms()
    session_id = f"chat_{agent_id}_{now}"

    # Resolve model: explicit request > agent config.yml > instance default > hardcoded fallback
    model = (request and request.model) or None
    if not model:
        try:
            agent_config = await get_agent_config(agent_id)
            model = agent_config.get("model") or None
        except Exception:
            pass
    if not model:
        try:
            result = await db.execute(
                select(GlobalSetting).where(GlobalSetting.key == "defaultWorkingModel")
            )
            row = result.scalar_one_or_none()
            if row and row.value and row.value.strip():
                model = row.value.strip()
        except Exception:
            pass
    if not model:
        model = DEFAULT_CHAT_MODEL

    # Create session in database
    chat_session = ChatSession(
        id=session_id,
        agent_id=agent_id,
        status="starting",
        model=model,
        created_at=now,
        last_activity_at=now,
    )
    db.add(chat_session)
    await db.commit()

    # Signal Engine to start the container via Redis stream
    try:
        payload: dict = {
            "event": "chat:start",
            "session_id": session_id,
            "agent_id": agent_id,
            "model": model,
        }
        if request and request.system_prompt_supplement:
            payload["system_prompt_supplement"] = request.system_prompt_supplement
        if request and request.thinking_level:
            payload["thinking_level"] = request.thinking_level

        await dependencies.redis_client.xadd(
            "djinnbot:events:chat_sessions",
            payload,
        )
        logger.info(f"start_chat_session: published start signal for {session_id}")
    except Exception as e:
        logger.error(f"Failed to publish chat:start signal: {e}")
        # Update session to failed
        chat_session.status = "failed"
        chat_session.error = f"Failed to start container: {str(e)}"
        await db.commit()
        raise HTTPException(
            status_code=500, detail=f"Failed to start session: {str(e)}"
        )

    return ChatSessionResponse(
        sessionId=session_id,
        status="starting",
        message="Chat session starting. Container will be ready shortly.",
    )


@router.post("/agents/{agent_id}/chat/{session_id}/message")
async def send_chat_message(
    agent_id: str,
    session_id: str,
    request: SendMessageRequest,
    background_tasks: BackgroundTasks,
    db: AsyncSession = Depends(get_async_session),
):
    """
    Send a message in an existing chat session.

    The message is stored in the database and sent to the container via Redis.
    The response is streamed via SSE on the session events channel.
    This endpoint returns immediately after queueing the message.
    """
    logger.info(
        f"send_chat_message: session={session_id}, message_len={len(request.message)}"
    )

    if not dependencies.redis_client:
        raise HTTPException(status_code=503, detail="Redis not available")

    # Get session from database
    result = await db.execute(select(ChatSession).where(ChatSession.id == session_id))
    session = result.scalar_one_or_none()

    if not session:
        raise HTTPException(status_code=404, detail=f"Session {session_id} not found")

    if session.agent_id != agent_id:
        raise HTTPException(
            status_code=400, detail="Session does not belong to this agent"
        )

    # Accept 'starting' status to handle race condition between session creation and container startup:
    # Messages are published to Redis pub/sub channel djinnbot:chat:sessions:{id}:commands.
    # The chat-session-manager subscribes to this channel early in startSession() (before reporting 'running').
    # However, there's still a small race window: if the message arrives before the Engine processes
    # the start event, it may be dropped (pub/sub doesn't queue). The frontend should ideally wait
    # for 'running' status, but accepting 'starting' provides better UX for fast connections.
    # TODO: Consider using Redis Streams for commands to ensure messages aren't lost.
    if session.status not in ("running", "ready", "starting"):
        raise HTTPException(
            status_code=400,
            detail=f"Session not ready for messages (status: {session.status})",
        )

    # Generate IDs upfront so we can pass them to Redis before the DB write.
    now = now_ms()
    model = request.model or session.model
    user_msg_id = gen_id("msg_")
    assistant_msg_id = gen_id("msg_")

    # ── Resolve attachment metadata if provided ───────────────────────────
    attachment_metas = []
    if request.attachment_ids:
        from app.models.chat import ChatAttachment, ALLOWED_IMAGE_TYPES

        att_result = await db.execute(
            select(ChatAttachment).where(
                ChatAttachment.id.in_(request.attachment_ids),
                ChatAttachment.session_id == session_id,
            )
        )
        found_atts = {a.id: a for a in att_result.scalars().all()}

        for att_id in request.attachment_ids:
            att = found_atts.get(att_id)
            if not att:
                raise HTTPException(
                    400, f"Attachment {att_id} not found in this session"
                )
            attachment_metas.append(
                {
                    "id": att.id,
                    "filename": att.filename,
                    "mimeType": att.mime_type,
                    "sizeBytes": att.size_bytes,
                    "isImage": att.mime_type in ALLOWED_IMAGE_TYPES,
                    "estimatedTokens": att.estimated_tokens,
                }
            )

    # 1. Publish to Redis FIRST — zero DB latency before the container starts
    #    generating tokens.
    command_channel = f"djinnbot:chat:sessions:{session_id}:commands"
    try:
        payload = {
            "type": "message",
            "content": request.message,
            "model": model,
            "message_id": assistant_msg_id,
            "timestamp": now,
        }
        if attachment_metas:
            payload["attachments"] = attachment_metas
        await dependencies.redis_client.publish(
            command_channel,
            json.dumps(payload),
        )
        logger.debug(f"send_chat_message: published to {command_channel}")
    except Exception as e:
        logger.error(f"Failed to send message to container: {e}")
        raise HTTPException(status_code=500, detail=f"Failed to send message: {str(e)}")

    # 2. Persist messages asynchronously — runs after the HTTP response is sent
    #    so the DB write never blocks the streaming response.
    background_tasks.add_task(
        _persist_chat_messages,
        session_id=session_id,
        user_msg_id=user_msg_id,
        assistant_msg_id=assistant_msg_id,
        content=request.message,
        model=model,
        now=now,
        attachment_ids=request.attachment_ids,
    )

    return {
        "status": "queued",
        "sessionId": session_id,
        "userMessageId": user_msg_id,
        "assistantMessageId": assistant_msg_id,
    }


async def _persist_chat_messages(
    session_id: str,
    user_msg_id: str,
    assistant_msg_id: str,
    content: str,
    model: str,
    now: int,
    attachment_ids: list[str] | None = None,
) -> None:
    """Persist user and assistant placeholder messages to the database.

    Runs as a FastAPI BackgroundTask — after the HTTP response is already sent —
    so it never adds latency to the streaming path.
    """

    async with AsyncSessionLocal() as db:
        try:
            db.add(
                ChatMessage(
                    id=user_msg_id,
                    session_id=session_id,
                    role="user",
                    content=content,
                    attachments=json.dumps(attachment_ids) if attachment_ids else None,
                    created_at=now,
                    completed_at=now,
                )
            )
            db.add(
                ChatMessage(
                    id=assistant_msg_id,
                    session_id=session_id,
                    role="assistant",
                    content="",
                    model=model,
                    created_at=now,
                )
            )
            # Update session last_activity_at (and model if changed) in one
            # statement — no need to SELECT first.
            await db.execute(
                update(ChatSession)
                .where(ChatSession.id == session_id)
                .values(last_activity_at=now, model=model)
            )
            await db.commit()
            logger.debug(f"_persist_chat_messages: committed for session {session_id}")
        except Exception as e:
            await db.rollback()
            logger.error(
                f"_persist_chat_messages: failed for session {session_id}: {e}"
            )


@router.post("/agents/{agent_id}/chat/{session_id}/stop")
async def stop_chat_response(
    agent_id: str,
    session_id: str,
    db: AsyncSession = Depends(get_async_session),
):
    """
    Stop the current response generation but keep the session alive.

    This sends an abort signal to the container. The session remains active
    and the user can continue sending messages.
    """
    logger.info(f"stop_chat_response: session={session_id}")

    if not dependencies.redis_client:
        raise HTTPException(status_code=503, detail="Redis not available")

    # Validate session
    result = await db.execute(select(ChatSession).where(ChatSession.id == session_id))
    session = result.scalar_one_or_none()

    if not session:
        raise HTTPException(status_code=404, detail=f"Session {session_id} not found")

    if session.agent_id != agent_id:
        raise HTTPException(
            status_code=400, detail="Session does not belong to this agent"
        )

    # Send abort command to the Engine via pub/sub command channel
    command_channel = f"djinnbot:chat:sessions:{session_id}:commands"
    await dependencies.redis_client.publish(
        command_channel,
        json.dumps(
            {
                "type": "abort",
                "timestamp": now_ms(),
            }
        ),
    )

    # Publish response_aborted to the session pub/sub channel so SSE clients
    # receive it immediately.  Matches the frontend handler case 'response_aborted'.
    session_channel = f"djinnbot:sessions:{session_id}"
    await dependencies.redis_client.publish(
        session_channel,
        json.dumps(
            {
                "type": "response_aborted",
                "timestamp": now_ms(),
                "data": {"reason": "user_requested"},
            }
        ),
    )

    return {
        "status": "stopped",
        "sessionId": session_id,
        "message": "Response generation stopped. Session is still active.",
    }


@router.post("/agents/{agent_id}/chat/{session_id}/restart")
async def restart_chat_session(
    agent_id: str,
    session_id: str,
    db: AsyncSession = Depends(get_async_session),
):
    """
    Restart a chat session whose container was reaped or that ended.

    This spins up a new container for an existing session, preserving all
    message history. The new container will load the conversation history
    from the database and resume where it left off.

    Only sessions in terminal states (completed, failed, idle) can be restarted.
    """
    logger.info(f"restart_chat_session: session={session_id}")

    if not dependencies.redis_client:
        raise HTTPException(status_code=503, detail="Redis not available")

    # Get session from database
    result = await db.execute(select(ChatSession).where(ChatSession.id == session_id))
    session = result.scalar_one_or_none()

    if not session:
        raise HTTPException(status_code=404, detail=f"Session {session_id} not found")

    if session.agent_id != agent_id:
        raise HTTPException(
            status_code=400, detail="Session does not belong to this agent"
        )

    # Only allow restart from terminal states
    if session.status in ("running", "starting", "ready"):
        return ChatSessionResponse(
            sessionId=session_id,
            status=session.status,
            message="Session is already active.",
        )

    # Reset session state
    now = now_ms()
    session.status = "starting"
    session.completed_at = None
    session.error = None
    session.container_id = None
    session.last_activity_at = now
    await db.commit()

    # Signal Engine to start a new container via Redis stream
    try:
        await dependencies.redis_client.xadd(
            "djinnbot:events:chat_sessions",
            {
                "event": "chat:start",
                "session_id": session_id,
                "agent_id": agent_id,
                "model": session.model,
            },
        )
        logger.info(f"restart_chat_session: published start signal for {session_id}")
    except Exception as e:
        logger.error(f"Failed to publish chat:start signal for restart: {e}")
        session.status = "failed"
        session.error = f"Failed to restart container: {str(e)}"
        await db.commit()
        raise HTTPException(
            status_code=500, detail=f"Failed to restart session: {str(e)}"
        )

    return ChatSessionResponse(
        sessionId=session_id,
        status="starting",
        message="Chat session restarting. Container will be ready shortly.",
    )


@router.post("/agents/{agent_id}/chat/{session_id}/end")
async def end_chat_session(
    agent_id: str,
    session_id: str,
    db: AsyncSession = Depends(get_async_session),
):
    """
    End the chat session entirely.

    This stops the container and marks the session as completed.
    """
    logger.info(f"end_chat_session: session={session_id}")

    if not dependencies.redis_client:
        raise HTTPException(status_code=503, detail="Redis not available")

    # Get session
    result = await db.execute(select(ChatSession).where(ChatSession.id == session_id))
    session = result.scalar_one_or_none()

    if not session:
        return {
            "status": "ended",
            "sessionId": session_id,
            "message": "Session already ended or not found.",
        }

    if session.agent_id != agent_id:
        raise HTTPException(
            status_code=400, detail="Session does not belong to this agent"
        )

    now = now_ms()

    # Update session status
    session.status = "completed"
    session.completed_at = now
    session.last_activity_at = now
    await db.commit()

    # Signal Engine to stop the container
    await dependencies.redis_client.xadd(
        "djinnbot:events:chat_sessions",
        {
            "event": "chat:stop",
            "session_id": session_id,
            "agent_id": agent_id,
        },
    )

    # Publish session_complete to the session pub/sub channel so SSE clients
    # receive it immediately.
    session_channel = f"djinnbot:sessions:{session_id}"
    await dependencies.redis_client.publish(
        session_channel,
        json.dumps(
            {
                "type": "session_complete",
                "timestamp": now,
                "data": {"reason": "user_ended"},
            }
        ),
    )

    return {
        "status": "ended",
        "sessionId": session_id,
        "message": "Chat session terminated.",
    }


@router.get("/agents/{agent_id}/chat/{session_id}/status")
async def get_chat_session_status(
    agent_id: str,
    session_id: str,
    db: AsyncSession = Depends(get_async_session),
):
    """Get the current status of a chat session."""
    result = await db.execute(select(ChatSession).where(ChatSession.id == session_id))
    session = result.scalar_one_or_none()

    if not session:
        return {
            "sessionId": session_id,
            "status": "not_found",
            "exists": False,
        }

    if session.agent_id != agent_id:
        raise HTTPException(
            status_code=400, detail="Session does not belong to this agent"
        )

    # Count messages
    from sqlalchemy import func

    count_result = await db.execute(
        select(func.count(ChatMessage.id)).where(ChatMessage.session_id == session_id)
    )
    message_count = count_result.scalar() or 0

    return {
        "sessionId": session_id,
        "status": session.status,
        "exists": True,
        "messageCount": message_count,
        "model": session.model,
        "containerId": session.container_id,
        "createdAt": session.created_at,
        "lastActivityAt": session.last_activity_at,
    }


@router.patch("/agents/{agent_id}/chat/{session_id}/model")
async def update_chat_model(
    agent_id: str,
    session_id: str,
    model: str,
    db: AsyncSession = Depends(get_async_session),
):
    """
    Update the model for a chat session.

    The new model will be used for subsequent messages.
    """
    logger.info(f"update_chat_model: session={session_id}, model={model}")

    result = await db.execute(select(ChatSession).where(ChatSession.id == session_id))
    session = result.scalar_one_or_none()

    if not session:
        raise HTTPException(status_code=404, detail=f"Session {session_id} not found")

    if session.agent_id != agent_id:
        raise HTTPException(
            status_code=400, detail="Session does not belong to this agent"
        )

    session.model = model
    session.last_activity_at = now_ms()
    await db.commit()

    # Signal Engine to update model (for any in-flight state)
    if dependencies.redis_client:
        command_channel = f"djinnbot:chat:sessions:{session_id}:commands"
        await dependencies.redis_client.publish(
            command_channel,
            json.dumps(
                {
                    "type": "update_model",
                    "model": model,
                    "timestamp": now_ms(),
                }
            ),
        )

    return {
        "status": "updated",
        "sessionId": session_id,
        "model": model,
    }
