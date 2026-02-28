"""WhatsApp integration API endpoints.

Manages system-wide WhatsApp configuration, QR linking (proxied to engine
via Redis RPC), allowlist CRUD, and agent message sending.

Mirrors the Signal integration API but adds pairing-code support and
ack-reaction configuration.

Endpoints (all under /v1/whatsapp):
  GET    /v1/whatsapp/config              — Read config + link status
  PUT    /v1/whatsapp/config              — Update config
  POST   /v1/whatsapp/link                — Start linking (returns QR data)
  POST   /v1/whatsapp/link/pairing-code   — Get 8-digit pairing code
  GET    /v1/whatsapp/link/status         — Check link status
  POST   /v1/whatsapp/unlink              — Unlink WhatsApp account
  GET    /v1/whatsapp/allowlist           — List allowlist entries
  POST   /v1/whatsapp/allowlist           — Add entry
  PUT    /v1/whatsapp/allowlist/{id}      — Update entry
  DELETE /v1/whatsapp/allowlist/{id}      — Delete entry
  POST   /v1/whatsapp/{agent_id}/send     — Send message as agent
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
from app.models.whatsapp import WhatsAppConfig, WhatsAppAllowlistEntry
from app.models.base import now_ms
from app.logging_config import get_logger

logger = get_logger(__name__)

router = APIRouter()


# ─── Redis RPC helper (API → Engine) ─────────────────────────────────────────


async def _whatsapp_rpc(method: str, params: dict, timeout: float = 10.0) -> dict:
    """Send an RPC request to the engine's WhatsAppBridge via Redis pub/sub.

    Publishes to 'whatsapp:rpc:request' and waits for a reply on
    'whatsapp:rpc:reply:{id}'.
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
        reply_channel = f"whatsapp:rpc:reply:{req_id}"
        await pubsub.subscribe(reply_channel)

        # Publish request
        request = json.dumps({"id": req_id, "method": method, "params": params})
        await pub.publish("whatsapp:rpc:request", request)

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
            detail="WhatsApp engine did not respond in time. Is the engine running?",
        )
    finally:
        await pubsub.unsubscribe(reply_channel)
        await pub.aclose()
        await sub.aclose()


# ─── Schemas ──────────────────────────────────────────────────────────────────


class WhatsAppConfigResponse(BaseModel):
    enabled: bool
    phoneNumber: Optional[str] = None
    linked: bool
    defaultAgentId: Optional[str] = None
    stickyTtlMinutes: int
    allowAll: bool
    ackEmoji: Optional[str] = None


class UpdateWhatsAppConfigRequest(BaseModel):
    enabled: Optional[bool] = None
    defaultAgentId: Optional[str] = None
    stickyTtlMinutes: Optional[int] = None
    allowAll: Optional[bool] = None
    ackEmoji: Optional[str] = None


class LinkResponse(BaseModel):
    qr: str


class PairingCodeRequest(BaseModel):
    phoneNumber: str


class PairingCodeResponse(BaseModel):
    code: str


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


class SendWhatsAppMessageRequest(BaseModel):
    to: str
    message: str
    urgent: bool = False


# ─── Config endpoints ─────────────────────────────────────────────────────────


@router.get("/config", response_model=WhatsAppConfigResponse)
async def get_whatsapp_config(
    session: AsyncSession = Depends(get_async_session),
) -> WhatsAppConfigResponse:
    """Return the system-wide WhatsApp configuration."""
    row = await session.get(WhatsAppConfig, 1)
    if not row:
        return WhatsAppConfigResponse(
            enabled=False,
            phoneNumber=None,
            linked=False,
            defaultAgentId=None,
            stickyTtlMinutes=30,
            allowAll=False,
            ackEmoji=None,
        )
    return WhatsAppConfigResponse(
        enabled=row.enabled,
        phoneNumber=row.phone_number,
        linked=row.linked,
        defaultAgentId=row.default_agent_id,
        stickyTtlMinutes=row.sticky_ttl_minutes,
        allowAll=row.allow_all,
        ackEmoji=row.ack_emoji,
    )


@router.put("/config", response_model=WhatsAppConfigResponse)
async def update_whatsapp_config(
    body: UpdateWhatsAppConfigRequest,
    session: AsyncSession = Depends(get_async_session),
) -> WhatsAppConfigResponse:
    """Update WhatsApp configuration."""
    row = await session.get(WhatsAppConfig, 1)
    if not row:
        row = WhatsAppConfig(
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
    if body.ackEmoji is not None:
        row.ack_emoji = body.ackEmoji if body.ackEmoji else None
    row.updated_at = now_ms()

    await session.commit()
    await session.refresh(row)

    return WhatsAppConfigResponse(
        enabled=row.enabled,
        phoneNumber=row.phone_number,
        linked=row.linked,
        defaultAgentId=row.default_agent_id,
        stickyTtlMinutes=row.sticky_ttl_minutes,
        allowAll=row.allow_all,
        ackEmoji=row.ack_emoji,
    )


# ─── Linking endpoints ────────────────────────────────────────────────────────


@router.post("/link", response_model=LinkResponse)
async def start_whatsapp_link(
    session: AsyncSession = Depends(get_async_session),
) -> LinkResponse:
    """Start the WhatsApp device linking process.

    Returns the latest QR code data string. The dashboard renders this as a
    QR code image. Baileys rotates QR codes every ~20s, so the dashboard
    should poll this endpoint to get fresh QR data.
    """
    result = await _whatsapp_rpc("link", {}, timeout=30.0)
    qr = result.get("qr", "")
    if not qr:
        raise HTTPException(
            status_code=502, detail="WhatsApp engine returned no QR data"
        )
    return LinkResponse(qr=qr)


@router.post("/link/pairing-code", response_model=PairingCodeResponse)
async def get_pairing_code(
    body: PairingCodeRequest,
    session: AsyncSession = Depends(get_async_session),
) -> PairingCodeResponse:
    """Get an 8-digit pairing code as an alternative to QR scanning.

    The user enters this code in their WhatsApp app under
    Settings > Linked Devices > Link a Device > Link with phone number.
    """
    result = await _whatsapp_rpc(
        "pairing_code",
        {"phoneNumber": body.phoneNumber},
        timeout=30.0,
    )
    code = result.get("code", "")
    if not code:
        raise HTTPException(
            status_code=502, detail="WhatsApp engine returned no pairing code"
        )
    return PairingCodeResponse(code=code)


@router.get("/link/status", response_model=LinkStatusResponse)
async def get_link_status(
    session: AsyncSession = Depends(get_async_session),
) -> LinkStatusResponse:
    """Check whether WhatsApp linking has completed."""
    result = await _whatsapp_rpc("link_status", {})
    linked = result.get("linked", False)
    phone = result.get("phoneNumber")

    # Update DB config if newly linked
    if linked and phone:
        row = await session.get(WhatsAppConfig, 1)
        if row and (not row.linked or row.phone_number != phone):
            row.linked = True
            row.phone_number = phone
            row.updated_at = now_ms()
            await session.commit()

    return LinkStatusResponse(linked=linked, phoneNumber=phone)


@router.post("/unlink")
async def unlink_whatsapp(
    session: AsyncSession = Depends(get_async_session),
) -> dict:
    """Unlink the WhatsApp account and clear local auth data."""
    await _whatsapp_rpc("unlink", {})

    # Clear linked state in DB
    row = await session.get(WhatsAppConfig, 1)
    if row:
        row.linked = False
        row.phone_number = None
        row.enabled = False
        row.updated_at = now_ms()
        await session.commit()

    return {"unlinked": True}


# ─── Internal endpoints (engine → API) ────────────────────────────────────────


@router.post("/mark-unlinked", include_in_schema=False)
async def mark_whatsapp_unlinked(
    session: AsyncSession = Depends(get_async_session),
) -> dict:
    """Mark the WhatsApp account as unlinked.

    Called by the engine when Baileys detects the device has been logged out
    (user removed the linked device from their WhatsApp primary app).
    """
    row = await session.get(WhatsAppConfig, 1)
    if row:
        row.linked = False
        row.phone_number = None
        row.enabled = False
        row.updated_at = now_ms()
        await session.commit()
        logger.warning(
            "WhatsApp account marked as unlinked (device removed externally)"
        )
    return {"unlinked": True}


# ─── Allowlist endpoints ──────────────────────────────────────────────────────


@router.get("/allowlist")
async def list_allowlist(
    session: AsyncSession = Depends(get_async_session),
) -> dict:
    """List all WhatsApp allowlist entries."""
    result = await session.execute(
        select(WhatsAppAllowlistEntry).order_by(
            WhatsAppAllowlistEntry.created_at.desc()
        )
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
    """Add a phone number to the WhatsApp allowlist."""
    now = now_ms()
    entry = WhatsAppAllowlistEntry(
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
    entry = await session.get(WhatsAppAllowlistEntry, entry_id)
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
    entry = await session.get(WhatsAppAllowlistEntry, entry_id)
    if entry:
        await session.delete(entry)
        await session.commit()
    return {"status": "ok", "id": entry_id}


# ─── Agent send endpoint ─────────────────────────────────────────────────────


@router.post("/{agent_id}/send")
async def send_whatsapp_message(
    agent_id: str,
    body: SendWhatsAppMessageRequest,
) -> dict:
    """Send a WhatsApp message as a specific agent.

    Proxied to the engine via Redis RPC.
    """
    prefix = "URGENT: " if body.urgent else ""
    result = await _whatsapp_rpc(
        "send",
        {
            "to": body.to,
            "message": f"{prefix}{body.message}",
            "agentId": agent_id,
        },
    )
    return {"status": "ok", "agentId": agent_id, **result}
