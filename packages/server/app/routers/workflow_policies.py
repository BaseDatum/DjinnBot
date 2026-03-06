"""Workflow policy API — per-project stage routing rules.

Manages workflow policies that define which SDLC stages are
required/optional/skip for each task work type. Also provides
the task workflow resolution endpoint used by agents.
"""

import json
from typing import Optional

from fastapi import APIRouter, HTTPException, Depends
from pydantic import BaseModel
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.database import get_async_session
from app.models import Task, WorkflowPolicy
from app.models.project import Project
from app.utils import now_ms, gen_id
from app.logging_config import get_logger

logger = get_logger(__name__)
router = APIRouter()


# ── Pydantic models ────────────────────────────────────────────────────────


class StageRuleItem(BaseModel):
    stage: str
    disposition: str  # required | optional | skip
    agent_role: Optional[str] = None


class UpdateWorkflowPolicyRequest(BaseModel):
    """Update or create workflow policy for a project."""

    stageRules: dict  # { work_type: [{ stage, disposition, agent_role? }] }


# ── Stage-to-status mapping ───────────────────────────────────────────────
# Maps SDLC stage names to kanban statuses for transition validation.
# This is the bridge between the conceptual "stages" in workflow policies
# and the actual kanban column statuses in the project.

DEFAULT_STAGE_TO_STATUS: dict[str, list[str]] = {
    "spec": ["backlog", "planning"],
    "design": ["planning", "planned"],
    "ux": ["ux"],
    "implement": ["ready", "in_progress"],
    "review": ["review"],
    "test": ["test"],
    "deploy": ["done"],  # deploy leads to done
}

# Reverse map: status → stage
DEFAULT_STATUS_TO_STAGE: dict[str, str] = {}
for _stage, _statuses in DEFAULT_STAGE_TO_STATUS.items():
    for _status in _statuses:
        DEFAULT_STATUS_TO_STAGE[_status] = _stage


def get_stage_for_status(status: str) -> Optional[str]:
    """Map a kanban status to its SDLC stage."""
    return DEFAULT_STATUS_TO_STAGE.get(status)


def get_statuses_for_stage(stage: str) -> list[str]:
    """Map an SDLC stage to its kanban statuses."""
    return DEFAULT_STAGE_TO_STATUS.get(stage, [])


# ── Workflow resolution helpers ────────────────────────────────────────────


def resolve_task_workflow(
    work_type: Optional[str],
    completed_stages: list[str],
    current_status: str,
    stage_rules: dict,
) -> dict:
    """Resolve the workflow for a task given its type and current state.

    Returns:
        {
            work_type: str,
            required_stages: [str],
            optional_stages: [str],
            skipped_stages: [str],
            completed_stages: [str],
            current_stage: str | null,
            next_required_stage: str | null,
            next_valid_stages: [str],  # stages agent can transition to
        }
    """
    effective_type = work_type or "custom"
    rules = stage_rules.get(effective_type, stage_rules.get("custom", []))

    required = []
    optional = []
    skipped = []
    all_stages_ordered = []

    for rule in rules:
        stage = rule.get("stage", "")
        disp = rule.get("disposition", "optional")
        all_stages_ordered.append(stage)
        if disp == "required":
            required.append(stage)
        elif disp == "optional":
            optional.append(stage)
        elif disp == "skip":
            skipped.append(stage)

    current_stage = get_stage_for_status(current_status)

    # Find next required stage that hasn't been completed
    next_required = None
    for stage in all_stages_ordered:
        if stage in skipped:
            continue
        if stage in completed_stages:
            continue
        if stage == current_stage:
            continue
        rule = next((r for r in rules if r.get("stage") == stage), None)
        if rule and rule.get("disposition") == "required":
            next_required = stage
            break

    # Valid next stages: everything that isn't skipped and isn't already completed,
    # in order. Include the next required stage and any optional stages before it.
    next_valid = []
    past_current = current_stage is None  # If no current stage, everything is ahead
    for stage in all_stages_ordered:
        if stage == current_stage:
            past_current = True
            continue
        if not past_current:
            continue
        if stage in skipped:
            continue
        if stage in completed_stages:
            continue
        next_valid.append(stage)

    # Always allow "done" as a terminal transition if all required stages done
    remaining_required = [
        s for s in required if s not in completed_stages and s != current_stage
    ]
    if not remaining_required:
        if "done" not in next_valid:
            next_valid.append("done")

    return {
        "work_type": effective_type,
        "required_stages": required,
        "optional_stages": optional,
        "skipped_stages": skipped,
        "completed_stages": completed_stages,
        "current_stage": current_stage,
        "next_required_stage": next_required,
        "next_valid_stages": next_valid,
    }


# ── API Endpoints ──────────────────────────────────────────────────────────


@router.get("/v1/projects/{project_id}/workflow-policy")
async def get_workflow_policy(
    project_id: str,
    session: AsyncSession = Depends(get_async_session),
):
    """Get the workflow policy for a project."""
    result = await session.execute(
        select(WorkflowPolicy).where(WorkflowPolicy.project_id == project_id)
    )
    policy = result.scalar_one_or_none()
    if not policy:
        return {"project_id": project_id, "stage_rules": {}, "exists": False}

    return {
        "id": policy.id,
        "project_id": policy.project_id,
        "stage_rules": policy.stage_rules,
        "created_at": policy.created_at,
        "updated_at": policy.updated_at,
        "exists": True,
    }


@router.put("/v1/projects/{project_id}/workflow-policy")
async def upsert_workflow_policy(
    project_id: str,
    req: UpdateWorkflowPolicyRequest,
    session: AsyncSession = Depends(get_async_session),
):
    """Create or update the workflow policy for a project."""
    # Verify project exists
    proj_result = await session.execute(select(Project).where(Project.id == project_id))
    if not proj_result.scalar_one_or_none():
        raise HTTPException(status_code=404, detail=f"Project {project_id} not found")

    now = now_ms()

    result = await session.execute(
        select(WorkflowPolicy).where(WorkflowPolicy.project_id == project_id)
    )
    policy = result.scalar_one_or_none()

    if policy:
        policy.stage_rules = req.stageRules
        policy.updated_at = now
    else:
        policy = WorkflowPolicy(
            id=gen_id("wfp_"),
            project_id=project_id,
            stage_rules=req.stageRules,
            created_at=now,
            updated_at=now,
        )
        session.add(policy)

    await session.commit()

    return {
        "id": policy.id,
        "project_id": project_id,
        "stage_rules": policy.stage_rules,
        "updated_at": policy.updated_at,
    }


@router.get("/v1/projects/{project_id}/tasks/{task_id}/workflow")
async def get_task_workflow(
    project_id: str,
    task_id: str,
    session: AsyncSession = Depends(get_async_session),
):
    """Get the resolved workflow for a specific task.

    Returns which stages are required/optional/skip based on the task's
    work_type and the project's workflow policy. Also returns the current
    stage, completed stages, and the next valid transition targets.

    This is the primary endpoint agents use to determine where a task
    should go next.
    """
    # Load task
    task_result = await session.execute(
        select(Task).where(Task.id == task_id, Task.project_id == project_id)
    )
    task = task_result.scalar_one_or_none()
    if not task:
        raise HTTPException(status_code=404, detail=f"Task {task_id} not found")

    # Load workflow policy
    policy_result = await session.execute(
        select(WorkflowPolicy).where(WorkflowPolicy.project_id == project_id)
    )
    policy = policy_result.scalar_one_or_none()

    if not policy:
        # No policy — return unresolved info
        return {
            "task_id": task_id,
            "work_type": task.work_type,
            "has_policy": False,
            "current_stage": get_stage_for_status(task.status),
            "current_status": task.status,
            "completed_stages": json.loads(task.completed_stages)
            if task.completed_stages
            else [],
            "message": "No workflow policy configured for this project. All transitions are allowed.",
        }

    completed = json.loads(task.completed_stages) if task.completed_stages else []

    workflow = resolve_task_workflow(
        work_type=task.work_type,
        completed_stages=completed,
        current_status=task.status,
        stage_rules=policy.stage_rules,
    )

    return {
        "task_id": task_id,
        "has_policy": True,
        "current_status": task.status,
        **workflow,
    }
