"""
Slack proxy endpoints for agent-runtime containers.

Agents call these endpoints to perform Slack actions using their own
bot token (stored in agent_channel_credentials). The server acts as
a proxy — it fetches the agent's token, makes the Slack API call, and
returns the result. This keeps Slack tokens out of containers entirely.

Endpoints (all under /v1/slack):
  POST /v1/slack/{agent_id}/send-message
      Post a message to a Slack channel (or thread).

  GET  /v1/slack/{agent_id}/channels
      List all public/private channels the bot is a member of.

  GET  /v1/slack/{agent_id}/channels/lookup
      Look up a channel ID by name.
"""

from typing import Optional
from fastapi import APIRouter, HTTPException, Depends
from pydantic import BaseModel
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy import select

from app.database import get_async_session
from app.models.settings import AgentChannelCredential
from app.logging_config import get_logger

logger = get_logger(__name__)

router = APIRouter()


# ── Helpers ───────────────────────────────────────────────────────────────────


async def _get_bot_token(agent_id: str, session: AsyncSession) -> str:
    """Fetch and return the Slack bot token for an agent, or raise 404/503."""
    row = await session.get(AgentChannelCredential, (agent_id, "slack"))
    if not row or not row.enabled:
        raise HTTPException(
            status_code=503,
            detail=(
                f"Agent {agent_id} does not have Slack configured. "
                "Add a Bot Token in Settings → Channels → Slack."
            ),
        )
    if not row.primary_token:
        raise HTTPException(
            status_code=503,
            detail=f"Agent {agent_id} is missing a Slack Bot Token.",
        )
    return row.primary_token


async def _slack_api(
    bot_token: str,
    method: str,
    payload: dict,
) -> dict:
    """POST to a Slack Web API method and return the parsed JSON response."""
    import httpx

    url = f"https://slack.com/api/{method}"
    headers = {
        "Authorization": f"Bearer {bot_token}",
        "Content-Type": "application/json; charset=utf-8",
    }
    async with httpx.AsyncClient(timeout=15.0) as client:
        resp = await client.post(url, json=payload, headers=headers)
        resp.raise_for_status()
        data = resp.json()

    if not data.get("ok"):
        error = data.get("error", "unknown_error")
        raise HTTPException(
            status_code=400,
            detail=f"Slack API error ({method}): {error}",
        )
    return data


# ── Schemas ───────────────────────────────────────────────────────────────────


class SendMessageRequest(BaseModel):
    channel: str
    """Channel ID (C…) or name (#general). IDs are preferred."""

    text: str
    """Message text (supports Slack mrkdwn)."""

    thread_ts: Optional[str] = None
    """Optional thread timestamp to reply into a thread."""

    unfurl_links: bool = False
    unfurl_media: bool = True


class SendMessageResponse(BaseModel):
    ok: bool
    channel: str
    ts: str
    message_text: str


class ChannelEntry(BaseModel):
    id: str
    name: str
    is_private: bool
    is_member: bool
    num_members: Optional[int] = None
    topic: Optional[str] = None
    purpose: Optional[str] = None


class ListChannelsResponse(BaseModel):
    channels: list[ChannelEntry]
    total: int


class LookupChannelResponse(BaseModel):
    id: str
    name: str
    is_private: bool
    is_member: bool


# ── Endpoints ─────────────────────────────────────────────────────────────────


@router.post("/{agent_id}/send-message", response_model=SendMessageResponse)
async def send_slack_message(
    agent_id: str,
    body: SendMessageRequest,
    session: AsyncSession = Depends(get_async_session),
) -> SendMessageResponse:
    """Post a message to a Slack channel on behalf of an agent.

    The agent's Slack bot token is retrieved from the database and used
    to call chat.postMessage. The channel can be provided as a channel
    ID (C…) or a channel name with or without the leading #.
    """
    bot_token = await _get_bot_token(agent_id, session)

    # Normalise channel name → strip leading #
    channel = body.channel.lstrip("#")

    payload: dict = {
        "channel": channel,
        "text": body.text,
        "unfurl_links": body.unfurl_links,
        "unfurl_media": body.unfurl_media,
    }
    if body.thread_ts:
        payload["thread_ts"] = body.thread_ts

    data = await _slack_api(bot_token, "chat.postMessage", payload)

    logger.info(
        f"[Slack] Agent {agent_id} posted to #{channel}: "
        f'"{body.text[:60]}{"…" if len(body.text) > 60 else ""}"'
    )

    return SendMessageResponse(
        ok=True,
        channel=data["channel"],
        ts=data["ts"],
        message_text=body.text,
    )


@router.get("/{agent_id}/channels", response_model=ListChannelsResponse)
async def list_slack_channels(
    agent_id: str,
    limit: int = 200,
    session: AsyncSession = Depends(get_async_session),
) -> ListChannelsResponse:
    """Return all Slack channels the agent's bot is a member of.

    Fetches both public and private channels where the bot has been
    invited. The bot can only send messages to channels it is a member
    of, so this list reflects exactly what channels are available.

    Pass limit (default 200, max 1000) to control how many channels are
    returned. For workspaces with many channels, use /channels/lookup to
    find a specific channel by name instead.
    """
    bot_token = await _get_bot_token(agent_id, session)

    # Clamp limit to Slack's allowed range
    clamped_limit = max(1, min(limit, 1000))

    data = await _slack_api(
        bot_token,
        "conversations.list",
        {
            # Only channels the bot is a member of — covers public + private
            "types": "public_channel,private_channel",
            "exclude_archived": True,
            "limit": clamped_limit,
        },
    )

    channels: list[ChannelEntry] = []
    for ch in data.get("channels", []):
        channels.append(
            ChannelEntry(
                id=ch["id"],
                name=ch.get("name", ""),
                is_private=ch.get("is_private", False),
                is_member=ch.get("is_member", False),
                num_members=ch.get("num_members"),
                topic=ch.get("topic", {}).get("value") or None,
                purpose=ch.get("purpose", {}).get("value") or None,
            )
        )

    return ListChannelsResponse(channels=channels, total=len(channels))


@router.get("/{agent_id}/channels/lookup", response_model=LookupChannelResponse)
async def lookup_slack_channel(
    agent_id: str,
    name: str,
    session: AsyncSession = Depends(get_async_session),
) -> LookupChannelResponse:
    """Look up a Slack channel ID by its name.

    The name is matched case-insensitively and the leading # is
    optional. Returns the first matching channel.

    Use this when you know the channel name but need the ID to post a
    message (IDs are more reliable than names when channels are renamed).
    """
    bot_token = await _get_bot_token(agent_id, session)

    # Normalise: strip leading # and lowercase
    target = name.lstrip("#").lower()

    # Paginate through all channels to find the name match.
    # Slack's search.channels is team-level and requires additional scopes;
    # paginating conversations.list is safer.
    cursor: Optional[str] = None
    while True:
        payload: dict = {
            "types": "public_channel,private_channel",
            "exclude_archived": True,
            "limit": 200,
        }
        if cursor:
            payload["cursor"] = cursor

        data = await _slack_api(bot_token, "conversations.list", payload)

        for ch in data.get("channels", []):
            if ch.get("name", "").lower() == target:
                return LookupChannelResponse(
                    id=ch["id"],
                    name=ch.get("name", ""),
                    is_private=ch.get("is_private", False),
                    is_member=ch.get("is_member", False),
                )

        next_cursor = data.get("response_metadata", {}).get("next_cursor") or ""
        if not next_cursor:
            break
        cursor = next_cursor

    raise HTTPException(
        status_code=404,
        detail=(
            f"No Slack channel named '{name}' was found (or the bot is not a member). "
            "Join the channel in Slack first, then try again."
        ),
    )
