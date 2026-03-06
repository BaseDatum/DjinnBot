# Design: Extract Slack Bridge into Standalone Container

**Status:** Proposed
**Estimated effort:** 1.5–2 weeks (one engineer)
**Depends on:** Nothing — this can be done independently before multi-tenant work

---

## 1. Motivation

The Slack bridge currently lives inside the engine process (`packages/core/src/main.ts:1268`).
This creates several problems:

- **Coupled lifecycle**: Updating Slack logic requires restarting the engine, which kills all running agent containers.
- **Hardcoded paths**: `agent-slack-runtime.ts` has 8+ inline references to `/data/vaults/{agentId}` and `/data/workspaces/{agentId}` because it runs in the engine's address space.
- **Scaling mismatch**: Slack is I/O-bound (websocket connections), the engine is CPU-bound (container orchestration). Different scaling profiles.
- **Multi-tenant blocker**: In a SaaS model, each tenant connects their own Slack workspace. Running all of them inside a single engine process doesn't scale.

## 2. Current Architecture

```
┌──────────────────────────────────────────────────────┐
│  Engine Process (packages/core/src/main.ts)          │
│                                                      │
│  ┌─────────────┐  in-process   ┌──────────────────┐  │
│  │  DjinnBot    │─────────────>│  SlackBridge      │  │
│  │  (djinnbot.ts│  callbacks   │  (slack-bridge.ts)│  │
│  │   :1262)     │              │                   │  │
│  └──────┬───────┘              │  ┌──────────────┐ │  │
│         │                      │  │ AgentSlack   │ │  │
│  ┌──────┴───────────────┐      │  │ Runtime (x11)│ │  │
│  │ ChatSessionManager   │◄─────│  │              │ │  │
│  │ (in-process hooks)   │      │  └──────────────┘ │  │
│  └──────────────────────┘      │  ┌──────────────┐ │  │
│                                │  │ SlackSession  │ │  │
│                                │  │ Pool          │ │  │
│                                │  └──────────────┘ │  │
│                                └──────────────────────┘│
└──────────────────────────────────────────────────────┘
```

### 2.1 Coupling Points (5 total)

The `SlackBridge` receives these from the engine via in-process callbacks
defined in `SlackBridgeConfig` (`slack-bridge.ts:32-103`):

| # | Callback / Dependency | Where wired | Purpose |
|---|----------------------|-------------|---------|
| 1 | `eventBus` (EventBus) | `djinnbot.ts:1263` | Subscribe to pipeline events (`STEP_QUEUED`, `STEP_OUTPUT`, `STEP_COMPLETE`, etc.) per run via `subscribeToRun()` |
| 2 | `onDecisionNeeded` | `main.ts:1270` | Lightweight LLM call for Slack triage (should the agent respond?) |
| 3 | `onRunFullSession` | `djinnbot.ts:1313` | Spawn a one-shot agent container (legacy path, deprecated) |
| 4 | `onMemorySearch` | `main.ts:1310` | Pre-fetch agent memories for triage context |
| 5 | `onFeedback` / `onLoadPersona` | `djinnbot.ts:1273`, `djinnbot.ts:1304` | Store feedback memories, load agent persona for system prompts |

Additionally, `ChatSessionManager` is injected post-construction:
- `main.ts:1420` — `slackBridge.setChatSessionManager(chatSessionManager)`
- `main.ts:1431` — `slackBridge.setOnBeforeTeardown(...)` for memory consolidation

### 2.2 What's Already Decoupled

The `SlackSessionPool` (the modern conversation path) already communicates
via Redis under the hood:

```
SlackSessionPool → ChatSessionManager.startSession()   → Redis → ContainerManager
SlackSessionPool → ChatSessionManager.sendMessage()     → Redis → Agent Container
SlackBridge      ← ChatSessionManager output hooks      ← Redis ← Agent Container
```

The `EventBus` (`event-bus.ts`) is a thin wrapper over Redis XREAD/XADD.
Pipeline event channels (`djinnbot:events:run:{runId}`) are Redis streams.

---

## 3. Target Architecture

```
┌───────────────────────────────┐     ┌─────────────────────────────┐
│  Engine Container             │     │  Slack Container (NEW)      │
│  (Dockerfile.engine)          │     │  (Dockerfile.slack)         │
│                               │     │                             │
│  ┌─────────────┐              │     │  ┌──────────────────┐       │
│  │  DjinnBot    │              │     │  │  SlackBridge      │       │
│  │  (no Slack)  │              │     │  │  + AgentRuntimes  │       │
│  └──────┬───────┘              │     │  │  + SessionPool    │       │
│         │                      │     │  └────────┬─────────┘       │
│  ┌──────┴───────────────┐      │     │           │                 │
│  │ ChatSessionManager   │      │     │  ┌────────┴─────────┐       │
│  │ (publishes hooks     │      │     │  │  ApiClient        │       │
│  │  to Redis)           │      │     │  │  (replaces        │       │
│  └──────────────────────┘      │     │  │   callbacks)      │       │
│                               │     │  └──────────────────┘       │
└───────────┬───────────────────┘     └───────────┬─────────────────┘
            │                                     │
            └──────────── Redis ──────────────────┘
                  (streams, pub/sub)
```

Each in-process callback becomes either an API call or a direct Redis
subscription. The Slack container is stateless — all persistent state lives
in Postgres and Redis.

---

## 4. Step-by-Step Implementation Plan

### Phase A: New API Endpoints on the Server (2–3 days)

These endpoints let the Slack container access engine capabilities via HTTP
instead of in-process callbacks. All go in the FastAPI server
(`packages/server/app/routers/`).

#### Step A1: Create `packages/server/app/routers/internal_slack.py`

This router handles all Slack-bridge-specific internal endpoints. All
endpoints require `ENGINE_INTERNAL_TOKEN` auth (same as existing internal
endpoints like `spawn_executor.py`).

```python
"""Internal Slack bridge endpoints.

These endpoints replace the in-process callbacks that the Slack bridge
previously received from the engine. All require ENGINE_INTERNAL_TOKEN auth.
"""

import os
import json
from typing import Optional
from fastapi import APIRouter, HTTPException, Depends, Request
from pydantic import BaseModel, Field
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.database import get_async_session
from app import dependencies
from app.logging_config import get_logger

logger = get_logger(__name__)
router = APIRouter(prefix="/v1/internal/slack", tags=["internal-slack"])


# ── Request/Response Models ────────────────────────────────────────────────


class LlmDecisionRequest(BaseModel):
    """Request for a lightweight LLM triage call."""
    system_prompt: str
    user_prompt: str
    model: str


class LlmDecisionResponse(BaseModel):
    output: str


class MemorySearchRequest(BaseModel):
    agent_id: str
    query: str
    limit: int = 5


class MemorySearchResult(BaseModel):
    title: str
    snippet: str
    category: str


class FeedbackRequest(BaseModel):
    agent_id: str
    feedback: str  # "positive" or "negative"
    response_text: str
    user_name: str


class LoadPersonaRequest(BaseModel):
    agent_id: str
    session_type: str = "slack"  # slack | pulse | pipeline
    channel_context: Optional[str] = None
    installed_tools: Optional[list[str]] = None


class LoadPersonaResponse(BaseModel):
    system_prompt: str
    identity: str
    soul: str
    agents: str
    decision: str


class SessionStartRequest(BaseModel):
    """Request to start a chat session (forwarded to engine via Redis)."""
    session_id: str
    agent_id: str
    model: str
    external_history: Optional[list[dict]] = None
    user_id: Optional[str] = None


class SessionMessageRequest(BaseModel):
    session_id: str
    message: str
    model: Optional[str] = None
    message_id: Optional[str] = None
    attachments: Optional[list[dict]] = None


class SessionStopRequest(BaseModel):
    session_id: str


class ConsolidationRequest(BaseModel):
    session_id: str


class SubscribeRunRequest(BaseModel):
    """Tell the engine to subscribe a run to Slack notifications."""
    run_id: str
    pipeline_id: str
    task_description: str
    assigned_agent_ids: list[str]
    slack_channel_id: Optional[str] = None
    slack_notify_user_id: Optional[str] = None


# ── LLM Decision (replaces onDecisionNeeded) ──────────────────────────────


@router.post("/llm-decision", response_model=LlmDecisionResponse)
async def llm_decision(req: LlmDecisionRequest):
    """Make a lightweight LLM call for Slack triage.

    This replaces the onDecisionNeeded callback. The Slack container calls
    this when it needs to decide whether/how an agent should respond to a
    Slack message.

    Implementation: Publish request to Redis, engine picks it up, runs the
    LLM call, publishes the response. OR: the Slack container makes the LLM
    call directly (see Phase B — this endpoint becomes a simple proxy or is
    skipped entirely if the Slack container has provider keys).
    """
    if not dependencies.redis_client:
        raise HTTPException(503, "Redis not available")

    import uuid
    request_id = str(uuid.uuid4())

    # Publish RPC request to Redis
    await dependencies.redis_client.xadd(
        "djinnbot:slack:rpc:requests",
        {
            "request_id": request_id,
            "type": "llm_decision",
            "payload": json.dumps({
                "system_prompt": req.system_prompt,
                "user_prompt": req.user_prompt,
                "model": req.model,
            }),
        },
    )

    # Wait for response (poll with timeout)
    response_key = f"djinnbot:slack:rpc:response:{request_id}"
    for _ in range(60):  # 30 second timeout
        result = await dependencies.redis_client.get(response_key)
        if result:
            await dependencies.redis_client.delete(response_key)
            data = json.loads(result)
            return LlmDecisionResponse(output=data["output"])
        import asyncio
        await asyncio.sleep(0.5)

    raise HTTPException(504, "LLM decision timed out")


# ── Memory Search (replaces onMemorySearch) ────────────────────────────────


@router.post("/memory-search", response_model=list[MemorySearchResult])
async def memory_search(req: MemorySearchRequest):
    """Search agent memories for triage context.

    Proxies to the existing memory search endpoint.
    """
    # Reuse the existing vault search logic from routers/memory.py
    VAULTS_DIR = os.getenv("VAULTS_DIR", "/data/vaults")
    vault_path = os.path.join(VAULTS_DIR, req.agent_id)

    if not os.path.isdir(vault_path):
        return []

    # Use the same search logic as spawn_executor.py:_search_vault_files
    from app.routers.spawn_executor import _search_vault_files
    results = _search_vault_files(vault_path, req.query, req.limit)

    return [
        MemorySearchResult(
            title=r.get("title", "Untitled"),
            snippet=r.get("snippet", ""),
            category=r.get("category", "unknown"),
        )
        for r in results
    ]


# ── Feedback (replaces onFeedback) ────────────────────────────────────────


@router.post("/feedback")
async def store_feedback(req: FeedbackRequest):
    """Store user feedback as a memory in the agent's vault.

    Proxies to the existing shared vault store endpoint.
    """
    VAULTS_DIR = os.getenv("VAULTS_DIR", "/data/vaults")
    vault_path = os.path.join(VAULTS_DIR, req.agent_id, "lesson")
    os.makedirs(vault_path, exist_ok=True)

    import uuid
    slug = f"feedback-{req.feedback}-{uuid.uuid4().hex[:8]}"
    filepath = os.path.join(vault_path, f"{slug}.md")

    truncated = req.response_text[:500] + ("..." if len(req.response_text) > 500 else "")

    if req.feedback == "positive":
        content = (
            f"---\nid: lesson/{slug}\ntype: lesson\n"
            f"source: slack_feedback\nfeedback: positive\n---\n\n"
            f"{req.user_name} gave a thumbs-up to this response:\n\n"
            f"> {truncated}\n\n"
            f"This style/approach worked well — keep doing this."
        )
    else:
        content = (
            f"---\nid: lesson/{slug}\ntype: lesson\n"
            f"source: slack_feedback\nfeedback: negative\n---\n\n"
            f"{req.user_name} gave a thumbs-down to this response:\n\n"
            f"> {truncated}\n\n"
            f"This response missed the mark. Review and adjust approach."
        )

    with open(filepath, "w") as f:
        f.write(content)

    # Trigger graph rebuild
    if dependencies.redis_client:
        await dependencies.redis_client.publish(
            "djinnbot:graph:rebuild",
            json.dumps({"agent_id": req.agent_id}),
        )

    return {"ok": True, "filename": f"lesson/{slug}.md"}


# ── Persona Loading (replaces onLoadPersona) ──────────────────────────────


@router.post("/load-persona", response_model=LoadPersonaResponse)
async def load_persona(req: LoadPersonaRequest):
    """Load an agent's full persona for system prompt construction.

    Reads the agent's IDENTITY.md, SOUL.md, AGENTS.md, DECISION.md from the
    agents directory and assembles the system prompt.
    """
    agents_dir = os.getenv("AGENTS_DIR", "/agents")
    agent_dir = os.path.join(agents_dir, req.agent_id)

    if not os.path.isdir(agent_dir):
        raise HTTPException(404, f"Agent {req.agent_id} not found")

    def _read_file(filename: str) -> str:
        path = os.path.join(agent_dir, filename)
        try:
            with open(path) as f:
                return f.read().strip()
        except FileNotFoundError:
            return ""

    identity = _read_file("IDENTITY.md")
    soul = _read_file("SOUL.md")
    agents = _read_file("AGENTS.md")
    decision = _read_file("DECISION.md")

    # Assemble system prompt (same structure as PersonaLoader.loadPersona)
    sections = []
    if identity:
        sections.append(identity)
    if soul:
        sections.append(f"\n# SOUL\n\n{soul}")
    if agents:
        sections.append(f"\n# OTHER AGENTS\n\n{agents}")
    if decision:
        sections.append(f"\n# DECISION FRAMEWORK\n\n{decision}")

    system_prompt = "\n".join(sections)

    return LoadPersonaResponse(
        system_prompt=system_prompt,
        identity=identity,
        soul=soul,
        agents=agents,
        decision=decision,
    )


# ── Chat Session Lifecycle (replaces direct ChatSessionManager calls) ──────
# These forward commands to the engine via Redis. The engine's ChatListener
# picks them up and delegates to ChatSessionManager — same flow as the
# dashboard chat, just triggered by the Slack container instead of the API.


CHAT_STREAM = "djinnbot:events:chat_sessions"


@router.post("/sessions/start")
async def start_session(req: SessionStartRequest):
    """Start a chat session container for a Slack conversation.

    Publishes a chat:start command to the Redis stream. The engine's
    ChatListener picks it up and delegates to ChatSessionManager.
    """
    if not dependencies.redis_client:
        raise HTTPException(503, "Redis not available")

    payload = {
        "command": "chat:start",
        "sessionId": req.session_id,
        "agentId": req.agent_id,
        "model": req.model,
    }

    if req.external_history:
        payload["externalHistory"] = json.dumps(req.external_history)
    if req.user_id:
        payload["userId"] = req.user_id

    await dependencies.redis_client.xadd(CHAT_STREAM, payload)

    return {"ok": True, "session_id": req.session_id}


@router.post("/sessions/message")
async def send_session_message(req: SessionMessageRequest):
    """Send a message to an active Slack chat session.

    Publishes a chat:message command to the Redis stream.
    """
    if not dependencies.redis_client:
        raise HTTPException(503, "Redis not available")

    payload: dict = {
        "command": "chat:message",
        "sessionId": req.session_id,
        "message": req.message,
    }
    if req.model:
        payload["model"] = req.model
    if req.message_id:
        payload["messageId"] = req.message_id
    if req.attachments:
        payload["attachments"] = json.dumps(req.attachments)

    await dependencies.redis_client.xadd(CHAT_STREAM, payload)

    return {"ok": True}


@router.post("/sessions/stop")
async def stop_session(req: SessionStopRequest):
    """Stop a chat session container.

    Publishes a chat:stop command to the Redis stream.
    """
    if not dependencies.redis_client:
        raise HTTPException(503, "Redis not available")

    await dependencies.redis_client.xadd(
        CHAT_STREAM,
        {
            "command": "chat:stop",
            "sessionId": req.session_id,
        },
    )

    return {"ok": True}


@router.post("/sessions/consolidate")
async def consolidate_session(req: ConsolidationRequest):
    """Trigger memory consolidation for a session before teardown.

    Publishes a chat:consolidate command to the Redis stream. The engine's
    ChatListener handles this by calling ChatSessionManager.triggerConsolidation().
    """
    if not dependencies.redis_client:
        raise HTTPException(503, "Redis not available")

    await dependencies.redis_client.xadd(
        CHAT_STREAM,
        {
            "command": "chat:consolidate",
            "sessionId": req.session_id,
        },
    )

    return {"ok": True}


@router.get("/sessions/{session_id}/active")
async def check_session_active(session_id: str):
    """Check if a chat session is currently active on the engine.

    Queries Redis for the session's container status.
    """
    if not dependencies.redis_client:
        raise HTTPException(503, "Redis not available")

    # Check if the session container is running by looking at the session's
    # status in the DB — the engine updates this via the API.
    from app.models.chat import ChatSession
    async with AsyncSessionLocal() as db:
        result = await db.execute(
            select(ChatSession.status).where(ChatSession.id == session_id)
        )
        status = result.scalar_one_or_none()

    active_statuses = {"starting", "ready", "running"}
    return {
        "active": status in active_statuses if status else False,
        "status": status,
    }

from app.database import AsyncSessionLocal
```

#### Step A2: Register the router in `packages/server/app/main.py`

```python
# Add import at the top (after existing internal router imports):
from app.routers import internal_slack as internal_slack_router

# Add router registration (after existing router includes, around line 110):
app.include_router(internal_slack_router.router)
```

#### Step A3: Add `chat:consolidate` command to `ChatListener`

The engine's `ChatListener` (`packages/core/src/chat/chat-listener.ts`)
needs to handle the new `chat:consolidate` command that the Slack container
sends before tearing down idle sessions.

**File:** `packages/core/src/chat/chat-listener.ts`

Find the command dispatch switch (around line 95) and add:

```typescript
case 'chat:consolidate': {
  const consolidateSessionId = data.sessionId;
  if (!consolidateSessionId) {
    console.warn('[ChatListener] chat:consolidate missing sessionId');
    break;
  }
  console.log(`[ChatListener] Consolidating session: ${consolidateSessionId}`);
  try {
    await this.sessionManager.triggerConsolidation(consolidateSessionId);
  } catch (err) {
    console.warn(`[ChatListener] Consolidation failed for ${consolidateSessionId}:`, err);
  }
  break;
}
```

#### Step A4: Add LLM decision RPC handler to the engine

The engine needs to listen for `djinnbot:slack:rpc:requests` and execute
the LLM call, then publish the result. This goes in `main.ts` as a new
background listener, or (simpler) the Slack container makes LLM calls
directly — see Phase B, Step B3.

**Decision:** Skip this RPC endpoint entirely. The Slack container will
make its own LLM calls directly using `@mariozechner/pi-agent-core` — the
same library the engine uses. This eliminates the most complex RPC path
and is simpler than proxying through the engine. Provider keys are fetched
from the API at startup (same as the engine does via
`syncProviderApiKeysToDb`).

---

### Phase B: Create the Slack Container Package (2–3 days)

#### Step B1: Create `packages/slack-service/` directory structure

```
packages/slack-service/
├── package.json
├── tsconfig.json
├── src/
│   ├── main.ts              # Entry point
│   ├── api-client.ts         # HTTP client replacing callbacks
│   ├── redis-event-bridge.ts # Direct Redis subscriptions replacing EventBus
│   ├── llm-client.ts         # Direct LLM calls (replaces onDecisionNeeded)
│   └── config.ts             # Environment configuration
```

#### Step B2: Create `packages/slack-service/package.json`

```json
{
  "name": "@djinnbot/slack-service",
  "version": "0.1.0",
  "type": "module",
  "main": "dist/main.js",
  "scripts": {
    "build": "tsc",
    "dev": "tsc --watch",
    "start": "node dist/main.js"
  },
  "dependencies": {
    "@djinnbot/slack": "*",
    "@djinnbot/core": "*",
    "@mariozechner/pi-agent-core": "^0.4.0",
    "@mariozechner/pi-ai": "^0.4.0",
    "ioredis": "^5.4.0"
  },
  "devDependencies": {
    "typescript": "^5.7.0"
  }
}
```

#### Step B3: Create `packages/slack-service/src/config.ts`

```typescript
/**
 * Slack service configuration from environment variables.
 */
export const CONFIG = {
  redisUrl: process.env.REDIS_URL || 'redis://redis:6379',
  apiBaseUrl: process.env.DJINNBOT_API_URL || 'http://api:8000',
  internalToken: process.env.ENGINE_INTERNAL_TOKEN || '',
  agentsDir: process.env.AGENTS_DIR || '/agents',
  slackChannelId: process.env.SLACK_CHANNEL_ID || '',
  defaultSlackDecisionModel:
    process.env.DEFAULT_SLACK_DECISION_MODEL || 'openrouter/minimax/minimax-m2.5',
} as const;
```

#### Step B4: Create `packages/slack-service/src/api-client.ts`

This replaces all in-process callbacks with HTTP calls to the API server.

```typescript
/**
 * ApiClient — HTTP client that replaces the in-process callbacks
 * the SlackBridge previously received from the engine.
 *
 * All calls use ENGINE_INTERNAL_TOKEN for auth (same as engine→API calls).
 */

import { CONFIG } from './config.js';

function authHeaders(extra?: Record<string, string>): Record<string, string> {
  const headers: Record<string, string> = {};
  if (CONFIG.internalToken) {
    headers['Authorization'] = `Bearer ${CONFIG.internalToken}`;
  }
  return { ...headers, ...extra };
}

async function apiFetch(path: string, init?: RequestInit): Promise<Response> {
  const url = `${CONFIG.apiBaseUrl}${path}`;
  const headers = new Headers(init?.headers);
  if (CONFIG.internalToken && !headers.has('Authorization')) {
    headers.set('Authorization', `Bearer ${CONFIG.internalToken}`);
  }
  return fetch(url, { ...init, headers });
}

// ── Memory Search (replaces onMemorySearch) ──────────────────────────────

export async function searchMemory(
  agentId: string,
  query: string,
  limit: number = 5,
): Promise<Array<{ title: string; snippet: string; category: string }>> {
  try {
    const res = await apiFetch('/v1/internal/slack/memory-search', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ agent_id: agentId, query, limit }),
    });
    if (!res.ok) return [];
    return await res.json() as Array<{ title: string; snippet: string; category: string }>;
  } catch (err) {
    console.warn(`[ApiClient] Memory search failed for ${agentId}:`, err);
    return [];
  }
}

// ── Feedback (replaces onFeedback) ───────────────────────────────────────

export async function storeFeedback(
  agentId: string,
  feedback: 'positive' | 'negative',
  responseText: string,
  userName: string,
): Promise<void> {
  try {
    await apiFetch('/v1/internal/slack/feedback', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        agent_id: agentId,
        feedback,
        response_text: responseText,
        user_name: userName,
      }),
    });
  } catch (err) {
    console.warn(`[ApiClient] Store feedback failed for ${agentId}:`, err);
  }
}

// ── Persona Loading (replaces onLoadPersona) ─────────────────────────────

export async function loadPersona(
  agentId: string,
  sessionContext: {
    sessionType: 'slack' | 'pulse' | 'pipeline';
    channelContext?: string;
    installedTools?: string[];
  },
): Promise<{
  systemPrompt: string;
  identity: string;
  soul: string;
  agents: string;
  decision: string;
}> {
  const res = await apiFetch('/v1/internal/slack/load-persona', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      agent_id: agentId,
      session_type: sessionContext.sessionType,
      channel_context: sessionContext.channelContext,
      installed_tools: sessionContext.installedTools,
    }),
  });
  if (!res.ok) {
    throw new Error(`Load persona failed: ${res.status}`);
  }
  return await res.json();
}

// ── Chat Session Lifecycle (replaces direct ChatSessionManager calls) ────

export async function startChatSession(params: {
  sessionId: string;
  agentId: string;
  model: string;
  externalHistory?: Array<{ role: string; content: string; created_at: number }>;
  userId?: string;
}): Promise<void> {
  const res = await apiFetch('/v1/internal/slack/sessions/start', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      session_id: params.sessionId,
      agent_id: params.agentId,
      model: params.model,
      external_history: params.externalHistory,
      user_id: params.userId,
    }),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(`Start session failed: ${res.status} ${(err as any).detail || ''}`);
  }
}

export async function sendChatMessage(params: {
  sessionId: string;
  message: string;
  model?: string;
  messageId?: string;
  attachments?: Array<{ id: string; filename: string; mimeType: string; sizeBytes: number; isImage: boolean; estimatedTokens?: number }>;
}): Promise<void> {
  const res = await apiFetch('/v1/internal/slack/sessions/message', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      session_id: params.sessionId,
      message: params.message,
      model: params.model,
      message_id: params.messageId,
      attachments: params.attachments,
    }),
  });
  if (!res.ok) {
    throw new Error(`Send message failed: ${res.status}`);
  }
}

export async function stopChatSession(sessionId: string): Promise<void> {
  await apiFetch('/v1/internal/slack/sessions/stop', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ session_id: sessionId }),
  });
}

export async function consolidateSession(sessionId: string): Promise<void> {
  await apiFetch('/v1/internal/slack/sessions/consolidate', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ session_id: sessionId }),
  });
}

export async function isSessionActive(sessionId: string): Promise<boolean> {
  try {
    const res = await apiFetch(`/v1/internal/slack/sessions/${sessionId}/active`);
    if (!res.ok) return false;
    const data = await res.json() as { active: boolean };
    return data.active;
  } catch {
    return false;
  }
}

// ── Agent Registry (replaces AgentRegistry filesystem scan) ──────────────

export async function fetchAgents(): Promise<any[]> {
  const res = await apiFetch('/v1/agents');
  if (!res.ok) throw new Error(`Fetch agents failed: ${res.status}`);
  return await res.json() as any[];
}

export async function fetchAgentChannelKeys(agentId: string): Promise<Record<string, any>> {
  const res = await apiFetch(`/v1/agents/${agentId}/channels/keys/all`);
  if (!res.ok) return {};
  const data = await res.json() as { channels: Record<string, any> };
  return data.channels ?? {};
}

// ── Provider Keys (for direct LLM calls) ─────────────────────────────────

export async function fetchProviderKeys(): Promise<Record<string, string>> {
  const res = await apiFetch('/v1/settings/providers/keys/all');
  if (!res.ok) return {};
  const data = await res.json() as { keys: Record<string, string>; extra?: Record<string, string> };
  return { ...data.keys, ...data.extra };
}
```

#### Step B5: Create `packages/slack-service/src/llm-client.ts`

This replaces `onDecisionNeeded` — the Slack container makes LLM calls
directly instead of proxying through the engine.

```typescript
/**
 * Direct LLM client for Slack triage decisions.
 *
 * Replaces the onDecisionNeeded callback. The Slack container loads
 * provider API keys from the DjinnBot API at startup and makes LLM
 * calls directly using @mariozechner/pi-agent-core.
 */

import { Agent } from '@mariozechner/pi-agent-core';
import { registerBuiltInApiProviders } from '@mariozechner/pi-ai';
import { parseModelString } from '@djinnbot/core';

let initialized = false;

export function ensureProviders(): void {
  if (!initialized) {
    registerBuiltInApiProviders();
    initialized = true;
  }
}

/**
 * Make a lightweight LLM call for Slack triage decisions.
 * This is the same logic as main.ts:1271-1306 in the engine.
 */
export async function makeDecision(
  systemPrompt: string,
  userPrompt: string,
  modelString: string,
): Promise<string> {
  ensureProviders();

  const model = parseModelString(modelString);
  const agent = new Agent({
    initialState: {
      systemPrompt,
      model,
      messages: [],
    },
  });

  let output = '';
  const unsubscribe = agent.subscribe((event: any) => {
    if (
      event.type === 'message_update' &&
      event.assistantMessageEvent?.type === 'text_delta'
    ) {
      output += event.assistantMessageEvent.delta;
    }
  });

  await agent.prompt(userPrompt);
  await agent.waitForIdle();
  unsubscribe();

  return output;
}
```

#### Step B6: Create `packages/slack-service/src/redis-event-bridge.ts`

This replaces the `EventBus` dependency for pipeline event subscriptions.

```typescript
/**
 * RedisEventBridge — subscribes to pipeline event Redis streams directly.
 *
 * Replaces EventBus.subscribe() which required the engine's EventBus instance.
 * The underlying protocol is identical (XREAD on djinnbot:events:run:{runId}).
 */

import { Redis } from 'ioredis';

export class RedisEventBridge {
  private subscriber: Redis;
  private abortControllers = new Map<string, AbortController>();
  private running = true;

  constructor(private redisUrl: string) {
    this.subscriber = new Redis(redisUrl, {
      maxRetriesPerRequest: null,
    });
  }

  /**
   * Subscribe to pipeline events for a specific run.
   * Returns an unsubscribe function.
   */
  subscribe(
    channel: string,
    callback: (event: any) => void | Promise<void>,
  ): () => void {
    const ac = new AbortController();
    this.abortControllers.set(channel, ac);

    let lastId = '0';

    const listen = async () => {
      // Create a dedicated connection for this subscription
      const conn = new Redis(this.redisUrl, { maxRetriesPerRequest: null });

      while (!ac.signal.aborted && this.running) {
        try {
          const results = await conn.xread(
            'BLOCK', 5000,
            'STREAMS', channel,
            lastId,
          );

          if (!results) continue;

          for (const [, messages] of results) {
            for (const [id, fields] of messages as any[]) {
              lastId = id;
              const dataIdx = fields.findIndex((f: string) => f === 'data');
              if (dataIdx !== -1 && dataIdx + 1 < fields.length) {
                try {
                  const event = JSON.parse(fields[dataIdx + 1]);
                  await callback(event);
                } catch { /* parse error */ }
              }
            }
          }
        } catch (err) {
          if (ac.signal.aborted) break;
          console.error(`[RedisEventBridge] Error on ${channel}:`, err);
          await new Promise(r => setTimeout(r, 1000));
        }
      }

      await conn.quit().catch(() => {});
    };

    listen().catch(console.error);

    return () => {
      ac.abort();
      this.abortControllers.delete(channel);
    };
  }

  async close(): Promise<void> {
    this.running = false;
    for (const ac of this.abortControllers.values()) {
      ac.abort();
    }
    this.abortControllers.clear();
    await this.subscriber.quit();
  }
}
```

#### Step B7: Create `packages/slack-service/src/remote-session-manager.ts`

This implements the `ChatSessionManager` interface expected by `SlackSessionPool`,
but proxies all calls to the API instead of managing containers directly.

```typescript
/**
 * RemoteChatSessionManager — implements the ChatSessionManager interface
 * from SlackSessionPool's perspective, but delegates all operations to the
 * engine via the API.
 *
 * SlackSessionPool calls:
 *   - isSessionActive(sessionId)
 *   - startSession({ sessionId, agentId, model, externalHistory, userId })
 *   - sendMessage(sessionId, message, model, messageId, attachments)
 *   - stopSession(sessionId)
 *   - getSession(sessionId)
 *   - updateModel(sessionId, model)
 *
 * ChatSessionManager also has output hooks (onOutput, onToolStart, etc.)
 * that the SlackBridge registers. In the extracted architecture, these hooks
 * are driven by Redis pub/sub — the engine's ChatSessionManager publishes
 * to Redis channels (djinnbot:sessions:{sessionId}:*) and we subscribe here.
 */

import {
  startChatSession,
  sendChatMessage,
  stopChatSession,
  isSessionActive as checkActive,
  consolidateSession,
} from './api-client.js';
import { Redis } from 'ioredis';

interface OutputHooks {
  onOutput?: (sessionId: string, chunk: string) => void;
  onToolStart?: (sessionId: string, toolName: string, args: Record<string, unknown>) => void;
  onToolEnd?: (sessionId: string, toolName: string, result: string, isError: boolean, durationMs: number) => void;
  onStepEnd?: (sessionId: string, success: boolean) => void;
}

/** Minimal session info tracked locally for getSession() / updateModel(). */
interface LocalSessionInfo {
  model: string;
  agentId: string;
}

export class RemoteChatSessionManager {
  private hooks: OutputHooks = {};
  private subscriber: Redis;
  private sessionSubscriptions = new Map<string, Redis>();
  private localSessions = new Map<string, LocalSessionInfo>();

  constructor(private redisUrl: string) {
    this.subscriber = new Redis(redisUrl);
  }

  registerHooks(hooks: OutputHooks): void {
    this.hooks = hooks;
  }

  isSessionActive(sessionId: string): boolean {
    // Local fast check — the session was registered by startSession()
    return this.localSessions.has(sessionId);
  }

  getSession(sessionId: string): { model: string } | undefined {
    const info = this.localSessions.get(sessionId);
    return info ? { model: info.model } : undefined;
  }

  updateModel(sessionId: string, model: string): void {
    const info = this.localSessions.get(sessionId);
    if (info) info.model = model;
    // The actual model change command is sent via sendMessage with the new model
  }

  async startSession(config: {
    sessionId: string;
    agentId: string;
    model: string;
    externalHistory?: Array<{ role: string; content: string; created_at: number }>;
    userId?: string;
  }): Promise<void> {
    // Track locally
    this.localSessions.set(config.sessionId, {
      model: config.model,
      agentId: config.agentId,
    });

    // Subscribe to output events from the engine's ChatSessionManager
    this.subscribeToSessionEvents(config.sessionId);

    // Forward to engine via API
    await startChatSession(config);
  }

  async sendMessage(
    sessionId: string,
    message: string,
    model?: string,
    messageId?: string,
    attachments?: any[],
  ): Promise<void> {
    await sendChatMessage({ sessionId, message, model, messageId, attachments });
  }

  async stopSession(sessionId: string): Promise<void> {
    this.localSessions.delete(sessionId);
    this.unsubscribeFromSessionEvents(sessionId);
    await stopChatSession(sessionId);
  }

  async triggerConsolidation(sessionId: string): Promise<void> {
    await consolidateSession(sessionId);
  }

  /**
   * Subscribe to the Redis pub/sub channel where the engine's
   * ChatSessionManager publishes output/tool/step events for a session.
   *
   * Channel: djinnbot:sessions:{sessionId}:events
   * Format: JSON with { type, timestamp, data }
   */
  private subscribeToSessionEvents(sessionId: string): void {
    const channel = `djinnbot:sessions:${sessionId}:events`;
    const sub = new Redis(this.redisUrl);

    sub.subscribe(channel).catch(err => {
      console.warn(`[RemoteCSM] Failed to subscribe to ${channel}:`, err);
    });

    sub.on('message', (_ch: string, message: string) => {
      try {
        const event = JSON.parse(message);
        this.handleSessionEvent(sessionId, event);
      } catch { /* ignore parse errors */ }
    });

    this.sessionSubscriptions.set(sessionId, sub);
  }

  private unsubscribeFromSessionEvents(sessionId: string): void {
    const sub = this.sessionSubscriptions.get(sessionId);
    if (sub) {
      sub.quit().catch(() => {});
      this.sessionSubscriptions.delete(sessionId);
    }
  }

  private handleSessionEvent(sessionId: string, event: any): void {
    switch (event.type) {
      case 'output':
        this.hooks.onOutput?.(sessionId, event.data?.content ?? '');
        break;
      case 'tool_start':
        this.hooks.onToolStart?.(
          sessionId,
          event.data?.toolName ?? '',
          (event.data?.args as Record<string, unknown>) ?? {},
        );
        break;
      case 'tool_end':
        this.hooks.onToolEnd?.(
          sessionId,
          event.data?.toolName ?? '',
          String(event.data?.result ?? ''),
          !event.data?.success,
          event.data?.durationMs ?? 0,
        );
        break;
      case 'step_end':
        this.hooks.onStepEnd?.(sessionId, event.data?.success ?? false);
        // Clean up local tracking
        this.localSessions.delete(sessionId);
        this.unsubscribeFromSessionEvents(sessionId);
        break;
    }
  }

  async shutdown(): Promise<void> {
    for (const sub of this.sessionSubscriptions.values()) {
      await sub.quit().catch(() => {});
    }
    this.sessionSubscriptions.clear();
    this.localSessions.clear();
    await this.subscriber.quit();
  }
}
```

#### Step B8: Create `packages/slack-service/src/main.ts`

The entry point — replaces the Slack-related code in `packages/core/src/main.ts`.

```typescript
#!/usr/bin/env node
/**
 * DjinnBot Slack Service
 *
 * Standalone container that runs the Slack bridge independently from the engine.
 * Communicates with the engine via Redis (event streams, pub/sub) and the
 * DjinnBot API (agent config, memory, chat sessions).
 */

import { Redis } from 'ioredis';
import { SlackBridge, type SlackBridgeConfig } from '@djinnbot/slack';
import { AgentRegistry, type AgentRegistryEntry } from '@djinnbot/core';
import { CONFIG } from './config.js';
import * as apiClient from './api-client.js';
import { makeDecision, ensureProviders } from './llm-client.js';
import { RedisEventBridge } from './redis-event-bridge.js';
import { RemoteChatSessionManager } from './remote-session-manager.js';

let isShuttingDown = false;
let slackBridge: SlackBridge | null = null;
let eventBridge: RedisEventBridge | null = null;
let remoteCSM: RemoteChatSessionManager | null = null;

/**
 * Load provider API keys from the DB into process.env so that
 * @mariozechner/pi-agent-core can find them for LLM calls.
 */
async function loadProviderKeys(): Promise<void> {
  const keys = await apiClient.fetchProviderKeys();
  for (const [key, value] of Object.entries(keys)) {
    if (value && !process.env[key]) {
      process.env[key] = value;
    }
  }
  console.log(`[Slack] Loaded ${Object.keys(keys).length} provider keys from DB`);
}

/**
 * Load global settings (decision model, user slack ID) from Redis.
 */
async function loadGlobalSettings(
  redis: Redis,
): Promise<{ defaultSlackDecisionModel: string; userSlackId: string }> {
  const SETTINGS_KEY = 'djinnbot:global:settings';
  const defaults = {
    defaultSlackDecisionModel: CONFIG.defaultSlackDecisionModel,
    userSlackId: '',
  };

  try {
    const data = await redis.get(SETTINGS_KEY);
    if (data) {
      return { ...defaults, ...JSON.parse(data) };
    }
  } catch (e) {
    console.warn('[Slack] Failed to load global settings:', e);
  }

  return defaults;
}

async function main(): Promise<void> {
  console.log('[Slack] Starting DjinnBot Slack Service');

  // Load provider keys for direct LLM calls
  await loadProviderKeys();
  ensureProviders();

  const redis = new Redis(CONFIG.redisUrl);
  const settings = await loadGlobalSettings(redis);
  redis.disconnect();

  // Initialize the agent registry from the filesystem
  // (agents dir is mounted read-only, same as the engine)
  const agentRegistry = new AgentRegistry(CONFIG.agentsDir);
  await agentRegistry.discover();
  console.log(`[Slack] Discovered ${agentRegistry.getIds().length} agents`);

  // Initialize event bridge (replaces EventBus for pipeline subscriptions)
  eventBridge = new RedisEventBridge(CONFIG.redisUrl);

  // Initialize remote ChatSessionManager
  remoteCSM = new RemoteChatSessionManager(CONFIG.redisUrl);

  // Build the SlackBridge with API-backed callbacks
  const bridgeConfig: SlackBridgeConfig = {
    eventBus: eventBridge as any,  // RedisEventBridge implements the subscribe interface
    agentRegistry: agentRegistry as any,
    defaultChannelId: CONFIG.slackChannelId || undefined,

    // LLM triage — direct call, no engine proxy
    onDecisionNeeded: async (
      agentId: string,
      systemPrompt: string,
      userPrompt: string,
      model: string,
    ) => {
      return makeDecision(systemPrompt, userPrompt, model);
    },

    // Memory search — API call
    onMemorySearch: async (agentId, query, limit) => {
      return apiClient.searchMemory(agentId, query, limit);
    },

    // Persona loading — API call
    onLoadPersona: async (agentId, sessionContext) => {
      return apiClient.loadPersona(agentId, sessionContext);
    },

    // Feedback — API call
    onFeedback: async (agentId, feedback, responseText, userName) => {
      return apiClient.storeFeedback(agentId, feedback, responseText, userName);
    },

    // ChatSessionManager — remote proxy
    chatSessionManager: remoteCSM as any,

    defaultSlackDecisionModel: settings.defaultSlackDecisionModel,
    userSlackId: settings.userSlackId || undefined,

    onBeforeTeardown: async (sessionId: string, _agentId: string) => {
      await apiClient.consolidateSession(sessionId);
    },
  };

  slackBridge = new SlackBridge(bridgeConfig);
  await slackBridge.start();

  console.log('[Slack] Slack bridge started');

  // Listen for run subscription requests from the engine
  // (the engine publishes these when a pipeline run starts and has Slack config)
  await listenForRunSubscriptions();
}

/**
 * Listen for pipeline run Slack subscription requests.
 *
 * When the engine starts a pipeline run that has Slack notifications enabled,
 * it publishes a message to djinnbot:slack:subscribe_run. This listener
 * picks it up and calls slackBridge.subscribeToRun().
 */
async function listenForRunSubscriptions(): Promise<void> {
  const sub = new Redis(CONFIG.redisUrl);
  const channel = 'djinnbot:slack:subscribe_run';

  await sub.subscribe(channel);
  console.log(`[Slack] Listening for run subscription requests on ${channel}`);

  sub.on('message', (_ch: string, message: string) => {
    try {
      const data = JSON.parse(message);
      if (slackBridge && data.runId) {
        slackBridge.subscribeToRun(
          data.runId,
          data.pipelineId,
          data.taskDescription,
          data.assignedAgentIds ?? [],
          data.slackChannelId,
          data.slackNotifyUserId,
        );
      }
    } catch (err) {
      console.error('[Slack] Failed to process run subscription:', err);
    }
  });
}

async function shutdown(signal: string): Promise<void> {
  if (isShuttingDown) return;
  isShuttingDown = true;

  console.log(`[Slack] Received ${signal}, shutting down...`);

  await slackBridge?.shutdown();
  await eventBridge?.close();
  await remoteCSM?.shutdown();

  console.log('[Slack] Shutdown complete');
  process.exit(0);
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

main().catch((err) => {
  console.error('[Slack] Fatal error:', err);
  process.exit(1);
});
```

---

### Phase C: Update the Engine to Publish Instead of Call (1–2 days)

#### Step C1: Modify `djinnbot.ts` to make Slack bridge optional

**File:** `packages/core/src/djinnbot.ts`

The engine should no longer start the Slack bridge. The `startSlackBridge()`
method becomes a no-op (or is removed entirely). Pipeline runs that need
Slack notifications publish to Redis instead.

Find `subscribeToRunEvents()` (around line 1397) where the engine calls
`this.slackBridge.subscribeToRun()`. Replace with a Redis publish:

```typescript
// BEFORE (djinnbot.ts:1397-1430):
if (this.slackBridge) {
  // ... fetch project Slack config ...
  this.slackBridge.subscribeToRun(
    runId, pipelineId, taskDescription, agentIds,
    slackChannelId, slackNotifyUserId,
  );
}

// AFTER:
if (this.redis) {
  // Publish to Redis so the standalone Slack container can pick it up
  this.redis.publish('djinnbot:slack:subscribe_run', JSON.stringify({
    runId,
    pipelineId,
    taskDescription,
    assignedAgentIds: agentIds,
    slackChannelId,
    slackNotifyUserId,
  }));
}
```

#### Step C2: Remove Slack wiring from `main.ts`

**File:** `packages/core/src/main.ts`

Remove or comment out these sections:

1. **Lines 1260-1328**: The `startSlackBridge()` call and all its callback wiring
2. **Lines 1418-1440**: The `setChatSessionManager()` injection into Slack bridge
3. **Lines 228-248**: All `SLACK_*` env var declarations in docker-compose (moved to slack service)

Keep the `@djinnbot/slack` package dependency for now — it can be removed
from the engine's package.json in a follow-up cleanup.

#### Step C3: Engine publishes session events to Redis pub/sub

The engine's `ChatSessionManager` already publishes to Redis channels
(`djinnbot:sessions:{sessionId}:events`) via its `publishToChannel()` method.
Verify that all output hooks (onOutput, onToolStart, onToolEnd, onStepEnd)
publish to this channel. If any are in-memory-only, add Redis publishing.

**File:** `packages/core/src/chat/chat-session-manager.ts`

Check the `publishToChannel` method (around line 2081). It currently writes
to a Redis stream for replay. Ensure the output hook events (`output`,
`tool_start`, `tool_end`, `step_end`) are also published via Redis PUBLISH
(pub/sub) so the Slack container's `RemoteChatSessionManager` can receive
them in real-time.

If `publishToChannel` only uses `XADD` (streams), add a parallel `PUBLISH`
for the output hook event types:

```typescript
// In setupEventHandlers(), after the existing publishToChannel call:
if (['output', 'tool_start', 'tool_end', 'step_end'].includes(normalizedType)) {
  this.publishRedis.publish(
    `djinnbot:sessions:${sessionId}:events`,
    JSON.stringify({ type: normalizedType, timestamp: Date.now(), data: msg }),
  ).catch(() => {});
}
```

---

### Phase D: Docker Infrastructure (1 day)

#### Step D1: Create `Dockerfile.slack`

The Slack service is a lightweight Node.js container — it does NOT need
all the heavy tooling from `Dockerfile.engine` (no Go, Rust, Docker CLI,
qmd, clawvault, etc.). It only needs Node.js and the Slack/core packages.

```dockerfile
# Stage 1: TypeScript Builder
FROM node:22-slim AS ts-builder

RUN apt-get update && apt-get install -y --no-install-recommends \
    git ca-certificates build-essential cmake g++ python3 \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /build

# Copy workspace files
COPY package.json package-lock.json tsconfig.base.json ./
COPY packages/core/package.json ./packages/core/
COPY packages/slack/package.json ./packages/slack/
COPY packages/slack-service/package.json ./packages/slack-service/

# Install all deps
RUN npm install --include=dev

# Copy source
COPY packages/core ./packages/core
COPY packages/slack ./packages/slack
COPY packages/slack-service ./packages/slack-service

# Build TypeScript (core → slack → slack-service)
RUN rm -rf packages/core/dist packages/slack/dist packages/slack-service/dist
RUN npm run build -w @djinnbot/core
RUN npm run build -w @djinnbot/slack
RUN npm run build -w @djinnbot/slack-service

# Stage 2: Production Runtime
FROM node:22-slim

WORKDIR /app

# Copy workspace files
COPY package.json package-lock.json ./
COPY packages/core/package.json ./packages/core/
COPY packages/slack/package.json ./packages/slack/
COPY packages/slack-service/package.json ./packages/slack-service/

# Install production deps only
RUN npm install --omit=dev

# Copy built code
COPY --from=ts-builder /build/packages/core/dist ./packages/core/dist
COPY --from=ts-builder /build/packages/slack/dist ./packages/slack/dist
COPY --from=ts-builder /build/packages/slack-service/dist ./packages/slack-service/dist

# Version
ARG BUILD_VERSION=dev
ENV DJINNBOT_BUILD_VERSION=${BUILD_VERSION}
ENV NODE_ENV=production

CMD ["node", "packages/slack-service/dist/main.js"]
```

#### Step D2: Add `slack` service to `docker-compose.yml`

Add this after the `engine` service definition (around line 292):

```yaml
  slack:
    build:
      context: .
      dockerfile: Dockerfile.slack
    container_name: djinnbot-slack
    environment:
      - REDIS_URL=redis://redis:6379
      - DJINNBOT_API_URL=http://api:8000
      - AGENTS_DIR=/agents
      - ENGINE_INTERNAL_TOKEN=${ENGINE_INTERNAL_TOKEN:-}
      - SLACK_CHANNEL_ID=${SLACK_CHANNEL_ID:-}
      # All Slack bot/app tokens
      - SLACK_CHIEKO_BOT_TOKEN=${SLACK_CHIEKO_BOT_TOKEN:-}
      - SLACK_CHIEKO_APP_TOKEN=${SLACK_CHIEKO_APP_TOKEN:-}
      - SLACK_ERIC_BOT_TOKEN=${SLACK_ERIC_BOT_TOKEN:-}
      - SLACK_ERIC_APP_TOKEN=${SLACK_ERIC_APP_TOKEN:-}
      - SLACK_FINN_BOT_TOKEN=${SLACK_FINN_BOT_TOKEN:-}
      - SLACK_FINN_APP_TOKEN=${SLACK_FINN_APP_TOKEN:-}
      - SLACK_HOLT_BOT_TOKEN=${SLACK_HOLT_BOT_TOKEN:-}
      - SLACK_HOLT_APP_TOKEN=${SLACK_HOLT_APP_TOKEN:-}
      - SLACK_JIM_BOT_TOKEN=${SLACK_JIM_BOT_TOKEN:-}
      - SLACK_JIM_APP_TOKEN=${SLACK_JIM_APP_TOKEN:-}
      - SLACK_LUKE_BOT_TOKEN=${SLACK_LUKE_BOT_TOKEN:-}
      - SLACK_LUKE_APP_TOKEN=${SLACK_LUKE_APP_TOKEN:-}
      - SLACK_SHIGEO_BOT_TOKEN=${SLACK_SHIGEO_BOT_TOKEN:-}
      - SLACK_SHIGEO_APP_TOKEN=${SLACK_SHIGEO_APP_TOKEN:-}
      - SLACK_STAS_BOT_TOKEN=${SLACK_STAS_BOT_TOKEN:-}
      - SLACK_STAS_APP_TOKEN=${SLACK_STAS_APP_TOKEN:-}
      - SLACK_YANG_BOT_TOKEN=${SLACK_YANG_BOT_TOKEN:-}
      - SLACK_YANG_APP_TOKEN=${SLACK_YANG_APP_TOKEN:-}
      - SLACK_YUKIHIRO_BOT_TOKEN=${SLACK_YUKIHIRO_BOT_TOKEN:-}
      - SLACK_YUKIHIRO_APP_TOKEN=${SLACK_YUKIHIRO_APP_TOKEN:-}
      # Provider keys for direct LLM triage calls
      - OPENROUTER_API_KEY=${OPENROUTER_API_KEY:-}
    volumes:
      - ./agents:/agents:ro
    networks:
      - djinnbot_default
    depends_on:
      api:
        condition: service_healthy
      redis:
        condition: service_healthy
    restart: unless-stopped
```

#### Step D3: Remove Slack env vars from the engine service

**File:** `docker-compose.yml`, engine service (lines 228-248)

Remove all `SLACK_*_BOT_TOKEN` and `SLACK_*_APP_TOKEN` env vars from the
engine service. Also remove `SLACK_CHANNEL_ID`. The engine no longer
needs these.

#### Step D4: Add to `docker-compose.ghcr.yml`

Mirror the same service definition for the GHCR (pre-built image) compose
file, using the published image:

```yaml
  slack:
    image: ${SLACK_IMAGE:-ghcr.io/basedatum/djinnbot/slack:${DJINNBOT_VERSION:-latest}}
    container_name: djinnbot-slack
    # ... same environment and volumes as above ...
```

---

### Phase E: Interface Compatibility (1–2 days)

The `SlackBridge` constructor expects specific types from `@djinnbot/core`:
`EventBus`, `AgentRegistry`, and `ChatSessionManager`. The standalone Slack
container provides different implementations. This phase ensures type
compatibility.

#### Step E1: Extract interfaces from concrete classes

**File:** `packages/core/src/events/event-bus.ts`

Export a minimal interface that `RedisEventBridge` can implement:

```typescript
/** Minimal event subscription interface used by SlackBridge. */
export interface IEventSubscriber {
  subscribe(
    channel: string,
    callback: (event: any) => void | Promise<void>,
  ): () => void;
}
```

Update `SlackBridgeConfig` in `packages/slack/src/slack-bridge.ts` to
accept `IEventSubscriber` instead of the concrete `EventBus`:

```typescript
// BEFORE:
import { EventBus, ... } from '@djinnbot/core';

export interface SlackBridgeConfig {
  eventBus: EventBus;
  // ...
}

// AFTER:
import { type IEventSubscriber, ... } from '@djinnbot/core';

export interface SlackBridgeConfig {
  eventBus: IEventSubscriber;
  // ...
}
```

#### Step E2: Extract `IChatSessionManager` interface

**File:** `packages/core/src/chat/chat-session-manager.ts`

```typescript
/** Minimal interface used by SlackSessionPool / SlackBridge. */
export interface IChatSessionManager {
  isSessionActive(sessionId: string): boolean;
  getSession(sessionId: string): { model: string } | undefined;
  updateModel(sessionId: string, model: string): void;
  startSession(config: ChatSessionConfig): Promise<void>;
  sendMessage(
    sessionId: string,
    message: string,
    model?: string,
    messageId?: string,
    attachments?: any[],
  ): Promise<void>;
  stopSession(sessionId: string): Promise<void>;
  triggerConsolidation(sessionId: string, minTurns?: number): Promise<void>;
  registerHooks(hooks: {
    onOutput?: (sessionId: string, chunk: string) => void;
    onToolStart?: (sessionId: string, toolName: string, args: Record<string, unknown>) => void;
    onToolEnd?: (sessionId: string, toolName: string, result: string, isError: boolean, durationMs: number) => void;
    onStepEnd?: (sessionId: string, success: boolean) => void;
  }): void;
}
```

Update `SlackSessionPool` and `SlackBridge` to use `IChatSessionManager`
instead of the concrete `ChatSessionManager`.

---

### Phase F: Remove Hardcoded Paths from agent-slack-runtime.ts (0.5 days)

#### Step F1: Remove hardcoded `/data/vaults/` and `/data/workspaces/` paths

**File:** `packages/slack/src/agent-slack-runtime.ts`

The 8 hardcoded path references fall into two categories:

**System prompt context (lines 220-221):** These tell the LLM where the
agent's files are. They should use the agent's actual config or env vars:

```typescript
// BEFORE (line 220-221):
sections.push(`- **Workspace**: \`/data/workspaces/${this.agentId}\` — Your persistent working directory`);
sections.push(`- **Memory Vault**: \`/data/vaults/${this.agentId}\` — Use \`recall\` tool to search`);

// AFTER:
const workspacesDir = process.env.WORKSPACES_DIR || '/data/workspaces';
const vaultsDir = process.env.VAULTS_DIR || '/data/vaults';
sections.push(`- **Workspace**: \`${workspacesDir}/${this.agentId}\` — Your persistent working directory`);
sections.push(`- **Memory Vault**: \`${vaultsDir}/${this.agentId}\` — Use \`recall\` tool to search`);
```

**onRunFullSession parameters (lines 1165-1166, 1231-1232, 1301-1302, 1903-1904):**
These are passed to the engine when spawning containers. Same fix:

```typescript
// BEFORE (repeated 4 times):
workspacePath: `/data/workspaces/${this.agentId}`,
vaultPath: `/data/vaults/${this.agentId}`,

// AFTER (repeated 4 times):
workspacePath: `${process.env.WORKSPACES_DIR || '/data/workspaces'}/${this.agentId}`,
vaultPath: `${process.env.VAULTS_DIR || '/data/vaults'}/${this.agentId}`,
```

---

## 5. Migration Strategy

### 5.1 Phase-in with Feature Flag

Run both paths simultaneously during migration:

1. Add `SLACK_STANDALONE=true` env var
2. If `SLACK_STANDALONE=true`, the engine skips `startSlackBridge()`
3. The `slack` container starts and takes over
4. If `SLACK_STANDALONE=false` (default), the engine runs Slack as before

This allows zero-downtime migration:

```yaml
# docker-compose.yml
engine:
  environment:
    - SLACK_STANDALONE=${SLACK_STANDALONE:-false}

slack:
  # Only starts when SLACK_STANDALONE=true
  profiles:
    - slack-standalone
```

Activate with:
```bash
SLACK_STANDALONE=true docker compose --profile slack-standalone up -d
```

### 5.2 Rollback Plan

If the standalone Slack container has issues:

```bash
# Stop standalone, re-enable engine Slack
SLACK_STANDALONE=false docker compose up -d engine
docker compose stop slack
```

---

## 6. Testing Plan

### 6.1 Unit Tests

| Test | Covers |
|------|--------|
| `api-client.test.ts` | HTTP calls with mock responses |
| `llm-client.test.ts` | Direct LLM call with mock provider |
| `redis-event-bridge.test.ts` | Redis XREAD subscription |
| `remote-session-manager.test.ts` | Session lifecycle via API |

### 6.2 Integration Tests

| Test | Covers |
|------|--------|
| Slack DM → container session → response | End-to-end Slack conversation |
| Pipeline run → Slack thread creation | Event bridge + subscribeToRun |
| Idle timeout → consolidation → teardown | Memory consolidation flow |
| Engine restart → Slack container unaffected | Fault isolation |
| Slack container restart → reconnects | Reconnection/recovery |

### 6.3 Manual Smoke Tests

1. Send a DM to an agent → verify response streams to Slack
2. @mention an agent in a channel → verify triage + response
3. Start a pipeline run with Slack config → verify thread creation
4. Check that pipeline step output streams to the Slack thread
5. Restart the engine → verify Slack conversations survive
6. Restart the Slack container → verify it reconnects to Slack websockets

---

## 7. Files Modified Summary

### New Files

| File | Purpose |
|------|---------|
| `packages/slack-service/package.json` | New package |
| `packages/slack-service/tsconfig.json` | TypeScript config |
| `packages/slack-service/src/main.ts` | Entry point |
| `packages/slack-service/src/config.ts` | Environment config |
| `packages/slack-service/src/api-client.ts` | HTTP client (replaces callbacks) |
| `packages/slack-service/src/llm-client.ts` | Direct LLM calls |
| `packages/slack-service/src/redis-event-bridge.ts` | Redis event subscriptions |
| `packages/slack-service/src/remote-session-manager.ts` | Remote ChatSessionManager proxy |
| `packages/server/app/routers/internal_slack.py` | New API endpoints |
| `Dockerfile.slack` | Lightweight container image |

### Modified Files

| File | Change |
|------|--------|
| `packages/server/app/main.py` | Register `internal_slack` router |
| `packages/core/src/main.ts` | Remove Slack bridge startup (behind feature flag) |
| `packages/core/src/djinnbot.ts` | Replace `subscribeToRun` with Redis publish |
| `packages/core/src/chat/chat-listener.ts` | Add `chat:consolidate` command |
| `packages/core/src/chat/chat-session-manager.ts` | Export `IChatSessionManager` interface; add Redis PUBLISH for output hooks |
| `packages/core/src/events/event-bus.ts` | Export `IEventSubscriber` interface |
| `packages/slack/src/slack-bridge.ts` | Accept interfaces instead of concrete types |
| `packages/slack/src/agent-slack-runtime.ts` | Replace 8 hardcoded paths with env vars |
| `docker-compose.yml` | Add `slack` service, remove Slack env vars from engine |
| `docker-compose.ghcr.yml` | Add `slack` service |

### Files Unchanged

The `@djinnbot/slack` package itself (`slack-bridge.ts`, `slack-session-pool.ts`,
`agent-slack-runtime.ts`, `slack-streamer.ts`, `thread-manager.ts`) requires
only minor changes (interface types, env var paths). The core Slack logic
is untouched.

---

## 8. Estimated Timeline

| Phase | Days | Can parallelize? |
|-------|------|------------------|
| A: API endpoints | 2-3 | — |
| B: Slack service package | 2-3 | Yes, with A |
| C: Engine publish changes | 1-2 | After A |
| D: Docker infrastructure | 1 | After A+B |
| E: Interface compatibility | 1-2 | With B |
| F: Hardcoded path fixes | 0.5 | Anytime |
| Testing + edge cases | 2-3 | After all |
| **Total** | **~10-12 days** | |

With parallelization (two engineers): **~7-8 days**.
