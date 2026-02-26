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

from ._common import get_project_or_404

logger = get_logger(__name__)

router = APIRouter()

WORKSPACES_DIR = os.getenv("WORKSPACES_DIR", "/data/workspaces")

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
    return str(Path(WORKSPACES_DIR) / project_id / ".code-graph")


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


async def _run_indexing(project_id: str, job_id: str, force: bool = False):
    """Background task that runs the code-graph indexing pipeline.

    Invokes the TypeScript pipeline via a subprocess (npx or node).
    Updates the DB record when done.
    """
    workspace = _workspace_path(project_id)
    db_path = _db_path(project_id)

    _index_jobs[job_id] = {
        "status": "running",
        "phase": "starting",
        "percent": 0,
        "message": "Starting indexer...",
    }

    try:
        # Run the indexer as a Node.js subprocess
        # The pipeline script reads from stdin and writes progress to stderr
        indexer_script = os.path.join(
            os.path.dirname(
                os.path.dirname(os.path.dirname(os.path.dirname(__file__)))
            ),
            "code-graph",
            "dist",
            "cli.js",
        )

        # If the compiled script doesn't exist, try npx
        if not os.path.exists(indexer_script):
            # Fallback: use the pipeline directly via node
            indexer_script = os.path.join(
                os.path.dirname(
                    os.path.dirname(os.path.dirname(os.path.dirname(__file__)))
                ),
                "code-graph",
                "dist",
                "index.js",
            )

        _index_jobs[job_id]["phase"] = "indexing"
        _index_jobs[job_id]["percent"] = 5

        # For now, we'll invoke the pipeline and track progress
        # In production this would be a proper subprocess with progress streaming
        process = await asyncio.create_subprocess_exec(
            "node",
            "--experimental-specifier-resolution=node",
            "-e",
            f"""
            import('{indexer_script.replace(os.sep, "/")}').then(async (mod) => {{
                const {{ runPipeline }} = mod;
                const result = await runPipeline(
                    '{str(workspace).replace(os.sep, "/")}',
                    '{db_path.replace(os.sep, "/")}',
                    (progress) => {{
                        process.stderr.write(JSON.stringify(progress) + '\\n');
                    }}
                );
                process.stdout.write(JSON.stringify({{
                    nodeCount: result.nodeCount,
                    relationshipCount: result.relationshipCount,
                    communityCount: result.communityCount,
                    processCount: result.processCount,
                }}));
            }}).catch(err => {{
                process.stderr.write('ERROR: ' + err.message);
                process.exit(1);
            }});
            """,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
        )

        stdout_data, stderr_data = await process.communicate()

        if process.returncode != 0:
            error_msg = stderr_data.decode() if stderr_data else "Unknown error"
            raise RuntimeError(f"Indexer failed: {error_msg}")

        # Parse result
        result = json.loads(stdout_data.decode())

        # Update DB
        async with AsyncSessionLocal() as session:
            db_result = await session.execute(
                select(CodeGraphIndex).where(CodeGraphIndex.project_id == project_id)
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
