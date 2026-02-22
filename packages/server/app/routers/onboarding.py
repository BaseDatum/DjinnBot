"""Onboarding session API — agent-guided project creation.

The "Agent Guided" flow: the user is interviewed by a sequence of agents
(Stas → Jim → Eric → ...) who accumulate context and eventually create the
project with full shared-memory anchoring.

Flow:
1. POST /onboarding/sessions           — create session, start Stas container
2. POST /onboarding/sessions/{id}/message  — send message to current agent
3. POST /onboarding/sessions/{id}/handoff  — agent signals next agent (internal + user)
4. POST /onboarding/sessions/{id}/finalize — commit project, seal memories
5. GET  /onboarding/sessions/{id}      — fetch session state + messages
6. GET  /onboarding/sessions/{id}/stream — SSE stream (proxies the underlying chat session)
"""

import json
import uuid
import asyncio
from typing import Optional, List, Any
from fastapi import APIRouter, HTTPException, Depends, BackgroundTasks
from fastapi.responses import StreamingResponse
from pydantic import BaseModel
from sqlalchemy import select, desc, and_, delete
from sqlalchemy.ext.asyncio import AsyncSession

from app.database import get_async_session
from app.models.project import OnboardingSession, OnboardingMessage, Project
from app.models import KanbanColumn, Run
from app import dependencies
from app.logging_config import get_logger
from app.utils import gen_id, now_ms
from app.constants import DEFAULT_CHAT_MODEL
from app.routers.projects._common import DEFAULT_COLUMNS

logger = get_logger(__name__)
router = APIRouter()

# The first agent for every onboarding session
FIRST_AGENT_ID = "stas"

# Ordered fallback chain if agent lookup fails
AGENT_CHAIN = ["stas", "jim", "eric", "finn"]

# Agent display metadata (display name + emoji)
AGENT_META: dict[str, dict] = {
    "stas": {"name": "Stas", "emoji": "🚀"},
    "jim": {"name": "Jim", "emoji": "💼"},
    "eric": {"name": "Eric", "emoji": "📋"},
    "finn": {"name": "Finn", "emoji": "🏗️"},
    "yang": {"name": "Yang", "emoji": "⚙️"},
    "shigeo": {"name": "Shigeo", "emoji": "🎨"},
}


# ============================================================================
# Request / Response models
# ============================================================================


class CreateOnboardingSessionRequest(BaseModel):
    model: Optional[str] = DEFAULT_CHAT_MODEL


class SendOnboardingMessageRequest(BaseModel):
    message: str
    model: Optional[str] = None


class HandoffRequest(BaseModel):
    """Agent signals it wants to hand off to another agent.

    This is called by the agent runtime when it emits an onboarding_handoff
    tool result, OR can be triggered manually by the frontend.
    """

    next_agent_id: str
    # JSON blob of context gathered so far — merged into session.context
    context_update: Optional[dict] = None
    # Short summary the next agent will be greeted with
    summary: Optional[str] = None
    # The agent making the request — used as an idempotency guard.
    # If the current agent has already changed (handoff already succeeded),
    # a retry is detected and the endpoint returns 200 with status=already_handed_off.
    from_agent_id: Optional[str] = None
    # 2-4 conversational details the next agent uses to show continuity.
    # Stored in session context under "conversation_highlights" so the
    # next agent's system prompt supplement can reference them.
    conversation_highlights: Optional[List[str]] = None


class FinalizeRequest(BaseModel):
    """Finalize the session: create the project record and seal memories."""

    project_name: str
    description: Optional[str] = None
    repository: Optional[str] = None
    # The full accumulated context dict
    context: Optional[dict] = None


class OnboardingMessageResponse(BaseModel):
    id: str
    session_id: str
    role: str
    content: str
    agent_id: Optional[str]
    agent_name: Optional[str]
    agent_emoji: Optional[str]
    tool_calls: Optional[List[Any]]
    thinking: Optional[str]
    handoff_to_agent: Optional[str]
    created_at: int


class DiagramState(BaseModel):
    """The evolving Mermaid diagram built collaboratively during onboarding."""

    mermaid: str
    caption: Optional[str] = None
    last_agent_id: Optional[str] = None
    version: int = 1


class OnboardingSessionResponse(BaseModel):
    id: str
    status: str
    project_id: Optional[str]
    current_agent_id: str
    current_agent_name: str
    current_agent_emoji: str
    phase: str
    context: dict
    diagram_state: Optional[DiagramState] = None
    chat_session_id: Optional[str]
    model: str
    created_at: int
    updated_at: int
    completed_at: Optional[int]
    messages: List[OnboardingMessageResponse]


# ============================================================================
# Helpers
# ============================================================================


def _agent_meta(agent_id: str) -> tuple[str, str]:
    """Return (name, emoji) for an agent_id."""
    meta = AGENT_META.get(agent_id, {})
    return meta.get("name", agent_id.capitalize()), meta.get("emoji", "🤖")


def _serialize_message(msg: OnboardingMessage) -> OnboardingMessageResponse:
    tool_calls = None
    if msg.tool_calls:
        try:
            tool_calls = json.loads(msg.tool_calls)
        except Exception:
            pass
    return OnboardingMessageResponse(
        id=msg.id,
        session_id=msg.session_id,
        role=msg.role,
        content=msg.content,
        agent_id=msg.agent_id,
        agent_name=msg.agent_name,
        agent_emoji=msg.agent_emoji,
        tool_calls=tool_calls,
        thinking=msg.thinking,
        handoff_to_agent=msg.handoff_to_agent,
        created_at=msg.created_at,
    )


def _serialize_session(
    session: OnboardingSession,
    messages: Optional[List[OnboardingMessage]] = None,
) -> OnboardingSessionResponse:
    """Serialize an OnboardingSession to a response model.

    Pass ``messages`` explicitly to avoid triggering SQLAlchemy lazy-loading
    inside an async greenlet (MissingGreenlet). If not provided the function
    falls back to ``session.messages``, which is only safe when the ORM
    relationship has already been eagerly loaded by the caller.
    """
    name, emoji = _agent_meta(session.current_agent_id)
    ctx: dict = {}
    if session.context:
        try:
            ctx = json.loads(session.context)
        except Exception:
            pass
    # Parse diagram state
    diagram: Optional[DiagramState] = None
    if session.diagram_state:
        try:
            diagram = DiagramState(**json.loads(session.diagram_state))
        except Exception:
            pass

    msg_list = messages if messages is not None else (session.messages or [])
    return OnboardingSessionResponse(
        id=session.id,
        status=session.status,
        project_id=session.project_id,
        current_agent_id=session.current_agent_id,
        current_agent_name=name,
        current_agent_emoji=emoji,
        phase=session.phase,
        context=ctx,
        diagram_state=diagram,
        chat_session_id=session.chat_session_id,
        model=session.model,
        created_at=session.created_at,
        updated_at=session.updated_at,
        completed_at=session.completed_at,
        messages=[_serialize_message(m) for m in msg_list],
    )


async def _start_agent_container(
    agent_id: str,
    model: str,
    onboarding_session_id: str,
    greeting_message_id: Optional[str] = None,
    onboarding_context: Optional[dict] = None,
) -> str:
    """Signal the Engine to start a container for the given agent.

    Returns the chat_session_id.
    The container is a standard chat session but tagged with
    onboarding_session_id so the runtime injects onboarding context.

    If greeting_message_id is provided, the engine will use it as the
    currentMessageId for the proactive greeting turn, so the response is
    persisted to the DB when stepEnd fires.

    If onboarding_context is provided (for non-first agents), a compact
    context summary is injected as a system_prompt_supplement so the agent
    knows the project name and other already-confirmed facts without having
    to ask the user.
    """
    if not dependencies.redis_client:
        raise HTTPException(status_code=503, detail="Redis not available")

    now = now_ms()
    chat_session_id = f"onb_{agent_id}_{onboarding_session_id}_{now}"

    payload: dict = {
        "event": "chat:start",
        "session_id": chat_session_id,
        "agent_id": agent_id,
        "model": model,
        # Tag so the runtime knows to inject onboarding system prompt
        "onboarding_session_id": onboarding_session_id,
        "session_type": "onboarding",
    }
    if greeting_message_id:
        payload["greeting_message_id"] = greeting_message_id

    # Inject a compact context supplement so the agent knows what's already
    # confirmed — project name, goal, repo, etc. — without asking the user.
    if onboarding_context:
        ctx_lines = []
        field_labels = {
            "project_name": "Project name",
            "goal": "Goal",
            "repo": "Repository",
            "open_source": "Open source",
            "target_customer": "Target customer",
            "monetization": "Monetization model",
            "revenue_goal": "Revenue/success goal",
            "timeline": "Timeline",
            "v1_scope": "V1 scope",
            "tech_preferences": "Tech preferences",
            "summary": "Summary so far",
        }
        for key, label in field_labels.items():
            val = onboarding_context.get(key)
            if val:
                ctx_lines.append(f"- **{label}:** {val}")
        if ctx_lines:
            supplement = (
                "## ⚠️ Already Confirmed — DO NOT Ask the User Again\n\n"
                "The previous agents have already gathered the following information. "
                "Use it directly. Do NOT ask the user to repeat anything listed here:\n\n"
                + "\n".join(ctx_lines)
                + "\n\n"
                "Your first action MUST be to recall shared memories to get full details:\n"
                "```\n"
                'recall("project context", { scope: "shared" })\n'
                "```"
            )

            # Inject conversation highlights from the previous agent so the
            # greeting feels like a seamless continuation, not a cold restart.
            highlights = onboarding_context.get("conversation_highlights")
            if highlights and isinstance(highlights, list):
                supplement += (
                    "\n\n## Conversation Highlights from Previous Agent\n\n"
                    "The user specifically mentioned these things during the "
                    "previous phase. Reference 1-2 of them naturally in your "
                    "opening message to show you were listening:\n\n"
                    + "\n".join(f"- {h}" for h in highlights[:4])
                )

            payload["system_prompt_supplement"] = supplement

    await dependencies.redis_client.xadd(
        "djinnbot:events:chat_sessions",
        payload,
    )
    return chat_session_id


async def _stop_agent_container(chat_session_id: str, agent_id: str) -> None:
    """Signal the Engine to stop a container."""
    if not dependencies.redis_client:
        return
    try:
        await dependencies.redis_client.xadd(
            "djinnbot:events:chat_sessions",
            {
                "event": "chat:stop",
                "session_id": chat_session_id,
                "agent_id": agent_id,
            },
        )
    except Exception as e:
        logger.warning(f"Failed to stop agent container {chat_session_id}: {e}")


# ============================================================================
# Shared finalization helpers (used by both handoff-to-done and /finalize)
# ============================================================================


def _synthesize_project_vision(project_name: str, accumulated_ctx: dict) -> str:
    """Synthesize a structured Project Vision document from onboarding context.

    This becomes the single source of truth that every agent reads before
    starting work — via get_project_vision() in pulse routines and via
    {{project_vision}} template variable in pipeline steps.

    The vision document is designed to be:
    - Dense enough to give agents full context in ~500 words
    - Structured so agents can quickly find what they need
    - Editable by users in the dashboard at any time
    """
    sections = []
    sections.append(f"# Project Vision: {project_name}")
    sections.append("")

    # Goal / Purpose
    goal = accumulated_ctx.get("goal", "")
    if goal:
        sections.append("## Goal")
        sections.append(goal)
        sections.append("")

    # Target Customer
    target = accumulated_ctx.get("target_customer", "")
    if target:
        sections.append("## Target Customer")
        sections.append(target)
        sections.append("")

    # V1 Scope
    scope = accumulated_ctx.get("v1_scope", "")
    if scope:
        sections.append("## V1 Scope")
        sections.append(scope)
        sections.append("")

    # Technical Architecture / Preferences
    arch = accumulated_ctx.get("architecture_summary", "")
    tech = accumulated_ctx.get("tech_preferences", "")
    planning_ctx = accumulated_ctx.get("planning_context", "")
    if arch or tech or planning_ctx:
        sections.append("## Technical Architecture")
        if arch:
            sections.append(arch)
        if tech:
            sections.append(f"\n**Tech Preferences:** {tech}")
        if planning_ctx and not arch:
            # planning_context is Finn's detailed output — use it if no arch summary
            sections.append(planning_ctx)
        sections.append("")

    # Revenue / Business Model
    revenue = accumulated_ctx.get("revenue_goal", "")
    monetization = accumulated_ctx.get("monetization", "")
    if revenue or monetization:
        sections.append("## Business Model")
        if revenue:
            sections.append(f"**Revenue Goal:** {revenue}")
        if monetization:
            sections.append(f"**Monetization:** {monetization}")
        sections.append("")

    # Timeline
    timeline = accumulated_ctx.get("timeline", "")
    if timeline:
        sections.append("## Timeline")
        sections.append(timeline)
        sections.append("")

    # Repository
    repo = accumulated_ctx.get("repo", "")
    open_source = accumulated_ctx.get("open_source", "")
    if repo or open_source:
        sections.append("## Repository")
        if repo:
            sections.append(f"**Repository:** {repo}")
        if open_source:
            sections.append(f"**Open Source:** {open_source}")
        sections.append("")

    # Summary (catch-all from onboarding)
    summary = accumulated_ctx.get("summary", "")
    if summary and not goal:
        # Only include summary if we don't have a proper goal
        sections.append("## Summary")
        sections.append(summary)
        sections.append("")

    # If somehow we got very little context, at least note it
    if len(sections) <= 2:
        sections.append("## Summary")
        sections.append(
            f"Project '{project_name}' was created via onboarding. "
            "Additional details will be added as the project evolves."
        )
        sections.append("")

    sections.append("---")
    sections.append(
        "*This document is the single source of truth for the project. "
        "All agents read it before starting work. Edit it in the dashboard "
        "to update the project's direction.*"
    )

    return "\n".join(sections)


async def _create_project_with_columns(
    db: AsyncSession,
    project_name: str,
    description: str,
    repository: Optional[str],
    accumulated_ctx: dict,
    now: int,
) -> str:
    """Create a Project row and its default kanban columns. Returns project_id."""
    project_id = gen_id("proj_")

    # Synthesize the project vision from accumulated onboarding context
    vision = _synthesize_project_vision(project_name, accumulated_ctx)

    project = Project(
        id=project_id,
        name=project_name,
        description=description if isinstance(description, str) else "",
        status="active",
        repository=repository if isinstance(repository, str) else None,
        onboarding_context=json.dumps(accumulated_ctx),
        vision=vision,
        created_at=now,
        updated_at=now,
    )
    db.add(project)
    await db.flush()

    for col_def in DEFAULT_COLUMNS:
        col = KanbanColumn(
            id=gen_id("col_"),
            project_id=project_id,
            name=col_def["name"],
            position=col_def["position"],
            wip_limit=col_def.get("wip_limit"),
            task_statuses=json.dumps(col_def["task_statuses"]),
        )
        db.add(col)

    return project_id


async def _trigger_planning_pipeline(
    db: AsyncSession,
    project_id: str,
    project_name: str,
    description: str,
    accumulated_ctx: dict,
    session_id: str,
    now: int,
) -> Optional[str]:
    """Create a planning Run and dispatch it via Redis. Returns run_id or None."""
    planning_run_id: Optional[str] = None
    try:
        planning_run_id = str(uuid.uuid4())
        finn_planning_context: Optional[str] = accumulated_ctx.get("planning_context")  # type: ignore

        # Synthesize the vision document — used as the primary context for planning
        vision = _synthesize_project_vision(project_name, accumulated_ctx)

        if finn_planning_context:
            task_desc = f"Plan project: {project_name}\n\n{finn_planning_context}"
            additional_context_str = finn_planning_context
        else:
            ctx_parts = [f"Plan project: {project_name}"]
            for key, label in [
                ("goal", "Goal"),
                ("target_customer", "Target customer"),
                ("v1_scope", "V1 scope"),
                ("tech_preferences", "Tech preferences"),
                ("timeline", "Timeline"),
                ("architecture_summary", "Architecture"),
            ]:
                if accumulated_ctx.get(key):
                    ctx_parts.append(f"{label}: {accumulated_ctx[key]}")
            if description:
                ctx_parts.append(f"\n{description}")
            task_desc = "\n".join(ctx_parts)
            additional_context_str = finn_planning_context or json.dumps(
                accumulated_ctx
            )

        human_context = json.dumps(
            {
                "project_id": project_id,
                "project_name": project_name,
                "project_description": description
                if isinstance(description, str)
                else "",
                "additional_context": additional_context_str,
                "project_vision": vision,
                "planning_run": True,
                "onboarding_session_id": session_id,
            }
        )

        planning_run = Run(
            id=planning_run_id,
            pipeline_id="planning",
            task_description=task_desc,
            status="pending",
            outputs="{}",
            human_context=human_context,
            created_at=now,
            updated_at=now,
        )
        db.add(planning_run)
        await db.commit()

        if dependencies.redis_client:
            await dependencies.redis_client.xadd(
                "djinnbot:events:new_runs",
                {"run_id": planning_run_id, "pipeline_id": "planning"},
            )
        logger.info(
            f"Planning pipeline triggered: run={planning_run_id}, project={project_id}"
        )
    except Exception as e:
        logger.warning(
            f"Failed to trigger planning pipeline for project {project_id}: {e}"
        )

    return planning_run_id


async def _publish_completion_events(
    session_id: str,
    project_id: str,
    project_name: str,
    planning_run_id: Optional[str],
    now: int,
) -> None:
    """Broadcast PROJECT_CREATED + ONBOARDING_COMPLETED to dashboard SSE."""
    if not dependencies.redis_client:
        return
    try:
        for event_data in [
            {
                "type": "PROJECT_CREATED",
                "projectId": project_id,
                "name": project_name,
                "timestamp": now,
            },
            {
                "type": "ONBOARDING_COMPLETED",
                "sessionId": session_id,
                "projectId": project_id,
                "projectName": project_name,
                "planningRunId": planning_run_id,
                "timestamp": now,
            },
        ]:
            await dependencies.redis_client.xadd(
                "djinnbot:events:global",
                {"data": json.dumps(event_data)},
            )
    except Exception as e:
        logger.warning(f"Failed to publish onboarding events: {e}")


# ============================================================================
# Endpoints
# ============================================================================


@router.post("/sessions", response_model=OnboardingSessionResponse)
async def create_onboarding_session(
    req: CreateOnboardingSessionRequest,
    db: AsyncSession = Depends(get_async_session),
):
    """Create a new agent-guided project onboarding session.

    Starts with Stas as the first agent. Returns immediately — the
    container will be ready shortly (poll /sessions/{id} for status,
    or subscribe to the SSE stream).
    """
    now = now_ms()
    session_id = gen_id("onb_")
    model = req.model or DEFAULT_CHAT_MODEL
    name, emoji = _agent_meta(FIRST_AGENT_ID)

    # Pre-create a placeholder for the proactive assistant greeting.
    # The engine needs a message ID before the container starts so it can
    # persist the response via /internal/chat/messages/{id}/complete.
    greeting_msg_id = gen_id("ombm_")

    # Start the Stas container, passing the greeting message ID so the
    # engine sets currentMessageId before the proactive turn fires.
    chat_session_id = await _start_agent_container(
        FIRST_AGENT_ID, model, session_id, greeting_message_id=greeting_msg_id
    )

    onb = OnboardingSession(
        id=session_id,
        status="active",
        project_id=None,
        current_agent_id=FIRST_AGENT_ID,
        phase="intake",
        context="{}",
        chat_session_id=chat_session_id,
        model=model,
        created_at=now,
        updated_at=now,
    )
    db.add(onb)
    await db.flush()

    # System message marking session start
    system_msg = OnboardingMessage(
        id=gen_id("ombm_"),
        session_id=session_id,
        role="system",
        content=f"Onboarding session started. {emoji} {name} is your first contact.",
        agent_id=FIRST_AGENT_ID,
        agent_name=name,
        agent_emoji=emoji,
        created_at=now,
    )
    db.add(system_msg)

    # Proactive greeting placeholder — empty content, filled in by the engine
    # when stepEnd fires via /internal/chat/messages/{id}/complete.
    greeting_msg = OnboardingMessage(
        id=greeting_msg_id,
        session_id=session_id,
        role="assistant",
        content="",
        agent_id=FIRST_AGENT_ID,
        agent_name=name,
        agent_emoji=emoji,
        created_at=now + 1,
    )
    db.add(greeting_msg)

    await db.commit()
    await db.refresh(onb)

    # Explicitly load messages via a separate async query so we can pass them
    # directly to _serialize_session, bypassing the ORM lazy-load relationship
    # (which would trigger MissingGreenlet in an async greenlet context).
    msgs_result = await db.execute(
        select(OnboardingMessage)
        .where(OnboardingMessage.session_id == session_id)
        .order_by(OnboardingMessage.created_at)
    )
    loaded_messages = list(msgs_result.scalars().all())

    logger.info(f"Onboarding session created: {session_id}, chat: {chat_session_id}")

    # Publish SSE event
    if dependencies.redis_client:
        try:
            await dependencies.redis_client.xadd(
                "djinnbot:events:global",
                {
                    "data": json.dumps(
                        {
                            "type": "ONBOARDING_STARTED",
                            "sessionId": session_id,
                            "agentId": FIRST_AGENT_ID,
                            "timestamp": now,
                        }
                    )
                },
            )
        except Exception:
            pass

    return _serialize_session(onb, messages=loaded_messages)


class OnboardingSessionSummary(BaseModel):
    """Lightweight session summary for the list endpoint (no messages)."""

    id: str
    status: str
    phase: str
    project_id: Optional[str]
    current_agent_id: str
    current_agent_name: str
    current_agent_emoji: str
    model: str
    created_at: int
    updated_at: int
    completed_at: Optional[int]
    context: dict


@router.get("/sessions", response_model=List[OnboardingSessionSummary])
async def list_onboarding_sessions(
    status: Optional[str] = None,
    limit: int = 20,
    db: AsyncSession = Depends(get_async_session),
):
    """List onboarding sessions, newest first.

    Optional ?status=active|completed|abandoned filter.
    Defaults to active+abandoned only (completed sessions belong on the project page).
    Returns lightweight summaries (no messages) for the sessions panel.
    """
    q = (
        select(OnboardingSession)
        .order_by(desc(OnboardingSession.updated_at))
        .limit(limit)
    )
    if status:
        q = q.where(OnboardingSession.status == status)
    else:
        # Default: only show sessions that can be resumed or dismissed —
        # completed sessions surface on their project page instead.
        q = q.where(OnboardingSession.status.in_(["active", "abandoned"]))
    result = await db.execute(q)
    sessions = result.scalars().all()

    out = []
    for s in sessions:
        name, emoji = _agent_meta(s.current_agent_id)
        ctx: dict = {}
        if s.context:
            try:
                ctx = json.loads(s.context)
            except Exception:
                pass
        out.append(
            OnboardingSessionSummary(
                id=s.id,
                status=s.status,
                phase=s.phase,
                project_id=s.project_id,
                current_agent_id=s.current_agent_id,
                current_agent_name=name,
                current_agent_emoji=emoji,
                model=s.model,
                created_at=s.created_at,
                updated_at=s.updated_at,
                completed_at=s.completed_at,
                context=ctx,
            )
        )
    return out


@router.post("/sessions/{session_id}/resume", response_model=OnboardingSessionResponse)
async def resume_onboarding_session(
    session_id: str,
    db: AsyncSession = Depends(get_async_session),
):
    """Resume a paused/abandoned onboarding session.

    Re-starts the agent container for the current agent phase and marks
    the session active again. The client can then reconnect to the SSE
    stream and continue the conversation.
    """
    result = await db.execute(
        select(OnboardingSession).where(OnboardingSession.id == session_id)
    )
    onb = result.scalar_one_or_none()
    if not onb:
        raise HTTPException(
            status_code=404, detail=f"Onboarding session {session_id} not found"
        )
    if onb.status == "completed":
        raise HTTPException(
            status_code=400, detail="Session already completed — cannot resume"
        )
    if onb.status == "active":
        # Already active — just return current state
        msgs_result = await db.execute(
            select(OnboardingMessage)
            .where(OnboardingMessage.session_id == session_id)
            .order_by(OnboardingMessage.created_at)
        )
        return _serialize_session(onb, messages=list(msgs_result.scalars().all()))

    now = now_ms()
    name, emoji = _agent_meta(onb.current_agent_id)

    # Stop any previously running container before spawning a new one.
    # This prevents orphaned containers when a session is abandoned mid-handoff
    # or the engine restarts while a container is still alive.
    prev_chat_session_id = onb.chat_session_id
    if prev_chat_session_id:
        await _stop_agent_container(prev_chat_session_id, onb.current_agent_id)

    # Clean up stale empty assistant placeholders from the previous run.
    # If the old container was killed before completing its greeting, the
    # placeholder row lingers with empty content. If the old container is
    # still alive briefly, it might complete the stale placeholder AFTER
    # we create a new one — causing a ghost message at the wrong position.
    # Deleting them here prevents both issues.
    await db.execute(
        delete(OnboardingMessage).where(
            and_(
                OnboardingMessage.session_id == session_id,
                OnboardingMessage.role == "assistant",
                OnboardingMessage.content == "",
            )
        )
    )

    # Pre-create a greeting message placeholder for the agent's opening turn.
    # The engine sets currentMessageId from this before firing the proactive step,
    # ensuring the greeting is persisted via /internal/chat/messages/{id}/complete.
    # Without this, the engine logs "no currentMessageId" and the greeting is lost.
    greeting_msg_id = gen_id("ombm_")
    greeting_msg = OnboardingMessage(
        id=greeting_msg_id,
        session_id=session_id,
        role="assistant",
        content="",
        agent_id=onb.current_agent_id,
        agent_name=name,
        agent_emoji=emoji,
        created_at=now + 2,
    )
    db.add(greeting_msg)

    # Re-start the agent container for the current agent
    chat_session_id = await _start_agent_container(
        onb.current_agent_id,
        onb.model,
        session_id,
        greeting_message_id=greeting_msg_id,
    )

    onb.status = "active"
    onb.chat_session_id = chat_session_id
    onb.updated_at = now

    # Record resume in transcript
    resume_msg = OnboardingMessage(
        id=gen_id("ombm_"),
        session_id=session_id,
        role="system",
        content=f"Session resumed. {emoji} {name} is ready to continue.",
        agent_id=onb.current_agent_id,
        agent_name=name,
        agent_emoji=emoji,
        created_at=now + 1,
    )
    db.add(resume_msg)
    await db.commit()
    await db.refresh(onb)

    msgs_result = await db.execute(
        select(OnboardingMessage)
        .where(OnboardingMessage.session_id == session_id)
        .order_by(OnboardingMessage.created_at)
    )
    loaded_messages = list(msgs_result.scalars().all())

    logger.info(
        f"Onboarding session resumed: {session_id}, new chat: {chat_session_id}"
    )
    return _serialize_session(onb, messages=loaded_messages)


@router.get("/sessions/{session_id}", response_model=OnboardingSessionResponse)
async def get_onboarding_session(
    session_id: str,
    db: AsyncSession = Depends(get_async_session),
):
    """Get the current state and full message history of an onboarding session."""
    result = await db.execute(
        select(OnboardingSession).where(OnboardingSession.id == session_id)
    )
    onb = result.scalar_one_or_none()
    if not onb:
        raise HTTPException(
            status_code=404, detail=f"Onboarding session {session_id} not found"
        )

    # Load messages explicitly and pass directly to avoid ORM lazy-load
    msgs_result = await db.execute(
        select(OnboardingMessage)
        .where(OnboardingMessage.session_id == session_id)
        .order_by(OnboardingMessage.created_at)
    )
    loaded_messages = list(msgs_result.scalars().all())

    return _serialize_session(onb, messages=loaded_messages)


@router.post("/sessions/{session_id}/message")
async def send_onboarding_message(
    session_id: str,
    req: SendOnboardingMessageRequest,
    db: AsyncSession = Depends(get_async_session),
):
    """Send a user message in an onboarding session.

    Stores the message locally and forwards it to the current agent's
    container via Redis pub/sub (same mechanism as regular chat).
    """
    if not dependencies.redis_client:
        raise HTTPException(status_code=503, detail="Redis not available")

    result = await db.execute(
        select(OnboardingSession).where(OnboardingSession.id == session_id)
    )
    onb = result.scalar_one_or_none()
    if not onb:
        raise HTTPException(status_code=404, detail=f"Session {session_id} not found")
    if onb.status != "active":
        raise HTTPException(
            status_code=400, detail=f"Session is not active (status: {onb.status})"
        )
    if not onb.chat_session_id:
        raise HTTPException(status_code=400, detail="No active agent container")

    now = now_ms()
    model = req.model or onb.model

    # Store user message in onboarding transcript
    user_msg = OnboardingMessage(
        id=gen_id("ombm_"),
        session_id=session_id,
        role="user",
        content=req.message,
        created_at=now,
    )
    db.add(user_msg)

    # Create a placeholder for the assistant reply (same pattern as chat.py)
    # Use now+1 so the assistant placeholder always sorts AFTER the user message.
    # Without this, ORDER BY created_at returns them in undefined order on refresh.
    assistant_msg_id = gen_id("ombm_")
    assistant_msg = OnboardingMessage(
        id=assistant_msg_id,
        session_id=session_id,
        role="assistant",
        content="",
        agent_id=onb.current_agent_id,
        agent_name=AGENT_META.get(onb.current_agent_id, {}).get("name"),
        agent_emoji=AGENT_META.get(onb.current_agent_id, {}).get("emoji"),
        created_at=now + 1,
    )
    db.add(assistant_msg)

    onb.updated_at = now
    await db.commit()

    # Forward to agent container via Redis pub/sub
    command_channel = f"djinnbot:chat:sessions:{onb.chat_session_id}:commands"
    await dependencies.redis_client.publish(
        command_channel,
        json.dumps(
            {
                "type": "message",
                "content": req.message,
                "model": model,
                "message_id": assistant_msg_id,
                "timestamp": now,
                # Extra context so the runtime knows where to write back
                "onboarding_session_id": session_id,
            }
        ),
    )

    return {
        "status": "queued",
        "sessionId": session_id,
        "chatSessionId": onb.chat_session_id,
        "userMessageId": user_msg.id,
        "assistantMessageId": assistant_msg_id,
    }


@router.post("/sessions/{session_id}/handoff")
async def handoff_onboarding_agent(
    session_id: str,
    req: HandoffRequest,
    db: AsyncSession = Depends(get_async_session),
):
    """Switch the active agent in an onboarding session.

    Stops the current agent container, starts the next one, and
    records a handoff system message in the transcript.

    Called by:
    - The agent runtime when the agent emits an `onboarding_handoff` tool call
    - The frontend if the user manually requests a different agent
    """
    result = await db.execute(
        select(OnboardingSession).where(OnboardingSession.id == session_id)
    )
    onb = result.scalar_one_or_none()
    if not onb:
        raise HTTPException(status_code=404, detail=f"Session {session_id} not found")
    if onb.status != "active":
        raise HTTPException(status_code=400, detail="Session is not active")

    # Idempotency guard: if from_agent_id is provided, verify it still matches
    # the current agent. If it doesn't, this is a retry of an already-completed
    # handoff — return success without side effects to prevent double-handoff.
    if req.from_agent_id and onb.current_agent_id != req.from_agent_id:
        logger.info(
            f"Handoff idempotency: session {session_id} already moved from "
            f"{req.from_agent_id} to {onb.current_agent_id}, skipping duplicate"
        )
        return {
            "status": "already_handed_off",
            "sessionId": session_id,
            "currentAgent": onb.current_agent_id,
        }

    now = now_ms()
    prev_agent_id = onb.current_agent_id
    prev_chat_session_id = onb.chat_session_id

    # Merge context update (needed for both handoff and auto-finalize)
    if req.context_update:
        existing_ctx: dict = {}
        if onb.context:
            try:
                existing_ctx = json.loads(onb.context)
            except Exception:
                pass
        existing_ctx.update(req.context_update)
        onb.context = json.dumps(existing_ctx)

    # Store conversation highlights so the next agent's supplement can
    # reference them for a seamless, personality-aware greeting.
    if req.conversation_highlights:
        ctx: dict = {}
        if onb.context:
            try:
                ctx = json.loads(onb.context)
            except Exception:
                pass
        ctx["conversation_highlights"] = req.conversation_highlights
        onb.context = json.dumps(ctx)

    # ── Auto-finalize when next_agent is "done" ──────────────────────────
    # "done" is not a real agent — it signals that the relay is complete.
    # Instead of starting a container for a non-existent agent, we finalize
    # the session: create the project, trigger the planning pipeline, and
    # close the onboarding session cleanly.
    if req.next_agent_id == "done":
        # Parse accumulated context
        accumulated_ctx: dict = {}
        if onb.context:
            try:
                accumulated_ctx = json.loads(onb.context)
            except Exception:
                pass

        project_name = accumulated_ctx.get("project_name", "Untitled Project")
        description = accumulated_ctx.get("summary", accumulated_ctx.get("goal", ""))
        repository = accumulated_ctx.get("repo")

        prev_name, prev_emoji = _agent_meta(prev_agent_id)

        # Record completion system message in transcript
        completion_msg = OnboardingMessage(
            id=gen_id("ombm_"),
            session_id=session_id,
            role="system",
            content=(
                f"{prev_emoji} {prev_name} has completed the onboarding."
                + (f" {req.summary}" if req.summary else "")
                + f' Creating project "{project_name}" and kicking off the planning pipeline.'
            ),
            agent_id=prev_agent_id,
            agent_name=prev_name,
            agent_emoji=prev_emoji,
            handoff_to_agent="done",
            created_at=now,
        )
        db.add(completion_msg)

        # Create project + kanban columns via shared helper
        project_id = await _create_project_with_columns(
            db, project_name, description, repository, accumulated_ctx, now
        )

        # Mark session completed
        onb.status = "completed"
        onb.project_id = project_id
        onb.phase = "done"
        onb.completed_at = now
        onb.updated_at = now
        onb.context = json.dumps(accumulated_ctx)

        await db.commit()

        # Stop the agent container (after commit)
        if prev_chat_session_id:
            await _stop_agent_container(prev_chat_session_id, prev_agent_id)

        # Trigger planning pipeline via shared helper
        planning_run_id = await _trigger_planning_pipeline(
            db,
            project_id,
            project_name,
            description,
            accumulated_ctx,
            session_id,
            now,
        )

        # Publish events via shared helper
        await _publish_completion_events(
            session_id, project_id, project_name, planning_run_id, now
        )

        logger.info(
            f"Onboarding auto-finalized via handoff to 'done': "
            f"session={session_id}, project={project_id}"
        )

        return {
            "status": "finalized",
            "sessionId": session_id,
            "fromAgent": prev_agent_id,
            "toAgent": "done",
            "projectId": project_id,
            "projectName": project_name,
            "planningRunId": planning_run_id,
        }

    # ── Normal handoff to another agent ──────────────────────────────────

    # Record handoff in transcript — marks the boundary between agents
    prev_name, prev_emoji = _agent_meta(prev_agent_id)
    next_name, next_emoji = _agent_meta(req.next_agent_id)

    # Build the handoff system message with context keys appended for the
    # frontend to render as "knowledge transferred" pills.
    handoff_text = (
        f"{prev_emoji} {prev_name} is handing off to {next_emoji} {next_name}."
        + (f" {req.summary}" if req.summary else "")
    )
    ctx_keys = list((req.context_update or {}).keys())
    if ctx_keys:
        handoff_text += f"\n[context: {', '.join(ctx_keys)}]"

    handoff_msg = OnboardingMessage(
        id=gen_id("ombm_"),
        session_id=session_id,
        role="system",
        content=handoff_text,
        agent_id=prev_agent_id,
        agent_name=prev_name,
        agent_emoji=prev_emoji,
        handoff_to_agent=req.next_agent_id,
        created_at=now,
    )
    db.add(handoff_msg)

    # Pre-create a greeting message placeholder for the next agent's opening turn.
    # The engine sets currentMessageId from this before firing the proactive step,
    # so the response is persisted via /internal/chat/messages/{id}/complete.
    greeting_msg_id = gen_id("ombm_")
    greeting_msg = OnboardingMessage(
        id=greeting_msg_id,
        session_id=session_id,
        role="assistant",
        content="",
        agent_id=req.next_agent_id,
        agent_name=next_name,
        agent_emoji=next_emoji,
        created_at=now + 2,
    )
    db.add(greeting_msg)

    # Start the next agent container (with context from this session).
    # Pass the accumulated onboarding context so the new agent knows the
    # project name and other confirmed facts without asking the user again.
    current_ctx: dict = {}
    if onb.context:
        try:
            current_ctx = json.loads(onb.context)
        except Exception:
            pass
    new_chat_session_id = await _start_agent_container(
        req.next_agent_id,
        onb.model,
        session_id,
        greeting_message_id=greeting_msg_id,
        onboarding_context=current_ctx if current_ctx else None,
    )

    # Update session
    onb.current_agent_id = req.next_agent_id
    onb.chat_session_id = new_chat_session_id
    onb.updated_at = now

    # Update phase based on agent
    phase_map = {
        "stas": "intake",
        "jim": "strategy",
        "eric": "product",
        "finn": "architecture",
    }
    onb.phase = phase_map.get(req.next_agent_id, "product")

    await db.commit()

    # Stop the previous container (after commit so the session is updated)
    if prev_chat_session_id:
        await _stop_agent_container(prev_chat_session_id, prev_agent_id)

    # Publish handoff event so dashboard SSE can update UI
    if dependencies.redis_client:
        try:
            await dependencies.redis_client.xadd(
                "djinnbot:events:global",
                {
                    "data": json.dumps(
                        {
                            "type": "ONBOARDING_HANDOFF",
                            "sessionId": session_id,
                            "fromAgent": prev_agent_id,
                            "toAgent": req.next_agent_id,
                            "phase": onb.phase,
                            "newChatSessionId": new_chat_session_id,
                            "timestamp": now,
                        }
                    )
                },
            )
        except Exception:
            pass

    logger.info(
        f"Onboarding handoff: {session_id} {prev_agent_id} → {req.next_agent_id}"
    )

    return {
        "status": "handed_off",
        "sessionId": session_id,
        "fromAgent": prev_agent_id,
        "toAgent": req.next_agent_id,
        "newChatSessionId": new_chat_session_id,
        "phase": onb.phase,
    }


@router.post("/sessions/{session_id}/finalize")
async def finalize_onboarding_session(
    session_id: str,
    req: FinalizeRequest,
    db: AsyncSession = Depends(get_async_session),
):
    """Finalize the onboarding session: create the project and seal memories.

    This endpoint:
    1. Creates the Project record with accumulated onboarding_context
    2. Marks the onboarding session as completed
    3. Stops the current agent container
    4. Emits a PROJECT_CREATED + ONBOARDING_COMPLETED event
    """
    result = await db.execute(
        select(OnboardingSession).where(OnboardingSession.id == session_id)
    )
    onb = result.scalar_one_or_none()
    if not onb:
        raise HTTPException(status_code=404, detail=f"Session {session_id} not found")
    if onb.status == "completed":
        # Idempotent — return existing project if already finalized
        if onb.project_id:
            return {"status": "already_finalized", "projectId": onb.project_id}
        raise HTTPException(status_code=400, detail="Session already completed")

    now = now_ms()

    # Merge final context
    accumulated_ctx: dict = {}
    if onb.context:
        try:
            accumulated_ctx = json.loads(onb.context)
        except Exception:
            pass
    if req.context:
        accumulated_ctx.update(req.context)

    description = req.description or accumulated_ctx.get("summary", "")
    repository = req.repository or accumulated_ctx.get("repo")

    # Create project + kanban columns via shared helper
    project_id = await _create_project_with_columns(
        db, req.project_name, description, repository, accumulated_ctx, now
    )

    # Mark session completed and link to project
    onb.status = "completed"
    onb.project_id = project_id
    onb.phase = "done"
    onb.completed_at = now
    onb.updated_at = now
    onb.context = json.dumps(accumulated_ctx)

    # Record completion in transcript
    completion_msg = OnboardingMessage(
        id=gen_id("ombm_"),
        session_id=session_id,
        role="system",
        content=f'Project "{req.project_name}" created. Onboarding complete.',
        created_at=now,
    )
    db.add(completion_msg)

    await db.commit()

    # Stop the current agent container
    if onb.chat_session_id:
        await _stop_agent_container(onb.chat_session_id, onb.current_agent_id)

    # Trigger planning pipeline via shared helper
    planning_run_id = await _trigger_planning_pipeline(
        db,
        project_id,
        req.project_name,
        description,
        accumulated_ctx,
        session_id,
        now,
    )

    # Publish events via shared helper
    await _publish_completion_events(
        session_id, project_id, req.project_name, planning_run_id, now
    )

    logger.info(f"Onboarding finalized: session={session_id}, project={project_id}")

    return {
        "status": "finalized",
        "sessionId": session_id,
        "projectId": project_id,
        "projectName": req.project_name,
        "planningRunId": planning_run_id,
    }


@router.post("/sessions/{session_id}/stop")
async def stop_onboarding_agent(
    session_id: str,
    db: AsyncSession = Depends(get_async_session),
):
    """Stop the current agent response without abandoning the session.

    Sends an abort signal to the running container via Redis pub/sub.
    The session stays active — the user can resume by sending another message
    or by calling the /resume endpoint if the container has been shut down.

    This is the "Stop" button in the UI — it does NOT mark the session abandoned.
    """
    if not dependencies.redis_client:
        raise HTTPException(status_code=503, detail="Redis not available")

    result = await db.execute(
        select(OnboardingSession).where(OnboardingSession.id == session_id)
    )
    onb = result.scalar_one_or_none()
    if not onb:
        raise HTTPException(status_code=404, detail=f"Session {session_id} not found")
    if onb.status != "active":
        raise HTTPException(
            status_code=400, detail=f"Session is not active (status: {onb.status})"
        )
    if not onb.chat_session_id:
        raise HTTPException(status_code=400, detail="No active agent container")

    now = now_ms()
    chat_session_id = onb.chat_session_id

    # 1. Send abort to the container's pub/sub command channel.
    #    ChatSessionManager listens here and will abort the current LLM generation,
    #    then publish response_aborted to the session SSE channel.
    command_channel = f"djinnbot:chat:sessions:{chat_session_id}:commands"
    await dependencies.redis_client.publish(
        command_channel,
        json.dumps({"type": "abort", "timestamp": now}),
    )

    # 2. Also publish response_aborted directly to the SSE channel so the UI
    #    clears its spinner immediately, even if the container is slow to respond.
    session_channel = f"djinnbot:sessions:{chat_session_id}"
    await dependencies.redis_client.publish(
        session_channel,
        json.dumps({"type": "response_aborted", "timestamp": now}),
    )

    logger.info(
        f"Onboarding agent stop signal sent: session={session_id}, chat={chat_session_id}"
    )
    return {
        "status": "stop_sent",
        "sessionId": session_id,
        "chatSessionId": chat_session_id,
    }


@router.post("/sessions/{session_id}/abandon")
@router.patch("/sessions/{session_id}/abandon")
async def abandon_onboarding_session(
    session_id: str,
    db: AsyncSession = Depends(get_async_session),
):
    """Mark a session abandoned (soft) so it can be resumed later.

    Called when the user closes the OnboardingChat mid-session.
    The row is kept so it appears in the panel for resuming.
    To permanently remove a session, use DELETE /sessions/{id}.
    """
    result = await db.execute(
        select(OnboardingSession).where(OnboardingSession.id == session_id)
    )
    onb = result.scalar_one_or_none()
    if not onb:
        raise HTTPException(status_code=404, detail=f"Session {session_id} not found")

    now = now_ms()
    if onb.chat_session_id and onb.status == "active":
        await _stop_agent_container(onb.chat_session_id, onb.current_agent_id)

    onb.status = "abandoned"
    # NOTE: Do NOT set completed_at here — the session isn't completed, it's
    # abandoned. completed_at is reserved for successful finalization so we can
    # distinguish "finished at X" from "gave up at X". updated_at is sufficient
    # for tracking when the abandonment occurred.
    onb.updated_at = now
    await db.commit()

    return {"status": "abandoned", "sessionId": session_id}


@router.delete("/sessions/{session_id}")
async def delete_onboarding_session(
    session_id: str,
    db: AsyncSession = Depends(get_async_session),
):
    """Permanently delete an onboarding session and all its messages.

    Called when the user dismisses a session from the panel (trash icon).
    Stops any running container and hard-deletes the row — it will not
    reappear on refresh.
    """
    result = await db.execute(
        select(OnboardingSession).where(OnboardingSession.id == session_id)
    )
    onb = result.scalar_one_or_none()
    if not onb:
        raise HTTPException(status_code=404, detail=f"Session {session_id} not found")

    if onb.chat_session_id and onb.status == "active":
        await _stop_agent_container(onb.chat_session_id, onb.current_agent_id)

    await db.delete(onb)
    await db.commit()

    return {"status": "deleted", "sessionId": session_id}


@router.patch("/internal/sessions/{session_id}/status")
async def internal_update_onboarding_session_status(
    session_id: str,
    request: dict,
    db: AsyncSession = Depends(get_async_session),
):
    """Internal: update an OnboardingSession's status.

    Called by the engine's ChatSessionManager when stopping an onboarding
    container (idle timeout, user stop, engine shutdown). Transitions the
    session to 'abandoned' so the UI reflects reality instead of showing
    every session as indefinitely 'active'.

    Only transitions active→abandoned or active→completed are accepted here;
    finalize uses its own endpoint.
    """
    new_status = request.get("status")
    if new_status not in ("abandoned", "completed"):
        raise HTTPException(status_code=400, detail=f"Invalid status: {new_status}")

    result = await db.execute(
        select(OnboardingSession).where(OnboardingSession.id == session_id)
    )
    onb = result.scalar_one_or_none()
    if not onb:
        # Silently ignore — session may not exist if this was a plain chat session
        return {"ok": True, "note": "session not found"}

    if onb.status in ("completed", "abandoned"):
        return {"ok": True, "note": "already finalized"}

    # Guard: only update if the chat session being stopped is still the current one.
    # After a handoff, the old agent's container is stopped — but the onboarding session
    # has already moved on to the new agent. Without this check, stopping the old
    # container would overwrite status→abandoned and kill the SSE on the dashboard.
    incoming_chat_session_id = request.get("chat_session_id")
    if incoming_chat_session_id and onb.chat_session_id != incoming_chat_session_id:
        logger.info(
            f"Onboarding session {session_id} skipping {new_status}: "
            f"current chat={onb.chat_session_id}, stopping={incoming_chat_session_id}"
        )
        return {"ok": True, "note": "session has handed off to next agent, skipping"}

    now = now_ms()
    onb.status = new_status
    onb.updated_at = now
    # Only set completed_at for actual completion, not abandonment
    if new_status == "completed" and onb.completed_at is None:
        onb.completed_at = now

    await db.commit()
    logger.info(f"Onboarding session {session_id} marked {new_status} by engine")
    return {"ok": True, "status": new_status}


@router.patch("/sessions/{session_id}/context")
async def update_onboarding_context(
    session_id: str,
    context_update: dict,
    db: AsyncSession = Depends(get_async_session),
):
    """Merge additional context into the session's accumulated knowledge.

    Called by the agent runtime when it stores a memory — lets the
    profile sidebar update in real-time.
    """
    result = await db.execute(
        select(OnboardingSession).where(OnboardingSession.id == session_id)
    )
    onb = result.scalar_one_or_none()
    if not onb:
        raise HTTPException(status_code=404, detail=f"Session {session_id} not found")

    existing: dict = {}
    if onb.context:
        try:
            existing = json.loads(onb.context)
        except Exception:
            pass
    existing.update(context_update)

    onb.context = json.dumps(existing)
    onb.updated_at = now_ms()
    await db.commit()

    # Broadcast so the profile sidebar updates live
    if dependencies.redis_client:
        try:
            await dependencies.redis_client.xadd(
                "djinnbot:events:global",
                {
                    "data": json.dumps(
                        {
                            "type": "ONBOARDING_CONTEXT_UPDATED",
                            "sessionId": session_id,
                            "context": existing,
                            "timestamp": now_ms(),
                        }
                    )
                },
            )
        except Exception:
            pass

    return {"status": "updated", "context": existing}


class UpdateDiagramRequest(BaseModel):
    """Update the evolving onboarding diagram."""

    mermaid: str
    caption: Optional[str] = None


@router.patch("/sessions/{session_id}/diagram")
async def update_onboarding_diagram(
    session_id: str,
    req: UpdateDiagramRequest,
    db: AsyncSession = Depends(get_async_session),
):
    """Update the evolving Mermaid diagram for an onboarding session.

    Called by agents via the update_onboarding_diagram tool to progressively
    build the project diagram throughout the onboarding process.  Each call
    replaces the full Mermaid string (the agent sees the current diagram in
    its context and builds on it).
    """
    result = await db.execute(
        select(OnboardingSession).where(OnboardingSession.id == session_id)
    )
    onb = result.scalar_one_or_none()
    if not onb:
        raise HTTPException(status_code=404, detail=f"Session {session_id} not found")

    # Parse existing state to bump version
    existing_version = 0
    if onb.diagram_state:
        try:
            existing = json.loads(onb.diagram_state)
            existing_version = existing.get("version", 0)
        except Exception:
            pass

    new_state = {
        "mermaid": req.mermaid,
        "caption": req.caption,
        "last_agent_id": onb.current_agent_id,
        "version": existing_version + 1,
    }
    onb.diagram_state = json.dumps(new_state)
    onb.updated_at = now_ms()
    await db.commit()

    # Broadcast so the diagram panel updates live
    if dependencies.redis_client:
        try:
            await dependencies.redis_client.xadd(
                "djinnbot:events:global",
                {
                    "data": json.dumps(
                        {
                            "type": "ONBOARDING_DIAGRAM_UPDATED",
                            "sessionId": session_id,
                            "diagramState": new_state,
                            "timestamp": now_ms(),
                        }
                    )
                },
            )
        except Exception:
            pass

    return {"status": "updated", "diagramState": new_state}


@router.patch("/internal/messages/{message_id}/complete")
async def complete_onboarding_message(
    message_id: str,
    request: dict,
    db: AsyncSession = Depends(get_async_session),
):
    """Internal: mark an onboarding assistant message complete with final content.

    Called by the engine's ChatSessionManager at stepEnd when currentMessageId
    is set (e.g. the proactive greeting turn or any user-initiated turn).
    """
    result = await db.execute(
        select(OnboardingMessage).where(OnboardingMessage.id == message_id)
    )
    msg = result.scalar_one_or_none()
    if not msg:
        raise HTTPException(
            status_code=404, detail=f"Onboarding message {message_id} not found"
        )

    content = request.get("content", "")
    if not content:
        logger.warning(
            f"complete_onboarding_message: message {message_id} received EMPTY content — "
            f"agent may have produced no output text (thinking={bool(request.get('thinking'))}, "
            f"tool_calls={bool(request.get('tool_calls'))})"
        )
    else:
        logger.info(
            f"complete_onboarding_message: message {message_id} completed "
            f"({len(content)} chars, thinking={bool(request.get('thinking'))}, "
            f"tool_calls={len(request.get('tool_calls') or [])} calls)"
        )
    msg.content = content
    if request.get("thinking"):
        msg.thinking = request["thinking"]
    if request.get("tool_calls"):
        import json as _json

        msg.tool_calls = _json.dumps(request["tool_calls"])

    await db.commit()

    # Notify the dashboard SSE *after* the DB commit so the frontend's
    # refreshSession call is guaranteed to see the completed message content.
    # The engine publishes turn_end *before* calling this endpoint (fire-and-
    # forget), so the dashboard's 500ms-delayed refreshSession can race with the
    # DB write.  Publishing a second turn_end here resolves that race.
    if dependencies.redis_client and content:
        try:
            onb_result = await db.execute(
                select(OnboardingSession.chat_session_id).where(
                    OnboardingSession.id == msg.session_id
                )
            )
            chat_session_id = onb_result.scalar_one_or_none()
            if chat_session_id:
                channel = f"djinnbot:sessions:{chat_session_id}"
                await dependencies.redis_client.publish(
                    channel,
                    json.dumps(
                        {
                            "type": "turn_end",
                            "timestamp": now_ms(),
                            "data": {"success": True},
                        }
                    ),
                )
        except Exception as e:
            logger.warning(
                f"complete_onboarding_message: failed to publish turn_end for {message_id}: {e}"
            )

    return {"ok": True}
