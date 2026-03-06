"""Enforcement logic for AdminSharedProvider limits.

Provides ``check_share_limits()`` which is called during key resolution
(``get_all_provider_keys``) to determine which admin-shared providers a
user is still allowed to use, based on:

  1. **allowed_models** — if the share restricts to a list of model IDs,
     the caller must know the intended model *or* the restriction is surfaced
     as metadata so the engine can enforce it at runtime.

  2. **daily_limit** — max LLM API calls per day (count of llm_call_logs rows
     with key_source='admin_shared' for this user+provider in the current UTC day).

  3. **daily_cost_limit_usd** — max estimated cost per day (sum of
     llm_call_logs.cost_total with key_source='admin_shared' for this
     user+provider in the current UTC day).

Returns per-provider usage stats and whether each limit is exceeded, so the
caller can:
  - Exclude the provider from the key response (hard block), OR
  - Include the provider but surface limit info as metadata so the engine
    can decide (soft/informational).

The current implementation does a **hard block**: if any limit is exceeded,
the provider's key is removed from the response.
"""

import json
from datetime import datetime, timezone
from typing import Dict, List, Optional, Tuple

from sqlalchemy import select, func
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.llm_call_log import LlmCallLog
from app.models.user_provider import AdminSharedProvider
from app.logging_config import get_logger

logger = get_logger(__name__)


def _start_of_utc_day_ms() -> int:
    """Return the start of the current UTC day as milliseconds since epoch."""
    now = datetime.now(timezone.utc)
    start = now.replace(hour=0, minute=0, second=0, microsecond=0)
    return int(start.timestamp() * 1000)


class ShareUsageInfo:
    """Usage stats and limit check result for one admin-shared provider."""

    __slots__ = (
        "provider_id",
        "daily_limit",
        "daily_cost_limit_usd",
        "allowed_models",
        "calls_today",
        "cost_today_usd",
        "limit_exceeded",
        "exceeded_reason",
    )

    def __init__(
        self,
        provider_id: str,
        daily_limit: Optional[int],
        daily_cost_limit_usd: Optional[float],
        allowed_models: Optional[List[str]],
        calls_today: int,
        cost_today_usd: float,
    ):
        self.provider_id = provider_id
        self.daily_limit = daily_limit
        self.daily_cost_limit_usd = daily_cost_limit_usd
        self.allowed_models = allowed_models
        self.calls_today = calls_today
        self.cost_today_usd = cost_today_usd

        # Determine if any limit is exceeded
        self.limit_exceeded = False
        self.exceeded_reason: Optional[str] = None

        if daily_limit is not None and calls_today >= daily_limit:
            self.limit_exceeded = True
            self.exceeded_reason = (
                f"Daily request limit reached ({calls_today}/{daily_limit})"
            )
        elif (
            daily_cost_limit_usd is not None and cost_today_usd >= daily_cost_limit_usd
        ):
            self.limit_exceeded = True
            self.exceeded_reason = (
                f"Daily cost limit reached "
                f"(${cost_today_usd:.4f}/${daily_cost_limit_usd:.2f})"
            )

    def to_dict(self) -> dict:
        return {
            "provider_id": self.provider_id,
            "daily_limit": self.daily_limit,
            "daily_cost_limit_usd": self.daily_cost_limit_usd,
            "allowed_models": self.allowed_models,
            "calls_today": self.calls_today,
            "cost_today_usd": round(self.cost_today_usd, 6),
            "limit_exceeded": self.limit_exceeded,
            "exceeded_reason": self.exceeded_reason,
        }


async def check_share_limits(
    session: AsyncSession,
    user_id: str,
    shared_rows: List[AdminSharedProvider],
) -> Dict[str, ShareUsageInfo]:
    """Check daily usage limits for admin-shared providers.

    Args:
        session: DB session.
        user_id: The user whose usage to check.
        shared_rows: The AdminSharedProvider grants applicable to this user
                     (already filtered for expiry, target_user_id, etc.).

    Returns:
        Mapping of provider_id → ShareUsageInfo with usage stats and whether
        any limit is exceeded.
    """
    # Collect provider_ids that have any limit set (skip unlimited shares)
    limited_shares: List[AdminSharedProvider] = []
    for share in shared_rows:
        has_limit = (
            share.daily_limit is not None or share.daily_cost_limit_usd is not None
        )
        if has_limit:
            limited_shares.append(share)

    if not limited_shares:
        # No limits to enforce — return empty (all shares are unlimited)
        # Still return allowed_models metadata for all shares.
        result: Dict[str, ShareUsageInfo] = {}
        for share in shared_rows:
            allowed = None
            if share.allowed_models:
                try:
                    allowed = json.loads(share.allowed_models)
                except (json.JSONDecodeError, TypeError):
                    pass
            result[share.provider_id] = ShareUsageInfo(
                provider_id=share.provider_id,
                daily_limit=None,
                daily_cost_limit_usd=None,
                allowed_models=allowed,
                calls_today=0,
                cost_today_usd=0.0,
            )
        return result

    # Query today's usage in a single batch:
    # GROUP BY provider → (call_count, sum_cost)
    day_start_ms = _start_of_utc_day_ms()
    limited_provider_ids = [s.provider_id for s in limited_shares]

    usage_query = (
        select(
            LlmCallLog.provider,
            func.count(LlmCallLog.id).label("call_count"),
            func.coalesce(func.sum(LlmCallLog.cost_total), 0).label("sum_cost"),
        )
        .where(
            LlmCallLog.user_id == user_id,
            LlmCallLog.key_source == "admin_shared",
            LlmCallLog.provider.in_(limited_provider_ids),
            LlmCallLog.created_at >= day_start_ms,
        )
        .group_by(LlmCallLog.provider)
    )

    usage_result = await session.execute(usage_query)
    usage_map: Dict[str, Tuple[int, float]] = {}
    for row in usage_result:
        usage_map[row.provider] = (row.call_count or 0, float(row.sum_cost or 0))

    # Build result for all shared providers (both limited and unlimited)
    result = {}
    for share in shared_rows:
        calls, cost = usage_map.get(share.provider_id, (0, 0.0))
        allowed = None
        if share.allowed_models:
            try:
                allowed = json.loads(share.allowed_models)
            except (json.JSONDecodeError, TypeError):
                pass

        result[share.provider_id] = ShareUsageInfo(
            provider_id=share.provider_id,
            daily_limit=share.daily_limit,
            daily_cost_limit_usd=share.daily_cost_limit_usd,
            allowed_models=allowed,
            calls_today=calls,
            cost_today_usd=cost,
        )

    return result
