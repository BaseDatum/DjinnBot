"""Memory scoring endpoints — agent-driven valuations + adaptive scores.

Scoring is driven entirely by agent valuations (rate_memories tool), NOT by
step success/failure.  The agent runtime posts:
  1. Retrieval batches (analytics + access counting) after each step.
  2. Valuation batches (the PRIMARY scoring signal) when the agent calls
     rate_memories.
  3. Knowledge gap reports when the agent identifies missing knowledge.

All tuning parameters are stored in global_settings and editable via the
admin dashboard.  The scoring engine reads them on every computation so
changes take effect immediately.
"""

import json
import math
from typing import List, Optional

from fastapi import APIRouter, Depends, Query
from pydantic import BaseModel, Field
from sqlalchemy import select, and_
from sqlalchemy.ext.asyncio import AsyncSession

from app.database import get_async_session
from app.models.memory_score import (
    MemoryRetrievalLog,
    MemoryValuation,
    MemoryGap,
    MemoryScore,
)
from app.models.settings import GlobalSetting
from app.logging_config import get_logger
from app.utils import gen_id, now_ms

logger = get_logger(__name__)

router = APIRouter()

# ── Default constants (overridden by global_settings) ────────────────────────

DEFAULTS = {
    "min_valuations_for_signal": 3,
    "recency_half_life_days": 30,
    "rehabilitation_half_life_days": 90,
    "adaptive_score_floor": 0.35,
    "frequency_log_cap": 50,
    "blend_usefulness_weight": 0.60,
    "blend_recency_weight": 0.25,
    "blend_frequency_weight": 0.15,
    "recency_floor": 0.30,
    "blend_boost_factor": 0.30,
    "blend_base_factor": 0.70,
}

# In-memory cache so we don't hit the DB on every score computation.
# Refreshed on GET /config and PUT /config.
_config_cache: dict = dict(DEFAULTS)


# ── Config model ─────────────────────────────────────────────────────────────


class MemoryScoringConfig(BaseModel):
    """All tunable parameters for the memory scoring system."""

    min_valuations_for_signal: int = Field(
        default=DEFAULTS["min_valuations_for_signal"],
        ge=1,
        le=50,
        description=(
            "Minimum number of agent valuations a memory must have before its "
            "usefulness rate is trusted. Below this threshold, the memory uses "
            "a neutral score of 0.5 (neither boosted nor penalized). Higher "
            "values make the system more conservative."
        ),
    )

    recency_half_life_days: int = Field(
        default=DEFAULTS["recency_half_life_days"],
        ge=1,
        le=365,
        description=(
            "Controls how quickly the recency component of the score decays. "
            "After this many days without being retrieved, a memory's recency "
            "signal drops to half its original value."
        ),
    )

    rehabilitation_half_life_days: int = Field(
        default=DEFAULTS["rehabilitation_half_life_days"],
        ge=7,
        le=730,
        description=(
            "Controls how fast old negative usefulness scores fade toward "
            "neutral (0.5). Prevents permanent punishment — a memory rated "
            "not-useful in the past shouldn't be penalized forever."
        ),
    )

    adaptive_score_floor: float = Field(
        default=DEFAULTS["adaptive_score_floor"],
        ge=0.0,
        le=0.5,
        description=(
            "Hard minimum for any memory's adaptive score. Even the most "
            "downvoted memory cannot score below this. Set to 0.5 to "
            "disable adaptive scoring entirely."
        ),
    )

    frequency_log_cap: int = Field(
        default=DEFAULTS["frequency_log_cap"],
        ge=5,
        le=500,
        description=(
            "Normalizes the frequency component. A memory retrieved this many "
            "times reaches the maximum frequency signal (1.0). The scale is "
            "logarithmic."
        ),
    )

    blend_usefulness_weight: float = Field(
        default=DEFAULTS["blend_usefulness_weight"],
        ge=0.0,
        le=1.0,
        description=(
            "How much the agent's usefulness ratings influence the adaptive "
            "score. This is the dominant signal — memories that agents rated "
            "as useful rank higher. The three blend weights (usefulness, "
            "recency, frequency) should sum to 1.0."
        ),
    )

    blend_recency_weight: float = Field(
        default=DEFAULTS["blend_recency_weight"],
        ge=0.0,
        le=1.0,
        description=(
            "How much recency (time since last retrieval) influences the "
            "adaptive score. The three blend weights should sum to 1.0."
        ),
    )

    blend_frequency_weight: float = Field(
        default=DEFAULTS["blend_frequency_weight"],
        ge=0.0,
        le=1.0,
        description=(
            "How much access frequency influences the adaptive score. "
            "The three blend weights should sum to 1.0."
        ),
    )

    recency_floor: float = Field(
        default=DEFAULTS["recency_floor"],
        ge=0.0,
        le=1.0,
        description=(
            "Minimum value for the recency component. Even a memory that "
            "hasn't been accessed in years retains at least this much recency "
            "signal."
        ),
    )

    blend_boost_factor: float = Field(
        default=DEFAULTS["blend_boost_factor"],
        ge=0.0,
        le=1.0,
        description=(
            "Controls how much adaptive scores can boost or penalize the raw "
            "search score. The final blended score is: "
            "rawScore x (base_factor + boost_factor x adaptiveScore). "
            "Set to 0.0 to disable score blending entirely."
        ),
    )

    blend_base_factor: float = Field(
        default=DEFAULTS["blend_base_factor"],
        ge=0.0,
        le=1.0,
        description=(
            "The baseline multiplier for raw search scores before adaptive "
            "blending. base_factor + boost_factor should equal ~1.0 so that "
            "a neutral adaptive score (0.5) leaves raw scores unchanged."
        ),
    )


# ── Request / Response models ────────────────────────────────────────────────


class RetrievalEvent(BaseModel):
    """One memory that was surfaced during a recall/wake call."""

    memory_id: str
    memory_title: Optional[str] = None
    query: Optional[str] = None
    retrieval_source: str = "bm25"
    raw_score: float = 0.0


class RecordRetrievalsRequest(BaseModel):
    """Batch of retrieval events posted by the agent runtime after a step."""

    agent_id: str
    session_id: Optional[str] = None
    run_id: Optional[str] = None
    request_id: Optional[str] = None
    retrievals: List[RetrievalEvent]


class ValuationEvent(BaseModel):
    """One agent-authored usefulness rating for a recalled memory."""

    memory_id: str
    memory_title: Optional[str] = None
    useful: bool


class RecordValuationsRequest(BaseModel):
    """Batch of agent valuations posted by the rate_memories tool."""

    agent_id: str
    session_id: Optional[str] = None
    run_id: Optional[str] = None
    valuations: List[ValuationEvent]
    gap: Optional[str] = None
    gap_query: Optional[str] = None


class MemoryScoreResponse(BaseModel):
    memory_id: str
    access_count: int
    valuation_count: int
    useful_count: int
    not_useful_count: int
    usefulness_rate: float
    adaptive_score: float
    last_accessed: int


class MemoryScoresListResponse(BaseModel):
    scores: List[MemoryScoreResponse]
    total: int
    # Blend factors so the runtime can apply the correct formula
    blend_base_factor: float = DEFAULTS["blend_base_factor"]
    blend_boost_factor: float = DEFAULTS["blend_boost_factor"]


class MemoryGapResponse(BaseModel):
    id: str
    agent_id: str
    description: str
    query_attempted: Optional[str]
    created_at: int


class MemoryGapsListResponse(BaseModel):
    gaps: List[MemoryGapResponse]
    total: int


# ── Helpers ──────────────────────────────────────────────────────────────────


def _cfg(key: str):
    """Read a config value from the in-memory cache."""
    return _config_cache.get(key, DEFAULTS[key])


def _days_to_ms(days) -> float:
    return float(days) * 24 * 60 * 60 * 1000


def compute_adaptive_score(
    access_count: int,
    valuation_count: int,
    useful_count: int,
    last_accessed_ms: int,
    now: int,
) -> tuple[float, float]:
    """Compute (usefulness_rate, adaptive_score) from counters.

    The PRIMARY signal is the agent's own usefulness ratings — not step
    success/failure.  Agents call rate_memories after consuming recalled
    memories, providing direct ground-truth about whether each memory
    helped with the current task.

    Key design decisions:

    1. **Agent-driven signal**: usefulness_rate comes from explicit agent
       valuations (boolean useful/not-useful).  This replaces the old
       step-success proxy which was noisy and meaningless in chat contexts.

    2. **Rehabilitation**: usefulness_rate drifts back toward 0.5 (neutral)
       based on how long ago the memory was last accessed/valued.  Old
       "not useful" ratings fade — context changes over time.

    3. **Hard floor**: adaptive_score is clamped to a configurable minimum.
       A keyword-matched memory will always surface.

    4. **Neutral prior**: Memories below min_valuations_for_signal start at
       0.5 so a single "not useful" doesn't tank the score.

    Returns:
        (usefulness_rate, adaptive_score) both in [0, 1].
    """
    min_valuations = int(_cfg("min_valuations_for_signal"))
    rehab_hl_ms = _days_to_ms(_cfg("rehabilitation_half_life_days"))
    recency_hl_ms = _days_to_ms(_cfg("recency_half_life_days"))
    recency_floor = float(_cfg("recency_floor"))
    freq_cap = math.log(max(2, int(_cfg("frequency_log_cap"))))
    floor = float(_cfg("adaptive_score_floor"))
    w_usefulness = float(_cfg("blend_usefulness_weight"))
    w_recency = float(_cfg("blend_recency_weight"))
    w_freq = float(_cfg("blend_frequency_weight"))

    # 1. Raw usefulness rate (or neutral prior for low-data)
    if valuation_count < min_valuations:
        raw_usefulness_rate = 0.5
    else:
        raw_usefulness_rate = useful_count / valuation_count

    # 2. Rehabilitation: blend usefulness toward 0.5 based on age
    age_ms = max(0, now - last_accessed_ms)
    rehab_factor = 2 ** (-age_ms / rehab_hl_ms) if rehab_hl_ms > 0 else 1.0
    usefulness_rate = raw_usefulness_rate * rehab_factor + 0.5 * (1.0 - rehab_factor)

    # 3. Recency weight — exponential decay, floored
    recency = (
        max(recency_floor, 2 ** (-age_ms / recency_hl_ms))
        if recency_hl_ms > 0
        else recency_floor
    )

    # 4. Frequency signal — log scale, capped and normalized to [0, 1]
    frequency = min(1.0, math.log(access_count + 1) / freq_cap)

    # 5. Blend components
    adaptive = usefulness_rate * w_usefulness + recency * w_recency + frequency * w_freq

    # 6. Hard floor — prevent total suppression
    adaptive = max(floor, adaptive)

    return round(usefulness_rate, 4), round(adaptive, 4)


# ── Internal endpoints (called by agent runtime) ────────────────────────────


@router.post("/internal/memory-retrievals")
async def record_retrievals(
    body: RecordRetrievalsRequest,
    db: AsyncSession = Depends(get_async_session),
):
    """Record a batch of memory retrievals from a completed step.

    Called fire-and-forget by the agent runtime after each step.
    Inserts raw events and increments access_count on score rows.
    No longer carries step_success — scoring is agent-driven.
    """
    if not body.retrievals:
        return {"ok": True, "logged": 0, "scores_updated": 0}

    now = now_ms()
    logged = 0

    # 1. Insert raw retrieval events
    for event in body.retrievals:
        log_entry = MemoryRetrievalLog(
            id=gen_id("mrl_"),
            agent_id=body.agent_id,
            session_id=body.session_id,
            run_id=body.run_id,
            request_id=body.request_id,
            memory_id=event.memory_id,
            memory_title=event.memory_title,
            query=event.query,
            retrieval_source=event.retrieval_source,
            raw_score=event.raw_score,
            created_at=now,
        )
        db.add(log_entry)
        logged += 1

    # 2. Upsert access_count for each unique memory_id in the batch
    seen_memory_ids = {e.memory_id for e in body.retrievals}
    scores_updated = 0

    for memory_id in seen_memory_ids:
        result = await db.execute(
            select(MemoryScore).where(
                and_(
                    MemoryScore.agent_id == body.agent_id,
                    MemoryScore.memory_id == memory_id,
                )
            )
        )
        existing = result.scalar_one_or_none()

        if existing:
            existing.access_count += 1
            existing.last_accessed = now
            existing.updated_at = now

            # Recompute adaptive score with updated access count
            ur, adaptive = compute_adaptive_score(
                existing.access_count,
                existing.valuation_count,
                existing.useful_count,
                now,
                now,
            )
            existing.usefulness_rate = ur
            existing.adaptive_score = adaptive
        else:
            ur, adaptive = compute_adaptive_score(1, 0, 0, now, now)
            new_score = MemoryScore(
                id=gen_id("ms_"),
                agent_id=body.agent_id,
                memory_id=memory_id,
                access_count=1,
                valuation_count=0,
                useful_count=0,
                not_useful_count=0,
                usefulness_rate=ur,
                adaptive_score=adaptive,
                last_accessed=now,
                last_valued=None,
                created_at=now,
                updated_at=now,
            )
            db.add(new_score)

        scores_updated += 1

    await db.commit()

    return {"ok": True, "logged": logged, "scores_updated": scores_updated}


@router.post("/internal/memory-valuations")
async def record_valuations(
    body: RecordValuationsRequest,
    db: AsyncSession = Depends(get_async_session),
):
    """Record agent-authored memory valuations from the rate_memories tool.

    This is the PRIMARY scoring signal.  Each valuation is an explicit
    "useful" or "not useful" judgment from the agent about a specific memory.
    """
    now = now_ms()
    valuations_logged = 0
    scores_updated = 0

    # 1. Insert individual valuation events
    for v in body.valuations:
        entry = MemoryValuation(
            id=gen_id("mv_"),
            agent_id=body.agent_id,
            session_id=body.session_id,
            run_id=body.run_id,
            memory_id=v.memory_id,
            memory_title=v.memory_title,
            useful=v.useful,
            created_at=now,
        )
        db.add(entry)
        valuations_logged += 1

    # 2. Upsert aggregated scores for each rated memory
    for v in body.valuations:
        result = await db.execute(
            select(MemoryScore).where(
                and_(
                    MemoryScore.agent_id == body.agent_id,
                    MemoryScore.memory_id == v.memory_id,
                )
            )
        )
        existing = result.scalar_one_or_none()

        if existing:
            existing.valuation_count += 1
            if v.useful:
                existing.useful_count += 1
            else:
                existing.not_useful_count += 1
            existing.last_valued = now
            existing.updated_at = now

            ur, adaptive = compute_adaptive_score(
                existing.access_count,
                existing.valuation_count,
                existing.useful_count,
                existing.last_accessed,
                now,
            )
            existing.usefulness_rate = ur
            existing.adaptive_score = adaptive
        else:
            # Memory was rated but somehow has no retrieval record — create one
            uc = 1 if v.useful else 0
            nuc = 0 if v.useful else 1
            ur, adaptive = compute_adaptive_score(1, 1, uc, now, now)
            new_score = MemoryScore(
                id=gen_id("ms_"),
                agent_id=body.agent_id,
                memory_id=v.memory_id,
                access_count=1,
                valuation_count=1,
                useful_count=uc,
                not_useful_count=nuc,
                usefulness_rate=ur,
                adaptive_score=adaptive,
                last_accessed=now,
                last_valued=now,
                created_at=now,
                updated_at=now,
            )
            db.add(new_score)

        scores_updated += 1

    # 3. Record knowledge gap if provided
    gap_id = None
    if body.gap and body.gap.strip():
        gap_id = gen_id("mg_")
        db.add(
            MemoryGap(
                id=gap_id,
                agent_id=body.agent_id,
                session_id=body.session_id,
                run_id=body.run_id,
                description=body.gap.strip(),
                query_attempted=body.gap_query,
                created_at=now,
            )
        )

    await db.commit()

    return {
        "ok": True,
        "valuations_logged": valuations_logged,
        "scores_updated": scores_updated,
        "gap_id": gap_id,
    }


@router.get("/internal/memory-scores/{agent_id}")
async def get_memory_scores(
    agent_id: str,
    memory_ids: Optional[str] = Query(
        None, description="Comma-separated memory IDs to filter"
    ),
    limit: int = Query(200, ge=1, le=1000),
    db: AsyncSession = Depends(get_async_session),
) -> MemoryScoresListResponse:
    """Get adaptive scores for an agent's memories.

    Called by the agent runtime at recall time to blend with raw search scores.
    """
    query = select(MemoryScore).where(MemoryScore.agent_id == agent_id)

    if memory_ids:
        ids = [mid.strip() for mid in memory_ids.split(",") if mid.strip()]
        if ids:
            query = query.where(MemoryScore.memory_id.in_(ids))

    # Recompute adaptive scores on read to account for time decay
    now = now_ms()

    result = await db.execute(query.limit(limit))
    rows = result.scalars().all()

    scores = []
    for row in rows:
        # Recompute with current time for accurate recency decay
        _, live_adaptive = compute_adaptive_score(
            row.access_count,
            row.valuation_count,
            row.useful_count,
            row.last_accessed,
            now,
        )
        scores.append(
            MemoryScoreResponse(
                memory_id=row.memory_id,
                access_count=row.access_count,
                valuation_count=row.valuation_count,
                useful_count=row.useful_count,
                not_useful_count=row.not_useful_count,
                usefulness_rate=row.usefulness_rate,
                adaptive_score=live_adaptive,
                last_accessed=row.last_accessed,
            )
        )

    return MemoryScoresListResponse(
        scores=scores,
        total=len(scores),
        blend_base_factor=float(_cfg("blend_base_factor")),
        blend_boost_factor=float(_cfg("blend_boost_factor")),
    )


@router.get("/internal/memory-gaps/{agent_id}")
async def get_memory_gaps(
    agent_id: str,
    limit: int = Query(50, ge=1, le=500),
    db: AsyncSession = Depends(get_async_session),
) -> MemoryGapsListResponse:
    """Get knowledge gaps reported by an agent."""
    result = await db.execute(
        select(MemoryGap)
        .where(MemoryGap.agent_id == agent_id)
        .order_by(MemoryGap.created_at.desc())
        .limit(limit)
    )
    rows = result.scalars().all()

    gaps = [
        MemoryGapResponse(
            id=row.id,
            agent_id=row.agent_id,
            description=row.description,
            query_attempted=row.query_attempted,
            created_at=row.created_at,
        )
        for row in rows
    ]

    return MemoryGapsListResponse(gaps=gaps, total=len(gaps))


# ── Scoring configuration endpoints (admin dashboard) ───────────────────────

_SETTINGS_KEY = "memory_scoring_config"


async def _load_config_from_db(db: AsyncSession) -> MemoryScoringConfig:
    """Load scoring config from global_settings, falling back to defaults."""
    row = await db.get(GlobalSetting, _SETTINGS_KEY)
    if row:
        try:
            data = json.loads(row.value)
            return MemoryScoringConfig(**data)
        except Exception:
            pass
    return MemoryScoringConfig()


def _refresh_cache(config: MemoryScoringConfig) -> None:
    """Update the in-memory cache from a config object."""
    global _config_cache
    _config_cache = config.model_dump()


@router.get("/memory-scoring/config")
async def get_scoring_config(
    db: AsyncSession = Depends(get_async_session),
) -> MemoryScoringConfig:
    """Get current memory scoring configuration."""
    config = await _load_config_from_db(db)
    _refresh_cache(config)
    return config


@router.put("/memory-scoring/config")
async def update_scoring_config(
    body: MemoryScoringConfig,
    db: AsyncSession = Depends(get_async_session),
) -> MemoryScoringConfig:
    """Update memory scoring configuration. Changes take effect immediately."""
    now = now_ms()
    serialized = json.dumps(body.model_dump())

    row = await db.get(GlobalSetting, _SETTINGS_KEY)
    if row:
        row.value = serialized
        row.updated_at = now
    else:
        db.add(GlobalSetting(key=_SETTINGS_KEY, value=serialized, updated_at=now))

    await db.commit()
    _refresh_cache(body)

    return body


@router.post("/memory-scoring/config/reset")
async def reset_scoring_config(
    db: AsyncSession = Depends(get_async_session),
) -> MemoryScoringConfig:
    """Reset scoring configuration to defaults."""
    now = now_ms()
    defaults = MemoryScoringConfig()
    serialized = json.dumps(defaults.model_dump())

    row = await db.get(GlobalSetting, _SETTINGS_KEY)
    if row:
        row.value = serialized
        row.updated_at = now
    else:
        db.add(GlobalSetting(key=_SETTINGS_KEY, value=serialized, updated_at=now))

    await db.commit()
    _refresh_cache(defaults)

    return defaults
