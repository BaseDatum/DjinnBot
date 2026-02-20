"""
MCP / mcpo Integration API

Manages MCP servers routed through the mcpo proxy container.

Endpoints:

  Server registry (admin / UI):
    GET    /v1/mcp/                           list all MCP servers
    POST   /v1/mcp/                           create server record
    GET    /v1/mcp/{server_id}                get server
    PUT    /v1/mcp/{server_id}                update config / metadata
    DELETE /v1/mcp/{server_id}                delete server
    PATCH  /v1/mcp/{server_id}/enabled        toggle enabled flag
    PATCH  /v1/mcp/{server_id}/status         update status (called by engine)
    PATCH  /v1/mcp/{server_id}/tools          update discovered tools (called by engine)

  Container management:
    POST   /v1/mcp/restart                    signal engine to (re)write config + reload mcpo
    GET    /v1/mcp/status                     mcpo container health + server statuses

  Log streaming (bridged via Redis → SSE):
    GET    /v1/mcp/logs/stream                SSE stream of mcpo logs

  Agent tool access control:
    GET    /v1/mcp/agents/{agent_id}/tools    all tool grants for agent
    GET    /v1/mcp/agents/{agent_id}/manifest compact manifest for system prompt injection
    POST   /v1/mcp/agents/{agent_id}/{server_id}/grant   grant all tools on a server
    POST   /v1/mcp/agents/{agent_id}/{server_id}/{tool_name}/grant  grant specific tool
    DELETE /v1/mcp/agents/{agent_id}/{server_id}         revoke all tools on server
    DELETE /v1/mcp/agents/{agent_id}/{server_id}/{tool_name}        revoke specific tool

  Interactive setup session:
    POST   /v1/mcp/configure/session          spawn MCP Smith agent chat session

  Config export (called by engine):
    GET    /v1/mcp/config.json                render full mcpo config.json
"""

import json
import re
import asyncio
import os
from typing import Optional, AsyncGenerator
from fastapi import APIRouter, HTTPException, Depends
from fastapi.responses import StreamingResponse
from pydantic import BaseModel
from sqlalchemy import select, delete
from sqlalchemy.ext.asyncio import AsyncSession

from app.database import get_async_session
from app.models.mcp import McpServer, AgentMcpTool
from app.utils import now_ms
from app import dependencies
from app.logging_config import get_logger

logger = get_logger(__name__)

router = APIRouter()

MCP_RESTART_CHANNEL = "djinnbot:mcp:restart"
MCP_LOG_STREAM = "djinnbot:mcp:logs"
MCP_GRANTS_CHANGED_CHANNEL = "djinnbot:mcp:grants-changed"


async def _publish_grants_changed(agent_id: str) -> None:
    """Notify running containers that MCP tool grants changed for this agent."""
    try:
        if dependencies.redis_client:
            await dependencies.redis_client.publish(
                MCP_GRANTS_CHANGED_CHANNEL,
                json.dumps({"agent_id": agent_id}),
            )
    except Exception:
        # Best-effort — container will pick up changes on next restart
        pass


# ── Pydantic schemas ───────────────────────────────────────────────────────────


class McpServerResponse(BaseModel):
    id: str
    name: str
    description: str
    config: dict
    discovered_tools: list[str]
    status: str
    enabled: bool
    setup_agent_id: Optional[str] = None
    created_at: int
    updated_at: int


class CreateMcpServerRequest(BaseModel):
    name: str
    description: str = ""
    config: dict  # the mcpServers entry JSON
    enabled: bool = True
    setup_agent_id: Optional[str] = None


class UpdateMcpServerRequest(BaseModel):
    name: Optional[str] = None
    description: Optional[str] = None
    config: Optional[dict] = None
    enabled: Optional[bool] = None


class AgentMcpToolGrant(BaseModel):
    server_id: str
    tool_name: str
    granted_by: str = "ui"
    granted_at: int
    server_name: str
    server_status: str


class AgentMcpManifestEntry(BaseModel):
    server_id: str
    server_name: str
    tool_name: str  # "*" = all
    base_url: str  # e.g. http://djinnbot-mcpo:8000/{server_id}


class AgentMcpManifestResponse(BaseModel):
    grants: list[AgentMcpManifestEntry]
    manifest_text: str


class GrantToolRequest(BaseModel):
    granted_by: str = "ui"


class PatchStatusRequest(BaseModel):
    status: str  # 'configuring' | 'running' | 'error' | 'stopped'


class PatchToolsRequest(BaseModel):
    tools: list[str]


class StartMcpSessionRequest(BaseModel):
    agent_id: str
    model: str
    input: str  # GitHub URL, package name, or free-text description
    input_type: str = "description"  # 'github' | 'npm' | 'pypi' | 'description' | 'url'


class StartMcpSessionResponse(BaseModel):
    session_id: str
    initial_message: str


# ── Helpers ────────────────────────────────────────────────────────────────────


def _slug(name: str) -> str:
    return re.sub(r"[^a-z0-9-]", "-", name.lower().strip())[:64]


def _row_to_response(server: McpServer) -> McpServerResponse:
    config_parsed: dict = {}
    try:
        config_parsed = json.loads(server.config) if server.config else {}
    except (json.JSONDecodeError, TypeError):
        config_parsed = {}

    tools: list[str] = []
    try:
        tools = json.loads(server.discovered_tools) if server.discovered_tools else []
    except (json.JSONDecodeError, TypeError):
        tools = []

    return McpServerResponse(
        id=server.id,
        name=server.name,
        description=server.description,
        config=config_parsed,
        discovered_tools=tools,
        status=server.status,
        enabled=server.enabled,
        setup_agent_id=server.setup_agent_id,
        created_at=server.created_at,
        updated_at=server.updated_at,
    )


def _mcpo_base_url() -> str:
    return os.getenv("MCPO_BASE_URL", "http://djinnbot-mcpo:8000")


def _build_manifest_text(grants: list[AgentMcpManifestEntry]) -> str:
    if not grants:
        return ""
    lines = []
    # Group by server
    by_server: dict[str, list[AgentMcpManifestEntry]] = {}
    for g in grants:
        by_server.setdefault(g.server_id, []).append(g)

    for server_id, server_grants in by_server.items():
        server_name = server_grants[0].server_name
        base_url = server_grants[0].base_url
        lines.append(f"## {server_name} (via mcpo)")
        lines.append(f"Base URL: `{base_url}`")
        tools_listed = [g.tool_name for g in server_grants]
        if "*" in tools_listed:
            lines.append("Tools: all tools on this server")
        else:
            for t in tools_listed:
                lines.append(f"- `{t}`")
        lines.append("")

    return "\n".join(
        [
            "# MCP TOOLS",
            "",
            "You have access to MCP tools via the mcpo proxy. Call them using",
            "standard HTTP POST requests to the endpoint listed below each server.",
            "Use the mcpo OpenAPI schema at `{base_url}/docs` for full parameter details.",
            "The MCPO_API_KEY env var contains the bearer token for authorization.",
            "",
            *lines,
        ]
    )


# ── Server CRUD ────────────────────────────────────────────────────────────────


@router.get("/")
async def list_mcp_servers(
    db: AsyncSession = Depends(get_async_session),
) -> list[McpServerResponse]:
    """List all MCP servers in the registry."""
    result = await db.execute(select(McpServer).order_by(McpServer.name))
    return [_row_to_response(s) for s in result.scalars().all()]


@router.post("/")
async def create_mcp_server(
    req: CreateMcpServerRequest,
    db: AsyncSession = Depends(get_async_session),
) -> McpServerResponse:
    """Register a new MCP server."""
    server_id = _slug(req.name)
    existing = await db.get(McpServer, server_id)
    if existing:
        raise HTTPException(
            status_code=409, detail=f"MCP server '{server_id}' already exists"
        )

    now = now_ms()
    server = McpServer(
        id=server_id,
        name=req.name,
        description=req.description,
        config=json.dumps(req.config),
        discovered_tools="[]",
        status="configuring",
        enabled=req.enabled,
        setup_agent_id=req.setup_agent_id,
        created_at=now,
        updated_at=now,
    )
    db.add(server)
    await db.flush()
    await db.refresh(server)
    logger.info(f"MCP server created: {server_id}")
    return _row_to_response(server)


# ── Container management ───────────────────────────────────────────────────────
# NOTE: All literal routes (/restart, /config.json, /logs/stream, /agents/...,
# /configure/..., /extract) MUST be registered before /{server_id} so FastAPI
# does not swallow them as path parameters.


@router.post("/restart")
async def restart_mcpo() -> dict:
    """Signal the engine to rewrite the mcpo config.json and reload mcpo.

    Publishes MCP_RESTART_REQUESTED to Redis global events stream.
    The engine subscribes to this and handles the actual Docker work.
    """
    if not dependencies.redis_client:
        raise HTTPException(status_code=503, detail="Redis unavailable")

    import json as json_mod
    from datetime import datetime, timezone

    event = {
        "type": "MCP_RESTART_REQUESTED",
        "timestamp": int(datetime.now(timezone.utc).timestamp() * 1000),
    }
    await dependencies.redis_client.xadd(
        "djinnbot:events:global", {"data": json_mod.dumps(event)}
    )
    logger.info("MCP restart requested via Redis")
    return {"status": "restart_requested"}


@router.get("/config.json")
async def get_mcpo_config(
    db: AsyncSession = Depends(get_async_session),
) -> dict:
    """Render the full mcpo config.json for the engine to write to disk.

    Only returns enabled servers.
    """
    result = await db.execute(select(McpServer).where(McpServer.enabled == True))
    servers = result.scalars().all()

    mcp_servers: dict = {}
    for server in servers:
        try:
            config = json.loads(server.config) if server.config else {}
        except (json.JSONDecodeError, TypeError):
            config = {}
        mcp_servers[server.id] = config

    return {"mcpServers": mcp_servers}


# ── Log streaming via Redis ────────────────────────────────────────────────────


@router.get("/logs/stream")
async def stream_mcpo_logs():
    """SSE stream of mcpo container logs.

    The engine publishes log lines to the Redis stream djinnbot:mcp:logs.
    This endpoint reads from that stream and sends them as SSE events.
    """
    if not dependencies.redis_client:
        raise HTTPException(status_code=503, detail="Redis unavailable")

    async def event_generator() -> AsyncGenerator[str, None]:
        last_id = "$"
        # Send an initial ping so the client knows we're connected
        yield "event: connected\ndata: {}\n\n"

        while True:
            try:
                messages = await dependencies.redis_client.xread(
                    {MCP_LOG_STREAM: last_id}, count=20, block=3000
                )
                if not messages:
                    # Send keepalive
                    yield ": keepalive\n\n"
                    continue

                for _stream_name, stream_messages in messages:
                    for msg_id, fields in stream_messages:
                        last_id = msg_id
                        line = fields.get("line", "")
                        level = fields.get("level", "info")
                        ts = fields.get("ts", "")
                        payload = json.dumps({"line": line, "level": level, "ts": ts})
                        yield f"event: log\ndata: {payload}\n\n"

            except asyncio.CancelledError:
                break
            except Exception as e:
                logger.warning(f"MCP log SSE error: {e}")
                yield f"event: error\ndata: {json.dumps({'error': str(e)})}\n\n"
                await asyncio.sleep(2)

    return StreamingResponse(
        event_generator(),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache",
            "X-Accel-Buffering": "no",
        },
    )


# ── Agent tool access control ──────────────────────────────────────────────────


@router.get("/agents/{agent_id}/tools")
async def list_agent_mcp_tools(
    agent_id: str,
    db: AsyncSession = Depends(get_async_session),
) -> list[AgentMcpToolGrant]:
    """Return all MCP tool grants for an agent."""
    result = await db.execute(
        select(AgentMcpTool, McpServer)
        .join(McpServer, AgentMcpTool.server_id == McpServer.id)
        .where(AgentMcpTool.agent_id == agent_id, AgentMcpTool.granted == True)
        .order_by(McpServer.name, AgentMcpTool.tool_name)
    )
    rows = result.all()
    return [
        AgentMcpToolGrant(
            server_id=server.id,
            tool_name=grant.tool_name,
            granted_by=grant.granted_by,
            granted_at=grant.granted_at,
            server_name=server.name,
            server_status=server.status,
        )
        for grant, server in rows
    ]


@router.get("/agents/{agent_id}/manifest")
async def get_agent_mcp_manifest(
    agent_id: str,
    db: AsyncSession = Depends(get_async_session),
) -> AgentMcpManifestResponse:
    """Return MCP tool manifest for system prompt injection.

    Only includes enabled servers with running status.
    """
    result = await db.execute(
        select(AgentMcpTool, McpServer)
        .join(McpServer, AgentMcpTool.server_id == McpServer.id)
        .where(
            AgentMcpTool.agent_id == agent_id,
            AgentMcpTool.granted == True,
            McpServer.enabled == True,
            McpServer.status == "running",
        )
        .order_by(McpServer.name, AgentMcpTool.tool_name)
    )
    rows = result.all()

    base = _mcpo_base_url()
    entries: list[AgentMcpManifestEntry] = [
        AgentMcpManifestEntry(
            server_id=server.id,
            server_name=server.name,
            tool_name=grant.tool_name,
            base_url=f"{base}/{server.id}",
        )
        for grant, server in rows
    ]

    return AgentMcpManifestResponse(
        grants=entries,
        manifest_text=_build_manifest_text(entries),
    )


async def _upsert_grant(
    db: AsyncSession,
    agent_id: str,
    server_id: str,
    tool_name: str,
    granted_by: str,
) -> AgentMcpTool:
    result = await db.execute(
        select(AgentMcpTool).where(
            AgentMcpTool.agent_id == agent_id,
            AgentMcpTool.server_id == server_id,
            AgentMcpTool.tool_name == tool_name,
        )
    )
    existing = result.scalar_one_or_none()
    now = now_ms()
    if existing:
        existing.granted = True
        existing.granted_at = now
        existing.granted_by = granted_by
        return existing
    grant = AgentMcpTool(
        agent_id=agent_id,
        server_id=server_id,
        tool_name=tool_name,
        granted=True,
        granted_at=now,
        granted_by=granted_by,
    )
    db.add(grant)
    return grant


@router.post("/agents/{agent_id}/{server_id}/grant")
async def grant_server_to_agent(
    agent_id: str,
    server_id: str,
    req: GrantToolRequest = GrantToolRequest(),
    db: AsyncSession = Depends(get_async_session),
) -> dict:
    """Grant access to all tools on a server (wildcard grant)."""
    server = await db.get(McpServer, server_id)
    if not server:
        raise HTTPException(
            status_code=404, detail=f"MCP server '{server_id}' not found"
        )

    await _upsert_grant(db, agent_id, server_id, "*", req.granted_by)
    await db.flush()
    await _publish_grants_changed(agent_id)
    return {"granted": server_id, "tool_name": "*", "agent_id": agent_id}


@router.post("/agents/{agent_id}/{server_id}/{tool_name}/grant")
async def grant_tool_to_agent(
    agent_id: str,
    server_id: str,
    tool_name: str,
    req: GrantToolRequest = GrantToolRequest(),
    db: AsyncSession = Depends(get_async_session),
) -> dict:
    """Grant access to a specific tool on a server."""
    server = await db.get(McpServer, server_id)
    if not server:
        raise HTTPException(
            status_code=404, detail=f"MCP server '{server_id}' not found"
        )

    await _upsert_grant(db, agent_id, server_id, tool_name, req.granted_by)
    await db.flush()
    await _publish_grants_changed(agent_id)
    return {"granted": server_id, "tool_name": tool_name, "agent_id": agent_id}


@router.delete("/agents/{agent_id}/{server_id}")
async def revoke_server_from_agent(
    agent_id: str,
    server_id: str,
    db: AsyncSession = Depends(get_async_session),
) -> dict:
    """Revoke all tool grants for a server from an agent."""
    await db.execute(
        delete(AgentMcpTool).where(
            AgentMcpTool.agent_id == agent_id,
            AgentMcpTool.server_id == server_id,
        )
    )
    await _publish_grants_changed(agent_id)
    return {"revoked": server_id, "agent_id": agent_id}


@router.delete("/agents/{agent_id}/{server_id}/{tool_name}")
async def revoke_tool_from_agent(
    agent_id: str,
    server_id: str,
    tool_name: str,
    db: AsyncSession = Depends(get_async_session),
) -> dict:
    """Revoke a specific tool grant from an agent."""
    await db.execute(
        delete(AgentMcpTool).where(
            AgentMcpTool.agent_id == agent_id,
            AgentMcpTool.server_id == server_id,
            AgentMcpTool.tool_name == tool_name,
        )
    )
    await _publish_grants_changed(agent_id)
    return {"revoked": tool_name, "server_id": server_id, "agent_id": agent_id}


# ── Interactive MCP setup session ──────────────────────────────────────────────

MCP_SMITH_SYSTEM_PROMPT = """You are an MCP Smith — a specialist agent whose sole job is to configure MCP servers for use with the mcpo proxy.

mcpo (https://github.com/open-webui/mcpo) wraps MCP servers in an OpenAPI HTTP interface. It reads a config.json in the Claude Desktop format:

```json
{
  "mcpServers": {
    "server-name": {
      "command": "uvx",
      "args": ["mcp-server-time", "--local-timezone=America/New_York"]
    }
  }
}
```

For SSE servers:
```json
{
  "mcpServers": {
    "server-name": {
      "type": "sse",
      "url": "http://host:port/sse",
      "headers": { "Authorization": "Bearer TOKEN" }
    }
  }
}
```

For streamable HTTP:
```json
{
  "mcpServers": {
    "server-name": {
      "type": "streamable-http",
      "url": "http://host:port/mcp"
    }
  }
}
```

## Your job

When the user gives you an MCP server name, GitHub URL, npm package, or PyPI package:

1. **Research thoroughly** — browse the GitHub repo, npm page, PyPI page, or docs to find:
   - The exact installation/invocation command
   - All required and optional environment variables / secrets
   - The correct args for the mcpo config entry
   - Whether it's stdio (command/args), SSE, or streamable-http

2. **Identify secrets** — list every environment variable or credential needed. For each:
   - State the exact env var name (e.g. `GITHUB_TOKEN`)
   - Say what type it is (API key, PAT, password, etc.)
   - Give a one-sentence description of where to get it
   - Ask the user to provide the value — output a clearly formatted request like:
     `[SECRET_REQUEST: GITHUB_TOKEN | api_key | Your GitHub Personal Access Token with repo scope]`

3. **Wait for secrets** — once the user provides all required values, confirm you have them.

4. **Output the final config** — produce a `mcp-config-output` fenced block with the complete mcpServers entry for this server, including any env vars inline in the config:

```mcp-config-output
{
  "id": "lowercase-slug-for-server",
  "name": "Display Name",
  "description": "What this MCP server provides",
  "config": {
    "command": "...",
    "args": [...],
    "env": {
      "MY_API_KEY": "provided-value"
    }
  }
}
```

## Rules
- `id` must be lowercase kebab-case, max 40 chars
- `config` must be a valid mcpo mcpServers entry (no extra nesting)
- For stdio servers, prefer `uvx` (Python/uv) or `npx -y` (npm) — no system installs needed
- Always include `env` with actual provided values, never placeholders
- Do not output until you have all required secrets
- If the server needs no secrets, say so and output immediately after researching

Begin by acknowledging the server the user wants to configure and asking any clarifying questions needed before researching.
"""


@router.post("/configure/session")
async def start_mcp_configure_session(
    req: StartMcpSessionRequest,
) -> StartMcpSessionResponse:
    """Spawn an interactive MCP Smith agent chat session for guided server setup."""
    from app import dependencies as deps
    from app.database import AsyncSessionLocal
    from app.models.chat import ChatSession

    if not deps.redis_client:
        raise HTTPException(status_code=503, detail="Redis not available")

    now = now_ms()
    session_id = f"mcpconfig_{req.agent_id}_{now}"

    # Build a context-appropriate opening message
    if req.input_type == "github":
        initial_message = (
            f"I need to configure an MCP server from this GitHub repository: {req.input}\n\n"
            f"Please research it thoroughly — find the mcpo config entry, identify all required "
            f"secrets, and guide me through setup."
        )
    elif req.input_type in ("npm", "pypi"):
        pkg_type = "npm package" if req.input_type == "npm" else "PyPI package"
        initial_message = (
            f"I need to configure the {pkg_type} `{req.input}` as an MCP server.\n\n"
            f"Please find the correct mcpo config entry, identify any required secrets, "
            f"and guide me through setup."
        )
    elif req.input_type == "url":
        initial_message = (
            f"I need to configure an MCP server from this URL: {req.input}\n\n"
            f"Please research it and help me configure it for mcpo."
        )
    else:
        initial_message = (
            f"I need to configure this MCP server: {req.input}\n\n"
            f"Please research it (search GitHub/npm/PyPI as needed), identify the correct "
            f"mcpo config entry and any required secrets, then guide me through setup."
        )

    async with AsyncSessionLocal() as db:
        chat_session = ChatSession(
            id=session_id,
            agent_id=req.agent_id,
            status="starting",
            model=req.model,
            created_at=now,
            last_activity_at=now,
        )
        db.add(chat_session)
        await db.commit()

    await deps.redis_client.xadd(
        "djinnbot:events:chat_sessions",
        {
            "event": "chat:start",
            "session_id": session_id,
            "agent_id": req.agent_id,
            "model": req.model,
            "system_prompt_override": MCP_SMITH_SYSTEM_PROMPT,
        },
    )

    logger.info(f"MCP configure session started: {session_id} for agent {req.agent_id}")
    return StartMcpSessionResponse(
        session_id=session_id,
        initial_message=initial_message,
    )


@router.post("/extract")
async def extract_mcp_config(body: dict) -> dict:
    """Extract a mcp-config-output block from agent output text.

    Returns parsed config ready to be POSTed to POST /v1/mcp/.
    """
    text = body.get("text", "")

    import re as _re

    m = _re.search(r"```mcp-config-output\s*\n([\s\S]*?)```", text)
    if not m:
        return {
            "found": False,
            "config": None,
            "error": "No mcp-config-output block found",
        }

    raw = m.group(1).strip()
    try:
        parsed = json.loads(raw)
    except json.JSONDecodeError as e:
        return {"found": True, "config": None, "error": f"Invalid JSON in output: {e}"}

    required = {"id", "name", "config"}
    missing = required - set(parsed.keys())
    if missing:
        return {
            "found": True,
            "config": None,
            "error": f"Missing required fields: {', '.join(missing)}",
        }

    return {"found": True, "config": parsed, "error": None}


# ── Per-server CRUD — registered LAST so literal paths above take priority ─────


@router.get("/{server_id}")
async def get_mcp_server(
    server_id: str,
    db: AsyncSession = Depends(get_async_session),
) -> McpServerResponse:
    server = await db.get(McpServer, server_id)
    if not server:
        raise HTTPException(
            status_code=404, detail=f"MCP server '{server_id}' not found"
        )
    return _row_to_response(server)


@router.put("/{server_id}")
async def update_mcp_server(
    server_id: str,
    req: UpdateMcpServerRequest,
    db: AsyncSession = Depends(get_async_session),
) -> McpServerResponse:
    """Update server metadata and/or config."""
    server = await db.get(McpServer, server_id)
    if not server:
        raise HTTPException(
            status_code=404, detail=f"MCP server '{server_id}' not found"
        )
    if req.name is not None:
        server.name = req.name
    if req.description is not None:
        server.description = req.description
    if req.config is not None:
        server.config = json.dumps(req.config)
    if req.enabled is not None:
        server.enabled = req.enabled
    server.updated_at = now_ms()
    await db.flush()
    await db.refresh(server)
    logger.info(f"MCP server updated: {server_id}")
    return _row_to_response(server)


@router.delete("/{server_id}")
async def delete_mcp_server(
    server_id: str,
    db: AsyncSession = Depends(get_async_session),
) -> dict:
    """Delete an MCP server and all its tool grants."""
    server = await db.get(McpServer, server_id)
    if not server:
        raise HTTPException(
            status_code=404, detail=f"MCP server '{server_id}' not found"
        )
    await db.delete(server)
    logger.info(f"MCP server deleted: {server_id}")
    return {"deleted": server_id}


@router.patch("/{server_id}/enabled")
async def set_mcp_server_enabled(
    server_id: str,
    enabled: bool,
    db: AsyncSession = Depends(get_async_session),
) -> McpServerResponse:
    """Toggle global enabled flag."""
    return await update_mcp_server(
        server_id, UpdateMcpServerRequest(enabled=enabled), db
    )


@router.patch("/{server_id}/status")
async def patch_mcp_server_status(
    server_id: str,
    req: PatchStatusRequest,
    db: AsyncSession = Depends(get_async_session),
) -> McpServerResponse:
    """Update server status — called by the engine after mcpo reload."""
    server = await db.get(McpServer, server_id)
    if not server:
        raise HTTPException(
            status_code=404, detail=f"MCP server '{server_id}' not found"
        )
    valid_statuses = {"configuring", "running", "error", "stopped"}
    if req.status not in valid_statuses:
        raise HTTPException(
            status_code=422,
            detail=f"Invalid status '{req.status}'. Valid: {valid_statuses}",
        )
    server.status = req.status
    server.updated_at = now_ms()
    await db.flush()
    await db.refresh(server)
    return _row_to_response(server)


@router.patch("/{server_id}/tools")
async def patch_mcp_server_tools(
    server_id: str,
    req: PatchToolsRequest,
    db: AsyncSession = Depends(get_async_session),
) -> McpServerResponse:
    """Update cached discovered_tools list — called by engine after mcpo starts."""
    server = await db.get(McpServer, server_id)
    if not server:
        raise HTTPException(
            status_code=404, detail=f"MCP server '{server_id}' not found"
        )
    server.discovered_tools = json.dumps(req.tools)
    server.updated_at = now_ms()
    await db.flush()
    await db.refresh(server)
    return _row_to_response(server)
