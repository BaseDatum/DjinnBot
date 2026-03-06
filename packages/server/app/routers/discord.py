"""Discord channel API — agent-initiated Discord messaging.

Provides REST endpoints for agent tools to send Discord messages,
list channels, and look up users. The engine's DiscordBridge holds
the live bot connections; these endpoints proxy through the engine
via internal HTTP or direct Discord REST API calls using stored tokens.

Endpoints are mounted under /v1/discord/{agent_id}/.
"""

import json
import os
from typing import Optional, List

import httpx
from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy import select

from app.database import get_async_session
from app.models.settings import AgentChannelCredential
from app.logging_config import get_logger

logger = get_logger(__name__)

router = APIRouter()

DISCORD_API_BASE = "https://discord.com/api/v10"


# ─── Helpers ──────────────────────────────────────────────────────────────────


async def _get_discord_token(agent_id: str, session: AsyncSession) -> str:
    """Retrieve the Discord bot token for an agent from the database."""
    row = await session.get(AgentChannelCredential, (agent_id, "discord"))
    if not row or not row.enabled or not row.primary_token:
        raise HTTPException(
            status_code=503,
            detail=(
                f"Discord is not configured for agent '{agent_id}'. "
                "Add a Bot Token in Settings → Channels → Discord."
            ),
        )
    return row.primary_token


def _discord_headers(token: str) -> dict:
    return {
        "Authorization": f"Bot {token}",
        "Content-Type": "application/json",
    }


# ─── Schemas ──────────────────────────────────────────────────────────────────


class SendMessageBody(BaseModel):
    target: str  # channel ID or user ID
    text: str
    thread_id: Optional[str] = None


# ─── Endpoints ────────────────────────────────────────────────────────────────


@router.post("/{agent_id}/send-message")
async def send_discord_message(
    agent_id: str,
    body: SendMessageBody,
    session: AsyncSession = Depends(get_async_session),
) -> dict:
    """Send a message to a Discord channel or DM a user."""
    token = await _get_discord_token(agent_id, session)
    headers = _discord_headers(token)

    channel_id = body.target

    async with httpx.AsyncClient() as client:
        # Check if target is a user ID (try to create/get DM channel)
        # Discord user IDs and channel IDs are both snowflakes, so we try
        # the channel first, and if it fails, try creating a DM.
        payload: dict = {"content": body.text[:2000]}

        # If a thread_id is specified, send to that thread
        target_url = f"{DISCORD_API_BASE}/channels/{channel_id}/messages"

        try:
            res = await client.post(target_url, headers=headers, json=payload)

            if res.status_code == 404:
                # Channel not found — try as a user DM
                dm_res = await client.post(
                    f"{DISCORD_API_BASE}/users/@me/channels",
                    headers=headers,
                    json={"recipient_id": body.target},
                )
                if dm_res.status_code != 200:
                    raise HTTPException(
                        status_code=404,
                        detail=f"Could not find channel or user with ID '{body.target}'",
                    )
                dm_channel = dm_res.json()
                channel_id = dm_channel["id"]
                target_url = f"{DISCORD_API_BASE}/channels/{channel_id}/messages"
                res = await client.post(target_url, headers=headers, json=payload)

            if res.status_code not in (200, 201):
                error_data = (
                    res.json()
                    if res.headers.get("content-type", "").startswith(
                        "application/json"
                    )
                    else {}
                )
                raise HTTPException(
                    status_code=res.status_code,
                    detail=f"Discord API error: {error_data.get('message', res.text[:200])}",
                )

            data = res.json()
            return {"channel_id": data["channel_id"], "message_id": data["id"]}

        except httpx.RequestError as e:
            raise HTTPException(
                status_code=502,
                detail=f"Failed to reach Discord API: {str(e)}",
            )


@router.get("/{agent_id}/channels")
async def list_discord_channels(
    agent_id: str,
    limit: int = 50,
    session: AsyncSession = Depends(get_async_session),
) -> dict:
    """List Discord channels accessible to this agent's bot."""
    token = await _get_discord_token(agent_id, session)
    headers = _discord_headers(token)

    channels = []

    async with httpx.AsyncClient() as client:
        # Get guilds the bot is in
        guilds_res = await client.get(
            f"{DISCORD_API_BASE}/users/@me/guilds",
            headers=headers,
        )
        if guilds_res.status_code != 200:
            raise HTTPException(
                status_code=guilds_res.status_code,
                detail="Failed to fetch guilds from Discord API",
            )

        guilds = guilds_res.json()

        for guild in guilds[:10]:  # Limit to 10 guilds
            guild_channels_res = await client.get(
                f"{DISCORD_API_BASE}/guilds/{guild['id']}/channels",
                headers=headers,
            )
            if guild_channels_res.status_code != 200:
                continue

            guild_channels = guild_channels_res.json()
            for ch in guild_channels:
                # Only include text-based channels
                ch_type = ch.get("type", 0)
                type_name = {
                    0: "text",
                    2: "voice",
                    4: "category",
                    5: "announcement",
                    10: "thread",
                    11: "thread",
                    12: "thread",
                    13: "stage",
                    15: "forum",
                }.get(ch_type, f"type-{ch_type}")
                if ch_type in (0, 5, 10, 11, 12, 15):  # Text-sendable types
                    channels.append(
                        {
                            "id": ch["id"],
                            "name": ch.get("name", "unnamed"),
                            "type": type_name,
                            "guild_name": guild.get("name"),
                            "topic": ch.get("topic"),
                        }
                    )

                if len(channels) >= limit:
                    break
            if len(channels) >= limit:
                break

    return {"channels": channels[:limit], "total": len(channels)}


@router.get("/{agent_id}/users/{user_id}")
async def lookup_discord_user(
    agent_id: str,
    user_id: str,
    session: AsyncSession = Depends(get_async_session),
) -> dict:
    """Look up a Discord user by ID."""
    token = await _get_discord_token(agent_id, session)
    headers = _discord_headers(token)

    async with httpx.AsyncClient() as client:
        res = await client.get(
            f"{DISCORD_API_BASE}/users/{user_id}",
            headers=headers,
        )

        if res.status_code == 404:
            raise HTTPException(status_code=404, detail=f"User '{user_id}' not found")

        if res.status_code != 200:
            raise HTTPException(
                status_code=res.status_code,
                detail=f"Discord API error: {res.text[:200]}",
            )

        data = res.json()
        return {
            "id": data["id"],
            "username": data.get("username", "unknown"),
            "display_name": data.get("global_name"),
            "is_bot": data.get("bot", False),
        }
