"""Agent channel credentials API (Slack, and future integrations).

Each agent can have credentials for one or more channels (e.g. "slack").
Credentials are stored in agent_channel_credentials and follow the same
lifecycle as model_providers:

  1. Engine syncs env vars → DB at startup (non-destructive if DB already set).
  2. Dashboard UI can view (masked) and update credentials at any time.
  3. Engine reads from DB at runtime so the agent gets the correct tokens.

Endpoints are mounted under /v1/agents/{agent_id}/channels.
"""

import json
import os
from typing import Optional, List, Dict

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy import select

from app.database import get_async_session
from app.models.settings import AgentChannelCredential
from app.models.base import now_ms
from app.logging_config import get_logger

logger = get_logger(__name__)

router = APIRouter()

AGENTS_DIR = os.environ.get("AGENTS_DIR", "/data/agents")

# ─── Channel catalog ──────────────────────────────────────────────────────────
# One entry per supported channel integration.  Each entry describes the two
# tokens and any optional extra fields so the UI can render a consistent form.

CHANNEL_CATALOG: Dict[str, dict] = {
    "whatsapp": {
        "name": "WhatsApp",
        "description": "Enable this agent for WhatsApp messaging via the shared platform number.",
        "primaryTokenLabel": None,
        "primaryTokenEnvVarSuffix": None,
        "primaryTokenPlaceholder": None,
        "primaryTokenHint": None,
        "secondaryTokenLabel": None,
        "secondaryTokenEnvVarSuffix": None,
        "secondaryTokenHint": None,
        "extraFields": [],
        "docsUrl": None,
        "sharedChannel": True,
    },
    "signal": {
        "name": "Signal",
        "description": "Enable this agent for Signal messaging via the shared platform number.",
        "primaryTokenLabel": None,
        "primaryTokenEnvVarSuffix": None,
        "primaryTokenPlaceholder": None,
        "primaryTokenHint": None,
        "secondaryTokenLabel": None,
        "secondaryTokenEnvVarSuffix": None,
        "secondaryTokenHint": None,
        "extraFields": [],
        "docsUrl": None,
        "sharedChannel": True,
    },
    "slack": {
        "name": "Slack",
        "description": "Connect this agent to a Slack workspace as a bot.",
        "primaryTokenLabel": "Bot Token",
        "primaryTokenEnvVarSuffix": "BOT_TOKEN",
        "primaryTokenPlaceholder": "xoxb-...",
        "primaryTokenHint": (
            "The Bot User OAuth Token from your Slack app. "
            "Starts with xoxb-. Required for posting messages."
        ),
        "secondaryTokenLabel": "App-Level Token",
        "secondaryTokenEnvVarSuffix": "APP_TOKEN",
        "secondaryTokenPlaceholder": "xapp-...",
        "secondaryTokenHint": (
            "App-level token with the connections:write scope. "
            "Starts with xapp-. Required for Socket Mode (real-time events)."
        ),
        "extraFields": [
            {
                "key": "bot_user_id",
                "label": "Bot User ID",
                "placeholder": "U0ABC1234",
                "description": (
                    "Optional. The Slack user ID of the bot (e.g. U0ABC1234). "
                    "Used to detect self-mentions. Can be left blank — "
                    "the agent will resolve it automatically on first connection."
                ),
                "secret": False,
            }
        ],
        "docsUrl": "https://api.slack.com/apps",
    },
}


# ─── Helpers ──────────────────────────────────────────────────────────────────


def _mask(value: str) -> str:
    """Return a masked representation: first 8 chars + '...' + last 4 chars."""
    if not value or len(value) < 8:
        return "***"
    return f"{value[:8]}...{value[-4:]}"


def _parse_extra(row: AgentChannelCredential) -> Dict[str, str]:
    if not row.extra_config:
        return {}
    try:
        return json.loads(row.extra_config)
    except (json.JSONDecodeError, TypeError):
        return {}


def _build_response(
    agent_id: str, channel: str, row: Optional[AgentChannelCredential]
) -> dict:
    catalog = CHANNEL_CATALOG[channel]
    # Shared channels (Signal) don't need tokens — just enabled flag.
    is_shared = catalog.get("sharedChannel", False)
    configured = (
        bool(row and row.enabled)
        if is_shared
        else bool(row and row.primary_token and row.secondary_token)
    )
    extra = _parse_extra(row) if row else {}

    masked_extra: Dict[str, str] = {}
    for field in catalog["extraFields"]:
        val = extra.get(field["key"])
        if val:
            masked_extra[field["key"]] = _mask(val) if field.get("secret") else val

    return {
        "agentId": agent_id,
        "channel": channel,
        "name": catalog["name"],
        "description": catalog["description"],
        "docsUrl": catalog["docsUrl"],
        "configured": configured,
        "enabled": row.enabled if row else False,
        "primaryTokenLabel": catalog["primaryTokenLabel"],
        "primaryTokenEnvVarSuffix": catalog["primaryTokenEnvVarSuffix"],
        "primaryTokenHint": catalog["primaryTokenHint"],
        "maskedPrimaryToken": _mask(row.primary_token)
        if (row and row.primary_token)
        else None,
        "secondaryTokenLabel": catalog["secondaryTokenLabel"],
        "secondaryTokenEnvVarSuffix": catalog["secondaryTokenEnvVarSuffix"],
        "secondaryTokenHint": catalog["secondaryTokenHint"],
        "maskedSecondaryToken": _mask(row.secondary_token)
        if (row and row.secondary_token)
        else None,
        "extraFields": catalog["extraFields"],
        "maskedExtra": masked_extra if masked_extra else None,
    }


# ─── Schemas ──────────────────────────────────────────────────────────────────


class UpsertChannelCredentials(BaseModel):
    enabled: bool = True
    primaryToken: Optional[str] = None
    secondaryToken: Optional[str] = None
    # Arbitrary extra config (e.g. {"bot_user_id": "U0ABC"})
    extraConfig: Optional[Dict[str, str]] = None


# ─── Endpoints ────────────────────────────────────────────────────────────────


@router.get("/{agent_id}/channels")
async def list_agent_channels(
    agent_id: str,
    session: AsyncSession = Depends(get_async_session),
) -> List[dict]:
    """Return all channel configurations (with masked tokens) for an agent."""
    agent_dir = os.path.join(AGENTS_DIR, agent_id)
    if not os.path.isdir(agent_dir):
        raise HTTPException(status_code=404, detail=f"Agent {agent_id} not found")

    result = await session.execute(
        select(AgentChannelCredential).where(
            AgentChannelCredential.agent_id == agent_id
        )
    )
    rows_by_channel: Dict[str, AgentChannelCredential] = {
        row.channel: row for row in result.scalars().all()
    }

    return [
        _build_response(agent_id, channel, rows_by_channel.get(channel))
        for channel in CHANNEL_CATALOG
    ]


@router.get("/{agent_id}/channels/{channel}")
async def get_agent_channel(
    agent_id: str,
    channel: str,
    session: AsyncSession = Depends(get_async_session),
) -> dict:
    """Return credentials (masked) for a single channel."""
    if channel not in CHANNEL_CATALOG:
        raise HTTPException(status_code=404, detail=f"Unknown channel: {channel}")

    agent_dir = os.path.join(AGENTS_DIR, agent_id)
    if not os.path.isdir(agent_dir):
        raise HTTPException(status_code=404, detail=f"Agent {agent_id} not found")

    row = await session.get(AgentChannelCredential, (agent_id, channel))
    return _build_response(agent_id, channel, row)


@router.put("/{agent_id}/channels/{channel}")
async def upsert_agent_channel(
    agent_id: str,
    channel: str,
    body: UpsertChannelCredentials,
    session: AsyncSession = Depends(get_async_session),
) -> dict:
    """Create or update channel credentials for an agent."""
    if channel not in CHANNEL_CATALOG:
        raise HTTPException(status_code=404, detail=f"Unknown channel: {channel}")

    agent_dir = os.path.join(AGENTS_DIR, agent_id)
    if not os.path.isdir(agent_dir):
        raise HTTPException(status_code=404, detail=f"Agent {agent_id} not found")

    now = now_ms()
    row = await session.get(AgentChannelCredential, (agent_id, channel))

    if row:
        row.enabled = body.enabled
        if body.primaryToken:
            row.primary_token = body.primaryToken
        if body.secondaryToken:
            row.secondary_token = body.secondaryToken
        if body.extraConfig is not None:
            existing_extra = _parse_extra(row)
            merged = {**existing_extra}
            for k, v in body.extraConfig.items():
                if v:
                    merged[k] = v
                elif k in merged:
                    del merged[k]
            row.extra_config = json.dumps(merged) if merged else None
        row.updated_at = now
    else:
        row = AgentChannelCredential(
            agent_id=agent_id,
            channel=channel,
            primary_token=body.primaryToken or None,
            secondary_token=body.secondaryToken or None,
            extra_config=json.dumps(body.extraConfig) if body.extraConfig else None,
            enabled=body.enabled,
            created_at=now,
            updated_at=now,
        )
        session.add(row)

    await session.commit()
    await session.refresh(row)
    return _build_response(agent_id, channel, row)


@router.delete("/{agent_id}/channels/{channel}")
async def remove_agent_channel(
    agent_id: str,
    channel: str,
    session: AsyncSession = Depends(get_async_session),
) -> dict:
    """Remove channel credentials for an agent."""
    if channel not in CHANNEL_CATALOG:
        raise HTTPException(status_code=404, detail=f"Unknown channel: {channel}")

    row = await session.get(AgentChannelCredential, (agent_id, channel))
    if row:
        await session.delete(row)
        await session.commit()

    return {"status": "ok", "agentId": agent_id, "channel": channel}


# ─── Internal: read all Slack credentials from the DB (used by engine sync) ──


@router.get("/{agent_id}/channels/keys/all")
async def get_all_channel_keys(
    agent_id: str,
    session: AsyncSession = Depends(get_async_session),
) -> dict:
    """
    Return all configured channel tokens for an agent.
    Used by the engine to retrieve credentials without the masking layer.

    Returns:
      channels: { channel: { primaryToken, secondaryToken, extra: {...} } }
    """
    result = await session.execute(
        select(AgentChannelCredential).where(
            AgentChannelCredential.agent_id == agent_id
        )
    )
    rows = result.scalars().all()

    channels: Dict[str, dict] = {}
    for row in rows:
        if not row.enabled:
            continue
        channels[row.channel] = {
            "primaryToken": row.primary_token,
            "secondaryToken": row.secondary_token,
            "extra": _parse_extra(row),
        }

    return {"channels": channels}
