"""Ingest PDF chunks into the shared ClawVault memory.

All PDF uploads go to the shared vault so every agent can recall document
knowledge via semantic search + BM25.  Chunks are written as individual
markdown files with frontmatter, then a single Redis signal triggers
re-indexing (qmd update + embed).

File layout in shared vault:
  documents/{slug}/
    _index.md          — document metadata + table of contents
    chunk-00.md        — first chunk
    chunk-01.md        — second chunk
    ...

Each chunk is wiki-linked back to the _index.md file and to adjacent chunks,
building graph edges that ClawVault's graph traversal can follow.
"""

import json
import os
import re
import time
from typing import Optional

from app.logging_config import get_logger
from app.services.pdf_chunker import PdfChunk, TableOfContentsEntry, format_toc

logger = get_logger(__name__)

VAULTS_DIR = os.getenv("VAULTS_DIR", "/data/vaults")


def _slugify(text: str) -> str:
    """Create a filesystem-safe slug from text."""
    slug = re.sub(r"[^a-z0-9]+", "-", text.lower()).strip("-")
    return slug[:80] if slug else "untitled"


def ingest_pdf_to_shared_vault(
    chunks: list[PdfChunk],
    toc: list[TableOfContentsEntry],
    document_id: str,
    filename: str,
    page_count: int,
    title: Optional[str] = None,
    author: Optional[str] = None,
    redis_client=None,
) -> dict:
    """Write PDF chunks to the shared vault as markdown files.

    Args:
        chunks: List of PdfChunk objects from pdf_chunker
        toc: Table of contents entries
        document_id: Attachment ID (att_xxx)
        filename: Original PDF filename
        page_count: Total page count
        title: PDF metadata title
        author: PDF metadata author
        redis_client: Optional Redis client for signaling re-index

    Returns:
        dict with ingest metadata:
          - doc_slug: str
          - files_written: int
          - vault_path: str
    """
    shared_dir = os.path.join(VAULTS_DIR, "shared")
    os.makedirs(shared_dir, exist_ok=True)

    doc_name = title or os.path.splitext(filename)[0]
    doc_slug = _slugify(doc_name)
    doc_dir = os.path.join(shared_dir, "documents", doc_slug)
    os.makedirs(doc_dir, exist_ok=True)

    files_written = 0
    now_str = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())

    # 1. Write the index file (metadata + TOC)
    index_path = os.path.join(doc_dir, "_index.md")
    toc_text = format_toc(toc, filename)

    chunk_links = []
    for i, chunk in enumerate(chunks):
        chunk_links.append(f"[[{doc_slug}/chunk-{i:02d}]]")

    index_content = _build_frontmatter(
        {
            "title": doc_name,
            "category": "fact",
            "type": "document_index",
            "source": "pdf",
            "filename": filename,
            "document_id": document_id,
            "page_count": page_count,
            "chunk_count": len(chunks),
            "author": author or "unknown",
            "created": now_str,
            "tags": ["pdf", "document"],
        }
    )
    index_content += f"# {doc_name}\n\n"
    index_content += (
        f"**Source:** {filename} ({page_count} pages, {len(chunks)} chunks)\n\n"
    )
    if author:
        index_content += f"**Author:** {author}\n\n"
    index_content += "## Table of Contents\n\n"
    index_content += toc_text + "\n\n"
    index_content += "## Document Chunks\n\n"
    index_content += "\n".join(chunk_links) + "\n"

    with open(index_path, "w", encoding="utf-8") as f:
        f.write(index_content)
    files_written += 1

    # 2. Write each chunk as a separate file
    for i, chunk in enumerate(chunks):
        chunk_filename = f"chunk-{i:02d}.md"
        chunk_path = os.path.join(doc_dir, chunk_filename)

        # Build wiki-links: back to index + adjacent chunks
        links = [f"[[{doc_slug}/_index]]"]
        if i > 0:
            links.append(f"[[{doc_slug}/chunk-{i - 1:02d}]]")
        if i < len(chunks) - 1:
            links.append(f"[[{doc_slug}/chunk-{i + 1:02d}]]")

        chunk_content = _build_frontmatter(
            {
                "title": f"{doc_name} — {chunk.section_heading}",
                "category": "fact",
                "type": "document_chunk",
                "source": "pdf",
                "document_id": document_id,
                "document_slug": doc_slug,
                "filename": filename,
                "chunk_index": chunk.chunk_index,
                "pages": chunk.page_numbers,
                "section": chunk.section_heading,
                "element_types": chunk.element_types,
                "created": now_str,
                "tags": ["pdf", "document-chunk"],
            }
        )
        chunk_content += chunk.content + "\n\n"
        chunk_content += "---\n"
        chunk_content += "Related: " + " ".join(links) + "\n"

        with open(chunk_path, "w", encoding="utf-8") as f:
            f.write(chunk_content)
        files_written += 1

    logger.info(
        f"PDF vault ingest: {filename} → {files_written} files in shared/documents/{doc_slug}/"
    )

    # 3. Signal engine to re-index (single signal for the batch)
    if redis_client:
        _signal_reindex(redis_client, doc_slug)

    return {
        "doc_slug": doc_slug,
        "files_written": files_written,
        "vault_path": f"documents/{doc_slug}",
    }


async def ingest_pdf_to_shared_vault_async(
    chunks: list[PdfChunk],
    toc: list[TableOfContentsEntry],
    document_id: str,
    filename: str,
    page_count: int,
    title: Optional[str] = None,
    author: Optional[str] = None,
    redis_client=None,
) -> dict:
    """Async wrapper for vault ingest — signals Redis asynchronously."""
    # File writes are fast enough to do synchronously
    result = ingest_pdf_to_shared_vault(
        chunks=chunks,
        toc=toc,
        document_id=document_id,
        filename=filename,
        page_count=page_count,
        title=title,
        author=author,
        redis_client=None,  # Don't signal synchronously
    )

    # Signal asynchronously via the async Redis client
    if redis_client:
        try:
            await redis_client.publish(
                "djinnbot:vault:updated",
                json.dumps(
                    {
                        "agentId": "shared",
                        "sharedUpdated": True,
                        "timestamp": int(time.time() * 1000),
                    }
                ),
            )
            logger.info(f"PDF vault ingest: signaled re-index for {result['doc_slug']}")
        except Exception as e:
            logger.warning(f"PDF vault ingest: failed to signal re-index: {e}")

    return result


def _build_frontmatter(meta: dict) -> str:
    """Build YAML frontmatter from a dict."""
    lines = ["---"]
    for k, v in meta.items():
        if v is None:
            continue
        if isinstance(v, list):
            if all(isinstance(i, int) for i in v):
                lines.append(f"{k}: [{', '.join(str(i) for i in v)}]")
            else:
                lines.append(f"{k}: [{', '.join(repr(i) for i in v)}]")
        elif isinstance(v, bool):
            lines.append(f"{k}: {'true' if v else 'false'}")
        elif isinstance(v, int):
            lines.append(f"{k}: {v}")
        else:
            # Quote strings that contain special YAML characters
            sv = str(v)
            if any(c in sv for c in ":#{}[]|>&*!%@"):
                lines.append(f'{k}: "{sv}"')
            else:
                lines.append(f"{k}: {sv}")
    lines.append("---")
    lines.append("")
    return "\n".join(lines) + "\n"


def _signal_reindex(redis_client, doc_slug: str) -> None:
    """Publish a synchronous Redis signal for vault re-indexing."""
    try:
        redis_client.publish(
            "djinnbot:vault:updated",
            json.dumps(
                {
                    "agentId": "shared",
                    "sharedUpdated": True,
                    "timestamp": int(time.time() * 1000),
                }
            ),
        )
    except Exception as e:
        logger.warning(f"PDF vault ingest: sync Redis signal failed: {e}")
