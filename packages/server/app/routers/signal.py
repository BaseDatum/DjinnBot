"""Signal integration API endpoints.

Manages system-wide Signal configuration, QR linking (proxied to engine
via Redis RPC), allowlist CRUD, and agent message sending.

Endpoints (all under /v1/signal):
  GET    /v1/signal/config              — Read config + link status
  PUT    /v1/signal/config              — Update config
  POST   /v1/signal/link                — Start linking (returns QR URI)
  GET    /v1/signal/link/status         — Check link status
  POST   /v1/signal/unlink              — Unlink Signal account
  GET    /v1/signal/allowlist           — List allowlist entries
  POST   /v1/signal/allowlist           — Add entry
  PUT    /v1/signal/allowlist/{id}      — Update entry
  DELETE /v1/signal/allowlist/{id}      — Delete entry
  POST   /v1/signal/{agent_id}/send     — Send message as agent
"""

import json
import uuid
import asyncio
from typing import Optional, List

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy import select

from app.database import get_async_session
from app.models.signal import SignalConfig, SignalAllowlistEntry
from app.models.base import now_ms
from app.logging_config import get_logger

logger = get_logger(__name__)

router = APIRouter()


# ─── Redis RPC helper (API → Engine) ─────────────────────────────────────────


async def _signal_rpc(method: str, params: dict, timeout: float = 10.0) -> dict:
    """Send an RPC request to the engine's SignalBridge via Redis pub/sub.

    Publishes to 'signal:rpc:request' and waits for a reply on
    'signal:rpc:reply:{id}'.
    """
    import redis.asyncio as aioredis
    import os

    redis_url = os.environ.get("REDIS_URL", "redis://localhost:6379")
    req_id = str(uuid.uuid4())

    pub = aioredis.from_url(redis_url)
    sub = aioredis.from_url(redis_url)

    try:
        # Subscribe to the reply channel BEFORE publishing the request
        pubsub = sub.pubsub()
        reply_channel = f"signal:rpc:reply:{req_id}"
        await pubsub.subscribe(reply_channel)

        # Publish request
        request = json.dumps({"id": req_id, "method": method, "params": params})
        await pub.publish("signal:rpc:request", request)

        # Wait for reply
        start = asyncio.get_event_loop().time()
        while (asyncio.get_event_loop().time() - start) < timeout:
            msg = await pubsub.get_message(ignore_subscribe_messages=True, timeout=1.0)
            if msg and msg["type"] == "message":
                data = json.loads(msg["data"])
                if data.get("error"):
                    raise HTTPException(status_code=502, detail=data["error"])
                return data.get("result", {})

        raise HTTPException(
            status_code=504,
            detail="Signal engine did not respond in time. Is the engine running?",
        )
    finally:
        await pubsub.unsubscribe(reply_channel)
        await pub.aclose()
        await sub.aclose()


# ─── Schemas ──────────────────────────────────────────────────────────────────


class SignalConfigResponse(BaseModel):
    enabled: bool
    phoneNumber: Optional[str] = None
    linked: bool
    defaultAgentId: Optional[str] = None
    stickyTtlMinutes: int
    allowAll: bool


class UpdateSignalConfigRequest(BaseModel):
    enabled: Optional[bool] = None
    defaultAgentId: Optional[str] = None
    stickyTtlMinutes: Optional[int] = None
    allowAll: Optional[bool] = None


class LinkResponse(BaseModel):
    uri: str


class LinkStatusResponse(BaseModel):
    linked: bool
    phoneNumber: Optional[str] = None


class AllowlistEntryResponse(BaseModel):
    id: int
    phoneNumber: str
    label: Optional[str] = None
    defaultAgentId: Optional[str] = None
    createdAt: int
    updatedAt: int


class CreateAllowlistEntryRequest(BaseModel):
    phoneNumber: str
    label: Optional[str] = None
    defaultAgentId: Optional[str] = None


class UpdateAllowlistEntryRequest(BaseModel):
    phoneNumber: Optional[str] = None
    label: Optional[str] = None
    defaultAgentId: Optional[str] = None


class SendSignalMessageRequest(BaseModel):
    to: str
    message: str
    urgent: bool = False


# ─── Config endpoints ─────────────────────────────────────────────────────────


@router.get("/config", response_model=SignalConfigResponse)
async def get_signal_config(
    session: AsyncSession = Depends(get_async_session),
) -> SignalConfigResponse:
    """Return the system-wide Signal configuration."""
    row = await session.get(SignalConfig, 1)
    if not row:
        return SignalConfigResponse(
            enabled=False,
            phoneNumber=None,
            linked=False,
            defaultAgentId=None,
            stickyTtlMinutes=30,
            allowAll=False,
        )
    return SignalConfigResponse(
        enabled=row.enabled,
        phoneNumber=row.phone_number,
        linked=row.linked,
        defaultAgentId=row.default_agent_id,
        stickyTtlMinutes=row.sticky_ttl_minutes,
        allowAll=row.allow_all,
    )


@router.put("/config", response_model=SignalConfigResponse)
async def update_signal_config(
    body: UpdateSignalConfigRequest,
    session: AsyncSession = Depends(get_async_session),
) -> SignalConfigResponse:
    """Update Signal configuration."""
    row = await session.get(SignalConfig, 1)
    if not row:
        row = SignalConfig(
            id=1,
            enabled=False,
            linked=False,
            sticky_ttl_minutes=30,
            allow_all=False,
            updated_at=now_ms(),
        )
        session.add(row)

    if body.enabled is not None:
        row.enabled = body.enabled
    if body.defaultAgentId is not None:
        row.default_agent_id = body.defaultAgentId if body.defaultAgentId else None
    if body.stickyTtlMinutes is not None:
        row.sticky_ttl_minutes = max(5, min(120, body.stickyTtlMinutes))
    if body.allowAll is not None:
        row.allow_all = body.allowAll
    row.updated_at = now_ms()

    await session.commit()
    await session.refresh(row)

    # Notify the engine to reload config and transition daemon mode if needed.
    # Fire-and-forget via background task so the PUT returns immediately.
    async def _notify_reload():
        try:
            await _signal_rpc("reload_config", {}, timeout=30.0)
        except Exception as e:
            logger.warning("Failed to notify engine of config reload: %s", e)

    asyncio.ensure_future(_notify_reload())

    return SignalConfigResponse(
        enabled=row.enabled,
        phoneNumber=row.phone_number,
        linked=row.linked,
        defaultAgentId=row.default_agent_id,
        stickyTtlMinutes=row.sticky_ttl_minutes,
        allowAll=row.allow_all,
    )


# ─── Linking endpoints ────────────────────────────────────────────────────────


@router.post("/link", response_model=LinkResponse)
async def start_signal_link(
    session: AsyncSession = Depends(get_async_session),
) -> LinkResponse:
    """Start the Signal device linking process.

    Returns a tsdevice:/ URI that the dashboard renders as a QR code.
    The user scans this QR with their Signal app to link the number.
    """
    # Longer timeout: may need to start signal-cli daemon first (up to 30s)
    result = await _signal_rpc("link", {"deviceName": "DjinnBot"}, timeout=45.0)
    uri = result.get("uri", "")
    if not uri:
        raise HTTPException(
            status_code=502, detail="Signal engine returned no link URI"
        )
    return LinkResponse(uri=uri)


@router.get("/link/status", response_model=LinkStatusResponse)
async def get_link_status(
    session: AsyncSession = Depends(get_async_session),
) -> LinkStatusResponse:
    """Check whether Signal linking has completed."""
    result = await _signal_rpc("link_status", {})
    linked = result.get("linked", False)
    phone = result.get("phoneNumber")

    # Update DB config if newly linked
    if linked and phone:
        row = await session.get(SignalConfig, 1)
        if row and (not row.linked or row.phone_number != phone):
            row.linked = True
            row.phone_number = phone
            row.updated_at = now_ms()
            await session.commit()

    return LinkStatusResponse(linked=linked, phoneNumber=phone)


@router.post("/unlink")
async def unlink_signal(
    session: AsyncSession = Depends(get_async_session),
) -> dict:
    """Unlink the Signal account and clear local data."""
    # Longer timeout: may need to start daemon (30s) + unregister from Signal servers
    await _signal_rpc("unlink", {}, timeout=45.0)

    # Clear linked state in DB
    row = await session.get(SignalConfig, 1)
    if row:
        row.linked = False
        row.phone_number = None
        row.enabled = False
        row.updated_at = now_ms()
        await session.commit()

    return {"unlinked": True}


# ─── Allowlist endpoints ──────────────────────────────────────────────────────


@router.get("/allowlist")
async def list_allowlist(
    session: AsyncSession = Depends(get_async_session),
) -> dict:
    """List all Signal allowlist entries."""
    result = await session.execute(
        select(SignalAllowlistEntry).order_by(SignalAllowlistEntry.created_at.desc())
    )
    rows = result.scalars().all()
    entries = [
        AllowlistEntryResponse(
            id=r.id,
            phoneNumber=r.phone_number,
            label=r.label,
            defaultAgentId=r.default_agent_id,
            createdAt=r.created_at,
            updatedAt=r.updated_at,
        )
        for r in rows
    ]
    return {"entries": entries, "total": len(entries)}


@router.post("/allowlist", response_model=AllowlistEntryResponse)
async def create_allowlist_entry(
    body: CreateAllowlistEntryRequest,
    session: AsyncSession = Depends(get_async_session),
) -> AllowlistEntryResponse:
    """Add a phone number to the Signal allowlist."""
    now = now_ms()
    entry = SignalAllowlistEntry(
        phone_number=body.phoneNumber.strip(),
        label=body.label,
        default_agent_id=body.defaultAgentId,
        created_at=now,
        updated_at=now,
    )
    session.add(entry)
    await session.commit()
    await session.refresh(entry)

    return AllowlistEntryResponse(
        id=entry.id,
        phoneNumber=entry.phone_number,
        label=entry.label,
        defaultAgentId=entry.default_agent_id,
        createdAt=entry.created_at,
        updatedAt=entry.updated_at,
    )


@router.put("/allowlist/{entry_id}", response_model=AllowlistEntryResponse)
async def update_allowlist_entry(
    entry_id: int,
    body: UpdateAllowlistEntryRequest,
    session: AsyncSession = Depends(get_async_session),
) -> AllowlistEntryResponse:
    """Update an allowlist entry."""
    entry = await session.get(SignalAllowlistEntry, entry_id)
    if not entry:
        raise HTTPException(status_code=404, detail="Allowlist entry not found")

    if body.phoneNumber is not None:
        entry.phone_number = body.phoneNumber.strip()
    if body.label is not None:
        entry.label = body.label
    if body.defaultAgentId is not None:
        entry.default_agent_id = body.defaultAgentId if body.defaultAgentId else None
    entry.updated_at = now_ms()

    await session.commit()
    await session.refresh(entry)

    return AllowlistEntryResponse(
        id=entry.id,
        phoneNumber=entry.phone_number,
        label=entry.label,
        defaultAgentId=entry.default_agent_id,
        createdAt=entry.created_at,
        updatedAt=entry.updated_at,
    )


@router.delete("/allowlist/{entry_id}")
async def delete_allowlist_entry(
    entry_id: int,
    session: AsyncSession = Depends(get_async_session),
) -> dict:
    """Remove an allowlist entry."""
    entry = await session.get(SignalAllowlistEntry, entry_id)
    if entry:
        await session.delete(entry)
        await session.commit()
    return {"status": "ok", "id": entry_id}


# ─── Agent send endpoint ─────────────────────────────────────────────────────


@router.post("/{agent_id}/send")
async def send_signal_message(
    agent_id: str,
    body: SendSignalMessageRequest,
) -> dict:
    """Send a Signal message as a specific agent.

    Proxied to the engine via Redis RPC.
    """
    prefix = "URGENT: " if body.urgent else ""
    result = await _signal_rpc(
        "send",
        {
            "to": body.to,
            "message": f"{prefix}{body.message}",
            "agentId": agent_id,
        },
    )
    return {"status": "ok", "agentId": agent_id, **result}
