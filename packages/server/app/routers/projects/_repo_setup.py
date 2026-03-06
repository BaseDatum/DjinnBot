"""Shared repository setup logic for project creation.

Consolidates clone + code-graph-index triggering into a single helper
that can be called from:
  - POST /v1/projects/             (direct project creation)
  - POST /onboarding/sessions/{id}/finalize  (onboarding finalization)
  - PUT  /v1/projects/{id}/repository        (repository link/update)

The function is intentionally non-fatal: callers catch exceptions and
treat failures as warnings so that project creation always succeeds
even if the workspace setup has issues.
"""

import json
import os
import re
import uuid

from sqlalchemy.ext.asyncio import AsyncSession

from app import dependencies
from app.github_helper import GitHubHelper
from app.logging_config import get_logger
from app.utils import now_ms, gen_id

logger = get_logger(__name__)


class RepoSetupResult:
    """Result of the automated repository setup."""

    __slots__ = (
        "cloned",
        "clone_error",
        "already_cloned",
        "branch",
        "commit",
        "installation_id",
        "index_triggered",
        "index_job_id",
    )

    def __init__(self) -> None:
        self.cloned: bool = False
        self.clone_error: str | None = None
        self.already_cloned: bool = False
        self.branch: str | None = None
        self.commit: str | None = None
        self.installation_id: int | None = None
        self.index_triggered: bool = False
        self.index_job_id: str | None = None

    def to_dict(self) -> dict:
        return {
            "cloned": self.cloned,
            "clone_error": self.clone_error,
            "already_cloned": self.already_cloned,
            "branch": self.branch,
            "commit": self.commit,
            "installation_id": self.installation_id,
            "index_triggered": self.index_triggered,
            "index_job_id": self.index_job_id,
        }


async def setup_project_repository(
    project_id: str,
    repo_url: str,
    session: AsyncSession,
    *,
    installation_id: int | None = None,
    trigger_index: bool = True,
    save_github_connection: bool = True,
) -> RepoSetupResult:
    """Clone a project's repository and kick off code-graph indexing.

    This is the single entry-point for workspace setup at project creation
    time.  It orchestrates:

      1. Discover / validate GitHub App access (for private repos)
      2. Persist the ProjectGitHub record if applicable
      3. Clone the repository into WORKSPACES_DIR/{project_id}
      4. Publish CODE_GRAPH_INDEX_REQUESTED so the engine indexes it

    Parameters
    ----------
    project_id : str
        The project to set up.
    repo_url : str
        Normalized HTTPS repository URL.
    session : AsyncSession
        Active DB session (used to persist ProjectGitHub if needed).
    installation_id : int | None
        Pre-resolved GitHub App installation ID.  When ``None`` the
        function auto-discovers it via the GitHub App.
    trigger_index : bool
        Whether to fire the code-graph indexing event after a
        successful clone.  Default ``True``.
    save_github_connection : bool
        Whether to create/update the ProjectGitHub record when a
        GitHub App installation is found.  Default ``True``.

    Returns
    -------
    RepoSetupResult
        Dataclass-like object with clone/index status.

    Raises
    ------
    Does NOT raise — all errors are captured in the result object so
    the caller can decide how to surface them.
    """
    result = RepoSetupResult()

    # ── 1. Resolve GitHub App installation (private repo auth) ─────────
    if not installation_id:
        installation_id = await _discover_installation(session, repo_url)

    result.installation_id = installation_id

    # ── 2. Persist ProjectGitHub record ────────────────────────────────
    if save_github_connection and installation_id:
        try:
            await _save_github_connection(
                session, project_id, repo_url, installation_id
            )
        except Exception as exc:
            logger.warning(
                "setup_project_repository: failed to save GitHub connection "
                "for %s (non-fatal): %s",
                project_id,
                exc,
            )

    # ── 3. Clone the repository ────────────────────────────────────────
    try:
        clone_info = await _clone_repository(
            project_id, repo_url, installation_id, session
        )
        if clone_info is None:
            result.already_cloned = True
        else:
            result.cloned = True
            result.branch = clone_info.get("branch")
            result.commit = clone_info.get("commit")
    except Exception as exc:
        result.clone_error = str(exc)
        logger.warning(
            "setup_project_repository: clone failed for %s (non-fatal): %s",
            project_id,
            exc,
        )
        # Don't try to index if clone failed
        return result

    # ── 4. Trigger code-graph indexing ─────────────────────────────────
    if trigger_index:
        try:
            job_id = await _trigger_code_graph_index(project_id, session)
            result.index_triggered = True
            result.index_job_id = job_id
        except Exception as exc:
            logger.warning(
                "setup_project_repository: index trigger failed for %s (non-fatal): %s",
                project_id,
                exc,
            )

    return result


# ── Internal helpers ──────────────────────────────────────────────────────


async def _discover_installation(session: AsyncSession, repo_url: str) -> int | None:
    """Try to find a GitHub App installation that can access *repo_url*.

    Reuses the same logic as ``repository._validate_repo_with_github_app``
    but only returns the installation ID (no full validation payload).
    """
    # Inline import to avoid circular dependency — the function lives in
    # the repository sub-module which is a sibling.
    from .repository import _validate_repo_with_github_app

    try:
        info = await _validate_repo_with_github_app(session, repo_url)
        if info and info.get("accessible"):
            return info.get("installationId")
    except Exception as exc:
        logger.debug("_discover_installation failed: %s", exc)

    return None


async def _save_github_connection(
    session: AsyncSession,
    project_id: str,
    repo_url: str,
    installation_id: int,
) -> None:
    """Create or update a ProjectGitHub record linking project to installation."""
    match = re.search(r"github\.com[/:]([^/]+)/([^/\.]+)", repo_url)
    if not match:
        return

    owner, repo_name = match.groups()
    repo_name = repo_name.replace(".git", "")

    from app.models.github import ProjectGitHub

    # Check if record already exists
    from sqlalchemy import select

    existing = await session.execute(
        select(ProjectGitHub).where(ProjectGitHub.project_id == project_id)
    )
    if existing.scalar_one_or_none():
        return  # Already linked

    gh_record = ProjectGitHub(
        id=f"gh_{owner}_{repo_name}".lower(),
        project_id=project_id,
        installation_id=installation_id,
        repo_owner=owner,
        repo_name=repo_name,
        repo_full_name=f"{owner}/{repo_name}",
        default_branch="main",
        connected_at=int(now_ms() / 1000),
        is_active=True,
    )
    session.add(gh_record)
    await session.flush()


async def _clone_repository(
    project_id: str,
    repo_url: str,
    installation_id: int | None,
    session: AsyncSession,
) -> dict | None:
    """Clone the repository into the project workspace.

    Delegates to the existing ``_auto_clone_repository`` in
    ``repository.py`` which already handles GitHub App auth,
    env-based tokens, and public-repo fallback.

    Returns clone info dict on success, None if already cloned.
    """
    from .repository import _auto_clone_repository

    return await _auto_clone_repository(project_id, repo_url, installation_id, session)


async def _trigger_code_graph_index(
    project_id: str,
    session: AsyncSession,
) -> str | None:
    """Publish a CODE_GRAPH_INDEX_REQUESTED event to Redis.

    The Node.js engine picks this up and runs the Tree-sitter indexing
    pipeline.  Also creates/updates the CodeGraphIndex DB record so the
    status endpoint shows "indexing".

    Returns the job_id for progress polling, or None if Redis unavailable.
    """
    if not dependencies.redis_client:
        logger.warning("_trigger_code_graph_index: Redis not available, skipping")
        return None

    # Create / update the CodeGraphIndex record
    from app.models.code_graph import CodeGraphIndex
    from sqlalchemy import select

    result = await session.execute(
        select(CodeGraphIndex).where(CodeGraphIndex.project_id == project_id)
    )
    index = result.scalar_one_or_none()
    now = now_ms()

    if index:
        if index.status == "indexing":
            logger.debug(
                "_trigger_code_graph_index: already indexing for %s",
                project_id,
            )
            return None  # Don't double-trigger
        index.status = "indexing"
        index.error = None
        index.updated_at = now
    else:
        index = CodeGraphIndex(
            id=gen_id("cgi_"),
            project_id=project_id,
            status="indexing",
            created_at=now,
            updated_at=now,
        )
        session.add(index)

    await session.flush()

    # Publish event for the engine
    job_id = str(uuid.uuid4())[:8]
    event = {
        "type": "CODE_GRAPH_INDEX_REQUESTED",
        "projectId": project_id,
        "jobId": job_id,
        "force": False,
        "timestamp": now,
    }
    await dependencies.redis_client.xadd(
        "djinnbot:events:global", {"data": json.dumps(event)}
    )

    logger.info(
        "Triggered code-graph indexing for project %s (job %s)",
        project_id,
        job_id,
    )

    # Start the background polling task that updates the DB when the
    # engine finishes.  This reuses the existing _run_indexing helper
    # from knowledge_graph.py but runs it in a fire-and-forget asyncio
    # task instead of a FastAPI BackgroundTasks (since we're not inside
    # a request handler in all call sites).
    #
    # skip_publish=True because we already published the event above.
    import asyncio
    from .knowledge_graph import _run_indexing

    asyncio.create_task(
        _run_indexing(project_id, job_id, force=False, skip_publish=True),
        name=f"code-graph-index-{project_id}",
    )

    return job_id
