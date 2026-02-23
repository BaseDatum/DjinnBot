"""Ingest endpoints for Dialog (desktop client).

Receives meeting transcripts, notes, and dictation from the macOS Dialog app
and routes them to Grace (executive assistant agent) for memory extraction.

Grace processes each payload using her remember/recall tools to extract
people, decisions, commitments, action items, and facts into the shared
knowledge graph.

Also provides a simplified /chat proxy that the Dialog client uses for
Grace-powered chat, post-meeting actions, and title generation.
"""

import json
import asyncio
import uuid
from typing import Optional
from datetime import datetime, timezone
from fastapi import APIRouter, HTTPException, Depends
from fastapi.responses import JSONResponse, StreamingResponse
from pydantic import BaseModel
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.database import get_async_session
from app.models.chat import ChatSession, ChatMessage
from app import dependencies
from app.logging_config import get_logger
from app.utils import now_ms

logger = get_logger(__name__)
router = APIRouter()

GRACE_AGENT_ID = "grace"
GRACE_INGEST_MODEL = "anthropic/claude-sonnet-4"
# Maximum time (seconds) to wait for Grace to finish processing before
# returning a 202 Accepted with partial status.
GRACE_RESPONSE_TIMEOUT_SECONDS = 120

# Lock to prevent concurrent session creation races
_session_creation_lock = asyncio.Lock()


# ============================================================================
# Request Models
# ============================================================================


class IngestParticipant(BaseModel):
    name: str
    email: Optional[str] = None
    company: Optional[str] = None
    isMe: Optional[bool] = False


class IngestMeetingRequest(BaseModel):
    """Meeting payload from Dialog after a recording session ends."""

    title: Optional[str] = None
    transcript: str
    themTranscript: Optional[str] = None
    meTranscript: Optional[str] = None
    notes: Optional[str] = None
    participants: Optional[list[IngestParticipant]] = None
    startedAt: Optional[str] = None  # ISO 8601
    endedAt: Optional[str] = None  # ISO 8601
    durationSeconds: Optional[float] = None
    tags: Optional[list[str]] = None
    sourceApp: Optional[str] = "Dialog"


class IngestNoteRequest(BaseModel):
    """Standalone note payload from Dialog."""

    title: Optional[str] = None
    notes: str
    transcript: Optional[str] = None
    tags: Optional[list[str]] = None
    sourceApp: Optional[str] = "Dialog"


class IngestDictationRequest(BaseModel):
    """Dictation payload from Dialog after a substantial dictation session."""

    text: str
    mode: Optional[str] = "standard"
    sourceApp: Optional[str] = None
    timestamp: Optional[str] = None  # ISO 8601


class ChatProxyRequest(BaseModel):
    """Simplified chat request from Dialog to Grace."""

    message: str
    stream: bool = False


class BriefingRequest(BaseModel):
    """Pre-meeting briefing request from Dialog."""

    participants: list[str]
    meetingTitle: Optional[str] = None


class BriefingResponse(BaseModel):
    """Pre-meeting briefing response."""

    briefing: str
    status: str = "ok"


# ============================================================================
# Helpers
# ============================================================================


async def _get_or_create_grace_session(
    db: AsyncSession,
) -> str:
    """Find an active Grace ingest session or create a new one.

    Reuses a running session if one exists to avoid container churn.
    Uses an asyncio lock to prevent concurrent creation races.
    """
    async with _session_creation_lock:
        # Look for an existing running ingest session
        # Expire cached objects so we see the latest DB state
        db.expire_all()
        result = await db.execute(
            select(ChatSession)
            .where(ChatSession.agent_id == GRACE_AGENT_ID)
            .where(ChatSession.status.in_(["running", "ready", "starting"]))
            .order_by(ChatSession.last_activity_at.desc())
            .limit(1)
        )
        existing = result.scalar_one_or_none()

        if existing:
            logger.info(f"Reusing existing Grace session: {existing.id}")
            return existing.id

        # Create a new session
        now = now_ms()
        session_id = f"chat_{GRACE_AGENT_ID}_{now}"

        chat_session = ChatSession(
            id=session_id,
            agent_id=GRACE_AGENT_ID,
            status="starting",
            model=GRACE_INGEST_MODEL,
            created_at=now,
            last_activity_at=now,
        )
        db.add(chat_session)
        await db.commit()

        # Signal Engine to start Grace's container
        if not dependencies.redis_client:
            raise HTTPException(status_code=503, detail="Redis not available")

        await dependencies.redis_client.xadd(
            "djinnbot:events:chat_sessions",
            {
                "event": "chat:start",
                "session_id": session_id,
                "agent_id": GRACE_AGENT_ID,
                "model": GRACE_INGEST_MODEL,
            },
        )
        logger.info(f"Created new Grace session: {session_id}")

    # Wait for the session to become ready (up to 30s) — outside the lock
    for _ in range(60):
        await asyncio.sleep(0.5)
        await db.refresh(chat_session)
        if chat_session.status in ("running", "ready"):
            return session_id
        if chat_session.status == "failed":
            raise HTTPException(
                status_code=503,
                detail=f"Grace session failed to start: {chat_session.error}",
            )

    raise HTTPException(
        status_code=504,
        detail="Grace session did not become ready in time",
    )


async def _send_to_grace(
    session_id: str,
    message: str,
    db: AsyncSession,
) -> dict:
    """Send a message to Grace and wait for her response."""
    if not dependencies.redis_client:
        raise HTTPException(status_code=503, detail="Redis not available")

    now = now_ms()
    unique_suffix = uuid.uuid4().hex[:8]
    user_msg_id = f"msg_ingest_{now}_{unique_suffix}"
    assistant_msg_id = f"msg_ingest_resp_{now}_{unique_suffix}"

    # Persist user message
    db.add(
        ChatMessage(
            id=user_msg_id,
            session_id=session_id,
            role="user",
            content=message,
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
            model=GRACE_INGEST_MODEL,
            created_at=now,
        )
    )
    await db.commit()

    # Publish to Grace's command channel
    command_channel = f"djinnbot:chat:sessions:{session_id}:commands"
    await dependencies.redis_client.publish(
        command_channel,
        json.dumps(
            {
                "type": "message",
                "content": message,
                "model": GRACE_INGEST_MODEL,
                "message_id": assistant_msg_id,
                "timestamp": now,
            }
        ),
    )

    # Wait for Grace's response by polling the assistant message.
    # Expire cached ORM objects each iteration so we see external DB writes
    # made by Grace's container (running in a different process/session).
    for _ in range(GRACE_RESPONSE_TIMEOUT_SECONDS * 2):
        await asyncio.sleep(0.5)
        db.expire_all()
        result = await db.execute(
            select(ChatMessage).where(ChatMessage.id == assistant_msg_id)
        )
        msg = result.scalar_one_or_none()
        if msg and msg.completed_at and msg.content:
            return {
                "status": "processed",
                "reply": msg.content,
                "sessionId": session_id,
                "messageId": assistant_msg_id,
            }

    # Timed out waiting — return partial status
    return {
        "status": "processing",
        "reply": None,
        "sessionId": session_id,
        "messageId": assistant_msg_id,
    }


async def _send_to_grace_streaming(
    session_id: str,
    message: str,
    db: AsyncSession,
):
    """Send a message to Grace and yield SSE token events as they arrive.

    Polls the assistant message content and yields incremental deltas.
    """
    if not dependencies.redis_client:
        raise HTTPException(status_code=503, detail="Redis not available")

    now = now_ms()
    unique_suffix = uuid.uuid4().hex[:8]
    user_msg_id = f"msg_chat_{now}_{unique_suffix}"
    assistant_msg_id = f"msg_chat_resp_{now}_{unique_suffix}"

    # Persist user message
    db.add(
        ChatMessage(
            id=user_msg_id,
            session_id=session_id,
            role="user",
            content=message,
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
            model=GRACE_INGEST_MODEL,
            created_at=now,
        )
    )
    await db.commit()

    # Publish to Grace's command channel
    command_channel = f"djinnbot:chat:sessions:{session_id}:commands"
    await dependencies.redis_client.publish(
        command_channel,
        json.dumps(
            {
                "type": "message",
                "content": message,
                "model": GRACE_INGEST_MODEL,
                "message_id": assistant_msg_id,
                "timestamp": now,
            }
        ),
    )

    # Yield SSE events by polling for content changes
    previous_content = ""
    for _ in range(GRACE_RESPONSE_TIMEOUT_SECONDS * 2):
        await asyncio.sleep(0.3)
        db.expire_all()
        result = await db.execute(
            select(ChatMessage).where(ChatMessage.id == assistant_msg_id)
        )
        msg = result.scalar_one_or_none()
        if not msg:
            continue

        current_content = msg.content or ""
        if len(current_content) > len(previous_content):
            delta = current_content[len(previous_content) :]
            previous_content = current_content
            yield f"data: {json.dumps({'token': delta})}\n\n"

        if msg.completed_at:
            # Yield any final content
            if len(current_content) > len(previous_content):
                delta = current_content[len(previous_content) :]
                yield f"data: {json.dumps({'token': delta})}\n\n"
            break

    yield "data: [DONE]\n\n"


# ============================================================================
# Prompt Formatters
# ============================================================================


def _format_meeting_prompt(req: IngestMeetingRequest) -> str:
    """Build the structured prompt Grace receives for a meeting."""
    parts = [
        "Process this meeting transcript. Extract ALL people, decisions, "
        "commitments, action items, relationships, and facts. Store each as a "
        "structured shared memory with proper wiki-links.\n",
    ]

    if req.title:
        parts.append(f"**Meeting Title:** {req.title}")

    if req.startedAt:
        parts.append(f"**Started:** {req.startedAt}")
    if req.endedAt:
        parts.append(f"**Ended:** {req.endedAt}")
    if req.durationSeconds is not None:
        minutes = int(req.durationSeconds // 60)
        parts.append(f"**Duration:** {minutes} minutes")

    if req.participants:
        participant_lines = []
        for p in req.participants:
            line = p.name
            if p.company:
                line += f" ({p.company})"
            if p.email:
                line += f" <{p.email}>"
            if p.isMe:
                line += " [User]"
            participant_lines.append(f"  - {line}")
        parts.append("**Participants:**\n" + "\n".join(participant_lines))

    if req.tags:
        parts.append(f"**Tags:** {', '.join(req.tags)}")

    # Transcript body
    if req.themTranscript and req.meTranscript:
        parts.append("\n--- THEM TRANSCRIPT ---")
        parts.append(req.themTranscript)
        parts.append("\n--- ME TRANSCRIPT ---")
        parts.append(req.meTranscript)
    else:
        parts.append("\n--- TRANSCRIPT ---")
        parts.append(req.transcript)

    if req.notes:
        parts.append("\n--- MEETING NOTES ---")
        parts.append(req.notes)

    return "\n\n".join(parts)


def _format_note_prompt(req: IngestNoteRequest) -> str:
    """Build the structured prompt Grace receives for a standalone note."""
    parts = [
        "Process this standalone note. Extract any decisions, commitments, "
        "action items, people mentioned, or important facts. Store each as a "
        "structured shared memory with proper wiki-links. If the note is "
        "purely personal or trivial, store a brief fact memory with the key "
        "points.\n",
    ]

    if req.title:
        parts.append(f"**Note Title:** {req.title}")

    if req.tags:
        parts.append(f"**Tags:** {', '.join(req.tags)}")

    parts.append("\n--- NOTES ---")
    parts.append(req.notes)

    if req.transcript:
        parts.append("\n--- ASSOCIATED TRANSCRIPT ---")
        parts.append(req.transcript)

    return "\n\n".join(parts)


def _format_dictation_prompt(req: IngestDictationRequest) -> str:
    """Build the structured prompt Grace receives for a dictation."""
    parts = [
        "Process this dictation. The user spoke this text via voice-to-text "
        "while working. Extract any decisions, commitments, action items, "
        "people mentioned, or important context. If the content is trivial "
        "or routine, acknowledge it briefly without creating memories.\n",
    ]

    if req.mode and req.mode != "standard":
        parts.append(f"**Dictation Mode:** {req.mode}")

    if req.sourceApp:
        parts.append(f"**Source App:** {req.sourceApp}")

    if req.timestamp:
        parts.append(f"**Timestamp:** {req.timestamp}")

    parts.append("\n--- DICTATION TEXT ---")
    parts.append(req.text)

    return "\n\n".join(parts)


def _format_briefing_prompt(req: BriefingRequest) -> str:
    """Build the structured prompt Grace receives for a pre-meeting briefing."""
    parts = [
        "The user is about to start a meeting. Prepare a concise pre-meeting "
        "briefing by searching your memory vault. Include:\n"
        "- Prior meetings with these participants\n"
        "- Open commitments involving these participants\n"
        "- Relevant project status\n"
        "- Relationship context (titles, companies, how they connect)\n"
        "- Any follow-ups that were promised\n\n"
        "Be concise. Use bullet points. Only include information you actually "
        "have in your memory vault — do not invent context.\n",
    ]

    parts.append(f"**Participants:** {', '.join(req.participants)}")

    if req.meetingTitle:
        parts.append(f"**Meeting Title:** {req.meetingTitle}")

    return "\n\n".join(parts)


# ============================================================================
# Endpoints
# ============================================================================


@router.post("/meeting")
async def ingest_meeting(
    request: IngestMeetingRequest,
    db: AsyncSession = Depends(get_async_session),
):
    """Ingest a meeting transcript from Dialog.

    Starts (or reuses) a Grace chat session and sends the meeting data
    for memory extraction. Returns Grace's processing summary.
    """
    logger.info(
        f"ingest_meeting: title={request.title!r} "
        f"transcript_len={len(request.transcript)} "
        f"participants={len(request.participants or [])}"
    )

    if not request.transcript.strip():
        raise HTTPException(status_code=400, detail="Transcript is required")

    session_id = await _get_or_create_grace_session(db)
    prompt = _format_meeting_prompt(request)
    result = await _send_to_grace(session_id, prompt, db)

    status_code = 200 if result["status"] == "processed" else 202
    return JSONResponse(content=result, status_code=status_code)


@router.post("/note")
async def ingest_note(
    request: IngestNoteRequest,
    db: AsyncSession = Depends(get_async_session),
):
    """Ingest a standalone note from Dialog.

    Routes to Grace for memory extraction of any actionable content.
    """
    logger.info(f"ingest_note: title={request.title!r} notes_len={len(request.notes)}")

    if not request.notes.strip():
        raise HTTPException(status_code=400, detail="Notes content is required")

    session_id = await _get_or_create_grace_session(db)
    prompt = _format_note_prompt(request)
    result = await _send_to_grace(session_id, prompt, db)

    status_code = 200 if result["status"] == "processed" else 202
    return JSONResponse(content=result, status_code=status_code)


@router.post("/dictation")
async def ingest_dictation(
    request: IngestDictationRequest,
    db: AsyncSession = Depends(get_async_session),
):
    """Ingest a substantial dictation from Dialog.

    Only called for dictations exceeding a character threshold (client-side).
    Routes to Grace for context extraction.
    """
    logger.info(
        f"ingest_dictation: text_len={len(request.text)} "
        f"mode={request.mode} sourceApp={request.sourceApp}"
    )

    if not request.text.strip():
        raise HTTPException(status_code=400, detail="Dictation text is required")

    session_id = await _get_or_create_grace_session(db)
    prompt = _format_dictation_prompt(request)
    result = await _send_to_grace(session_id, prompt, db)

    status_code = 200 if result["status"] == "processed" else 202
    return JSONResponse(content=result, status_code=status_code)


@router.post("/briefing")
async def generate_briefing(
    request: BriefingRequest,
    db: AsyncSession = Depends(get_async_session),
):
    """Generate a pre-meeting context briefing from Grace's knowledge graph.

    Accepts participant names and optionally a meeting title. Grace searches
    her vault for prior meetings, open commitments, and relationship context
    involving those participants.
    """
    if not request.participants:
        raise HTTPException(
            status_code=400, detail="At least one participant is required"
        )

    logger.info(
        f"briefing: participants={request.participants} title={request.meetingTitle!r}"
    )

    prompt = _format_briefing_prompt(request)
    session_id = await _get_or_create_grace_session(db)
    result = await _send_to_grace(session_id, prompt, db)

    briefing_text = result.get("reply") or ""
    return BriefingResponse(
        briefing=briefing_text,
        status=result["status"],
    )


@router.post("/chat")
async def chat_proxy(
    request: ChatProxyRequest,
    db: AsyncSession = Depends(get_async_session),
):
    """Simplified chat proxy for Dialog to send messages to Grace.

    When `stream=false`, returns the full response as JSON:
        {"reply": "...", "sessionId": "...", "messageId": "..."}

    When `stream=true`, returns an SSE stream of token deltas:
        data: {"token": "Hello"}
        data: {"token": " world"}
        data: [DONE]
    """
    if not request.message.strip():
        raise HTTPException(status_code=400, detail="Message is required")

    logger.info(
        f"chat_proxy: message_len={len(request.message)} stream={request.stream}"
    )

    session_id = await _get_or_create_grace_session(db)

    if request.stream:
        return StreamingResponse(
            _send_to_grace_streaming(session_id, request.message, db),
            media_type="text/event-stream",
            headers={
                "Cache-Control": "no-cache",
                "Connection": "keep-alive",
                "X-Accel-Buffering": "no",
            },
        )

    result = await _send_to_grace(session_id, request.message, db)
    return result
