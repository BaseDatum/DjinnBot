"""Structured PDF chunking using OpenDataLoader JSON output.

Takes the structured JSON produced by opendataloader-pdf and builds
semantically meaningful chunks that respect document structure:

- Headings start new chunks
- Tables are kept intact (never split mid-row)
- Lists stay together
- Chunks target ~500-1000 tokens each
- Each chunk carries metadata: page numbers, section path, element types

For small documents (<10 pages, <5K tokens markdown), produces a single chunk
to avoid over-engineering simple cases.
"""

import re
from typing import Optional

from app.logging_config import get_logger
from app.services.text_extraction import estimate_tokens

logger = get_logger(__name__)

# Chunking thresholds
SMALL_DOC_PAGE_LIMIT = 10
SMALL_DOC_TOKEN_LIMIT = 5_000
TARGET_CHUNK_TOKENS = 800
MAX_CHUNK_TOKENS = 1_500


class PdfChunk:
    """A semantically meaningful chunk of a PDF document."""

    def __init__(
        self,
        chunk_index: int,
        document_id: str,
        filename: str,
        content: str,
        page_numbers: list[int],
        section_heading: str,
        element_types: list[str],
        token_estimate: int,
    ):
        self.chunk_index = chunk_index
        self.document_id = document_id
        self.filename = filename
        self.content = content
        self.page_numbers = page_numbers
        self.section_heading = section_heading
        self.element_types = element_types
        self.token_estimate = token_estimate

    def to_dict(self) -> dict:
        return {
            "chunk_index": self.chunk_index,
            "document_id": self.document_id,
            "filename": self.filename,
            "content": self.content,
            "page_numbers": self.page_numbers,
            "section_heading": self.section_heading,
            "element_types": self.element_types,
            "token_estimate": self.token_estimate,
        }


class TableOfContentsEntry:
    """A heading entry for the document table of contents."""

    def __init__(self, level: int, title: str, page: int):
        self.level = level
        self.title = title
        self.page = page


def chunk_pdf(
    json_data: dict,
    markdown_text: str,
    document_id: str,
    filename: str,
) -> list[PdfChunk]:
    """Chunk a PDF document into semantically meaningful pieces.

    For small documents, returns a single chunk with the full markdown.
    For larger documents, uses the structured JSON to build heading-aware chunks.

    Args:
        json_data: Structured JSON from opendataloader-pdf (with kids, types, etc.)
        markdown_text: Full markdown text from opendataloader-pdf
        document_id: Attachment ID (e.g., att_xxx)
        filename: Original filename

    Returns:
        List of PdfChunk objects ready for vault ingest.
    """
    page_count = json_data.get("number of pages", 0)
    md_tokens = estimate_tokens(markdown_text)

    # Small document optimization: single chunk
    if page_count <= SMALL_DOC_PAGE_LIMIT and md_tokens <= SMALL_DOC_TOKEN_LIMIT:
        logger.info(
            f"PDF {filename}: small doc ({page_count} pages, ~{md_tokens} tokens) — single chunk"
        )
        return [
            PdfChunk(
                chunk_index=0,
                document_id=document_id,
                filename=filename,
                content=markdown_text,
                page_numbers=list(range(1, page_count + 1)),
                section_heading=filename,
                element_types=["full_document"],
                token_estimate=md_tokens,
            )
        ]

    # Larger document: chunk by structure
    kids = json_data.get("kids", [])
    if not kids:
        # No structured data — fall back to single chunk
        return [
            PdfChunk(
                chunk_index=0,
                document_id=document_id,
                filename=filename,
                content=markdown_text,
                page_numbers=list(range(1, page_count + 1)),
                section_heading=filename,
                element_types=["full_document"],
                token_estimate=md_tokens,
            )
        ]

    return _chunk_by_structure(kids, document_id, filename)


def extract_toc(json_data: dict) -> list[TableOfContentsEntry]:
    """Extract table of contents (headings only) from structured JSON.

    Returns a lightweight heading list for the document inventory —
    costs very few tokens but gives agents an overview of the document.
    """
    toc: list[TableOfContentsEntry] = []

    def _walk(elements: list[dict]) -> None:
        for el in elements:
            el_type = el.get("type", "")
            if el_type == "heading":
                level = el.get("heading level", 1)
                content = el.get("content", "").strip()
                page = el.get("page number", 0)
                if content:
                    toc.append(
                        TableOfContentsEntry(level=level, title=content, page=page)
                    )
            # Recurse into nested structures
            for child_key in ("kids", "list items", "rows"):
                children = el.get(child_key, [])
                if children:
                    _walk(children)

    _walk(json_data.get("kids", []))
    return toc


def format_toc(toc: list[TableOfContentsEntry], filename: str) -> str:
    """Format TOC entries into a compact markdown string."""
    if not toc:
        return f"**{filename}** — no headings detected"

    lines = [f"**{filename}**"]
    for entry in toc:
        indent = "  " * (entry.level - 1)
        lines.append(f"{indent}- {entry.title} (p.{entry.page})")
    return "\n".join(lines)


def _chunk_by_structure(
    kids: list[dict],
    document_id: str,
    filename: str,
) -> list[PdfChunk]:
    """Walk the JSON element tree and build chunks respecting headings."""
    chunks: list[PdfChunk] = []
    current_heading = filename
    current_content_parts: list[str] = []
    current_pages: set[int] = set()
    current_types: set[str] = set()
    current_tokens = 0

    def _flush_chunk() -> None:
        nonlocal current_content_parts, current_pages, current_types, current_tokens
        if not current_content_parts:
            return

        content = "\n\n".join(current_content_parts)
        tokens = estimate_tokens(content)
        chunks.append(
            PdfChunk(
                chunk_index=len(chunks),
                document_id=document_id,
                filename=filename,
                content=content,
                page_numbers=sorted(current_pages),
                section_heading=current_heading,
                element_types=sorted(current_types),
                token_estimate=tokens,
            )
        )
        current_content_parts = []
        current_pages = set()
        current_types = set()
        current_tokens = 0

    for element in kids:
        el_type = element.get("type", "unknown")
        page = element.get("page number", 0)

        # Headings start a new chunk
        if el_type == "heading":
            _flush_chunk()
            level = element.get("heading level", 1)
            content = element.get("content", "").strip()
            if content:
                current_heading = content
                md_heading = "#" * min(level, 6) + " " + content
                current_content_parts.append(md_heading)
                current_pages.add(page)
                current_types.add("heading")
                current_tokens += estimate_tokens(md_heading)
            continue

        # Build content for this element
        el_content = _element_to_markdown(element)
        if not el_content.strip():
            continue

        el_tokens = estimate_tokens(el_content)

        # Tables are always kept as a single unit — flush before if needed
        if (
            el_type == "table"
            and current_tokens > 0
            and current_tokens + el_tokens > MAX_CHUNK_TOKENS
        ):
            _flush_chunk()

        # Regular content: flush if we'd exceed target
        if current_tokens + el_tokens > TARGET_CHUNK_TOKENS and current_content_parts:
            # But don't flush if the element alone exceeds target (avoid empty chunks)
            if current_tokens > 0:
                _flush_chunk()

        current_content_parts.append(el_content)
        current_pages.add(page)
        current_types.add(el_type)
        current_tokens += el_tokens

    # Flush remaining
    _flush_chunk()

    logger.info(
        f"PDF {filename}: chunked into {len(chunks)} chunks from {len(kids)} elements"
    )
    return chunks


def _element_to_markdown(element: dict) -> str:
    """Convert a single JSON element to markdown text."""
    el_type = element.get("type", "")

    if el_type == "paragraph":
        return element.get("content", "")

    if el_type == "heading":
        level = element.get("heading level", 1)
        content = element.get("content", "")
        return "#" * min(level, 6) + " " + content

    if el_type == "caption":
        content = element.get("content", "")
        return f"*{content}*" if content else ""

    if el_type == "table":
        return _table_to_markdown(element)

    if el_type == "list":
        return _list_to_markdown(element)

    if el_type == "image":
        desc = element.get("description", "")
        return f"[Image: {desc}]" if desc else "[Image]"

    if el_type == "text block":
        kids = element.get("kids", [])
        parts = [_element_to_markdown(kid) for kid in kids]
        return "\n\n".join(p for p in parts if p.strip())

    if el_type in ("header", "footer"):
        # Filtered by default — include only if explicitly requested
        return ""

    # Fallback: try content field
    content = element.get("content", "")
    return content


def _table_to_markdown(table: dict) -> str:
    """Convert a table element to a markdown table."""
    rows = table.get("rows", [])
    if not rows:
        return ""

    md_rows: list[str] = []
    for i, row in enumerate(rows):
        cells = row.get("cells", [])
        cell_texts: list[str] = []
        for cell in cells:
            # Cell content can be nested kids or direct content
            kids = cell.get("kids", [])
            if kids:
                parts = [_element_to_markdown(kid) for kid in kids]
                cell_text = " ".join(p.strip() for p in parts if p.strip())
            else:
                cell_text = cell.get("content", "")
            # Clean for table cell (no newlines)
            cell_text = cell_text.replace("\n", " ").strip()
            cell_texts.append(cell_text)

        md_rows.append("| " + " | ".join(cell_texts) + " |")

        # Add separator after header row
        if i == 0:
            md_rows.append("| " + " | ".join("---" for _ in cell_texts) + " |")

    return "\n".join(md_rows)


def _list_to_markdown(list_el: dict) -> str:
    """Convert a list element to markdown."""
    items = list_el.get("list items", [])
    style = list_el.get("numbering style", "bullet")
    lines: list[str] = []

    for idx, item in enumerate(items):
        content = item.get("content", "")
        # Also check nested kids
        kids = item.get("kids", [])
        if kids and not content:
            parts = [_element_to_markdown(kid) for kid in kids]
            content = " ".join(p.strip() for p in parts if p.strip())

        if style == "ordered" or style == "decimal":
            lines.append(f"{idx + 1}. {content}")
        else:
            lines.append(f"- {content}")

    return "\n".join(lines)
