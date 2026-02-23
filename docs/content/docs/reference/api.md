---
title: API Reference
weight: 1
---

The DjinnBot API server runs at `http://localhost:8000` and provides a REST API for all operations. All endpoints are prefixed with `/v1/`.

{{< callout type="info" >}}
When authentication is enabled (`AUTH_ENABLED=true`), most endpoints require a valid JWT access token or API key in the `Authorization: Bearer <token>` header. The `ENGINE_INTERNAL_TOKEN` is also accepted as a service-level API key.
{{< /callout >}}

## Status

```
GET /v1/status
```

Returns server health, Redis connection status, and summary statistics.

## Pipelines

```
GET  /v1/pipelines              # List all pipeline definitions
GET  /v1/pipelines/{id}         # Get a specific pipeline
```

## Runs

```
GET  /v1/runs                   # List runs (?pipeline_id= filter)
GET  /v1/runs/{id}              # Get run details
POST /v1/runs                   # Create a new run
POST /v1/runs/{id}/cancel       # Cancel a running pipeline
POST /v1/runs/{id}/restart      # Restart a failed run
```

### Create Run Request

```json
{
  "pipeline_id": "engineering",
  "task_description": "Build a REST API for a todo app",
  "human_context": "Optional additional guidance",
  "project_name": "my-project"
}
```

## Steps

```
GET /v1/steps/{run_id}              # List steps for a run
GET /v1/steps/{run_id}/{step_id}    # Get step details
GET /v1/steps/{run_id}/{step_id}/output  # Get step output
```

## Agents

```
GET /v1/agents                  # List all agents
GET /v1/agents/{id}             # Get agent details
GET /v1/agents/{id}/runs        # Get agent run history
PUT /v1/agents/{id}/config      # Update agent configuration
```

## Agent Tools

```
GET  /v1/agent-tools/{agent_id}           # List tool overrides
PUT  /v1/agent-tools/{agent_id}/{tool}    # Set tool override (enable/disable)
DELETE /v1/agent-tools/{agent_id}/{tool}  # Remove tool override
```

## Chat

```
POST /v1/chat/sessions              # Create a chat session
GET  /v1/chat/sessions              # List active sessions
GET  /v1/chat/sessions/{id}         # Get session details
POST /v1/chat/sessions/{id}/message # Send a message
DELETE /v1/chat/sessions/{id}       # End a session
```

## Attachments

```
POST /v1/attachments/upload         # Upload a file attachment
GET  /v1/attachments/{id}           # Get attachment metadata
GET  /v1/attachments/{id}/content   # Download attachment content
```

## Projects

```
GET  /v1/projects                   # List projects
POST /v1/projects                   # Create a project
GET  /v1/projects/{id}              # Get project details
PUT  /v1/projects/{id}              # Update a project
GET  /v1/projects/{id}/tasks        # List tasks
POST /v1/projects/{id}/tasks        # Create a task
PUT  /v1/projects/{id}/tasks/{tid}  # Update a task
POST /v1/projects/{id}/tasks/{tid}/claim       # Claim a task
POST /v1/projects/{id}/tasks/{tid}/transition  # Move task
PUT  /v1/projects/{id}/vision       # Set project vision
```

## Memory

```
GET /v1/memory/vaults               # List all vaults
GET /v1/memory/vaults/{agent_id}    # Get vault contents
GET /v1/memory/search               # Search memories
    ?agent_id=eric&query=architecture&limit=5
GET /v1/memory/shared               # Search shared knowledge
```

## Memory Scores

```
GET  /v1/memory-scores/{agent_id}          # Get memory scores
PUT  /v1/memory-scores/{agent_id}/{entry}  # Update memory score
GET  /v1/memory-scores/settings            # Get scoring settings
PUT  /v1/memory-scores/settings            # Update scoring settings
```

## Skills

```
GET  /v1/skills                     # List all skills
GET  /v1/skills/{name}              # Get skill content
POST /v1/skills                     # Create a skill
PUT  /v1/skills/{name}              # Update a skill
DELETE /v1/skills/{name}            # Delete a skill
PATCH /v1/skills/{name}/enabled     # Toggle enabled state
```

## MCP

```
GET  /v1/mcp                        # List MCP servers
GET  /v1/mcp/{id}                   # Get server details
POST /v1/mcp                        # Register a new server
PUT  /v1/mcp/{id}                   # Update server config
DELETE /v1/mcp/{id}                 # Remove a server
GET  /v1/mcp/config.json            # Get merged config
PATCH /v1/mcp/{id}/status           # Update server status
PATCH /v1/mcp/{id}/tools            # Update discovered tools
GET  /v1/mcp/logs                   # Stream MCP proxy logs
```

## Settings

```
GET  /v1/settings                   # Get all settings
PUT  /v1/settings                   # Update settings
GET  /v1/settings/providers         # List LLM providers
PUT  /v1/settings/providers/{id}    # Update provider config
GET  /v1/settings/providers/keys/all  # Get all provider API keys
```

## Secrets

```
GET  /v1/secrets                    # List secrets (names only)
POST /v1/secrets                    # Store a secret
DELETE /v1/secrets/{name}           # Delete a secret
POST /v1/secrets/{id}/grant/{agent_id}    # Grant to agent
DELETE /v1/secrets/{id}/grant/{agent_id}  # Revoke from agent
GET  /v1/secrets/agents/{agent_id}        # List agent's secrets (masked)
GET  /v1/secrets/agents/{agent_id}/env    # Get plaintext (engine only)
```

## Pulse Routines

```
GET  /v1/pulse-routines/{agent_id}           # List routines
POST /v1/pulse-routines/{agent_id}           # Create routine
PUT  /v1/pulse-routines/{agent_id}/{id}      # Update routine
DELETE /v1/pulse-routines/{agent_id}/{id}    # Delete routine
```

## Swarm Execution

```
POST /v1/swarm/execute              # Launch a swarm
GET  /v1/swarm/{id}                 # Get swarm status
GET  /v1/swarm/{id}/tasks           # List swarm tasks
POST /v1/swarm/{id}/cancel          # Cancel a swarm
```

## Spawn Executor

```
POST /v1/spawn-executor/execute     # Spawn a one-off agent execution
GET  /v1/spawn-executor/{id}        # Get execution status
```

## LLM Call Logs

```
GET /v1/llm-calls                   # List LLM calls (filterable)
    ?agent_id=&run_id=&provider=&limit=50
GET /v1/llm-calls/summary           # Aggregate usage summary
GET /v1/llm-calls/{id}              # Get call details
```

## User Usage

```
GET /v1/usage                       # Personal usage summary
GET /v1/usage/history               # Usage history over time
```

## Users

```
GET  /v1/users                      # List users (admin)
POST /v1/users                      # Create a user (admin)
GET  /v1/users/{id}                 # Get user details
PUT  /v1/users/{id}                 # Update a user
DELETE /v1/users/{id}               # Delete a user
```

## User Providers

```
GET  /v1/settings/user-providers           # List personal provider keys
PUT  /v1/settings/user-providers/{provider}  # Set personal API key
DELETE /v1/settings/user-providers/{provider}  # Remove personal key
```

## Admin

```
GET  /v1/admin/api-usage            # API usage analytics
GET  /v1/admin/notifications        # System notifications
POST /v1/admin/notifications/{id}/dismiss  # Dismiss notification
GET  /v1/admin/containers           # List containers
GET  /v1/admin/containers/{id}/logs # Stream container logs
POST /v1/admin/pull-image           # Pull a Docker image
GET  /v1/admin/users                # User management
```

## Ingest

```
POST /v1/ingest/transcript          # Submit a meeting transcript for Grace
POST /v1/ingest/document            # Submit a document for processing
```

## Waitlist

```
POST /v1/waitlist                   # Join the waitlist
GET  /v1/waitlist                   # List waitlist entries (admin)
```

## Events (SSE)

```
GET /v1/events/stream               # Server-Sent Events stream
    ?run_id=run_123                  # Filter to a specific run
```

Returns real-time events including:
- `run_created`, `run_complete`, `run_failed`
- `step_queued`, `step_started`, `step_complete`, `step_failed`
- `agent_output` (streaming text chunks)
- `agent_thinking` (reasoning blocks)
- `tool_call_start`, `tool_call_end`
- `swarm_task_started`, `swarm_task_complete`
- `llm_call` (per-API-call token and cost data)
- `activity` (live activity feed events)

## Auth

```
POST /v1/auth/login                 # Email/password login
POST /v1/auth/login/2fa             # 2FA verification
POST /v1/auth/refresh               # Refresh access token
POST /v1/auth/logout                # Logout (invalidate refresh)
POST /v1/auth/setup                 # Initial admin account creation
GET  /v1/auth/me                    # Current user info
POST /v1/auth/2fa/enable            # Enable 2FA
POST /v1/auth/2fa/verify            # Verify 2FA setup
POST /v1/auth/2fa/disable           # Disable 2FA
POST /v1/auth/api-keys              # Create API key
GET  /v1/auth/api-keys              # List API keys
DELETE /v1/auth/api-keys/{id}       # Revoke API key
```

## GitHub

```
POST /v1/github/webhooks            # Receive GitHub webhooks
GET  /v1/github/repos               # List accessible repos
GET  /v1/github/app/status          # GitHub App connection status
```

## Lifecycle

```
GET /v1/lifecycle/timeline          # Agent activity timeline
GET /v1/lifecycle/sessions          # Active sessions
```

## Updates

```
GET /v1/updates/check               # Check for DjinnBot updates
GET /v1/updates/version             # Current version info
```
