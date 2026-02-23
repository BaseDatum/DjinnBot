"""Pulse management API endpoints.

Provides:
- GET /api/pulses/timeline - Get upcoming pulses for all agents
- GET /api/agents/{id}/pulse-schedule - Get agent's pulse schedule
- PUT /api/agents/{id}/pulse-schedule - Update agent's pulse schedule
- POST /api/agents/{id}/pulse-schedule/one-off - Add a one-off pulse
- DELETE /api/agents/{id}/pulse-schedule/one-off/{timestamp} - Remove a one-off pulse
- POST /api/pulses/auto-spread - Auto-assign offsets to prevent conflicts
"""

import os
import json
import yaml
from datetime import datetime, timedelta
from typing import Optional, List
from fastapi import APIRouter, HTTPException, Query, Depends
from pydantic import BaseModel
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app import dependencies
from app.database import get_async_session
from app.models.pulse_routine import PulseRoutine as PulseRoutineModel
from app.logging_config import get_logger

logger = get_logger(__name__)

router = APIRouter()

AGENTS_DIR = os.getenv("AGENTS_DIR", "./agents")

# ============================================================================
# Pydantic Models
# ============================================================================


class PulseBlackout(BaseModel):
    type: str  # 'recurring' or 'one-off'
    label: Optional[str] = None
    startTime: Optional[str] = None  # HH:MM for recurring
    endTime: Optional[str] = None  # HH:MM for recurring
    daysOfWeek: Optional[List[int]] = None  # 0-6 for recurring
    start: Optional[str] = None  # ISO8601 for one-off
    end: Optional[str] = None  # ISO8601 for one-off


class PulseScheduleConfig(BaseModel):
    enabled: bool = True
    intervalMinutes: int = 30
    offsetMinutes: int = 0
    blackouts: List[PulseBlackout] = []
    oneOffs: List[str] = []  # ISO8601 timestamps
    maxConsecutiveSkips: int = 5


class PulseScheduleUpdate(BaseModel):
    enabled: Optional[bool] = None
    intervalMinutes: Optional[int] = None
    offsetMinutes: Optional[int] = None
    blackouts: Optional[List[PulseBlackout]] = None


class OneOffPulseRequest(BaseModel):
    time: str  # ISO8601 timestamp


class ScheduledPulse(BaseModel):
    agentId: str
    scheduledAt: int  # Unix timestamp ms
    source: str  # 'recurring' or 'one-off'
    status: str = "scheduled"
    routineId: Optional[str] = None
    routineName: Optional[str] = None
    routineColor: Optional[str] = None


class PulseConflict(BaseModel):
    windowStart: int
    windowEnd: int
    agents: List[dict]
    severity: str


class PulseTimelineResponse(BaseModel):
    windowStart: int
    windowEnd: int
    pulses: List[ScheduledPulse]
    conflicts: List[PulseConflict]
    summary: dict


# ============================================================================
# Helper Functions
# ============================================================================


def _load_agent_config(agent_id: str) -> dict:
    """Load agent's config.yml."""
    config_path = os.path.join(AGENTS_DIR, agent_id, "config.yml")
    if not os.path.isfile(config_path):
        return {}

    with open(config_path, "r") as f:
        return yaml.safe_load(f) or {}


def _save_agent_config(agent_id: str, config: dict) -> None:
    """Save agent's config.yml."""
    config_path = os.path.join(AGENTS_DIR, agent_id, "config.yml")
    with open(config_path, "w") as f:
        yaml.dump(config, f, default_flow_style=False)


def _get_pulse_schedule(agent_id: str) -> PulseScheduleConfig:
    """Get pulse schedule from agent's config."""
    config = _load_agent_config(agent_id)

    # Map config.yml fields to PulseScheduleConfig
    blackouts = []
    raw_blackouts = config.get("pulse_blackouts", [])
    for b in raw_blackouts:
        blackouts.append(
            PulseBlackout(
                type=b.get("type", "recurring"),
                label=b.get("label"),
                startTime=b.get("start_time") or b.get("startTime"),
                endTime=b.get("end_time") or b.get("endTime"),
                daysOfWeek=b.get("days_of_week") or b.get("daysOfWeek"),
                start=b.get("start"),
                end=b.get("end"),
            )
        )

    # Default blackout if none configured
    if not blackouts:
        blackouts = [
            PulseBlackout(
                type="recurring",
                label="Nighttime",
                startTime="23:00",
                endTime="07:00",
            )
        ]

    return PulseScheduleConfig(
        enabled=config.get("pulse_enabled", True),
        intervalMinutes=config.get("pulse_interval_minutes", 30),
        offsetMinutes=config.get("pulse_offset_minutes", 0),
        blackouts=blackouts,
        oneOffs=config.get("pulse_one_offs", []),
        maxConsecutiveSkips=config.get("pulse_max_consecutive_skips", 5),
    )


def _save_pulse_schedule(agent_id: str, schedule: PulseScheduleConfig) -> None:
    """Save pulse schedule to agent's config."""
    config = _load_agent_config(agent_id)

    # Convert blackouts to YAML format
    blackouts_yaml = []
    for b in schedule.blackouts:
        blackout = {"type": b.type}
        if b.label:
            blackout["label"] = b.label
        if b.startTime:
            blackout["start_time"] = b.startTime
        if b.endTime:
            blackout["end_time"] = b.endTime
        if b.daysOfWeek:
            blackout["days_of_week"] = b.daysOfWeek
        if b.start:
            blackout["start"] = b.start
        if b.end:
            blackout["end"] = b.end
        blackouts_yaml.append(blackout)

    config["pulse_enabled"] = schedule.enabled
    config["pulse_interval_minutes"] = schedule.intervalMinutes
    config["pulse_offset_minutes"] = schedule.offsetMinutes
    config["pulse_blackouts"] = blackouts_yaml
    config["pulse_one_offs"] = schedule.oneOffs
    config["pulse_max_consecutive_skips"] = schedule.maxConsecutiveSkips

    _save_agent_config(agent_id, config)


def _compute_upcoming_pulses(
    agent_id: str,
    schedule: PulseScheduleConfig,
    hours: int = 24,
    routine_id: Optional[str] = None,
    routine_name: Optional[str] = None,
    routine_color: Optional[str] = None,
) -> List[ScheduledPulse]:
    """Compute upcoming pulses for an agent (or a specific routine)."""
    if not schedule.enabled:
        return []

    pulses = []
    now = datetime.utcnow()
    end_time = now + timedelta(hours=hours)

    # Add one-off pulses
    for one_off in schedule.oneOffs:
        try:
            pulse_time = datetime.fromisoformat(one_off.replace("Z", "+00:00"))
            if now <= pulse_time <= end_time:
                pulses.append(
                    ScheduledPulse(
                        agentId=agent_id,
                        scheduledAt=int(pulse_time.timestamp() * 1000),
                        source="one-off",
                        status="scheduled",
                        routineId=routine_id,
                        routineName=routine_name,
                        routineColor=routine_color,
                    )
                )
        except ValueError:
            pass

    # Compute recurring pulses
    interval_minutes = schedule.intervalMinutes
    offset_minutes = schedule.offsetMinutes

    if interval_minutes <= 0:
        interval_minutes = 30  # Default fallback

    # Start from current time, find next pulse slot
    # A pulse fires at: (slot * interval) + offset minutes from midnight
    current_time = now

    # Iterate through time slots until we've covered the window
    pulse_count = 0
    max_pulses = 100  # Safety limit

    # Start checking from now
    check_time = now

    while check_time <= end_time and pulse_count < max_pulses:
        # Calculate which slot this time falls into
        minutes_since_midnight = check_time.hour * 60 + check_time.minute

        # Find the next pulse time at or after check_time
        # Pulses fire at offset, offset+interval, offset+2*interval, etc.
        if minutes_since_midnight < offset_minutes:
            # Next pulse is at offset today
            next_pulse_minutes = offset_minutes
        else:
            # Find which slot we're in or past
            minutes_past_offset = minutes_since_midnight - offset_minutes
            current_slot = minutes_past_offset // interval_minutes
            next_slot = current_slot + 1
            next_pulse_minutes = offset_minutes + (next_slot * interval_minutes)

        # Calculate the actual datetime for this pulse
        pulse_date = datetime(check_time.year, check_time.month, check_time.day)

        # Handle day rollover
        if next_pulse_minutes >= 24 * 60:
            next_pulse_minutes -= 24 * 60
            pulse_date = pulse_date + timedelta(days=1)

        pulse_time = pulse_date + timedelta(minutes=next_pulse_minutes)

        # If we've gone past end_time, stop
        if pulse_time > end_time:
            break

        # Only add if it's in the future and not in blackout
        if pulse_time > now:
            if not _is_in_blackout(pulse_time, schedule.blackouts):
                pulses.append(
                    ScheduledPulse(
                        agentId=agent_id,
                        scheduledAt=int(pulse_time.timestamp() * 1000),
                        source="recurring",
                        status="scheduled",
                        routineId=routine_id,
                        routineName=routine_name,
                        routineColor=routine_color,
                    )
                )
                pulse_count += 1

        # Move to check from just after this pulse
        check_time = pulse_time + timedelta(minutes=1)

    # Sort by time
    pulses.sort(key=lambda p: p.scheduledAt)
    return pulses


def _compute_routine_pulses(
    routine: "PulseRoutineModel", hours: int = 24
) -> List[ScheduledPulse]:
    """Compute upcoming pulses from a DB PulseRoutine record."""
    if not routine.enabled:
        return []

    # Build a PulseScheduleConfig from the routine fields
    blackouts = []
    for b in routine.blackouts or []:
        blackouts.append(
            PulseBlackout(
                type=b.get("type", "recurring"),
                label=b.get("label"),
                startTime=b.get("startTime") or b.get("start_time"),
                endTime=b.get("endTime") or b.get("end_time"),
                daysOfWeek=b.get("daysOfWeek") or b.get("days_of_week"),
                start=b.get("start"),
                end=b.get("end"),
            )
        )

    schedule = PulseScheduleConfig(
        enabled=True,
        intervalMinutes=routine.interval_minutes,
        offsetMinutes=routine.offset_minutes,
        blackouts=blackouts,
        oneOffs=routine.one_offs or [],
    )

    return _compute_upcoming_pulses(
        agent_id=routine.agent_id,
        schedule=schedule,
        hours=hours,
        routine_id=routine.id,
        routine_name=routine.name,
        routine_color=routine.color,
    )


def _is_in_blackout(time: datetime, blackouts: List[PulseBlackout]) -> bool:
    """Check if a time falls within a blackout window."""
    time_str = time.strftime("%H:%M")
    day_of_week = time.weekday()  # 0=Monday, convert to 0=Sunday
    day_of_week = (day_of_week + 1) % 7

    for blackout in blackouts:
        if blackout.type == "recurring":
            # Check day of week if specified
            if blackout.daysOfWeek and day_of_week not in blackout.daysOfWeek:
                continue

            if blackout.startTime and blackout.endTime:
                if _is_time_in_range(time_str, blackout.startTime, blackout.endTime):
                    return True

        elif blackout.type == "one-off":
            if blackout.start and blackout.end:
                try:
                    start = datetime.fromisoformat(
                        blackout.start.replace("Z", "+00:00")
                    )
                    end = datetime.fromisoformat(blackout.end.replace("Z", "+00:00"))
                    if start <= time <= end:
                        return True
                except ValueError:
                    pass

    return False


def _is_time_in_range(time_str: str, start: str, end: str) -> bool:
    """Check if time (HH:MM) is in range. Handles overnight ranges."""

    def to_minutes(t):
        h, m = map(int, t.split(":"))
        return h * 60 + m

    time_min = to_minutes(time_str)
    start_min = to_minutes(start)
    end_min = to_minutes(end)

    if start_min <= end_min:
        return start_min <= time_min < end_min
    else:
        return time_min >= start_min or time_min < end_min


def _detect_conflicts(
    pulses: List[ScheduledPulse], window_ms: int = 120000
) -> List[PulseConflict]:
    """Detect pulse conflicts (multiple agents pulsing within window_ms)."""
    conflicts = []
    seen_windows = set()

    for i, pulse in enumerate(pulses):
        window_start = pulse.scheduledAt
        window_end = pulse.scheduledAt + window_ms

        # Find conflicting pulses
        conflicting = [
            p
            for p in pulses
            if p.scheduledAt >= window_start
            and p.scheduledAt < window_end
            and p.agentId != pulse.agentId
        ]

        if conflicting:
            # Create window key to avoid duplicates
            window_key = (
                window_start // window_ms,
                frozenset(p.agentId for p in [pulse] + conflicting),
            )
            if window_key in seen_windows:
                continue
            seen_windows.add(window_key)

            agents = [
                {
                    "agentId": pulse.agentId,
                    "scheduledAt": pulse.scheduledAt,
                    "source": pulse.source,
                }
            ]
            for p in conflicting:
                agents.append(
                    {
                        "agentId": p.agentId,
                        "scheduledAt": p.scheduledAt,
                        "source": p.source,
                    }
                )

            conflicts.append(
                PulseConflict(
                    windowStart=window_start,
                    windowEnd=window_end,
                    agents=agents,
                    severity="critical" if len(agents) >= 4 else "warning",
                )
            )

    return conflicts


def _get_all_agent_ids() -> List[str]:
    """Get all agent IDs from the agents directory."""
    if not os.path.isdir(AGENTS_DIR):
        return []

    agents = []
    for entry in os.listdir(AGENTS_DIR):
        if entry.startswith("_") or entry.startswith("."):
            continue
        agent_dir = os.path.join(AGENTS_DIR, entry)
        if os.path.isdir(agent_dir):
            agents.append(entry)
    return sorted(agents)


# ============================================================================
# API Endpoints
# ============================================================================


@router.get("/timeline")
async def get_pulse_timeline(
    hours: int = Query(24, ge=1, le=168),
    db: AsyncSession = Depends(get_async_session),
):
    """Get upcoming pulse timeline for all agents.

    Uses per-routine schedules from the database.  Falls back to config.yml
    schedule for agents that have no routines configured yet.

    Args:
        hours: Number of hours to look ahead (1-168, default 24)

    Returns:
        Timeline with all scheduled pulses and detected conflicts
    """
    logger.debug(f"Getting pulse timeline for next {hours} hours")

    all_pulses: List[ScheduledPulse] = []
    by_agent: dict[str, int] = {}

    # Load all routines from the database
    result = await db.execute(
        select(PulseRoutineModel).order_by(
            PulseRoutineModel.agent_id, PulseRoutineModel.sort_order
        )
    )
    routines = result.scalars().all()

    # Group routines by agent
    agents_with_routines: set[str] = set()
    for routine in routines:
        agents_with_routines.add(routine.agent_id)
        pulses = _compute_routine_pulses(routine, hours)
        all_pulses.extend(pulses)
        by_agent[routine.agent_id] = by_agent.get(routine.agent_id, 0) + len(pulses)

    # Fallback: agents with no DB routines use config.yml schedule
    for agent_id in _get_all_agent_ids():
        if agent_id in agents_with_routines:
            continue
        schedule = _get_pulse_schedule(agent_id)
        pulses = _compute_upcoming_pulses(agent_id, schedule, hours)
        all_pulses.extend(pulses)
        by_agent[agent_id] = len(pulses)

    # Sort all pulses by time
    all_pulses.sort(key=lambda p: p.scheduledAt)

    # Detect conflicts
    conflicts = _detect_conflicts(all_pulses)

    now = int(datetime.utcnow().timestamp() * 1000)

    return PulseTimelineResponse(
        windowStart=now,
        windowEnd=now + hours * 60 * 60 * 1000,
        pulses=[p.model_dump() for p in all_pulses],
        conflicts=[c.model_dump() for c in conflicts],
        summary={
            "totalPulses": len(all_pulses),
            "byAgent": by_agent,
            "conflictCount": len(conflicts),
        },
    )


@router.get("/agents/{agent_id}/schedule")
async def get_agent_pulse_schedule(agent_id: str):
    """Get an agent's pulse schedule configuration."""
    logger.debug(f"Getting pulse schedule for agent: {agent_id}")

    agent_dir = os.path.join(AGENTS_DIR, agent_id)
    if not os.path.isdir(agent_dir):
        raise HTTPException(status_code=404, detail=f"Agent {agent_id} not found")

    schedule = _get_pulse_schedule(agent_id)

    # Also compute upcoming pulses
    upcoming = _compute_upcoming_pulses(agent_id, schedule, 48)

    return {
        "schedule": schedule.model_dump(),
        "upcoming": [p.model_dump() for p in upcoming[:20]],  # Limit to 20
    }


@router.put("/agents/{agent_id}/schedule")
async def update_agent_pulse_schedule(agent_id: str, update: PulseScheduleUpdate):
    """Update an agent's pulse schedule configuration."""
    logger.debug(f"Updating pulse schedule for agent: {agent_id}")

    agent_dir = os.path.join(AGENTS_DIR, agent_id)
    if not os.path.isdir(agent_dir):
        raise HTTPException(status_code=404, detail=f"Agent {agent_id} not found")

    # Load current schedule
    schedule = _get_pulse_schedule(agent_id)

    # Apply updates
    if update.enabled is not None:
        schedule.enabled = update.enabled
    if update.intervalMinutes is not None:
        schedule.intervalMinutes = update.intervalMinutes
    if update.offsetMinutes is not None:
        schedule.offsetMinutes = update.offsetMinutes
    if update.blackouts is not None:
        schedule.blackouts = update.blackouts

    # Save
    _save_pulse_schedule(agent_id, schedule)

    # Notify the core system to reload schedule (via Redis pub/sub if available)
    if dependencies.redis_client:
        try:
            await dependencies.redis_client.publish(
                "djinnbot:pulse:schedule-updated", json.dumps({"agentId": agent_id})
            )
        except Exception as e:
            logger.warning(f"Failed to publish schedule update: {e}")

    return {"status": "updated", "schedule": schedule.model_dump()}


@router.post("/agents/{agent_id}/schedule/one-off")
async def add_one_off_pulse(agent_id: str, req: OneOffPulseRequest):
    """Add a one-off pulse for an agent."""
    logger.debug(f"Adding one-off pulse for agent: {agent_id} at {req.time}")

    agent_dir = os.path.join(AGENTS_DIR, agent_id)
    if not os.path.isdir(agent_dir):
        raise HTTPException(status_code=404, detail=f"Agent {agent_id} not found")

    # Validate timestamp
    try:
        pulse_time = datetime.fromisoformat(req.time.replace("Z", "+00:00"))
        if pulse_time < datetime.utcnow():
            raise HTTPException(
                status_code=400, detail="Pulse time must be in the future"
            )
    except ValueError:
        raise HTTPException(
            status_code=400, detail="Invalid timestamp format. Use ISO8601."
        )

    # Load and update schedule
    schedule = _get_pulse_schedule(agent_id)

    if req.time not in schedule.oneOffs:
        schedule.oneOffs.append(req.time)
        _save_pulse_schedule(agent_id, schedule)

    # Notify core system
    if dependencies.redis_client:
        try:
            await dependencies.redis_client.publish(
                "djinnbot:pulse:schedule-updated", json.dumps({"agentId": agent_id})
            )
        except Exception:
            pass

    return {"status": "added", "time": req.time}


@router.delete("/agents/{agent_id}/schedule/one-off/{timestamp}")
async def remove_one_off_pulse(agent_id: str, timestamp: str):
    """Remove a one-off pulse for an agent."""
    logger.debug(f"Removing one-off pulse for agent: {agent_id} at {timestamp}")

    agent_dir = os.path.join(AGENTS_DIR, agent_id)
    if not os.path.isdir(agent_dir):
        raise HTTPException(status_code=404, detail=f"Agent {agent_id} not found")

    schedule = _get_pulse_schedule(agent_id)

    # URL decode the timestamp
    import urllib.parse

    decoded_timestamp = urllib.parse.unquote(timestamp)

    if decoded_timestamp in schedule.oneOffs:
        schedule.oneOffs.remove(decoded_timestamp)
        _save_pulse_schedule(agent_id, schedule)

    return {"status": "removed", "time": decoded_timestamp}


@router.post("/auto-spread")
async def auto_spread_offsets():
    """Auto-assign offsets to all agents to minimize pulse conflicts.

    Uses a simple strategy: spread agents evenly across the interval.
    """
    logger.info("Auto-spreading pulse offsets for all agents")

    agent_ids = _get_all_agent_ids()
    if not agent_ids:
        return {"status": "no_agents", "changes": {}}

    # Assume default interval (30 min)
    interval = 30
    changes = {}

    for idx, agent_id in enumerate(agent_ids):
        schedule = _get_pulse_schedule(agent_id)
        old_offset = schedule.offsetMinutes

        # Spread evenly: each agent gets interval/n_agents minutes apart
        new_offset = (idx * interval) // len(agent_ids)

        if new_offset != old_offset:
            schedule.offsetMinutes = new_offset
            _save_pulse_schedule(agent_id, schedule)
            changes[agent_id] = {"old": old_offset, "new": new_offset}

    # Notify core system
    if dependencies.redis_client:
        try:
            await dependencies.redis_client.publish(
                "djinnbot:pulse:offsets-updated", json.dumps({"changes": changes})
            )
        except Exception:
            pass

    logger.info(f"Auto-spread complete: {len(changes)} agents updated")

    return {
        "status": "updated",
        "changes": changes,
        "totalAgents": len(agent_ids),
    }
