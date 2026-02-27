"""Telegram integration API endpoints.

Per-agent Telegram bot configuration, allowlist CRUD, and message sending.
Unlike Signal (one shared number), each agent gets its own BotFather bot.

Endpoints:
  GET    /v1/telegram/configs                     - List all agent configs
  GET    /v1/telegram/{agent_id}/config            - Read agent config
  PUT    /v1/telegram/{agent_id}/config            - Update config (token, enable/disable)
  GET    /v1/telegram/{agent_id}/status            - Live bot status (Redis RPC)
  GET    /v1/telegram/{agent_id}/allowlist         - List allowlist entries
  POST   /v1/telegram/{agent_id}/allowlist         - Add entry
  PUT    /v1/telegram/{agent_id}/allowlist/{id}    - Update entry
  DELETE /v1/telegram/{agent_id}/allowlist/{id}    - Delete entry
  POST   /v1/telegram/{agent_id}/send              - Send message (Redis RPC)
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
from app.models.telegram import TelegramConfig, TelegramAllowlistEntry
from app.models.base import now_ms
from app.logging_config import get_logger

logger = get_logger(__name__)

router = APIRouter()


# --- Redis RPC helper (API -> Engine) -----------------------------------------


async def _telegram_rpc(method: str, params: dict, timeout: float = 10.0) -> dict:
    """Send an RPC request to the engine's TelegramBridgeManager via Redis pub/sub."""
    import redis.asyncio as aioredis
    import os

    redis_url = os.environ.get("REDIS_URL", "redis://localhost:6379")
    req_id = str(uuid.uuid4())

    pub = aioredis.from_url(redis_url)
    sub = aioredis.from_url(redis_url)

    try:
        pubsub = sub.pubsub()
        reply_channel = f"telegram:rpc:reply:{req_id}"
        await pubsub.subscribe(reply_channel)

        request = json.dumps({"id": req_id, "method": method, "params": params})
        await pub.publish("telegram:rpc:request", request)

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
            detail="Telegram engine did not respond in time. Is the engine running?",
        )
    finally:
        await pubsub.unsubscribe(reply_channel)
        await pub.aclose()
        await sub.aclose()


# --- Schemas ------------------------------------------------------------------


class TelegramConfigResponse(BaseModel):
    agentId: str
    enabled: bool
    botToken: Optional[str] = None  # Masked in response
    botUsername: Optional[str] = None
    allowAll: bool
    updatedAt: int


class UpdateTelegramConfigRequest(BaseModel):
    enabled: Optional[bool] = None
    botToken: Optional[str] = None
    allowAll: Optional[bool] = None


class AllowlistEntryResponse(BaseModel):
    id: int
    agentId: str
    identifier: str
    label: Optional[str] = None
    createdAt: int
    updatedAt: int


class CreateAllowlistEntryRequest(BaseModel):
    identifier: str
    label: Optional[str] = None


class UpdateAllowlistEntryRequest(BaseModel):
    identifier: Optional[str] = None
    label: Optional[str] = None


class SendTelegramMessageRequest(BaseModel):
    chatId: str
    message: str
    urgent: bool = False


class BotStatusResponse(BaseModel):
    active: bool
    agentId: str


# --- Helpers ------------------------------------------------------------------


def _mask_token(token: Optional[str]) -> Optional[str]:
    """Mask a bot token for display: show first 5 and last 4 chars."""
    if not token:
        return None
    if len(token) < 12:
        return "****"
    return f"{token[:5]}...{token[-4:]}"


def _config_to_response(
    row: TelegramConfig, *, unmask: bool = False
) -> TelegramConfigResponse:
    return TelegramConfigResponse(
        agentId=row.agent_id,
        enabled=row.enabled,
        botToken=row.bot_token if unmask else _mask_token(row.bot_token),
        botUsername=row.bot_username,
        allowAll=row.allow_all,
        updatedAt=row.updated_at,
    )


# --- Config endpoints ---------------------------------------------------------


@router.get("/configs")
async def list_telegram_configs(
    session: AsyncSession = Depends(get_async_session),
) -> dict:
    """List all agent Telegram configurations."""
    result = await session.execute(
        select(TelegramConfig).order_by(TelegramConfig.agent_id)
    )
    rows = result.scalars().all()
    configs = [_config_to_response(r) for r in rows]
    return {"configs": configs, "total": len(configs)}


@router.get("/{agent_id}/config", response_model=TelegramConfigResponse)
async def get_telegram_config(
    agent_id: str,
    session: AsyncSession = Depends(get_async_session),
) -> TelegramConfigResponse:
    """Read Telegram configuration for an agent."""
    result = await session.execute(
        select(TelegramConfig).where(TelegramConfig.agent_id == agent_id)
    )
    row = result.scalar_one_or_none()
    if not row:
        return TelegramConfigResponse(
            agentId=agent_id,
            enabled=False,
            botToken=None,
            botUsername=None,
            allowAll=False,
            updatedAt=0,
        )
    return _config_to_response(row)


@router.put("/{agent_id}/config", response_model=TelegramConfigResponse)
async def update_telegram_config(
    agent_id: str,
    body: UpdateTelegramConfigRequest,
    session: AsyncSession = Depends(get_async_session),
) -> TelegramConfigResponse:
    """Update Telegram configuration for an agent.

    After saving, publishes a config change event to Redis so the engine
    hot-reloads the bot without requiring a restart.
    """
    result = await session.execute(
        select(TelegramConfig).where(TelegramConfig.agent_id == agent_id)
    )
    row = result.scalar_one_or_none()

    if not row:
        row = TelegramConfig(
            agent_id=agent_id,
            enabled=False,
            allow_all=False,
            updated_at=now_ms(),
        )
        session.add(row)

    if body.enabled is not None:
        row.enabled = body.enabled
    if body.botToken is not None:
        token = body.botToken.strip()
        row.bot_token = token if token else None
        # Clear cached username when token changes — will be re-resolved on connect
        if token:
            row.bot_username = None
    if body.allowAll is not None:
        row.allow_all = body.allowAll
    row.updated_at = now_ms()

    await session.commit()
    await session.refresh(row)

    # Notify engine of config change (fire-and-forget)
    try:
        import redis.asyncio as aioredis
        import os

        redis_url = os.environ.get("REDIS_URL", "redis://localhost:6379")
        r = aioredis.from_url(redis_url)
        await r.publish(f"telegram:config:changed:{agent_id}", "updated")
        await r.aclose()
    except Exception as e:
        logger.warning(f"Failed to notify engine of Telegram config change: {e}")

    return _config_to_response(row)


# --- Internal endpoints (engine use — unmasked tokens) ------------------------


@router.get("/internal/configs")
async def list_telegram_configs_internal(
    session: AsyncSession = Depends(get_async_session),
) -> dict:
    """List all agent Telegram configurations with unmasked tokens.

    Used by the engine to start bots — tokens must not be masked.
    """
    result = await session.execute(
        select(TelegramConfig).order_by(TelegramConfig.agent_id)
    )
    rows = result.scalars().all()
    configs = [_config_to_response(r, unmask=True) for r in rows]
    return {"configs": configs, "total": len(configs)}


@router.get("/internal/{agent_id}/config", response_model=TelegramConfigResponse)
async def get_telegram_config_internal(
    agent_id: str,
    session: AsyncSession = Depends(get_async_session),
) -> TelegramConfigResponse:
    """Read Telegram configuration for an agent with unmasked token.

    Used by the engine on config reload — token must not be masked.
    """
    result = await session.execute(
        select(TelegramConfig).where(TelegramConfig.agent_id == agent_id)
    )
    row = result.scalar_one_or_none()
    if not row:
        return TelegramConfigResponse(
            agentId=agent_id,
            enabled=False,
            botToken=None,
            botUsername=None,
            allowAll=False,
            updatedAt=0,
        )
    return _config_to_response(row, unmask=True)


# --- Status endpoint ----------------------------------------------------------


@router.get("/{agent_id}/status", response_model=BotStatusResponse)
async def get_telegram_status(agent_id: str) -> BotStatusResponse:
    """Check whether the Telegram bot for an agent is actively running."""
    try:
        result = await _telegram_rpc("status", {"agentId": agent_id})
        return BotStatusResponse(
            active=result.get("active", False),
            agentId=agent_id,
        )
    except HTTPException:
        return BotStatusResponse(active=False, agentId=agent_id)


# --- Allowlist endpoints ------------------------------------------------------


@router.get("/{agent_id}/allowlist")
async def list_allowlist(
    agent_id: str,
    session: AsyncSession = Depends(get_async_session),
) -> dict:
    """List all Telegram allowlist entries for an agent."""
    result = await session.execute(
        select(TelegramAllowlistEntry)
        .where(TelegramAllowlistEntry.agent_id == agent_id)
        .order_by(TelegramAllowlistEntry.created_at.desc())
    )
    rows = result.scalars().all()
    entries = [
        AllowlistEntryResponse(
            id=r.id,
            agentId=r.agent_id,
            identifier=r.identifier,
            label=r.label,
            createdAt=r.created_at,
            updatedAt=r.updated_at,
        )
        for r in rows
    ]
    return {"entries": entries, "total": len(entries)}


@router.post("/{agent_id}/allowlist", response_model=AllowlistEntryResponse)
async def create_allowlist_entry(
    agent_id: str,
    body: CreateAllowlistEntryRequest,
    session: AsyncSession = Depends(get_async_session),
) -> AllowlistEntryResponse:
    """Add an entry to an agent's Telegram allowlist."""
    now = now_ms()
    entry = TelegramAllowlistEntry(
        agent_id=agent_id,
        identifier=body.identifier.strip(),
        label=body.label,
        created_at=now,
        updated_at=now,
    )
    session.add(entry)
    await session.commit()
    await session.refresh(entry)

    return AllowlistEntryResponse(
        id=entry.id,
        agentId=entry.agent_id,
        identifier=entry.identifier,
        label=entry.label,
        createdAt=entry.created_at,
        updatedAt=entry.updated_at,
    )


@router.put("/{agent_id}/allowlist/{entry_id}", response_model=AllowlistEntryResponse)
async def update_allowlist_entry(
    agent_id: str,
    entry_id: int,
    body: UpdateAllowlistEntryRequest,
    session: AsyncSession = Depends(get_async_session),
) -> AllowlistEntryResponse:
    """Update an allowlist entry."""
    entry = await session.get(TelegramAllowlistEntry, entry_id)
    if not entry or entry.agent_id != agent_id:
        raise HTTPException(status_code=404, detail="Allowlist entry not found")

    if body.identifier is not None:
        entry.identifier = body.identifier.strip()
    if body.label is not None:
        entry.label = body.label
    entry.updated_at = now_ms()

    await session.commit()
    await session.refresh(entry)

    return AllowlistEntryResponse(
        id=entry.id,
        agentId=entry.agent_id,
        identifier=entry.identifier,
        label=entry.label,
        createdAt=entry.created_at,
        updatedAt=entry.updated_at,
    )


@router.delete("/{agent_id}/allowlist/{entry_id}")
async def delete_allowlist_entry(
    agent_id: str,
    entry_id: int,
    session: AsyncSession = Depends(get_async_session),
) -> dict:
    """Remove an allowlist entry."""
    entry = await session.get(TelegramAllowlistEntry, entry_id)
    if entry and entry.agent_id == agent_id:
        await session.delete(entry)
        await session.commit()
    return {"status": "ok", "id": entry_id}


# --- Agent send endpoint -----------------------------------------------------


@router.post("/{agent_id}/send")
async def send_telegram_message(
    agent_id: str,
    body: SendTelegramMessageRequest,
) -> dict:
    """Send a Telegram message as a specific agent.

    Proxied to the engine via Redis RPC. The engine uses the agent's
    bot token to send the message.
    """
    prefix = "URGENT: " if body.urgent else ""
    result = await _telegram_rpc(
        "send",
        {
            "agentId": agent_id,
            "chatId": body.chatId,
            "message": f"{prefix}{body.message}",
        },
    )
    return {"status": "ok", "agentId": agent_id, **result}
