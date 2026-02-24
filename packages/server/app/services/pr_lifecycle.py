"""PR Lifecycle Handler — automated server-side reactions to PR events.

Handles the autonomous loop closure:
- PR merged → auto-transition task to "done", publish worktree cleanup event
- PR closed (not merged) → optionally transition task back to "in_progress"

This runs server-side without requiring an agent session. It's called from
the webhook listener in main.py before/alongside the agent assignment routing.

The key insight: PR merge → task done → worktree cleanup is a purely mechanical
workflow that doesn't need LLM reasoning. Doing it server-side ensures it
happens reliably even if no agent is awake.
"""

import json
import re
from typing import Optional, Dict, Any

from sqlalchemy import select, update
from sqlalchemy.ext.asyncio import AsyncSession

from app.database import AsyncSessionLocal
from app.models import Task, Project, KanbanColumn
from app.models.base import now_ms
from app import dependencies
from app.logging_config import get_logger

logger = get_logger(__name__)


# ══════════════════════════════════════════════════════════════════════════
# BRANCH → TASK MATCHING
# ══════════════════════════════════════════════════════════════════════════


def _extract_task_id_from_branch(branch: str) -> Optional[str]:
    """Extract a task ID from a feature branch name.

    Supported formats:
    - feat/task_abc123-implement-oauth  → task_abc123
    - feat/task_abc123                  → task_abc123

    Returns None if the branch doesn't match a known task branch pattern.
    """
    match = re.match(r"^feat/(task_[a-zA-Z0-9]+)", branch)
    return match.group(1) if match else None


async def _find_task_by_pr_metadata(
    session: AsyncSession,
    project_id: str,
    pr_number: int,
    pr_url: str,
) -> Optional[Task]:
    """Find a task that has this PR stored in its metadata.

    When agents call open_pull_request, the PR URL/number is stored in
    task.metadata.pr_url and task.metadata.pr_number.
    """
    # Search tasks in this project that have pr_number or pr_url in metadata
    result = await session.execute(
        select(Task).where(
            Task.project_id == project_id,
            Task.task_metadata.isnot(None),
        )
    )
    for task in result.scalars().all():
        try:
            meta = json.loads(task.task_metadata) if task.task_metadata else {}
        except (json.JSONDecodeError, TypeError):
            continue

        if meta.get("pr_number") == pr_number or meta.get("pr_url") == pr_url:
            return task

    return None


async def _find_task_by_branch(
    session: AsyncSession,
    project_id: str,
    branch: str,
) -> Optional[Task]:
    """Find a task by matching its git_branch metadata to the PR head branch."""
    task_id = _extract_task_id_from_branch(branch)

    # Strategy 1: Direct task ID from branch name
    if task_id:
        result = await session.execute(
            select(Task).where(
                Task.id == task_id,
                Task.project_id == project_id,
            )
        )
        task = result.scalar_one_or_none()
        if task:
            return task

    # Strategy 2: Search metadata for git_branch match
    result = await session.execute(
        select(Task).where(
            Task.project_id == project_id,
            Task.task_metadata.isnot(None),
        )
    )
    for task in result.scalars().all():
        try:
            meta = json.loads(task.task_metadata) if task.task_metadata else {}
        except (json.JSONDecodeError, TypeError):
            continue

        if meta.get("git_branch") == branch:
            return task

    return None


async def _find_project_by_repo(
    session: AsyncSession,
    repo_full_name: str,
) -> Optional[str]:
    """Find project ID by GitHub repository full name."""
    result = await session.execute(
        select(Project.id).where(
            (Project.repository == f"https://github.com/{repo_full_name}")
            | (Project.repository == f"git@github.com:{repo_full_name}.git")
        )
    )
    row = result.scalar_one_or_none()
    return row if row else None


# ══════════════════════════════════════════════════════════════════════════
# TASK STATE TRANSITIONS
# ══════════════════════════════════════════════════════════════════════════


async def _transition_task_to_done(
    session: AsyncSession,
    task: Task,
    pr_number: int,
    pr_url: str,
) -> bool:
    """Transition a task to 'done' status and move to the done column.

    Returns True if the task was transitioned, False if it was already done.
    """
    if task.status == "done":
        logger.debug(f"Task {task.id} already done, skipping transition")
        return False

    now = now_ms()
    old_status = task.status

    # Find the "done" column
    col_result = await session.execute(
        select(KanbanColumn)
        .where(KanbanColumn.project_id == task.project_id)
        .order_by(KanbanColumn.position)
    )
    done_col = None
    for col in col_result.scalars().all():
        statuses = json.loads(col.task_statuses) if col.task_statuses else []
        if "done" in statuses:
            done_col = col
            break

    # Update task status
    task.status = "done"
    task.completed_at = now
    task.updated_at = now
    if done_col:
        task.column_id = done_col.id

    # Store merge info in metadata
    try:
        meta = json.loads(task.task_metadata) if task.task_metadata else {}
    except (json.JSONDecodeError, TypeError):
        meta = {}
    meta["pr_merged"] = True
    meta["pr_merged_at"] = now
    meta.setdefault("transition_notes", []).append(
        {
            "from": old_status,
            "to": "done",
            "note": f"Auto-completed: PR #{pr_number} merged",
            "timestamp": now,
            "source": "pr_lifecycle",
        }
    )
    task.task_metadata = json.dumps(meta)

    await session.commit()

    logger.info(
        f"Task {task.id} auto-transitioned to done "
        f"(was {old_status}, PR #{pr_number} merged)"
    )
    return True


# ══════════════════════════════════════════════════════════════════════════
# EVENT PUBLISHING
# ══════════════════════════════════════════════════════════════════════════


async def _publish_global_event(event_type: str, data: dict):
    """Publish event to global Redis stream."""
    if dependencies.redis_client:
        try:
            event = {"type": event_type, **data, "timestamp": now_ms()}
            await dependencies.redis_client.xadd(
                "djinnbot:events:global", {"data": json.dumps(event)}
            )
        except Exception:
            pass  # Best effort


# ══════════════════════════════════════════════════════════════════════════
# MAIN HANDLER
# ══════════════════════════════════════════════════════════════════════════


async def handle_pr_event(payload: Dict[str, Any]) -> Optional[str]:
    """Handle a pull_request webhook event for autonomous loop closure.

    Called from the webhook listener for pull_request events.
    Returns a description of what was done, or None if no action taken.

    Handles:
    - pull_request.closed + merged=True → task → done + worktree cleanup
    """
    action = payload.get("action")
    pr = payload.get("pull_request", {})

    if not pr:
        return None

    # ── PR opened → trigger Finn for architecture review ─────────────────
    # Finn reviews first. After he approves and transitions the task to
    # "test", the TRANSITION_TRIGGERS mechanism in transition_task will
    # automatically wake Chieko for QA. This ensures sequential review:
    # architecture first, then testing.
    if action == "opened" or action == "ready_for_review":
        head_branch = pr.get("head", {}).get("ref", "")
        # Only trigger for task branches (not random PRs)
        if head_branch.startswith("feat/"):
            pr_number = pr.get("number")
            pr_title = pr.get("title", "")
            pr_url = pr.get("html_url", "")

            if dependencies.redis_client:
                try:
                    event = {
                        "type": "PULSE_TRIGGERED",
                        "agentId": "finn",
                        "source": "pr_lifecycle",
                        "context": (
                            f"PR #{pr_number} ready for review: {pr_title} ({pr_url})"
                        ),
                        "timestamp": now_ms(),
                    }
                    await dependencies.redis_client.xadd(
                        "djinnbot:events:global",
                        {"data": json.dumps(event)},
                    )
                    logger.info(
                        f"Triggered Finn review pulse for PR #{pr_number} "
                        f"({head_branch})"
                    )
                except Exception as e:
                    logger.error(f"Failed to trigger Finn pulse: {e}")

            return f"PR #{pr_number} opened → Finn review pulse triggered"

    # Only handle closed PRs for the auto-complete flow
    if action != "closed":
        return None

    merged = pr.get("merged", False)
    if not merged:
        # PR closed without merge — could optionally move task back
        # For now, do nothing (agent can handle on next pulse)
        return None

    # ── PR was merged — find and complete the linked task ──────────────

    head_branch = pr.get("head", {}).get("ref", "")
    pr_number = pr.get("number")
    pr_url = pr.get("html_url", "")
    repo_full_name = payload.get("repository", {}).get("full_name", "")

    if not repo_full_name:
        return None

    async with AsyncSessionLocal() as session:
        # Find the project
        project_id = await _find_project_by_repo(session, repo_full_name)
        if not project_id:
            logger.debug(
                f"PR merge: no project found for repo {repo_full_name}, skipping"
            )
            return None

        # Find the task — try PR metadata first, then branch name
        task = await _find_task_by_pr_metadata(session, project_id, pr_number, pr_url)
        if not task:
            task = await _find_task_by_branch(session, project_id, head_branch)

        if not task:
            logger.debug(
                f"PR merge: no task found for PR #{pr_number} "
                f"(branch {head_branch}) in project {project_id}"
            )
            return None

        # Transition to done
        transitioned = await _transition_task_to_done(session, task, pr_number, pr_url)

        if not transitioned:
            return None

        # Determine the assigned agent for worktree cleanup
        agent_id = task.assigned_agent

        # Publish events
        await _publish_global_event(
            "TASK_STATUS_CHANGED",
            {
                "projectId": project_id,
                "taskId": task.id,
                "fromStatus": "review",
                "toStatus": "done",
                "note": f"Auto-completed: PR #{pr_number} merged",
                "source": "pr_lifecycle",
            },
        )

        # Request worktree cleanup if we know the assigned agent
        if agent_id:
            await _publish_global_event(
                "TASK_WORKSPACE_REMOVE_REQUESTED",
                {
                    "agentId": agent_id,
                    "projectId": project_id,
                    "taskId": task.id,
                },
            )
            logger.info(
                f"Published worktree cleanup for agent {agent_id}, task {task.id}"
            )

        return f"PR #{pr_number} merged → task {task.id} auto-completed" + (
            f", worktree cleanup requested for {agent_id}" if agent_id else ""
        )
