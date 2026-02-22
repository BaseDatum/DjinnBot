"""
Agent Built-in Tool Override API

Endpoints:

  GET    /v1/agents/{agent_id}/tools/overrides
      Returns the current enabled/disabled state for every built-in tool.
      Tools absent from the DB are implicitly enabled.

  PUT    /v1/agents/{agent_id}/tools/overrides
      Bulk-upsert override records.
      Body: list of {tool_name, enabled} objects.
      Publishes a Redis broadcast so running containers pick up changes.

  DELETE /v1/agents/{agent_id}/tools/overrides/{tool_name}
      Remove the override row for a single tool (restores implicit-enabled).
"""

import json
from typing import Optional
from fastapi import APIRouter, HTTPException, Depends
from pydantic import BaseModel
from sqlalchemy import select, delete
from sqlalchemy.ext.asyncio import AsyncSession

from app.database import get_async_session
from app.models.agent_tool_override import AgentToolOverride
from app.utils import now_ms
from app import dependencies
from app.logging_config import get_logger

logger = get_logger(__name__)

router = APIRouter()

# Redis channel — running agent containers subscribe to this to invalidate
# their tool cache and pick up override changes on the next turn.
TOOL_OVERRIDES_CHANGED_CHANNEL = "djinnbot:tools:overrides-changed"


async def _publish_overrides_changed(agent_id: str) -> None:
    """Notify running containers that tool overrides changed for this agent."""
    try:
        if dependencies.redis_client:
            await dependencies.redis_client.publish(
                TOOL_OVERRIDES_CHANGED_CHANNEL,
                json.dumps({"agent_id": agent_id}),
            )
    except Exception:
        pass  # best-effort; container picks up on restart


# ── Pydantic schemas ───────────────────────────────────────────────────────────


class ToolOverrideItem(BaseModel):
    tool_name: str
    enabled: bool


class ToolOverrideResponse(BaseModel):
    agent_id: str
    tool_name: str
    enabled: bool
    updated_at: int
    updated_by: str


class BulkUpsertRequest(BaseModel):
    overrides: list[ToolOverrideItem]
    updated_by: Optional[str] = "ui"


# ── Endpoints ──────────────────────────────────────────────────────────────────


@router.get("/{agent_id}/tools/overrides", response_model=list[ToolOverrideResponse])
async def get_tool_overrides(
    agent_id: str,
    session: AsyncSession = Depends(get_async_session),
):
    """Return all override records for this agent.

    Only rows that exist in the DB are returned.  A tool absent from this
    list is implicitly enabled.
    """
    result = await session.execute(
        select(AgentToolOverride).where(AgentToolOverride.agent_id == agent_id)
    )
    rows = result.scalars().all()
    return [
        ToolOverrideResponse(
            agent_id=r.agent_id,
            tool_name=r.tool_name,
            enabled=r.enabled,
            updated_at=r.updated_at,
            updated_by=r.updated_by,
        )
        for r in rows
    ]


@router.put("/{agent_id}/tools/overrides", response_model=list[ToolOverrideResponse])
async def upsert_tool_overrides(
    agent_id: str,
    req: BulkUpsertRequest,
    session: AsyncSession = Depends(get_async_session),
):
    """Bulk-upsert tool override records.

    For each item in the body:
      - If a row for (agent_id, tool_name) already exists, update enabled/updated_at.
      - Otherwise, insert a new row.

    Returns the updated state of all submitted tool overrides.
    """
    if not req.overrides:
        raise HTTPException(status_code=400, detail="overrides list must not be empty")

    now = now_ms()
    updated_by = req.updated_by or "ui"

    # Fetch existing rows for this agent (one DB round-trip)
    existing_result = await session.execute(
        select(AgentToolOverride).where(AgentToolOverride.agent_id == agent_id)
    )
    existing_map: dict[str, AgentToolOverride] = {
        r.tool_name: r for r in existing_result.scalars().all()
    }

    results: list[AgentToolOverride] = []
    for item in req.overrides:
        if item.tool_name in existing_map:
            row = existing_map[item.tool_name]
            row.enabled = item.enabled
            row.updated_at = now
            row.updated_by = updated_by
        else:
            row = AgentToolOverride(
                agent_id=agent_id,
                tool_name=item.tool_name,
                enabled=item.enabled,
                updated_at=now,
                updated_by=updated_by,
            )
            session.add(row)
        results.append(row)

    await session.flush()

    await _publish_overrides_changed(agent_id)

    return [
        ToolOverrideResponse(
            agent_id=agent_id,
            tool_name=r.tool_name,
            enabled=r.enabled,
            updated_at=r.updated_at,
            updated_by=r.updated_by,
        )
        for r in results
    ]


@router.delete("/{agent_id}/tools/overrides/{tool_name}", status_code=204)
async def delete_tool_override(
    agent_id: str,
    tool_name: str,
    session: AsyncSession = Depends(get_async_session),
):
    """Remove the override for a single tool (restores implicit-enabled state)."""
    await session.execute(
        delete(AgentToolOverride).where(
            AgentToolOverride.agent_id == agent_id,
            AgentToolOverride.tool_name == tool_name,
        )
    )
    await _publish_overrides_changed(agent_id)
    return None


@router.get("/{agent_id}/tools/disabled", response_model=list[str])
async def get_disabled_tools(
    agent_id: str,
    session: AsyncSession = Depends(get_async_session),
):
    """Return just the list of disabled tool names for this agent.

    This is the lightweight endpoint called by the agent-runtime on startup
    (and on broadcast invalidation) to know which tools to filter out.
    """
    result = await session.execute(
        select(AgentToolOverride.tool_name).where(
            AgentToolOverride.agent_id == agent_id,
            AgentToolOverride.enabled == False,  # noqa: E712
        )
    )
    return result.scalars().all()
