"""Shared utilities for workspace routers."""
import os
from pathlib import Path

from fastapi import HTTPException
from app.logging_config import get_logger

logger = get_logger(__name__)

__all__ = ['RUNS_DIR', '_safe_path', '_add_credentials', 'logger']


# Run workspaces are created by SandboxManager at SHARED_RUNS_DIR
# This is where nsjail mounts /workspace/.run for each pipeline run
RUNS_DIR = os.getenv("SHARED_RUNS_DIR", "/data/runs")


def _safe_path(run_id: str, rel_path: str = "") -> Path:
    """Resolve path safely, preventing directory traversal."""
    base = Path(RUNS_DIR) / run_id
    if not base.exists():
        logger.debug(f"Workspace not found: run_id={run_id}, expected path={base}")
        raise HTTPException(
            status_code=404, 
            detail=f"Workspace not found for run {run_id}. "
                   f"The run may still be initializing, or workspace creation failed. "
                   f"Check engine logs for 'Failed to create workspace' errors."
        )
    
    resolved = (base / rel_path).resolve()
    if not str(resolved).startswith(str(base.resolve())):
        raise HTTPException(status_code=403, detail="Path traversal not allowed")
    return resolved


def _add_credentials(repo_url: str) -> str:
    """Add authentication credentials to repository URL."""
    token = os.getenv("GITHUB_TOKEN")
    user = os.getenv("GITHUB_USER", "djinnbot")
    
    if token and repo_url.startswith("https://"):
        return repo_url.replace("https://", f"https://{user}:{token}@")
    
    return repo_url
