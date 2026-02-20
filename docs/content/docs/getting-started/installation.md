---
title: Installation
weight: 1
---

## Prerequisites

You need exactly two things:

- **Docker + Docker Compose** — [Install Docker Desktop](https://docs.docker.com/get-docker/) (includes Compose)
- **An LLM API key** — [OpenRouter](https://openrouter.ai/) is recommended (one key, access to all models)

That's it. No Node.js, no Python, no database setup. Docker handles everything.

## Clone & Configure

```bash
git clone https://github.com/BaseDatum/djinnbot.git
cd djinnbot
cp .env.example .env
```

Open `.env` in your editor and set your API key:

```bash
# Required — this is the only thing you must set
OPENROUTER_API_KEY=sk-or-v1-your-key-here
```

{{< callout type="info" >}}
**OpenRouter** gives you access to Claude, GPT-4, Gemini, Kimi, and dozens of other models through a single API key. It's the fastest way to get started. You can also use direct provider keys (Anthropic, OpenAI, etc.) — see [LLM Providers](/docs/advanced/llm-providers) for details.
{{< /callout >}}

### Optional: Encryption Key

For production deployments, generate a secrets encryption key:

```bash
# Generate and add to .env
python3 -c "import secrets; print('SECRET_ENCRYPTION_KEY=' + secrets.token_hex(32))" >> .env
```

This encrypts user-defined secrets (API keys, SSH keys, etc.) at rest. Without it, secrets are encrypted with an ephemeral key that resets on restart.

## Start Services

```bash
docker compose up -d
```

This starts 6 services:

| Service | Container | Port | Purpose |
|---------|-----------|------|---------|
| PostgreSQL | `djinnbot-postgres` | 5432 | State database |
| Redis | `djinnbot-redis` | 6379 | Event bus (Redis Streams) |
| API Server | `djinnbot-api` | 8000 | REST API (FastAPI) |
| Pipeline Engine | `djinnbot-engine` | — | Orchestrates agent execution |
| Dashboard | `djinnbot-dashboard` | 3000 | React web interface |
| MCP Proxy | `djinnbot-mcpo` | 8001 | Tool server proxy |

Check that everything is healthy:

```bash
docker compose ps
```

You should see all services running with healthy status.

## Verify

Open the dashboard:

```
http://localhost:3000
```

Check the API:

```bash
curl http://localhost:8000/v1/status
```

You should see a JSON response with `"status": "ok"` and connected service counts.

## What Just Happened

Docker Compose built and started the entire stack:

1. **PostgreSQL** stores pipeline runs, steps, agent state, project boards, and settings
2. **Redis** provides the event bus via Redis Streams — reliable, ordered message delivery between services
3. **API Server** (FastAPI/Python) exposes REST endpoints for the dashboard, CLI, and external integrations
4. **Pipeline Engine** (TypeScript/Node) runs the state machine that coordinates agent execution, spawns agent containers, manages memory, and bridges Slack
5. **Dashboard** (React/Vite) serves the web interface with real-time SSE streaming
6. **mcpo** proxies MCP tool servers (GitHub, web fetch, etc.) as OpenAPI endpoints for agents

When a pipeline runs, the engine dynamically spawns **agent containers** — isolated Docker containers with a full engineering toolbox — for each step. These are separate from the 6 core services and are created/destroyed per step.

## Next Steps

{{< cards >}}
  {{< card link="../first-run" title="Run Your First Pipeline" subtitle="Start an engineering pipeline and watch agents collaborate." >}}
{{< /cards >}}
