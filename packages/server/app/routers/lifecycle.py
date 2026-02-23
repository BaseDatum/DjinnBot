"""Agent lifecycle and activity endpoints."""

import json
import time
from typing import Optional
from fastapi import APIRouter, HTTPException, Depends
from pydantic import BaseModel
from sqlalchemy import select, func
from sqlalchemy.ext.asyncio import AsyncSession

from app import dependencies
from app.database import get_async_session
from app.logging_config import get_logger

logger = get_logger(__name__)

router = APIRouter()


class LifecycleResponse(BaseModel):
    state: str  # "idle" | "working" | "thinking"
    lastActive: Optional[int] = None
    queueDepth: int = 0
    currentWork: Optional[dict] = None
    pulse: dict


class ActivityResponse(BaseModel):
    timeline: list
    resourceUsage: dict


def _default_lifecycle_state() -> dict:
    """Default state when Redis key doesn't exist."""
    return {"state": "idle", "lastActive": None, "currentWork": None}


def _default_pulse_config() -> dict:
    """Default pulse configuration."""
    return {"enabled": False, "lastPulse": None, "nextPulse": None, "intervalMs": 0}


def _default_resource_usage() -> dict:
    """Default resource usage."""
    return {
        "memory": {"used": 0, "limit": 0, "unit": "MB"},
        "cpu": {"used": 0.0, "cores": 0},
        "pids": {"count": 0, "limit": 0},
    }


@router.get("/{agent_id}/lifecycle", response_model=LifecycleResponse)
async def get_agent_lifecycle(agent_id: str):
    """
    Get current agent lifecycle state, queue depth, and pulse status.

    Returns:
        - state: "idle" | "working" | "thinking"
        - lastActive: timestamp or null
        - queueDepth: number of items in work queue
        - currentWork: current work details or null
        - pulse: pulse configuration
    """
    logger.debug(f"Getting lifecycle state for agent_id={agent_id}")

    if not dependencies.redis_client:
        raise HTTPException(status_code=503, detail="Redis unavailable")

    # Get state
    state_key = f"djinnbot:agent:{agent_id}:state"
    state_data = await dependencies.redis_client.get(state_key)

    if state_data:
        try:
            state = json.loads(state_data)
        except json.JSONDecodeError:
            state = _default_lifecycle_state()
    else:
        state = _default_lifecycle_state()

    # Get queue depth
    queue_key = f"djinnbot:agent:{agent_id}:queue"
    queue_depth = await dependencies.redis_client.llen(queue_key)

    # Get pulse configuration
    pulse_key = f"djinnbot:agent:{agent_id}:pulse"
    pulse_data = await dependencies.redis_client.get(pulse_key)

    if pulse_data:
        try:
            pulse = json.loads(pulse_data)
        except json.JSONDecodeError:
            pulse = _default_pulse_config()
    else:
        pulse = _default_pulse_config()

    logger.debug(
        f"Lifecycle state for agent_id={agent_id}: state={state.get('state')}, queueDepth={queue_depth}"
    )

    return {
        "state": state.get("state", "idle"),
        "lastActive": state.get("lastActive"),
        "queueDepth": queue_depth,
        "currentWork": state.get("currentWork"),
        "pulse": pulse,
    }


@router.get("/{agent_id}/activity", response_model=ActivityResponse)
async def get_agent_activity(
    agent_id: str, limit: int = 100, since: Optional[int] = None
):
    """
    Get agent activity timeline and resource usage.

    Query params:
        - limit: max events to return (default 100)
        - since: timestamp filter (only events after this)

    Returns:
        - timeline: list of activity events
        - resourceUsage: memory, CPU, and process metrics
    """
    logger.debug(
        f"Getting activity for agent_id={agent_id}, limit={limit}, since={since}"
    )

    if not dependencies.redis_client:
        raise HTTPException(status_code=503, detail="Redis unavailable")

    # Get timeline events from sorted set
    timeline_key = f"djinnbot:agent:{agent_id}:timeline"

    # Fetch events (sorted by timestamp score)
    if since is not None:
        # Get events after 'since' timestamp
        events = await dependencies.redis_client.zrangebyscore(
            timeline_key, min=since, max="+inf", start=0, num=limit, withscores=True
        )
    else:
        # Get most recent events
        events = await dependencies.redis_client.zrevrange(
            timeline_key, start=0, end=limit - 1, withscores=True
        )

    # Parse timeline events
    timeline = []
    for event_data, timestamp in events:
        try:
            event = json.loads(event_data)
            timeline.append(
                {
                    "id": event.get("id", str(int(timestamp))),
                    "timestamp": int(timestamp),
                    "type": event.get("type", "unknown"),
                    "data": event.get("data", {}),
                }
            )
        except (json.JSONDecodeError, TypeError):
            # Skip malformed events
            continue

    # If we used zrevrange (descending), events are already newest-first
    # If we used zrangebyscore (ascending), reverse them
    if since is not None:
        timeline.reverse()

    # Get resource usage
    resources_key = f"djinnbot:agent:{agent_id}:resources"
    resources_data = await dependencies.redis_client.hgetall(resources_key)

    if resources_data:
        # Parse resource hash
        resource_usage = {
            "memory": {
                "used": int(resources_data.get("memory_used", 0)),
                "limit": int(resources_data.get("memory_limit", 0)),
                "unit": resources_data.get("memory_unit", "MB"),
            },
            "cpu": {
                "used": float(resources_data.get("cpu_used", 0.0)),
                "cores": int(resources_data.get("cpu_cores", 0)),
            },
            "pids": {
                "count": int(resources_data.get("pids_count", 0)),
                "limit": int(resources_data.get("pids_limit", 0)),
            },
        }
    else:
        resource_usage = _default_resource_usage()

    logger.debug(f"Activity for agent_id={agent_id}: timeline_events={len(timeline)}")

    return {"timeline": timeline, "resourceUsage": resource_usage}


@router.get("/{agent_id}/pulse/status")
async def get_agent_pulse_status(agent_id: str):
    """
    Get agent pulse configuration and last/next run.

    Returns pulse configuration including:
        - enabled: bool
        - intervalMinutes: number
        - timeoutMs: number
        - lastPulse: object or null
        - nextPulse: timestamp or null
        - checks: enabled checks configuration
    """
    logger.debug(f"Getting pulse status for agent_id={agent_id}")

    # Read agent config from file
    import os
    import yaml

    agents_dir = os.environ.get("AGENTS_DIR", "/agents")
    config_path = os.path.join(agents_dir, agent_id, "config.yml")

    agent_config = {}
    if os.path.isfile(config_path):
        try:
            with open(config_path, "r") as f:
                agent_config = yaml.safe_load(f) or {}
        except Exception:
            pass

    # Get pulse settings from agent config (with defaults)
    pulse_enabled = agent_config.get(
        "pulse_enabled", agent_config.get("pulseEnabled", True)
    )
    pulse_interval = agent_config.get(
        "pulse_interval_minutes", agent_config.get("pulseIntervalMinutes", 30)
    )

    # Read from Redis for runtime state
    pulse_data = {}
    if dependencies.redis_client:
        try:
            pulse_key = f"djinnbot:agent:{agent_id}:pulse"
            data = await dependencies.redis_client.hgetall(pulse_key)
            pulse_data = data or {}
        except Exception:
            pass

    # Get last pulse info from Redis
    last_pulse = None
    if pulse_data.get("lastPulseTimestamp"):
        last_pulse = {
            "timestamp": int(pulse_data.get("lastPulseTimestamp", 0)),
            "duration": int(pulse_data.get("lastPulseDuration", 0)),
            "summary": pulse_data.get("lastPulseSummary", ""),
            "checksCompleted": int(pulse_data.get("checksCompleted", 0)),
            "checksFailed": int(pulse_data.get("checksFailed", 0)),
            "checks": [],  # Could store in Redis as JSON
        }

    logger.debug(
        f"Pulse status for agent_id={agent_id}: enabled={pulse_enabled}, interval={pulse_interval}min"
    )

    return {
        "enabled": pulse_enabled,
        "intervalMinutes": pulse_interval,
        "timeoutMs": 60000,
        "lastPulse": last_pulse,
        "nextPulse": None,  # Could calculate from lastPulse + interval
        "checks": {
            "inbox": True,
            "consolidateMemories": True,
            "updateWorkspaceDocs": False,
            "cleanupStaleFiles": True,
            "postStatusSlack": False,
        },
    }


@router.get("/{agent_id}/activity/stats")
async def get_agent_activity_stats(
    agent_id: str, session: AsyncSession = Depends(get_async_session)
):
    """Get quick stats for agent activity feed.

    Returns:
        - sessionsToday: number of sessions started today
        - sessionsThisWeek: sessions started in the last 7 days
        - totalTokens: total tokens used (from LLM call log) last 24h
        - totalCost: total cost last 24h
        - errorCount: failed sessions last 24h
    """
    from app.models.session import Session as SessionModel
    from app.models.llm_call_log import LlmCallLog

    now = int(time.time() * 1000)
    day_ago = now - 86_400_000
    week_ago = now - 7 * 86_400_000

    # Sessions today
    today_result = await session.execute(
        select(func.count(SessionModel.id)).where(
            SessionModel.agent_id == agent_id,
            SessionModel.created_at >= day_ago,
        )
    )
    sessions_today = today_result.scalar() or 0

    # Sessions this week
    week_result = await session.execute(
        select(func.count(SessionModel.id)).where(
            SessionModel.agent_id == agent_id,
            SessionModel.created_at >= week_ago,
        )
    )
    sessions_week = week_result.scalar() or 0

    # Failed sessions last 24h
    error_result = await session.execute(
        select(func.count(SessionModel.id)).where(
            SessionModel.agent_id == agent_id,
            SessionModel.created_at >= day_ago,
            SessionModel.status == "failed",
        )
    )
    error_count = error_result.scalar() or 0

    # Token/cost totals from LLM call log (last 24h)
    total_tokens = 0
    total_cost = 0.0
    try:
        token_result = await session.execute(
            select(
                func.coalesce(func.sum(LlmCallLog.total_tokens), 0),
                func.coalesce(func.sum(LlmCallLog.cost_total), 0.0),
            ).where(
                LlmCallLog.agent_id == agent_id,
                LlmCallLog.created_at >= day_ago,
            )
        )
        row = token_result.one_or_none()
        if row:
            total_tokens = int(row[0])
            total_cost = float(row[1])
    except Exception:
        # LlmCall table may not exist yet
        pass

    return {
        "sessionsToday": sessions_today,
        "sessionsThisWeek": sessions_week,
        "totalTokens": total_tokens,
        "totalCost": total_cost,
        "errorCount": error_count,
    }
