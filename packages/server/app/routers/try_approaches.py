"""Try Approaches — Internal API for speculative multi-path execution.

An agent (the planner) calls this endpoint to spawn multiple executor instances
in parallel, each testing a COMPETING approach to the same task. Unlike swarm
execution (cooperating tasks in a dependency DAG), this runs ALTERNATIVE
strategies and the planner picks the best one based on evaluation.

Flow:
1. Planner agent calls try_approaches tool → POST /v1/internal/try-approaches
2. This endpoint creates N spawn-executor runs (one per approach), each on a
   unique git branch (try/{taskId}-{approachKey})
3. The planner polls each run independently
4. When all complete, the planner evaluates results and picks a winner
5. The winning branch can be merged into the task branch

Architecture: this endpoint is a thin orchestration layer over spawn-executor.
Each approach becomes a separate spawn_executor call with:
  - A unique branch suffix for git isolation
  - The approach-specific execution prompt
  - The speculative deviation rules (stricter than normal — stay in scope)
"""

import json
import uuid
from typing import Optional

from fastapi import APIRouter, HTTPException, Depends
from pydantic import BaseModel, Field
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.database import get_async_session
from app.models import Run, Task, Project
from app import dependencies
from app.utils import now_ms, gen_id
from app.logging_config import get_logger
from app.routers.projects.execution import (
    _get_task_branch,
    _set_task_branch,
    _task_branch_name,
)

logger = get_logger(__name__)

router = APIRouter()

VAULTS_DIR = __import__("os").getenv("VAULTS_DIR", "/data/vaults")


# ══════════════════════════════════════════════════════════════════════════
# REQUEST / RESPONSE MODELS
# ══════════════════════════════════════════════════════════════════════════


class ApproachDefModel(BaseModel):
    key: str = Field(
        ...,
        description="Unique key for this approach within the speculation",
        pattern=r"^[a-zA-Z0-9_-]+$",
    )
    title: str = Field(..., description="Human-readable approach title")
    execution_prompt: str = Field(
        ..., description="The execution prompt for this approach"
    )
    model: Optional[str] = Field(None, description="Model override for this executor")
    timeout_seconds: int = Field(
        default=300, ge=30, le=600, description="Timeout for this executor"
    )


class TryApproachesRequest(BaseModel):
    agent_id: str = Field(
        ..., description="Agent ID of the planner (executors inherit identity)"
    )
    project_id: str = Field(..., description="Project ID for workspace provisioning")
    task_id: str = Field(..., description="Task ID being worked on")
    approaches: list[ApproachDefModel] = Field(
        ...,
        min_length=2,
        max_length=5,
        description="Competing approaches to try in parallel",
    )
    evaluation_criteria: str = Field(
        ..., description="How to evaluate and compare approaches"
    )
    deviation_rules: str = Field(
        default="", description="Deviation rules injected into every executor"
    )
    global_timeout_seconds: int = Field(
        default=900, ge=60, le=1800, description="Global timeout for all approaches"
    )


# ══════════════════════════════════════════════════════════════════════════
# MEMORY INJECTION (reuse from spawn_executor)
# ══════════════════════════════════════════════════════════════════════════


def _build_lessons_section_for_approach(
    agent_id: str,
    task_title: str,
    task_tags: list[str],
    approach_title: str,
) -> str:
    """Search vault for lessons relevant to this specific approach.

    Reuses the same vault-search logic as spawn_executor but also
    includes the approach title in the search queries for relevance.
    """
    from app.routers.spawn_executor import _build_lessons_section

    # The existing _build_lessons_section searches by title + tags.
    # We pass a composite title that includes the approach name for better recall.
    composite_title = f"{task_title} ({approach_title})"
    return _build_lessons_section(agent_id, composite_title, task_tags, "")


# ══════════════════════════════════════════════════════════════════════════
# ENDPOINT
# ══════════════════════════════════════════════════════════════════════════


@router.post("/try-approaches")
async def try_approaches(
    req: TryApproachesRequest,
    session: AsyncSession = Depends(get_async_session),
):
    """Spawn parallel competing executor instances for speculative execution.

    Creates one executor run per approach, each on an isolated git branch.
    Returns immediately with the speculation_id and per-approach run IDs.
    The planner polls each run for completion, then evaluates results.
    """
    logger.info(
        f"Try approaches: agent={req.agent_id}, project={req.project_id}, "
        f"task={req.task_id}, approaches={len(req.approaches)}"
    )
    now = now_ms()

    # Validate unique approach keys
    keys = [a.key for a in req.approaches]
    if len(keys) != len(set(keys)):
        raise HTTPException(status_code=400, detail="Duplicate approach keys detected")

    # Look up task for branch naming and memory injection
    task_title = ""
    task_tags: list[str] = []
    task = None
    try:
        task_result = await session.execute(
            select(Task).where(
                Task.id == req.task_id, Task.project_id == req.project_id
            )
        )
        task = task_result.scalar_one_or_none()
        if task:
            task_title = task.title or ""
            task_tags = json.loads(task.tags) if task.tags else []
    except Exception as e:
        logger.warning(f"Failed to look up task for try-approaches: {e}")

    # Resolve base task branch (ensure it exists)
    base_branch: str | None = None
    if task:
        base_branch = _get_task_branch(task)
        if not base_branch:
            base_branch = _task_branch_name(task.id, task.title)
            _set_task_branch(task, base_branch)
            await session.commit()

    # Look up project workspace_type
    project_workspace_type: str | None = None
    try:
        project_result = await session.execute(
            select(Project).where(Project.id == req.project_id)
        )
        project = project_result.scalar_one_or_none()
        if project:
            project_workspace_type = project.workspace_type
    except Exception:
        pass

    # Generate speculation ID
    speculation_id = f"spec_{uuid.uuid4().hex[:12]}"

    # Create one run per approach
    approach_run_ids: dict[str, str] = {}
    approach_branches: dict[str, str] = {}

    for approach in req.approaches:
        # Build per-approach branch: try/{taskId}-{approachKey}
        approach_branch = f"try/{req.task_id}-{approach.key}"
        if base_branch:
            # Prefix with the base branch for context
            approach_branch = f"try/{base_branch.replace('feat/', '')}-{approach.key}"

        approach_branches[approach.key] = approach_branch

        # Pre-flight memory injection (approach-specific)
        lessons_section = _build_lessons_section_for_approach(
            req.agent_id, task_title, task_tags, approach.title
        )

        # Build enriched prompt
        enriched_prompt = approach.execution_prompt
        if lessons_section:
            enriched_prompt += f"\n\n{lessons_section}"

        # Store metadata
        human_context = json.dumps(
            {
                "spawn_executor": True,
                "try_approaches": True,
                "speculation_id": speculation_id,
                "approach_key": approach.key,
                "approach_title": approach.title,
                "planner_agent_id": req.agent_id,
                "project_id": req.project_id,
                "task_id": req.task_id,
                "deviation_rules": req.deviation_rules,
                "timeout_seconds": approach.timeout_seconds,
                "memory_injection": bool(lessons_section),
                "evaluation_criteria": req.evaluation_criteria,
            }
        )

        run_id = gen_id("run_")
        approach_run_ids[approach.key] = run_id

        run = Run(
            id=run_id,
            pipeline_id="execute",
            project_id=req.project_id,
            task_description=enriched_prompt,
            status="pending",
            outputs="{}",
            human_context=human_context,
            model_override=approach.model,
            task_branch=approach_branch,
            workspace_type=project_workspace_type,
            created_at=now,
            updated_at=now,
        )
        session.add(run)

    await session.commit()

    # Dispatch all runs to engine via Redis
    dispatched = 0
    if dependencies.redis_client:
        for approach in req.approaches:
            run_id = approach_run_ids[approach.key]
            try:
                await dependencies.redis_client.xadd(
                    "djinnbot:events:new_runs",
                    {"run_id": run_id, "pipeline_id": "execute"},
                )
                dispatched += 1
            except Exception as e:
                logger.warning(
                    f"Failed to dispatch approach {approach.key} to Redis: {e}"
                )
    else:
        logger.warning(
            "Redis not available — approach runs created in DB but not dispatched"
        )

    logger.info(
        f"Speculation {speculation_id}: dispatched {dispatched}/{len(req.approaches)} "
        f"approach runs for task {req.task_id}"
    )

    return {
        "speculation_id": speculation_id,
        "approach_count": len(req.approaches),
        "approach_run_ids": approach_run_ids,
        "approach_branches": approach_branches,
        "base_branch": base_branch,
        "dispatched": dispatched,
    }
