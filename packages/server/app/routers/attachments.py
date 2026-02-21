"""Chat attachment upload/download endpoints.

Provides file upload for chat sessions and retrieval for both the dashboard
UI (thumbnails, download) and the agent-runtime containers (fetching file
content for LLM context injection).
"""

import json
from typing import Optional, List
from fastapi import APIRouter, HTTPException, Depends, UploadFile, File, BackgroundTasks
from fastapi.responses import Response
from pydantic import BaseModel
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.database import get_async_session, AsyncSessionLocal
from app.models.chat import (
    ChatSession,
    ChatAttachment,
    ALLOWED_MIME_TYPES,
    ALLOWED_IMAGE_TYPES,
    MAX_ATTACHMENT_SIZE,
)
from app.services import file_storage
from app.services.text_extraction import extract_text
from app.logging_config import get_logger
from app.utils import gen_id, now_ms

logger = get_logger(__name__)
router = APIRouter()


# ── Response Models ────────────────────────────────────────────────────────────


class AttachmentResponse(BaseModel):
    id: str
    filename: str
    mimeType: str
    sizeBytes: int
    processingStatus: str
    estimatedTokens: Optional[int] = None
    isImage: bool
    createdAt: int


class AttachmentListResponse(BaseModel):
    attachments: List[AttachmentResponse]


def _to_response(att: ChatAttachment) -> AttachmentResponse:
    return AttachmentResponse(
        id=att.id,
        filename=att.filename,
        mimeType=att.mime_type,
        sizeBytes=att.size_bytes,
        processingStatus=att.processing_status,
        estimatedTokens=att.estimated_tokens,
        isImage=att.mime_type in ALLOWED_IMAGE_TYPES,
        createdAt=att.created_at,
    )


# ── Upload ─────────────────────────────────────────────────────────────────────


@router.post(
    "/agents/{agent_id}/chat/{session_id}/upload", response_model=AttachmentResponse
)
async def upload_attachment(
    agent_id: str,
    session_id: str,
    file: UploadFile = File(...),
    background_tasks: BackgroundTasks = BackgroundTasks(),
    db: AsyncSession = Depends(get_async_session),
):
    """Upload a file attachment to a chat session.

    The file is stored on disk and (for non-image types) text is extracted
    asynchronously for context injection.
    """
    # ── Validate session ────────────────────────────────────────────────────
    result = await db.execute(select(ChatSession).where(ChatSession.id == session_id))
    session = result.scalar_one_or_none()
    if not session:
        raise HTTPException(404, f"Session {session_id} not found")
    if session.agent_id != agent_id:
        raise HTTPException(400, "Session does not belong to this agent")

    # ── Validate file ───────────────────────────────────────────────────────
    if not file.filename:
        raise HTTPException(400, "Missing filename")

    # Detect MIME: trust the client header, then fall back to extension
    mime = file.content_type or "application/octet-stream"
    if mime == "application/octet-stream":
        mime = _guess_mime(file.filename)

    if mime not in ALLOWED_MIME_TYPES:
        raise HTTPException(
            400,
            f"Unsupported file type: {mime}. Allowed: images, PDFs, text, code files.",
        )

    data = await file.read()
    if len(data) > MAX_ATTACHMENT_SIZE:
        raise HTTPException(
            400,
            f"File too large ({len(data)} bytes). Maximum: {MAX_ATTACHMENT_SIZE // (1024 * 1024)} MB.",
        )

    # ── Store ───────────────────────────────────────────────────────────────
    att_id = gen_id("att_")
    storage_path = file_storage.store_file(session_id, att_id, file.filename, data)

    # Synchronous text extraction for small files, async for large ones
    is_image = mime in ALLOWED_IMAGE_TYPES
    extracted_text: Optional[str] = None
    estimated_tokens: int = 0

    if not is_image:
        extracted_text, estimated_tokens = extract_text(data, mime, file.filename)
    else:
        estimated_tokens = 1600  # flat image token estimate

    now = now_ms()
    attachment = ChatAttachment(
        id=att_id,
        session_id=session_id,
        filename=file.filename,
        mime_type=mime,
        size_bytes=len(data),
        storage_path=storage_path,
        processing_status="ready",
        extracted_text=extracted_text,
        estimated_tokens=estimated_tokens,
        created_at=now,
    )
    db.add(attachment)
    await db.commit()
    await db.refresh(attachment)

    logger.info(
        f"upload_attachment: {att_id} ({file.filename}, {mime}, {len(data)} bytes, ~{estimated_tokens} tokens)"
    )
    return _to_response(attachment)


# ── Retrieval ──────────────────────────────────────────────────────────────────


@router.get("/chat/attachments/{attachment_id}", response_model=AttachmentResponse)
async def get_attachment_metadata(
    attachment_id: str,
    db: AsyncSession = Depends(get_async_session),
):
    """Get metadata for an attachment."""
    result = await db.execute(
        select(ChatAttachment).where(ChatAttachment.id == attachment_id)
    )
    att = result.scalar_one_or_none()
    if not att:
        raise HTTPException(404, f"Attachment {attachment_id} not found")
    return _to_response(att)


@router.get("/chat/attachments/{attachment_id}/content")
async def get_attachment_content(
    attachment_id: str,
    db: AsyncSession = Depends(get_async_session),
):
    """Download the raw file content of an attachment.

    Used by:
    - Dashboard UI for image thumbnails and file downloads
    - Agent-runtime containers to fetch file bytes for LLM context
    """
    result = await db.execute(
        select(ChatAttachment).where(ChatAttachment.id == attachment_id)
    )
    att = result.scalar_one_or_none()
    if not att:
        raise HTTPException(404, f"Attachment {attachment_id} not found")

    data = file_storage.read_file(att.storage_path)
    if data is None:
        raise HTTPException(404, "Attachment file not found on disk")

    return Response(
        content=data,
        media_type=att.mime_type,
        headers={
            "Content-Disposition": f'inline; filename="{att.filename}"',
            "Cache-Control": "private, max-age=3600",
        },
    )


@router.get("/chat/attachments/{attachment_id}/text")
async def get_attachment_text(
    attachment_id: str,
    db: AsyncSession = Depends(get_async_session),
):
    """Get the extracted text for an attachment (for non-image files).

    Used by agent-runtime containers as an alternative to downloading the
    full binary when only the text content is needed.
    """
    result = await db.execute(
        select(ChatAttachment).where(ChatAttachment.id == attachment_id)
    )
    att = result.scalar_one_or_none()
    if not att:
        raise HTTPException(404, f"Attachment {attachment_id} not found")

    return {
        "id": att.id,
        "filename": att.filename,
        "mimeType": att.mime_type,
        "extractedText": att.extracted_text,
        "estimatedTokens": att.estimated_tokens,
    }


@router.get(
    "/chat/sessions/{session_id}/attachments", response_model=AttachmentListResponse
)
async def list_session_attachments(
    session_id: str,
    db: AsyncSession = Depends(get_async_session),
):
    """List all attachments for a session."""
    result = await db.execute(
        select(ChatAttachment)
        .where(ChatAttachment.session_id == session_id)
        .order_by(ChatAttachment.created_at)
    )
    attachments = result.scalars().all()
    return AttachmentListResponse(attachments=[_to_response(a) for a in attachments])


# ── Internal endpoints (called by engine / slack bridge) ──────────────────────


@router.post("/internal/chat/attachments/upload-bytes")
async def upload_bytes_internal(
    session_id: str,
    filename: str,
    mime_type: str,
    file: UploadFile = File(...),
    db: AsyncSession = Depends(get_async_session),
):
    """Upload file bytes directly (used by Slack bridge to re-upload downloaded files).

    Unlike the public upload endpoint, this doesn't require agent_id validation
    and accepts session_id as a query parameter.
    """
    data = await file.read()
    if len(data) > MAX_ATTACHMENT_SIZE:
        raise HTTPException(400, "File too large")

    if mime_type not in ALLOWED_MIME_TYPES:
        mime_type = _guess_mime(filename)

    att_id = gen_id("att_")
    storage_path = file_storage.store_file(session_id, att_id, filename, data)

    is_image = mime_type in ALLOWED_IMAGE_TYPES
    extracted_text = None
    estimated_tokens = 1600 if is_image else 0
    if not is_image:
        extracted_text, estimated_tokens = extract_text(data, mime_type, filename)

    now = now_ms()
    attachment = ChatAttachment(
        id=att_id,
        session_id=session_id,
        filename=filename,
        mime_type=mime_type,
        size_bytes=len(data),
        storage_path=storage_path,
        processing_status="ready",
        extracted_text=extracted_text,
        estimated_tokens=estimated_tokens,
        created_at=now,
    )
    db.add(attachment)
    await db.commit()

    return {
        "id": att_id,
        "filename": filename,
        "mimeType": mime_type,
        "sizeBytes": len(data),
    }


# ── Helpers ────────────────────────────────────────────────────────────────────

_EXTENSION_MIME_MAP = {
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".png": "image/png",
    ".gif": "image/gif",
    ".webp": "image/webp",
    ".pdf": "application/pdf",
    ".txt": "text/plain",
    ".md": "text/markdown",
    ".csv": "text/csv",
    ".json": "application/json",
    ".py": "text/x-python",
    ".js": "text/javascript",
    ".ts": "text/typescript",
    ".html": "text/html",
    ".css": "text/css",
    ".xml": "text/xml",
    ".yaml": "application/x-yaml",
    ".yml": "application/x-yaml",
}


def _guess_mime(filename: str) -> str:
    """Guess MIME type from file extension."""
    import os

    ext = os.path.splitext(filename)[1].lower()
    return _EXTENSION_MIME_MAP.get(ext, "application/octet-stream")
