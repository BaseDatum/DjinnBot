"""File storage service for chat attachments.

Stores uploaded files on the local filesystem under DATA_DIR/uploads/.
Files are organized by session: uploads/{session_id}/{attachment_id}_{filename}

A future iteration can swap this for S3-compatible storage via the
STORAGE_PROVIDER env var without changing the caller interface.
"""

import os
import shutil
from typing import Optional

from app.logging_config import get_logger

logger = get_logger(__name__)

# Root directory for uploads — defaults to ./data/uploads alongside the DB
UPLOAD_DIR = os.path.join(
    os.getenv(
        "DATA_DIR",
        os.path.join(
            os.path.dirname(os.path.dirname(os.path.dirname(__file__))), "data"
        ),
    ),
    "uploads",
)


def _ensure_dir(path: str) -> None:
    os.makedirs(path, exist_ok=True)


def store_file(
    session_id: str,
    attachment_id: str,
    filename: str,
    data: bytes,
) -> str:
    """Write *data* to disk and return the relative storage path."""
    safe_filename = filename.replace("/", "_").replace("\\", "_").replace("..", "_")
    rel_path = os.path.join(session_id, f"{attachment_id}_{safe_filename}")
    abs_path = os.path.join(UPLOAD_DIR, rel_path)
    _ensure_dir(os.path.dirname(abs_path))
    with open(abs_path, "wb") as f:
        f.write(data)
    logger.debug(f"Stored attachment {attachment_id} ({len(data)} bytes) at {rel_path}")
    return rel_path


def read_file(storage_path: str) -> Optional[bytes]:
    """Read a file from storage.  Returns None if missing."""
    abs_path = os.path.join(UPLOAD_DIR, storage_path)
    if not os.path.isfile(abs_path):
        return None
    with open(abs_path, "rb") as f:
        return f.read()


def delete_file(storage_path: str) -> bool:
    """Delete a single file.  Returns True if it existed."""
    abs_path = os.path.join(UPLOAD_DIR, storage_path)
    if os.path.isfile(abs_path):
        os.remove(abs_path)
        return True
    return False


def delete_session_files(session_id: str) -> int:
    """Delete all files for a session.  Returns count of files removed."""
    session_dir = os.path.join(UPLOAD_DIR, session_id)
    if not os.path.isdir(session_dir):
        return 0
    count = sum(1 for _ in os.scandir(session_dir) if _.is_file())
    shutil.rmtree(session_dir, ignore_errors=True)
    return count


def get_absolute_path(storage_path: str) -> str:
    """Resolve a relative storage path to an absolute filesystem path."""
    return os.path.join(UPLOAD_DIR, storage_path)
