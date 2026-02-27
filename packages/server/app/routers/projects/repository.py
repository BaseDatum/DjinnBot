"""Repository management endpoints for projects."""

import os
import subprocess
from pathlib import Path
from typing import Optional

import re
import httpx
from fastapi import APIRouter, HTTPException, Depends
from sqlalchemy import select, update
from sqlalchemy.ext.asyncio import AsyncSession

from app.database import get_async_session
from app.models import Project
from app.utils import now_ms
from app.git_utils import (
    validate_git_url,
    normalize_git_url,
    validate_repo_access,
    get_remote_branches,
)
from app.logging_config import get_logger
from app.github_helper import GitHubHelper

from ._common import (
    get_project_or_404,
    _publish_event,
    SetRepositoryRequest,
    ValidateRepositoryRequest,
)

logger = get_logger(__name__)
router = APIRouter()


@router.put("/{project_id}/repository")
async def set_project_repository(
    project_id: str,
    req: SetRepositoryRequest,
    session: AsyncSession = Depends(get_async_session),
):
    """
    Set or update a project's Git repository URL.

    Optionally validates access before saving (default: true).
    Uses GitHub App for private repos when available.
    """
    logger.debug(
        f"Setting repository: project_id={project_id}, url={req.repoUrl}, validate={req.validateAccess}"
    )
    project = await get_project_or_404(session, project_id)

    # Normalize URL
    normalized_url = normalize_git_url(req.repoUrl)
    if not normalized_url:
        raise HTTPException(status_code=400, detail="Invalid repository URL")

    # Validate URL format
    is_valid, error = validate_git_url(normalized_url)
    if not is_valid:
        raise HTTPException(status_code=400, detail=error or "Invalid repository URL")

    # Validate access if requested
    installation_id = None
    if req.validateAccess:
        # Try GitHub App first
        github_info = await _validate_repo_with_github_app(session, normalized_url)
        if github_info:
            if not github_info.get("accessible"):
                raise HTTPException(
                    status_code=400,
                    detail=f"Repository not accessible: {github_info.get('error', 'Unknown error')}",
                )
            installation_id = github_info.get("installationId")
        else:
            # Fall back to git ls-remote
            info = validate_repo_access(normalized_url)
            if not info.accessible:
                raise HTTPException(
                    status_code=400, detail=f"Repository not accessible: {info.error}"
                )

    # Update database
    now = now_ms()
    project.repository = normalized_url
    project.updated_at = now

    # Also update project_github if we have installation info
    if installation_id:
        match = re.search(r"github\.com[/:]([^/]+)/([^/\.]+)", normalized_url)
        if match:
            from app.models.github import ProjectGitHub

            owner, repo_name = match.groups()
            repo_name = repo_name.replace(".git", "")

            gh_record = ProjectGitHub(
                id=f"gh_{owner}_{repo_name}".lower(),
                project_id=project_id,
                installation_id=installation_id,
                repo_owner=owner,
                repo_name=repo_name,
                repo_full_name=f"{owner}/{repo_name}",
                default_branch="main",
                connected_at=int(now / 1000),
                is_active=True,
            )
            session.add(gh_record)

    await session.commit()

    await _publish_event(
        "PROJECT_REPOSITORY_UPDATED",
        {
            "projectId": project_id,
            "repoUrl": normalized_url,
            "installationId": installation_id,
        },
    )

    # Auto-clone the repository in the background so the workspace is ready
    # for the first pipeline run.  This replaces the manual "Clone Now" step.
    clone_result = None
    clone_error = None
    try:
        clone_result = await _auto_clone_repository(
            project_id, normalized_url, installation_id, session
        )
    except Exception as e:
        clone_error = str(e)
        logger.warning(
            "Auto-clone failed for project %s (non-fatal): %s",
            project_id,
            clone_error,
        )

    return {
        "status": "updated",
        "repoUrl": normalized_url,
        "validated": req.validateAccess,
        "installationId": installation_id,
        "cloned": clone_result is not None,
        "cloneResult": clone_result,
        "cloneError": clone_error,
    }


@router.delete("/{project_id}/repository")
async def remove_project_repository(
    project_id: str, session: AsyncSession = Depends(get_async_session)
):
    """
    Remove repository association from a project.

    Does NOT delete the cloned repository files (use workspace cleanup for that).
    """
    project = await get_project_or_404(session, project_id)

    now = now_ms()
    project.repository = None
    project.updated_at = now
    await session.commit()

    await _publish_event("PROJECT_REPOSITORY_REMOVED", {"projectId": project_id})

    return {"status": "removed"}


@router.get("/{project_id}/repository/status")
async def get_project_repository_status(
    project_id: str, session: AsyncSession = Depends(get_async_session)
):
    """
    Check if the project's repository is accessible.

    Returns:
        - Repository URL
        - Accessibility status
        - Default branch
        - Latest commit
        - List of branches (up to 10)
        - Error message if not accessible
    """
    project = await get_project_or_404(session, project_id)

    repo_url = project.repository
    if not repo_url:
        raise HTTPException(
            status_code=404, detail="No repository configured for this project"
        )

    # Try GitHub App first, fall back to git ls-remote
    info = await _validate_repo_with_github_app(session, repo_url)
    if info is None:
        # Fall back to standard git validation
        info = validate_repo_access(repo_url)
        branches = get_remote_branches(repo_url, limit=10) if info.accessible else []
    else:
        branches = info.get("branches", [])

    return {
        "url": repo_url,
        "accessible": info.accessible
        if hasattr(info, "accessible")
        else info.get("accessible", False),
        "defaultBranch": info.default_branch
        if hasattr(info, "default_branch")
        else info.get("defaultBranch"),
        "latestCommit": info.latest_commit
        if hasattr(info, "latest_commit")
        else info.get("latestCommit"),
        "branches": branches,
        "error": info.error if hasattr(info, "error") else info.get("error"),
    }


@router.post("/{project_id}/repository/status")
async def validate_repository_url(
    project_id: str,
    req: ValidateRepositoryRequest,
    session: AsyncSession = Depends(get_async_session),
):
    """
    Validate a repository URL before saving it.

    Tests connectivity using GitHub App (if applicable) or git ls-remote.
    """
    logger.debug(
        f"Validating repository URL: project_id={project_id}, url={req.repoUrl}"
    )
    await get_project_or_404(session, project_id)  # Verify project exists

    # Normalize URL
    normalized_url = normalize_git_url(req.repoUrl)
    if not normalized_url:
        raise HTTPException(status_code=400, detail="Invalid repository URL format")

    # Validate URL format
    is_valid, error = validate_git_url(normalized_url)
    if not is_valid:
        raise HTTPException(status_code=400, detail=error or "Invalid repository URL")

    # Try GitHub App first, fall back to git ls-remote
    info = await _validate_repo_with_github_app(session, normalized_url)
    if info is None:
        # Fall back to standard git validation
        git_info = validate_repo_access(normalized_url)
        branches = (
            get_remote_branches(normalized_url, limit=10) if git_info.accessible else []
        )
        return {
            "url": normalized_url,
            "accessible": git_info.accessible,
            "defaultBranch": git_info.default_branch,
            "latestCommit": git_info.latest_commit,
            "branches": branches,
            "error": git_info.error,
        }

    return info


async def _validate_repo_with_github_app(
    session: AsyncSession, repo_url: str
) -> dict | None:
    """
    Validate repository access using GitHub App if it's a GitHub repo.

    Returns dict with repo info or None if not a GitHub repo / no app configured.
    """
    logger.debug(f"Validating repo with GitHub App: url={repo_url}")

    # Check if it's a GitHub URL
    if "github.com" not in repo_url:
        return None

    # Parse owner/repo from URL
    match = re.search(r"github\.com[/:]([^/]+)/([^/\.]+)", repo_url)
    if not match:
        return None

    owner, repo_name = match.groups()
    repo_name = repo_name.replace(".git", "")

    # Try to get GitHub App installation for this repo
    try:
        helper = GitHubHelper()

        if not helper.app_id:
            return None  # GitHub App not configured

        # Get all installations
        jwt_token = helper.generate_jwt()

        async with httpx.AsyncClient() as http:
            # List installations
            resp = await http.get(
                "https://api.github.com/app/installations",
                headers={
                    "Authorization": f"Bearer {jwt_token}",
                    "Accept": "application/vnd.github+json",
                    "X-GitHub-Api-Version": "2022-11-28",
                },
            )

            if resp.status_code != 200:
                return None

            installations = resp.json()

            for install in installations:
                # Get token for this installation
                token_resp = await http.post(
                    f"https://api.github.com/app/installations/{install['id']}/access_tokens",
                    headers={
                        "Authorization": f"Bearer {jwt_token}",
                        "Accept": "application/vnd.github+json",
                        "X-GitHub-Api-Version": "2022-11-28",
                    },
                )

                if token_resp.status_code != 201:
                    continue

                token = token_resp.json()["token"]
                headers = {
                    "Authorization": f"Bearer {token}",
                    "Accept": "application/vnd.github+json",
                    "X-GitHub-Api-Version": "2022-11-28",
                }

                # Try to access the repo with this installation
                repo_resp = await http.get(
                    f"https://api.github.com/repos/{owner}/{repo_name}", headers=headers
                )

                if repo_resp.status_code == 200:
                    repo_data = repo_resp.json()

                    # Get branches
                    branches_resp = await http.get(
                        f"https://api.github.com/repos/{owner}/{repo_name}/branches?per_page=10",
                        headers=headers,
                    )
                    branches = []
                    if branches_resp.status_code == 200:
                        for b in branches_resp.json():
                            branches.append(
                                {"name": b["name"], "commit": b["commit"]["sha"][:8]}
                            )

                    return {
                        "url": repo_url,
                        "accessible": True,
                        "defaultBranch": repo_data.get("default_branch", "main"),
                        "latestCommit": repo_data.get("pushed_at"),
                        "branches": branches,
                        "error": None,
                        "githubApp": True,
                        "installationId": install["id"],
                    }

        return None  # No installation has access
    except Exception as e:
        # Log but don't fail - fall back to git
        logger.debug(f"GitHub App validation failed, falling back: {e}")
        return None


@router.post("/{project_id}/repository/clone")
async def clone_project_repository(
    project_id: str, session: AsyncSession = Depends(get_async_session)
):
    """
    Clone the project's repository to create the workspace.

    This must be called after setting the repository URL to prepare the workspace
    for running tasks. The clone uses GitHub App authentication when available.

    Returns:
        - workspace_path: Path where the repository was cloned
        - branch: Default branch of the repository
        - commit: Latest commit hash
    """
    logger.debug(f"Cloning repository: project_id={project_id}")

    project = await get_project_or_404(session, project_id)

    repo_url = project.repository
    if not repo_url:
        raise HTTPException(
            status_code=400,
            detail="No repository configured for this project. Set a repository URL first.",
        )

    # Determine workspace path
    workspaces_dir = os.getenv("WORKSPACES_DIR", "/jfs/workspaces")
    workspace_path = os.path.join(workspaces_dir, project_id)

    # Check if already cloned
    if os.path.exists(os.path.join(workspace_path, ".git")):
        # Already cloned - pull latest
        try:
            subprocess.run(
                ["git", "pull", "--ff-only"],
                cwd=workspace_path,
                capture_output=True,
                timeout=60,
                check=False,
            )

            # Get branch and commit info
            branch = subprocess.run(
                ["git", "rev-parse", "--abbrev-ref", "HEAD"],
                cwd=workspace_path,
                capture_output=True,
                text=True,
            ).stdout.strip()

            commit = subprocess.run(
                ["git", "rev-parse", "HEAD"],
                cwd=workspace_path,
                capture_output=True,
                text=True,
            ).stdout.strip()

            return {
                "status": "updated",
                "workspace_path": workspace_path,
                "branch": branch,
                "commit": commit[:8],
            }
        except Exception as e:
            raise HTTPException(
                status_code=500, detail=f"Failed to update repository: {str(e)}"
            )

    # Clone the repository
    os.makedirs(workspace_path, exist_ok=True)

    # Try to get GitHub App token for authentication
    clone_url = repo_url
    try:
        github_info = await _validate_repo_with_github_app(session, repo_url)
        if github_info and github_info.get("accessible"):
            # Get fresh token for clone
            helper = GitHubHelper()
            installation_id = github_info.get("installationId")
            if installation_id:
                token, _ = await helper.get_installation_token(installation_id)
                # Build authenticated URL
                match = re.search(r"github\.com[/:]([^/]+)/([^/\.]+)", repo_url)
                if match:
                    owner, repo_name = match.groups()
                    repo_name = repo_name.replace(".git", "")
                    clone_url = f"https://x-access-token:{token}@github.com/{owner}/{repo_name}.git"
    except Exception as e:
        logger.warning(f"Failed to get GitHub App token, falling back to URL: {e}")

    try:
        # Remove the empty directory we created
        import shutil

        if os.path.exists(workspace_path):
            shutil.rmtree(workspace_path)

        result = subprocess.run(
            ["git", "clone", clone_url, workspace_path],
            capture_output=True,
            text=True,
            timeout=120,
            env={**os.environ, "GIT_TERMINAL_PROMPT": "0"},
        )

        if result.returncode != 0:
            raise HTTPException(
                status_code=500,
                detail=f"Clone failed: {result.stderr or result.stdout}",
            )

        # Get branch and commit info
        branch = subprocess.run(
            ["git", "rev-parse", "--abbrev-ref", "HEAD"],
            cwd=workspace_path,
            capture_output=True,
            text=True,
        ).stdout.strip()

        commit = subprocess.run(
            ["git", "rev-parse", "HEAD"],
            cwd=workspace_path,
            capture_output=True,
            text=True,
        ).stdout.strip()

        return {
            "status": "cloned",
            "workspace_path": workspace_path,
            "branch": branch,
            "commit": commit[:8],
        }

    except subprocess.TimeoutExpired:
        raise HTTPException(status_code=500, detail="Clone timed out")
    except Exception as e:
        # Cleanup on failure
        if os.path.exists(workspace_path):
            import shutil

            shutil.rmtree(workspace_path, ignore_errors=True)
        raise HTTPException(status_code=500, detail=f"Clone failed: {str(e)}")


async def _auto_clone_repository(
    project_id: str,
    repo_url: str,
    installation_id: int | None,
    session: AsyncSession,
) -> dict | None:
    """Clone a repository immediately after the URL is saved.

    This is called inline from the PUT /repository endpoint so that
    the workspace is ready for the first pipeline execution without
    the user needing to click "Clone Now" separately.

    Returns clone info dict on success, or None if already cloned.
    Raises on failure (caller should catch and treat as non-fatal).
    """
    import shutil

    workspaces_dir = os.getenv("WORKSPACES_DIR", "/jfs/workspaces")
    workspace_path = os.path.join(workspaces_dir, project_id)

    # Already cloned — pull latest instead
    if os.path.exists(os.path.join(workspace_path, ".git")):
        logger.debug("Auto-clone: workspace already exists for %s, pulling", project_id)
        try:
            subprocess.run(
                ["git", "pull", "--ff-only"],
                cwd=workspace_path,
                capture_output=True,
                timeout=60,
                check=False,
            )
        except Exception:
            pass  # Non-fatal
        return None  # Already cloned

    # Build authenticated clone URL
    clone_url = repo_url
    if installation_id:
        try:
            helper = GitHubHelper()
            token, _ = await helper.get_installation_token(installation_id)
            match = re.search(r"github\.com[/:]([^/]+)/([^/\.]+)", repo_url)
            if match:
                owner, repo_name = match.groups()
                repo_name = repo_name.replace(".git", "")
                clone_url = (
                    f"https://x-access-token:{token}@github.com/{owner}/{repo_name}.git"
                )
        except Exception as e:
            logger.warning(
                "Auto-clone: GitHub App token failed, trying plain URL: %s", e
            )
    else:
        # Try to discover GitHub App installation for this repo
        try:
            github_info = await _validate_repo_with_github_app(session, repo_url)
            if github_info and github_info.get("accessible"):
                inst_id = github_info.get("installationId")
                if inst_id:
                    helper = GitHubHelper()
                    token, _ = await helper.get_installation_token(inst_id)
                    match = re.search(r"github\.com[/:]([^/]+)/([^/\.]+)", repo_url)
                    if match:
                        owner, repo_name = match.groups()
                        repo_name = repo_name.replace(".git", "")
                        clone_url = f"https://x-access-token:{token}@github.com/{owner}/{repo_name}.git"
        except Exception as e:
            logger.debug("Auto-clone: GitHub App discovery failed: %s", e)

    # Ensure parent dir exists, remove any partial leftovers
    if os.path.exists(workspace_path):
        shutil.rmtree(workspace_path)

    result = subprocess.run(
        ["git", "clone", clone_url, workspace_path],
        capture_output=True,
        text=True,
        timeout=120,
        env={**os.environ, "GIT_TERMINAL_PROMPT": "0"},
    )

    if result.returncode != 0:
        # Cleanup on failure
        if os.path.exists(workspace_path):
            shutil.rmtree(workspace_path, ignore_errors=True)
        raise RuntimeError(f"git clone failed: {result.stderr or result.stdout}")

    branch = subprocess.run(
        ["git", "rev-parse", "--abbrev-ref", "HEAD"],
        cwd=workspace_path,
        capture_output=True,
        text=True,
    ).stdout.strip()

    commit = subprocess.run(
        ["git", "rev-parse", "HEAD"],
        cwd=workspace_path,
        capture_output=True,
        text=True,
    ).stdout.strip()

    logger.info(
        "Auto-clone succeeded for project %s: branch=%s commit=%s",
        project_id,
        branch,
        commit[:8],
    )

    return {"status": "cloned", "branch": branch, "commit": commit[:8]}
