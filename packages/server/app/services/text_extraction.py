"""Text extraction from uploaded files for context injection.

Extracts plain-text content from various file types so it can be sent to LLMs
as context alongside the user message.  For images, no text extraction is needed
— they are sent as base64 content blocks directly.

Supported formats:
- Plain text / code files: read as-is
- PDF: structured extraction via opendataloader-pdf (markdown + JSON with
  bounding boxes, tables, reading order) — falls back to pypdf
- CSV: first N rows converted to markdown table
- JSON: pretty-printed, truncated

Token estimation uses a rough chars/4 heuristic.
"""

import json
import csv
import io
import os
import tempfile
from typing import Optional, Tuple

from app.logging_config import get_logger

logger = get_logger(__name__)

# Maximum extracted text size (characters) — ~25K tokens
MAX_EXTRACTED_CHARS = 100_000
# Maximum CSV rows to include
MAX_CSV_ROWS = 100


def estimate_tokens(text: str) -> int:
    """Rough token estimate: ~4 chars per token for English text."""
    return max(1, len(text) // 4)


def extract_text(
    data: bytes, mime_type: str, filename: str
) -> Tuple[Optional[str], int]:
    """Extract text from file data.

    Returns (extracted_text, estimated_tokens).
    Returns (None, 0) for image types (handled as base64 content blocks).
    """
    if mime_type.startswith("image/"):
        # Images: estimate tokens based on Anthropic's formula (~1600 tokens per 1000x1000)
        # Without decoding the image we can't know dimensions, so use a flat estimate
        return None, 1600

    try:
        if mime_type in (
            "text/plain",
            "text/markdown",
            "text/html",
            "text/css",
            "text/xml",
            "application/xml",
            "text/x-python",
            "text/javascript",
            "text/typescript",
            "application/x-yaml",
            "text/yaml",
        ):
            return _extract_plain_text(data)

        if mime_type == "application/json":
            return _extract_json(data)

        if mime_type == "text/csv":
            return _extract_csv(data)

        if mime_type == "application/pdf":
            return _extract_pdf(data, filename)

        # Unknown type — try reading as text
        return _extract_plain_text(data)

    except Exception as e:
        logger.warning(f"Text extraction failed for {filename} ({mime_type}): {e}")
        return f"[Could not extract text from {filename}: {e}]", 20


def _extract_plain_text(data: bytes) -> Tuple[str, int]:
    """Read bytes as UTF-8 text, truncating if needed."""
    try:
        text = data.decode("utf-8", errors="replace")
    except Exception:
        text = data.decode("latin-1", errors="replace")

    if len(text) > MAX_EXTRACTED_CHARS:
        text = (
            text[:MAX_EXTRACTED_CHARS] + f"\n\n... [truncated, {len(data)} bytes total]"
        )
    return text, estimate_tokens(text)


def _extract_json(data: bytes) -> Tuple[str, int]:
    """Pretty-print JSON, truncate if large."""
    try:
        obj = json.loads(data)
        text = json.dumps(obj, indent=2, ensure_ascii=False)
    except json.JSONDecodeError:
        text = data.decode("utf-8", errors="replace")

    if len(text) > MAX_EXTRACTED_CHARS:
        text = text[:MAX_EXTRACTED_CHARS] + "\n... [truncated]"
    return text, estimate_tokens(text)


def _extract_csv(data: bytes) -> Tuple[str, int]:
    """Convert CSV to a markdown table (first N rows)."""
    text_data = data.decode("utf-8", errors="replace")
    reader = csv.reader(io.StringIO(text_data))

    rows = []
    for i, row in enumerate(reader):
        if i >= MAX_CSV_ROWS + 1:  # +1 for header
            break
        rows.append(row)

    if not rows:
        return "[Empty CSV file]", 5

    # Build markdown table
    header = rows[0]
    lines = [
        "| " + " | ".join(header) + " |",
        "| " + " | ".join("---" for _ in header) + " |",
    ]
    for row in rows[1:]:
        # Pad/truncate to header width
        padded = row + [""] * (len(header) - len(row))
        lines.append("| " + " | ".join(padded[: len(header)]) + " |")

    total_rows = sum(1 for _ in csv.reader(io.StringIO(text_data))) - 1
    if total_rows > MAX_CSV_ROWS:
        lines.append(f"\n... [{total_rows - MAX_CSV_ROWS} more rows not shown]")

    text = "\n".join(lines)
    return text, estimate_tokens(text)


def _extract_pdf(data: bytes, filename: str) -> Tuple[str, int]:
    """Extract text from a PDF using opendataloader-pdf.

    Produces structured markdown with correct reading order, table preservation,
    and header/footer filtering.  Falls back to pypdf if opendataloader is
    unavailable (missing Java runtime).
    """
    try:
        result = extract_pdf_structured(data, filename)
        text = result["markdown"]
        if not text or not text.strip():
            return (
                f"[PDF '{filename}' contains no extractable text]",
                20,
            )
        if len(text) > MAX_EXTRACTED_CHARS:
            page_count = result.get("page_count", "?")
            text = (
                text[:MAX_EXTRACTED_CHARS]
                + f"\n\n... [truncated, {page_count} pages total]"
            )
        return text, estimate_tokens(text)

    except Exception as e:
        logger.warning(f"OpenDataLoader PDF extraction failed for {filename}: {e}")
        # Fall back to pypdf
        return _extract_pdf_fallback(data, filename)


def extract_pdf_structured(data: bytes, filename: str) -> dict:
    """Run opendataloader-pdf and return both markdown and structured JSON.

    Returns dict with keys:
      - markdown: str  (clean markdown text)
      - json_data: dict | None  (structured JSON with bounding boxes, types)
      - page_count: int
      - title: str | None
      - author: str | None

    Raises on failure (caller should handle).
    """
    import opendataloader_pdf

    with tempfile.TemporaryDirectory(prefix="djinnbot_pdf_") as tmpdir:
        # Write PDF to temp file
        input_path = os.path.join(tmpdir, filename)
        output_dir = os.path.join(tmpdir, "output")
        os.makedirs(output_dir, exist_ok=True)

        with open(input_path, "wb") as f:
            f.write(data)

        # Run opendataloader — produces markdown + json files
        opendataloader_pdf.convert(
            input_path=input_path,
            output_dir=output_dir,
            format="markdown,json",
            image_output="off",  # Don't extract images for now
            quiet=True,
        )

        # Read outputs
        base_name = os.path.splitext(filename)[0]
        md_path = os.path.join(output_dir, f"{base_name}.md")
        json_path = os.path.join(output_dir, f"{base_name}.json")

        markdown_text = ""
        json_data = None
        page_count = 0
        title = None
        author = None

        if os.path.isfile(md_path):
            with open(md_path, "r", encoding="utf-8") as f:
                markdown_text = f.read()

        if os.path.isfile(json_path):
            with open(json_path, "r", encoding="utf-8") as f:
                json_data = json.load(f)
                page_count = json_data.get("number of pages", 0)
                title = json_data.get("title")
                author = json_data.get("author")

        return {
            "markdown": markdown_text,
            "json_data": json_data,
            "page_count": page_count,
            "title": title,
            "author": author,
        }


def _extract_pdf_fallback(data: bytes, filename: str) -> Tuple[str, int]:
    """Fallback PDF extraction using pypdf when opendataloader is unavailable."""
    try:
        import pypdf  # type: ignore

        reader = pypdf.PdfReader(io.BytesIO(data))
        pages = []
        for i, page in enumerate(reader.pages):
            page_text = page.extract_text() or ""
            if page_text.strip():
                pages.append(f"--- Page {i + 1} ---\n{page_text}")

        if pages:
            text = "\n\n".join(pages)
            if len(text) > MAX_EXTRACTED_CHARS:
                text = (
                    text[:MAX_EXTRACTED_CHARS]
                    + f"\n\n... [truncated, {len(reader.pages)} pages total]"
                )
            return text, estimate_tokens(text)
        else:
            return (
                f"[PDF '{filename}' contains no extractable text ({len(reader.pages)} pages)]",
                20,
            )

    except ImportError:
        return (
            f"[PDF '{filename}' — {len(data)} bytes. Install opendataloader-pdf or pypdf for text extraction.]",
            30,
        )
    except Exception as e:
        logger.warning(f"Fallback PDF extraction also failed for {filename}: {e}")
        return (
            f"[PDF '{filename}' — {len(data)} bytes. Text extraction failed: {e}]",
            20,
        )
