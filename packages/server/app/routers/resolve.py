"""Resolve endpoint — GitHub issue URL to pipeline run.

Parses a GitHub issue URL, fetches issue metadata (title, body, labels,
comments), and starts the `resolve` pipeline to analyze, fix, test, and
open a PR.
"""

import re
import json
from typing import Optional

import httpx
from fastapi import APIRouter, HTTPException, Depends, Query
from pydantic import BaseModel
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.database import get_async_session
from app.models.project import Project
from app.models import ProjectGitHub
from app.utils import gen_id, now_ms, validate_pipeline_exists
from app.logging_config import get_logger
from app import dependencies

logger = get_logger(__name__)

router = APIRouter()

# ── Regex for GitHub issue URLs ──────────────────────────────────────────
# Matches: https://github.com/owner/repo/issues/123
#          github.com/owner/repo/issues/123
#          owner/repo#123
GITHUB_ISSUE_URL_RE = re.compile(
    r"(?:https?://)?github\.com/(?P<owner>[^/]+)/(?P<repo>[^/]+)/issues/(?P<number>\d+)"
)
GITHUB_SHORTHAND_RE = re.compile(
    r"^(?P<owner>[^/#]+)/(?P<repo>[^/#]+)#(?P<number>\d+)$"
)


def parse_issue_ref(ref: str) -> dict:
    """Parse a GitHub issue reference into owner, repo, number.

    Accepts:
        https://github.com/owner/repo/issues/123
        github.com/owner/repo/issues/123
        owner/repo#123

    Returns:
        {"owner": str, "repo": str, "number": int}

    Raises:
        ValueError if the reference can't be parsed.
    """
    ref = ref.strip()

    m = GITHUB_ISSUE_URL_RE.search(ref)
    if m:
        return {
            "owner": m.group("owner"),
            "repo": m.group("repo"),
            "number": int(m.group("number")),
        }

    m = GITHUB_SHORTHAND_RE.match(ref)
    if m:
        return {
            "owner": m.group("owner"),
            "repo": m.group("repo"),
            "number": int(m.group("number")),
        }

    raise ValueError(
        f"Cannot parse GitHub issue reference: '{ref}'. "
        "Use https://github.com/owner/repo/issues/123 or owner/repo#123"
    )


async def _fetch_github_issue(
    owner: str, repo: str, number: int, token: Optional[str] = None
) -> dict:
    """Fetch issue data from the GitHub API.

    Tries in order:
    1. GitHub App installation token (via github_helper)
    2. Provided token parameter
    3. GITHUB_TOKEN environment variable
    4. Unauthenticated (rate-limited)

    Returns the raw GitHub API issue response.
    """
    import os

    headers = {
        "Accept": "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
    }

    # Try GitHub App token first
    auth_token = None
    try:
        from app.github_helper import github_helper

        ok, _ = github_helper.is_configured()
        if ok:
            jwt = github_helper.generate_jwt()
            async with httpx.AsyncClient() as client:
                resp = await client.get(
                    f"https://api.github.com/repos/{owner}/{repo}/installation",
                    headers={**headers, "Authorization": f"Bearer {jwt}"},
                )
            if resp.status_code == 200:
                installation_id = resp.json()["id"]
                auth_token, _ = await github_helper.get_installation_token(
                    installation_id
                )
    except Exception as e:
        logger.debug(f"GitHub App token not available: {e}")

    if not auth_token and token:
        auth_token = token
    if not auth_token:
        auth_token = os.getenv("GITHUB_TOKEN")

    if auth_token:
        headers["Authorization"] = f"Bearer {auth_token}"

    async with httpx.AsyncClient() as client:
        # Fetch issue
        resp = await client.get(
            f"https://api.github.com/repos/{owner}/{repo}/issues/{number}",
            headers=headers,
        )
        if resp.status_code == 404:
            raise HTTPException(
                status_code=404,
                detail=f"GitHub issue not found: {owner}/{repo}#{number}",
            )
        if resp.status_code == 403:
            raise HTTPException(
                status_code=403,
                detail="GitHub API rate limit or permission denied. Configure GITHUB_TOKEN or a GitHub App.",
            )
        if resp.status_code != 200:
            raise HTTPException(
                status_code=502,
                detail=f"GitHub API error ({resp.status_code}): {resp.text[:200]}",
            )
        issue = resp.json()

        # Fetch comments (first page, up to 30)
        comments_text = ""
        comments_url = issue.get("comments_url")
        if comments_url and issue.get("comments", 0) > 0:
            try:
                resp_comments = await client.get(
                    comments_url,
                    headers=headers,
                    params={"per_page": 30},
                )
                if resp_comments.status_code == 200:
                    comments = resp_comments.json()
                    parts = []
                    for c in comments:
                        author = c.get("user", {}).get("login", "unknown")
                        body = c.get("body", "").strip()
                        if body:
                            parts.append(f"@{author}: {body}")
                    comments_text = "\n\n---\n\n".join(parts)
            except Exception as e:
                logger.warning(f"Failed to fetch issue comments: {e}")

    return {**issue, "_comments_text": comments_text}


# ── Request / Response Models ────────────────────────────────────────────


class ResolveRequest(BaseModel):
    """Request to resolve a GitHub issue."""

    issue_url: str  # GitHub issue URL or shorthand (owner/repo#123)
    project_id: Optional[str] = None  # Optional: link to existing project
    model: Optional[str] = None  # Optional: override default model
    agent: Optional[str] = None  # Optional: override agent (default: yukihiro)


class ResolveResponse(BaseModel):
    """Response from resolve endpoint."""

    run_id: str
    pipeline_id: str
    issue_number: int
    repo_full_name: str
    issue_title: str
    status: str


# ── Endpoint ─────────────────────────────────────────────────────────────


@router.post("/", response_model=ResolveResponse)
async def resolve_issue(
    req: ResolveRequest,
    session: AsyncSession = Depends(get_async_session),
):
    """Resolve a GitHub issue by starting the resolve pipeline.

    Accepts a GitHub issue URL (or shorthand like owner/repo#123), fetches
    the issue metadata, and starts a pipeline run that will:

    1. ANALYZE — Read the codebase and plan a fix
    2. IMPLEMENT — Write the code, tests, and commit
    3. VALIDATE — Run the test suite and verify
    4. PR — Open a pull request referencing the issue

    If `project_id` is provided and the project is connected to the same
    GitHub repository, the run will use the project's git workspace.
    Otherwise a standalone run is created.
    """
    # Parse the issue reference
    try:
        parsed = parse_issue_ref(req.issue_url)
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))

    owner = parsed["owner"]
    repo = parsed["repo"]
    number = parsed["number"]
    repo_full_name = f"{owner}/{repo}"

    logger.info(f"resolve: starting for {repo_full_name}#{number}")

    # Validate the resolve pipeline exists
    if not validate_pipeline_exists("resolve"):
        raise HTTPException(
            status_code=500,
            detail="resolve pipeline not found. Ensure pipelines/resolve.yml exists.",
        )

    # Fetch issue from GitHub
    issue = await _fetch_github_issue(owner, repo, number)

    issue_title = issue.get("title", f"Issue #{number}")
    issue_body = issue.get("body") or "(no description)"
    issue_author = issue.get("user", {}).get("login", "unknown")
    issue_labels = ", ".join(label.get("name", "") for label in issue.get("labels", []))
    issue_created_at = issue.get("created_at", "")
    issue_comments = issue.get("_comments_text", "")

    # Try to find a matching project for this repo
    project_id = req.project_id
    if not project_id:
        # Auto-discover: find a project connected to this repo
        result = await session.execute(
            select(ProjectGitHub.project_id).where(
                ProjectGitHub.repo_full_name == repo_full_name
            )
        )
        row = result.scalar_one_or_none()
        if row:
            project_id = row
            logger.info(
                f"resolve: auto-matched project {project_id} for {repo_full_name}"
            )

    # Build task description with all issue metadata embedded as template variables
    # The pipeline uses Jinja2 template variables — we embed them in the
    # human_context JSON so the engine can resolve {{issue_number}} etc.
    task_description = f"Resolve GitHub issue {repo_full_name}#{number}: {issue_title}"

    # Context carries the template variables for the pipeline steps
    context = json.dumps(
        {
            "issue_number": str(number),
            "issue_title": issue_title,
            "issue_body": issue_body,
            "issue_author": issue_author,
            "issue_labels": issue_labels or "none",
            "issue_created_at": issue_created_at,
            "issue_comments": issue_comments or "",
            "repo_full_name": repo_full_name,
            "resolve_run": True,
        }
    )

    # Create the run
    from app.models.run import Run

    now = now_ms()

    # Look up workspace type if we have a project
    run_workspace_type: Optional[str] = None
    if project_id:
        try:
            proj_result = await session.execute(
                select(Project.workspace_type).where(Project.id == project_id)
            )
            run_workspace_type = proj_result.scalar_one_or_none()
        except Exception:
            pass

    run = Run(
        id=gen_id("run_"),
        pipeline_id="resolve",
        project_id=project_id,
        task_description=task_description,
        status="pending",
        current_step_id=None,
        outputs="{}",
        human_context=context,
        workspace_type=run_workspace_type,
        created_at=now,
        updated_at=now,
    )
    session.add(run)
    await session.flush()

    # Publish to Redis for the engine to pick up
    if dependencies.redis_client:
        try:
            await dependencies.redis_client.xadd(
                "djinnbot:events:new_runs",
                {"event": "run:new", "run_id": run.id, "pipeline_id": "resolve"},
            )

            # Global event for dashboard SSE
            global_event = {
                "type": "RUN_CREATED",
                "runId": run.id,
                "pipelineId": "resolve",
                "taskDescription": task_description,
                "timestamp": now,
                "metadata": {
                    "resolve": True,
                    "issue_number": number,
                    "repo_full_name": repo_full_name,
                },
            }
            await dependencies.redis_client.xadd(
                "djinnbot:events:global", {"data": json.dumps(global_event)}
            )
        except Exception as e:
            logger.warning(f"Failed to publish resolve run to Redis: {e}")

    logger.info(
        f"resolve: created run {run.id} for {repo_full_name}#{number} "
        f"(project_id={project_id})"
    )

    return ResolveResponse(
        run_id=run.id,
        pipeline_id="resolve",
        issue_number=number,
        repo_full_name=repo_full_name,
        issue_title=issue_title,
        status="pending",
    )


@router.get("/parse")
async def parse_issue_url(
    url: str = Query(..., description="GitHub issue URL or shorthand"),
):
    """Parse a GitHub issue URL without starting a run.

    Useful for the CLI/dashboard to validate input and show a preview.
    """
    try:
        parsed = parse_issue_ref(url)
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))

    return {
        "owner": parsed["owner"],
        "repo": parsed["repo"],
        "number": parsed["number"],
        "full_name": f"{parsed['owner']}/{parsed['repo']}",
    }
