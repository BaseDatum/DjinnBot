---
title: API Reference
weight: 1
---

The DjinnBot API server runs at `http://localhost:8000` and provides a REST API for all operations. All endpoints are prefixed with `/v1/`.

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

## Chat

```
POST /v1/chat/sessions              # Create a chat session
GET  /v1/chat/sessions              # List active sessions
GET  /v1/chat/sessions/{id}         # Get session details
POST /v1/chat/sessions/{id}/message # Send a message
DELETE /v1/chat/sessions/{id}       # End a session
```

## Projects

```
GET  /v1/projects                   # List projects
POST /v1/projects                   # Create a project
GET  /v1/projects/{id}              # Get project details
GET  /v1/projects/{id}/tasks        # List tasks
POST /v1/projects/{id}/tasks        # Create a task
PUT  /v1/projects/{id}/tasks/{tid}  # Update a task
POST /v1/projects/{id}/tasks/{tid}/claim    # Claim a task
POST /v1/projects/{id}/tasks/{tid}/transition  # Move task
```

## Memory

```
GET /v1/memory/vaults               # List all vaults
GET /v1/memory/vaults/{agent_id}    # Get vault contents
GET /v1/memory/search               # Search memories
    ?agent_id=eric&query=architecture&limit=5
GET /v1/memory/shared               # Search shared knowledge
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
