"""GitHub App configuration and status endpoints."""

import os
import json
import traceback
import httpx
from fastapi import APIRouter, HTTPException, Request, Depends, Query
from fastapi.responses import RedirectResponse
from pydantic import BaseModel
from typing import Optional, List
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.database import get_async_session
from app.models import (
    Project,
    GitHubAppConfig,
    ProjectGitHub,
    GitHubInstallationState,
    WebhookEvent,
)
from app.models.project import Task
from app.utils import now_ms
from app.github_helper import github_helper
from app.logging_config import get_logger

logger = get_logger(__name__)

router = APIRouter()


# ── Pydantic Models ──────────────────────────────────────────────────────


class GitHubAppInfo(BaseModel):
    """Public GitHub App information."""

    app_id: int
    app_name: str
    installation_url: str
    is_configured: bool


class GitHubAppStatus(BaseModel):
    """GitHub App configuration and health status."""

    healthy: bool
    message: str
    app_id: int
    app_name: str
    installation_url: str
    is_configured: bool


class InstallationUrlResponse(BaseModel):
    """GitHub App installation URL response."""

    url: str
    state: str


class ConnectRepositoryRequest(BaseModel):
    """Request to connect a repository to a project."""

    installation_id: int
    owner: str
    repo: str


class GitHubConnectionStatus(BaseModel):
    """GitHub connection status for a project."""

    connected: bool
    repo_full_name: Optional[str] = None
    repo_url: Optional[str] = None
    default_branch: Optional[str] = None
    last_push_at: Optional[int] = None
    installation_id: Optional[int] = None


class RepositoryInfo(BaseModel):
    """GitHub repository information."""

    owner: str
    name: str
    full_name: str
    description: Optional[str] = None
    private: bool
    default_branch: str
    html_url: str


# ── Helper Functions ─────────────────────────────────────────────────────


async def _get_github_config(session: AsyncSession) -> Optional[dict]:
    """Get GitHub App configuration from database."""
    logger.debug("Fetching GitHub App config from database")
    result = await session.execute(
        select(GitHubAppConfig).order_by(GitHubAppConfig.id.desc()).limit(1)
    )
    config = result.scalar_one_or_none()
    if config:
        return {
            "id": config.id,
            "app_id": config.app_id,
            "app_name": config.app_name,
            "client_id": config.client_id,
            "webhook_secret": config.webhook_secret,
            "private_key_path": config.private_key_path,
            "created_at": config.created_at,
            "updated_at": config.updated_at,
        }
    return None


async def _validate_github_config(session: AsyncSession) -> dict:
    """Validate GitHub App configuration and return status.

    Returns:
        dict: {"healthy": bool, "message": str}
    """
    logger.debug("Validating GitHub App configuration")

    # Check environment variables
    app_id = os.getenv("GITHUB_APP_ID")
    client_id = os.getenv("GITHUB_APP_CLIENT_ID")
    webhook_secret = os.getenv("GITHUB_APP_WEBHOOK_SECRET")
    private_key_path = os.getenv(
        "GITHUB_APP_PRIVATE_KEY_PATH", "/secrets/github-app.pem"
    )
    app_name = os.getenv("GITHUB_APP_NAME", "djinnbot")

    if not app_id:
        logger.debug("Validation failed: GITHUB_APP_ID not set")
        return {
            "healthy": False,
            "message": "GITHUB_APP_ID environment variable not set",
        }

    if not client_id:
        logger.debug("Validation failed: GITHUB_APP_CLIENT_ID not set")
        return {
            "healthy": False,
            "message": "GITHUB_APP_CLIENT_ID environment variable not set",
        }

    if not webhook_secret:
        logger.debug("Validation failed: GITHUB_APP_WEBHOOK_SECRET not set")
        return {
            "healthy": False,
            "message": "GITHUB_APP_WEBHOOK_SECRET environment variable not set",
        }

    # Check if private key file exists
    if not os.path.exists(private_key_path):
        logger.debug(f"Validation failed: Private key not found at {private_key_path}")
        return {
            "healthy": False,
            "message": f"Private key file not found: {private_key_path}",
        }

    # Check if file is readable
    try:
        with open(private_key_path, "r") as f:
            key_content = f.read()
            if not key_content.strip():
                return {"healthy": False, "message": "Private key file is empty"}

            # Validate it looks like a private key
            if "BEGIN" not in key_content or "PRIVATE KEY" not in key_content:
                logger.debug("Validation failed: Private key has invalid format")
                return {
                    "healthy": False,
                    "message": "Private key file has invalid format",
                }
    except PermissionError:
        logger.debug(f"Validation failed: Cannot read private key (permission denied)")
        return {
            "healthy": False,
            "message": f"Cannot read private key file (permission denied): {private_key_path}",
        }
    except Exception as e:
        logger.debug(f"Validation failed: Error reading private key: {e}")
        return {"healthy": False, "message": f"Error reading private key: {str(e)}"}

    # Check database configuration
    config = await _get_github_config(session)
    if not config:
        # Try to sync from environment to database
        logger.debug("No DB config found, syncing from environment")
        try:
            now = now_ms()
            new_config = GitHubAppConfig(
                app_id=int(app_id),
                app_name=app_name,
                client_id=client_id,
                webhook_secret=webhook_secret,
                private_key_path=private_key_path,
                created_at=now,
                updated_at=now,
            )
            session.add(new_config)
            await session.flush()
        except Exception as e:
            logger.debug(f"Validation failed: Failed to sync config to database: {e}")
            return {
                "healthy": False,
                "message": f"Failed to sync config to database: {str(e)}",
            }

    logger.debug("Validation passed: GitHub App is properly configured")
    return {
        "healthy": True,
        "message": f"GitHub App '{app_name}' is properly configured",
    }


# ── API Endpoints ────────────────────────────────────────────────────────


@router.get("/app-info", response_model=GitHubAppInfo)
async def get_app_info(session: AsyncSession = Depends(get_async_session)):
    """Get public GitHub App information.

    This endpoint is public and used by the frontend to show the "Connect to GitHub" flow.
    Returns basic app information without sensitive credentials.
    """
    logger.debug("GET /app-info - Fetching GitHub App info")
    config = await _get_github_config(session)

    # Try environment variables if not in database
    if not config:
        app_id = os.getenv("GITHUB_APP_ID")
        app_name = os.getenv("GITHUB_APP_NAME", "djinnbot")

        if not app_id:
            return GitHubAppInfo(
                app_id=0,
                app_name="Not Configured",
                installation_url="",
                is_configured=False,
            )

        return GitHubAppInfo(
            app_id=int(app_id),
            app_name=app_name,
            installation_url=f"https://github.com/apps/{app_name}/installations/new",
            is_configured=True,
        )

    # Return from database
    installation_url = f"https://github.com/apps/{config['app_name']}/installations/new"

    return GitHubAppInfo(
        app_id=config["app_id"],
        app_name=config["app_name"],
        installation_url=installation_url,
        is_configured=True,
    )


@router.get("/status", response_model=GitHubAppStatus)
async def get_github_status(session: AsyncSession = Depends(get_async_session)):
    """Get GitHub App configuration and health status.

    This endpoint checks:
    - Environment variables are set
    - Private key file exists and is readable
    - Database configuration is present

    Returns detailed status information.
    """
    logger.debug("GET /status - Checking GitHub App status")
    # Validate configuration
    validation_result = await _validate_github_config(session)

    # Get app info
    config = await _get_github_config(session)

    if not config:
        app_id = os.getenv("GITHUB_APP_ID", "0")
        app_name = os.getenv("GITHUB_APP_NAME", "Not Configured")
        installation_url = ""
        is_configured = False
    else:
        app_id = config["app_id"]
        app_name = config["app_name"]
        installation_url = f"https://github.com/apps/{app_name}/installations/new"
        is_configured = True

    return GitHubAppStatus(
        healthy=validation_result["healthy"],
        message=validation_result["message"],
        app_id=int(app_id) if isinstance(app_id, str) else app_id,
        app_name=app_name,
        installation_url=installation_url,
        is_configured=is_configured and validation_result["healthy"],
    )


@router.post("/validate")
async def validate_github_config_endpoint(
    session: AsyncSession = Depends(get_async_session),
):
    """Manually trigger GitHub App configuration validation.

    This endpoint runs all validation checks and returns detailed results.
    Useful for debugging configuration issues.
    """
    logger.debug("POST /validate - Running manual GitHub config validation")
    validation_result = await _validate_github_config(session)

    if not validation_result["healthy"]:
        raise HTTPException(status_code=400, detail=validation_result["message"])

    return {"status": "valid", "message": validation_result["message"]}


# ── Project GitHub Installation Endpoints ────────────────────────────────


@router.get(
    "/projects/{project_id}/install-url", response_model=InstallationUrlResponse
)
async def get_project_install_url(
    project_id: str, session: AsyncSession = Depends(get_async_session)
):
    """Get GitHub App installation URL for a project.

    This generates a unique state token for CSRF protection and returns the URL
    where the user should be redirected to install the GitHub App.

    Args:
        project_id: Project ID

    Returns:
        Installation URL and state token
    """
    logger.debug(
        "GET /projects/%s/install-url - Generating installation URL", project_id
    )

    # Check if project exists
    result = await session.execute(select(Project).where(Project.id == project_id))
    project = result.scalar_one_or_none()

    if not project:
        logger.debug("Project not found: %s", project_id)
        raise HTTPException(status_code=404, detail="Project not found")

    # Get app info
    config = await _get_github_config(session)
    if not config:
        app_name = os.getenv("GITHUB_APP_NAME", "djinnbot")
    else:
        app_name = config["app_name"]

    logger.debug("Creating installation state token for project_id=%s", project_id)
    # Create state token (using "system" as user_id for now - in production, use actual user)
    state_token = await github_helper.create_installation_state(project_id, "system")

    # Build installation URL
    base_url = f"https://github.com/apps/{app_name}/installations/new"
    # GitHub will redirect back with installation_id and state
    installation_url = f"{base_url}?state={state_token}"

    return InstallationUrlResponse(url=installation_url, state=state_token)


@router.post("/projects/{project_id}/connect")
async def connect_project_repository(
    project_id: str,
    request: ConnectRepositoryRequest,
    session: AsyncSession = Depends(get_async_session),
):
    """Connect a project to a specific GitHub repository.

    This endpoint is called after the user completes the GitHub App installation.
    It verifies access to the repository and stores the connection.

    Args:
        project_id: Project ID
        request: Connection request with installation_id, owner, and repo

    Returns:
        Connection result
    """
    logger.debug(
        "POST /projects/%s/connect - Connecting repo %s/%s (installation_id=%d)",
        project_id,
        request.owner,
        request.repo,
        request.installation_id,
    )

    # Check if project exists
    result = await session.execute(select(Project).where(Project.id == project_id))
    project = result.scalar_one_or_none()

    if not project:
        logger.debug("Project not found: %s", project_id)
        raise HTTPException(status_code=404, detail="Project not found")

    try:
        # Get repository info from GitHub to verify access
        logger.debug(
            "Fetching repository info from GitHub: %s/%s (installation_id=%d)",
            request.owner,
            request.repo,
            request.installation_id,
        )
        repo_info = await github_helper.get_repository_info(
            request.installation_id, request.owner, request.repo
        )
        logger.debug(
            "Successfully fetched repo info for %s/%s", request.owner, request.repo
        )

        # Extract metadata
        metadata = {
            "repo_id": repo_info.get("id"),
            "private": repo_info.get("private", False),
            "clone_url": repo_info.get("clone_url"),
            "html_url": repo_info.get("html_url"),
            "description": repo_info.get("description", ""),
        }

        # Connect project to repository
        logger.debug(
            "Connecting project %s to repository %s/%s",
            project_id,
            request.owner,
            request.repo,
        )
        connection = await github_helper.connect_project_to_repository(
            project_id=project_id,
            installation_id=request.installation_id,
            repo_owner=request.owner,
            repo_name=request.repo,
            default_branch=repo_info.get("default_branch", "main"),
            connected_by="system",  # In production, use actual user ID
            metadata=metadata,
        )
        logger.debug(
            "Successfully connected project %s to %s",
            project_id,
            connection["repo_full_name"],
        )

        return {
            "success": True,
            "repo_full_name": connection["repo_full_name"],
            "installation_id": connection["installation_id"],
            "default_branch": connection["default_branch"],
        }

    except Exception as e:
        raise HTTPException(
            status_code=400, detail=f"Failed to connect repository: {str(e)}"
        )


@router.get("/projects/{project_id}/status", response_model=GitHubConnectionStatus)
async def get_project_github_status(
    project_id: str, session: AsyncSession = Depends(get_async_session)
):
    """Get GitHub connection status for a project.

    Args:
        project_id: Project ID

    Returns:
        Connection status
    """
    logger.debug(
        "GET /projects/%s/status - Fetching GitHub connection status", project_id
    )

    # Check if project exists
    result = await session.execute(select(Project).where(Project.id == project_id))
    project = result.scalar_one_or_none()

    if not project:
        logger.debug("Project not found: %s", project_id)
        raise HTTPException(status_code=404, detail="Project not found")

    # Get connection
    connection = await github_helper.get_project_github(project_id)

    if not connection:
        return GitHubConnectionStatus(connected=False)

    # Parse metadata to get repo URL
    metadata = json.loads(connection.get("metadata", "{}"))
    repo_url = metadata.get(
        "html_url", f"https://github.com/{connection['repo_full_name']}"
    )

    return GitHubConnectionStatus(
        connected=True,
        repo_full_name=connection["repo_full_name"],
        repo_url=repo_url,
        default_branch=connection["default_branch"],
        last_push_at=connection.get("last_push_at"),
        installation_id=connection["installation_id"],
    )


@router.delete("/projects/{project_id}/disconnect")
async def disconnect_project_repository(
    project_id: str, session: AsyncSession = Depends(get_async_session)
):
    """Disconnect a project from its GitHub repository.

    Args:
        project_id: Project ID

    Returns:
        Success message
    """
    logger.debug("DELETE /projects/%s/disconnect - Disconnecting GitHub", project_id)

    # Check if project exists
    result = await session.execute(select(Project).where(Project.id == project_id))
    project = result.scalar_one_or_none()

    if not project:
        logger.debug("Project not found: %s", project_id)
        raise HTTPException(status_code=404, detail="Project not found")

    # Check if connection exists
    connection = await github_helper.get_project_github(project_id)
    if not connection:
        logger.debug("Project %s not connected to GitHub", project_id)
        raise HTTPException(status_code=404, detail="Project not connected to GitHub")

    # Disconnect
    await github_helper.disconnect_project(project_id)
    logger.debug("Successfully disconnected project %s from GitHub", project_id)

    return {"success": True, "message": "GitHub integration disconnected"}


@router.get("/projects/{project_id}/repositories", response_model=List[RepositoryInfo])
async def list_available_repositories(
    project_id: str,
    installation_id: int,
    session: AsyncSession = Depends(get_async_session),
):
    """List repositories available for a given installation.

    This is used when the GitHub App is installed on multiple repositories
    and the user needs to select which one to connect to the project.

    Args:
        project_id: Project ID
        installation_id: GitHub App installation ID (query parameter)

    Returns:
        List of available repositories
    """
    logger.debug(
        "GET /projects/%s/repositories - Listing repos for installation_id=%d",
        project_id,
        installation_id,
    )

    # Check if project exists
    result = await session.execute(select(Project).where(Project.id == project_id))
    project = result.scalar_one_or_none()

    if not project:
        logger.debug("Project not found: %s", project_id)
        raise HTTPException(status_code=404, detail="Project not found")

    try:
        # Get repositories from GitHub
        logger.debug(
            "Fetching installation repositories from GitHub (installation_id=%d)",
            installation_id,
        )
        repos = await github_helper.get_installation_repositories(installation_id)
        logger.debug(
            "Found %d repositories for installation %d", len(repos), installation_id
        )

        # Format response
        result = []
        for repo in repos:
            result.append(
                RepositoryInfo(
                    owner=repo["owner"]["login"],
                    name=repo["name"],
                    full_name=repo["full_name"],
                    description=repo.get("description"),
                    private=repo["private"],
                    default_branch=repo.get("default_branch", "main"),
                    html_url=repo["html_url"],
                )
            )

        return result

    except Exception as e:
        raise HTTPException(
            status_code=400, detail=f"Failed to list repositories: {str(e)}"
        )


# ── GitHub OAuth Callback ───────────────────────────────────────────────


@router.get("/callback")
async def handle_github_callback(installation_id: int, setup_action: str, state: str):
    """Handle GitHub App installation callback.

    GitHub redirects to this endpoint after user completes app installation.
    This endpoint validates the state token, retrieves installation details,
    and auto-connects if only one repository was selected.

    Query params:
        installation_id: GitHub App installation ID
        setup_action: 'install' or 'update'
        state: CSRF protection token

    Returns:
        Redirect response to frontend
    """
    logger.debug(
        "GET /callback - OAuth flow started (installation_id=%d, setup_action=%s)",
        installation_id,
        setup_action,
    )

    try:
        # Validate state token
        logger.debug("Validating OAuth state token")
        state_data = await github_helper.validate_and_consume_state(state)

        if not state_data:
            # Invalid or expired state token
            logger.debug("OAuth callback: Invalid or expired state token")
            frontend_url = os.getenv("FRONTEND_URL", "http://localhost:3000")
            return RedirectResponse(
                url=f"{frontend_url}/github/error?message=Invalid+or+expired+state+token",
                status_code=302,
            )

        project_id = state_data["project_id"]
        user_id = state_data["user_id"]
        logger.debug(
            "OAuth callback: State valid for project_id=%s, user_id=%s",
            project_id,
            user_id,
        )

        # Get repositories accessible by this installation
        logger.debug("Fetching repositories for installation_id=%d", installation_id)
        try:
            repos = await github_helper.get_installation_repositories(installation_id)
        except Exception as e:
            logger.error(f"Failed to get installation repositories: {e}")
            frontend_url = os.getenv("FRONTEND_URL", "http://localhost:3000")
            return RedirectResponse(
                url=f"{frontend_url}/github/error?message=Failed+to+access+repositories",
                status_code=302,
            )

        # If only one repository, auto-connect it
        if len(repos) == 1:
            logger.debug(
                "Auto-connecting: single repository found (%s)", repos[0]["full_name"]
            )
            repo = repos[0]

            try:
                # Get full repository info
                logger.debug(
                    "Fetching repo info for auto-connect: %s/%s",
                    repo["owner"]["login"],
                    repo["name"],
                )
                repo_info = await github_helper.get_repository_info(
                    installation_id, repo["owner"]["login"], repo["name"]
                )

                # Connect project to repository
                metadata = {
                    "repo_id": repo_info.get("id"),
                    "private": repo_info.get("private", False),
                    "clone_url": repo_info.get("clone_url"),
                    "html_url": repo_info.get("html_url"),
                    "description": repo_info.get("description", ""),
                }

                logger.debug(
                    "Auto-connecting project %s to %s", project_id, repo["full_name"]
                )
                await github_helper.connect_project_to_repository(
                    project_id=project_id,
                    installation_id=installation_id,
                    repo_owner=repo["owner"]["login"],
                    repo_name=repo["name"],
                    default_branch=repo_info.get("default_branch", "main"),
                    connected_by=user_id,
                    metadata=metadata,
                )

                logger.info(
                    f"Auto-connected project {project_id} to {repo['full_name']}"
                )

            except Exception as e:
                logger.error(f"Failed to auto-connect repository: {e}")
                # Still redirect to success page, user can manually connect
        else:
            logger.debug(
                "Multiple repositories (%d) - user must select manually", len(repos)
            )

        # Redirect back to project settings with success flag
        frontend_url = os.getenv("FRONTEND_URL", "http://localhost:3000")
        return RedirectResponse(
            url=f"{frontend_url}/projects/{project_id}/settings?tab=github&installation_id={installation_id}&success=true",
            status_code=302,
        )

    except Exception as e:
        logger.error(f"GitHub callback error: {e}", exc_info=True)

        frontend_url = os.getenv("FRONTEND_URL", "http://localhost:3000")
        error_message = str(e).replace(" ", "+")
        return RedirectResponse(
            url=f"{frontend_url}/github/error?message={error_message}", status_code=302
        )


# ── GitHub Webhooks ──────────────────────────────────────────────────────


@router.post("/webhooks")
async def handle_github_webhook(request: Request):
    """Handle GitHub webhook events.

    This endpoint receives webhooks from GitHub for:
    - installation.created - New app installation
    - installation.deleted - App uninstalled
    - installation_repositories - Repositories added/removed
    - push events, pull requests, etc.
    """
    # Get webhook payload
    payload = await request.body()
    signature = request.headers.get("X-Hub-Signature-256", "")
    event_type = request.headers.get("X-GitHub-Event", "")
    delivery_id = request.headers.get("X-GitHub-Delivery", "")

    logger.debug(
        "POST /webhooks - Received GitHub webhook: event=%s, delivery=%s",
        event_type,
        delivery_id,
    )

    # Verify signature
    logger.debug("Verifying webhook signature")
    is_valid = await github_helper.verify_webhook_signature(payload, signature)
    if not is_valid:
        logger.debug(
            "Webhook signature verification failed for delivery=%s", delivery_id
        )
        raise HTTPException(status_code=401, detail="Invalid webhook signature")

    # Parse payload
    try:
        data = json.loads(payload)
    except json.JSONDecodeError:
        raise HTTPException(status_code=400, detail="Invalid JSON payload")

    action = data.get("action")
    installation = data.get("installation", {})
    installation_id = installation.get("id")

    logger.info(f"GitHub webhook: {event_type}.{action} (delivery: {delivery_id})")

    # Handle installation events
    if event_type == "installation":
        if action == "created":
            logger.info(f"New GitHub App installation: {installation_id}")
            # Installation created - logged for reference

        elif action == "deleted":
            logger.warning(f"GitHub App uninstalled: {installation_id}")
            # Mark all projects using this installation as disconnected
            if installation_id:
                projects = await github_helper.get_projects_by_installation(
                    installation_id
                )
                for project in projects:
                    await github_helper.disconnect_project(project["project_id"])
                    logger.info(f"Disconnected project: {project['project_id']}")

    elif event_type == "installation_repositories":
        if action == "removed":
            # Repositories removed from installation
            removed_repos = data.get("repositories_removed", [])
            logger.info(f"Repositories removed: {len(removed_repos)}")
            # Could disconnect projects using these specific repos

    # Log webhook event to database for audit trail using ORM
    async with get_async_session() as session:
        event_id = f"wh_{delivery_id}"
        now = now_ms()

        event = WebhookEvent(
            id=event_id,
            delivery_id=delivery_id,
            event_type=event_type,
            action=action,
            installation_id=str(installation_id) if installation_id else None,
            repository_full_name=data.get("repository", {}).get("full_name"),
            repository_id=data.get("repository", {}).get("id"),
            sender_login=data.get("sender", {}).get("login"),
            payload=payload.decode("utf-8"),
            signature=signature,
            verified=1,
            processed=1,
            received_at=now,
        )
        session.add(event)
        await session.commit()

    # Return success quickly (GitHub expects response within 10 seconds)
    return {"received": True, "event": event_type, "action": action}


# ══════════════════════════════════════════════════════════════════════════
# INTERNAL TOKEN ENDPOINT (for core engine)
# ══════════════════════════════════════════════════════════════════════════


class AppInstallation(BaseModel):
    """A GitHub App installation (account/org that has installed the App)."""

    installation_id: int
    account_login: str
    account_type: str  # "User" or "Organization"
    account_avatar_url: str
    app_id: int
    app_slug: str
    repository_selection: str  # "all" or "selected"
    installed_at: str


class ManualCallbackRequest(BaseModel):
    """Register an installation by ID without going through the OAuth redirect."""

    installation_id: int


# ── App-level Installation Endpoints ────────────────────────────────────────


@router.get("/setup-status")
async def get_setup_status():
    """Return structured GitHub App configuration status.

    This endpoint never raises — it always returns a JSON body that tells the
    frontend exactly what is missing so it can render a clear setup guide
    instead of a generic error.

    Response shape:
      {
        "configured": bool,
        "missing": [str, ...],   # human-readable list of what's absent
        "app_name": str | null,
        "app_id": int | null,
      }
    """
    ok, missing = github_helper.is_configured()
    app_name = os.getenv("GITHUB_APP_NAME") or None
    app_id_raw = os.getenv("GITHUB_APP_ID")
    app_id = int(app_id_raw) if app_id_raw else None

    return {
        "configured": ok,
        "missing": missing,
        "app_name": app_name,
        "app_id": app_id,
    }


@router.get("/installations", response_model=List[AppInstallation])
async def list_app_installations():
    """List all GitHub accounts/orgs that have installed this GitHub App.

    Uses the App JWT to call GET /app/installations on the GitHub API, so it
    returns every installation regardless of project association. This is
    useful for discovering the installation_id for a new account (e.g. your
    personal GitHub account) so it can be manually wired to a project.

    No database state required — goes straight to the GitHub API.
    """
    logger.debug("GET /installations - Listing all App installations")

    try:
        jwt_token = github_helper.generate_jwt()
    except Exception as e:
        raise HTTPException(
            status_code=503,
            detail=f"GitHub App not configured (cannot generate JWT): {str(e)}",
        )

    async with httpx.AsyncClient() as client:
        response = await client.get(
            "https://api.github.com/app/installations",
            headers={
                "Authorization": f"Bearer {jwt_token}",
                "Accept": "application/vnd.github+json",
                "X-GitHub-Api-Version": "2022-11-28",
            },
            params={"per_page": 100},
        )

    if response.status_code != 200:
        raise HTTPException(
            status_code=502,
            detail=f"GitHub API error: {response.text}",
        )

    raw = response.json()
    result = []
    for inst in raw:
        account = inst.get("account", {})
        result.append(
            AppInstallation(
                installation_id=inst["id"],
                account_login=account.get("login", ""),
                account_type=account.get("type", ""),
                account_avatar_url=account.get("avatar_url", ""),
                app_id=inst.get("app_id", 0),
                app_slug=inst.get("app_slug", ""),
                repository_selection=inst.get("repository_selection", "selected"),
                installed_at=inst.get("created_at", ""),
            )
        )

    logger.debug("Found %d App installations", len(result))
    return result


@router.get("/app-install-url")
async def get_app_install_url():
    """Return the GitHub App installation URL (no project or state token required).

    This is the raw URL to send any GitHub user/org to in order to install
    the App into their account.  Useful during development or for private
    deployments where the OAuth callback URL is not publicly reachable.

    After installing, the user will be redirected to the App's callback URL
    (which may not be reachable in dev), but the installation itself will
    still appear in GET /v1/github/installations once GitHub processes it.
    """
    app_name = os.getenv("GITHUB_APP_NAME", "djinnbot")
    app_id = os.getenv("GITHUB_APP_ID")

    if not app_id:
        raise HTTPException(
            status_code=503,
            detail="GitHub App not configured (GITHUB_APP_ID not set)",
        )

    url = f"https://github.com/apps/{app_name}/installations/new"
    return {"url": url, "app_name": app_name, "app_id": int(app_id)}


@router.post("/manual-callback")
async def manual_callback(
    request: ManualCallbackRequest,
    session: AsyncSession = Depends(get_async_session),
):
    """Register a GitHub App installation by ID without the OAuth redirect.

    For development or private deployments where the callback URL is not
    publicly reachable.  The user installs the App through GitHub normally,
    then copies the installation_id from GET /v1/github/installations (or from
    the GitHub App settings page) and submits it here.

    Returns the installation details fetched live from the GitHub API so the
    caller can confirm the correct account was installed.
    """
    installation_id = request.installation_id
    logger.info(
        "POST /manual-callback - Registering installation_id=%d", installation_id
    )

    try:
        jwt_token = github_helper.generate_jwt()
    except Exception as e:
        raise HTTPException(
            status_code=503,
            detail=f"GitHub App not configured: {str(e)}",
        )

    async with httpx.AsyncClient() as client:
        response = await client.get(
            f"https://api.github.com/app/installations/{installation_id}",
            headers={
                "Authorization": f"Bearer {jwt_token}",
                "Accept": "application/vnd.github+json",
                "X-GitHub-Api-Version": "2022-11-28",
            },
        )

    if response.status_code == 404:
        raise HTTPException(
            status_code=404,
            detail=f"Installation {installation_id} not found — make sure the App is installed in the target account",
        )
    if response.status_code != 200:
        raise HTTPException(
            status_code=502,
            detail=f"GitHub API error: {response.text}",
        )

    inst = response.json()
    account = inst.get("account", {})

    return {
        "ok": True,
        "installation_id": inst["id"],
        "account_login": account.get("login", ""),
        "account_type": account.get("type", ""),
        "account_avatar_url": account.get("avatar_url", ""),
        "repository_selection": inst.get("repository_selection", "selected"),
        "installed_at": inst.get("created_at", ""),
    }


class InstallationTokenResponse(BaseModel):
    """Installation token response for git operations."""

    token: str
    expires_at: int
    installation_id: int
    repo_url: str


@router.get(
    "/projects/{project_id}/git-token", response_model=InstallationTokenResponse
)
async def get_project_git_token(project_id: str):
    """Get an installation access token for git operations on a project's repository.

    This endpoint is used by the core engine to authenticate git clone/push operations
    using the GitHub App instead of a static GITHUB_TOKEN.

    The returned token should be used as:
        https://x-access-token:{token}@github.com/owner/repo.git

    Args:
        project_id: Project ID

    Returns:
        InstallationTokenResponse with token, expiry, and repo URL

    Raises:
        404: Project not found or not connected to GitHub
    """
    logger.debug(
        "GET /projects/%s/git-token - Requesting installation token", project_id
    )

    # Get GitHub connection for project
    connection = await github_helper.get_project_github(project_id)

    if not connection:
        logger.debug("Project %s not connected to GitHub", project_id)
        raise HTTPException(
            status_code=404,
            detail="Project not connected to GitHub. Configure GitHub integration first.",
        )

    installation_id = connection["installation_id"]
    owner = connection["repo_owner"]
    repo = connection["repo_name"]
    logger.debug(
        "Found GitHub connection: owner=%s, repo=%s, installation_id=%d",
        owner,
        repo,
        installation_id,
    )

    try:
        # Get fresh installation token
        logger.debug(
            "Requesting installation token from GitHub (installation_id=%d)",
            installation_id,
        )
        token, expires_at = await github_helper.get_installation_token(installation_id)
        logger.debug(
            "Successfully obtained installation token, expires at %d", expires_at
        )

        # Build authenticated repo URL
        repo_url = f"https://x-access-token:{token}@github.com/{owner}/{repo}.git"

        return InstallationTokenResponse(
            token=token,
            expires_at=expires_at,
            installation_id=installation_id,
            repo_url=repo_url,
        )
    except Exception as e:
        raise HTTPException(
            status_code=500, detail=f"Failed to get installation token: {str(e)}"
        )


@router.get("/repo-token")
async def get_repo_token_for_agent(
    repo: str = Query(
        ...,
        description='Repository path or URL, e.g. "owner/repo" or "https://github.com/owner/repo"',
    ),
    session: AsyncSession = Depends(get_async_session),
):
    """Get a GitHub App installation token for a specific repository.

    Called by the `get_github_token` tool inside agent containers.
    The agent passes only the repo URL/path — the API resolves which
    installation covers that repo, so the agent never needs to know
    installation IDs.

    Resolution order:
    1. Check `project_github` DB table for a connected project with that repo.
    2. If not found, call the GitHub API (GET /repos/{owner}/{repo}/installation)
       using the App JWT — returns the installation that covers the repo.
    3. If the app is not installed on that repo, return a clear 404 with
       instructions for the user.

    Returns: { token, expires_at, owner, repo, clone_url }
    """
    # Normalise input: strip protocol and .git suffix, extract owner/repo
    raw = repo.strip()
    for prefix in ("https://github.com/", "http://github.com/", "git@github.com:"):
        if raw.startswith(prefix):
            raw = raw[len(prefix) :]
    raw = raw.rstrip("/").removesuffix(".git")
    parts = raw.split("/")
    if len(parts) < 2:
        raise HTTPException(
            status_code=400,
            detail=f"Invalid repo format '{repo}'. Use 'owner/repo' or the full GitHub URL.",
        )
    owner, repo_name = parts[0], parts[1]
    full_name = f"{owner}/{repo_name}"

    logger.debug("GET /github/repo-token - repo=%s", full_name)

    installation_id: Optional[int] = None

    # 1. Check local DB first (fast path — no GitHub API call)
    db_result = await session.execute(
        select(ProjectGitHub).where(ProjectGitHub.repo_full_name == full_name)
    )
    connection = db_result.scalar_one_or_none()
    if connection:
        installation_id = connection.installation_id
        logger.debug(
            "Resolved installation_id=%d from DB for %s", installation_id, full_name
        )

    # 2. Ask GitHub API: which installation covers this repo?
    if installation_id is None:
        try:
            jwt_token = github_helper.generate_jwt()
            async with httpx.AsyncClient() as client:
                resp = await client.get(
                    f"https://api.github.com/repos/{owner}/{repo_name}/installation",
                    headers={
                        "Authorization": f"Bearer {jwt_token}",
                        "Accept": "application/vnd.github+json",
                        "X-GitHub-Api-Version": "2022-11-28",
                    },
                )
            if resp.status_code == 200:
                installation_id = resp.json()["id"]
                logger.debug(
                    "Resolved installation_id=%d from GitHub API for %s",
                    installation_id,
                    full_name,
                )
            elif resp.status_code == 404:
                raise HTTPException(
                    status_code=404,
                    detail=(
                        f"The DjinnBot GitHub App is not installed on '{full_name}'. "
                        f"Ask the repository owner to install the app at "
                        f"https://github.com/apps/{os.getenv('GITHUB_APP_NAME', 'djinnbot')}/installations/new "
                        f"and grant access to this repository."
                    ),
                )
            else:
                raise HTTPException(
                    status_code=502,
                    detail=f"GitHub API error resolving installation for '{full_name}': {resp.text}",
                )
        except HTTPException:
            raise
        except Exception as e:
            raise HTTPException(
                status_code=503,
                detail=f"GitHub App not configured or unavailable: {str(e)}",
            )

    # 3. Exchange installation_id for an access token
    try:
        token, expires_at = await github_helper.get_installation_token(installation_id)
    except Exception as e:
        raise HTTPException(
            status_code=500,
            detail=f"Failed to get installation token for '{full_name}': {str(e)}",
        )

    return {
        "token": token,
        "expires_at": expires_at,
        "installation_id": installation_id,
        "owner": owner,
        "repo": repo_name,
        "clone_url": f"https://x-access-token:{token}@github.com/{owner}/{repo_name}.git",
    }


@router.get("/git-credential")
async def get_git_credential(
    agent_id: str = Query(..., description="Agent ID requesting credentials"),
    session: AsyncSession = Depends(get_async_session),
):
    """Return a GitHub App token suitable for git push/fetch operations.

    Called by the djinnbot-git-credential helper script that runs inside
    agent containers during pulse sessions. The script passes agent_id so we
    can look up which GitHub App installation to use.

    Strategy: find all tasks currently assigned to this agent that are
    in_progress, get the project IDs, and return a token for the first
    project that has a GitHub App connection. In practice all tasks for a
    given agent should share the same installation (same GitHub org/user).

    Returns: { "token": "<github-app-installation-token>" }
    Raises:  404 if no connected project is found for this agent.
    """
    logger.debug("GET /github/git-credential - agent_id=%s", agent_id)

    # Find projects that have in-progress tasks assigned to this agent
    result = await session.execute(
        select(Task.project_id)
        .where(Task.assigned_agent == agent_id, Task.status == "in_progress")
        .distinct()
    )
    project_ids = [row[0] for row in result.fetchall()]

    if not project_ids:
        # Fallback: any task assigned to this agent (not just in_progress)
        result = await session.execute(
            select(Task.project_id).where(Task.assigned_agent == agent_id).distinct()
        )
        project_ids = [row[0] for row in result.fetchall()]

    if not project_ids:
        raise HTTPException(
            status_code=404,
            detail=f"No projects found for agent {agent_id}",
        )

    # Try each project until we find one with a GitHub App connection
    for project_id in project_ids:
        connection = await github_helper.get_project_github(project_id)
        if not connection:
            continue
        try:
            token, _expires_at = await github_helper.get_installation_token(
                connection["installation_id"]
            )
            logger.debug(
                "Issued git credential token for agent %s via project %s",
                agent_id,
                project_id,
            )
            return {"token": token}
        except Exception as e:
            logger.warning("Failed to get token for project %s: %s", project_id, e)
            continue

    raise HTTPException(
        status_code=404,
        detail=f"No GitHub App connection found for any project assigned to agent {agent_id}",
    )
