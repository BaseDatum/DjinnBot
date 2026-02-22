"""User usage endpoints — personal API usage view scoped to the authenticated user."""

import json
from typing import Optional, List, Dict

from fastapi import APIRouter, Depends, Query
from pydantic import BaseModel
from sqlalchemy import select, func
from sqlalchemy.ext.asyncio import AsyncSession

from app.database import get_async_session
from app.auth.dependencies import get_current_user, AuthUser
from app.logging_config import get_logger
from app.models.llm_call_log import LlmCallLog

logger = get_logger(__name__)

router = APIRouter()


# ── Response models ──────────────────────────────────────────────────────────


class UserUsageItem(BaseModel):
    id: str
    type: str  # "chat" or "run"
    agentId: str
    model: Optional[str] = None
    status: str
    keyResolution: Optional[dict] = None
    createdAt: int
    completedAt: Optional[int] = None


class UserUsageSummary(BaseModel):
    totalSessions: int
    totalRuns: int
    totalLlmCalls: int
    totalTokens: int
    totalInputTokens: int
    totalOutputTokens: int
    totalCacheReadTokens: int
    totalCacheWriteTokens: int
    totalCost: float


class UserUsageResponse(BaseModel):
    items: List[UserUsageItem]
    total: int
    hasMore: bool
    summary: UserUsageSummary


@router.get("/usage/me", response_model=UserUsageResponse)
async def get_my_usage(
    user: AuthUser = Depends(get_current_user),
    db: AsyncSession = Depends(get_async_session),
    item_type: Optional[str] = Query(None, alias="type"),
    status_filter: Optional[str] = Query(None, alias="status"),
    limit: int = Query(50, ge=1, le=200),
    offset: int = Query(0, ge=0),
) -> UserUsageResponse:
    """Get the current user's API usage — their chat sessions and pipeline runs."""
    from app.models.chat import ChatSession
    from app.models.run import Run

    user_id = user.id
    items: List[UserUsageItem] = []

    # ── Chat sessions: match on key_resolution.userId ────────────────────
    if item_type is None or item_type == "chat":
        chat_query = select(ChatSession).order_by(ChatSession.created_at.desc())
        if status_filter:
            chat_query = chat_query.where(ChatSession.status == status_filter)

        chat_result = await db.execute(chat_query)
        for cs in chat_result.scalars().all():
            kr = None
            cs_user_id = None
            if cs.key_resolution:
                try:
                    kr = json.loads(cs.key_resolution)
                    cs_user_id = kr.get("userId")
                except (json.JSONDecodeError, TypeError):
                    pass

            if cs_user_id != user_id:
                continue

            items.append(
                UserUsageItem(
                    id=cs.id,
                    type="chat",
                    agentId=cs.agent_id,
                    model=cs.model,
                    status=cs.status,
                    keyResolution=kr,
                    createdAt=cs.created_at,
                    completedAt=cs.completed_at,
                )
            )

    # ── Pipeline runs: match on initiated_by_user_id ─────────────────────
    if item_type is None or item_type == "run":
        run_query = (
            select(Run)
            .where(Run.initiated_by_user_id == user_id)
            .order_by(Run.created_at.desc())
        )
        if status_filter:
            run_query = run_query.where(Run.status == status_filter)

        run_result = await db.execute(run_query)
        for r in run_result.scalars().all():
            kr = None
            if r.key_resolution:
                try:
                    kr = json.loads(r.key_resolution)
                except (json.JSONDecodeError, TypeError):
                    pass

            items.append(
                UserUsageItem(
                    id=r.id,
                    type="run",
                    agentId=r.pipeline_id,
                    model=getattr(r, "model_override", None),
                    status=r.status,
                    keyResolution=kr,
                    createdAt=r.created_at,
                    completedAt=r.completed_at,
                )
            )

    # Sort combined
    items.sort(key=lambda x: x.createdAt, reverse=True)
    total = len(items)
    page_items = items[offset : offset + limit]

    # ── LLM call summary for this user's sessions + runs ─────────────────
    session_ids = [i.id for i in items if i.type == "chat"]
    run_ids = [i.id for i in items if i.type == "run"]

    llm_query = select(
        func.count(LlmCallLog.id).label("call_count"),
        func.coalesce(func.sum(LlmCallLog.total_tokens), 0).label("total_tokens"),
        func.coalesce(func.sum(LlmCallLog.input_tokens), 0).label("input_tokens"),
        func.coalesce(func.sum(LlmCallLog.output_tokens), 0).label("output_tokens"),
        func.coalesce(func.sum(LlmCallLog.cache_read_tokens), 0).label("cache_read"),
        func.coalesce(func.sum(LlmCallLog.cache_write_tokens), 0).label("cache_write"),
        func.coalesce(func.sum(LlmCallLog.cost_total), 0).label("total_cost"),
    )

    from sqlalchemy import or_

    conditions = []
    if session_ids:
        conditions.append(LlmCallLog.session_id.in_(session_ids))
    if run_ids:
        conditions.append(LlmCallLog.run_id.in_(run_ids))

    if conditions:
        llm_query = llm_query.where(or_(*conditions))
        llm_result = await db.execute(llm_query)
        row = llm_result.one()
        summary = UserUsageSummary(
            totalSessions=len(session_ids),
            totalRuns=len(run_ids),
            totalLlmCalls=row.call_count or 0,
            totalTokens=row.total_tokens or 0,
            totalInputTokens=row.input_tokens or 0,
            totalOutputTokens=row.output_tokens or 0,
            totalCacheReadTokens=row.cache_read or 0,
            totalCacheWriteTokens=row.cache_write or 0,
            totalCost=round(row.total_cost or 0, 6),
        )
    else:
        summary = UserUsageSummary(
            totalSessions=0,
            totalRuns=0,
            totalLlmCalls=0,
            totalTokens=0,
            totalInputTokens=0,
            totalOutputTokens=0,
            totalCacheReadTokens=0,
            totalCacheWriteTokens=0,
            totalCost=0,
        )

    return UserUsageResponse(
        items=page_items,
        total=total,
        hasMore=(offset + len(page_items)) < total,
        summary=summary,
    )
