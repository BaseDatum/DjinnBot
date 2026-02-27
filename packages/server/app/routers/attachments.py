"""Chat attachment upload/download endpoints.

Provides file upload for chat sessions and retrieval for both the dashboard
UI (thumbnails, download) and the agent-runtime containers (fetching file
content for LLM context injection).

PDF uploads are processed with OpenDataLoader for structured extraction,
chunked by document structure, and ingested into the shared ClawVault
so all agents can recall document knowledge via semantic search.

Audio uploads (voice notes from Signal/Telegram/WhatsApp/Discord) are
transcribed via faster-whisper as a background task.  The transcript is
stored as extracted_text so agent containers read it via /text like any
other document.
"""

import json
from typing import Optional, List
from fastapi import APIRouter, HTTPException, Depends, UploadFile, File, BackgroundTasks
from fastapi.responses import Response
from pydantic import BaseModel
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.database import get_async_session, AsyncSessionLocal
from app import dependencies
from app.models.chat import (
    ChatSession,
    ChatAttachment,
    ALLOWED_MIME_TYPES,
    ALLOWED_IMAGE_TYPES,
    ALLOWED_AUDIO_TYPES,
    MAX_ATTACHMENT_SIZE,
)
from app.services import file_storage
from app.services.text_extraction import extract_text, extract_pdf_structured
from app.services.audio_transcription import transcribe_audio
from app.services.pdf_chunker import chunk_pdf, extract_toc
from app.services.pdf_vault_ingest import ingest_pdf_to_shared_vault_async
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
    # Vault ingest fields (PDF and large document processing)
    vaultIngestStatus: Optional[str] = None
    vaultDocSlug: Optional[str] = None
    vaultChunkCount: Optional[int] = None
    pdfPageCount: Optional[int] = None


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
        vaultIngestStatus=att.vault_ingest_status,
        vaultDocSlug=att.vault_doc_slug,
        vaultChunkCount=att.vault_chunk_count,
        pdfPageCount=att.pdf_page_count,
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

    # Detect MIME: trust the client header, then fall back to extension.
    # Strip codec params (e.g. 'audio/webm;codecs=opus' → 'audio/webm').
    mime = _normalize_mime(file.content_type or "application/octet-stream")
    if mime == "application/octet-stream":
        mime = _guess_mime(file.filename)

    if mime not in ALLOWED_MIME_TYPES:
        raise HTTPException(
            400,
            f"Unsupported file type: {mime}. Allowed: images, PDFs, text, code, audio files.",
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
    is_audio = mime in ALLOWED_AUDIO_TYPES
    extracted_text: Optional[str] = None
    estimated_tokens: int = 0
    structured_json: Optional[str] = None
    pdf_title: Optional[str] = None
    pdf_author: Optional[str] = None
    pdf_page_count: Optional[int] = None
    vault_ingest_status: Optional[str] = None
    processing_status = "ready"

    if is_audio:
        # Audio: transcription runs as a background task.  The agent-runtime
        # polls processing_status and waits for "ready" before fetching /text.
        processing_status = "transcribing"
        estimated_tokens = 0
    elif not is_image:
        extracted_text, estimated_tokens = extract_text(data, mime, file.filename)

        # For PDFs: also extract structured JSON for chunking + vault ingest
        if mime == "application/pdf":
            vault_ingest_status = "pending"
            try:
                pdf_result = extract_pdf_structured(data, file.filename)
                if pdf_result.get("json_data"):
                    structured_json = json.dumps(pdf_result["json_data"])
                pdf_title = pdf_result.get("title")
                pdf_author = pdf_result.get("author")
                pdf_page_count = pdf_result.get("page_count")
            except Exception as e:
                logger.warning(
                    f"Structured PDF extraction failed for {file.filename}: {e}"
                )
                # Text extraction already succeeded via extract_text — proceed without structure
                vault_ingest_status = "failed"
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
        processing_status=processing_status,
        extracted_text=extracted_text,
        estimated_tokens=estimated_tokens,
        structured_json=structured_json,
        pdf_title=pdf_title,
        pdf_author=pdf_author,
        pdf_page_count=pdf_page_count,
        vault_ingest_status=vault_ingest_status,
        created_at=now,
    )
    db.add(attachment)
    await db.commit()
    await db.refresh(attachment)

    logger.info(
        f"upload_attachment: {att_id} ({file.filename}, {mime}, {len(data)} bytes, ~{estimated_tokens} tokens)"
    )

    # Trigger async vault ingest for PDFs with structured data
    if mime == "application/pdf" and structured_json:
        background_tasks.add_task(
            _ingest_pdf_to_vault,
            att_id,
            structured_json,
            extracted_text or "",
            file.filename,
            pdf_page_count or 0,
            pdf_title,
            pdf_author,
        )

    # Trigger async transcription for audio files
    if is_audio:
        background_tasks.add_task(
            _transcribe_audio,
            att_id,
            data,
            mime,
            file.filename,
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
    is_audio = mime_type in ALLOWED_AUDIO_TYPES
    extracted_text = None
    estimated_tokens = 1600 if is_image else 0
    structured_json_str: Optional[str] = None
    pdf_title: Optional[str] = None
    pdf_author: Optional[str] = None
    pdf_page_count: Optional[int] = None
    vault_ingest_status: Optional[str] = None
    processing_status = "ready"

    if is_audio:
        processing_status = "transcribing"
        estimated_tokens = 0
    elif not is_image:
        extracted_text, estimated_tokens = extract_text(data, mime_type, filename)

        # For PDFs: extract structured JSON for vault ingest
        if mime_type == "application/pdf":
            vault_ingest_status = "pending"
            try:
                pdf_result = extract_pdf_structured(data, filename)
                if pdf_result.get("json_data"):
                    structured_json_str = json.dumps(pdf_result["json_data"])
                pdf_title = pdf_result.get("title")
                pdf_author = pdf_result.get("author")
                pdf_page_count = pdf_result.get("page_count")
            except Exception as e:
                logger.warning(f"Structured PDF extraction failed for {filename}: {e}")
                vault_ingest_status = "failed"

    now = now_ms()
    attachment = ChatAttachment(
        id=att_id,
        session_id=session_id,
        filename=filename,
        mime_type=mime_type,
        size_bytes=len(data),
        storage_path=storage_path,
        processing_status=processing_status,
        extracted_text=extracted_text,
        estimated_tokens=estimated_tokens,
        structured_json=structured_json_str,
        pdf_title=pdf_title,
        pdf_author=pdf_author,
        pdf_page_count=pdf_page_count,
        vault_ingest_status=vault_ingest_status,
        created_at=now,
    )
    db.add(attachment)
    await db.commit()

    # Trigger vault ingest for PDFs (fire-and-forget)
    if mime_type == "application/pdf" and structured_json_str:
        import asyncio

        asyncio.create_task(
            _ingest_pdf_to_vault(
                att_id,
                structured_json_str,
                extracted_text or "",
                filename,
                pdf_page_count or 0,
                pdf_title,
                pdf_author,
            )
        )

    # Trigger audio transcription (fire-and-forget)
    if is_audio:
        import asyncio

        asyncio.create_task(_transcribe_audio_async(att_id, data, mime_type, filename))

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
    # Audio formats
    ".ogg": "audio/ogg",
    ".opus": "audio/opus",
    ".mp3": "audio/mpeg",
    ".m4a": "audio/mp4",
    ".wav": "audio/wav",
    ".webm": "audio/webm",
    ".aac": "audio/aac",
    ".flac": "audio/flac",
    ".amr": "audio/amr",
}


def _normalize_mime(mime: str) -> str:
    """Strip codec parameters from MIME types.

    Browsers send e.g. 'audio/webm;codecs=opus' but our ALLOWED_MIME_TYPES
    set contains 'audio/webm'.  Strip everything after the semicolon.
    """
    return mime.split(";")[0].strip()


def _guess_mime(filename: str) -> str:
    """Guess MIME type from file extension."""
    import os

    ext = os.path.splitext(filename)[1].lower()
    return _EXTENSION_MIME_MAP.get(ext, "application/octet-stream")


# ── PDF Vault Ingest ──────────────────────────────────────────────────────────


async def _ingest_pdf_to_vault(
    attachment_id: str,
    structured_json_str: str,
    markdown_text: str,
    filename: str,
    page_count: int,
    title: Optional[str],
    author: Optional[str],
) -> None:
    """Background task: chunk a PDF and ingest into the shared vault.

    Updates the ChatAttachment record with vault ingest metadata on completion.
    """
    try:
        json_data = json.loads(structured_json_str)

        # Chunk the document
        chunks = chunk_pdf(json_data, markdown_text, attachment_id, filename)
        toc = extract_toc(json_data)

        # Write to shared vault
        result = await ingest_pdf_to_shared_vault_async(
            chunks=chunks,
            toc=toc,
            document_id=attachment_id,
            filename=filename,
            page_count=page_count,
            title=title,
            author=author,
            redis_client=dependencies.redis_client,
        )

        # Update the attachment record
        async with AsyncSessionLocal() as db:
            att_result = await db.execute(
                select(ChatAttachment).where(ChatAttachment.id == attachment_id)
            )
            att = att_result.scalar_one_or_none()
            if att:
                att.vault_ingest_status = "ingested"
                att.vault_doc_slug = result["doc_slug"]
                att.vault_chunk_count = len(chunks)
                await db.commit()

        logger.info(
            f"PDF vault ingest complete: {filename} → {result['files_written']} files, "
            f"{len(chunks)} chunks in shared/documents/{result['doc_slug']}/"
        )

    except Exception as e:
        logger.error(f"PDF vault ingest failed for {attachment_id} ({filename}): {e}")
        # Mark as failed
        try:
            async with AsyncSessionLocal() as db:
                att_result = await db.execute(
                    select(ChatAttachment).where(ChatAttachment.id == attachment_id)
                )
                att = att_result.scalar_one_or_none()
                if att:
                    att.vault_ingest_status = "failed"
                    await db.commit()
        except Exception:
            pass  # Best-effort status update


# ── Audio Transcription ──────────────────────────────────────────────────────


def _transcribe_audio(
    attachment_id: str,
    data: bytes,
    mime_type: str,
    filename: str,
) -> None:
    """Background task (sync): transcribe audio and update the attachment record.

    Used by the public upload endpoint via FastAPI BackgroundTasks (sync).
    """
    import asyncio

    asyncio.run(_transcribe_audio_async(attachment_id, data, mime_type, filename))


async def _transcribe_audio_async(
    attachment_id: str,
    data: bytes,
    mime_type: str,
    filename: str,
) -> None:
    """Background task (async): transcribe audio and update the attachment record.

    Used by the internal upload endpoint via asyncio.create_task().
    Runs faster-whisper in a thread pool to avoid blocking the event loop.
    """
    import asyncio

    try:
        # Run transcription in thread pool (faster-whisper is CPU-bound)
        loop = asyncio.get_event_loop()
        transcript, tokens = await loop.run_in_executor(
            None, transcribe_audio, data, mime_type, filename
        )

        # Wrap transcript so the agent knows it's a voice message
        if transcript:
            transcript = f'[Voice message from user, transcribed]: "{transcript}"'

        # Update the attachment record with the transcript
        async with AsyncSessionLocal() as db:
            att_result = await db.execute(
                select(ChatAttachment).where(ChatAttachment.id == attachment_id)
            )
            att = att_result.scalar_one_or_none()
            if att:
                att.extracted_text = (
                    transcript or f"[Voice message ({filename}) — no speech detected]"
                )
                att.estimated_tokens = tokens or 15
                att.processing_status = "ready"
                await db.commit()

        # Notify waiting consumers (engine/CSM) via Redis pub/sub
        if dependencies.redis_client:
            try:
                await dependencies.redis_client.publish(
                    f"attachment:ready:{attachment_id}",
                    "ready",
                )
            except Exception:
                pass  # Best-effort — CSM will fall back to timeout

        if transcript:
            logger.info(
                f"Audio transcription complete: {filename} → "
                f"{len(transcript)} chars, ~{tokens} tokens"
            )
        else:
            logger.warning(f"Audio transcription returned no text for {filename}")

    except Exception as e:
        logger.error(
            f"Audio transcription failed for {attachment_id} ({filename}): {e}"
        )
        # Mark as failed
        try:
            async with AsyncSessionLocal() as db:
                att_result = await db.execute(
                    select(ChatAttachment).where(ChatAttachment.id == attachment_id)
                )
                att = att_result.scalar_one_or_none()
                if att:
                    att.processing_status = "failed"
                    att.extracted_text = (
                        f"[Audio transcription failed for {filename}: {e}]"
                    )
                    att.estimated_tokens = 15
                    await db.commit()
            # Still notify so CSM doesn't hang waiting
            if dependencies.redis_client:
                await dependencies.redis_client.publish(
                    f"attachment:ready:{attachment_id}",
                    "failed",
                )
        except Exception:
            pass  # Best-effort status update
