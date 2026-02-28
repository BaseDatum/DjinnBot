"""
Agent Messaging Permissions API

Per-agent, per-channel (telegram/whatsapp/signal) target permissions.
Controls which chat IDs / phone numbers / groups an agent's messaging
tools are allowed to send to.

Endpoints:

  GET    /v1/agents/{agent_id}/messaging-permissions
      List all permissions for an agent, optionally filtered by channel.

  PUT    /v1/agents/{agent_id}/messaging-permissions
      Bulk-set permissions for a specific channel (replaces existing).

  POST   /v1/agents/{agent_id}/messaging-permissions
      Add a single permission entry.

  DELETE /v1/agents/{agent_id}/messaging-permissions/{permission_id}
      Remove a single permission entry.
"""

import json
from typing import Optional, List

from fastapi import APIRouter, HTTPException, Depends, Query
from pydantic import BaseModel
from sqlalchemy import select, delete
from sqlalchemy.ext.asyncio import AsyncSession

from app.database import get_async_session
from app.models.agent_messaging_permission import AgentMessagingPermission
from app.utils import now_ms
from app import dependencies
from app.logging_config import get_logger

logger = get_logger(__name__)

router = APIRouter()

# Redis channel — agent-runtime subscribes to invalidate its permission cache
MESSAGING_PERMS_CHANGED_CHANNEL = "djinnbot:messaging-permissions:changed"

VALID_CHANNELS = {"telegram", "whatsapp", "signal"}


async def _publish_perms_changed(agent_id: str, channel: str) -> None:
    """Notify running containers that messaging permissions changed."""
    try:
        if dependencies.redis_client:
            await dependencies.redis_client.publish(
                MESSAGING_PERMS_CHANGED_CHANNEL,
                json.dumps({"agent_id": agent_id, "channel": channel}),
            )
    except Exception:
        pass  # best-effort


# ── Pydantic schemas ───────────────────────────────────────────────────────


class PermissionResponse(BaseModel):
    id: int
    agentId: str
    channel: str
    target: str
    label: Optional[str] = None
    createdAt: int
    updatedAt: int


class CreatePermissionRequest(BaseModel):
    channel: str
    target: str
    label: Optional[str] = None


class BulkSetPermissionsRequest(BaseModel):
    """Replace all permissions for a specific channel."""

    channel: str
    permissions: List[CreatePermissionRequest]


# ── Helpers ────────────────────────────────────────────────────────────────


def _row_to_response(row: AgentMessagingPermission) -> PermissionResponse:
    return PermissionResponse(
        id=row.id,
        agentId=row.agent_id,
        channel=row.channel,
        target=row.target,
        label=row.label,
        createdAt=row.created_at,
        updatedAt=row.updated_at,
    )


def _validate_channel(channel: str) -> None:
    if channel not in VALID_CHANNELS:
        raise HTTPException(
            status_code=400,
            detail=f"Invalid channel '{channel}'. Must be one of: {', '.join(sorted(VALID_CHANNELS))}",
        )


# ── Endpoints ──────────────────────────────────────────────────────────────


@router.get("/{agent_id}/messaging-permissions")
async def list_messaging_permissions(
    agent_id: str,
    channel: Optional[str] = Query(
        None, description="Filter by channel (telegram, whatsapp, signal)"
    ),
    session: AsyncSession = Depends(get_async_session),
) -> dict:
    """List all messaging permissions for an agent, optionally filtered by channel."""
    if channel:
        _validate_channel(channel)

    stmt = select(AgentMessagingPermission).where(
        AgentMessagingPermission.agent_id == agent_id
    )
    if channel:
        stmt = stmt.where(AgentMessagingPermission.channel == channel)
    stmt = stmt.order_by(
        AgentMessagingPermission.channel,
        AgentMessagingPermission.created_at.desc(),
    )

    result = await session.execute(stmt)
    rows = result.scalars().all()
    permissions = [_row_to_response(r) for r in rows]
    return {"permissions": permissions, "total": len(permissions)}


@router.post("/{agent_id}/messaging-permissions", response_model=PermissionResponse)
async def create_messaging_permission(
    agent_id: str,
    body: CreatePermissionRequest,
    session: AsyncSession = Depends(get_async_session),
) -> PermissionResponse:
    """Add a single messaging permission for an agent."""
    _validate_channel(body.channel)

    now = now_ms()
    row = AgentMessagingPermission(
        agent_id=agent_id,
        channel=body.channel,
        target=body.target.strip(),
        label=body.label,
        created_at=now,
        updated_at=now,
    )
    session.add(row)

    try:
        await session.flush()
    except Exception:
        await session.rollback()
        raise HTTPException(
            status_code=409,
            detail=f"Permission for target '{body.target}' on channel '{body.channel}' already exists.",
        )

    await _publish_perms_changed(agent_id, body.channel)
    return _row_to_response(row)


@router.put("/{agent_id}/messaging-permissions")
async def bulk_set_messaging_permissions(
    agent_id: str,
    body: BulkSetPermissionsRequest,
    session: AsyncSession = Depends(get_async_session),
) -> dict:
    """Replace all permissions for a specific channel.

    Deletes existing permissions for this agent+channel and inserts the
    new set. An empty permissions list removes all access.
    """
    _validate_channel(body.channel)

    # Validate all entries belong to the declared channel
    for p in body.permissions:
        if p.channel != body.channel:
            raise HTTPException(
                status_code=400,
                detail=f"All permissions must use channel '{body.channel}', got '{p.channel}'.",
            )

    # Delete existing
    await session.execute(
        delete(AgentMessagingPermission).where(
            AgentMessagingPermission.agent_id == agent_id,
            AgentMessagingPermission.channel == body.channel,
        )
    )

    # Insert new
    now = now_ms()
    rows = []
    for p in body.permissions:
        row = AgentMessagingPermission(
            agent_id=agent_id,
            channel=p.channel,
            target=p.target.strip(),
            label=p.label,
            created_at=now,
            updated_at=now,
        )
        session.add(row)
        rows.append(row)

    await session.flush()
    await _publish_perms_changed(agent_id, body.channel)

    permissions = [_row_to_response(r) for r in rows]
    return {"permissions": permissions, "total": len(permissions)}


@router.delete("/{agent_id}/messaging-permissions/{permission_id}")
async def delete_messaging_permission(
    agent_id: str,
    permission_id: int,
    session: AsyncSession = Depends(get_async_session),
) -> dict:
    """Remove a single messaging permission."""
    row = await session.get(AgentMessagingPermission, permission_id)
    if not row or row.agent_id != agent_id:
        raise HTTPException(status_code=404, detail="Permission not found")

    channel = row.channel
    await session.delete(row)
    await session.flush()
    await _publish_perms_changed(agent_id, channel)

    return {"status": "ok", "id": permission_id}
