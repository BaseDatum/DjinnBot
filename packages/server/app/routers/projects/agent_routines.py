"""Project-Agent-Routine mapping endpoints.

Manages the relationship between pulse routines and projects for each agent.
When an agent is assigned to a project, you can map specific pulse routines
to specific columns in that project, and optionally override which tools
are available during each routine.

Endpoints (nested under /v1/projects/{project_id}):
- GET    /agents/{agent_id}/routines              - List routine mappings
- POST   /agents/{agent_id}/routines              - Create mapping
- PUT    /agents/{agent_id}/routines/{mapping_id} - Update mapping
- DELETE /agents/{agent_id}/routines/{mapping_id} - Delete mapping
- GET    /agents/{agent_id}/routines/resolve       - Resolve effective config
"""

import json
from typing import Optional, List

from fastapi import APIRouter, HTTPException, Depends
from pydantic import BaseModel, Field
from sqlalchemy import select, update, delete
from sqlalchemy.ext.asyncio import AsyncSession

from app.database import get_async_session
from app.models.project_agent_routine import ProjectAgentRoutine
from app.models.pulse_routine import PulseRoutine
from app.models.agent import ProjectAgent as ProjectAgentModel
from app.models import KanbanColumn
from app.utils import now_ms
from app.logging_config import get_logger
from ._common import get_project_or_404, _publish_event

logger = get_logger(__name__)
router = APIRouter()


# ============================================================================
# Pydantic schemas
# ============================================================================


class CreateRoutineMappingRequest(BaseModel):
    routineId: str = Field(..., description="Pulse routine ID to map")
    # Column IDs this routine should watch in this project.
    # null = use routine's default pulse_columns
    columnIds: Optional[List[str]] = None
    # Tool overrides for this project-routine combo.
    # null = use routine's tools (or agent default)
    toolOverrides: Optional[List[str]] = None
    enabled: bool = True


class UpdateRoutineMappingRequest(BaseModel):
    columnIds: Optional[List[str]] = None
    toolOverrides: Optional[List[str]] = None
    enabled: Optional[bool] = None


def _serialize_mapping(m: ProjectAgentRoutine) -> dict:
    return {
        "id": m.id,
        "projectId": m.project_id,
        "agentId": m.agent_id,
        "routineId": m.routine_id,
        "columnIds": m.column_ids,
        "toolOverrides": m.tool_overrides,
        "enabled": m.enabled,
        "createdAt": m.created_at,
        "updatedAt": m.updated_at,
    }


# ============================================================================
# Endpoints
# ============================================================================


@router.get("/{project_id}/agents/{agent_id}/routines")
async def list_routine_mappings(
    project_id: str,
    agent_id: str,
    session: AsyncSession = Depends(get_async_session),
):
    """List all routine mappings for an agent in a project.

    Returns the mappings enriched with routine name/description for display.
    """
    await get_project_or_404(session, project_id)

    # Verify agent is assigned to project
    agent_result = await session.execute(
        select(ProjectAgentModel).where(
            ProjectAgentModel.project_id == project_id,
            ProjectAgentModel.agent_id == agent_id,
        )
    )
    if not agent_result.scalar_one_or_none():
        raise HTTPException(
            status_code=404,
            detail=f"Agent {agent_id} is not assigned to project {project_id}",
        )

    # Get mappings
    result = await session.execute(
        select(ProjectAgentRoutine).where(
            ProjectAgentRoutine.project_id == project_id,
            ProjectAgentRoutine.agent_id == agent_id,
        )
    )
    mappings = result.scalars().all()

    # Enrich with routine info
    routine_ids = [m.routine_id for m in mappings]
    routines_map = {}
    if routine_ids:
        routines_result = await session.execute(
            select(PulseRoutine).where(PulseRoutine.id.in_(routine_ids))
        )
        for r in routines_result.scalars().all():
            routines_map[r.id] = {
                "name": r.name,
                "description": r.description,
                "tools": r.tools,
                "pulseColumns": r.pulse_columns,
            }

    # Get project columns for reference
    cols_result = await session.execute(
        select(KanbanColumn)
        .where(KanbanColumn.project_id == project_id)
        .order_by(KanbanColumn.position)
    )
    columns = [
        {
            "id": c.id,
            "name": c.name,
            "statuses": json.loads(c.task_statuses) if c.task_statuses else [],
        }
        for c in cols_result.scalars().all()
    ]

    enriched = []
    for m in mappings:
        data = _serialize_mapping(m)
        routine_info = routines_map.get(m.routine_id, {})
        data["routineName"] = routine_info.get("name", "Unknown")
        data["routineDescription"] = routine_info.get("description")
        data["routineDefaultTools"] = routine_info.get("tools")
        data["routineDefaultColumns"] = routine_info.get("pulseColumns")
        enriched.append(data)

    return {
        "mappings": enriched,
        "projectColumns": columns,
    }


@router.post("/{project_id}/agents/{agent_id}/routines", status_code=201)
async def create_routine_mapping(
    project_id: str,
    agent_id: str,
    req: CreateRoutineMappingRequest,
    session: AsyncSession = Depends(get_async_session),
):
    """Map a pulse routine to this project for this agent.

    Specifies which columns the routine watches and optionally overrides tools.
    """
    await get_project_or_404(session, project_id)

    # Verify agent is assigned
    agent_check = await session.execute(
        select(ProjectAgentModel).where(
            ProjectAgentModel.project_id == project_id,
            ProjectAgentModel.agent_id == agent_id,
        )
    )
    if not agent_check.scalar_one_or_none():
        raise HTTPException(
            status_code=404,
            detail=f"Agent {agent_id} is not assigned to project {project_id}",
        )

    # Verify routine exists and belongs to agent
    routine_check = await session.execute(
        select(PulseRoutine).where(
            PulseRoutine.id == req.routineId,
            PulseRoutine.agent_id == agent_id,
        )
    )
    if not routine_check.scalar_one_or_none():
        raise HTTPException(
            status_code=404,
            detail=f"Routine {req.routineId} not found for agent {agent_id}",
        )

    # Check for duplicate mapping
    dup_check = await session.execute(
        select(ProjectAgentRoutine).where(
            ProjectAgentRoutine.project_id == project_id,
            ProjectAgentRoutine.agent_id == agent_id,
            ProjectAgentRoutine.routine_id == req.routineId,
        )
    )
    if dup_check.scalar_one_or_none():
        raise HTTPException(
            status_code=409,
            detail="This routine is already mapped to this project for this agent",
        )

    # Validate column IDs if provided
    if req.columnIds:
        col_check = await session.execute(
            select(KanbanColumn.id).where(
                KanbanColumn.project_id == project_id,
                KanbanColumn.id.in_(req.columnIds),
            )
        )
        valid_ids = {row[0] for row in col_check.all()}
        invalid = set(req.columnIds) - valid_ids
        if invalid:
            raise HTTPException(
                status_code=400,
                detail=f"Invalid column IDs for this project: {sorted(invalid)}",
            )

    ts = now_ms()
    mapping = ProjectAgentRoutine(
        id=ProjectAgentRoutine.generate_id(),
        project_id=project_id,
        agent_id=agent_id,
        routine_id=req.routineId,
        column_ids=req.columnIds,
        tool_overrides=req.toolOverrides,
        enabled=req.enabled,
        created_at=ts,
        updated_at=ts,
    )
    session.add(mapping)
    await session.commit()
    await session.refresh(mapping)

    await _publish_event(
        "AGENT_ROUTINE_MAPPED",
        {
            "projectId": project_id,
            "agentId": agent_id,
            "routineId": req.routineId,
            "mappingId": mapping.id,
        },
    )

    return _serialize_mapping(mapping)


@router.put("/{project_id}/agents/{agent_id}/routines/{mapping_id}")
async def update_routine_mapping(
    project_id: str,
    agent_id: str,
    mapping_id: str,
    req: UpdateRoutineMappingRequest,
    session: AsyncSession = Depends(get_async_session),
):
    """Update a routine mapping's column assignments or tool overrides."""
    result = await session.execute(
        select(ProjectAgentRoutine).where(
            ProjectAgentRoutine.id == mapping_id,
            ProjectAgentRoutine.project_id == project_id,
            ProjectAgentRoutine.agent_id == agent_id,
        )
    )
    mapping = result.scalar_one_or_none()
    if not mapping:
        raise HTTPException(status_code=404, detail="Mapping not found")

    update_fields = {}
    if req.columnIds is not None:
        # Validate column IDs
        if req.columnIds:
            col_check = await session.execute(
                select(KanbanColumn.id).where(
                    KanbanColumn.project_id == project_id,
                    KanbanColumn.id.in_(req.columnIds),
                )
            )
            valid_ids = {row[0] for row in col_check.all()}
            invalid = set(req.columnIds) - valid_ids
            if invalid:
                raise HTTPException(
                    status_code=400,
                    detail=f"Invalid column IDs: {sorted(invalid)}",
                )
        update_fields["column_ids"] = req.columnIds or None
    if req.toolOverrides is not None:
        update_fields["tool_overrides"] = req.toolOverrides or None
    if req.enabled is not None:
        update_fields["enabled"] = req.enabled

    if update_fields:
        update_fields["updated_at"] = now_ms()
        await session.execute(
            update(ProjectAgentRoutine)
            .where(ProjectAgentRoutine.id == mapping_id)
            .values(**update_fields)
        )
        await session.commit()
        await session.refresh(mapping)

    return _serialize_mapping(mapping)


@router.delete("/{project_id}/agents/{agent_id}/routines/{mapping_id}")
async def delete_routine_mapping(
    project_id: str,
    agent_id: str,
    mapping_id: str,
    session: AsyncSession = Depends(get_async_session),
):
    """Remove a routine mapping from this project."""
    result = await session.execute(
        delete(ProjectAgentRoutine).where(
            ProjectAgentRoutine.id == mapping_id,
            ProjectAgentRoutine.project_id == project_id,
            ProjectAgentRoutine.agent_id == agent_id,
        )
    )
    await session.commit()

    if result.rowcount == 0:
        raise HTTPException(status_code=404, detail="Mapping not found")

    return {"status": "deleted", "id": mapping_id}


@router.get("/{project_id}/agents/{agent_id}/routines/resolve")
async def resolve_routine_config(
    project_id: str,
    agent_id: str,
    session: AsyncSession = Depends(get_async_session),
):
    """Resolve the effective configuration for all of an agent's routines in a project.

    Returns the merged view: routine defaults + project-specific overrides.
    This is what the runtime uses to determine what tools and columns to use.
    """
    await get_project_or_404(session, project_id)

    # Get all mappings
    mappings_result = await session.execute(
        select(ProjectAgentRoutine).where(
            ProjectAgentRoutine.project_id == project_id,
            ProjectAgentRoutine.agent_id == agent_id,
            ProjectAgentRoutine.enabled == True,
        )
    )
    mappings = mappings_result.scalars().all()

    # Get routines
    routine_ids = [m.routine_id for m in mappings]
    routines_map = {}
    if routine_ids:
        routines_result = await session.execute(
            select(PulseRoutine).where(PulseRoutine.id.in_(routine_ids))
        )
        for r in routines_result.scalars().all():
            routines_map[r.id] = r

    # Get project columns
    cols_result = await session.execute(
        select(KanbanColumn)
        .where(KanbanColumn.project_id == project_id)
        .order_by(KanbanColumn.position)
    )
    columns = cols_result.scalars().all()
    col_id_to_name = {c.id: c.name for c in columns}
    col_name_to_statuses = {}
    for c in columns:
        statuses = json.loads(c.task_statuses) if c.task_statuses else []
        col_name_to_statuses[c.name] = statuses

    resolved = []
    for m in mappings:
        routine = routines_map.get(m.routine_id)
        if not routine:
            continue

        # Resolve columns: mapping override → routine default → all columns
        effective_column_names = []
        effective_statuses = []
        if m.column_ids:
            for cid in m.column_ids:
                name = col_id_to_name.get(cid)
                if name:
                    effective_column_names.append(name)
                    effective_statuses.extend(col_name_to_statuses.get(name, []))
        elif routine.pulse_columns:
            for name in routine.pulse_columns:
                effective_column_names.append(name)
                effective_statuses.extend(col_name_to_statuses.get(name, []))

        # Resolve tools: mapping override → routine tools → null (agent default)
        effective_tools = m.tool_overrides or routine.tools or None

        resolved.append(
            {
                "routineId": routine.id,
                "routineName": routine.name,
                "mappingId": m.id,
                "effectiveColumns": effective_column_names,
                "effectiveStatuses": effective_statuses,
                "effectiveTools": effective_tools,
                "planningModel": routine.planning_model,
                "executorModel": routine.executor_model,
            }
        )

    return {"resolved": resolved}
