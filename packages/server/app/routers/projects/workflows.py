"""Workflow management endpoints."""
import json
from typing import Optional
from fastapi import APIRouter, HTTPException, Depends
from sqlalchemy import select, update, delete
from sqlalchemy.ext.asyncio import AsyncSession

from app.database import get_async_session
from app.models import Project, ProjectWorkflow
from app.utils import now_ms, gen_id
from app.logging_config import get_logger
from ._common import (
    get_project_or_404,
    _serialize_workflow,
    _publish_event,
    _validate_pipeline_exists,
    CreateWorkflowRequest,
    UpdateWorkflowRequest,
)

logger = get_logger(__name__)
router = APIRouter()


@router.post("/{project_id}/workflows")
async def create_workflow(project_id: str, req: CreateWorkflowRequest, session: AsyncSession = Depends(get_async_session)):
    """Add a workflow (pipeline mapping) to a project."""
    logger.debug(f"Creating workflow: project_id={project_id}, name={req.name}, pipeline={req.pipelineId}")
    await get_project_or_404(session, project_id)
    
    # If setting as default, unset existing default
    if req.isDefault:
        await session.execute(
            update(ProjectWorkflow)
            .where(ProjectWorkflow.project_id == project_id)
            .values(is_default=False)
        )
    
    workflow = ProjectWorkflow(
        id=gen_id("wf_"),
        project_id=project_id,
        name=req.name,
        pipeline_id=req.pipelineId,
        is_default=req.isDefault,
        task_filter=json.dumps(req.taskFilter),
        trigger=req.trigger,
    )
    session.add(workflow)
    await session.commit()
    
    return {"id": workflow.id, "name": req.name, "pipeline_id": req.pipelineId}


@router.get("/{project_id}/workflows")
async def list_workflows(project_id: str, session: AsyncSession = Depends(get_async_session)):
    """List workflows for a project."""
    logger.debug(f"Listing workflows: project_id={project_id}")
    await get_project_or_404(session, project_id)
    
    result = await session.execute(
        select(ProjectWorkflow)
        .where(ProjectWorkflow.project_id == project_id)
    )
    workflows = result.scalars().all()
    return [_serialize_workflow(w) for w in workflows]


@router.put("/{project_id}/workflows/{workflow_id}")
async def update_workflow(project_id: str, workflow_id: str, req: UpdateWorkflowRequest, session: AsyncSession = Depends(get_async_session)):
    """Update a workflow."""
    logger.debug(f"Updating workflow: project_id={project_id}, workflow_id={workflow_id}")
    await get_project_or_404(session, project_id)
    
    result = await session.execute(
        select(ProjectWorkflow)
        .where(ProjectWorkflow.id == workflow_id, ProjectWorkflow.project_id == project_id)
    )
    workflow = result.scalar_one_or_none()
    if not workflow:
        raise HTTPException(status_code=404, detail="Workflow not found")
    
    if req.name is not None:
        workflow.name = req.name
    if req.pipelineId is not None:
        workflow.pipeline_id = req.pipelineId
    if req.taskFilter is not None:
        workflow.task_filter = json.dumps(req.taskFilter)
    if req.trigger is not None:
        workflow.trigger = req.trigger
    
    if req.isDefault is not None:
        if req.isDefault:
            # Unset other defaults
            await session.execute(
                update(ProjectWorkflow)
                .where(ProjectWorkflow.project_id == project_id)
                .values(is_default=False)
            )
            workflow.is_default = True
        else:
            workflow.is_default = False
    
    await session.commit()
    
    return {"status": "updated"}


@router.delete("/{project_id}/workflows/{workflow_id}")
async def delete_workflow(project_id: str, workflow_id: str, session: AsyncSession = Depends(get_async_session)):
    """Delete a workflow."""
    logger.debug(f"Deleting workflow: project_id={project_id}, workflow_id={workflow_id}")
    result = await session.execute(
        delete(ProjectWorkflow)
        .where(ProjectWorkflow.id == workflow_id, ProjectWorkflow.project_id == project_id)
    )
    await session.commit()
    
    return {"status": "deleted"}
