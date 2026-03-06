"""Workspace file browser and git operations.

This module combines workspace sub-routers into a single router for backward compatibility.
The original endpoints are now split across:
- files.py: File listing and reading
- git.py: Git operations (status, history, diff, merge, push)
"""

from fastapi import APIRouter

from .files import router as files_router
from .git import router as git_router

# Create combined router for backward compatibility
router = APIRouter()

# Git router MUST be included before files router.
# files.py has a greedy /{run_id}/{path:path} catch-all that would match
# /run_xxx/git/status before the git router ever sees it if registered first.
router.include_router(git_router)
router.include_router(files_router)

# Re-export for backward compatibility
__all__ = ["router"]
