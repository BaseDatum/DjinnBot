"""Ingest endpoints for Dialog (desktop client).

Receives meeting transcripts, notes, and dictation from the macOS Dialog app
and routes them to Grace (executive assistant agent) for memory extraction.

Grace processes each payload using her remember/recall tools to extract
people, decisions, commitments, action items, and facts into the shared
knowledge graph.
"""

import json
import asyncio
from typing import Optional
from datetime import datetime, timezone
from fastapi import APIRouter, HTTPException, Depends
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


# ============================================================================
# Helpers
# ============================================================================


async def _get_or_create_grace_session(
    db: AsyncSession,
) -> str:
    """Find an active Grace ingest session or create a new one.

    Reuses a running session if one exists to avoid container churn.
    """
    # Look for an existing running ingest session
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

    # Wait for the session to become ready (up to 30s)
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
    user_msg_id = f"msg_ingest_{now}"
    assistant_msg_id = f"msg_ingest_resp_{now}"

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

    # Wait for Grace's response by polling the assistant message
    for _ in range(GRACE_RESPONSE_TIMEOUT_SECONDS * 2):
        await asyncio.sleep(0.5)
        result = await db.execute(
            select(ChatMessage).where(ChatMessage.id == assistant_msg_id)
        )
        msg = result.scalar_one_or_none()
        if msg and msg.completed_at and msg.content:
            return {
                "status": "processed",
                "summary": msg.content,
                "sessionId": session_id,
                "messageId": assistant_msg_id,
            }

    # Timed out waiting — return 202 so the client knows it was accepted
    return {
        "status": "processing",
        "summary": None,
        "sessionId": session_id,
        "messageId": assistant_msg_id,
    }


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
    return result


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
    return result


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
    return result
