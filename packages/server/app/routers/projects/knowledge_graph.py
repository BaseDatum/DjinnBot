"""Knowledge Graph API endpoints for projects.

Endpoints:
  GET    /v1/projects/{project_id}/knowledge-graph/status
  POST   /v1/projects/{project_id}/knowledge-graph/index
  GET    /v1/projects/{project_id}/knowledge-graph/index/{job_id}
  GET    /v1/projects/{project_id}/knowledge-graph/graph-data
  GET    /v1/projects/{project_id}/knowledge-graph/communities
  GET    /v1/projects/{project_id}/knowledge-graph/processes
  POST   /v1/projects/{project_id}/knowledge-graph/query
  GET    /v1/projects/{project_id}/knowledge-graph/context/{symbol_name}
  POST   /v1/projects/{project_id}/knowledge-graph/impact
  GET    /v1/projects/{project_id}/knowledge-graph/changes
  POST   /v1/projects/{project_id}/knowledge-graph/cypher
  GET    /v1/projects/{project_id}/knowledge-graph/file-content
"""

import asyncio
import json
import os
import subprocess
import uuid
from pathlib import Path
from typing import Optional

from fastapi import APIRouter, HTTPException, Depends, BackgroundTasks
from pydantic import BaseModel
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.database import get_async_session, AsyncSessionLocal
from app.models.code_graph import CodeGraphIndex
from app.utils import now_ms, gen_id
from app.logging_config import get_logger
from app import dependencies

from ._common import get_project_or_404

logger = get_logger(__name__)

router = APIRouter()

WORKSPACES_DIR = os.getenv("WORKSPACES_DIR", "/jfs/workspaces")

# In-memory job tracking (simple dict — not persistent across restarts)
_index_jobs: dict[str, dict] = {}


# ── Pydantic Models ────────────────────────────────────────────────────────


class IndexRequest(BaseModel):
    force: bool = False


class QueryRequest(BaseModel):
    query: str
    limit: int = 10
    include_content: bool = False


class ImpactRequest(BaseModel):
    target: str
    direction: str = "upstream"
    max_depth: int = 3
    min_confidence: float = 0.7


class CypherRequest(BaseModel):
    query: str


# ── Helpers ────────────────────────────────────────────────────────────────


def _workspace_path(project_id: str) -> Path:
    return Path(WORKSPACES_DIR) / project_id


def _db_path(project_id: str) -> str:
    return str(Path(WORKSPACES_DIR) / project_id / ".code-graph.kuzu")


def _get_current_commit(workspace: Path) -> Optional[str]:
    """Get HEAD commit hash from a git workspace."""
    if not (workspace / ".git").exists():
        return None
    try:
        result = subprocess.run(
            ["git", "rev-parse", "HEAD"],
            cwd=workspace,
            capture_output=True,
            text=True,
            check=True,
        )
        return result.stdout.strip()
    except Exception:
        return None


async def _get_or_create_index(
    session: AsyncSession, project_id: str
) -> CodeGraphIndex:
    """Get or create the CodeGraphIndex record for a project."""
    result = await session.execute(
        select(CodeGraphIndex).where(CodeGraphIndex.project_id == project_id)
    )
    index = result.scalar_one_or_none()
    if not index:
        now = now_ms()
        index = CodeGraphIndex(
            id=gen_id("cgi_"),
            project_id=project_id,
            status="pending",
            created_at=now,
            updated_at=now,
        )
        session.add(index)
        await session.flush()
    return index


REDIS_RESULT_KEY = "djinnbot:code-graph:result:{project_id}"
REDIS_RESULT_TTL = 600  # 10 minutes


async def _run_indexing(
    project_id: str,
    job_id: str,
    force: bool = False,
    *,
    skip_publish: bool = False,
):
    """Background task: publish indexing request to Redis, poll for engine result.

    The engine (Node.js) listens for CODE_GRAPH_INDEX_REQUESTED on the global
    event stream, runs the @djinnbot/code-graph pipeline, and writes the result
    to a Redis key. This function polls that key and updates the DB.

    Parameters
    ----------
    skip_publish : bool
        When True, skip publishing the Redis event (the caller already did it).
        Used by ``_repo_setup._trigger_code_graph_index`` which publishes the
        event itself before spawning this as a background task.
    """
    _index_jobs[job_id] = {
        "status": "running",
        "phase": "starting",
        "percent": 0,
        "message": "Requesting indexing from engine...",
    }

    try:
        if not dependencies.redis_client:
            raise RuntimeError("Redis not available")

        # Publish event for the engine to pick up (unless caller already did)
        if not skip_publish:
            event = {
                "type": "CODE_GRAPH_INDEX_REQUESTED",
                "projectId": project_id,
                "jobId": job_id,
                "force": force,
                "timestamp": now_ms(),
            }
            await dependencies.redis_client.xadd(
                "djinnbot:events:global", {"data": json.dumps(event)}
            )

        _index_jobs[job_id]["phase"] = "indexing"
        _index_jobs[job_id]["percent"] = 5
        _index_jobs[job_id]["message"] = "Engine is indexing..."

        # Poll for the result from the engine
        result_key = REDIS_RESULT_KEY.format(project_id=project_id)
        max_wait = 300  # 5 minutes max
        poll_interval = 2  # seconds
        waited = 0

        while waited < max_wait:
            await asyncio.sleep(poll_interval)
            waited += poll_interval

            raw = await dependencies.redis_client.get(result_key)
            if raw is None:
                # Check for progress updates
                progress_key = f"djinnbot:code-graph:progress:{project_id}"
                progress_raw = await dependencies.redis_client.get(progress_key)
                if progress_raw:
                    try:
                        progress = json.loads(progress_raw)
                        _index_jobs[job_id]["phase"] = progress.get("phase", "indexing")
                        _index_jobs[job_id]["percent"] = progress.get("percent", 5)
                        _index_jobs[job_id]["message"] = progress.get(
                            "message", "Indexing..."
                        )
                    except Exception:
                        pass
                continue

            # Got result
            result = json.loads(raw)
            await dependencies.redis_client.delete(result_key)

            if result.get("error"):
                raise RuntimeError(result["error"])

            # Update DB with success
            workspace = _workspace_path(project_id)
            async with AsyncSessionLocal() as session:
                db_result = await session.execute(
                    select(CodeGraphIndex).where(
                        CodeGraphIndex.project_id == project_id
                    )
                )
                index = db_result.scalar_one_or_none()
                if index:
                    now = now_ms()
                    index.status = "ready"
                    index.last_indexed_at = now
                    index.last_commit_hash = _get_current_commit(workspace)
                    index.node_count = result.get("nodeCount", 0)
                    index.relationship_count = result.get("relationshipCount", 0)
                    index.community_count = result.get("communityCount", 0)
                    index.process_count = result.get("processCount", 0)
                    index.error = None
                    index.updated_at = now
                    await session.commit()

            _index_jobs[job_id] = {
                "status": "completed",
                "phase": "complete",
                "percent": 100,
                "message": "Indexing complete",
                "result": result,
            }
            return

        # Timed out
        raise RuntimeError(
            "Indexing timed out after 5 minutes — engine may not be running"
        )

    except Exception as err:
        logger.error(f"Knowledge graph indexing failed for {project_id}: {err}")

        # Update DB with error
        try:
            async with AsyncSessionLocal() as session:
                db_result = await session.execute(
                    select(CodeGraphIndex).where(
                        CodeGraphIndex.project_id == project_id
                    )
                )
                index = db_result.scalar_one_or_none()
                if index:
                    index.status = "failed"
                    index.error = str(err)[:1000]
                    index.updated_at = now_ms()
                    await session.commit()
        except Exception:
            pass

        _index_jobs[job_id] = {
            "status": "failed",
            "phase": "error",
            "percent": 0,
            "message": str(err)[:500],
        }


# ── Endpoints ──────────────────────────────────────────────────────────────


@router.get("/{project_id}/knowledge-graph/status")
async def get_knowledge_graph_status(
    project_id: str,
    session: AsyncSession = Depends(get_async_session),
):
    """Get the indexing status of a project's code knowledge graph."""
    await get_project_or_404(session, project_id)

    result = await session.execute(
        select(CodeGraphIndex).where(CodeGraphIndex.project_id == project_id)
    )
    index = result.scalar_one_or_none()

    workspace = _workspace_path(project_id)
    current_commit = _get_current_commit(workspace)
    is_git = (workspace / ".git").exists()

    if not index:
        return {
            "indexed": False,
            "stale": False,
            "is_git": is_git,
            "node_count": 0,
            "relationship_count": 0,
            "community_count": 0,
            "process_count": 0,
            "last_indexed_at": None,
            "last_commit_hash": None,
            "current_commit_hash": current_commit,
            "status": "not_indexed",
            "error": None,
        }

    stale = (
        index.status == "ready"
        and current_commit is not None
        and index.last_commit_hash != current_commit
    )

    return {
        "indexed": index.status == "ready",
        "stale": stale,
        "is_git": is_git,
        "node_count": index.node_count,
        "relationship_count": index.relationship_count,
        "community_count": index.community_count,
        "process_count": index.process_count,
        "last_indexed_at": index.last_indexed_at,
        "last_commit_hash": index.last_commit_hash,
        "current_commit_hash": current_commit,
        "status": index.status,
        "error": index.error,
    }


@router.post("/{project_id}/knowledge-graph/index")
async def trigger_knowledge_graph_index(
    project_id: str,
    req: IndexRequest = IndexRequest(),
    background_tasks: BackgroundTasks = BackgroundTasks(),
    session: AsyncSession = Depends(get_async_session),
):
    """Trigger (re-)indexing of the project's code knowledge graph."""
    project = await get_project_or_404(session, project_id)

    workspace = _workspace_path(project_id)
    if not workspace.exists():
        raise HTTPException(status_code=400, detail="Project workspace not found")

    # Create/update the index record
    index = await _get_or_create_index(session, project_id)
    if index.status == "indexing":
        raise HTTPException(status_code=409, detail="Indexing already in progress")

    index.status = "indexing"
    index.error = None
    index.updated_at = now_ms()
    await session.commit()

    # Start background job
    job_id = str(uuid.uuid4())[:8]
    background_tasks.add_task(_run_indexing, project_id, job_id, req.force)

    return {"job_id": job_id, "status": "started"}


@router.get("/{project_id}/knowledge-graph/index/{job_id}")
async def get_index_progress(project_id: str, job_id: str):
    """Poll for indexing progress."""
    job = _index_jobs.get(job_id)
    if not job:
        raise HTTPException(status_code=404, detail="Job not found")
    return job


@router.get("/{project_id}/knowledge-graph/graph-data")
async def get_graph_data(
    project_id: str,
    session: AsyncSession = Depends(get_async_session),
):
    """Get the full graph summary for visualization.

    Returns nodes (symbols + communities) and edges for rendering
    a force-directed graph in the dashboard.
    """
    await get_project_or_404(session, project_id)

    result = await session.execute(
        select(CodeGraphIndex).where(CodeGraphIndex.project_id == project_id)
    )
    index = result.scalar_one_or_none()
    if not index or index.status != "ready":
        return {"nodes": [], "edges": [], "communities": [], "processes": []}

    # Query KuzuDB for graph data
    try:
        from app.routers.projects._kuzu_helper import query_graph_data

        return await query_graph_data(_db_path(project_id))
    except Exception as err:
        logger.error(f"Failed to query graph data: {err}")
        return {
            "nodes": [],
            "edges": [],
            "communities": [],
            "processes": [],
            "error": str(err),
        }


@router.get("/{project_id}/knowledge-graph/communities")
async def get_communities(
    project_id: str,
    session: AsyncSession = Depends(get_async_session),
):
    """List all detected code communities."""
    await get_project_or_404(session, project_id)

    try:
        from app.routers.projects._kuzu_helper import query_communities

        return await query_communities(_db_path(project_id))
    except Exception as err:
        logger.error(f"Failed to query communities: {err}")
        return {"communities": [], "error": str(err)}


@router.get("/{project_id}/knowledge-graph/processes")
async def get_processes(
    project_id: str,
    session: AsyncSession = Depends(get_async_session),
):
    """List all detected execution flows."""
    await get_project_or_404(session, project_id)

    try:
        from app.routers.projects._kuzu_helper import query_processes

        return await query_processes(_db_path(project_id))
    except Exception as err:
        logger.error(f"Failed to query processes: {err}")
        return {"processes": [], "error": str(err)}


@router.post("/{project_id}/knowledge-graph/query")
async def search_knowledge_graph(
    project_id: str,
    req: QueryRequest,
    session: AsyncSession = Depends(get_async_session),
):
    """Hybrid search across the code knowledge graph."""
    await get_project_or_404(session, project_id)

    try:
        from app.routers.projects._kuzu_helper import query_search

        return await query_search(_db_path(project_id), req.query, req.limit)
    except Exception as err:
        logger.error(f"Failed to search graph: {err}")
        return {"results": [], "error": str(err)}


@router.get("/{project_id}/knowledge-graph/context/{symbol_name}")
async def get_symbol_context(
    project_id: str,
    symbol_name: str,
    file_path: Optional[str] = None,
    session: AsyncSession = Depends(get_async_session),
):
    """Get 360-degree context for a code symbol."""
    await get_project_or_404(session, project_id)

    try:
        from app.routers.projects._kuzu_helper import query_context

        return await query_context(_db_path(project_id), symbol_name, file_path)
    except Exception as err:
        logger.error(f"Failed to get context: {err}")
        return {"error": str(err)}


@router.post("/{project_id}/knowledge-graph/impact")
async def analyze_impact(
    project_id: str,
    req: ImpactRequest,
    session: AsyncSession = Depends(get_async_session),
):
    """Analyze the blast radius of changing a code symbol."""
    await get_project_or_404(session, project_id)

    try:
        from app.routers.projects._kuzu_helper import query_impact

        return await query_impact(
            _db_path(project_id),
            req.target,
            req.direction,
            req.max_depth,
            req.min_confidence,
        )
    except Exception as err:
        logger.error(f"Failed to analyze impact: {err}")
        return {"error": str(err)}


@router.get("/{project_id}/knowledge-graph/changes")
async def detect_changes(
    project_id: str,
    session: AsyncSession = Depends(get_async_session),
):
    """Map uncommitted git changes to affected symbols and processes."""
    await get_project_or_404(session, project_id)

    workspace = _workspace_path(project_id)
    if not (workspace / ".git").exists():
        return {"error": "Not a git repository"}

    try:
        from app.routers.projects._kuzu_helper import query_changes

        return await query_changes(_db_path(project_id), str(workspace))
    except Exception as err:
        logger.error(f"Failed to detect changes: {err}")
        return {"error": str(err)}


@router.post("/{project_id}/knowledge-graph/cypher")
async def execute_cypher(
    project_id: str,
    req: CypherRequest,
    session: AsyncSession = Depends(get_async_session),
):
    """Execute a raw Cypher query against the knowledge graph."""
    await get_project_or_404(session, project_id)

    # Safety: prevent mutations
    lower = req.query.strip().lower()
    if any(
        kw in lower for kw in ["create", "delete", "set", "merge", "drop", "remove"]
    ):
        raise HTTPException(status_code=400, detail="Only read queries are allowed")

    try:
        from app.routers.projects._kuzu_helper import query_cypher

        return await query_cypher(_db_path(project_id), req.query)
    except Exception as err:
        logger.error(f"Failed to execute cypher: {err}")
        return {"error": str(err)}


@router.get("/{project_id}/knowledge-graph/file-content")
async def get_file_content(
    project_id: str,
    path: str,
    session: AsyncSession = Depends(get_async_session),
):
    """Read a source file from the project workspace for the code inspector.

    Returns the file content with language detection.
    Path must be relative to the workspace root.
    """
    await get_project_or_404(session, project_id)

    workspace = _workspace_path(project_id)
    if not workspace.exists():
        raise HTTPException(status_code=404, detail="Project workspace not found")

    # Normalize and validate path to prevent directory traversal
    clean_path = Path(path).as_posix().lstrip("/").lstrip("./")
    if ".." in clean_path.split("/"):
        raise HTTPException(status_code=400, detail="Invalid path")

    file_path = workspace / clean_path
    resolved = file_path.resolve()
    if not str(resolved).startswith(str(workspace.resolve())):
        raise HTTPException(status_code=400, detail="Path escapes workspace")

    if not resolved.is_file():
        raise HTTPException(status_code=404, detail="File not found")

    # Size limit: 1 MB
    stat = resolved.stat()
    if stat.st_size > 1_048_576:
        raise HTTPException(status_code=413, detail="File too large (>1 MB)")

    try:
        content = resolved.read_text(encoding="utf-8", errors="replace")
    except Exception:
        raise HTTPException(status_code=500, detail="Failed to read file")

    # Detect language from extension
    ext = resolved.suffix.lower()
    LANG_MAP = {
        ".py": "python",
        ".js": "javascript",
        ".jsx": "javascript",
        ".ts": "typescript",
        ".tsx": "typescript",
        ".go": "go",
        ".rs": "rust",
        ".java": "java",
        ".c": "c",
        ".cpp": "cpp",
        ".h": "c",
        ".hpp": "cpp",
        ".cs": "csharp",
        ".rb": "ruby",
        ".php": "php",
        ".swift": "swift",
        ".kt": "kotlin",
        ".scala": "scala",
        ".sh": "bash",
        ".bash": "bash",
        ".yaml": "yaml",
        ".yml": "yaml",
        ".json": "json",
        ".toml": "toml",
        ".md": "markdown",
        ".html": "html",
        ".css": "css",
        ".scss": "scss",
        ".sql": "sql",
        ".r": "r",
        ".lua": "lua",
        ".zig": "zig",
    }

    return {
        "content": content,
        "path": clean_path,
        "language": LANG_MAP.get(ext, "text"),
        "lines": content.count("\n") + 1,
        "size": stat.st_size,
    }
