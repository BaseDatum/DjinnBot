"""System update check and apply endpoints.

Periodically checks the GitHub Releases API for new DjinnBot versions.
Compares the latest release tag against the running DJINNBOT_VERSION.
When an update is available the dashboard shows an indicator; triggering
the update publishes a Redis event that the engine picks up and executes
(docker compose pull + up -d --force-recreate).
"""

import asyncio
import json
import os
import re
import time
from typing import Optional

import httpx
from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

from app import dependencies
from app.logging_config import get_logger

logger = get_logger(__name__)

router = APIRouter()

# ── Constants ────────────────────────────────────────────────────────────────

GITHUB_REPO = "BaseDatum/DjinnBot"
GITHUB_RELEASES_URL = f"https://api.github.com/repos/{GITHUB_REPO}/releases/latest"
CHECK_INTERVAL_SECONDS = 3600  # 1 hour
REDIS_CACHE_KEY = "djinnbot:system:update_check"
REDIS_CACHE_TTL = 3600  # 1 hour


# ── Helpers ──────────────────────────────────────────────────────────────────


def _get_current_version() -> str:
    """Return the running DjinnBot version.

    Prefer DJINNBOT_BUILD_VERSION (semver baked in at Docker build time via
    ``--build-arg BUILD_VERSION=vX.Y.Z``).  Fall back to DJINNBOT_VERSION
    (the image tag used in docker-compose, which is often just ``latest``).
    """
    return (
        os.getenv("DJINNBOT_BUILD_VERSION") or os.getenv("DJINNBOT_VERSION") or "latest"
    )


def _parse_semver(tag: str) -> Optional[tuple[int, int, int]]:
    """Parse a semver tag like 'v1.2.3' into (1, 2, 3). Returns None on failure."""
    m = re.match(r"^v?(\d+)\.(\d+)\.(\d+)", tag)
    if not m:
        return None
    return (int(m.group(1)), int(m.group(2)), int(m.group(3)))


def _is_newer(latest_tag: str, current_tag: str) -> bool:
    """Return True if latest_tag is strictly newer than current_tag."""
    latest = _parse_semver(latest_tag)
    current = _parse_semver(current_tag)
    if latest is None or current is None:
        # Can't compare — treat as update available if tags differ
        return latest_tag != current_tag
    return latest > current


async def _fetch_latest_release() -> Optional[dict]:
    """Fetch the latest release from GitHub Releases API."""
    try:
        headers = {
            "Accept": "application/vnd.github+json",
            "User-Agent": "DjinnBot-UpdateChecker/1.0",
        }
        # Use GITHUB_TOKEN if available for higher rate limits
        gh_token = os.getenv("GITHUB_TOKEN")
        if gh_token:
            headers["Authorization"] = f"Bearer {gh_token}"

        async with httpx.AsyncClient(timeout=15.0) as client:
            resp = await client.get(GITHUB_RELEASES_URL, headers=headers)
            if resp.status_code == 404:
                logger.debug("No releases found on GitHub")
                return None
            resp.raise_for_status()
            return resp.json()
    except httpx.HTTPStatusError as e:
        logger.warning(
            f"GitHub API error checking for updates: {e.response.status_code}"
        )
        return None
    except Exception as e:
        logger.warning(f"Failed to check for updates: {e}")
        return None


# ── Pydantic models ──────────────────────────────────────────────────────────


class UpdateCheckResponse(BaseModel):
    """Result of an update availability check."""

    current_version: str
    latest_version: Optional[str] = None
    update_available: bool = False
    release_url: Optional[str] = None
    release_name: Optional[str] = None
    release_body: Optional[str] = None
    published_at: Optional[str] = None
    checked_at: int = 0  # epoch ms


class UpdateApplyRequest(BaseModel):
    """Request to apply an update."""

    target_version: Optional[str] = None  # None = latest


class UpdateApplyResponse(BaseModel):
    """Response after triggering an update."""

    status: str  # "triggered" | "error"
    message: str
    target_version: str


# ── Background checker ───────────────────────────────────────────────────────


async def check_for_updates() -> UpdateCheckResponse:
    """Check GitHub for the latest release and compare with running version."""
    current = _get_current_version()
    result = UpdateCheckResponse(
        current_version=current,
        checked_at=int(time.time() * 1000),
    )

    release = await _fetch_latest_release()
    if not release:
        return result

    tag = release.get("tag_name", "")
    result.latest_version = tag
    result.release_url = release.get("html_url")
    result.release_name = release.get("name") or tag
    result.release_body = release.get("body", "")
    result.published_at = release.get("published_at")

    # Compare versions
    if current in ("unknown", ""):
        # Can't determine running version — assume update available
        result.update_available = True
    elif current == "latest":
        # Running from "latest" tag — compare the release tag against the
        # API-reported version (which reflects the actual build version).
        api_version = os.getenv("DJINNBOT_API_VERSION", "")
        if api_version and _parse_semver(api_version):
            result.current_version = api_version
            result.update_available = _is_newer(tag, api_version)
        else:
            # No concrete version available — don't nag about updates
            result.update_available = False
    else:
        result.update_available = _is_newer(tag, current)

    return result


async def _cache_update_check(result: UpdateCheckResponse) -> None:
    """Cache the update check result in Redis."""
    if not dependencies.redis_client:
        return
    try:
        await dependencies.redis_client.setex(
            REDIS_CACHE_KEY,
            REDIS_CACHE_TTL,
            result.model_dump_json(),
        )
    except Exception as e:
        logger.warning(f"Failed to cache update check: {e}")


async def _get_cached_check() -> Optional[UpdateCheckResponse]:
    """Get the cached update check result from Redis."""
    if not dependencies.redis_client:
        return None
    try:
        data = await dependencies.redis_client.get(REDIS_CACHE_KEY)
        if data:
            return UpdateCheckResponse.model_validate_json(data)
    except Exception as e:
        logger.warning(f"Failed to read cached update check: {e}")
    return None


# ── Background task (called from lifespan) ───────────────────────────────────


async def periodic_update_checker():
    """Background task that checks for updates every CHECK_INTERVAL_SECONDS."""
    # Initial delay — let the API server finish booting
    await asyncio.sleep(30)

    while True:
        try:
            logger.info("Checking for DjinnBot updates...")
            result = await check_for_updates()
            await _cache_update_check(result)
            if result.update_available:
                logger.info(
                    f"Update available: {result.current_version} → {result.latest_version}"
                )
            else:
                logger.debug(f"DjinnBot is up to date ({result.current_version})")
        except Exception as e:
            logger.error(f"Update check failed: {e}", exc_info=True)

        await asyncio.sleep(CHECK_INTERVAL_SECONDS)


# ── Endpoints ────────────────────────────────────────────────────────────────


@router.get("/check")
async def get_update_status() -> UpdateCheckResponse:
    """Get the latest update check result (cached, refreshed every hour).

    If no cached result exists, performs a live check.
    """
    cached = await _get_cached_check()
    if cached:
        return cached

    # No cache — do a fresh check
    result = await check_for_updates()
    await _cache_update_check(result)
    return result


@router.post("/check")
async def force_update_check() -> UpdateCheckResponse:
    """Force an immediate update check (bypasses cache)."""
    result = await check_for_updates()
    await _cache_update_check(result)
    return result


@router.post("/apply")
async def apply_update(
    body: UpdateApplyRequest = UpdateApplyRequest(),
) -> UpdateApplyResponse:
    """Trigger a system update.

    Publishes a SYSTEM_UPDATE_REQUESTED event to the global Redis stream
    which the engine picks up and executes (pull images + recreate containers).
    """
    if not dependencies.redis_client:
        raise HTTPException(status_code=503, detail="Redis unavailable")

    # Determine target version
    target = body.target_version
    if not target:
        # Use the latest known version from the cache
        cached = await _get_cached_check()
        if cached and cached.latest_version:
            target = cached.latest_version
        else:
            # Do a fresh check
            result = await check_for_updates()
            if result.latest_version:
                target = result.latest_version
            else:
                raise HTTPException(
                    status_code=400,
                    detail="Could not determine latest version. Try again later.",
                )

    # Publish event for the engine to pick up
    event = {
        "type": "SYSTEM_UPDATE_REQUESTED",
        "targetVersion": target,
        "requestedAt": int(time.time() * 1000),
    }
    try:
        await dependencies.redis_client.xadd(
            "djinnbot:events:global", {"data": json.dumps(event)}
        )
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Failed to trigger update: {e}")

    return UpdateApplyResponse(
        status="triggered",
        message=f"Update to {target} has been triggered. The system will pull new images and restart containers.",
        target_version=target,
    )
