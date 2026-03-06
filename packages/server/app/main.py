from fastapi import FastAPI, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from contextlib import asynccontextmanager
import redis.asyncio as redis
import os
import json
import asyncio
from datetime import datetime, timezone
from sqlalchemy import text, select, update
from app.models import Run, Task, Step, WebhookEvent

from app import dependencies
from app.logging_config import setup_logging, get_logger

logger = get_logger(__name__)
from app.database import init_db_engine, close_db_engine
from app.migration_check import ensure_migrations
from app.routers import (
    pipelines,
    runs,
    steps,
    events,
    agents,
    memory,
    projects,
    workspaces,
    sandbox,
    queue,
    inbox,
    lifecycle,
    settings,
    github_webhooks,
    github,
    github_agents,
    sessions,
    chat,
    chat_sessions,
    pulses,
    onboarding,
    skills,
)
from app.routers import channels
from app.routers import secrets
from app.routers import mcp
from app.routers import agent_tools
from app.routers import agent_messaging_permissions
from app.routers import browser_cookies
from app.routers import attachments
from app.routers import documents
from app.routers import auth as auth_router
from app.routers import users as users_router
from app.routers import admin as admin_router
from app.routers import waitlist as waitlist_router
from app.routers import updates as updates_router
from app.routers import pulse_routines
from app.routers import llm_calls
from app.routers import user_usage
from app.routers import slack as slack_router
from app.routers import discord as discord_router
from app.routers import signal as signal_router
from app.routers import whatsapp as whatsapp_router
from app.routers import telegram as telegram_router
from app.routers import spawn_executor as spawn_executor_router
from app.routers import swarm_executor as swarm_executor_router
from app.routers import try_approaches as try_approaches_router
from app.routers import run_history as run_history_router
from app.routers import ingest as ingest_router
from app.routers import memory_scores as memory_scores_router
from app.routers import project_templates as project_templates_router
from app.routers import workflow_policies as workflow_policies_router
from app.routers import tts as tts_router
from app.routers import resolve as resolve_router


async def _handle_task_run_event(run_id: str, event_type: str):
    """Handle RUN_COMPLETE/RUN_FAILED for task-linked runs."""
    from app.database import AsyncSessionLocal

    async with AsyncSessionLocal() as session:
        try:
            result = await session.execute(select(Task).where(Task.run_id == run_id))
            task = result.scalar_one_or_none()
            if not task:
                return False

            from app.routers.projects import task_run_completed

            run_status = "completed" if event_type == "RUN_COMPLETE" else "failed"
            # Pass session explicitly instead of relying on Depends()
            await task_run_completed(
                task.project_id, task.id, run_id, run_status, session
            )
            await session.commit()
            logger.info(f"Task {task.id} updated to {run_status} (run {run_id})")
            return True
        except Exception:
            await session.rollback()
            raise


async def _handle_planning_run_complete(run_id: str):
    """Handle completed planning runs — auto-import tasks and reflow statuses.

    Supports two pipeline types:
    - Structured output pipelines (planning): bulk-imports tasks from JSON outputs.
    - Agentic pipelines (planning-agentic): tasks already created via tool calls,
      only needs post-planning status reflow.

    After import/completion, runs reflow_task_statuses_after_planning to move
    blocked tasks to backlog (tasks are created before deps are wired).
    """
    from app.database import AsyncSessionLocal
    from app.models.run import Output

    async with AsyncSessionLocal() as session:
        try:
            result = await session.execute(select(Run).where(Run.id == run_id))
            run = result.scalar_one_or_none()
            if not run or not run.human_context:
                return

            try:
                context = json.loads(run.human_context)
            except (json.JSONDecodeError, TypeError):
                return

            if not context.get("planning_run"):
                return

            project_id = context.get("project_id")
            if not project_id:
                logger.warning(f"Planning run {run_id}: no project_id in context")
                return

            pipeline_id = context.get("pipeline_id", "planning")

            # ── Agentic pipeline: tasks already created via tool calls ──
            # Only need to run post-planning reflow to fix statuses.
            if pipeline_id == "planning-agentic":
                from app.routers.projects.planning import (
                    reflow_task_statuses_after_planning,
                )

                reflow_result = await reflow_task_statuses_after_planning(
                    project_id, session
                )
                logger.info(
                    f"Planning run {run_id} (agentic): reflow moved "
                    f"{reflow_result.get('moved', 0)} tasks to backlog"
                )

                # Publish completion event
                if dependencies.redis_client:
                    event = {
                        "type": "PROJECT_PLANNING_COMPLETED",
                        "projectId": project_id,
                        "runId": run_id,
                        "pipeline": "planning-agentic",
                        "timestamp": int(datetime.now(timezone.utc).timestamp() * 1000),
                    }
                    await dependencies.redis_client.xadd(
                        "djinnbot:events:global", {"data": json.dumps(event)}
                    )
                return

            # ── Structured output pipeline: bulk-import from JSON outputs ──
            # Read outputs from the Output table (written per-key by the engine via
            # setOutput). The run.outputs column may still be "{}" due to a race: the
            # RUN_COMPLETE event is published immediately after updateRun() is called,
            # but the PATCH /api/runs/{id} HTTP request may not yet be committed.
            outputs_result = await session.execute(
                select(Output).where(Output.run_id == run_id)
            )
            outputs = {o.key: o.value for o in outputs_result.scalars().all()}

            # Fall back to run.outputs if the Output table has nothing yet
            if not outputs and run.outputs:
                try:
                    outputs = json.loads(run.outputs)
                except (json.JSONDecodeError, TypeError):
                    outputs = {}

            tasks_json = outputs.get("validated_tasks_json") or outputs.get(
                "task_breakdown_json"
            )

            if not tasks_json:
                logger.warning(f"Planning run {run_id}: no tasks output")
                return

            parsed = (
                json.loads(tasks_json) if isinstance(tasks_json, str) else tasks_json
            )
            task_list = (
                parsed.get("tasks", parsed) if isinstance(parsed, dict) else parsed
            )

            if not isinstance(task_list, list) or len(task_list) == 0:
                logger.warning(f"Planning run {run_id}: empty task list")
                return

            from app.routers.projects import (
                bulk_import_tasks,
                bulk_import_subtasks,
                BulkImportTasksRequest,
            )

            # Pass session explicitly instead of relying on Depends()
            result = await bulk_import_tasks(
                project_id, BulkImportTasksRequest(tasks=task_list), session
            )
            logger.info(
                f"Planning run {run_id}: imported {result.get('tasks_created', 0)} tasks"
            )

            # Import subtasks if present
            parent_title_to_id = result.get("title_to_id", {})
            subtasks_json = outputs.get("final_subtasks_json") or outputs.get(
                "subtask_breakdown_json"
            )
            if subtasks_json and parent_title_to_id:
                parsed_subtasks = (
                    json.loads(subtasks_json)
                    if isinstance(subtasks_json, str)
                    else subtasks_json
                )
                subtask_list = (
                    parsed_subtasks.get("subtasks", [])
                    if isinstance(parsed_subtasks, dict)
                    else parsed_subtasks
                )

                if subtask_list:
                    subtask_result = await bulk_import_subtasks(
                        project_id, parent_title_to_id, subtask_list, session
                    )
                    logger.info(
                        f"Planning run {run_id}: imported {subtask_result.get('subtasks_created', 0)} subtasks"
                    )

            await session.commit()

            # Run post-planning reflow for structured pipelines too
            from app.routers.projects.planning import (
                reflow_task_statuses_after_planning,
            )

            await reflow_task_statuses_after_planning(project_id, session)

            # Publish event after successful commit
            if dependencies.redis_client:
                event = {
                    "type": "PROJECT_PLANNING_COMPLETED",
                    "projectId": project_id,
                    "runId": run_id,
                    "tasksCreated": result.get("tasks_created", 0),
                    "timestamp": int(datetime.now(timezone.utc).timestamp() * 1000),
                }
                await dependencies.redis_client.xadd(
                    "djinnbot:events:global", {"data": json.dumps(event)}
                )
        except Exception:
            await session.rollback()
            raise


async def _run_completion_listener():
    """Background task: listen for run completion events and update linked tasks."""
    from app.database import AsyncSessionLocal

    last_id = "$"
    while True:
        try:
            if not dependencies.redis_client:
                await asyncio.sleep(5)
                continue

            response = await dependencies.redis_client.xread(
                {"djinnbot:events:global": last_id}, count=10, block=5000
            )
            if not response:
                continue

            for stream_name, messages in response:
                for msg_id, msg_data in messages:
                    last_id = msg_id
                    try:
                        data = json.loads(msg_data.get("data", "{}"))
                        event_type = data.get("type")
                        run_id = data.get("runId")

                        if not event_type or not run_id:
                            continue

                        # Handle step-level events
                        if event_type == "STEP_STARTED":
                            step_id = data.get("stepId")
                            if step_id:
                                async with AsyncSessionLocal() as session:
                                    try:
                                        full_step_id = f"{run_id}_{step_id}"
                                        now = int(
                                            datetime.now(timezone.utc).timestamp()
                                            * 1000
                                        )
                                        await session.execute(
                                            update(Step)
                                            .where(Step.id == full_step_id)
                                            .values(status="running", started_at=now)
                                        )
                                        # Update run to 'running' if still 'pending'
                                        await session.execute(
                                            update(Run)
                                            .where(Run.id == run_id)
                                            .where(Run.status == "pending")
                                            .values(status="running", updated_at=now)
                                        )
                                        await session.commit()
                                    except Exception:
                                        await session.rollback()
                                        raise
                            continue

                        elif event_type == "STEP_COMPLETE":
                            step_id = data.get("stepId")
                            outputs = data.get("outputs", {})
                            if step_id:
                                async with AsyncSessionLocal() as session:
                                    try:
                                        full_step_id = f"{run_id}_{step_id}"
                                        now = int(
                                            datetime.now(timezone.utc).timestamp()
                                            * 1000
                                        )
                                        await session.execute(
                                            update(Step)
                                            .where(Step.id == full_step_id)
                                            .values(
                                                status="completed",
                                                outputs=json.dumps(outputs),
                                                completed_at=now,
                                            )
                                        )
                                        await session.commit()
                                    except Exception:
                                        await session.rollback()
                                        raise
                            continue

                        elif event_type == "STEP_FAILED":
                            step_id = data.get("stepId")
                            error = data.get("error", "")
                            if step_id:
                                async with AsyncSessionLocal() as session:
                                    try:
                                        full_step_id = f"{run_id}_{step_id}"
                                        now = int(
                                            datetime.now(timezone.utc).timestamp()
                                            * 1000
                                        )
                                        await session.execute(
                                            update(Step)
                                            .where(Step.id == full_step_id)
                                            .values(
                                                status="failed",
                                                error=error,
                                                completed_at=now,
                                            )
                                        )
                                        await session.commit()
                                    except Exception:
                                        await session.rollback()
                                        raise
                            continue

                        # Handle run-level events
                        if event_type not in ("RUN_COMPLETE", "RUN_FAILED"):
                            continue

                        # Try task-linked run first
                        handled = await _handle_task_run_event(run_id, event_type)

                        # If not a task run, check if it's a planning run
                        if not handled and event_type == "RUN_COMPLETE":
                            await _handle_planning_run_complete(run_id)

                    except Exception as e:
                        logger.error(
                            f"Error processing event {msg_id}: {e}", exc_info=True
                        )

        except Exception as e:
            logger.error(f"Stream error: {e}")
            await asyncio.sleep(2)


async def _github_webhook_listener():
    """Background task: listen for GitHub webhook events and route to agents."""
    from app.database import AsyncSessionLocal

    if not dependencies.redis_client:
        return

    pubsub = dependencies.redis_client.pubsub()
    await pubsub.subscribe("djinnbot:webhooks:github")

    logger.info("Listening for GitHub webhook events")

    try:
        async for message in pubsub.listen():
            if message["type"] != "message":
                continue

            try:
                data = json.loads(message["data"])
                event_id = data.get("event_id")

                if not event_id:
                    continue

                # Fetch full payload from database
                async with AsyncSessionLocal() as session:
                    try:
                        result = await session.execute(
                            select(WebhookEvent).where(WebhookEvent.id == event_id)
                        )
                        webhook_event = result.scalar_one_or_none()

                        if not webhook_event:
                            continue

                        payload = json.loads(webhook_event.payload)
                    except Exception:
                        await session.rollback()
                        raise

                # ── PR lifecycle automation (runs before agent routing) ────────
                # Handles PR merge → auto-complete task → worktree cleanup
                # without requiring an agent session.
                event_type = data.get("event_type")
                if event_type == "pull_request":
                    from app.services.pr_lifecycle import handle_pr_event

                    try:
                        result = await handle_pr_event(payload)
                        if result:
                            logger.info(f"PR lifecycle: {result}")
                    except Exception as pr_err:
                        logger.error(
                            f"PR lifecycle handler error: {pr_err}",
                            exc_info=True,
                        )

                # Process event through agent assignment router
                from app.services.github_event_router import process_webhook_event

                await process_webhook_event(event_id, payload)

                # Mark event as processed
                async with AsyncSessionLocal() as session:
                    try:
                        await session.execute(
                            update(WebhookEvent)
                            .where(WebhookEvent.id == event_id)
                            .values(
                                processed=1,
                                processed_at=int(
                                    datetime.now(timezone.utc).timestamp()
                                ),
                            )
                        )
                        await session.commit()
                    except Exception:
                        await session.rollback()
                        raise

            except Exception as e:
                logger.error(f"Error processing webhook: {e}", exc_info=True)

                # Mark event as failed
                try:
                    async with AsyncSessionLocal() as session:
                        try:
                            await session.execute(
                                update(WebhookEvent)
                                .where(WebhookEvent.id == event_id)
                                .values(processing_error=str(e))
                            )
                            await session.commit()
                        except Exception:
                            await session.rollback()
                            raise
                except Exception:
                    pass

    except Exception as e:
        logger.critical(f"Fatal error in webhook listener: {e}", exc_info=True)


@asynccontextmanager
async def lifespan(app: FastAPI):
    """Manage application lifespan - connect/disconnect Redis and database."""
    # Initialize logging first
    setup_logging()

    # Validate auth configuration
    from app.auth.config import auth_settings

    try:
        auth_settings.validate()
        if auth_settings.enabled:
            logger.info("Authentication is ENABLED")
        else:
            logger.warning("Authentication is DISABLED (AUTH_ENABLED=false)")
    except RuntimeError as e:
        logger.critical(f"Auth configuration error: {e}")
        raise

    redis_url = os.getenv("REDIS_URL", "redis://localhost:6379")

    # Initialize Redis with retry/reconnect settings
    dependencies.redis_client = redis.from_url(
        redis_url,
        decode_responses=True,
        socket_connect_timeout=5,
        socket_keepalive=True,
        retry_on_timeout=True,
        health_check_interval=30,
    )

    try:
        await dependencies.redis_client.ping()
        logger.info(f"Connected to Redis at {redis_url}")
    except Exception as e:
        logger.warning(f"Could not connect to Redis: {e}")
        logger.warning("API will continue with degraded event streaming capabilities")

    # Initialize async database engine
    try:
        await init_db_engine()
        logger.info("Database engine initialized")
    except Exception as e:
        logger.critical(f"Could not initialize database engine: {e}")
        raise

    # Verify database migrations are applied
    try:
        ensure_migrations()
    except Exception as e:
        logger.critical(f"Migration check failed: {e}")
        raise

    # Validate GitHub App configuration (non-blocking)
    try:
        from app.routers.github import _validate_github_config
        from app.database import AsyncSessionLocal

        async with AsyncSessionLocal() as session:
            validation_result = await _validate_github_config(session)
        if validation_result["healthy"]:
            logger.info(f"GitHub App: {validation_result['message']}")
        else:
            logger.warning(
                f"GitHub App configuration issue: {validation_result['message']}"
            )
            logger.warning("GitHub integration features will be unavailable")
    except Exception as e:
        logger.warning(f"Could not validate GitHub App configuration: {e}")
        logger.warning("GitHub integration features will be unavailable")

    # Seed built-in project templates
    try:
        from app.routers.project_templates import seed_builtin_templates

        seed_result = await seed_builtin_templates()
        if seed_result.get("seeded"):
            logger.info(f"Project templates seeded: {', '.join(seed_result['seeded'])}")
    except Exception as e:
        logger.warning(f"Could not seed project templates: {e}")

    # Auto-import skills from SKILLS_DIR into the database
    try:
        from app.routers.skills import sync_skills_from_disk

        result = await sync_skills_from_disk()
        if result["created"]:
            logger.info(f"Skills auto-imported: {', '.join(result['created'])}")
        if result["updated"]:
            logger.info(f"Skills updated from disk: {', '.join(result['updated'])}")
        if result["errors"]:
            for err in result["errors"]:
                logger.warning(f"Skill import error: {err}")
        total = (
            len(result["created"]) + len(result["updated"]) + len(result["unchanged"])
        )
        if total > 0:
            logger.info(
                f"Skills disk sync complete: {len(result['created'])} created, "
                f"{len(result['updated'])} updated, {len(result['unchanged'])} unchanged"
            )
    except Exception as e:
        logger.warning(f"Could not auto-import skills from disk: {e}")

    # Pre-load faster-whisper model in background so the first voice note
    # doesn't pay the download + load cost.  Model is cached on JuiceFS.
    async def _preload_whisper():
        try:
            from app.services.audio_transcription import _get_model

            await asyncio.get_event_loop().run_in_executor(None, _get_model)
        except Exception as e:
            logger.warning(f"Whisper model preload failed (non-fatal): {e}")

    asyncio.create_task(_preload_whisper())

    # Start background run completion listener
    listener_task = asyncio.create_task(_run_completion_listener())
    logger.info("Started run completion listener")

    # Start background update checker
    from app.routers.updates import periodic_update_checker

    update_checker_task = asyncio.create_task(periodic_update_checker())
    logger.info("Started periodic update checker")

    # Start GitHub webhook listener
    github_listener_task = None
    if dependencies.redis_client:
        github_listener_task = asyncio.create_task(_github_webhook_listener())
        logger.info("Started GitHub webhook listener")

    yield

    # Cleanup
    listener_task.cancel()
    update_checker_task.cancel()
    if github_listener_task:
        github_listener_task.cancel()

    # Close async database engine
    try:
        await close_db_engine()
        logger.info("Database engine closed")
    except Exception as e:
        logger.error(f"Error closing database engine: {e}")

    if dependencies.redis_client:
        try:
            await dependencies.redis_client.close()
            logger.info("Disconnected from Redis")
        except Exception as e:
            logger.error(f"Error closing Redis connection: {e}")


app = FastAPI(
    title="DjinnBot API",
    version="0.1.0",
    description="API backend for DjinnBot - AI agent orchestration platform",
    lifespan=lifespan,
)

# CORS
# CORS_ORIGINS env var controls allowed origins.
#   "*"              → wildcard (allow any origin, credentials disabled)
#   unset / empty    → wildcard (same default behaviour)
#   "http://a,https://b" → explicit origin list (credentials enabled)
_cors_origins_env = os.getenv("CORS_ORIGINS", "*").strip()
if _cors_origins_env == "*":
    _cors_origins = ["*"]
    _cors_credentials = False
else:
    _cors_origins = [o.strip() for o in _cors_origins_env.split(",") if o.strip()]
    _cors_credentials = True

# Auth middleware — must be added BEFORE CORS so that CORS wraps it.
# Starlette middleware order is LIFO: last-added runs outermost.
# We need CORS to run first (outermost) so 401 responses still get CORS headers.
from app.auth.middleware import AuthMiddleware

app.add_middleware(AuthMiddleware)

app.add_middleware(
    CORSMiddleware,
    allow_origins=_cors_origins,
    allow_credentials=_cors_credentials,
    allow_methods=["*"],
    allow_headers=["*"],
)


# Global exception handler
@app.exception_handler(Exception)
async def global_exception_handler(request: Request, exc: Exception):
    """Catch unhandled exceptions and return proper JSON response."""
    error_detail = str(exc)
    error_type = type(exc).__name__

    # Log the full traceback
    logger.error(
        f"Unhandled exception in {request.method} {request.url.path}: {error_type}: {error_detail}",
        exc_info=True,
    )

    return JSONResponse(
        status_code=500,
        content={
            "detail": f"{error_type}: {error_detail}",
            "type": error_type,
            "path": str(request.url.path),
        },
    )


app.include_router(auth_router.router, prefix="/v1/auth", tags=["auth"])
app.include_router(pipelines.router, prefix="/v1/pipelines", tags=["pipelines"])
app.include_router(runs.router, prefix="/v1/runs", tags=["runs"])
app.include_router(steps.router, prefix="/v1/steps", tags=["steps"])
app.include_router(events.router, prefix="/v1/events", tags=["events"])
app.include_router(agents.router, prefix="/v1/agents", tags=["agents"])
app.include_router(lifecycle.router, prefix="/v1/agents", tags=["lifecycle"])
app.include_router(memory.router, prefix="/v1/memory", tags=["memory"])
app.include_router(projects.router, prefix="/v1/projects", tags=["projects"])
app.include_router(workspaces.router, prefix="/v1/workspaces", tags=["workspaces"])
app.include_router(sandbox.router, prefix="/v1/agents", tags=["sandbox"])
app.include_router(queue.router, prefix="/v1/agents", tags=["queue"])
app.include_router(inbox.router, prefix="/v1/agents", tags=["inbox"])
app.include_router(settings.router, prefix="/v1/settings", tags=["settings"])
app.include_router(github.router, prefix="/v1/github", tags=["github"])
app.include_router(github_agents.router, prefix="/v1", tags=["github-agents"])
app.include_router(github_webhooks.router, prefix="/v1/webhooks", tags=["webhooks"])
app.include_router(sessions.router, prefix="/v1", tags=["sessions"])
app.include_router(chat.router, prefix="/v1", tags=["chat"])
app.include_router(chat_sessions.router, prefix="/v1", tags=["chat-sessions"])
app.include_router(attachments.router, prefix="/v1", tags=["attachments"])
app.include_router(documents.router, prefix="/v1", tags=["documents"])
app.include_router(pulses.router, prefix="/v1/pulses", tags=["pulses"])
app.include_router(pulse_routines.router, prefix="/v1", tags=["pulse-routines"])
app.include_router(onboarding.router, prefix="/v1/onboarding", tags=["onboarding"])
app.include_router(skills.router, prefix="/v1/skills", tags=["skills"])
app.include_router(channels.router, prefix="/v1/agents", tags=["channels"])
app.include_router(agent_tools.router, prefix="/v1/agents", tags=["agent-tools"])
app.include_router(
    agent_messaging_permissions.router,
    prefix="/v1/agents",
    tags=["agent-messaging-permissions"],
)
app.include_router(secrets.router, prefix="/v1/secrets", tags=["secrets"])
app.include_router(mcp.router, prefix="/v1/mcp", tags=["mcp"])
app.include_router(
    browser_cookies.router, prefix="/v1/browser", tags=["browser-cookies"]
)
app.include_router(users_router.router, prefix="/v1/users", tags=["users"])
app.include_router(admin_router.router, prefix="/v1/admin", tags=["admin"])
app.include_router(llm_calls.router, prefix="/v1", tags=["llm-calls"])
app.include_router(user_usage.router, prefix="/v1", tags=["user-usage"])
app.include_router(waitlist_router.router, prefix="/v1/waitlist", tags=["waitlist"])
app.include_router(updates_router.router, prefix="/v1/system/updates", tags=["updates"])
app.include_router(slack_router.router, prefix="/v1/slack", tags=["slack"])
app.include_router(discord_router.router, prefix="/v1/discord", tags=["discord"])
app.include_router(signal_router.router, prefix="/v1/signal", tags=["signal"])
app.include_router(whatsapp_router.router, prefix="/v1/whatsapp", tags=["whatsapp"])
app.include_router(telegram_router.router, prefix="/v1/telegram", tags=["telegram"])
app.include_router(
    spawn_executor_router.router, prefix="/v1/internal", tags=["internal"]
)
app.include_router(
    swarm_executor_router.router, prefix="/v1/internal", tags=["internal"]
)
app.include_router(
    try_approaches_router.router, prefix="/v1/internal", tags=["internal"]
)
app.include_router(run_history_router.router, prefix="/v1/internal", tags=["internal"])
app.include_router(ingest_router.router, prefix="/v1/ingest", tags=["ingest"])
app.include_router(memory_scores_router.router, prefix="/v1", tags=["memory-scores"])
app.include_router(
    project_templates_router.router,
    prefix="/v1/project-templates",
    tags=["project-templates"],
)
app.include_router(
    workflow_policies_router.router,
    tags=["workflow-policies"],
)
app.include_router(tts_router.router, prefix="/v1", tags=["tts"])
app.include_router(resolve_router.router, prefix="/v1/resolve", tags=["resolve"])


@app.get("/v1/status")
async def status():
    """Get API health status."""
    redis_ok = False
    engine_version = None
    if dependencies.redis_client:
        try:
            redis_ok = await dependencies.redis_client.ping()
        except Exception:
            pass
        # Read engine version published via Redis
        try:
            engine_version = await dependencies.redis_client.get(
                "djinnbot:engine:version"
            )
        except Exception:
            pass

    # Count runs
    active_runs = 0
    total_pipelines = 0
    total_agents = 0

    try:
        from app.database import AsyncSessionLocal

        async with AsyncSessionLocal() as session:
            result = await session.execute(
                text("SELECT COUNT(*) FROM runs WHERE status = 'running'")
            )
            active_runs = result.scalar() or 0
    except Exception:
        pass

    # Count pipelines from filesystem
    pipelines_dir = os.getenv("PIPELINES_DIR", "./pipelines")
    if os.path.exists(pipelines_dir):
        total_pipelines = len(
            [f for f in os.listdir(pipelines_dir) if f.endswith((".yml", ".yaml"))]
        )

    # Count agents from filesystem (exclude dirs starting with '_' or '.')
    agents_dir = os.getenv("AGENTS_DIR", "./agents")
    if os.path.exists(agents_dir):
        total_agents = len(
            [
                d
                for d in os.listdir(agents_dir)
                if os.path.isdir(os.path.join(agents_dir, d))
                and not d.startswith("_")
                and not d.startswith(".")
            ]
        )

    # Check GitHub App status
    github_status = {"configured": False, "healthy": False}
    try:
        from app.database import AsyncSessionLocal
        from app.routers.github import _validate_github_config

        async with AsyncSessionLocal() as session:
            validation_result = await _validate_github_config(session)
            github_status["configured"] = True
            github_status["healthy"] = validation_result["healthy"]
    except Exception:
        pass

    # Version info — baked in at Docker build time, falls back to env or "dev"
    api_version = os.getenv("DJINNBOT_BUILD_VERSION", "dev")

    # Storage backend health (JuiceFS + RustFS)
    storage_status = None
    data_path = os.getenv("DJINN_DATA_PATH", "/jfs")
    try:
        jfs_mounted = os.path.ismount(data_path)
        # Also verify the mount is functional by checking readability
        if jfs_mounted:
            os.listdir(data_path)
        rustfs_healthy = False
        try:
            import httpx

            resp = httpx.get("http://rustfs:9000/health", timeout=3)
            rustfs_healthy = resp.status_code == 200
        except Exception:
            pass
        storage_status = {
            "juicefs_mounted": jfs_mounted,
            "rustfs_healthy": rustfs_healthy,
            "data_path": data_path,
            "juicefs_volume": os.getenv("JUICEFS_VOLUME_NAME", ""),
        }
    except Exception:
        storage_status = {
            "juicefs_mounted": False,
            "rustfs_healthy": False,
            "data_path": data_path,
        }

    return {
        "status": "ok",
        "version": api_version,
        "engine_version": engine_version or "unknown",
        "redis_connected": redis_ok,
        "storage": storage_status,
        "active_runs": active_runs,
        "total_pipelines": total_pipelines,
        "total_agents": total_agents,
        "github": github_status,
    }
