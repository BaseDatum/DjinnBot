"""Task dependency management endpoints."""
import json
from fastapi import APIRouter, HTTPException, Depends
from sqlalchemy import select, delete
from sqlalchemy.ext.asyncio import AsyncSession

from app.database import get_async_session
from app.models import Project, Task, DependencyEdge
from app.utils import now_ms, gen_id
from app.logging_config import get_logger
from ._common import (
    get_project_or_404,
    get_task_or_404,
    _serialize_task,
    _publish_event,
    AddDependencyRequest,
)

logger = get_logger(__name__)
router = APIRouter()


async def _detect_cycle(
    session: AsyncSession,
    project_id: str,
    from_task_id: str,
    to_task_id: str
) -> list[str] | None:
    """Check if adding edge (from → to) would create a cycle. Returns cycle path or None."""
    logger.debug(f"Detecting cycle: project_id={project_id}, from={from_task_id}, to={to_task_id}")
    # Get all existing edges for this project
    result = await session.execute(
        select(DependencyEdge.from_task_id, DependencyEdge.to_task_id)
        .where(DependencyEdge.project_id == project_id)
    )
    edges = result.all()
    
    # Build adjacency list including proposed edge
    adj: dict[str, list[str]] = {}
    for src, dst in edges:
        adj.setdefault(src, []).append(dst)
    adj.setdefault(from_task_id, []).append(to_task_id)
    
    # DFS from to_task_id — if we can reach from_task_id, there's a cycle
    visited = set()
    path = []
    
    def dfs(node: str) -> bool:
        if node == from_task_id:
            path.append(node)
            return True
        if node in visited:
            return False
        visited.add(node)
        path.append(node)
        for neighbor in adj.get(node, []):
            if dfs(neighbor):
                return True
        path.pop()
        return False
    
    if dfs(to_task_id):
        return path
    return None


@router.post("/{project_id}/tasks/{task_id}/dependencies")
async def add_dependency(project_id: str, task_id: str, req: AddDependencyRequest, session: AsyncSession = Depends(get_async_session)):
    """Add a dependency: fromTaskId must complete before task_id can start."""
    logger.debug(f"Adding dependency: project_id={project_id}, task_id={task_id}, from={req.fromTaskId}, type={req.type}")
    # Validate both tasks exist
    await get_task_or_404(session, project_id, task_id)
    from_task = await get_task_or_404(session, project_id, req.fromTaskId)
    
    if req.fromTaskId == task_id:
        raise HTTPException(status_code=400, detail="A task cannot depend on itself")
    
    # Check for existing dependency
    result = await session.execute(
        select(DependencyEdge.id)
        .where(
            DependencyEdge.from_task_id == req.fromTaskId,
            DependencyEdge.to_task_id == task_id
        )
    )
    if result.scalar_one_or_none():
        raise HTTPException(status_code=400, detail="Dependency already exists")
    
    # Cycle detection
    cycle = await _detect_cycle(session, project_id, req.fromTaskId, task_id)
    if cycle:
        # Get task titles for the cycle path
        title_map = {}
        for tid in cycle:
            result = await session.execute(
                select(Task.title).where(Task.id == tid)
            )
            title = result.scalar_one_or_none()
            if title:
                title_map[tid] = title
        
        cycle_path = " → ".join(title_map.get(tid, tid) for tid in cycle)
        raise HTTPException(
            status_code=400,
            detail=f"Cannot add dependency: would create a cycle: {cycle_path}"
        )
    
    dep = DependencyEdge(
        id=gen_id("dep_"),
        project_id=project_id,
        from_task_id=req.fromTaskId,
        to_task_id=task_id,
        type=req.type,
    )
    session.add(dep)
    await session.commit()
    
    await _publish_event("DEPENDENCY_ADDED", {
        "projectId": project_id,
        "fromTaskId": req.fromTaskId,
        "toTaskId": task_id,
        "type": req.type,
    })
    return {"id": dep.id, "from": req.fromTaskId, "to": task_id, "type": req.type}


@router.delete("/{project_id}/tasks/{task_id}/dependencies/{dep_id}")
async def remove_dependency(project_id: str, task_id: str, dep_id: str, session: AsyncSession = Depends(get_async_session)):
    """Remove a dependency."""
    logger.debug(f"Removing dependency: project_id={project_id}, dep_id={dep_id}")
    result = await session.execute(
        delete(DependencyEdge)
        .where(DependencyEdge.id == dep_id, DependencyEdge.project_id == project_id)
    )
    await session.commit()
    
    await _publish_event("DEPENDENCY_REMOVED", {"projectId": project_id, "dependencyId": dep_id})
    return {"status": "removed"}


@router.get("/{project_id}/dependency-graph")
async def get_dependency_graph(project_id: str, session: AsyncSession = Depends(get_async_session)):
    """Get the full dependency graph for visualization."""
    logger.debug(f"Getting dependency graph: project_id={project_id}")
    await get_project_or_404(session, project_id)
    
    # Get all tasks (nodes)
    result = await session.execute(
        select(Task)
        .where(Task.project_id == project_id)
    )
    tasks = result.scalars().all()
    tasks_data = [
        {
            "id": t.id,
            "title": t.title,
            "status": t.status,
            "priority": t.priority,
            "assigned_agent": t.assigned_agent,
            "estimated_hours": t.estimated_hours,
        }
        for t in tasks
    ]
    
    # Get all edges
    dep_result = await session.execute(
        select(DependencyEdge)
        .where(DependencyEdge.project_id == project_id)
    )
    edges_data = [
        {
            "id": e.id,
            "project_id": e.project_id,
            "from_task_id": e.from_task_id,
            "to_task_id": e.to_task_id,
            "type": e.type,
        }
        for e in dep_result.scalars().all()
    ]
    
    # Compute critical path
    # Simple longest-path calculation
    task_map = {t["id"]: t for t in tasks_data}
    task_ids = [t["id"] for t in tasks_data]
    blocking_edges = [e for e in edges_data if e["type"] == "blocks"]
    
    # Topological sort (Kahn's)
    in_degree = {tid: 0 for tid in task_ids}
    adj: dict[str, list[str]] = {tid: [] for tid in task_ids}
    for e in blocking_edges:
        if e["from_task_id"] in adj:
            adj[e["from_task_id"]].append(e["to_task_id"])
            in_degree[e["to_task_id"]] = in_degree.get(e["to_task_id"], 0) + 1
    
    queue = [tid for tid, d in in_degree.items() if d == 0]
    sorted_ids = []
    while queue:
        node = queue.pop(0)
        sorted_ids.append(node)
        for neighbor in adj.get(node, []):
            in_degree[neighbor] -= 1
            if in_degree[neighbor] == 0:
                queue.append(neighbor)
    
    # Longest path via DP
    dist = {tid: 0.0 for tid in task_ids}
    prev_map: dict[str, str | None] = {tid: None for tid in task_ids}
    for node in sorted_ids:
        for neighbor in adj.get(node, []):
            hours = task_map.get(neighbor, {}).get("estimated_hours") or 1
            if dist[node] + hours > dist[neighbor]:
                dist[neighbor] = dist[node] + hours
                prev_map[neighbor] = node
    
    # Trace critical path
    max_node = max(dist, key=lambda x: dist[x]) if dist else None
    critical_path = []
    current = max_node
    while current:
        critical_path.insert(0, current)
        current = prev_map.get(current)
    
    return {
        "nodes": tasks_data,
        "edges": edges_data,
        "critical_path": critical_path,
        "topological_order": sorted_ids,
    }
