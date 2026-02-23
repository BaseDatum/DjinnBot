"""Memory scoring endpoints — retrieval outcome tracking + adaptive scores.

The agent runtime posts retrieval batches after each step completes.
The API upserts aggregated scores and serves them back at recall time.

All tuning parameters are stored in global_settings and editable via the
admin dashboard. The scoring engine reads them on every computation so
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
from app.models.memory_score import MemoryRetrievalLog, MemoryScore
from app.models.settings import GlobalSetting
from app.logging_config import get_logger
from app.utils import gen_id, now_ms

logger = get_logger(__name__)

router = APIRouter()

# ── Default constants (overridden by global_settings) ────────────────────────

DEFAULTS = {
    "min_accesses_for_signal": 3,
    "recency_half_life_days": 30,
    "rehabilitation_half_life_days": 90,
    "adaptive_score_floor": 0.35,
    "frequency_log_cap": 50,
    "blend_success_weight": 0.60,
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

    min_accesses_for_signal: int = Field(
        default=DEFAULTS["min_accesses_for_signal"],
        ge=1,
        le=50,
        description=(
            "Minimum number of times a memory must be retrieved before its "
            "success/failure ratio is trusted. Below this threshold, the memory "
            "uses a neutral score of 0.5 (neither boosted nor penalized). "
            "Higher values make the system more conservative — it needs more "
            "evidence before adjusting a memory's ranking."
        ),
    )

    recency_half_life_days: int = Field(
        default=DEFAULTS["recency_half_life_days"],
        ge=1,
        le=365,
        description=(
            "Controls how quickly the recency component of the score decays. "
            "After this many days without being retrieved, a memory's recency "
            "signal drops to half its original value. Lower values cause stale "
            "memories to lose ranking faster; higher values keep them relevant longer."
        ),
    )

    rehabilitation_half_life_days: int = Field(
        default=DEFAULTS["rehabilitation_half_life_days"],
        ge=7,
        le=730,
        description=(
            "Controls how fast old negative scores fade toward neutral (0.5). "
            "This prevents 'permanent punishment' — a memory that was irrelevant "
            "in the past shouldn't be penalized forever. After this many days of "
            "not being retrieved, half the negative signal is erased. After 4x "
            "this period, ~94% is erased."
        ),
    )

    adaptive_score_floor: float = Field(
        default=DEFAULTS["adaptive_score_floor"],
        ge=0.0,
        le=0.5,
        description=(
            "Hard minimum for any memory's adaptive score. Even the most "
            "downvoted memory cannot score below this. Combined with the "
            "blend formula, this caps the maximum penalty a memory can "
            "receive. At 0.35 with default blend factors, the worst-case "
            "penalty is ~19.5%%. Set to 0.5 to disable adaptive scoring "
            "entirely (all memories treated equally)."
        ),
    )

    frequency_log_cap: int = Field(
        default=DEFAULTS["frequency_log_cap"],
        ge=5,
        le=500,
        description=(
            "Normalizes the frequency component. A memory retrieved this many "
            "times reaches the maximum frequency signal (1.0). The scale is "
            "logarithmic, so the first few retrievals matter most. Lower values "
            "mean the frequency signal saturates faster."
        ),
    )

    blend_success_weight: float = Field(
        default=DEFAULTS["blend_success_weight"],
        ge=0.0,
        le=1.0,
        description=(
            "How much the success/failure ratio influences the adaptive score. "
            "This is the dominant signal — memories that led to successful "
            "outcomes rank higher. The three blend weights (success, recency, "
            "frequency) should sum to 1.0."
        ),
    )

    blend_recency_weight: float = Field(
        default=DEFAULTS["blend_recency_weight"],
        ge=0.0,
        le=1.0,
        description=(
            "How much recency (time since last retrieval) influences the "
            "adaptive score. Higher values favor recently-accessed memories. "
            "The three blend weights should sum to 1.0."
        ),
    )

    blend_frequency_weight: float = Field(
        default=DEFAULTS["blend_frequency_weight"],
        ge=0.0,
        le=1.0,
        description=(
            "How much access frequency influences the adaptive score. "
            "Higher values favor memories that are retrieved often. "
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
            "signal. Prevents very old memories from being completely "
            "deprioritized by the recency component alone."
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
            "At 0.30, a perfect adaptive score gives +30%% boost, "
            "while the worst score gives -30%% penalty. Set to 0.0 to "
            "disable score blending entirely."
        ),
    )

    blend_base_factor: float = Field(
        default=DEFAULTS["blend_base_factor"],
        ge=0.0,
        le=1.0,
        description=(
            "The baseline multiplier for raw search scores before adaptive "
            "blending is applied. At 0.70, even a memory with the worst "
            "adaptive score retains 70%% of its raw relevance score. "
            "base_factor + boost_factor should equal ~1.0 so that a "
            "neutral adaptive score (0.5) leaves raw scores unchanged."
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
    step_success: Optional[bool] = None
    retrievals: List[RetrievalEvent]


class MemoryScoreResponse(BaseModel):
    memory_id: str
    access_count: int
    success_count: int
    failure_count: int
    success_rate: float
    adaptive_score: float
    last_accessed: int


class MemoryScoresListResponse(BaseModel):
    scores: List[MemoryScoreResponse]
    total: int
    # Blend factors so the runtime can apply the correct formula
    blend_base_factor: float = DEFAULTS["blend_base_factor"]
    blend_boost_factor: float = DEFAULTS["blend_boost_factor"]


# ── Helpers ──────────────────────────────────────────────────────────────────


def _cfg(key: str):
    """Read a config value from the in-memory cache."""
    return _config_cache.get(key, DEFAULTS[key])


def _days_to_ms(days) -> float:
    return float(days) * 24 * 60 * 60 * 1000


def compute_adaptive_score(
    access_count: int,
    success_count: int,
    failure_count: int,
    last_accessed_ms: int,
    now: int,
) -> tuple[float, float]:
    """Compute (success_rate, adaptive_score) from raw counters.

    All tuning parameters are read from the config cache (populated from
    global_settings on startup and on every GET/PUT /config call).

    Key design decisions to prevent "downvoted into oblivion":

    1. **Rehabilitation**: success_rate drifts back toward 0.5 (neutral) based
       on how long ago the memory was last accessed. Old failures shouldn't
       penalize a memory forever — the context that caused them may no longer
       be relevant.

    2. **Hard floor**: adaptive_score is clamped to a configurable minimum.
       Combined with the blend formula, this caps the maximum penalty any
       memory can receive. A keyword-matched memory will always surface.

    3. **Neutral prior**: Memories below min_accesses_for_signal start at 0.5
       so a single failure doesn't tank the score.

    Returns:
        (success_rate, adaptive_score) both in [0, 1].
    """
    min_accesses = int(_cfg("min_accesses_for_signal"))
    rehab_hl_ms = _days_to_ms(_cfg("rehabilitation_half_life_days"))
    recency_hl_ms = _days_to_ms(_cfg("recency_half_life_days"))
    recency_floor = float(_cfg("recency_floor"))
    freq_cap = math.log(max(2, int(_cfg("frequency_log_cap"))))
    floor = float(_cfg("adaptive_score_floor"))
    w_success = float(_cfg("blend_success_weight"))
    w_recency = float(_cfg("blend_recency_weight"))
    w_freq = float(_cfg("blend_frequency_weight"))

    # 1. Raw success rate (or neutral prior for low-data)
    if access_count < min_accesses:
        raw_success_rate = 0.5
    else:
        raw_success_rate = success_count / access_count

    # 2. Rehabilitation: blend success_rate toward 0.5 based on age
    age_ms = max(0, now - last_accessed_ms)
    rehab_factor = 2 ** (-age_ms / rehab_hl_ms) if rehab_hl_ms > 0 else 1.0
    success_rate = raw_success_rate * rehab_factor + 0.5 * (1.0 - rehab_factor)

    # 3. Recency weight — exponential decay, floored
    recency = (
        max(recency_floor, 2 ** (-age_ms / recency_hl_ms))
        if recency_hl_ms > 0
        else recency_floor
    )

    # 4. Frequency signal — log scale, capped and normalized to [0, 1]
    frequency = min(1.0, math.log(access_count + 1) / freq_cap)

    # 5. Blend components
    adaptive = success_rate * w_success + recency * w_recency + frequency * w_freq

    # 6. Hard floor — prevent total suppression
    adaptive = max(floor, adaptive)

    return round(success_rate, 4), round(adaptive, 4)


# ── Internal endpoints (called by agent runtime) ────────────────────────────


@router.post("/internal/memory-retrievals")
async def record_retrievals(
    body: RecordRetrievalsRequest,
    db: AsyncSession = Depends(get_async_session),
):
    """Record a batch of memory retrievals from a completed step.

    Called fire-and-forget by the agent runtime after each step.
    Inserts raw events and upserts aggregated scores atomically.
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
            step_success=body.step_success,
            created_at=now,
        )
        db.add(log_entry)
        logged += 1

    # 2. Upsert aggregated scores for each unique memory_id in the batch
    seen_memory_ids = {e.memory_id for e in body.retrievals}
    scores_updated = 0

    for memory_id in seen_memory_ids:
        # Fetch existing score row (if any)
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
            # Update counters
            existing.access_count += 1
            if body.step_success is True:
                existing.success_count += 1
            elif body.step_success is False:
                existing.failure_count += 1
            existing.last_accessed = now
            existing.updated_at = now

            # Recompute derived scores
            sr, adaptive = compute_adaptive_score(
                existing.access_count,
                existing.success_count,
                existing.failure_count,
                now,
                now,
            )
            existing.success_rate = sr
            existing.adaptive_score = adaptive
        else:
            # Create new score entry
            sc = 1 if body.step_success is True else 0
            fc = 1 if body.step_success is False else 0
            sr, adaptive = compute_adaptive_score(1, sc, fc, now, now)

            new_score = MemoryScore(
                id=gen_id("ms_"),
                agent_id=body.agent_id,
                memory_id=memory_id,
                access_count=1,
                success_count=sc,
                failure_count=fc,
                success_rate=sr,
                adaptive_score=adaptive,
                last_accessed=now,
                created_at=now,
                updated_at=now,
            )
            db.add(new_score)

        scores_updated += 1

    await db.commit()

    return {"ok": True, "logged": logged, "scores_updated": scores_updated}


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
    Optionally filter to specific memory_ids (comma-separated).
    """
    query = select(MemoryScore).where(MemoryScore.agent_id == agent_id)

    if memory_ids:
        ids = [mid.strip() for mid in memory_ids.split(",") if mid.strip()]
        if ids:
            query = query.where(MemoryScore.memory_id.in_(ids))

    # Recompute adaptive scores on read to account for time decay
    # (last_accessed ages since the score row was last written)
    now = now_ms()

    result = await db.execute(query.limit(limit))
    rows = result.scalars().all()

    scores = []
    for row in rows:
        # Recompute with current time for accurate recency decay
        _, live_adaptive = compute_adaptive_score(
            row.access_count,
            row.success_count,
            row.failure_count,
            row.last_accessed,
            now,
        )
        scores.append(
            MemoryScoreResponse(
                memory_id=row.memory_id,
                access_count=row.access_count,
                success_count=row.success_count,
                failure_count=row.failure_count,
                success_rate=row.success_rate,
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
