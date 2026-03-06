"""Document query endpoints for PDF knowledge retrieval.

Provides APIs for agents to lazily access document content:
- List all ingested documents (lightweight inventory)
- Get table of contents for a document
- Read a specific section/page
- Search across document chunks

These endpoints are called by the agent-runtime `read_document` tool
to pull only the content an agent needs, instead of dumping full PDFs
into context windows.
"""

import json
import os
from typing import Optional, List
from fastapi import APIRouter, HTTPException, Depends, Query
from pydantic import BaseModel
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.database import get_async_session
from app.models.chat import ChatAttachment
from app.services.pdf_chunker import extract_toc, format_toc
from app.logging_config import get_logger

logger = get_logger(__name__)
router = APIRouter()

VAULTS_DIR = os.getenv("VAULTS_DIR", "/jfs/vaults")


# ── Response Models ────────────────────────────────────────────────────────────


class DocumentSummary(BaseModel):
    attachment_id: str
    filename: str
    title: Optional[str] = None
    author: Optional[str] = None
    page_count: Optional[int] = None
    chunk_count: Optional[int] = None
    vault_doc_slug: Optional[str] = None
    ingest_status: Optional[str] = None
    estimated_tokens: Optional[int] = None


class DocumentListResponse(BaseModel):
    documents: List[DocumentSummary]
    total: int


class DocumentTocResponse(BaseModel):
    attachment_id: str
    filename: str
    toc_markdown: str
    page_count: int


class DocumentSectionResponse(BaseModel):
    attachment_id: str
    filename: str
    section_heading: str
    content: str
    page_numbers: List[int]
    chunk_index: int
    estimated_tokens: int


class DocumentSearchResult(BaseModel):
    attachment_id: str
    filename: str
    section_heading: str
    content: str
    page_numbers: List[int]
    chunk_index: int
    score: float


# ── Endpoints ──────────────────────────────────────────────────────────────────


@router.get("/documents", response_model=DocumentListResponse)
async def list_documents(
    db: AsyncSession = Depends(get_async_session),
):
    """List all ingested PDF documents.

    Returns a lightweight inventory (~50 tokens) that agents use to know
    what documents are available for recall.
    """
    result = await db.execute(
        select(ChatAttachment)
        .where(ChatAttachment.mime_type == "application/pdf")
        .where(ChatAttachment.vault_ingest_status == "ingested")
        .order_by(ChatAttachment.created_at.desc())
    )
    attachments = result.scalars().all()

    documents = [
        DocumentSummary(
            attachment_id=att.id,
            filename=att.filename,
            title=att.pdf_title,
            author=att.pdf_author,
            page_count=att.pdf_page_count,
            chunk_count=att.vault_chunk_count,
            vault_doc_slug=att.vault_doc_slug,
            ingest_status=att.vault_ingest_status,
            estimated_tokens=att.estimated_tokens,
        )
        for att in attachments
    ]

    return DocumentListResponse(documents=documents, total=len(documents))


@router.get("/documents/{attachment_id}/toc", response_model=DocumentTocResponse)
async def get_document_toc(
    attachment_id: str,
    db: AsyncSession = Depends(get_async_session),
):
    """Get the table of contents (headings) for a PDF document.

    Very lightweight — returns just headings with page numbers.
    Agents use this to understand document structure before pulling sections.
    """
    att = await _get_pdf_attachment(attachment_id, db)
    if not att.structured_json:
        raise HTTPException(400, "No structured data available for this document")

    json_data = json.loads(att.structured_json)
    toc = extract_toc(json_data)
    toc_md = format_toc(toc, att.filename)

    return DocumentTocResponse(
        attachment_id=att.id,
        filename=att.filename,
        toc_markdown=toc_md,
        page_count=att.pdf_page_count or 0,
    )


@router.get("/documents/{attachment_id}/section")
async def get_document_section(
    attachment_id: str,
    heading: Optional[str] = Query(None, description="Section heading to find"),
    page: Optional[int] = Query(None, description="Page number (1-indexed)"),
    chunk_index: Optional[int] = Query(None, description="Direct chunk index"),
    db: AsyncSession = Depends(get_async_session),
):
    """Read a specific section of a PDF document.

    Agents can query by heading name, page number, or direct chunk index.
    Returns just the relevant content — token-efficient.
    """
    att = await _get_pdf_attachment(attachment_id, db)
    if not att.vault_doc_slug:
        raise HTTPException(400, "Document not yet ingested into vault")

    # Read chunks from the vault filesystem
    doc_dir = os.path.join(VAULTS_DIR, "shared", "documents", att.vault_doc_slug)
    if not os.path.isdir(doc_dir):
        raise HTTPException(404, "Document vault directory not found")

    chunks = _read_vault_chunks(doc_dir)
    if not chunks:
        raise HTTPException(404, "No chunks found for this document")

    # Find matching chunk
    if chunk_index is not None:
        # Direct index access
        matching = [c for c in chunks if c["chunk_index"] == chunk_index]
    elif heading:
        # Search by heading (case-insensitive partial match)
        heading_lower = heading.lower()
        matching = [c for c in chunks if heading_lower in c.get("section", "").lower()]
    elif page:
        # Find chunks containing this page
        matching = [c for c in chunks if page in c.get("pages", [])]
    else:
        raise HTTPException(400, "Provide heading, page, or chunk_index")

    if not matching:
        return {"results": [], "message": f"No matching section found"}

    results = []
    for chunk in matching:
        from app.services.text_extraction import estimate_tokens

        results.append(
            DocumentSectionResponse(
                attachment_id=att.id,
                filename=att.filename,
                section_heading=chunk.get("section", ""),
                content=chunk.get("content", ""),
                page_numbers=chunk.get("pages", []),
                chunk_index=chunk.get("chunk_index", 0),
                estimated_tokens=estimate_tokens(chunk.get("content", "")),
            )
        )

    return {"results": [r.model_dump() for r in results]}


@router.get("/documents/{attachment_id}/search")
async def search_document(
    attachment_id: str,
    q: str = Query(..., description="Search query"),
    limit: int = Query(5, ge=1, le=20),
    db: AsyncSession = Depends(get_async_session),
):
    """Search within a specific document's chunks.

    Performs a simple keyword search across the document's vault chunks.
    For semantic search, agents should use the recall tool with scope=shared.
    """
    att = await _get_pdf_attachment(attachment_id, db)
    if not att.vault_doc_slug:
        raise HTTPException(400, "Document not yet ingested into vault")

    doc_dir = os.path.join(VAULTS_DIR, "shared", "documents", att.vault_doc_slug)
    if not os.path.isdir(doc_dir):
        raise HTTPException(404, "Document vault directory not found")

    chunks = _read_vault_chunks(doc_dir)
    query_lower = q.lower()

    # Score chunks by keyword match density
    scored = []
    for chunk in chunks:
        content_lower = chunk.get("content", "").lower()
        section_lower = chunk.get("section", "").lower()

        # Count query word matches
        words = query_lower.split()
        score = sum(
            content_lower.count(word) + section_lower.count(word) * 2 for word in words
        )
        if score > 0:
            scored.append((score, chunk))

    scored.sort(key=lambda x: x[0], reverse=True)

    results = []
    for score, chunk in scored[:limit]:
        results.append(
            DocumentSearchResult(
                attachment_id=att.id,
                filename=att.filename,
                section_heading=chunk.get("section", ""),
                content=chunk.get("content", ""),
                page_numbers=chunk.get("pages", []),
                chunk_index=chunk.get("chunk_index", 0),
                score=float(score),
            )
        )

    return {"results": [r.model_dump() for r in results], "total_matches": len(scored)}


# ── Helpers ────────────────────────────────────────────────────────────────────


async def _get_pdf_attachment(attachment_id: str, db: AsyncSession) -> ChatAttachment:
    """Fetch and validate a PDF attachment."""
    result = await db.execute(
        select(ChatAttachment).where(ChatAttachment.id == attachment_id)
    )
    att = result.scalar_one_or_none()
    if not att:
        raise HTTPException(404, f"Attachment {attachment_id} not found")
    if att.mime_type != "application/pdf":
        raise HTTPException(400, "Attachment is not a PDF")
    return att


def _read_vault_chunks(doc_dir: str) -> list[dict]:
    """Read chunk metadata and content from vault markdown files.

    Parses frontmatter from each chunk-NN.md file to reconstruct
    chunk metadata without needing the original structured JSON.
    """
    from app.utils import parse_frontmatter as _parse_frontmatter

    chunks = []
    for entry in sorted(os.listdir(doc_dir)):
        if not entry.startswith("chunk-") or not entry.endswith(".md"):
            continue

        filepath = os.path.join(doc_dir, entry)
        if not os.path.isfile(filepath):
            continue

        with open(filepath, "r", encoding="utf-8") as f:
            raw = f.read()

        meta, body = _parse_frontmatter(raw)
        chunks.append(
            {
                "chunk_index": meta.get("chunk_index", 0),
                "section": meta.get("section", ""),
                "pages": meta.get("pages", []),
                "element_types": meta.get("element_types", []),
                "content": body or "",
                "filename": entry,
            }
        )

    return chunks
