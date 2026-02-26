"""
Browser Cookie Management API

Manages browser cookies that agents can use via Camofox for authenticated
web browsing. Follows the same grant/revoke pattern as MCP tool access.

Endpoints:

  Cookie set management:
    GET    /v1/browser/cookies                              list cookie sets
    POST   /v1/browser/cookies                              upload cookie file
    GET    /v1/browser/cookies/{cookie_set_id}              get cookie set
    DELETE /v1/browser/cookies/{cookie_set_id}              delete cookie set + file

  Agent grants:
    GET    /v1/browser/cookies/agents/{agent_id}            list grants for agent
    POST   /v1/browser/cookies/agents/{agent_id}/{cookie_set_id}/grant   grant
    DELETE /v1/browser/cookies/agents/{agent_id}/{cookie_set_id}         revoke
"""

import json
import os
import shutil
import uuid
from typing import Optional

from fastapi import APIRouter, HTTPException, Depends, UploadFile, File, Form
from pydantic import BaseModel
from sqlalchemy import select, delete
from sqlalchemy.ext.asyncio import AsyncSession

from app.database import get_async_session
from app.models.browser_cookie import BrowserCookieSet, AgentCookieGrant
from app.utils import now_ms
from app import dependencies
from app.logging_config import get_logger

logger = get_logger(__name__)

router = APIRouter()

COOKIES_CHANGED_CHANNEL = "djinnbot:browser:cookies-changed"

# JuiceFS data path — cookie files are stored at /data/cookies/{agent_id}/
DATA_PATH = os.environ.get("DJINN_DATA_PATH", "/data")


async def _publish_cookies_changed(agent_id: str) -> None:
    """Notify running containers that cookie grants changed for this agent."""
    try:
        if dependencies.redis_client:
            await dependencies.redis_client.publish(
                COOKIES_CHANGED_CHANNEL,
                json.dumps({"agent_id": agent_id}),
            )
    except Exception:
        pass


def _parse_netscape_cookies(content: str) -> list[dict]:
    """Parse a Netscape-format cookie file, return list of cookie dicts."""
    cookies = []
    for line in content.splitlines():
        line = line.strip()
        if not line or line.startswith("#"):
            continue
        parts = line.split("\t")
        if len(parts) < 7:
            continue
        domain, _, path, secure, expires, name, value = parts[:7]
        cookies.append(
            {
                "name": name,
                "value": value or "",
                "domain": domain,
                "path": path or "/",
                "expires": int(expires) if expires.isdigit() else -1,
                "secure": secure.lower() == "true",
            }
        )
    return cookies


def _detect_domain(cookies: list[dict]) -> str:
    """Detect the primary domain from a list of cookies."""
    domains: dict[str, int] = {}
    for c in cookies:
        d = c.get("domain", "")
        domains[d] = domains.get(d, 0) + 1
    if not domains:
        return "unknown"
    return max(domains, key=lambda d: domains[d])


def _cookie_file_path(agent_id: str, filename: str) -> str:
    """Absolute path to a cookie file on JuiceFS."""
    return os.path.join(DATA_PATH, "cookies", agent_id, filename)


def _ensure_cookie_dir(agent_id: str) -> str:
    """Ensure the cookies directory exists for an agent."""
    dirpath = os.path.join(DATA_PATH, "cookies", agent_id)
    os.makedirs(dirpath, exist_ok=True)
    return dirpath


# ── Pydantic schemas ───────────────────────────────────────────────────────


class CookieSetResponse(BaseModel):
    id: str
    user_id: str
    name: str
    domain: str
    filename: str
    cookie_count: int
    expires_at: Optional[int] = None
    created_at: int
    updated_at: int
    grants: list[dict] = []


class CookieGrantResponse(BaseModel):
    id: int
    agent_id: str
    cookie_set_id: str
    cookie_set_name: Optional[str] = None
    cookie_set_domain: Optional[str] = None
    granted_by: str
    granted_at: int


# ── Cookie set CRUD ───────────────────────────────────────────────────────


@router.get("/cookies")
async def list_cookie_sets(
    db: AsyncSession = Depends(get_async_session),
):
    """List all browser cookie sets."""
    result = await db.execute(
        select(BrowserCookieSet).order_by(BrowserCookieSet.created_at.desc())
    )
    sets = result.scalars().all()
    return [
        CookieSetResponse(
            id=s.id,
            user_id=s.user_id,
            name=s.name,
            domain=s.domain,
            filename=s.filename,
            cookie_count=s.cookie_count,
            expires_at=s.expires_at,
            created_at=s.created_at,
            updated_at=s.updated_at,
        )
        for s in sets
    ]


@router.post("/cookies")
async def upload_cookie_set(
    name: str = Form(...),
    cookie_file: UploadFile = File(...),
    user_id: str = Form(default="system"),
    db: AsyncSession = Depends(get_async_session),
):
    """Upload a Netscape-format cookie file."""
    content = (await cookie_file.read()).decode("utf-8", errors="replace")

    cookies = _parse_netscape_cookies(content)
    if not cookies:
        raise HTTPException(400, "No valid cookies found in file")

    if len(cookies) > 500:
        raise HTTPException(400, f"Too many cookies ({len(cookies)}). Maximum 500.")

    domain = _detect_domain(cookies)
    cookie_id = f"ck_{uuid.uuid4().hex[:12]}"
    filename = f"{cookie_id}.txt"

    # Find earliest expiry
    expiries = [c["expires"] for c in cookies if c["expires"] > 0]
    expires_at = min(expiries) if expiries else None

    ts = now_ms()
    cookie_set = BrowserCookieSet(
        id=cookie_id,
        user_id=user_id,
        name=name,
        domain=domain,
        filename=filename,
        cookie_count=len(cookies),
        expires_at=expires_at,
        created_at=ts,
        updated_at=ts,
    )
    db.add(cookie_set)
    await db.commit()

    # Write file to a staging area — it gets copied to agent dirs on grant
    staging_dir = os.path.join(DATA_PATH, "cookies", "_staging")
    os.makedirs(staging_dir, exist_ok=True)
    with open(os.path.join(staging_dir, filename), "w") as f:
        f.write(content)

    logger.info(
        "Cookie set uploaded: %s (%s, %d cookies)", cookie_id, domain, len(cookies)
    )

    return CookieSetResponse(
        id=cookie_id,
        user_id=user_id,
        name=name,
        domain=domain,
        filename=filename,
        cookie_count=len(cookies),
        expires_at=expires_at,
        created_at=ts,
        updated_at=ts,
    )


@router.get("/cookies/{cookie_set_id}")
async def get_cookie_set(
    cookie_set_id: str,
    db: AsyncSession = Depends(get_async_session),
):
    """Get a specific cookie set."""
    result = await db.execute(
        select(BrowserCookieSet).where(BrowserCookieSet.id == cookie_set_id)
    )
    cs = result.scalar_one_or_none()
    if not cs:
        raise HTTPException(404, "Cookie set not found")

    # Include grants
    grants_result = await db.execute(
        select(AgentCookieGrant).where(AgentCookieGrant.cookie_set_id == cookie_set_id)
    )
    grants = grants_result.scalars().all()

    return CookieSetResponse(
        id=cs.id,
        user_id=cs.user_id,
        name=cs.name,
        domain=cs.domain,
        filename=cs.filename,
        cookie_count=cs.cookie_count,
        expires_at=cs.expires_at,
        created_at=cs.created_at,
        updated_at=cs.updated_at,
        grants=[
            {
                "agent_id": g.agent_id,
                "granted_by": g.granted_by,
                "granted_at": g.granted_at,
            }
            for g in grants
        ],
    )


@router.delete("/cookies/{cookie_set_id}")
async def delete_cookie_set(
    cookie_set_id: str,
    db: AsyncSession = Depends(get_async_session),
):
    """Delete a cookie set and all its grants + files."""
    result = await db.execute(
        select(BrowserCookieSet).where(BrowserCookieSet.id == cookie_set_id)
    )
    cs = result.scalar_one_or_none()
    if not cs:
        raise HTTPException(404, "Cookie set not found")

    # Get all agents who had grants (to clean up files and notify)
    grants_result = await db.execute(
        select(AgentCookieGrant).where(AgentCookieGrant.cookie_set_id == cookie_set_id)
    )
    grants = grants_result.scalars().all()
    agent_ids = [g.agent_id for g in grants]

    # Delete from DB (cascades to grants)
    await db.delete(cs)
    await db.commit()

    # Clean up files
    staging_path = os.path.join(DATA_PATH, "cookies", "_staging", cs.filename)
    if os.path.exists(staging_path):
        os.remove(staging_path)

    for agent_id in agent_ids:
        agent_path = _cookie_file_path(agent_id, cs.filename)
        if os.path.exists(agent_path):
            os.remove(agent_path)
        await _publish_cookies_changed(agent_id)

    logger.info("Cookie set deleted: %s", cookie_set_id)
    return {"ok": True}


# ── Agent grants ───────────────────────────────────────────────────────────


@router.get("/cookies/agents/{agent_id}")
async def list_agent_cookie_grants(
    agent_id: str,
    db: AsyncSession = Depends(get_async_session),
):
    """List all cookie grants for an agent."""
    result = await db.execute(
        select(AgentCookieGrant).where(AgentCookieGrant.agent_id == agent_id)
    )
    grants = result.scalars().all()

    # Enrich with cookie set info
    response = []
    for g in grants:
        cs_result = await db.execute(
            select(BrowserCookieSet).where(BrowserCookieSet.id == g.cookie_set_id)
        )
        cs = cs_result.scalar_one_or_none()
        response.append(
            CookieGrantResponse(
                id=g.id,
                agent_id=g.agent_id,
                cookie_set_id=g.cookie_set_id,
                cookie_set_name=cs.name if cs else None,
                cookie_set_domain=cs.domain if cs else None,
                granted_by=g.granted_by,
                granted_at=g.granted_at,
            )
        )
    return response


@router.post("/cookies/agents/{agent_id}/{cookie_set_id}/grant")
async def grant_cookies_to_agent(
    agent_id: str,
    cookie_set_id: str,
    db: AsyncSession = Depends(get_async_session),
):
    """Grant an agent access to a cookie set. Copies the cookie file to the agent's directory."""
    # Verify cookie set exists
    cs_result = await db.execute(
        select(BrowserCookieSet).where(BrowserCookieSet.id == cookie_set_id)
    )
    cs = cs_result.scalar_one_or_none()
    if not cs:
        raise HTTPException(404, "Cookie set not found")

    # Check if already granted
    existing = await db.execute(
        select(AgentCookieGrant).where(
            AgentCookieGrant.agent_id == agent_id,
            AgentCookieGrant.cookie_set_id == cookie_set_id,
        )
    )
    if existing.scalar_one_or_none():
        return {"ok": True, "message": "Already granted"}

    # Create grant
    grant = AgentCookieGrant(
        agent_id=agent_id,
        cookie_set_id=cookie_set_id,
        granted_by="ui",
        granted_at=now_ms(),
    )
    db.add(grant)
    await db.commit()

    # Copy cookie file to agent's directory on JuiceFS
    src = os.path.join(DATA_PATH, "cookies", "_staging", cs.filename)
    if os.path.exists(src):
        _ensure_cookie_dir(agent_id)
        dst = _cookie_file_path(agent_id, cs.filename)
        shutil.copy2(src, dst)

    await _publish_cookies_changed(agent_id)
    logger.info("Cookie grant: %s -> %s (%s)", cookie_set_id, agent_id, cs.domain)
    return {"ok": True}


@router.delete("/cookies/agents/{agent_id}/{cookie_set_id}")
async def revoke_cookies_from_agent(
    agent_id: str,
    cookie_set_id: str,
    db: AsyncSession = Depends(get_async_session),
):
    """Revoke an agent's access to a cookie set. Removes the cookie file from the agent's directory."""
    # Find the grant
    result = await db.execute(
        select(AgentCookieGrant).where(
            AgentCookieGrant.agent_id == agent_id,
            AgentCookieGrant.cookie_set_id == cookie_set_id,
        )
    )
    grant = result.scalar_one_or_none()
    if not grant:
        raise HTTPException(404, "Grant not found")

    # Get cookie set info for file cleanup
    cs_result = await db.execute(
        select(BrowserCookieSet).where(BrowserCookieSet.id == cookie_set_id)
    )
    cs = cs_result.scalar_one_or_none()

    await db.delete(grant)
    await db.commit()

    # Remove cookie file from agent's directory
    if cs:
        agent_path = _cookie_file_path(agent_id, cs.filename)
        if os.path.exists(agent_path):
            os.remove(agent_path)

    await _publish_cookies_changed(agent_id)
    logger.info("Cookie revoked: %s from %s", cookie_set_id, agent_id)
    return {"ok": True}
