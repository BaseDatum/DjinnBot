"""Run history endpoint for agent introspection.

Allows agents to query their own (and their project's) execution history.
This enables learning from past attempts — agents can see what was tried,
what succeeded, what failed, and why.
"""

import json
from typing import Optional

from fastapi import APIRouter, Depends, Query
from sqlalchemy import select, and_, or_
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import selectinload

from app.database import get_async_session
from app.models.run import Run, Step, Output
from app.models.project import TaskRun
from app.logging_config import get_logger

logger = get_logger(__name__)

router = APIRouter()


@router.get("/run-history")
async def get_run_history(
    project_id: Optional[str] = Query(None, description="Filter by project ID"),
    task_id: Optional[str] = Query(
        None, description="Filter by task ID (via task_runs table)"
    ),
    agent_id: Optional[str] = Query(
        None, description="Filter by agent ID (matches step agent_id)"
    ),
    status: Optional[str] = Query(
        None,
        description="Filter by run status: completed, failed, cancelled, running, or 'terminal' for completed+failed+cancelled",
    ),
    since: Optional[int] = Query(
        None, description="Only runs created after this epoch-ms timestamp"
    ),
    limit: int = Query(10, ge=1, le=50, description="Max number of runs to return"),
    include_steps: bool = Query(True, description="Include step details in response"),
    session: AsyncSession = Depends(get_async_session),
):
    """Query execution history with rich filtering.

    Designed for agent self-introspection: "What happened last time I worked
    on this task?" / "What runs completed in my project since my last pulse?"

    Returns runs in reverse chronological order with step-level detail,
    outputs, errors, and timing information.
    """
    logger.debug(
        f"get_run_history: project_id={project_id}, task_id={task_id}, "
        f"agent_id={agent_id}, status={status}, since={since}, limit={limit}"
    )

    # If filtering by task_id, first resolve which run_ids are linked to that task
    task_run_ids: set[str] | None = None
    if task_id:
        tr_query = select(TaskRun.run_id).where(TaskRun.task_id == task_id)
        tr_result = await session.execute(tr_query)
        task_run_ids = set(tr_result.scalars().all())
        if not task_run_ids:
            # No runs found for this task — return empty early
            return {"runs": [], "total": 0}

    # If filtering by agent_id, resolve which run_ids have steps by that agent
    agent_run_ids: set[str] | None = None
    if agent_id:
        step_query = select(Step.run_id).where(Step.agent_id == agent_id).distinct()
        step_result = await session.execute(step_query)
        agent_run_ids = set(step_result.scalars().all())

        # Also check human_context JSON for spawn_executor runs where agent_id
        # is stored as planner_agent_id (these runs have pipeline_id='execute')
        hc_query = select(Run.id).where(
            Run.pipeline_id == "execute",
            Run.human_context.isnot(None),
            Run.human_context.contains(f'"planner_agent_id": "{agent_id}"'),
        )
        hc_result = await session.execute(hc_query)
        planner_run_ids = set(hc_result.scalars().all())

        agent_run_ids = agent_run_ids | planner_run_ids

        if not agent_run_ids:
            return {"runs": [], "total": 0}

    # Build the main query
    query = select(Run)
    if include_steps:
        query = query.options(selectinload(Run.steps))

    conditions = []

    if project_id:
        conditions.append(Run.project_id == project_id)

    if task_run_ids is not None:
        conditions.append(Run.id.in_(task_run_ids))

    if agent_run_ids is not None:
        conditions.append(Run.id.in_(agent_run_ids))

    if status:
        if status == "terminal":
            conditions.append(Run.status.in_(["completed", "failed", "cancelled"]))
        else:
            conditions.append(Run.status == status)

    if since:
        conditions.append(Run.created_at >= since)

    if conditions:
        query = query.where(and_(*conditions))

    query = query.order_by(Run.created_at.desc()).limit(limit)

    result = await session.execute(query)
    runs = result.scalars().unique().all()

    # Fetch outputs for all runs in one batch
    run_ids = [r.id for r in runs]
    outputs_map: dict[str, dict[str, str]] = {}
    if run_ids:
        out_result = await session.execute(
            select(Output).where(Output.run_id.in_(run_ids))
        )
        for o in out_result.scalars().all():
            outputs_map.setdefault(o.run_id, {})[o.key] = o.value

    # If we have task_id filter, also build a reverse map of run_id → task_id
    # For non-task-filtered queries, try to resolve task_id from task_runs
    task_id_map: dict[str, str] = {}
    if run_ids:
        tr_result = await session.execute(
            select(TaskRun.run_id, TaskRun.task_id).where(TaskRun.run_id.in_(run_ids))
        )
        for row in tr_result.all():
            task_id_map[row.run_id] = row.task_id

    # Also try to extract task_id from human_context for spawn_executor runs
    for r in runs:
        if r.id not in task_id_map and r.human_context:
            try:
                hc = json.loads(r.human_context)
                if hc.get("spawn_executor") and hc.get("task_id"):
                    task_id_map[r.id] = hc["task_id"]
            except (json.JSONDecodeError, TypeError):
                pass

    # Format response
    formatted_runs = []
    for r in runs:
        run_outputs = outputs_map.get(r.id, {})

        # Also parse the run-level outputs JSON (legacy storage)
        try:
            run_level_outputs = json.loads(r.outputs) if r.outputs else {}
        except (json.JSONDecodeError, TypeError):
            run_level_outputs = {}

        # Merge: Output table takes precedence, fall back to run.outputs JSON
        merged_outputs = {**run_level_outputs, **run_outputs}

        # Extract useful metadata from human_context
        hc_meta: dict = {}
        if r.human_context:
            try:
                hc = json.loads(r.human_context)
                if isinstance(hc, dict):
                    hc_meta = {
                        k: hc[k]
                        for k in [
                            "spawn_executor",
                            "planner_agent_id",
                            "task_id",
                            "memory_injection",
                            "timeout_seconds",
                        ]
                        if k in hc
                    }
            except (json.JSONDecodeError, TypeError):
                pass

        # Compute duration
        duration_ms = None
        if r.completed_at and r.created_at:
            duration_ms = r.completed_at - r.created_at

        entry: dict = {
            "run_id": r.id,
            "pipeline_id": r.pipeline_id,
            "project_id": r.project_id,
            "task_id": task_id_map.get(r.id),
            "status": r.status,
            "created_at": r.created_at,
            "completed_at": r.completed_at,
            "duration_ms": duration_ms,
            "task_branch": getattr(r, "task_branch", None),
            "model_override": getattr(r, "model_override", None),
            "outputs": merged_outputs,
            "metadata": hc_meta if hc_meta else None,
        }

        if include_steps and r.steps:
            sorted_steps = sorted(r.steps, key=lambda s: s.started_at or 0)
            entry["steps"] = [
                {
                    "step_id": s.step_id,
                    "agent_id": s.agent_id,
                    "status": s.status,
                    "error": s.error,
                    "outputs": _safe_json(s.outputs),
                    "started_at": s.started_at,
                    "completed_at": s.completed_at,
                    "retry_count": s.retry_count,
                    "model_used": getattr(s, "model_used", None),
                }
                for s in sorted_steps
            ]
        else:
            entry["steps"] = []

        formatted_runs.append(entry)

    return {"runs": formatted_runs, "total": len(formatted_runs)}


def _safe_json(raw: str | None) -> dict:
    """Parse JSON string, returning empty dict on failure."""
    if not raw:
        return {}
    try:
        return json.loads(raw)
    except (json.JSONDecodeError, TypeError):
        return {}
