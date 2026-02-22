# DjinnBot

**Autonomous AI teams that build software while you sleep.**

DjinnBot is an open-core agent orchestration platform that deploys a full team of AI agents — product owner, architect, engineers, QA, SRE, and more — to collaboratively execute software development workflows. Each agent has a distinct persona, persistent memory, and its own Slack presence. Define a task, kick off a pipeline, and watch your AI team spec, design, implement, review, test, and deploy — autonomously.

Self-hosted is free. One command to install, one command to run.

**[Join the waitlist for DjinnBot Cloud](https://app.djinn.bot)** — managed hosting so you don't have to self-host.

**Docs:** [docs.djinn.bot](https://docs.djinn.bot) | **License:** [FSL-1.1-ALv2](LICENSE) (free to use, converts to Apache 2.0 after 2 years)

---

## Why DjinnBot

- **Plug and play.** One `curl` command installs everything. The setup wizard handles secrets, API keys, Docker, and optional SSL. No Kubernetes, no cloud accounts, no 45-minute setup guides.
- **Fully containerized.** Every agent runs in its own isolated Docker container with a full engineering toolbox (Node, Python, Go, Rust, git, ripgrep, GitHub CLI, and dozens more). No host access, no security concerns.
- **Real team, not a chatbot.** Agents have personas, opinions, and memory. Eric (Product Owner) pushes back on vague specs. Finn (Architect) rejects PRs that violate architecture. Chieko (QA) finds the edge cases you forgot.
- **Persistent memory.** Agents remember decisions, lessons, and patterns across runs using ClawVault with semantic search. They learn and improve over time.
- **Beautiful dashboard.** Real-time streaming output, live agent sessions, project management with kanban boards, chat interface, and pipeline visualization — not a terminal dump.
- **Slack-native.** Each agent gets its own Slack bot. Watch your team discuss in threads. Mention an agent to get their perspective. Or skip Slack entirely and use the built-in chat.
- **YAML pipelines.** Define workflows as simple YAML — steps, agents, branching, loops, retries. No code required for orchestration.
- **MCP tools.** Agents can use any MCP-compatible tool server via the built-in mcpo proxy. Add GitHub, web search, or any custom tool with a single config entry.
- **Built-in auth.** User accounts with email/password, TOTP two-factor authentication, API keys, and optional OIDC single sign-on. Enable with one toggle for production deployments.
- **Open core.** Self-hosted is completely free. Use it, modify it, run it on your own infra. SaaS option coming for teams that don't want to manage infrastructure.

---

## Quick Start

### One-Line Install (Recommended)

The installer handles everything — Docker, Python, the CLI, cloning the repo, generating secrets, configuring your first model provider, optional SSL, and starting the stack:

```bash
curl -fsSL https://raw.githubusercontent.com/BaseDatum/djinnbot/main/install.sh | bash
```

This installs prerequisites (Docker, Python 3.11+, git), installs the `djinn` CLI, and launches the interactive setup wizard which walks you through:

1. Cloning the DjinnBot repository
2. Generating encryption keys and secrets
3. Choosing a model provider and entering your API key
4. Detecting your server IP and configuring network access
5. Optional SSL/TLS setup with Traefik (automatic Let's Encrypt certificates)
6. Starting the Docker stack

Works on **Linux** (Ubuntu, Debian, Fedora, CentOS, Arch, Amazon Linux) and **macOS** (Intel and Apple Silicon).

### Manual Install

If you prefer to set things up yourself:

```bash
git clone https://github.com/BaseDatum/djinnbot.git
cd djinnbot
cp .env.example .env
```

Edit `.env` and add your API key:

```bash
OPENROUTER_API_KEY=sk-or-v1-your-key-here
```

Generate required secrets:

```bash
python3 -c "import secrets; print('SECRET_ENCRYPTION_KEY=' + secrets.token_hex(32))" >> .env
python3 -c "import secrets; print('ENGINE_INTERNAL_TOKEN=' + secrets.token_urlsafe(32))" >> .env
python3 -c "import secrets; print('AUTH_SECRET_KEY=' + secrets.token_urlsafe(64))" >> .env
```

Start services:

```bash
docker compose up -d
```

This starts 6 services: PostgreSQL, Redis, API server, pipeline engine, dashboard, and the mcpo tool proxy.

### First Visit

| Service | URL |
|---------|-----|
| Dashboard | http://localhost:3000 |
| API | http://localhost:8000 |
| MCP Tools | http://localhost:8001 |

When authentication is enabled (`AUTH_ENABLED=true`), the dashboard redirects you to a setup page on first visit where you create your admin account and optionally enable two-factor authentication.

### CLI

Install the CLI to manage agents, providers, authenticate, and chat from the terminal:

```bash
pip install djinn-bot-cli
djinn --help
```

Log in and chat with agents:

```bash
djinn login                         # email/password + optional 2FA
djinn chat                          # interactive agent + model selection
djinn whoami                        # show current user
```

Run the setup wizard anytime:

```bash
djinn setup                         # interactive setup (safe to re-run)
```

Configure model provider API keys:

```bash
djinn provider set-key anthropic
djinn provider set-key openrouter
```

See the [CLI reference](https://docs.djinn.bot/docs/reference/cli/) for all commands.

---

## Architecture

```
┌──────────────────┐     ┌──────────────────┐     ┌──────────────┐
│    Dashboard     │◄SSE─│   API Server     │────►│  PostgreSQL  │
│  (React + Vite)  │     │   (FastAPI)      │     │              │
└──────────────────┘     └──────┬───────────┘     └──────────────┘
                                │
                                ▼
                        ┌──────────────┐
                        │    Redis     │
                        │(Streams+Pub/ │
                        │    Sub)      │
                        └──────┬───────┘
                               │
              ┌────────────────┼────────────────┐
              │                │                │
              ▼                ▼                ▼
     ┌────────────────┐ ┌──────────┐  ┌──────────────┐
     │Pipeline Engine │ │  Agent   │  │  Agent       │
     │(State Machine) │ │Container │  │  Container   │
     └───────┬────────┘ │(Isolated)│  │  (Isolated)  │
             │          └────┬─────┘  └──────┬───────┘
             │               │               │
             ▼               ▼               ▼
     ┌──────────────┐  ┌──────────────────────────┐
     │  Slack       │  │     mcpo Proxy            │
     │  Bridge      │  │  (MCP → Native Tools)     │
     └──────────────┘  └──────────────────────────┘
```

**How it works:**

1. **Create a project** — describe what you want built via the dashboard's guided onboarding, or import an existing repo
2. **Plan it** — the planning pipeline decomposes your project into tasks on a kanban board with priorities and dependencies
3. **Assign agents** — each agent is assigned to project board columns matching their role (e.g., Yukihiro watches "Ready", Chieko watches "Review")
4. **Agents work autonomously** — on pulse cycles, agents wake up, check the board, claim a task, spin up an isolated container, do the work, open a PR, and move the task forward
5. **Watch it happen** — streaming output in the dashboard, Slack threads, or the kanban board. Step in when you want, or let them run

Pipelines also exist for structured workflows — the planning pipeline generates tasks, the engineering pipeline runs a full SDLC for a single task, and you can create custom pipelines for any repeatable process.

Each agent runs in a fully isolated Docker container — its own filesystem, git workspace, installed tools, and network. No host access.

---

## The Team

DjinnBot ships with a default software engineering team. Each agent has a rich persona with backstory, opinions, communication style, and domain expertise:

| Agent | Role | Pipeline Stage |
|-------|------|---------------|
| **Eric** | Product Owner | SPEC — Requirements, user stories, acceptance criteria |
| **Finn** | Solutions Architect | DESIGN, REVIEW — Architecture, tech decisions, code review |
| **Shigeo** | UX Specialist | UX — User flows, design systems, accessibility |
| **Yukihiro** | Senior Software Engineer | IMPLEMENT, FIX — Writing code, fixing bugs |
| **Chieko** | Senior Test Engineer | TEST — QA, testing, regression detection |
| **Stas** | Site Reliability Engineer | DEPLOY — Infrastructure, monitoring, deployment |
| **Yang** | DevEx Specialist | DX — CI/CD, tooling, developer workflow |
| **Holt** | Marketing & Sales Lead | On-demand — Sales, outreach, positioning |
| **Luke** | SEO Specialist | On-demand — Content strategy, keyword research |
| **Jim** | Business & Finance Lead | On-demand — Budget, pricing, runway |

> Agents are assigned to projects and kanban columns. On pulse cycles, they autonomously pick up tasks, do the work, open PRs, and advance tasks through the board. Marketing, sales, and finance agents work in chat and pulse modes. More project types are coming.

---

## Pipelines

Pipelines are YAML files that define structured multi-step workflows. They power project planning, guided onboarding, and predefined SDLC passes:

| Pipeline | Description |
|----------|------------|
| `engineering` | Full SDLC: spec → design → UX → implement → review → test → deploy |
| `feature` | Lightweight: design → implement → review → test |
| `bugfix` | Focused: diagnose → fix → validate |
| `planning` | Project decomposition into tasks with dependency chains |
| `execute` | Run a single task from a project board |

### Example: Engineering Pipeline Flow

```
SPEC (Eric) → DESIGN (Finn) → UX (Shigeo) → IMPLEMENT (Yukihiro)
                                                    ↕
                                              REVIEW (Finn)
                                                    ↕
                                               TEST (Chieko)
                                                    ↓
                                              DEPLOY (Stas)
```

Steps support **loops** (implement each task in a breakdown), **branching** (approved vs. changes requested), **retries**, and **template variables** that pass outputs between agents.

---

## Agent Anatomy

Each agent is defined by a directory under `agents/`:

```
agents/eric/
├── IDENTITY.md      # Name, origin, role, emoji
├── SOUL.md          # Personality, beliefs, anti-patterns, communication style
├── AGENTS.md        # Workflow procedures, collaboration triggers, tools
├── DECISION.md      # Memory-first decision framework
├── PULSE.md         # Autonomous wake-up routine (check inbox, find tasks, work)
├── config.yml       # Model, pulse schedule, thinking settings
└── slack.yml        # Slack bot credentials (optional)
```

Agents also have access to **skills** — on-demand instruction sets loaded via `load_skill("name")` — and **MCP tools** — external tool servers accessed through the mcpo proxy.

---

## Memory System

DjinnBot uses [ClawVault](https://github.com/koi-labs-org/clawvault) for persistent agent memory with semantic search powered by QMDR:

- **Personal vaults** — Each agent has private memory for lessons, decisions, patterns, and preferences
- **Shared vault** — Team-wide knowledge that all agents can access
- **Wiki-link graph** — Memories are connected via `[[Topic]]` links for graph traversal
- **Semantic search** — `recall("query")` finds relevant memories by meaning, not just keywords
- **Automatic lifecycle** — Memory is loaded on wake, checkpointed during work, and saved on sleep

Embeddings and reranking run through OpenRouter (using `text-embedding-3-small` and `gpt-4o-mini`) — no local GPU required.

---

## Slack Integration

Each agent can have its own Slack bot, appearing as a distinct team member in your workspace. Agents post updates to threads, respond to mentions, and collaborate in channels.

Slack is **optional**. The built-in dashboard chat works without any Slack configuration. See the [docs](https://docs.djinn.bot) for setup instructions.

---

## MCP Tools

DjinnBot includes an [mcpo](https://github.com/skymoore/mcpo) proxy that exposes MCP tool servers as OpenAPI endpoints. Agents call tools like `github`, `fetch`, `time`, and any custom MCP server you add.

Tools are configured in `mcp/config.json` and can be managed through the dashboard UI. The proxy supports hot-reload — add a tool server and agents can use it immediately, no restart needed.

---

## LLM Providers

DjinnBot supports all major providers through [pi-mono](https://github.com/badlogic/pi-mono):

| Provider | Env Variable |
|----------|-------------|
| OpenRouter (recommended) | `OPENROUTER_API_KEY` |
| Anthropic | `ANTHROPIC_API_KEY` |
| OpenAI | `OPENAI_API_KEY` |
| Google (Gemini) | `GEMINI_API_KEY` |
| xAI (Grok) | `XAI_API_KEY` |
| Groq | `GROQ_API_KEY` |
| Mistral | `MISTRAL_API_KEY` |
| Azure OpenAI | `AZURE_OPENAI_API_KEY` |
| Amazon Bedrock | AWS credentials |
| Google Vertex | GCP ADC |
| Custom (OpenAI-compatible) | Via settings UI |

Configure providers in `.env` or through the dashboard settings page. Each agent can use a different model — put your architect on Claude Opus and your engineer on Kimi K2.5.

---

## Tech Stack

| Component | Technology |
|-----------|-----------|
| Pipeline Engine | TypeScript, Redis Streams |
| API Server | Python, FastAPI, PostgreSQL, SQLAlchemy, JWT auth |
| Dashboard | React, Vite, TanStack Router, Tailwind CSS |
| Agent Runtime | Node.js 22, Debian (full toolbox) |
| Memory | ClawVault + QMDR (semantic search) |
| Agent Framework | pi-mono (pi-agent-core) |
| Slack | Bolt.js, Socket Mode |
| MCP Proxy | mcpo (hot-reload) |
| Build | Turborepo monorepo |
| Orchestration | Docker Compose |

---

## Project Structure

```
djinnbot/
├── agents/                     # Agent persona definitions
│   ├── _templates/             # Shared templates (AGENTS.md, PULSE.md, etc.)
│   ├── _skills/                # Global skills (available to all agents)
│   ├── eric/                   # Product Owner
│   ├── finn/                   # Solutions Architect
│   ├── shigeo/                 # UX Specialist
│   ├── yukihiro/               # Senior SWE
│   ├── chieko/                 # Test Engineer
│   ├── stas/                   # SRE
│   ├── yang/                   # DevEx
│   ├── holt/                   # Marketing & Sales
│   ├── luke/                   # SEO
│   └── jim/                    # Finance
├── pipelines/                  # YAML pipeline definitions
├── packages/
│   ├── core/                   # Engine, events, memory, container management
│   ├── server/                 # FastAPI API server (Python)
│   ├── dashboard/              # React dashboard (TypeScript)
│   ├── slack/                  # Slack bridge and per-agent bots
│   └── agent-runtime/          # Agent container entrypoint + tools
├── mcp/                        # MCP tool server config
├── cli/                        # Python CLI (pip install djinn-bot-cli)
├── proxy/                      # Traefik reverse proxy for SSL
├── install.sh                  # One-shot installer script
├── docker-compose.yml
├── Dockerfile.engine
├── Dockerfile.server
├── Dockerfile.dashboard
└── Dockerfile.agent-runtime
```

---

## Development

For local development (not Docker):

**Requirements:** Node.js 20+, Python 3.12+, PostgreSQL, Redis

```bash
# Install dependencies
npm install
cd packages/server && pip install -e ".[dev]" && cd ../..
cd cli && uv sync --all-extras && cd ..

# Start services
redis-server &
# Start PostgreSQL

# Run API server
cd packages/server && uvicorn app.main:app --reload --port 8000

# Run engine (separate terminal)
cd packages/core && npm run build && node dist/main.js

# Run dashboard (separate terminal)
cd packages/dashboard && npm run dev
```

---

## Roadmap

- **RBAC & team management** — Role-based access control with granular permissions per project
- **Marketing & sales pipelines** — Structured workflows for content, outreach, and deal management
- **More bot interfaces** — Discord, Microsoft Teams, and other platforms beyond Slack
- **SaaS offering** — Managed hosting at djinn.bot for teams that don't want to self-host
- **Pipeline marketplace** — Share and discover community pipeline templates
- **Custom agent builder** — Create new agents with custom personas through the UI

---

## License

[FSL-1.1-ALv2](LICENSE) — Functional Source License with Apache 2.0 future grant.

**What this means:** You can use, modify, and self-host DjinnBot for free. The only restriction is you can't use it to build a competing commercial product. After 2 years, every release automatically converts to Apache 2.0 with no restrictions.

---

## Links

- **Join the Waitlist:** [app.djinn.bot](https://app.djinn.bot)
- **Documentation:** [docs.djinn.bot](https://docs.djinn.bot)
- **Website:** [djinn.bot](https://djinn.bot)
- **GitHub:** [github.com/BaseDatum/djinnbot](https://github.com/BaseDatum/djinnbot)

Built by [Sky Moore](https://github.com/skymoore) and the DjinnBot team.
