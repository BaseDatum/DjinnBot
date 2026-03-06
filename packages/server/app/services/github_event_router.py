"""GitHub webhook event router — maps events to agent assignments."""

import json
import uuid
import fnmatch
from typing import Optional, List, Dict, Any
from datetime import datetime, timezone

from app.db import get_db
from app import dependencies
from app.logging_config import get_logger

logger = get_logger(__name__)


# Event type mapping: GitHub event+action -> DjinnBot event type
EVENT_TYPE_MAP = {
    "issues": {
        "opened": "issue_new",
        "edited": "issue_updated",
        "closed": "issue_closed",
        "reopened": "issue_reopened",
        "assigned": "issue_assigned",
        "labeled": "issue_labeled",
    },
    "issue_comment": {
        "created": "issue_comment_new",
        "edited": "issue_comment_updated",
    },
    "pull_request": {
        "opened": "pr_new",
        "closed": "pr_closed",
        "reopened": "pr_reopened",
        "edited": "pr_updated",
        "review_requested": "pr_review_requested",
        "labeled": "pr_labeled",
    },
    "pull_request_review": {
        "submitted": "pr_review_submitted",
        "edited": "pr_review_edited",
    },
    "pull_request_review_comment": {
        "created": "pr_review_comment_new",
    },
    "push": {
        None: "push",  # No action field
    },
    "check_run": {
        "created": "check_run_created",
        "completed": "check_run_completed",
    },
    "check_suite": {
        "completed": "check_suite_completed",
    },
    "release": {
        "published": "release_published",
    },
    "workflow_run": {
        "completed": "workflow_completed",
    },
}


def get_djinnbot_event_type(
    github_event: str, action: Optional[str] = None
) -> Optional[str]:
    """Map GitHub event+action to DjinnBot event type."""
    event_map = EVENT_TYPE_MAP.get(github_event)
    if not event_map:
        return None
    return event_map.get(action)


async def process_webhook_event(event_id: str, payload: Dict[str, Any]) -> List[str]:
    """Process a webhook event and trigger assigned agents.

    Args:
        event_id: Webhook event ID from database
        payload: GitHub webhook payload

    Returns:
        List of trigger IDs created
    """
    # Extract event metadata
    action = payload.get("action")
    repository = payload.get("repository", {})
    repo_full_name = repository.get("full_name")
    sender = payload.get("sender", {})
    sender_login = sender.get("login")

    if not repo_full_name:
        logger.warning(f"No repository in webhook {event_id}")
        return []

    # Find project by repository URL
    async with get_db() as db:
        cursor = await db.execute(
            "SELECT id, name FROM projects WHERE repository = ? OR repository = ?",
            (
                f"https://github.com/{repo_full_name}",
                f"git@github.com:{repo_full_name}.git",
            ),
        )
        project_row = await cursor.fetchone()

        if not project_row:
            logger.warning(f"No project found for repository {repo_full_name}")
            return []

        project_id = project_row["id"]
        project_name = project_row["name"]

    # Get webhook event details
    async with get_db() as db:
        cursor = await db.execute(
            "SELECT event_type, action FROM webhook_events WHERE id = ?", (event_id,)
        )
        event_row = await cursor.fetchone()

        if not event_row:
            return []

        event_type = event_row["event_type"]
        event_action = event_row["action"]

    # Find matching agent assignments
    logger.debug(
        f"Routing event {event_id}: {event_type}.{event_action} for project {project_name}"
    )
    assignments = await find_matching_assignments(
        project_id=project_id,
        event_type=event_type,
        event_action=event_action,
        payload=payload,
    )

    if not assignments:
        logger.info(
            f"No agents assigned for {event_type}.{event_action} in project {project_name}"
        )
        return []

    # Trigger agents
    trigger_ids = []
    for assignment in assignments:
        trigger_id = await trigger_agent(
            assignment=assignment,
            webhook_event_id=event_id,
            project_id=project_id,
            payload=payload,
        )
        trigger_ids.append(trigger_id)

    logger.info(
        f"Triggered {len(trigger_ids)} agents for {event_type}.{event_action} in {project_name}"
    )
    return trigger_ids


async def find_matching_assignments(
    project_id: str,
    event_type: str,
    event_action: Optional[str],
    payload: Dict[str, Any],
) -> List[Dict[str, Any]]:
    """Find agent assignments matching event and filters."""
    async with get_db() as db:
        # Query assignments for this project and event type
        query = """
            SELECT * FROM project_github_agents
            WHERE project_id = ? AND event_type = ?
            AND (event_action IS NULL OR event_action = ?)
        """
        cursor = await db.execute(query, (project_id, event_type, event_action))
        rows = await cursor.fetchall()

        if not rows:
            return []

        logger.debug(
            f"Found {len(rows)} agent assignments for {event_type}.{event_action}"
        )

        matched = []
        for row in rows:
            assignment = dict(row)

            # Apply filters
            if not check_filters(assignment, payload):
                logger.debug(f"Agent {assignment.get('id')} failed filter check")
                continue

            matched.append(assignment)

        logger.debug(f"Matched {len(matched)} agents after filters")
        return matched


def check_filters(assignment: Dict[str, Any], payload: Dict[str, Any]) -> bool:
    """Check if webhook payload matches assignment filters."""
    # Label filter
    if assignment.get("filter_labels"):
        try:
            filter_labels = json.loads(assignment["filter_labels"])
            if filter_labels:
                issue_or_pr = payload.get("issue") or payload.get("pull_request")
                if not issue_or_pr:
                    return False  # No labels to check

                event_labels = {
                    label["name"] for label in issue_or_pr.get("labels", [])
                }
                if not any(label in event_labels for label in filter_labels):
                    return False  # No matching labels
        except (json.JSONDecodeError, KeyError):
            pass

    # File pattern filter (for PRs and pushes)
    if assignment.get("filter_file_patterns"):
        try:
            filter_patterns = json.loads(assignment["filter_file_patterns"])
            if filter_patterns:
                changed_files = extract_changed_files(payload)
                if not changed_files:
                    return False  # No files to check

                if not any(
                    fnmatch.fnmatch(file, pattern)
                    for file in changed_files
                    for pattern in filter_patterns
                ):
                    return False  # No matching files
        except (json.JSONDecodeError, KeyError):
            pass

    # Author filter
    if assignment.get("filter_authors"):
        try:
            filter_authors = json.loads(assignment["filter_authors"])
            if filter_authors:
                sender = payload.get("sender", {})
                sender_login = sender.get("login")

                # Check if sender matches filter (inclusive or exclusive)
                # If filter starts with "!", exclude that author
                has_positive_filter = any(not f.startswith("!") for f in filter_authors)

                for author_filter in filter_authors:
                    if author_filter.startswith("!"):
                        # Exclude: if sender matches, filter fails
                        if sender_login == author_filter[1:]:
                            return False
                    else:
                        # Include: sender must match at least one positive filter
                        if sender_login == author_filter:
                            has_positive_filter = False  # Found a match, mark it
                            break

                # If there were positive filters and none matched, fail
                if has_positive_filter:
                    return False
        except (json.JSONDecodeError, KeyError):
            pass

    return True


def extract_changed_files(payload: Dict[str, Any]) -> List[str]:
    """Extract list of changed files from webhook payload."""
    files = []

    # Pull request files - note: webhook doesn't include files list
    # Would need to fetch via GitHub API
    if "pull_request" in payload:
        # TODO: Fetch files via GitHub API
        return []

    # Push commits
    if "commits" in payload:
        for commit in payload["commits"]:
            files.extend(commit.get("added", []))
            files.extend(commit.get("modified", []))
            files.extend(commit.get("removed", []))

    return files


async def trigger_agent(
    assignment: Dict[str, Any],
    webhook_event_id: str,
    project_id: str,
    payload: Dict[str, Any],
) -> str:
    """Trigger an agent based on webhook event."""
    agent_id = assignment["agent_id"]
    auto_respond = bool(assignment["auto_respond"])

    trigger_id = str(uuid.uuid4())
    triggered_at = int(datetime.now(timezone.utc).timestamp())

    # Build trigger reason
    event_type = assignment["event_type"]
    event_action = assignment.get("event_action")
    reason = f"GitHub event: {event_type}"
    if event_action:
        reason += f".{event_action}"

    # Extract relevant context
    issue_or_pr = payload.get("issue") or payload.get("pull_request")
    if issue_or_pr:
        reason += f" - {issue_or_pr.get('title', 'Untitled')}"

    logger.debug(
        f"Triggering agent {agent_id} (auto_respond={auto_respond}): {reason[:60]}..."
    )

    async with get_db() as db:
        if auto_respond:
            # Trigger agent session immediately
            session_id = await start_agent_session(
                agent_id=agent_id,
                project_id=project_id,
                webhook_event_id=webhook_event_id,
                payload=payload,
            )

            await db.execute(
                """
                INSERT INTO github_agent_triggers (
                    id, agent_assignment_id, webhook_event_id, project_id,
                    agent_id, event_type, event_action, repository_full_name,
                    trigger_reason, session_id, status, triggered_at
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
                (
                    trigger_id,
                    assignment["id"],
                    webhook_event_id,
                    project_id,
                    agent_id,
                    event_type,
                    event_action,
                    payload.get("repository", {}).get("full_name"),
                    reason,
                    session_id,
                    "running",
                    triggered_at,
                ),
            )

            logger.info(f"Started agent session {session_id} for {agent_id}")
        else:
            # Create task for review
            task_id = await create_agent_task(
                agent_id=agent_id,
                project_id=project_id,
                webhook_event_id=webhook_event_id,
                payload=payload,
                reason=reason,
            )

            await db.execute(
                """
                INSERT INTO github_agent_triggers (
                    id, agent_assignment_id, webhook_event_id, project_id,
                    agent_id, event_type, event_action, repository_full_name,
                    trigger_reason, task_id, status, triggered_at
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
                (
                    trigger_id,
                    assignment["id"],
                    webhook_event_id,
                    project_id,
                    agent_id,
                    event_type,
                    event_action,
                    payload.get("repository", {}).get("full_name"),
                    reason,
                    task_id,
                    "pending",
                    triggered_at,
                ),
            )

            logger.info(f"Created task {task_id} for {agent_id}")

        await db.commit()

    return trigger_id


async def start_agent_session(
    agent_id: str, project_id: str, webhook_event_id: str, payload: Dict[str, Any]
) -> str:
    """Start an agent session by triggering a pulse for the agent.

    Publishes a PULSE_TRIGGERED event to the engine's global stream.
    The engine already handles PULSE_TRIGGERED events and will wake
    the agent with the relevant context.
    """
    session_id = str(uuid.uuid4())

    logger.info(
        f"Triggering pulse for agent {agent_id} "
        f"(project {project_id}, webhook {webhook_event_id})"
    )

    # Build context summary for the agent's inbox
    context = build_agent_context(payload)
    context_summary = ""
    if "pull_request" in context:
        pr = context["pull_request"]
        context_summary = (
            f"PR #{pr.get('number')}: {pr.get('title')} "
            f"({pr.get('head')} → {pr.get('base')})"
        )
    elif "issue" in context:
        issue = context["issue"]
        context_summary = f"Issue #{issue.get('number')}: {issue.get('title')}"

    # Publish pulse trigger to the engine's global event stream
    if dependencies.redis_client:
        try:
            event = {
                "type": "PULSE_TRIGGERED",
                "agentId": agent_id,
                "projectId": project_id,
                "source": "github_webhook",
                "webhookEventId": webhook_event_id,
                "context": context_summary,
                "timestamp": int(datetime.now(timezone.utc).timestamp() * 1000),
            }
            await dependencies.redis_client.xadd(
                "djinnbot:events:global", {"data": json.dumps(event)}
            )
            logger.info(
                f"Published PULSE_TRIGGERED for {agent_id}: {context_summary[:60]}"
            )
        except Exception as e:
            logger.error(f"Failed to trigger pulse for {agent_id}: {e}")
    else:
        logger.warning(f"Redis not available — cannot trigger pulse for {agent_id}")

    return session_id


async def create_agent_task(
    agent_id: str,
    project_id: str,
    webhook_event_id: str,
    payload: Dict[str, Any],
    reason: str,
) -> str:
    """Create a task for agent to handle webhook event."""
    task_id = str(uuid.uuid4())
    created_at = int(datetime.now(timezone.utc).timestamp())

    # Build task description
    description = build_task_description(payload)

    logger.debug(f"Creating task for agent {agent_id}: {reason[:50]}...")

    # Get default column for project
    async with get_db() as db:
        cursor = await db.execute(
            "SELECT id FROM kanban_columns WHERE project_id = ? ORDER BY position LIMIT 1",
            (project_id,),
        )
        column_row = await cursor.fetchone()
        column_id = column_row["id"] if column_row else "default"

        await db.execute(
            """
            INSERT INTO tasks (
                id, project_id, title, description, status,
                created_at, updated_at, metadata, assigned_agent,
                column_id, column_position
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        """,
            (
                task_id,
                project_id,
                reason,
                description,
                "pending",
                created_at,
                created_at,
                json.dumps(
                    {
                        "source": "github_webhook",
                        "webhook_event_id": webhook_event_id,
                        "agent_id": agent_id,
                    }
                ),
                agent_id,
                column_id,
                0,
            ),
        )
        await db.commit()

    # Publish task created event
    if dependencies.redis_client:
        try:
            await dependencies.redis_client.publish(
                f"djinnbot:projects:{project_id}:tasks",
                json.dumps(
                    {
                        "type": "TASK_CREATED",
                        "task_id": task_id,
                        "source": "github_webhook",
                    }
                ),
            )
        except Exception as e:
            logger.error(f"Failed to publish task created event: {e}", exc_info=True)

    return task_id


def build_agent_context(payload: Dict[str, Any]) -> Dict[str, Any]:
    """Build context object for agent session from webhook payload."""
    context = {
        "source": "github_webhook",
        "repository": payload.get("repository", {}).get("full_name"),
    }

    # Issue context
    if "issue" in payload:
        issue = payload["issue"]
        context["issue"] = {
            "number": issue.get("number"),
            "title": issue.get("title"),
            "body": issue.get("body"),
            "url": issue.get("html_url"),
            "labels": [label["name"] for label in issue.get("labels", [])],
            "assignees": [assignee["login"] for assignee in issue.get("assignees", [])],
        }

    # Pull request context
    if "pull_request" in payload:
        pr = payload["pull_request"]
        context["pull_request"] = {
            "number": pr.get("number"),
            "title": pr.get("title"),
            "body": pr.get("body"),
            "url": pr.get("html_url"),
            "head": pr.get("head", {}).get("ref"),
            "base": pr.get("base", {}).get("ref"),
            "labels": [label["name"] for label in pr.get("labels", [])],
        }

    # Push context
    if "commits" in payload:
        context["push"] = {
            "ref": payload.get("ref"),
            "before": payload.get("before"),
            "after": payload.get("after"),
            "commits": [
                {
                    "sha": commit["id"][:7],
                    "message": commit["message"],
                    "author": commit["author"]["name"],
                    "url": commit["url"],
                }
                for commit in payload["commits"]
            ],
        }

    return context


def build_task_description(payload: Dict[str, Any]) -> str:
    """Build human-readable task description from webhook payload."""
    description = ""

    # Issue
    if "issue" in payload:
        issue = payload["issue"]
        description = f"**Issue #{issue.get('number')}**: {issue.get('title')}\n\n"
        description += f"{issue.get('body', '')}\n\n"
        description += f"[View on GitHub]({issue.get('html_url')})"

    # Pull request
    elif "pull_request" in payload:
        pr = payload["pull_request"]
        description = f"**PR #{pr.get('number')}**: {pr.get('title')}\n\n"
        description += f"{pr.get('body', '')}\n\n"
        description += f"[View on GitHub]({pr.get('html_url')})"

    # Push
    elif "commits" in payload:
        ref = payload.get("ref", "").replace("refs/heads/", "")
        commits = payload["commits"]
        description = f"**Push to {ref}** ({len(commits)} commits)\n\n"
        for commit in commits[:5]:  # Show first 5 commits
            sha = commit["id"][:7]
            message = commit["message"].split("\n")[0]
            description += f"- `{sha}` {message}\n"
        if len(commits) > 5:
            description += f"\n...and {len(commits) - 5} more commits"

    return description or "GitHub webhook event"
