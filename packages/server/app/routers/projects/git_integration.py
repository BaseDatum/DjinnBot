"""Git-specific project endpoints — branch management, workspaces, and PRs.

These endpoints are only available for projects with a repository configured.
Non-git projects will receive a 400 error explaining that git integration
is not enabled for the project.

Extracted from execution.py during the modular workflow redesign.
"""

import asyncio
import json
import re
from typing import Optional

from fastapi import APIRouter, HTTPException, Depends, Query
from pydantic import BaseModel
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.database import get_async_session
from app.models import Project, Task
from app import dependencies
from app.utils import now_ms
from app.logging_config import get_logger
from app.github_helper import github_helper
from ._common import get_project_or_404, get_task_or_404, _publish_event

logger = get_logger(__name__)
router = APIRouter()


# ══════════════════════════════════════════════════════════════════════════
# GUARD: Ensure project has git integration
# ══════════════════════════════════════════════════════════════════════════


async def _require_git_project(session: AsyncSession, project_id: str) -> Project:
    """Get project and verify it has a repository configured."""
    project = await get_project_or_404(session, project_id)
    if not project.repository:
        raise HTTPException(
            status_code=400,
            detail=(
                "Git integration is not enabled for this project. "
                "Set a repository URL first via PUT /projects/{id} or the dashboard."
            ),
        )
    return project


# ══════════════════════════════════════════════════════════════════════════
# BRANCH HELPERS
# ══════════════════════════════════════════════════════════════════════════


def _task_branch_name(task_id: str, task_title: str) -> str:
    """Generate a stable, filesystem-safe git branch name for a task.

    Format: feat/{task_id}-{slug}
    Example: feat/task_abc123-implement-oauth-login
    """
    slug = re.sub(r"[^a-z0-9]+", "-", task_title.lower()).strip("-")[:40]
    return f"feat/{task_id}-{slug}" if slug else f"feat/{task_id}"


def _get_task_branch(task: Task) -> Optional[str]:
    """Read the stored git branch from task metadata."""
    try:
        meta = json.loads(task.task_metadata) if task.task_metadata else {}
        return meta.get("git_branch")
    except (json.JSONDecodeError, TypeError):
        return None


def _set_task_branch(task: Task, branch: str) -> None:
    """Write git branch into task metadata (in-place, does not commit)."""
    try:
        meta = json.loads(task.task_metadata) if task.task_metadata else {}
    except (json.JSONDecodeError, TypeError):
        meta = {}
    meta["git_branch"] = branch
    task.task_metadata = json.dumps(meta)


# ══════════════════════════════════════════════════════════════════════════
# TASK BRANCH — Get or create the persistent git branch for a task
# ══════════════════════════════════════════════════════════════════════════


@router.get("/{project_id}/tasks/{task_id}/branch")
async def get_task_branch(
    project_id: str,
    task_id: str,
    session: AsyncSession = Depends(get_async_session),
):
    """Get the persistent git branch name for a task.

    Creates and stores the branch name in task metadata if it doesn't exist yet.
    The branch follows the naming convention: feat/{task_id}-{slug}

    Requires the project to have a repository configured.
    """
    await _require_git_project(session, project_id)
    task = await get_task_or_404(session, project_id, task_id)
    now = now_ms()

    branch = _get_task_branch(task)
    created = False

    if not branch:
        branch = _task_branch_name(task.id, task.title)
        _set_task_branch(task, branch)
        task.updated_at = now
        await session.commit()
        created = True
        logger.debug(f"Created branch name for task {task_id}: {branch}")

    return {
        "task_id": task_id,
        "project_id": project_id,
        "branch": branch,
        "created": created,
    }


# ══════════════════════════════════════════════════════════════════════════
# TASK WORKSPACE — Create / remove a persistent worktree in agent's sandbox
# ══════════════════════════════════════════════════════════════════════════


class TaskWorkspaceRequest(BaseModel):
    agentId: str  # Agent that will own the worktree


@router.post("/{project_id}/tasks/{task_id}/workspace")
async def create_task_workspace(
    project_id: str,
    task_id: str,
    req: TaskWorkspaceRequest,
    session: AsyncSession = Depends(get_async_session),
):
    """Create a persistent git worktree for a task in the agent's sandbox.

    Requires the project to have a repository configured.
    """
    await _require_git_project(session, project_id)
    task = await get_task_or_404(session, project_id, task_id)

    branch = _get_task_branch(task)
    if not branch:
        branch = _task_branch_name(task.id, task.title)
        _set_task_branch(task, branch)
        task.updated_at = now_ms()
        await session.commit()

    if not dependencies.redis_client:
        raise HTTPException(status_code=503, detail="Redis not available")

    # Clear any stale result key
    result_key = f"djinnbot:workspace:{req.agentId}:{task_id}"
    await dependencies.redis_client.delete(result_key)

    # Ask the engine to create the worktree
    await _publish_event(
        "TASK_WORKSPACE_REQUESTED",
        {
            "agentId": req.agentId,
            "projectId": project_id,
            "taskId": task_id,
            "taskBranch": branch,
        },
    )

    # Poll for result (engine is async — usually < 5 s for a local fetch+worktree)
    for _ in range(60):  # 60 × 0.5 s = 30 s max
        await asyncio.sleep(0.5)
        raw = await dependencies.redis_client.get(result_key)
        if raw:
            result = json.loads(raw)
            if not result.get("success"):
                raise HTTPException(
                    status_code=500,
                    detail=f"Engine failed to create task workspace: {result.get('error', 'unknown')}",
                )
            container_path = f"/home/agent/task-workspaces/{task_id}"
            return {
                "status": "ready",
                "task_id": task_id,
                "agent_id": req.agentId,
                "branch": result["branch"],
                "worktree_path": container_path,
                "already_existed": result.get("alreadyExists", False),
            }

    raise HTTPException(
        status_code=504,
        detail="Timed out waiting for engine to create task workspace (30 s)",
    )


@router.delete("/{project_id}/tasks/{task_id}/workspace")
async def remove_task_workspace(
    project_id: str,
    task_id: str,
    agent_id: str = Query(..., description="Agent ID whose workspace to remove"),
):
    """Remove a task worktree from an agent's sandbox."""
    if not dependencies.redis_client:
        raise HTTPException(status_code=503, detail="Redis not available")

    await _publish_event(
        "TASK_WORKSPACE_REMOVE_REQUESTED",
        {
            "agentId": agent_id,
            "projectId": project_id,
            "taskId": task_id,
        },
    )
    return {"status": "remove_requested", "task_id": task_id, "agent_id": agent_id}


# ══════════════════════════════════════════════════════════════════════════
# PULL REQUEST — Open a PR for a task branch
# ══════════════════════════════════════════════════════════════════════════


class OpenPullRequestRequest(BaseModel):
    agentId: str
    title: str
    body: Optional[str] = ""
    draft: Optional[bool] = False
    base_branch: Optional[str] = "main"


@router.post("/{project_id}/tasks/{task_id}/pull-request")
async def open_task_pull_request(
    project_id: str,
    task_id: str,
    req: OpenPullRequestRequest,
    session: AsyncSession = Depends(get_async_session),
):
    """Open a GitHub pull request for a task's feature branch.

    Requires the project to have a repository and GitHub App configured.
    """
    await _require_git_project(session, project_id)
    task = await get_task_or_404(session, project_id, task_id)

    branch = _get_task_branch(task)
    if not branch:
        branch = _task_branch_name(task.id, task.title)
        _set_task_branch(task, branch)

    try:
        result = await github_helper.create_pull_request(
            project_id=project_id,
            head_branch=branch,
            base_branch=req.base_branch or "main",
            title=req.title,
            body=req.body or "",
            draft=req.draft or False,
        )
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Failed to create PR: {e}")

    # Persist PR URL in task metadata
    try:
        meta = json.loads(task.task_metadata) if task.task_metadata else {}
    except (json.JSONDecodeError, TypeError):
        meta = {}
    meta["pr_url"] = result["pr_url"]
    meta["pr_number"] = result["pr_number"]
    task.task_metadata = json.dumps(meta)
    task.updated_at = now_ms()
    await session.commit()

    await _publish_event(
        "TASK_PR_OPENED",
        {
            "projectId": project_id,
            "taskId": task_id,
            "agentId": req.agentId,
            "prNumber": result["pr_number"],
            "prUrl": result["pr_url"],
            "branch": branch,
        },
    )

    logger.debug(
        "PR #%d opened for task %s by %s", result["pr_number"], task_id, req.agentId
    )
    return {
        "pr_number": result["pr_number"],
        "pr_url": result["pr_url"],
        "title": result["title"],
        "draft": result["draft"],
        "branch": branch,
    }


# ══════════════════════════════════════════════════════════════════════════
# PR STATUS — Check the state of a task's pull request
# ══════════════════════════════════════════════════════════════════════════


@router.get("/{project_id}/tasks/{task_id}/pr-status")
async def get_task_pr_status(
    project_id: str,
    task_id: str,
    session: AsyncSession = Depends(get_async_session),
):
    """Get the PR status for a task's feature branch.

    Requires the project to have a repository and GitHub App configured.
    Returns 404 if no PR is associated with this task.
    """
    await _require_git_project(session, project_id)
    task = await get_task_or_404(session, project_id, task_id)

    # Read PR metadata
    try:
        meta = json.loads(task.task_metadata) if task.task_metadata else {}
    except (json.JSONDecodeError, TypeError):
        meta = {}

    pr_number = meta.get("pr_number")
    if not pr_number:
        raise HTTPException(status_code=404, detail="No PR associated with this task")

    # Fetch PR details from GitHub
    try:
        connection = await github_helper.get_project_github(project_id)
        if not connection:
            raise HTTPException(
                status_code=400, detail="Project not connected to GitHub"
            )

        installation_id = connection["installation_id"]
        owner = connection["repo_owner"]
        repo = connection["repo_name"]

        import httpx

        token, _expires_at = await github_helper.get_installation_token(installation_id)
        headers = {
            "Authorization": f"Bearer {token}",
            "Accept": "application/vnd.github+json",
            "X-GitHub-Api-Version": "2022-11-28",
        }

        async with httpx.AsyncClient() as client:
            # Fetch PR
            pr_resp = await client.get(
                f"https://api.github.com/repos/{owner}/{repo}/pulls/{pr_number}",
                headers=headers,
                timeout=15.0,
            )
            if pr_resp.status_code == 404:
                raise HTTPException(
                    status_code=404,
                    detail=f"PR #{pr_number} not found on GitHub",
                )
            pr_resp.raise_for_status()
            pr_data = pr_resp.json()

            # Fetch reviews
            reviews_resp = await client.get(
                f"https://api.github.com/repos/{owner}/{repo}/pulls/{pr_number}/reviews",
                headers=headers,
                timeout=15.0,
            )
            reviews_data = (
                reviews_resp.json() if reviews_resp.status_code == 200 else []
            )

            # Fetch check runs for the head SHA
            head_sha = pr_data.get("head", {}).get("sha", "")
            checks_data = []
            if head_sha:
                checks_resp = await client.get(
                    f"https://api.github.com/repos/{owner}/{repo}/commits/{head_sha}/check-runs",
                    headers=headers,
                    timeout=15.0,
                )
                if checks_resp.status_code == 200:
                    checks_data = checks_resp.json().get("check_runs", [])

        # Build review summary
        review_summary = []
        for review in reviews_data:
            review_summary.append(
                {
                    "user": review.get("user", {}).get("login"),
                    "state": review.get("state"),
                    "submitted_at": review.get("submitted_at"),
                }
            )

        # Build checks summary
        checks_summary = []
        for check in checks_data:
            checks_summary.append(
                {
                    "name": check.get("name"),
                    "status": check.get("status"),
                    "conclusion": check.get("conclusion"),
                }
            )

        # Determine overall CI status
        all_checks_passed = all(
            c.get("conclusion") == "success"
            for c in checks_data
            if c.get("status") == "completed"
        )
        any_checks_pending = any(c.get("status") != "completed" for c in checks_data)
        ci_status = (
            "pending"
            if any_checks_pending
            else ("passing" if all_checks_passed else "failing")
        )
        if not checks_data:
            ci_status = "none"

        return {
            "pr_number": pr_number,
            "pr_url": pr_data.get("html_url"),
            "state": pr_data.get("state"),
            "merged": pr_data.get("merged", False),
            "mergeable": pr_data.get("mergeable"),
            "mergeable_state": pr_data.get("mergeable_state"),
            "draft": pr_data.get("draft", False),
            "title": pr_data.get("title"),
            "head_branch": pr_data.get("head", {}).get("ref"),
            "base_branch": pr_data.get("base", {}).get("ref"),
            "changed_files": pr_data.get("changed_files"),
            "additions": pr_data.get("additions"),
            "deletions": pr_data.get("deletions"),
            "reviews": review_summary,
            "checks": checks_summary,
            "ci_status": ci_status,
            "ready_to_merge": (
                pr_data.get("state") == "open"
                and not pr_data.get("draft", False)
                and pr_data.get("mergeable") is True
                and ci_status == "passing"
                and any(r.get("state") == "APPROVED" for r in reviews_data)
            ),
        }

    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Failed to fetch PR status: {e}", exc_info=True)
        raise HTTPException(status_code=500, detail=f"Failed to fetch PR status: {e}")
