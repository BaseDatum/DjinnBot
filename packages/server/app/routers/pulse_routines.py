"""Pulse routine CRUD API endpoints.

Provides per-agent named pulse routines with independent instructions,
schedules, and execution settings.  All routine data is stored in the
database — there is no file-based fallback.

Endpoints:
- GET    /api/v1/agents/{agent_id}/pulse-routines          - List routines
- POST   /api/v1/agents/{agent_id}/pulse-routines          - Create routine
- GET    /api/v1/agents/{agent_id}/pulse-routines/{id}     - Get routine
- PUT    /api/v1/agents/{agent_id}/pulse-routines/{id}     - Update routine
- DELETE /api/v1/agents/{agent_id}/pulse-routines/{id}     - Delete routine
- POST   /api/v1/agents/{agent_id}/pulse-routines/{id}/trigger   - Trigger now
- PATCH  /api/v1/agents/{agent_id}/pulse-routines/{id}/toggle    - Toggle enable
- POST   /api/v1/agents/{agent_id}/pulse-routines/reorder        - Reorder
- POST   /api/v1/agents/{agent_id}/pulse-routines/{id}/duplicate - Duplicate
"""

import json
import os
from typing import Optional, List

from fastapi import APIRouter, HTTPException, Depends
from pydantic import BaseModel, Field
from sqlalchemy import select, update, delete, func
from sqlalchemy.ext.asyncio import AsyncSession

from app import dependencies
from app.database import get_async_session
from app.models.pulse_routine import PulseRoutine
from app.models.base import now_ms
from app.logging_config import get_logger

logger = get_logger(__name__)

router = APIRouter()

AGENTS_DIR = os.getenv("AGENTS_DIR", "./agents")

# Default color palette for auto-assigning routine colors
ROUTINE_COLORS = [
    "#3b82f6",  # blue
    "#8b5cf6",  # violet
    "#06b6d4",  # cyan
    "#10b981",  # emerald
    "#f59e0b",  # amber
    "#ef4444",  # red
    "#ec4899",  # pink
    "#6366f1",  # indigo
]


# ============================================================================
# Pydantic Request / Response Models
# ============================================================================


class PulseBlackoutSchema(BaseModel):
    type: str = "recurring"
    label: Optional[str] = None
    startTime: Optional[str] = None
    endTime: Optional[str] = None
    daysOfWeek: Optional[List[int]] = None
    start: Optional[str] = None
    end: Optional[str] = None


class CreatePulseRoutineRequest(BaseModel):
    name: str = Field(..., min_length=1, max_length=256)
    description: Optional[str] = None
    instructions: str = ""
    enabled: bool = True
    intervalMinutes: int = Field(default=30, ge=1, le=10080)
    offsetMinutes: int = Field(default=0, ge=0)
    blackouts: List[PulseBlackoutSchema] = []
    oneOffs: List[str] = []
    timeoutMs: Optional[int] = None
    maxConcurrent: int = Field(default=1, ge=1, le=10)
    pulseColumns: Optional[List[str]] = None
    color: Optional[str] = None
    planningModel: Optional[str] = None
    executorModel: Optional[str] = None
    # Per-routine tool selection. When null → inherit agent defaults.
    # When set → only these tools are available during this routine.
    tools: Optional[List[str]] = None


class UpdatePulseRoutineRequest(BaseModel):
    name: Optional[str] = Field(default=None, min_length=1, max_length=256)
    description: Optional[str] = None
    instructions: Optional[str] = None
    enabled: Optional[bool] = None
    intervalMinutes: Optional[int] = Field(default=None, ge=1, le=10080)
    offsetMinutes: Optional[int] = Field(default=None, ge=0)
    blackouts: Optional[List[PulseBlackoutSchema]] = None
    oneOffs: Optional[List[str]] = None
    timeoutMs: Optional[int] = None
    maxConcurrent: Optional[int] = Field(default=None, ge=1, le=10)
    pulseColumns: Optional[List[str]] = None
    color: Optional[str] = None
    planningModel: Optional[str] = None
    executorModel: Optional[str] = None
    tools: Optional[List[str]] = None


class ReorderRequest(BaseModel):
    routineIds: List[str]


class PulseRoutineResponse(BaseModel):
    id: str
    agentId: str
    name: str
    description: Optional[str]
    instructions: str
    enabled: bool
    intervalMinutes: int
    offsetMinutes: int
    blackouts: list
    oneOffs: list
    timeoutMs: Optional[int]
    maxConcurrent: int
    pulseColumns: Optional[list]
    sortOrder: int
    lastRunAt: Optional[int]
    totalRuns: int
    color: Optional[str]
    createdAt: int
    updatedAt: int

    class Config:
        from_attributes = True


# ============================================================================
# Helpers
# ============================================================================


def _model_to_response(r: PulseRoutine) -> dict:
    """Convert a PulseRoutine ORM object to a response dict."""
    return {
        "id": r.id,
        "agentId": r.agent_id,
        "name": r.name,
        "description": r.description,
        "instructions": r.instructions,
        "enabled": r.enabled,
        "intervalMinutes": r.interval_minutes,
        "offsetMinutes": r.offset_minutes,
        "blackouts": r.blackouts or [],
        "oneOffs": r.one_offs or [],
        "timeoutMs": r.timeout_ms,
        "maxConcurrent": r.max_concurrent,
        "pulseColumns": r.pulse_columns,
        "planningModel": r.planning_model,
        "executorModel": r.executor_model,
        "tools": r.tools,
        "sortOrder": r.sort_order,
        "lastRunAt": r.last_run_at,
        "totalRuns": r.total_runs,
        "color": r.color,
        "createdAt": r.created_at,
        "updatedAt": r.updated_at,
    }


def _validate_agent_exists(agent_id: str) -> None:
    """Check agent directory exists on disk."""
    agent_dir = os.path.join(AGENTS_DIR, agent_id)
    if not os.path.isdir(agent_dir):
        raise HTTPException(status_code=404, detail=f"Agent {agent_id} not found")


def _pick_color(existing_colors: List[Optional[str]]) -> str:
    """Pick the next unused color from the palette."""
    used = set(c for c in existing_colors if c)
    for c in ROUTINE_COLORS:
        if c not in used:
            return c
    # If all used, cycle back
    return ROUTINE_COLORS[len(existing_colors) % len(ROUTINE_COLORS)]


async def _notify_schedule_change(agent_id: str, routine_id: str | None = None) -> None:
    """Notify the core runtime that a routine schedule changed."""
    if dependencies.redis_client:
        try:
            await dependencies.redis_client.publish(
                "djinnbot:pulse:routine-updated",
                json.dumps({"agentId": agent_id, "routineId": routine_id}),
            )
        except Exception as e:
            logger.warning(f"Failed to publish routine update: {e}")


# ============================================================================
# Endpoints
# ============================================================================


@router.get("/agents/{agent_id}/pulse-routines")
async def list_pulse_routines(
    agent_id: str,
    db: AsyncSession = Depends(get_async_session),
):
    """List all pulse routines for an agent, ordered by sort_order."""
    _validate_agent_exists(agent_id)

    result = await db.execute(
        select(PulseRoutine)
        .where(PulseRoutine.agent_id == agent_id)
        .order_by(PulseRoutine.sort_order, PulseRoutine.created_at)
    )
    routines = result.scalars().all()
    return {"routines": [_model_to_response(r) for r in routines]}


@router.post("/agents/{agent_id}/pulse-routines", status_code=201)
async def create_pulse_routine(
    agent_id: str,
    req: CreatePulseRoutineRequest,
    db: AsyncSession = Depends(get_async_session),
):
    """Create a new pulse routine for an agent."""
    _validate_agent_exists(agent_id)

    # Check name uniqueness
    existing = await db.execute(
        select(PulseRoutine).where(
            PulseRoutine.agent_id == agent_id, PulseRoutine.name == req.name
        )
    )
    if existing.scalar_one_or_none():
        raise HTTPException(
            status_code=409,
            detail=f"Routine '{req.name}' already exists for this agent",
        )

    # Determine sort order
    max_order = await db.execute(
        select(func.max(PulseRoutine.sort_order)).where(
            PulseRoutine.agent_id == agent_id
        )
    )
    next_order = (max_order.scalar() or 0) + 1

    # Pick color
    existing_colors_result = await db.execute(
        select(PulseRoutine.color).where(PulseRoutine.agent_id == agent_id)
    )
    existing_colors = [row[0] for row in existing_colors_result]
    color = req.color or _pick_color(existing_colors)

    ts = now_ms()
    routine = PulseRoutine(
        id=PulseRoutine.generate_id(),
        agent_id=agent_id,
        name=req.name,
        description=req.description,
        instructions=req.instructions,
        enabled=req.enabled,
        interval_minutes=req.intervalMinutes,
        offset_minutes=req.offsetMinutes,
        blackouts=[b.model_dump(exclude_none=True) for b in req.blackouts],
        one_offs=req.oneOffs,
        timeout_ms=req.timeoutMs,
        max_concurrent=req.maxConcurrent,
        pulse_columns=req.pulseColumns,
        planning_model=req.planningModel,
        executor_model=req.executorModel,
        tools=req.tools,
        sort_order=next_order,
        color=color,
        created_at=ts,
        updated_at=ts,
    )
    db.add(routine)
    await db.commit()
    await db.refresh(routine)

    await _notify_schedule_change(agent_id, routine.id)
    return _model_to_response(routine)


@router.get("/agents/{agent_id}/pulse-routines/{routine_id}")
async def get_pulse_routine(
    agent_id: str,
    routine_id: str,
    db: AsyncSession = Depends(get_async_session),
):
    """Get a specific pulse routine."""
    _validate_agent_exists(agent_id)

    result = await db.execute(
        select(PulseRoutine).where(
            PulseRoutine.id == routine_id, PulseRoutine.agent_id == agent_id
        )
    )
    routine = result.scalar_one_or_none()
    if not routine:
        raise HTTPException(status_code=404, detail="Routine not found")

    return _model_to_response(routine)


@router.put("/agents/{agent_id}/pulse-routines/{routine_id}")
async def update_pulse_routine(
    agent_id: str,
    routine_id: str,
    req: UpdatePulseRoutineRequest,
    db: AsyncSession = Depends(get_async_session),
):
    """Update a pulse routine."""
    _validate_agent_exists(agent_id)

    result = await db.execute(
        select(PulseRoutine).where(
            PulseRoutine.id == routine_id, PulseRoutine.agent_id == agent_id
        )
    )
    routine = result.scalar_one_or_none()
    if not routine:
        raise HTTPException(status_code=404, detail="Routine not found")

    # Check name uniqueness if renaming
    if req.name is not None and req.name != routine.name:
        dup = await db.execute(
            select(PulseRoutine).where(
                PulseRoutine.agent_id == agent_id,
                PulseRoutine.name == req.name,
                PulseRoutine.id != routine_id,
            )
        )
        if dup.scalar_one_or_none():
            raise HTTPException(
                status_code=409, detail=f"Routine '{req.name}' already exists"
            )

    # Apply updates
    update_fields = {}
    if req.name is not None:
        update_fields["name"] = req.name
    if req.description is not None:
        update_fields["description"] = req.description
    if req.instructions is not None:
        update_fields["instructions"] = req.instructions
    if req.enabled is not None:
        update_fields["enabled"] = req.enabled
    if req.intervalMinutes is not None:
        update_fields["interval_minutes"] = req.intervalMinutes
    if req.offsetMinutes is not None:
        update_fields["offset_minutes"] = req.offsetMinutes
    if req.blackouts is not None:
        update_fields["blackouts"] = [
            b.model_dump(exclude_none=True) for b in req.blackouts
        ]
    if req.oneOffs is not None:
        update_fields["one_offs"] = req.oneOffs
    if req.timeoutMs is not None:
        update_fields["timeout_ms"] = req.timeoutMs
    if req.maxConcurrent is not None:
        update_fields["max_concurrent"] = req.maxConcurrent
    if req.pulseColumns is not None:
        update_fields["pulse_columns"] = req.pulseColumns
    if req.color is not None:
        update_fields["color"] = req.color
    if req.planningModel is not None:
        update_fields["planning_model"] = (
            req.planningModel or None
        )  # empty string → null
    if req.executorModel is not None:
        update_fields["executor_model"] = (
            req.executorModel or None
        )  # empty string → null
    if req.tools is not None:
        update_fields["tools"] = req.tools if req.tools else None  # empty list → null

    if update_fields:
        update_fields["updated_at"] = now_ms()
        await db.execute(
            update(PulseRoutine)
            .where(PulseRoutine.id == routine_id)
            .values(**update_fields)
        )
        await db.commit()
        await db.refresh(routine)

    await _notify_schedule_change(agent_id, routine_id)
    return _model_to_response(routine)


@router.delete("/agents/{agent_id}/pulse-routines/{routine_id}")
async def delete_pulse_routine(
    agent_id: str,
    routine_id: str,
    db: AsyncSession = Depends(get_async_session),
):
    """Delete a pulse routine."""
    _validate_agent_exists(agent_id)

    result = await db.execute(
        select(PulseRoutine).where(
            PulseRoutine.id == routine_id, PulseRoutine.agent_id == agent_id
        )
    )
    routine = result.scalar_one_or_none()
    if not routine:
        raise HTTPException(status_code=404, detail="Routine not found")

    await db.execute(delete(PulseRoutine).where(PulseRoutine.id == routine_id))
    await db.commit()

    await _notify_schedule_change(agent_id, routine_id)
    return {"status": "deleted", "id": routine_id}


@router.patch("/agents/{agent_id}/pulse-routines/{routine_id}/toggle")
async def toggle_pulse_routine(
    agent_id: str,
    routine_id: str,
    db: AsyncSession = Depends(get_async_session),
):
    """Toggle a routine's enabled state."""
    _validate_agent_exists(agent_id)

    result = await db.execute(
        select(PulseRoutine).where(
            PulseRoutine.id == routine_id, PulseRoutine.agent_id == agent_id
        )
    )
    routine = result.scalar_one_or_none()
    if not routine:
        raise HTTPException(status_code=404, detail="Routine not found")

    new_enabled = not routine.enabled
    await db.execute(
        update(PulseRoutine)
        .where(PulseRoutine.id == routine_id)
        .values(enabled=new_enabled, updated_at=now_ms())
    )
    await db.commit()
    await db.refresh(routine)

    await _notify_schedule_change(agent_id, routine_id)
    return {"id": routine_id, "enabled": new_enabled}


@router.post("/agents/{agent_id}/pulse-routines/{routine_id}/trigger")
async def trigger_pulse_routine(
    agent_id: str,
    routine_id: str,
    db: AsyncSession = Depends(get_async_session),
):
    """Manually trigger a specific pulse routine."""
    _validate_agent_exists(agent_id)

    result = await db.execute(
        select(PulseRoutine).where(
            PulseRoutine.id == routine_id, PulseRoutine.agent_id == agent_id
        )
    )
    routine = result.scalar_one_or_none()
    if not routine:
        raise HTTPException(status_code=404, detail="Routine not found")

    # Publish trigger event to Redis
    if dependencies.redis_client:
        try:
            await dependencies.redis_client.publish(
                "djinnbot:pulse:trigger-routine",
                json.dumps(
                    {
                        "agentId": agent_id,
                        "routineId": routine_id,
                        "routineName": routine.name,
                    }
                ),
            )
        except Exception as e:
            logger.warning(f"Failed to publish trigger: {e}")
            raise HTTPException(status_code=500, detail="Failed to trigger pulse")

    return {"status": "triggered", "routineId": routine_id, "routineName": routine.name}


@router.post("/agents/{agent_id}/pulse-routines/{routine_id}/duplicate")
async def duplicate_pulse_routine(
    agent_id: str,
    routine_id: str,
    db: AsyncSession = Depends(get_async_session),
):
    """Duplicate an existing routine with a new name."""
    _validate_agent_exists(agent_id)

    result = await db.execute(
        select(PulseRoutine).where(
            PulseRoutine.id == routine_id, PulseRoutine.agent_id == agent_id
        )
    )
    source = result.scalar_one_or_none()
    if not source:
        raise HTTPException(status_code=404, detail="Routine not found")

    # Generate unique name
    base_name = f"{source.name} (copy)"
    name = base_name
    counter = 2
    while True:
        dup = await db.execute(
            select(PulseRoutine).where(
                PulseRoutine.agent_id == agent_id, PulseRoutine.name == name
            )
        )
        if not dup.scalar_one_or_none():
            break
        name = f"{base_name} {counter}"
        counter += 1

    # Determine sort order
    max_order = await db.execute(
        select(func.max(PulseRoutine.sort_order)).where(
            PulseRoutine.agent_id == agent_id
        )
    )
    next_order = (max_order.scalar() or 0) + 1

    # Pick color
    existing_colors_result = await db.execute(
        select(PulseRoutine.color).where(PulseRoutine.agent_id == agent_id)
    )
    existing_colors = [row[0] for row in existing_colors_result]
    color = _pick_color(existing_colors)

    ts = now_ms()
    clone = PulseRoutine(
        id=PulseRoutine.generate_id(),
        agent_id=agent_id,
        name=name,
        description=source.description,
        instructions=source.instructions,
        enabled=False,  # Start disabled
        interval_minutes=source.interval_minutes,
        offset_minutes=source.offset_minutes,
        blackouts=source.blackouts,
        one_offs=[],  # Don't copy one-offs
        timeout_ms=source.timeout_ms,
        max_concurrent=source.max_concurrent,
        pulse_columns=source.pulse_columns,
        sort_order=next_order,
        color=color,
        created_at=ts,
        updated_at=ts,
    )
    db.add(clone)
    await db.commit()
    await db.refresh(clone)

    return _model_to_response(clone)


@router.post("/agents/{agent_id}/pulse-routines/reorder")
async def reorder_pulse_routines(
    agent_id: str,
    req: ReorderRequest,
    db: AsyncSession = Depends(get_async_session),
):
    """Reorder routines by providing the full list of IDs in desired order."""
    _validate_agent_exists(agent_id)

    for idx, rid in enumerate(req.routineIds):
        await db.execute(
            update(PulseRoutine)
            .where(PulseRoutine.id == rid, PulseRoutine.agent_id == agent_id)
            .values(sort_order=idx, updated_at=now_ms())
        )
    await db.commit()

    return {"status": "reordered"}


@router.post("/pulse-routines/{routine_id}/record-run")
async def record_routine_run(
    routine_id: str,
    db: AsyncSession = Depends(get_async_session),
):
    """Record that a routine just completed a run (update stats).

    Called by the engine after each routine pulse session finishes.
    """
    ts = now_ms()
    result = await db.execute(
        update(PulseRoutine)
        .where(PulseRoutine.id == routine_id)
        .values(
            last_run_at=ts,
            total_runs=PulseRoutine.total_runs + 1,
            updated_at=ts,
        )
    )
    await db.commit()

    if result.rowcount == 0:
        raise HTTPException(status_code=404, detail="Routine not found")

    return {"status": "recorded", "routineId": routine_id, "lastRunAt": ts}
