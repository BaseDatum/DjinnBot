"""Agent management endpoints."""

import os
import re
import json
import yaml
from fastapi import APIRouter, HTTPException, Depends
from pydantic import BaseModel
from typing import Optional, Tuple
from sqlalchemy import select, func
from sqlalchemy.ext.asyncio import AsyncSession

from app.database import get_async_session
from app.models import Run, Step, Task
from app.models.agent import ProjectAgent
from app.models.project import Project
from app import dependencies
from app.logging_config import get_logger

logger = get_logger(__name__)

router = APIRouter()


class FileUpdateRequest(BaseModel):
    content: str


AGENTS_DIR = os.getenv("AGENTS_DIR", "./agents")
VAULTS_DIR = os.getenv("VAULTS_DIR", "/data/vaults")
PERSONA_FILES = ["IDENTITY.md", "SOUL.md", "AGENTS.md", "DECISION.md"]

EXCLUDED_DIRS = {"templates", ".clawvault", ".git", "node_modules"}


def _parse_identity(content: str) -> dict:
    result = {}
    for line in content.split("\n"):
        line = line.strip()
        # Match "- **Key:** value" or "Key: value"
        m = re.match(r"^[-*\s]*\*?\*?(\w+)\*?\*?\s*:\*?\*?\s*(.*)", line)
        if m:
            key = m.group(1).lower()
            val = m.group(2).strip().rstrip("*")
            if key == "name":
                result["name"] = val
            elif key == "emoji":
                result["emoji"] = val
            elif key == "role":
                result["role"] = val
            elif key == "description":
                result["description"] = val
        elif line.startswith("# ") and "name" not in result:
            result["name"] = line[2:].strip()
    return result


def _count_vault_files(agent_id: str) -> int:
    vault_dir = os.path.join(VAULTS_DIR, agent_id)
    if not os.path.isdir(vault_dir):
        return 0
    count = 0
    for root, dirs, files in os.walk(vault_dir):
        dirs[:] = [d for d in dirs if d not in EXCLUDED_DIRS]
        count += sum(1 for f in files if f.endswith(".md"))
    return count


def _read_file(filepath: str) -> Optional[str]:
    """Read file contents, return None if file doesn't exist or can't be read."""
    try:
        if not os.path.isfile(filepath):
            return None
        with open(filepath, "r", encoding="utf-8") as f:
            return f.read()
    except Exception as e:
        logger.warning(f"Failed to read file {filepath}: {e}")
        return None


def _parse_frontmatter(content: str) -> Tuple[dict, str]:
    """Parse YAML frontmatter from markdown content.

    Returns (metadata_dict, body_content).
    If no frontmatter, returns ({}, content).
    """
    if not content.startswith("---"):
        return {}, content

    # Find closing ---
    end_idx = content.find("---", 3)
    if end_idx == -1:
        return {}, content

    frontmatter = content[3:end_idx].strip()
    body = content[end_idx + 3 :].strip()

    try:
        import yaml

        meta = yaml.safe_load(frontmatter) or {}
    except Exception:
        meta = {}

    return meta, body


def _read_agent_config_model(agent_id: str) -> Optional[str]:
    """Read the model field from an agent's config.yml, if present."""
    config_path = os.path.join(AGENTS_DIR, agent_id, "config.yml")
    try:
        if not os.path.isfile(config_path):
            return None
        with open(config_path, "r", encoding="utf-8") as f:
            config = yaml.safe_load(f) or {}
        model = config.get("model")
        if model and isinstance(model, str) and model.strip():
            return model.strip()
    except Exception:
        pass
    return None


def _build_agent(agent_id: str) -> dict:
    logger.debug(f"Building agent: {agent_id}")
    agent_dir = os.path.join(AGENTS_DIR, agent_id)
    persona_files = [
        pf for pf in PERSONA_FILES if os.path.isfile(os.path.join(agent_dir, pf))
    ]

    name = agent_id
    emoji = None
    role = None
    description = None

    identity = _read_file(os.path.join(agent_dir, "IDENTITY.md"))
    if identity:
        logger.debug(f"Read IDENTITY.md for agent: {agent_id}")
        parsed = _parse_identity(identity)
        name = parsed.get("name", agent_id)
        emoji = parsed.get("emoji")
        role = parsed.get("role")
        description = parsed.get("description")

    slack_connected = os.path.isfile(os.path.join(agent_dir, "slack.yml"))

    return {
        "id": agent_id,
        "name": name,
        "emoji": emoji,
        "role": role,
        "description": description,
        "persona_files": persona_files,
        "slack_connected": slack_connected,
        "memory_count": _count_vault_files(agent_id),
        "model": _read_agent_config_model(agent_id),
    }


@router.get("/")
async def list_agents():
    logger.debug("Listing all agents")
    if not os.path.isdir(AGENTS_DIR):
        logger.debug(f"Agents directory not found: {AGENTS_DIR}")
        return []

    agents = []
    for entry in sorted(os.listdir(AGENTS_DIR)):
        if entry.startswith("_") or entry.startswith("."):
            continue
        agent_dir = os.path.join(AGENTS_DIR, entry)
        if os.path.isdir(agent_dir):
            logger.debug(f"Discovered agent: {entry}")
            agents.append(_build_agent(entry))
    logger.debug(f"Total agents discovered: {len(agents)}")
    return agents


@router.get("/status")
async def get_agents_status():
    """Get runtime status of all agents with fleet summary."""
    logger.debug("Getting agents status")
    # Get all agents from filesystem
    if not os.path.isdir(AGENTS_DIR):
        logger.debug(f"Agents directory not found: {AGENTS_DIR}")
        return {
            "agents": [],
            "summary": {
                "total": 0,
                "idle": 0,
                "working": 0,
                "thinking": 0,
                "totalQueued": 0,
            },
        }

    if dependencies.redis_client:
        logger.debug("Redis client connected for status check")
    else:
        logger.debug("Redis client not available")

    agents = []
    for entry in sorted(os.listdir(AGENTS_DIR)):
        if entry.startswith("_") or entry.startswith("."):
            continue
        agent_dir = os.path.join(AGENTS_DIR, entry)
        if os.path.isdir(agent_dir):
            logger.debug(f"Processing agent status: {entry}")
            base = _build_agent(entry)

            # Enrich with Redis runtime lifecycle status
            state = "idle"
            current_work = None
            queue_length = 0
            last_active = None
            pulse_enabled = False
            last_pulse = None

            if dependencies.redis_client:
                try:
                    # Get lifecycle state from Redis (stored as JSON string)
                    state_key = f"djinnbot:agent:{entry}:state"
                    state_json = await dependencies.redis_client.get(state_key)

                    if state_json:
                        import json

                        state_data = json.loads(state_json)
                        state = state_data.get("state", "idle")
                        current_work_data = state_data.get("currentWork")
                        if current_work_data:
                            current_work = {
                                "step": current_work_data.get("step"),
                                "runId": current_work_data.get("runId"),
                            }
                        last_active = state_data.get("lastActive") or None

                    # Get queue length
                    queue_key = f"djinnbot:agent:{entry}:queue"
                    queue_length = await dependencies.redis_client.llen(queue_key) or 0

                    # Get pulse config (stored as JSON string)
                    pulse_key = f"djinnbot:agent:{entry}:pulse"
                    pulse_json = await dependencies.redis_client.get(pulse_key)
                    pulse_data = json.loads(pulse_json) if pulse_json else None
                    if pulse_data:
                        pulse_enabled = pulse_data.get("enabled", "").lower() == "true"
                        last_pulse = int(pulse_data.get("lastPulse", 0)) or None

                except Exception as e:
                    logger.warning(f"Failed to get Redis status for {entry}: {e}")

            agents.append(
                {
                    "id": base.get("id", entry),
                    "name": base.get("name", entry),
                    "emoji": base.get("emoji", "🤖"),
                    "role": base.get("role", ""),
                    "state": state,
                    "currentWork": current_work,
                    "queueLength": queue_length,
                    "lastActive": last_active,
                    "lastPulse": last_pulse,
                    "pulseEnabled": pulse_enabled,
                    "slackConnected": base.get("slack_connected", False),
                }
            )

    # Calculate summary
    summary = {
        "total": len(agents),
        "idle": sum(1 for a in agents if a["state"] == "idle"),
        "working": sum(1 for a in agents if a["state"] == "working"),
        "thinking": sum(1 for a in agents if a["state"] == "thinking"),
        "totalQueued": sum(a["queueLength"] for a in agents),
    }

    return {"agents": agents, "summary": summary}


@router.get("/{agent_id}")
async def get_agent(agent_id: str):
    logger.debug(f"Getting agent: {agent_id}")
    agent_dir = os.path.join(AGENTS_DIR, agent_id)
    if not os.path.isdir(agent_dir):
        raise HTTPException(status_code=404, detail=f"Agent {agent_id} not found")

    base = _build_agent(agent_id)

    files = {}
    for pf in PERSONA_FILES:
        content = _read_file(os.path.join(agent_dir, pf))
        if content:
            files[pf] = content

    soul_preview = None
    if "SOUL.md" in files:
        soul_preview = files["SOUL.md"][:500]

    return {**base, "files": files, "soul_preview": soul_preview}


@router.get("/{agent_id}/memory")
async def list_agent_memory(agent_id: str):
    logger.debug(f"Listing memory for agent: {agent_id}")
    vault_dir = os.path.join(VAULTS_DIR, agent_id)
    if not os.path.isdir(vault_dir):
        return []

    memories = []
    for root, dirs, files in os.walk(vault_dir):
        # Exclude certain directories from traversal
        dirs[:] = [d for d in sorted(dirs) if d not in EXCLUDED_DIRS]

        for filename in sorted(files):
            if not filename.endswith(".md"):
                continue

            filepath = os.path.join(root, filename)
            content = _read_file(filepath)
            if not content:
                continue

            meta, body = _parse_frontmatter(content)
            created_at = None
            if meta.get("createdAt"):
                try:
                    created_at = int(meta["createdAt"])
                except ValueError:
                    pass

            # Calculate relative path from vault root
            rel_path = os.path.relpath(filepath, vault_dir)
            directory = os.path.dirname(rel_path) or None

            # Infer category from frontmatter or directory name
            category = meta.get("category")
            if not category and directory:
                category = directory.split(os.sep)[0]

            memories.append(
                {
                    "filename": rel_path,
                    "directory": directory,
                    "category": category,
                    "title": meta.get("title"),
                    "created_at": created_at,
                    "size_bytes": os.path.getsize(filepath),
                    "preview": body.strip()[:200] if body else None,
                }
            )
    return memories


@router.get("/{agent_id}/memory/{filename:path}")
async def get_memory_file(agent_id: str, filename: str):
    logger.debug(f"Reading memory file: {filename} for agent: {agent_id}")
    # Allow subdirectory paths but block traversal
    if ".." in filename or filename.startswith("/") or "\\" in filename:
        raise HTTPException(status_code=400, detail="Invalid filename")

    # Resolve and verify the path stays within the vault
    vault_dir = os.path.join(VAULTS_DIR, agent_id)
    filepath = os.path.realpath(os.path.join(vault_dir, filename))
    if not filepath.startswith(os.path.realpath(vault_dir)):
        raise HTTPException(status_code=400, detail="Path traversal detected")

    if not os.path.isfile(filepath):
        raise HTTPException(status_code=404, detail="Memory file not found")
    content = _read_file(filepath)
    if content is None:
        raise HTTPException(status_code=500, detail="Failed to read file")
    return {"filename": filename, "content": content}


@router.delete("/{agent_id}/memory/{filename:path}")
async def delete_memory_file(agent_id: str, filename: str):
    """Delete a memory file from an agent's vault."""
    if ".." in filename or filename.startswith("/") or "\\" in filename:
        raise HTTPException(status_code=400, detail="Invalid filename")

    vault_dir = os.path.join(VAULTS_DIR, agent_id)
    filepath = os.path.realpath(os.path.join(vault_dir, filename))
    if not filepath.startswith(os.path.realpath(vault_dir)):
        raise HTTPException(status_code=400, detail="Path traversal detected")

    if ".clawvault" in filename.split(os.sep):
        raise HTTPException(status_code=403, detail="Cannot delete .clawvault files")

    if not os.path.isfile(filepath):
        raise HTTPException(status_code=404, detail="Memory file not found")

    try:
        os.remove(filepath)
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Failed to delete file: {str(e)}")

    return {"agent_id": agent_id, "filename": filename, "deleted": True}


@router.get("/{agent_id}/status")
async def get_agent_status(agent_id: str):
    """Get runtime status of a single agent."""
    logger.debug(f"Getting agent status: {agent_id}")
    agent_dir = os.path.join(AGENTS_DIR, agent_id)
    if not os.path.isdir(agent_dir):
        raise HTTPException(status_code=404, detail=f"Agent {agent_id} not found")

    base = _build_agent(agent_id)

    # Get Redis runtime status
    status = "offline"
    last_seen = None
    active_steps = []
    current_run = None

    if dependencies.redis_client:
        logger.debug(f"Checking Redis status for agent: {agent_id}")
        try:
            heartbeat_key = f"djinnbot:agent:{agent_id}:heartbeat"
            heartbeat_data = await dependencies.redis_client.get(heartbeat_key)

            if heartbeat_data:
                heartbeat = json.loads(heartbeat_data)
                status = heartbeat.get("status", "online")
                last_seen = heartbeat.get("last_seen")
                active_steps = heartbeat.get("active_steps", [])
                current_run = heartbeat.get("current_run")
        except Exception as e:
            logger.warning(f"Failed to get Redis status for {agent_id}: {e}")

    return {
        **base,
        "status": status,
        "last_seen": last_seen,
        "active_steps": active_steps,
        "current_run": current_run,
    }


@router.get("/{agent_id}/runs")
async def get_agent_runs(
    agent_id: str, session: AsyncSession = Depends(get_async_session)
):
    """Get all runs where this agent participated."""
    logger.debug(f"Getting runs for agent: {agent_id}")
    agent_dir = os.path.join(AGENTS_DIR, agent_id)
    if not os.path.isdir(agent_dir):
        raise HTTPException(status_code=404, detail=f"Agent {agent_id} not found")

    # Get distinct runs where agent has steps using ORM
    result = await session.execute(
        select(
            Run.id,
            Run.pipeline_id,
            Run.task_description,
            Run.status,
            Run.created_at,
            func.group_concat(Step.id).label("step_ids"),
        )
        .join(Step, Run.id == Step.run_id)
        .where(Step.agent_id == agent_id)
        .group_by(Run.id)
        .order_by(Run.created_at.desc())
    )
    rows = result.all()

    return [
        {
            "run_id": row.id,
            "pipeline_id": row.pipeline_id,
            "task": row.task_description,
            "status": row.status,
            "step_ids": row.step_ids.split(",") if row.step_ids else [],
            "created_at": row.created_at,
        }
        for row in rows
    ]


@router.get("/{agent_id}/config")
async def get_agent_config(agent_id: str):
    """Get agent configuration from config.yml."""
    logger.debug(f"Getting config for agent: {agent_id}")
    agent_dir = os.path.join(AGENTS_DIR, agent_id)
    if not os.path.isdir(agent_dir):
        raise HTTPException(status_code=404, detail=f"Agent {agent_id} not found")

    config_path = os.path.join(agent_dir, "config.yml")
    if not os.path.isfile(config_path):
        logger.debug(f"No config.yml found for agent: {agent_id}")
        return {}

    logger.debug(f"Reading config.yml for agent: {agent_id}")
    with open(config_path, "r") as f:
        raw = yaml.safe_load(f) or {}

    # Build coordination config from raw YAML
    coordination_raw = raw.get("coordination", {})
    wake_raw = coordination_raw.get("wake_guardrails", {})
    coordination = {
        "maxConcurrentPulseSessions": coordination_raw.get(
            "max_concurrent_pulse_sessions", 2
        ),
        "wakeGuardrails": {
            "cooldownSeconds": wake_raw.get("cooldown_seconds", 300),
            "maxWakesPerDay": wake_raw.get("max_wakes_per_day", 12),
            "maxDailySessionMinutes": wake_raw.get("max_daily_session_minutes", 120),
            "maxWakesPerPairPerDay": wake_raw.get("max_wakes_per_pair_per_day", 5),
        },
    }

    # Map snake_case to camelCase for frontend
    return {
        "model": raw.get("model", ""),
        "thinkingModel": raw.get("thinking_model", raw.get("thinkingModel", "")),
        "planningModel": raw.get("planning_model", raw.get("planningModel", "")),
        "executorModel": raw.get("executor_model", raw.get("executorModel", "")),
        "thinkingLevel": raw.get("thinking_level", raw.get("thinkingLevel", "off")),
        "thinkingModelThinkingLevel": raw.get(
            "thinking_model_thinking_level",
            raw.get("thinkingModelThinkingLevel", "off"),
        ),
        "threadMode": raw.get("thread_mode", raw.get("threadMode", "passive")),
        "pulseEnabled": raw.get("pulse_enabled", raw.get("pulseEnabled", True)),
        "pulseIntervalMinutes": raw.get(
            "pulse_interval_minutes", raw.get("pulseIntervalMinutes", 30)
        ),
        "pulseColumns": raw.get("pulse_columns", raw.get("pulseColumns", [])),
        "pulseContainerTimeoutMs": raw.get(
            "pulse_container_timeout_ms", raw.get("pulseContainerTimeoutMs", 120000)
        ),
        "coordination": coordination,
    }


@router.put("/{agent_id}/config")
async def update_agent_config(agent_id: str, req: dict):
    """Update agent configuration (model, etc.)."""
    logger.debug(f"Updating config for agent: {agent_id}")
    agent_dir = os.path.join(AGENTS_DIR, agent_id)
    if not os.path.isdir(agent_dir):
        raise HTTPException(status_code=404, detail=f"Agent {agent_id} not found")

    config_path = os.path.join(agent_dir, "config.yml")

    # Load existing config or start fresh
    existing = {}
    if os.path.isfile(config_path):
        with open(config_path, "r") as f:
            existing = yaml.safe_load(f) or {}

    # Merge updates - map camelCase to snake_case where needed
    key_mapping = {
        "model": "model",
        "thinkingModel": "thinking_model",
        "planningModel": "planning_model",
        "executorModel": "executor_model",
        "thinkingLevel": "thinking_level",
        "thinkingModelThinkingLevel": "thinking_model_thinking_level",
        "threadMode": "thread_mode",
        "pulseEnabled": "pulse_enabled",
        "pulseIntervalMinutes": "pulse_interval_minutes",
        "pulseColumns": "pulse_columns",
        "pulseContainerTimeoutMs": "pulse_container_timeout_ms",
        "timeout": "timeout",
        "maxRetries": "max_retries",
    }

    for camel_key, yaml_key in key_mapping.items():
        if camel_key in req:
            existing[yaml_key] = req[camel_key]

    # Handle nested coordination config
    if "coordination" in req:
        coord = req["coordination"]
        if not isinstance(existing.get("coordination"), dict):
            existing["coordination"] = {}
        if "maxConcurrentPulseSessions" in coord:
            existing["coordination"]["max_concurrent_pulse_sessions"] = coord[
                "maxConcurrentPulseSessions"
            ]
        if "wakeGuardrails" in coord:
            wg = coord["wakeGuardrails"]
            if not isinstance(existing["coordination"].get("wake_guardrails"), dict):
                existing["coordination"]["wake_guardrails"] = {}
            wake_mapping = {
                "cooldownSeconds": "cooldown_seconds",
                "maxWakesPerDay": "max_wakes_per_day",
                "maxDailySessionMinutes": "max_daily_session_minutes",
                "maxWakesPerPairPerDay": "max_wakes_per_pair_per_day",
            }
            for camel_key, yaml_key in wake_mapping.items():
                if camel_key in wg:
                    existing["coordination"]["wake_guardrails"][yaml_key] = wg[
                        camel_key
                    ]

    # Write back
    logger.debug(f"Writing config.yml for agent: {agent_id}")
    with open(config_path, "w") as f:
        yaml.dump(existing, f, default_flow_style=False)

    return {"status": "updated", "config": existing}


# ── Work Ledger (live coordination) ──────────────────────────────────────


@router.get("/{agent_id}/work-ledger")
async def get_agent_work_ledger(agent_id: str):
    """Get active work locks for an agent across all parallel instances."""
    if not dependencies.redis_client:
        raise HTTPException(status_code=503, detail="Redis not available")

    ledger_key = f"djinnbot:agent:{agent_id}:work_ledger"
    keys = await dependencies.redis_client.smembers(ledger_key)

    if not keys:
        return {"agentId": agent_id, "locks": [], "count": 0}

    locks = []
    expired_keys = []
    for key in keys:
        lock_key = f"djinnbot:agent:{agent_id}:work_lock:{key}"
        raw = await dependencies.redis_client.get(lock_key)
        if not raw:
            expired_keys.append(key)
            continue
        try:
            entry = json.loads(raw)
            ttl = await dependencies.redis_client.ttl(lock_key)
            locks.append(
                {
                    "key": key,
                    "sessionId": entry.get("sessionId"),
                    "description": entry.get("description"),
                    "acquiredAt": entry.get("acquiredAt"),
                    "ttlSeconds": entry.get("ttlSeconds"),
                    "remainingSeconds": max(0, ttl) if ttl > 0 else 0,
                }
            )
        except (json.JSONDecodeError, TypeError):
            expired_keys.append(key)

    # Clean up expired keys
    if expired_keys:
        await dependencies.redis_client.srem(ledger_key, *expired_keys)

    return {
        "agentId": agent_id,
        "locks": sorted(locks, key=lambda x: x.get("acquiredAt", 0)),
        "count": len(locks),
    }


@router.get("/{agent_id}/wake-stats")
async def get_agent_wake_stats(agent_id: str):
    """Get wake guardrail stats for an agent (today's usage)."""
    if not dependencies.redis_client:
        raise HTTPException(status_code=503, detail="Redis not available")

    from datetime import date

    today = date.today().isoformat()
    day_key = f"djinnbot:agent:{agent_id}:wakes:{today}"
    wakes_today = await dependencies.redis_client.get(day_key)

    return {
        "agentId": agent_id,
        "wakesToday": int(wakes_today) if wakes_today else 0,
        "date": today,
    }


@router.put("/{agent_id}/files/{filename}")
async def update_agent_file(agent_id: str, filename: str, req: FileUpdateRequest):
    """Update an agent persona file."""
    logger.debug(f"Updating file: {filename} for agent: {agent_id}")
    # Validate filename — only allow known persona files
    ALLOWED_FILES = {"IDENTITY.md", "SOUL.md", "AGENTS.md", "DECISION.md"}
    if filename not in ALLOWED_FILES:
        raise HTTPException(
            status_code=400,
            detail=f"Cannot edit {filename}. Allowed: {', '.join(ALLOWED_FILES)}",
        )

    agent_dir = os.path.join(AGENTS_DIR, agent_id)
    if not os.path.isdir(agent_dir):
        raise HTTPException(status_code=404, detail=f"Agent {agent_id} not found")

    # Block path traversal
    if ".." in filename or "/" in filename:
        raise HTTPException(status_code=400, detail="Invalid filename")

    filepath = os.path.join(agent_dir, filename)

    with open(filepath, "w", encoding="utf-8") as f:
        f.write(req.content)

    return {"status": "updated", "filename": filename, "size": len(req.content)}


@router.get("/{agent_id}/projects")
async def get_agent_projects(
    agent_id: str, session: AsyncSession = Depends(get_async_session)
):
    """
    List all projects an agent is assigned to.

    Useful for pulse routines to discover work.
    """
    logger.debug(f"Getting projects for agent: {agent_id}")
    agent_dir = os.path.join(AGENTS_DIR, agent_id)
    if not os.path.isdir(agent_dir):
        raise HTTPException(status_code=404, detail=f"Agent {agent_id} not found")

    result = await session.execute(
        select(ProjectAgent, Project)
        .join(Project, ProjectAgent.project_id == Project.id)
        .where(ProjectAgent.agent_id == agent_id, Project.status != "archived")
        .order_by(ProjectAgent.role, ProjectAgent.assigned_at.desc())
    )
    rows = result.all()

    return [
        {
            "project_id": pa.project_id,
            "agent_id": pa.agent_id,
            "role": pa.role,
            "assigned_at": pa.assigned_at,
            "assigned_by": pa.assigned_by,
            "project_name": p.name,
            "project_status": p.status,
            "project_description": p.description,
        }
        for pa, p in rows
    ]


@router.get("/{agent_id}/projects/{project_id}/tasks")
async def get_agent_project_tasks(
    agent_id: str,
    project_id: str,
    status: Optional[str] = None,
    session: AsyncSession = Depends(get_async_session),
):
    """
    Get tasks in a project that are assigned to this agent.

    Query params:
    - status: Filter by task status (e.g., 'ready', 'in_progress')
    """
    logger.debug(f"Getting tasks for agent: {agent_id}, project: {project_id}")
    agent_dir = os.path.join(AGENTS_DIR, agent_id)
    if not os.path.isdir(agent_dir):
        raise HTTPException(status_code=404, detail=f"Agent {agent_id} not found")

    # Verify agent is assigned to project
    assignment = await session.execute(
        select(ProjectAgent).where(
            ProjectAgent.project_id == project_id, ProjectAgent.agent_id == agent_id
        )
    )
    if not assignment.scalar_one_or_none():
        raise HTTPException(
            status_code=403,
            detail=f"Agent {agent_id} is not assigned to project {project_id}",
        )

    # Get tasks
    query = select(Task).where(
        Task.project_id == project_id,
        (Task.assigned_agent == agent_id) | (Task.assigned_agent.is_(None)),
    )

    if status:
        query = query.where(Task.status == status)

    query = query.order_by(Task.priority, Task.created_at)

    result = await session.execute(query)
    tasks = result.scalars().all()

    return [
        {
            "id": t.id,
            "project_id": t.project_id,
            "title": t.title,
            "description": t.description,
            "status": t.status,
            "priority": t.priority,
            "assigned_agent": t.assigned_agent,
            "tags": json.loads(t.tags) if t.tags else [],
            "metadata": json.loads(t.task_metadata) if t.task_metadata else {},
            "created_at": t.created_at,
            "updated_at": t.updated_at,
        }
        for t in tasks
    ]
