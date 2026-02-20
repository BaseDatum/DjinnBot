"""Agent assignment endpoints for projects."""
import json
from fastapi import APIRouter, HTTPException, Depends
from sqlalchemy import select, update, delete
from sqlalchemy.ext.asyncio import AsyncSession

from app.database import get_async_session
from app.models import Project
from app.models.agent import ProjectAgent as ProjectAgentModel
from app.schemas import AssignAgentRequest, UpdateAgentRoleRequest
from app.utils import now_ms, gen_id
from app.logging_config import get_logger
from ._common import get_project_or_404, _publish_event

logger = get_logger(__name__)
router = APIRouter()


# ══════════════════════════════════════════════════════════════════════════
# AGENT ASSIGNMENT ENDPOINTS
# ══════════════════════════════════════════════════════════════════════════

@router.post("/{project_id}/agents")
async def assign_agent_to_project(project_id: str, req: AssignAgentRequest, session: AsyncSession = Depends(get_async_session)):
    """
    Assign an agent to a project with a role.
    
    Roles:
    - lead: Primary agent, can assign tasks and run pipelines
    - member: Standard team member, can execute tasks
    - reviewer: Reviews completed work
    """
    logger.debug(f"Assigning agent: project_id={project_id}, agent_id={req.agentId}, role={req.role}")
    now = now_ms()
    
    # Verify project exists
    await get_project_or_404(session, project_id)
    
    # Check if already assigned
    result = await session.execute(
        select(ProjectAgentModel)
        .where(ProjectAgentModel.project_id == project_id, ProjectAgentModel.agent_id == req.agentId)
    )
    if result.scalar_one_or_none():
        raise HTTPException(
            status_code=400, 
            detail=f"Agent {req.agentId} is already assigned to this project"
        )
    
    # If assigning as lead, demote existing lead to member
    if req.role == "lead":
        await session.execute(
            update(ProjectAgentModel)
            .where(ProjectAgentModel.project_id == project_id, ProjectAgentModel.role == "lead")
            .values(role="member")
        )
    
    # Create assignment
    agent = ProjectAgentModel(
        project_id=project_id,
        agent_id=req.agentId,
        role=req.role,
        assigned_at=now,
        assigned_by="user",
    )
    session.add(agent)
    await session.commit()
    
    await _publish_event("AGENT_ASSIGNED", {
        "projectId": project_id,
        "agentId": req.agentId,
        "role": req.role
    })
    
    return {
        "status": "assigned",
        "project_id": project_id,
        "agent_id": req.agentId,
        "role": req.role,
        "assigned_at": now
    }


@router.get("/{project_id}/agents")
async def list_project_agents(project_id: str, session: AsyncSession = Depends(get_async_session)):
    """List all agents assigned to a project."""
    logger.debug(f"Listing project agents: project_id={project_id}")
    await get_project_or_404(session, project_id)
    
    result = await session.execute(
        select(ProjectAgentModel)
        .where(ProjectAgentModel.project_id == project_id)
        .order_by(ProjectAgentModel.role, ProjectAgentModel.assigned_at)
    )
    agents = result.scalars().all()
    
    return [
        {
            "project_id": a.project_id,
            "agent_id": a.agent_id,
            "role": a.role,
            "assigned_at": a.assigned_at,
            "assigned_by": a.assigned_by,
        }
        for a in agents
    ]


@router.put("/{project_id}/agents/{agent_id}")
async def update_agent_role(project_id: str, agent_id: str, req: UpdateAgentRoleRequest, session: AsyncSession = Depends(get_async_session)):
    """Update an agent's role on a project."""
    logger.debug(f"Updating agent role: project_id={project_id}, agent_id={agent_id}, new_role={req.role}")
    await get_project_or_404(session, project_id)
    
    # Verify assignment exists
    result = await session.execute(
        select(ProjectAgentModel)
        .where(ProjectAgentModel.project_id == project_id, ProjectAgentModel.agent_id == agent_id)
    )
    agent = result.scalar_one_or_none()
    if not agent:
        raise HTTPException(
            status_code=404,
            detail=f"Agent {agent_id} is not assigned to this project"
        )
    
    # If promoting to lead, demote existing lead
    if req.role == "lead":
        await session.execute(
            update(ProjectAgentModel)
            .where(ProjectAgentModel.project_id == project_id, ProjectAgentModel.role == "lead", ProjectAgentModel.agent_id != agent_id)
            .values(role="member")
        )
    
    # Update role
    agent.role = req.role
    await session.commit()
    
    await _publish_event("AGENT_ROLE_UPDATED", {
        "projectId": project_id,
        "agentId": agent_id,
        "role": req.role
    })
    
    return {"status": "updated", "role": req.role}


@router.delete("/{project_id}/agents/{agent_id}")
async def remove_agent_from_project(project_id: str, agent_id: str, session: AsyncSession = Depends(get_async_session)):
    """Remove an agent from a project."""
    logger.debug(f"Removing agent from project: project_id={project_id}, agent_id={agent_id}")
    await get_project_or_404(session, project_id)
    
    result = await session.execute(
        delete(ProjectAgentModel)
        .where(ProjectAgentModel.project_id == project_id, ProjectAgentModel.agent_id == agent_id)
    )
    await session.commit()
    
    if result.rowcount == 0:
        raise HTTPException(
            status_code=404,
            detail=f"Agent {agent_id} is not assigned to this project"
        )
    
    await _publish_event("AGENT_REMOVED", {
        "projectId": project_id,
        "agentId": agent_id
    })
    
    return {"status": "removed"}
