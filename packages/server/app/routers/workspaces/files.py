"""Workspace file browser endpoints."""
import os
from pathlib import Path

from fastapi import APIRouter, HTTPException

from app.logging_config import get_logger
from ._common import RUNS_DIR, _safe_path

logger = get_logger(__name__)
router = APIRouter()


@router.get("/{run_id}")
async def list_workspace_files(run_id: str):
    """List all files in a run's workspace (excluding .git)."""
    logger.debug(f"Listing workspace files for run_id={run_id}")
    
    base = _safe_path(run_id)
    
    files = []
    for root, dirs, filenames in os.walk(base):
        dirs[:] = [d for d in dirs if d != '.git']
        
        for fname in filenames:
            full = Path(root) / fname
            rel = full.relative_to(base)
            stat = full.stat()
            files.append({
                "path": str(rel),
                "size": stat.st_size,
                "modified": int(stat.st_mtime * 1000),
            })
    
    logger.debug(f"Found {len(files)} files in run_id={run_id}")
    return {"run_id": run_id, "files": sorted(files, key=lambda f: f["path"])}


@router.get("/{run_id}/{path:path}")
async def read_workspace_file(run_id: str, path: str):
    """Read a file from the run workspace."""
    logger.debug(f"Reading file path={path} for run_id={run_id}")
    
    file_path = _safe_path(run_id, path)
    
    if not file_path.is_file():
        logger.debug(f"File not found: path={path}")
        raise HTTPException(status_code=404, detail=f"File not found: {path}")
    
    if file_path.stat().st_size > 1_000_000:
        logger.debug(f"File too large: path={path} size > 1MB")
        raise HTTPException(status_code=413, detail="File too large (>1MB)")
    
    try:
        content = file_path.read_text(encoding="utf-8")
    except UnicodeDecodeError:
        logger.debug(f"Binary file attempted: path={path}")
        raise HTTPException(status_code=415, detail="Binary file, cannot display")
    
    return {"path": path, "content": content, "size": len(content)}
