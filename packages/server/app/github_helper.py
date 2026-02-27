"""GitHub App installation helper functions."""

import json
import os
import secrets
import hashlib
import hmac
import time
from datetime import datetime, timedelta
from typing import Optional, Dict, List, Tuple

import jwt
import httpx
from sqlalchemy import select, update, delete
from sqlalchemy.dialects.postgresql import insert as pg_insert
from sqlalchemy.ext.asyncio import AsyncSession

from app.database import AsyncSessionLocal
from app.models.github import (
    ProjectGitHub,
    GitHubInstallationState,
)
from app.logging_config import get_logger
from app.models.base import now_ms

logger = get_logger(__name__)


def _row_to_dict(obj) -> dict:
    """Convert an ORM model instance to a dictionary."""
    return {c.key: getattr(obj, c.key) for c in obj.__table__.columns}


class GitHubHelper:
    """Helper class for GitHub App operations."""

    def __init__(self):
        self.app_id = os.getenv("GITHUB_APP_ID")
        self.app_name = os.getenv("GITHUB_APP_NAME", "djinnbot")
        self.client_id = os.getenv("GITHUB_APP_CLIENT_ID")
        self.private_key_path = os.getenv(
            "GITHUB_APP_PRIVATE_KEY_PATH", "/secrets/github-app.pem"
        )
        self.webhook_secret = os.getenv("GITHUB_APP_WEBHOOK_SECRET")
        self._private_key = None

    def _load_private_key(self) -> str:
        """Load private key from file."""
        if self._private_key is None:
            with open(self.private_key_path, "r") as f:
                self._private_key = f.read()
        return self._private_key

    def is_configured(self) -> tuple[bool, list[str]]:
        """Check whether all required env vars and files are present."""
        missing = []
        if not self.app_id:
            missing.append("GITHUB_APP_ID environment variable is not set")
        if not self.client_id:
            missing.append("GITHUB_APP_CLIENT_ID environment variable is not set")
        if not self.webhook_secret:
            missing.append("GITHUB_APP_WEBHOOK_SECRET environment variable is not set")
        if not os.path.exists(self.private_key_path):
            missing.append(
                f"Private key file not found at {self.private_key_path} "
                f"(set GITHUB_APP_PRIVATE_KEY_PATH or place the .pem file there)"
            )
        return len(missing) == 0, missing

    def generate_jwt(self) -> str:
        """Generate JWT for GitHub App authentication."""
        ok, missing = self.is_configured()
        if not ok:
            raise RuntimeError(
                "GitHub App is not configured. Missing: " + "; ".join(missing)
            )
        logger.debug("Generating new JWT for GitHub App")
        private_key = self._load_private_key()

        now = int(time.time())
        payload = {
            "iat": now - 60,
            "exp": now + 600,
            "iss": self.app_id,
        }

        encoded = jwt.encode(payload, private_key, algorithm="RS256")
        logger.debug("JWT generated successfully")
        return encoded

    async def get_installation_token(self, installation_id: int) -> Tuple[str, int]:
        """Get installation access token."""
        logger.debug(
            f"Getting installation token for installation_id={installation_id}"
        )
        jwt_token = self.generate_jwt()

        async with httpx.AsyncClient() as client:
            response = await client.post(
                f"https://api.github.com/app/installations/{installation_id}/access_tokens",
                headers={
                    "Authorization": f"Bearer {jwt_token}",
                    "Accept": "application/vnd.github+json",
                    "X-GitHub-Api-Version": "2022-11-28",
                },
            )

            if response.status_code != 201:
                raise Exception(f"Failed to get installation token: {response.text}")

            data = response.json()
            expires_at = datetime.fromisoformat(
                data["expires_at"].replace("Z", "+00:00")
            )
            return data["token"], int(expires_at.timestamp() * 1000)

    async def get_installation_repositories(self, installation_id: int) -> List[Dict]:
        """Get repositories accessible by an installation."""
        token, _ = await self.get_installation_token(installation_id)

        async with httpx.AsyncClient() as client:
            response = await client.get(
                "https://api.github.com/installation/repositories",
                headers={
                    "Authorization": f"Bearer {token}",
                    "Accept": "application/vnd.github+json",
                    "X-GitHub-Api-Version": "2022-11-28",
                },
            )

            if response.status_code != 200:
                raise Exception(f"Failed to get repositories: {response.text}")

            data = response.json()
            return data.get("repositories", [])

    async def get_repository_info(
        self, installation_id: int, owner: str, repo: str
    ) -> Dict:
        """Get repository information."""
        token, _ = await self.get_installation_token(installation_id)

        async with httpx.AsyncClient() as client:
            response = await client.get(
                f"https://api.github.com/repos/{owner}/{repo}",
                headers={
                    "Authorization": f"Bearer {token}",
                    "Accept": "application/vnd.github+json",
                    "X-GitHub-Api-Version": "2022-11-28",
                },
            )

            if response.status_code != 200:
                raise Exception(f"Failed to get repository info: {response.text}")

            return response.json()

    async def verify_webhook_signature(self, payload: bytes, signature: str) -> bool:
        """Verify webhook signature."""
        if not signature or not signature.startswith("sha256="):
            return False

        expected_signature = signature.split("=")[1]

        mac = hmac.new(
            self.webhook_secret.encode(), msg=payload, digestmod=hashlib.sha256
        )
        computed_signature = mac.hexdigest()

        return hmac.compare_digest(computed_signature, expected_signature)

    # ─── Database operations using SQLAlchemy ORM ─────────────────────────────

    async def create_installation_state(self, project_id: str, user_id: str) -> str:
        """Create a state token for OAuth flow CSRF protection."""
        state_token = secrets.token_urlsafe(32)
        state_id = secrets.token_urlsafe(16)

        now = now_ms()
        expires_at = now + (10 * 60 * 1000)  # 10 minutes

        async with AsyncSessionLocal() as session:
            state = GitHubInstallationState(
                id=state_id,
                state_token=state_token,
                project_id=project_id,
                user_id=user_id,
                created_at=now,
                expires_at=expires_at,
                used=0,
            )
            session.add(state)
            await session.commit()

        return state_token

    async def validate_and_consume_state(self, state_token: str) -> Optional[Dict]:
        """Validate state token and mark as used."""
        now = now_ms()

        async with AsyncSessionLocal() as session:
            result = await session.execute(
                select(GitHubInstallationState).where(
                    GitHubInstallationState.state_token == state_token,
                    GitHubInstallationState.used == 0,
                    GitHubInstallationState.expires_at > now,
                )
            )
            state = result.scalar_one_or_none()

            if not state:
                return None

            state.used = 1
            await session.commit()

            return {"project_id": state.project_id, "user_id": state.user_id}

    async def cleanup_expired_states(self) -> int:
        """Clean up expired state tokens."""
        now = now_ms()

        async with AsyncSessionLocal() as session:
            result = await session.execute(
                delete(GitHubInstallationState).where(
                    GitHubInstallationState.expires_at < now
                )
            )
            await session.commit()
            return result.rowcount

    async def get_project_github(self, project_id: str) -> Optional[Dict]:
        """Get GitHub connection for a project."""
        logger.debug(f"Looking up GitHub connection for project_id={project_id}")

        async with AsyncSessionLocal() as session:
            result = await session.execute(
                select(ProjectGitHub).where(
                    ProjectGitHub.project_id == project_id,
                    ProjectGitHub.is_active == 1,
                )
            )
            row = result.scalar_one_or_none()
            if row:
                d = _row_to_dict(row)
                # Callers expect "metadata" key — map from DB column name
                d["metadata"] = d.pop("github_metadata", "{}")
                logger.debug(
                    f"Found GitHub connection for project_id={project_id}: True"
                )
                return d
            logger.debug(f"Found GitHub connection for project_id={project_id}: False")
            return None

    async def get_projects_by_installation(self, installation_id: int) -> List[Dict]:
        """Get all projects connected to an installation."""
        logger.debug(f"Looking up projects for installation_id={installation_id}")

        async with AsyncSessionLocal() as session:
            result = await session.execute(
                select(ProjectGitHub).where(
                    ProjectGitHub.installation_id == installation_id,
                    ProjectGitHub.is_active == 1,
                )
            )
            rows = result.scalars().all()
            results = []
            for row in rows:
                d = _row_to_dict(row)
                d["metadata"] = d.pop("github_metadata", "{}")
                results.append(d)
            logger.debug(
                f"Found {len(results)} projects for installation_id={installation_id}"
            )
            return results

    async def connect_project_to_repository(
        self,
        project_id: str,
        installation_id: int,
        repo_owner: str,
        repo_name: str,
        default_branch: str,
        connected_by: str,
        metadata: Optional[Dict] = None,
    ) -> Dict:
        """Connect a project to a GitHub repository (upsert)."""
        connection_id = secrets.token_urlsafe(16)
        repo_full_name = f"{repo_owner}/{repo_name}"
        now = now_ms()
        metadata_json = json.dumps(metadata or {})

        async with AsyncSessionLocal() as session:
            # PostgreSQL upsert
            stmt = (
                pg_insert(ProjectGitHub)
                .values(
                    id=connection_id,
                    project_id=project_id,
                    installation_id=installation_id,
                    repo_owner=repo_owner,
                    repo_name=repo_name,
                    repo_full_name=repo_full_name,
                    default_branch=default_branch,
                    connected_at=now,
                    connected_by=connected_by,
                    is_active=1,
                    github_metadata=metadata_json,
                )
                .on_conflict_do_update(
                    index_elements=["project_id"],
                    set_={
                        "installation_id": installation_id,
                        "repo_owner": repo_owner,
                        "repo_name": repo_name,
                        "repo_full_name": repo_full_name,
                        "default_branch": default_branch,
                        "connected_at": now,
                        "connected_by": connected_by,
                        "is_active": 1,
                        "github_metadata": metadata_json,
                    },
                )
            )
            await session.execute(stmt)
            await session.commit()

            # Return the connection
            result = await session.execute(
                select(ProjectGitHub).where(ProjectGitHub.project_id == project_id)
            )
            row = result.scalar_one()
            d = _row_to_dict(row)
            d["metadata"] = d.pop("github_metadata", "{}")
            return d

    async def disconnect_project(self, project_id: str) -> None:
        """Disconnect a project from GitHub."""
        async with AsyncSessionLocal() as session:
            await session.execute(
                update(ProjectGitHub)
                .where(ProjectGitHub.project_id == project_id)
                .values(is_active=0)
            )
            await session.commit()

    async def update_last_push(self, project_id: str) -> None:
        """Update last push timestamp for a project."""
        now = now_ms()
        async with AsyncSessionLocal() as session:
            await session.execute(
                update(ProjectGitHub)
                .where(ProjectGitHub.project_id == project_id)
                .values(last_push_at=now)
            )
            await session.commit()

    async def update_last_sync(self, project_id: str) -> None:
        """Update last sync timestamp for a project."""
        now = now_ms()
        async with AsyncSessionLocal() as session:
            await session.execute(
                update(ProjectGitHub)
                .where(ProjectGitHub.project_id == project_id)
                .values(last_sync_at=now)
            )
            await session.commit()

    async def create_pull_request(
        self,
        project_id: str,
        head_branch: str,
        base_branch: str = "main",
        title: str = "",
        body: str = "",
        draft: bool = False,
    ) -> Dict:
        """Create a GitHub pull request for a task branch."""
        connection = await self.get_project_github(project_id)
        if not connection:
            raise ValueError(f"Project {project_id} is not connected to GitHub")

        installation_id = connection["installation_id"]
        owner = connection["repo_owner"]
        repo = connection["repo_name"]

        token, _expires_at = await self.get_installation_token(installation_id)

        payload = {
            "title": title,
            "body": body,
            "head": head_branch,
            "base": base_branch,
            "draft": draft,
        }

        async with httpx.AsyncClient() as client:
            response = await client.post(
                f"https://api.github.com/repos/{owner}/{repo}/pulls",
                headers={
                    "Authorization": f"Bearer {token}",
                    "Accept": "application/vnd.github+json",
                    "X-GitHub-Api-Version": "2022-11-28",
                },
                json=payload,
                timeout=30.0,
            )
            response.raise_for_status()
            data = response.json()

        return {
            "pr_number": data["number"],
            "pr_url": data["html_url"],
            "title": data["title"],
            "state": data["state"],
            "draft": data.get("draft", False),
        }


# Global instance
github_helper = GitHubHelper()
