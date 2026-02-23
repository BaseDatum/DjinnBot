---
title: Installation
weight: 1
---

## One-Line Install (Recommended)

The fastest way to get DjinnBot running. A single command installs all prerequisites, launches the setup wizard, and starts the stack:

```bash
curl -fsSL https://raw.githubusercontent.com/BaseDatum/djinnbot/main/install.sh | bash
```

The installer automatically detects your platform and installs everything needed. Then the setup wizard walks you through:

{{% steps %}}

### Clone the repo

Detects an existing checkout or clones fresh from GitHub.

### Generate secrets

Creates `.env` with encryption keys, internal tokens, and API key for the mcpo proxy.

### Enable authentication

Recommended for anything beyond localhost — sets up JWT auth with optional 2FA.

### Configure networking

Detects your server IP and sets up network access. Optional SSL/TLS with Traefik and automatic Let's Encrypt certificates.

### Choose a model provider

Enter your API key for OpenRouter, Anthropic, OpenAI, or any supported provider.

### Start the stack

Launches Docker Compose with all 6 services — your AI team is ready.

{{% /steps %}}

Supported platforms: **Ubuntu**, **Debian**, **Fedora**, **CentOS/RHEL**, **Rocky/Alma**, **Amazon Linux**, **Arch**, **macOS** (Intel and Apple Silicon).

{{< callout type="info" >}}
The setup wizard is idempotent — safe to re-run anytime. It detects existing configuration and skips what's already done. Run `djinn setup` again to change settings or add SSL later.
{{< /callout >}}

## Manual Install

If you prefer to set things up yourself:

### Prerequisites

- **Docker + Docker Compose** — [Install Docker Desktop](https://docs.docker.com/get-docker/) (includes Compose)
- **An LLM API key** — [OpenRouter](https://openrouter.ai/) is recommended (one key, access to all models)

That's it. No Node.js, no Python, no database setup. Docker handles everything.

### Clone & Configure

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

### Generate Secrets

For production deployments, generate all required secrets:

```bash
# Encryption key for secrets at rest (AES-256-GCM)
python3 -c "import secrets; print('SECRET_ENCRYPTION_KEY=' + secrets.token_hex(32))" >> .env

# Internal service-to-service auth token
python3 -c "import secrets; print('ENGINE_INTERNAL_TOKEN=' + secrets.token_urlsafe(32))" >> .env

# JWT signing key for user authentication
python3 -c "import secrets; print('AUTH_SECRET_KEY=' + secrets.token_urlsafe(64))" >> .env
```

{{< callout type="warning" >}}
When `AUTH_ENABLED=true`, both `ENGINE_INTERNAL_TOKEN` and `AUTH_SECRET_KEY` are **required**. The server will refuse to start without them. The setup wizard generates these automatically.
{{< /callout >}}

### Enable Authentication

To enable the built-in authentication system, set in `.env`:

```bash
AUTH_ENABLED=true
```

When enabled, the dashboard will redirect to a setup page on first visit where you create an admin account and optionally enable two-factor authentication. See [Security Model](/docs/advanced/security) for details.

### Start Services

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

## SSL/TLS with Traefik

For production deployments exposed to the internet, DjinnBot includes a Traefik reverse proxy with automatic Let's Encrypt certificates.

The setup wizard configures this automatically when you choose SSL. To set it up manually:

**Requirements:**
- A domain name with an A record pointing to your server
- Ports 80 and 443 accessible from the internet

**Configuration:**

1. Set environment variables in `.env`:

```bash
DOMAIN=djinn.example.com
BIND_HOST=127.0.0.1          # Only Traefik faces the internet
TRAEFIK_ENABLED=true
VITE_API_URL=https://djinn.example.com
```

2. Create `proxy/.env`:

```bash
ACME_EMAIL=you@example.com
DOMAIN=djinn.example.com
```

3. Create the shared Docker network and start the proxy:

```bash
docker network create djinnbot-proxy
docker compose -f proxy/docker-compose.yml up -d
```

4. Start the main stack (it picks up `docker-compose.override.yml` automatically):

```bash
docker compose up -d
```

Traefik handles:
- Automatic certificate issuance and renewal via Let's Encrypt
- HTTP to HTTPS redirection
- Routing `/v1/*` to the API and everything else to the dashboard
- SSE streaming support with proper flush intervals

## Verify

Open the dashboard:

```
http://localhost:3000
```

If authentication is enabled, you'll be redirected to the setup page to create your admin account.

Check the API:

```bash
curl http://localhost:8000/v1/status
```

You should see a JSON response with `"status": "ok"` and connected service counts.

## What Just Happened

Docker Compose built and started the entire stack:

1. **PostgreSQL** stores pipeline runs, steps, agent state, project boards, user accounts, and settings
2. **Redis** provides the event bus via Redis Streams — reliable, ordered message delivery between services
3. **API Server** (FastAPI/Python) exposes REST endpoints for the dashboard, CLI, and external integrations, with optional JWT authentication
4. **Pipeline Engine** (TypeScript/Node) runs the state machine that coordinates agent execution, spawns agent containers, manages memory, and bridges Slack
5. **Dashboard** (React/Vite) serves the web interface with real-time SSE streaming, authentication pages, and project management
6. **mcpo** proxies MCP tool servers (GitHub, web fetch, etc.) as OpenAPI endpoints for agents

When a pipeline runs, the engine dynamically spawns **agent containers** — isolated Docker containers with a full engineering toolbox — for each step. These are separate from the 6 core services and are created/destroyed per step.

## Next Steps

{{< cards >}}
  {{< card link="../first-run" title="Run Your First Pipeline" subtitle="Create a project and watch agents collaborate." >}}
  {{< card link="/docs/advanced/security" title="Security Model" subtitle="Authentication, 2FA, API keys, and container isolation." >}}
{{< /cards >}}
