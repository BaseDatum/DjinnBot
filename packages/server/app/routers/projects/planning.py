"""Project planning and task import endpoints."""

import json
import uuid
from difflib import SequenceMatcher
from typing import Optional
from fastapi import APIRouter, HTTPException, Depends
from sqlalchemy import select, func
from sqlalchemy.ext.asyncio import AsyncSession

from app.database import get_async_session
from app.models import Project, Task, KanbanColumn, DependencyEdge, Run
from app import dependencies
from app.utils import now_ms, gen_id
from app.logging_config import get_logger
from ._common import (
    get_project_or_404,
    _serialize_task,
    _publish_event,
    PlanProjectRequest,
    BulkImportTasksRequest,
    _validate_pipeline_exists,
)

logger = get_logger(__name__)
router = APIRouter()


def _fuzzy_resolve_dep(
    dep_title: str, known_titles: dict[str, str], threshold: float = 0.6
) -> Optional[str]:
    """Try to fuzzy-match a dependency title against known task titles.

    Returns the matched title if found above threshold, else None.
    """
    best_match = None
    best_score = 0.0
    dep_lower = dep_title.lower().strip()
    for title in known_titles:
        score = SequenceMatcher(None, dep_lower, title.lower().strip()).ratio()
        if score > best_score:
            best_score = score
            best_match = title
    if best_score >= threshold and best_match:
        return best_match
    return None


# ══════════════════════════════════════════════════════════════════════════
# AI PLANNING PIPELINE
# ══════════════════════════════════════════════════════════════════════════


@router.post("/{project_id}/reflow-planning")
async def reflow_planning(
    project_id: str,
    session: AsyncSession = Depends(get_async_session),
):
    """Reflow task statuses after planning — moves blocked tasks to backlog.

    Can be called manually or is triggered automatically when a planning
    pipeline completes.
    """
    await get_project_or_404(session, project_id)
    result = await reflow_task_statuses_after_planning(project_id, session)
    return result


@router.post("/{project_id}/plan")
async def plan_project(
    project_id: str,
    req: PlanProjectRequest,
    session: AsyncSession = Depends(get_async_session),
):
    """Start an AI planning pipeline to decompose the project into tasks.

    The planning pipeline will:
    1. Analyze the project description
    2. Decompose into tasks with dependencies
    3. Auto-import results into the project's kanban board when complete

    The run's output (validated_tasks_json or task_breakdown_json) will be
    automatically imported when the run completes.
    """
    logger.debug(
        f"Starting AI planning: project_id={project_id}, pipeline={req.pipelineId}"
    )
    now = now_ms()
    project = await get_project_or_404(session, project_id)

    # Validate pipeline exists
    if not _validate_pipeline_exists(req.pipelineId):
        raise HTTPException(
            status_code=404, detail=f"Planning pipeline '{req.pipelineId}' not found"
        )

    # Create a planning run
    run_id = str(uuid.uuid4())
    task_desc = f"Plan project: {project.name}\n\n{project.description or ''}"
    if req.context:
        task_desc += f"\n\nAdditional context:\n{req.context}"

    # Store project metadata in human_context so the planning pipeline can use template variables
    human_context = json.dumps(
        {
            "project_id": project_id,
            "project_name": project.name,
            "project_description": project.description or "",
            "planning_run": True,  # Flag to identify this as a planning run
            "pipeline_id": req.pipelineId,  # Used by completion handler to choose import strategy
            "additional_context": req.context,
        }
    )

    from app.models import Run

    run = Run(
        id=run_id,
        pipeline_id=req.pipelineId,
        task_description=task_desc,
        status="pending",
        outputs="{}",
        human_context=human_context,
        created_at=now,
        updated_at=now,
    )
    session.add(run)
    await session.commit()

    # Publish to Redis for engine to pick up
    if dependencies.redis_client:
        try:
            logger.debug(
                f"Publishing planning run to Redis: run_id={run_id}, pipeline_id={req.pipelineId}"
            )
            await dependencies.redis_client.xadd(
                "djinnbot:events:new_runs",
                {"run_id": run_id, "pipeline_id": req.pipelineId},
            )
        except Exception as e:
            logger.warning(f"Failed to publish planning run to Redis: {e}")

        await _publish_event(
            "PROJECT_PLANNING_STARTED",
            {
                "projectId": project_id,
                "runId": run_id,
                "pipelineId": req.pipelineId,
            },
        )

    return {
        "status": "planning_started",
        "project_id": project_id,
        "run_id": run_id,
        "pipeline_id": req.pipelineId,
    }


# ══════════════════════════════════════════════════════════════════════════
# TIMELINE / GANTT
# ══════════════════════════════════════════════════════════════════════════


@router.get("/{project_id}/timeline")
async def get_project_timeline(
    project_id: str,
    hours_per_day: float = 8.0,
    session: AsyncSession = Depends(get_async_session),
):
    """Compute a Gantt-style timeline for all tasks in the project.

    Uses dependency-aware forward scheduling:
    - Tasks with no dependencies start at project creation time
    - Tasks with dependencies start after all deps complete
    - Duration is based on estimated_hours / hours_per_day
    - Returns scheduled start/end for each task, plus overall project timeline
    """
    logger.debug(
        f"Computing timeline: project_id={project_id}, hours_per_day={hours_per_day}"
    )
    now = now_ms()
    project = await get_project_or_404(session, project_id)

    # Get all tasks
    result = await session.execute(
        select(Task)
        .where(Task.project_id == project_id)
        .order_by(Task.priority, Task.column_position)
    )
    tasks = result.scalars().all()

    if not tasks:
        return {
            "tasks": [],
            "project_start": project.created_at,
            "project_end": project.created_at,
            "total_hours": 0,
            "critical_path": [],
        }

    task_map = {t.id: t for t in tasks}

    # Get all dependency edges
    edge_result = await session.execute(
        select(DependencyEdge.from_task_id, DependencyEdge.to_task_id).where(
            DependencyEdge.project_id == project_id
        )
    )
    edges = edge_result.all()

    # Build adjacency: task_deps[task_id] = list of task IDs it depends on
    task_deps = {t.id: [] for t in tasks}
    task_dependents = {t.id: [] for t in tasks}
    for from_id, to_id in edges:
        if to_id in task_deps:
            task_deps[to_id].append(from_id)
        if from_id in task_dependents:
            task_dependents[from_id].append(to_id)

    project_start = project.created_at
    ms_per_day = 86400000  # 24h in ms

    # Forward scheduling via topological order
    scheduled = {}

    # Kahn's algorithm for topological sort
    in_degree = {t.id: len(task_deps[t.id]) for t in tasks}
    queue = [tid for tid, deg in in_degree.items() if deg == 0]
    topo_order = []

    while queue:
        # Sort by priority for consistent ordering
        queue.sort(key=lambda tid: (task_map[tid].priority or "P2", tid))
        tid = queue.pop(0)
        topo_order.append(tid)
        for dep_tid in task_dependents.get(tid, []):
            in_degree[dep_tid] -= 1
            if in_degree[dep_tid] == 0:
                queue.append(dep_tid)

    # Handle tasks not in topo_order (cycles — shouldn't happen but be safe)
    for t in tasks:
        if t.id not in topo_order:
            topo_order.append(t.id)

    for tid in topo_order:
        task = task_map[tid]
        hours = task.estimated_hours or 4  # default 4h if not set
        duration_days = hours / hours_per_day
        duration_ms = int(duration_days * ms_per_day)

        # If task is already done, use actual dates
        if task.status == "done" and task.completed_at:
            actual_start = task.created_at or project_start
            actual_end = task.completed_at
            scheduled[tid] = {
                "start": actual_start,
                "end": actual_end,
                "duration_days": round((actual_end - actual_start) / ms_per_day, 1),
                "actual": True,
            }
            continue

        # Compute earliest start: max(end of all deps)
        if task_deps[tid]:
            dep_ends = [
                scheduled[dep_id]["end"]
                for dep_id in task_deps[tid]
                if dep_id in scheduled
            ]
            earliest_start = max(dep_ends) if dep_ends else project_start
        else:
            earliest_start = project_start

        scheduled[tid] = {
            "start": earliest_start,
            "end": earliest_start + duration_ms,
            "duration_days": round(duration_days, 1),
            "actual": False,
        }

    # Build critical path (longest path through the graph)
    critical_path = []
    if scheduled:
        project_end = max(s["end"] for s in scheduled.values())

        # Trace back from the task with the latest end time
        latest_task = max(scheduled.keys(), key=lambda tid: scheduled[tid]["end"])
        path = [latest_task]
        current = latest_task
        while task_deps.get(current):
            # Trace backwards: pick the dependency (blocker) with the latest end time
            prev = max(
                task_deps[current],
                key=lambda tid: scheduled.get(tid, {}).get("end", 0),
            )
            path.append(prev)
            current = prev
        critical_path = list(reversed(path))
    else:
        project_end = project_start

    # Build response
    timeline_tasks = []
    for t in tasks:
        sched = scheduled.get(
            t.id,
            {
                "start": project_start,
                "end": project_start,
                "duration_days": 0,
                "actual": False,
            },
        )
        timeline_tasks.append(
            {
                "id": t.id,
                "title": t.title,
                "status": t.status,
                "priority": t.priority,
                "assigned_agent": t.assigned_agent,
                "tags": json.loads(t.tags) if t.tags else [],
                "estimated_hours": t.estimated_hours,
                "dependencies": task_deps.get(t.id, []),
                "scheduled_start": sched["start"],
                "scheduled_end": sched["end"],
                "duration_days": sched["duration_days"],
                "actual": sched.get("actual", False),
                "is_critical": t.id in critical_path,
            }
        )

    total_hours = sum(t.estimated_hours or 4 for t in tasks)

    return {
        "tasks": timeline_tasks,
        "project_start": project_start,
        "project_end": project_end,
        "total_hours": total_hours,
        "total_days": round(total_hours / hours_per_day, 1),
        "critical_path": critical_path,
        "hours_per_day": hours_per_day,
    }


# ══════════════════════════════════════════════════════════════════════════
# BULK IMPORT (for AI planner output)
# ══════════════════════════════════════════════════════════════════════════


@router.post("/{project_id}/import")
async def bulk_import_tasks(
    project_id: str,
    req: BulkImportTasksRequest,
    session: AsyncSession = Depends(get_async_session),
):
    """Import tasks from AI planner output. Validates dependency graph before importing."""
    logger.debug(
        f"Bulk importing tasks: project_id={project_id}, count={len(req.tasks)}"
    )
    now = now_ms()
    await get_project_or_404(session, project_id)

    # Get all columns so we can resolve backlog and ready
    cols_result = await session.execute(
        select(KanbanColumn)
        .where(KanbanColumn.project_id == project_id)
        .order_by(KanbanColumn.position)
    )
    all_cols = cols_result.scalars().all()
    if not all_cols:
        raise HTTPException(status_code=500, detail="Project has no columns")

    backlog_col = all_cols[0]
    ready_col = None
    for col in all_cols:
        statuses = json.loads(col.task_statuses) if col.task_statuses else []
        if "ready" in statuses:
            ready_col = col
            break

    # First pass: create task ID mapping (title → id)
    title_to_id: dict[str, str] = {}
    task_data: list[dict] = []

    for i, t in enumerate(req.tasks):
        task_id = gen_id("task_")
        title = t.get("title", f"Task {i + 1}")
        title_to_id[title] = task_id
        task_data.append(
            {
                "id": task_id,
                "title": title,
                "description": t.get("description", ""),
                "priority": t.get("priority", "P2"),
                "tags": t.get("tags", []),
                "estimated_hours": t.get("estimatedHours"),
                "dependencies": t.get("dependencies", []),  # title refs
            }
        )

    # Validate dependency graph before inserting anything
    # Resilient: unknown deps are fuzzy-matched or dropped with a warning
    edges_to_create = []
    skipped_deps = []
    for td in task_data:
        for dep_title in td["dependencies"]:
            resolved_title = dep_title
            if dep_title not in title_to_id:
                # Try fuzzy matching
                fuzzy_match = _fuzzy_resolve_dep(dep_title, title_to_id)
                if fuzzy_match:
                    logger.warning(
                        f"Fuzzy-matched dependency '{dep_title}' -> '{fuzzy_match}' "
                        f"for task '{td['title']}'"
                    )
                    resolved_title = fuzzy_match
                else:
                    logger.warning(
                        f"Dropping unknown dependency '{dep_title}' "
                        f"for task '{td['title']}' (no fuzzy match found)"
                    )
                    skipped_deps.append({"task": td["title"], "unknown_dep": dep_title})
                    continue
            edges_to_create.append(
                {
                    "from": title_to_id[resolved_title],
                    "to": td["id"],
                    "type": "blocks",
                }
            )

    # Check for cycles — also builds in_deg used to determine initial column
    all_ids = [td["id"] for td in task_data]
    # Build adj list
    adj_check: dict[str, list[str]] = {tid: [] for tid in all_ids}
    in_deg: dict[str, int] = {tid: 0 for tid in all_ids}
    for e in edges_to_create:
        adj_check[e["from"]].append(e["to"])
        in_deg[e["to"]] += 1

    q = [tid for tid, d in in_deg.items() if d == 0]
    count = 0
    while q:
        n = q.pop(0)
        count += 1
        for nb in adj_check.get(n, []):
            in_deg[nb] -= 1
            if in_deg[nb] == 0:
                q.append(nb)

    if count != len(all_ids):
        raise HTTPException(
            status_code=400, detail="Import rejected: dependency graph contains a cycle"
        )

    # Tasks with no incoming "blocks" edges are immediately actionable → Ready
    # Tasks that have unmet dependencies start in Backlog
    tasks_with_deps = {e["to"] for e in edges_to_create}

    # Insert tasks
    for i, td in enumerate(task_data):
        has_deps = td["id"] in tasks_with_deps
        if not has_deps and ready_col:
            task_status = "ready"
            task_col_id = ready_col.id
        else:
            task_status = "backlog"
            task_col_id = backlog_col.id
        task = Task(
            id=td["id"],
            project_id=project_id,
            title=td["title"],
            description=td["description"],
            status=task_status,
            priority=td["priority"],
            tags=json.dumps(td["tags"]),
            estimated_hours=td["estimated_hours"],
            column_id=task_col_id,
            column_position=i,
            task_metadata="{}",
            created_at=now,
            updated_at=now,
        )
        session.add(task)

    # Flush tasks to DB before inserting edges so FK constraints are satisfied
    await session.flush()

    # Insert dependency edges
    for edge in edges_to_create:
        dep = DependencyEdge(
            id=gen_id("dep_"),
            project_id=project_id,
            from_task_id=edge["from"],
            to_task_id=edge["to"],
            type=edge["type"],
        )
        session.add(dep)

    await session.commit()

    await _publish_event(
        "TASKS_IMPORTED", {"projectId": project_id, "count": len(task_data)}
    )

    return {
        "status": "imported",
        "tasks_created": len(task_data),
        "dependencies_created": len(edges_to_create),
        "skipped_dependencies": skipped_deps,
        "task_ids": {td["title"]: td["id"] for td in task_data},
        "title_to_id": title_to_id,  # Return mapping for subtask import
    }


async def bulk_import_subtasks(
    project_id: str, parent_title_to_id: dict, subtask_list: list, session: AsyncSession
):
    """Import subtasks, linking them to parent tasks by title."""
    logger.debug(
        f"Bulk importing subtasks: project_id={project_id}, count={len(subtask_list)}"
    )
    now = now_ms()

    # Get all columns so we can resolve backlog and ready
    cols_result = await session.execute(
        select(KanbanColumn)
        .where(KanbanColumn.project_id == project_id)
        .order_by(KanbanColumn.position)
    )
    all_cols = cols_result.scalars().all()
    backlog_col = all_cols[0] if all_cols else None
    backlog_col_id = backlog_col.id if backlog_col else None
    ready_col = None
    for col in all_cols:
        statuses = json.loads(col.task_statuses) if col.task_statuses else []
        if "ready" in statuses:
            ready_col = col
            break
    ready_col_id = ready_col.id if ready_col else None

    # Map subtask titles to IDs
    title_to_id = {}
    subtask_data = []

    for i, st in enumerate(subtask_list):
        subtask_id = gen_id("task_")
        title = st.get("title", f"Subtask {i + 1}")
        parent_title = st.get("parentTaskTitle", "")
        parent_id = parent_title_to_id.get(parent_title)

        if not parent_id:
            logger.warning(f"Unknown parent '{parent_title}' for subtask '{title}'")
            continue

        title_to_id[title] = subtask_id
        subtask_data.append(
            {
                "id": subtask_id,
                "title": title,
                "description": st.get("description", ""),
                "priority": st.get("priority", "P2"),
                "tags": st.get("tags", []),
                "estimated_hours": st.get("estimatedHours"),
                "dependencies": st.get("dependencies", []),
                "parent_task_id": parent_id,
            }
        )

    # Determine which subtasks have incoming dependency edges
    subtasks_with_deps = {
        td["id"]
        for td in subtask_data
        for dep_title in td["dependencies"]
        if dep_title in title_to_id
    }

    # Insert subtasks
    for i, td in enumerate(subtask_data):
        has_deps = td["id"] in subtasks_with_deps
        if not has_deps and ready_col_id:
            task_status = "ready"
            task_col_id = ready_col_id
        else:
            task_status = "backlog"
            task_col_id = backlog_col_id
        task = Task(
            id=td["id"],
            project_id=project_id,
            title=td["title"],
            description=td["description"],
            status=task_status,
            priority=td["priority"],
            parent_task_id=td["parent_task_id"],
            tags=json.dumps(td["tags"]),
            estimated_hours=td["estimated_hours"],
            column_id=task_col_id,
            column_position=i + 1000,
            task_metadata="{}",
            created_at=now,
            updated_at=now,
        )
        session.add(task)

    # Flush subtasks to DB before inserting edges so FK constraints are satisfied
    await session.flush()

    # Insert dependency edges among subtasks (with fuzzy fallback)
    edges_created = 0
    for td in subtask_data:
        for dep_title in td["dependencies"]:
            dep_id = title_to_id.get(dep_title)
            if not dep_id:
                # Try fuzzy matching against subtask titles
                fuzzy_match = _fuzzy_resolve_dep(dep_title, title_to_id)
                if fuzzy_match:
                    logger.warning(
                        f"Subtask fuzzy-matched dependency '{dep_title}' -> '{fuzzy_match}' "
                        f"for subtask '{td['title']}'"
                    )
                    dep_id = title_to_id[fuzzy_match]
                else:
                    logger.warning(
                        f"Dropping unknown subtask dependency '{dep_title}' "
                        f"for subtask '{td['title']}'"
                    )
            if dep_id:
                edge = DependencyEdge(
                    id=gen_id("dep_"),
                    project_id=project_id,
                    from_task_id=dep_id,
                    to_task_id=td["id"],
                    type="blocks",
                )
                session.add(edge)
                edges_created += 1

    await session.commit()
    return {"subtasks_created": len(subtask_data), "edges_created": edges_created}


async def reflow_task_statuses_after_planning(
    project_id: str, session: AsyncSession
) -> dict:
    """Reflow task statuses after planning completes.

    During planning, tasks are created before dependencies are wired, so they
    end up in 'ready' status even if they have unresolved blocking dependencies.
    This function moves blocked tasks to 'backlog' (the initial column) so only
    truly unblocked tasks remain in 'ready'.

    Additionally, parent tasks that have subtasks are moved to 'backlog' since
    they are container tasks whose status is derived from their children.

    Called automatically when a planning pipeline run completes.
    """
    now = now_ms()
    moved = 0

    # Get initial/backlog column for this project
    col_result = await session.execute(
        select(KanbanColumn)
        .where(KanbanColumn.project_id == project_id)
        .order_by(KanbanColumn.position)
    )
    all_cols = col_result.scalars().all()
    if not all_cols:
        return {"moved": 0, "error": "no columns"}

    # Find backlog column (first column or one with 'backlog' status)
    backlog_col = all_cols[0]
    for col in all_cols:
        statuses = json.loads(col.task_statuses) if col.task_statuses else []
        if "backlog" in statuses:
            backlog_col = col
            break

    backlog_status = "backlog"

    # Identify container parents (tasks that have subtasks)
    subtask_parents_result = await session.execute(
        select(Task.parent_task_id)
        .where(Task.project_id == project_id, Task.parent_task_id.isnot(None))
        .distinct()
    )
    container_parent_ids = {row[0] for row in subtask_parents_result.all()}

    # Get all tasks in the project that are in non-terminal statuses
    tasks_result = await session.execute(
        select(Task).where(
            Task.project_id == project_id,
            Task.status.notin_(["done", "failed"]),
        )
    )
    tasks = tasks_result.scalars().all()

    for task in tasks:
        should_move_to_backlog = False

        # Container parents always go to backlog (derived status)
        if task.id in container_parent_ids:
            should_move_to_backlog = True
        else:
            # Check if this task has any unresolved blocking dependencies
            dep_result = await session.execute(
                select(Task.status)
                .join(DependencyEdge, DependencyEdge.from_task_id == Task.id)
                .where(
                    DependencyEdge.to_task_id == task.id,
                    DependencyEdge.type == "blocks",
                )
            )
            deps = dep_result.all()
            if deps and not all(status == "done" for (status,) in deps):
                should_move_to_backlog = True

            # For subtasks: also check parent's deps
            if not should_move_to_backlog and task.parent_task_id:
                parent_dep_result = await session.execute(
                    select(Task.status)
                    .join(DependencyEdge, DependencyEdge.from_task_id == Task.id)
                    .where(
                        DependencyEdge.to_task_id == task.parent_task_id,
                        DependencyEdge.type == "blocks",
                    )
                )
                parent_deps = parent_dep_result.all()
                if parent_deps and not all(
                    status == "done" for (status,) in parent_deps
                ):
                    should_move_to_backlog = True

        if should_move_to_backlog and task.status != backlog_status:
            task.status = backlog_status
            task.column_id = backlog_col.id
            task.updated_at = now
            moved += 1

    # ── Second pass: promote unblocked leaf tasks to "ready" ──
    # Tasks that have no unresolved deps (and are not container parents) should
    # be in "ready" so agents can pick them up.
    ready_col = None
    for col in all_cols:
        statuses = json.loads(col.task_statuses) if col.task_statuses else []
        if "ready" in statuses:
            ready_col = col
            break

    promoted = 0
    if ready_col:
        # Re-fetch tasks since we just modified them
        tasks_result2 = await session.execute(
            select(Task).where(
                Task.project_id == project_id,
                Task.status == backlog_status,
            )
        )
        backlog_tasks = tasks_result2.scalars().all()

        for task in backlog_tasks:
            # Skip container parents — their status is derived
            if task.id in container_parent_ids:
                continue

            # Check own deps
            dep_result = await session.execute(
                select(Task.status)
                .join(DependencyEdge, DependencyEdge.from_task_id == Task.id)
                .where(
                    DependencyEdge.to_task_id == task.id,
                    DependencyEdge.type == "blocks",
                )
            )
            deps = dep_result.all()
            if deps and not all(status == "done" for (status,) in deps):
                continue

            # Check parent deps (for subtasks)
            if task.parent_task_id:
                parent_dep_result = await session.execute(
                    select(Task.status)
                    .join(DependencyEdge, DependencyEdge.from_task_id == Task.id)
                    .where(
                        DependencyEdge.to_task_id == task.parent_task_id,
                        DependencyEdge.type == "blocks",
                    )
                )
                parent_deps = parent_dep_result.all()
                if parent_deps and not all(
                    status == "done" for (status,) in parent_deps
                ):
                    continue

            # This task is unblocked — promote to ready
            task.status = "ready"
            task.column_id = ready_col.id
            task.updated_at = now
            promoted += 1

    await session.commit()
    logger.info(
        f"Post-planning reflow for project {project_id}: "
        f"{moved} → backlog, {promoted} → ready"
    )
    return {"moved": moved, "promoted": promoted}
