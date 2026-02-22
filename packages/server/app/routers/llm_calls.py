"""LLM call log endpoints — record and query per-API-call usage data."""

import json
from typing import Optional, List

from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel
from sqlalchemy import select, func, desc
from sqlalchemy.ext.asyncio import AsyncSession

from app.database import get_async_session
from app.auth.dependencies import get_current_admin, get_service_or_user, AuthUser
from app.models.llm_call_log import LlmCallLog
from app.logging_config import get_logger
from app.utils import gen_id, now_ms

logger = get_logger(__name__)

router = APIRouter()


# ── Request / Response models ────────────────────────────────────────────────


class RecordLlmCallRequest(BaseModel):
    """Payload sent by agent runtime after each LLM API call."""

    session_id: Optional[str] = None
    run_id: Optional[str] = None
    agent_id: str
    request_id: Optional[str] = None
    provider: str
    model: str
    key_source: Optional[str] = None
    key_masked: Optional[str] = None
    input_tokens: int = 0
    output_tokens: int = 0
    cache_read_tokens: int = 0
    cache_write_tokens: int = 0
    total_tokens: int = 0
    cost_input: Optional[float] = None
    cost_output: Optional[float] = None
    cost_total: Optional[float] = None
    duration_ms: Optional[int] = None
    tool_call_count: int = 0
    has_thinking: bool = False
    stop_reason: Optional[str] = None


class LlmCallResponse(BaseModel):
    id: str
    session_id: Optional[str] = None
    run_id: Optional[str] = None
    agent_id: str
    request_id: Optional[str] = None
    provider: str
    model: str
    key_source: Optional[str] = None
    key_masked: Optional[str] = None
    input_tokens: int
    output_tokens: int
    cache_read_tokens: int
    cache_write_tokens: int
    total_tokens: int
    cost_input: Optional[float] = None
    cost_output: Optional[float] = None
    cost_total: Optional[float] = None
    duration_ms: Optional[int] = None
    tool_call_count: int
    has_thinking: bool
    stop_reason: Optional[str] = None
    created_at: int


class LlmCallListResponse(BaseModel):
    calls: List[LlmCallResponse]
    total: int
    hasMore: bool
    summary: Optional[dict] = None  # Aggregated totals


# ── Internal endpoint (called by agent runtime) ─────────────────────────────


@router.post("/internal/llm-calls")
async def record_llm_call(
    body: RecordLlmCallRequest,
    db: AsyncSession = Depends(get_async_session),
):
    """Record an LLM API call.  Called by agent containers after each turn."""
    call = LlmCallLog(
        id=gen_id("llmcall"),
        session_id=body.session_id,
        run_id=body.run_id,
        agent_id=body.agent_id,
        request_id=body.request_id,
        provider=body.provider,
        model=body.model,
        key_source=body.key_source,
        key_masked=body.key_masked,
        input_tokens=body.input_tokens,
        output_tokens=body.output_tokens,
        cache_read_tokens=body.cache_read_tokens,
        cache_write_tokens=body.cache_write_tokens,
        total_tokens=body.total_tokens,
        cost_input=body.cost_input,
        cost_output=body.cost_output,
        cost_total=body.cost_total,
        duration_ms=body.duration_ms,
        tool_call_count=body.tool_call_count,
        has_thinking=body.has_thinking,
        stop_reason=body.stop_reason,
        created_at=now_ms(),
    )
    db.add(call)
    await db.commit()

    # Publish to Redis for real-time SSE streaming
    from app import dependencies

    if dependencies.redis_client:
        try:
            payload = json.dumps(
                {
                    "type": "llm_call",
                    "id": call.id,
                    "session_id": call.session_id,
                    "run_id": call.run_id,
                    "agent_id": call.agent_id,
                    "request_id": call.request_id,
                    "provider": call.provider,
                    "model": call.model,
                    "key_source": call.key_source,
                    "key_masked": call.key_masked,
                    "input_tokens": call.input_tokens,
                    "output_tokens": call.output_tokens,
                    "cache_read_tokens": call.cache_read_tokens,
                    "cache_write_tokens": call.cache_write_tokens,
                    "total_tokens": call.total_tokens,
                    "cost_input": call.cost_input,
                    "cost_output": call.cost_output,
                    "cost_total": call.cost_total,
                    "duration_ms": call.duration_ms,
                    "tool_call_count": call.tool_call_count,
                    "has_thinking": call.has_thinking,
                    "stop_reason": call.stop_reason,
                    "created_at": call.created_at,
                }
            )
            await dependencies.redis_client.publish("djinnbot:llm-calls:live", payload)
        except Exception as e:
            logger.warning(f"Failed to publish LLM call event: {e}")

    return {"ok": True, "id": call.id}


# ── Public endpoints ─────────────────────────────────────────────────────────


def _row_to_response(row: LlmCallLog) -> LlmCallResponse:
    return LlmCallResponse(
        id=row.id,
        session_id=row.session_id,
        run_id=row.run_id,
        agent_id=row.agent_id,
        request_id=row.request_id,
        provider=row.provider,
        model=row.model,
        key_source=row.key_source,
        key_masked=row.key_masked,
        input_tokens=row.input_tokens,
        output_tokens=row.output_tokens,
        cache_read_tokens=row.cache_read_tokens,
        cache_write_tokens=row.cache_write_tokens,
        total_tokens=row.total_tokens,
        cost_input=row.cost_input,
        cost_output=row.cost_output,
        cost_total=row.cost_total,
        duration_ms=row.duration_ms,
        tool_call_count=row.tool_call_count,
        has_thinking=row.has_thinking,
        stop_reason=row.stop_reason,
        created_at=row.created_at,
    )


async def _build_summary(db: AsyncSession, query) -> dict:
    """Compute aggregated token/cost totals for a set of LLM calls."""
    summary_query = select(
        func.count(LlmCallLog.id).label("call_count"),
        func.sum(LlmCallLog.input_tokens).label("total_input_tokens"),
        func.sum(LlmCallLog.output_tokens).label("total_output_tokens"),
        func.sum(LlmCallLog.cache_read_tokens).label("total_cache_read_tokens"),
        func.sum(LlmCallLog.cache_write_tokens).label("total_cache_write_tokens"),
        func.sum(LlmCallLog.total_tokens).label("total_tokens"),
        func.sum(LlmCallLog.cost_total).label("total_cost"),
        func.sum(LlmCallLog.cost_input).label("total_cost_input"),
        func.sum(LlmCallLog.cost_output).label("total_cost_output"),
        func.avg(LlmCallLog.duration_ms).label("avg_duration_ms"),
    ).select_from(query.subquery())
    result = await db.execute(summary_query)
    row = result.one()
    return {
        "callCount": row.call_count or 0,
        "totalInputTokens": row.total_input_tokens or 0,
        "totalOutputTokens": row.total_output_tokens or 0,
        "totalCacheReadTokens": row.total_cache_read_tokens or 0,
        "totalCacheWriteTokens": row.total_cache_write_tokens or 0,
        "totalTokens": row.total_tokens or 0,
        "totalCost": round(row.total_cost or 0, 6),
        "totalCostInput": round(row.total_cost_input or 0, 6),
        "totalCostOutput": round(row.total_cost_output or 0, 6),
        "avgDurationMs": round(row.avg_duration_ms or 0),
    }


@router.get("/llm-calls", response_model=LlmCallListResponse)
async def list_llm_calls(
    session_id: Optional[str] = Query(None),
    run_id: Optional[str] = Query(None),
    agent_id: Optional[str] = Query(None),
    limit: int = Query(50, ge=1, le=200),
    offset: int = Query(0, ge=0),
    db: AsyncSession = Depends(get_async_session),
) -> LlmCallListResponse:
    """List LLM calls, filterable by session, run, or agent."""
    query = select(LlmCallLog)

    if session_id:
        query = query.where(LlmCallLog.session_id == session_id)
    if run_id:
        query = query.where(LlmCallLog.run_id == run_id)
    if agent_id:
        query = query.where(LlmCallLog.agent_id == agent_id)

    # Total count
    count_q = select(func.count()).select_from(query.subquery())
    total = (await db.execute(count_q)).scalar() or 0

    # Summary
    summary = await _build_summary(db, query)

    # Paginated results
    result = await db.execute(
        query.order_by(desc(LlmCallLog.created_at)).limit(limit).offset(offset)
    )
    calls = [_row_to_response(r) for r in result.scalars().all()]

    return LlmCallListResponse(
        calls=calls,
        total=total,
        hasMore=(offset + len(calls)) < total,
        summary=summary,
    )


@router.get("/admin/llm-calls", response_model=LlmCallListResponse)
async def admin_list_llm_calls(
    admin: AuthUser = Depends(get_current_admin),
    session_id: Optional[str] = Query(None),
    run_id: Optional[str] = Query(None),
    agent_id: Optional[str] = Query(None),
    provider: Optional[str] = Query(None),
    key_source: Optional[str] = Query(None),
    limit: int = Query(50, ge=1, le=200),
    offset: int = Query(0, ge=0),
    db: AsyncSession = Depends(get_async_session),
) -> LlmCallListResponse:
    """Admin: list all LLM calls with additional filters."""
    query = select(LlmCallLog)

    if session_id:
        query = query.where(LlmCallLog.session_id == session_id)
    if run_id:
        query = query.where(LlmCallLog.run_id == run_id)
    if agent_id:
        query = query.where(LlmCallLog.agent_id == agent_id)
    if provider:
        query = query.where(LlmCallLog.provider == provider)
    if key_source:
        query = query.where(LlmCallLog.key_source == key_source)

    count_q = select(func.count()).select_from(query.subquery())
    total = (await db.execute(count_q)).scalar() or 0

    summary = await _build_summary(db, query)

    result = await db.execute(
        query.order_by(desc(LlmCallLog.created_at)).limit(limit).offset(offset)
    )
    calls = [_row_to_response(r) for r in result.scalars().all()]

    return LlmCallListResponse(
        calls=calls,
        total=total,
        hasMore=(offset + len(calls)) < total,
        summary=summary,
    )
