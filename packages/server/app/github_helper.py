"""GitHub App installation helper functions."""

import os
import secrets
import hashlib
import hmac
import time
from datetime import datetime, timedelta
from typing import Optional, Dict, List, Tuple
import jwt
import httpx

from app.db import get_db
from app.logging_config import get_logger
from app.utils import now_ms

logger = get_logger(__name__)


class GitHubHelper:
    """Helper class for GitHub App operations."""

    def __init__(self):
        self.app_id = os.getenv("GITHUB_APP_ID")
        self.app_name = os.getenv("GITHUB_APP_NAME", "djinnbot")
        self.client_id = os.getenv("GITHUB_APP_CLIENT_ID")
        self.private_key_path = os.getenv(
            "GITHUB_APP_PRIVATE_KEY_PATH", "/data/secrets/github-app.pem"
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
        """Check whether all required env vars and files are present.

        Returns:
            (ok, missing_items) where missing_items is a list of human-readable
            descriptions of what is absent.
        """
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
        """Generate JWT for GitHub App authentication.

        Returns:
            str: JWT token valid for 10 minutes

        Raises:
            RuntimeError: If required env vars or the private key file are missing.
        """
        ok, missing = self.is_configured()
        if not ok:
            raise RuntimeError(
                "GitHub App is not configured. Missing: " + "; ".join(missing)
            )
        logger.debug("Generating new JWT for GitHub App")
        private_key = self._load_private_key()

        now = int(time.time())
        payload = {
            "iat": now
            - 60,  # issued at time, 60 seconds in the past to allow for clock drift
            "exp": now + 600,  # expiration time (10 minutes maximum)
            "iss": self.app_id,
        }

        # Create JWT using PyJWT
        encoded = jwt.encode(payload, private_key, algorithm="RS256")

        logger.debug("JWT generated successfully")
        return encoded

    async def get_installation_token(self, installation_id: int) -> Tuple[str, int]:
        """Get installation access token.

        Args:
            installation_id: GitHub App installation ID

        Returns:
            Tuple of (access_token, expires_at_timestamp)
        """
        logger.debug(
            f"Getting installation token for installation_id={installation_id}"
        )
        jwt_token = self.generate_jwt()

        async with httpx.AsyncClient() as client:
            logger.debug(
                f"Requesting access token from GitHub API for installation_id={installation_id}"
            )
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

            logger.debug(
                f"Successfully obtained installation token for installation_id={installation_id}"
            )
            return data["token"], int(expires_at.timestamp() * 1000)

    async def get_installation_repositories(self, installation_id: int) -> List[Dict]:
        """Get repositories accessible by an installation.

        Args:
            installation_id: GitHub App installation ID

        Returns:
            List of repository dictionaries
        """
        logger.debug(
            f"Fetching installation repositories for installation_id={installation_id}"
        )
        token, _ = await self.get_installation_token(installation_id)

        async with httpx.AsyncClient() as client:
            logger.debug(f"Calling GitHub API: installation/repositories")
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
            repos = data.get("repositories", [])
            logger.debug(
                f"Found {len(repos)} repositories for installation_id={installation_id}"
            )
            return repos

    async def get_repository_info(
        self, installation_id: int, owner: str, repo: str
    ) -> Dict:
        """Get repository information.

        Args:
            installation_id: GitHub App installation ID
            owner: Repository owner
            repo: Repository name

        Returns:
            Repository information dictionary
        """
        logger.debug(
            f"Fetching repository info: {owner}/{repo} (installation_id={installation_id})"
        )
        token, _ = await self.get_installation_token(installation_id)

        async with httpx.AsyncClient() as client:
            logger.debug(f"Calling GitHub API: repos/{owner}/{repo}")
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
        """Verify webhook signature.

        Args:
            payload: Raw webhook payload bytes
            signature: X-Hub-Signature-256 header value

        Returns:
            True if signature is valid
        """
        if not signature or not signature.startswith("sha256="):
            return False

        expected_signature = signature.split("=")[1]

        mac = hmac.new(
            self.webhook_secret.encode(), msg=payload, digestmod=hashlib.sha256
        )
        computed_signature = mac.hexdigest()

        return hmac.compare_digest(computed_signature, expected_signature)

    async def create_installation_state(self, project_id: str, user_id: str) -> str:
        """Create a state token for OAuth flow CSRF protection.

        Args:
            project_id: Project ID
            user_id: User ID initiating the installation

        Returns:
            State token string
        """
        state_token = secrets.token_urlsafe(32)
        state_id = secrets.token_urlsafe(16)

        now = now_ms()
        expires_at = now + (10 * 60 * 1000)  # 10 minutes

        async with get_db() as db:
            await db.execute(
                """INSERT INTO github_installation_states 
                   (id, state_token, project_id, user_id, created_at, expires_at, used)
                   VALUES (?, ?, ?, ?, ?, ?, 0)""",
                (state_id, state_token, project_id, user_id, now, expires_at),
            )
            await db.commit()

        return state_token

    async def validate_and_consume_state(self, state_token: str) -> Optional[Dict]:
        """Validate state token and mark as used.

        Args:
            state_token: State token to validate

        Returns:
            Dictionary with project_id and user_id if valid, None otherwise
        """
        now = now_ms()

        async with get_db() as db:
            # Get state
            cursor = await db.execute(
                """SELECT * FROM github_installation_states 
                   WHERE state_token = ? AND used = 0 AND expires_at > ?""",
                (state_token, now),
            )
            row = await cursor.fetchone()

            if not row:
                return None

            state = dict(row)

            # Mark as used
            await db.execute(
                "UPDATE github_installation_states SET used = 1 WHERE id = ?",
                (state["id"],),
            )
            await db.commit()

            return {"project_id": state["project_id"], "user_id": state["user_id"]}

    async def cleanup_expired_states(self) -> int:
        """Clean up expired state tokens.

        Returns:
            Number of states deleted
        """
        now = now_ms()

        async with get_db() as db:
            cursor = await db.execute(
                "DELETE FROM github_installation_states WHERE expires_at < ?", (now,)
            )
            await db.commit()
            return cursor.rowcount

    async def get_project_github(self, project_id: str) -> Optional[Dict]:
        """Get GitHub connection for a project.

        Args:
            project_id: Project ID

        Returns:
            Project GitHub connection dictionary or None
        """
        logger.debug(f"Looking up GitHub connection for project_id={project_id}")
        async with get_db() as db:
            cursor = await db.execute(
                "SELECT * FROM project_github WHERE project_id = ? AND is_active = 1",
                (project_id,),
            )
            row = await cursor.fetchone()
            result = dict(row) if row else None
            logger.debug(
                f"Found GitHub connection for project_id={project_id}: {result is not None}"
            )
            return result

    async def get_projects_by_installation(self, installation_id: int) -> List[Dict]:
        """Get all projects connected to an installation.

        Args:
            installation_id: GitHub App installation ID

        Returns:
            List of project GitHub connection dictionaries
        """
        logger.debug(f"Looking up projects for installation_id={installation_id}")
        async with get_db() as db:
            cursor = await db.execute(
                "SELECT * FROM project_github WHERE installation_id = ? AND is_active = 1",
                (installation_id,),
            )
            rows = await cursor.fetchall()
            result = [dict(row) for row in rows]
            logger.debug(
                f"Found {len(result)} projects for installation_id={installation_id}"
            )
            return result

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
        """Connect a project to a GitHub repository.

        Args:
            project_id: Project ID
            installation_id: GitHub App installation ID
            repo_owner: Repository owner
            repo_name: Repository name
            default_branch: Default branch name
            connected_by: User ID who connected
            metadata: Optional metadata dictionary

        Returns:
            Project GitHub connection dictionary
        """
        import json

        connection_id = secrets.token_urlsafe(16)
        repo_full_name = f"{repo_owner}/{repo_name}"
        now = now_ms()
        metadata_json = json.dumps(metadata or {})

        async with get_db() as db:
            # Upsert - replace existing connection if any
            await db.execute(
                """INSERT INTO project_github 
                   (id, project_id, installation_id, repo_owner, repo_name, repo_full_name, 
                    default_branch, connected_at, connected_by, is_active, metadata)
                   VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?)
                   ON CONFLICT(project_id) DO UPDATE SET
                     installation_id = excluded.installation_id,
                     repo_owner = excluded.repo_owner,
                     repo_name = excluded.repo_name,
                     repo_full_name = excluded.repo_full_name,
                     default_branch = excluded.default_branch,
                     connected_at = excluded.connected_at,
                     connected_by = excluded.connected_by,
                     is_active = 1,
                     metadata = excluded.metadata""",
                (
                    connection_id,
                    project_id,
                    installation_id,
                    repo_owner,
                    repo_name,
                    repo_full_name,
                    default_branch,
                    now,
                    connected_by,
                    metadata_json,
                ),
            )
            await db.commit()

            # Return the connection
            cursor = await db.execute(
                "SELECT * FROM project_github WHERE project_id = ?", (project_id,)
            )
            row = await cursor.fetchone()
            return dict(row)

    async def disconnect_project(self, project_id: str) -> None:
        """Disconnect a project from GitHub.

        Args:
            project_id: Project ID
        """
        async with get_db() as db:
            await db.execute(
                "UPDATE project_github SET is_active = 0 WHERE project_id = ?",
                (project_id,),
            )
            await db.commit()

    async def update_last_push(self, project_id: str) -> None:
        """Update last push timestamp for a project.

        Args:
            project_id: Project ID
        """
        now = now_ms()
        async with get_db() as db:
            await db.execute(
                "UPDATE project_github SET last_push_at = ? WHERE project_id = ?",
                (now, project_id),
            )
            await db.commit()

    async def update_last_sync(self, project_id: str) -> None:
        """Update last sync timestamp for a project.

        Args:
            project_id: Project ID
        """
        now = now_ms()
        async with get_db() as db:
            await db.execute(
                "UPDATE project_github SET last_sync_at = ? WHERE project_id = ?",
                (now, project_id),
            )
            await db.commit()

    async def create_pull_request(
        self,
        project_id: str,
        head_branch: str,
        base_branch: str = "main",
        title: str = "",
        body: str = "",
        draft: bool = False,
    ) -> Dict:
        """Create a GitHub pull request for a task branch.

        Uses the project's GitHub App installation token so no personal
        access token is required.

        Args:
            project_id: DjinnBot project ID (used to look up the installation).
            head_branch: Source branch (e.g. "feat/task_abc123-implement-oauth").
            base_branch: Target branch (default "main").
            title: PR title.
            body: PR description (markdown).
            draft: Whether to create as a draft PR.

        Returns:
            Dict with keys: pr_number, pr_url, title, state, draft.

        Raises:
            ValueError: If the project has no GitHub connection.
            httpx.HTTPStatusError: On GitHub API error.
        """
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
