"""Spawn Executor — Internal API for plan-then-execute workflow.

An agent (the planner) calls this endpoint to spawn a fresh executor instance
with a curated prompt. The executor runs in a separate container with a clean
context window, implements the task, and the result is returned to the planner.

Flow:
1. Planner agent calls spawn_executor tool → POST /v1/internal/spawn-executor
2. This endpoint does pre-flight memory injection (searches for relevant lessons)
3. Creates a lightweight Run with pipeline_id="execute"
4. The execution prompt (enriched with memories) is stored as the task_description
5. The run is dispatched to the engine via Redis
6. The planner polls GET /v1/runs/{run_id} until completion

The key innovation: the executor gets ONLY the planner's curated prompt plus
deviation rules and relevant past lessons — no accumulated context from prior
work. Fresh 200k-token window dedicated entirely to the task.
"""

import json
import os
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

logger = get_logger(__name__)

router = APIRouter()

VAULTS_DIR = os.getenv("VAULTS_DIR", "/data/vaults")


# ══════════════════════════════════════════════════════════════════════════
# PRE-FLIGHT MEMORY INJECTION
# ══════════════════════════════════════════════════════════════════════════


def _search_vault_files(vault_path: str, query: str, limit: int = 5) -> list[dict]:
    """Search markdown files in a vault directory for content matching query.

    Returns list of {title, snippet, score} dicts sorted by relevance.
    Uses simple substring matching — same as GET /v1/memory/search.
    """
    if not os.path.isdir(vault_path):
        return []

    query_lower = query.lower()
    results = []
    excluded = {"templates", ".clawvault", ".git", "node_modules"}

    for root, dirs, files in os.walk(vault_path):
        dirs[:] = [d for d in dirs if d not in excluded]
        for filename in files:
            if not filename.endswith(".md"):
                continue
            filepath = os.path.join(root, filename)
            try:
                with open(filepath, "r", encoding="utf-8", errors="replace") as f:
                    content = f.read()
            except Exception:
                continue

            content_lower = content.lower()
            if query_lower not in content_lower:
                continue

            # Extract title from frontmatter or filename
            title = filename.replace(".md", "").replace("-", " ").title()
            for line in content.split("\n"):
                if line.startswith("title:"):
                    title = line.split(":", 1)[1].strip().strip('"').strip("'")
                    break

            # Score by frequency of query terms
            score = sum(
                content_lower.count(term)
                for term in query_lower.split()
                if len(term) > 2
            )

            # Extract a relevant snippet
            pos = content_lower.find(query_lower)
            start = max(0, pos - 80)
            end = min(len(content), pos + len(query) + 200)
            snippet = content[start:end].strip()
            if start > 0:
                snippet = "..." + snippet
            if end < len(content):
                snippet = snippet + "..."

            results.append({"title": title, "snippet": snippet, "score": score})

            if len(results) >= limit * 3:
                break
        if len(results) >= limit * 3:
            break

    results.sort(key=lambda x: x["score"], reverse=True)
    return results[:limit]


def _build_lessons_section(
    agent_id: str,
    task_title: str,
    task_tags: list[str],
    task_description: str,
) -> str:
    """Search agent's personal + shared vault for relevant past lessons.

    Returns a markdown section to inject into the executor prompt, or empty
    string if nothing relevant was found.

    This is the structural enforcement that makes agents actually USE their
    memories — it's injected into the prompt, not left to agent discretion.
    """
    # Build search queries from task metadata
    queries = []
    if task_tags:
        queries.append(" ".join(task_tags))
    if task_title:
        # Use key words from the title
        title_words = [w for w in task_title.lower().split() if len(w) > 3]
        if title_words:
            queries.append(" ".join(title_words[:4]))
    # Always search for "lesson" and "failure" patterns
    queries.append("lesson")

    # Search both personal and shared vaults
    all_results = []
    personal_path = os.path.join(VAULTS_DIR, agent_id)
    shared_path = os.path.join(VAULTS_DIR, "shared")

    for query in queries:
        for vault_path in [personal_path, shared_path]:
            results = _search_vault_files(vault_path, query, limit=3)
            all_results.extend(results)

    if not all_results:
        return ""

    # Deduplicate by title
    seen_titles = set()
    unique_results = []
    for r in all_results:
        if r["title"] not in seen_titles:
            seen_titles.add(r["title"])
            unique_results.append(r)

    # Take top 5 most relevant
    unique_results.sort(key=lambda x: x["score"], reverse=True)
    top_results = unique_results[:5]

    lines = ["## Lessons From Past Work (Injected Automatically)", ""]
    lines.append(
        "These memories were found in the team's knowledge vault. "
        "Read them before starting — they contain lessons from similar past work."
    )
    lines.append("")

    for r in top_results:
        lines.append(f"### {r['title']}")
        lines.append(r["snippet"])
        lines.append("")

    return "\n".join(lines)


# ══════════════════════════════════════════════════════════════════════════
# REQUEST MODEL
# ══════════════════════════════════════════════════════════════════════════


class SpawnExecutorRequest(BaseModel):
    agent_id: str = Field(
        ..., description="Agent ID of the planner (executor inherits identity)"
    )
    project_id: str = Field(..., description="Project ID for workspace provisioning")
    task_id: str = Field(..., description="Task ID being executed")
    execution_prompt: str = Field(
        ..., description="The planner's curated execution prompt"
    )
    deviation_rules: str = Field(
        default="", description="Deviation rules to inject into system prompt"
    )
    model_override: Optional[str] = Field(
        None, description="Override the executor model"
    )
    timeout_seconds: int = Field(
        default=300, ge=30, le=600, description="Max execution time"
    )


# ══════════════════════════════════════════════════════════════════════════
# ENDPOINT
# ══════════════════════════════════════════════════════════════════════════


@router.post("/spawn-executor")
async def spawn_executor(
    req: SpawnExecutorRequest,
    session: AsyncSession = Depends(get_async_session),
):
    """Spawn a fresh executor agent for a task.

    Creates a run that the engine picks up and dispatches to a fresh container.
    The executor gets the planner's curated prompt enriched with relevant
    memories from the knowledge vault (pre-flight injection).

    Returns immediately with the run_id — the planner polls for completion.
    """
    logger.info(
        f"Spawn executor: agent={req.agent_id}, project={req.project_id}, "
        f"task={req.task_id}, model={req.model_override or 'default'}"
    )
    now = now_ms()

    # ── Pre-flight memory injection ──────────────────────────────────────
    # Look up the task to get tags and title for memory search.
    # This is structural — the executor always gets relevant past lessons
    # regardless of whether the planner remembered to recall() them.
    task_title = ""
    task_tags: list[str] = []
    task_description = ""
    try:
        task_result = await session.execute(
            select(Task).where(
                Task.id == req.task_id, Task.project_id == req.project_id
            )
        )
        task = task_result.scalar_one_or_none()
        if task:
            task_title = task.title or ""
            task_description = task.description or ""
            task_tags = json.loads(task.tags) if task.tags else []
    except Exception as e:
        logger.warning(f"Failed to look up task for memory injection: {e}")

    lessons_section = _build_lessons_section(
        req.agent_id, task_title, task_tags, task_description
    )

    # Build the enriched task description
    enriched_prompt = req.execution_prompt
    if lessons_section:
        enriched_prompt += f"\n\n{lessons_section}"
        logger.info(
            f"Pre-flight injection: added {len(lessons_section)} chars of lessons"
        )

    # Store metadata in human_context for the engine to use
    human_context = json.dumps(
        {
            "spawn_executor": True,
            "planner_agent_id": req.agent_id,
            "project_id": req.project_id,
            "task_id": req.task_id,
            "deviation_rules": req.deviation_rules,
            "timeout_seconds": req.timeout_seconds,
            "memory_injection": bool(lessons_section),
        }
    )

    # Create the run — uses 'execute' pipeline (single-step, minimal overhead)
    run_id = gen_id("run_")

    run = Run(
        id=run_id,
        pipeline_id="execute",
        project_id=req.project_id,
        task_description=enriched_prompt,
        status="pending",
        outputs="{}",
        human_context=human_context,
        model_override=req.model_override,
        created_at=now,
        updated_at=now,
    )
    session.add(run)
    await session.commit()

    # Dispatch to engine via Redis
    if dependencies.redis_client:
        try:
            await dependencies.redis_client.xadd(
                "djinnbot:events:new_runs",
                {"run_id": run_id, "pipeline_id": "execute"},
            )
            logger.info(f"Executor run dispatched: {run_id}")
        except Exception as e:
            logger.warning(f"Failed to dispatch executor run to Redis: {e}")
    else:
        logger.warning(
            "Redis not available — executor run created in DB but not dispatched"
        )

    return {
        "run_id": run_id,
        "status": "dispatched",
        "pipeline_id": "execute",
        "model": req.model_override or "default",
        "memory_injection": bool(lessons_section),
    }
