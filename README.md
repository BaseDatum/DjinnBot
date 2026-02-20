# 🧞 DjinnBot

Event-driven agent orchestration framework for autonomous software development.

DjinnBot is a multi-agent pipeline orchestration system that coordinates specialized AI agents to collaboratively execute complex software development workflows. Built on Redis Streams for reliable event delivery and ClawVault for persistent agent memory, DjinnBot enables teams of AI agents to work together on product development, architecture, implementation, testing, and deployment—with real-time visibility through an integrated dashboard and Slack bridge.

## Features

- **Multi-agent pipelines with YAML definitions** — Define workflows where each step is handled by a specialized agent persona
- **Each agent has its own persona, memory vault, and Slack presence** — Agents maintain context across runs and communicate naturally in Slack
- **Real-time dashboard with live streaming output** — Watch agents work in real-time with streaming text and expandable thinking blocks
- **Redis Streams event bus for reliable event delivery** — Event-driven architecture ensures no messages are lost during pipeline execution
- **Persistent agent memory across runs (ClawVault)** — Agents remember decisions, lessons, and context between sessions
- **CLI for full API access** — Control pipelines, inspect runs, manage agent memory, and more from the command line
- **Docker Compose for one-command deployment** — Get the full stack running with a single command

## Architecture Overview

```
┌─────────────┐      ┌──────────────┐      ┌─────────────┐
│   Dashboard │◄─────│  API Server  │◄─────│    Redis    │
│  (React)    │ SSE  │  (FastAPI)   │      │  (Streams)  │
└─────────────┘      └──────────────┘      └─────────────┘
                             │                      ▲
                             │                      │
                             ▼                      │
                      ┌──────────────┐              │
                      │   SQLite     │              │
                      │  (State DB)  │              │
                      └──────────────┘              │
                                                    │
                     ┌──────────────────────────────┘
                     │
                     ▼
          ┌──────────────────┐           ┌─────────────────┐
          │  Pipeline Engine │◄──────────│ Agent Executor  │
          │  (State Machine) │           │ (Pi-Agent Core) │
          └──────────────────┘           └─────────────────┘
                     │                            │
                     │                            │
                     ▼                            ▼
          ┌──────────────────┐           ┌─────────────────┐
          │  Slack Bridge    │           │   ClawVault     │
          │  (Per-Agent Apps)│           │ (Agent Memory)  │
          └──────────────────┘           └─────────────────┘
```

**Event Flow:**
- API creates run → Redis `new_runs` stream
- Engine starts pipeline → publishes `RUN_CREATED`, `STEP_QUEUED` events
- Agent Executor subscribes to run channel → executes agent sessions
- Agents call tools (complete/fail) → Engine advances state machine
- Slack Bridge relays events to Slack threads → agents respond autonomously

## Quick Start

### Prerequisites

- **Docker + Docker Compose** — For containerized deployment
- **Node.js 20+** — For local development
- **Python 3.12+** — For API server and CLI
- **OpenRouter API key** — Or compatible LLM provider (Anthropic, OpenAI, etc.)

### 1. Clone & Configure

```bash
git clone https://github.com/skymoore/djinnbot.git
cd djinnbot

# Copy environment template
cp .env.example .env

# Edit .env and add your API keys
# Required:
#   OPENROUTER_API_KEY=sk-or-v1-...
# Optional for Slack integration:
#   SLACK_CHANNEL_ID=C...
#   SLACK_<AGENT>_BOT_TOKEN=xoxb-...
#   SLACK_<AGENT>_APP_TOKEN=xapp-...
```

**Minimum required environment variables:**
```bash
OPENROUTER_API_KEY=sk-or-v1-your-key-here
REDIS_URL=redis://redis:6379
DATABASE_PATH=/data/djinnbot.db
PIPELINES_DIR=/pipelines
AGENTS_DIR=/agents
VAULTS_DIR=/data/vaults
```

### 2. Start with Docker Compose

```bash
# Build and start all services
docker compose up -d

# View logs
docker compose logs -f

# Check service health
docker compose ps
```

Services will start on:
- **Dashboard**: http://localhost:3000
- **API**: http://localhost:8000
- **Redis**: localhost:6379

> **Note**: DjinnBot uses 4 services (redis, api, engine, dashboard). Agent memory embeddings are handled locally via [qmd](https://github.com/tobi/qmd) with GGUF models—no external embedding service required.

### 3. Access

**Dashboard**  
Open http://localhost:3000 to see the real-time pipeline dashboard.

**API**  
Check API status at http://localhost:8000/api/status

**CLI**  
Install the CLI tool:
```bash
cd cli
pip install -e .
djinnbot --help
```

### 4. Run Your First Pipeline

**Via CLI:**
```bash
# List available pipelines
djinnbot pipeline list

# Start a new run
djinnbot pipeline start engineering \
  --task "Build a task management CLI tool in Python"

# Watch run progress
djinnbot run show <run-id>

# Stream output in real-time
djinnbot run stream <run-id>
```

**Via API:**
```bash
# Start a pipeline run
curl -X POST http://localhost:8000/api/runs \
  -H "Content-Type: application/json" \
  -d '{
    "pipeline_id": "engineering",
    "task_description": "Build a task management CLI tool in Python"
  }'

# Get run status
curl http://localhost:8000/api/runs/<run-id>
```

**Via Dashboard:**
1. Navigate to http://localhost:3000
2. Click "New Run"
3. Select "engineering" pipeline
4. Enter your task description
5. Watch agents collaborate in real-time!

## Project Structure

```
djinnbot/
├── agents/                    # Agent persona definitions
│   ├── eric/                  # Product Owner
│   │   ├── IDENTITY.md        # Agent bio and role
│   │   ├── SOUL.md            # Personality and traits
│   │   ├── AGENTS.md          # Workflow guidance
│   │   └── slack.yml          # Slack credentials
│   ├── finn/                  # Solutions Architect
│   ├── shigeo/                # UX Specialist
│   ├── yukihiro/              # Senior SWE
│   ├── chieko/                # Senior Test Engineer
│   ├── stas/                  # SRE
│   └── yang/                  # DevEx Engineer
│
├── pipelines/                 # Pipeline definitions
│   └── engineering.yml        # Full software development workflow
│
├── packages/                  # TypeScript monorepo
│   ├── core/                  # Pipeline engine, event bus, runtime
│   │   ├── src/
│   │   │   ├── engine/        # Pipeline state machine
│   │   │   ├── events/        # Redis Streams event bus
│   │   │   ├── runtime/       # Agent executor, Pi-Agent integration
│   │   │   ├── memory/        # ClawVault memory system
│   │   │   └── db/            # SQLite state store
│   │   └── package.json
│   │
│   ├── server/                # FastAPI backend
│   │   ├── app/
│   │   │   ├── main.py        # Server entry point
│   │   │   ├── routers/       # REST endpoints
│   │   │   └── db.py          # Database connection
│   │   └── requirements.txt
│   │
│   ├── dashboard/             # React frontend
│   │   ├── src/
│   │   │   ├── routes/        # TanStack Router pages
│   │   │   ├── components/    # React components
│   │   │   └── lib/           # API client, SSE
│   │   └── package.json
│   │
│   └── slack/                 # Slack integration
│       ├── src/
│       │   ├── slack-bridge.ts      # Event → Slack routing
│       │   ├── agent-slack-runtime.ts  # Per-agent Socket Mode
│       │   └── thread-manager.ts    # Run ↔ thread mapping
│       └── package.json
│
├── cli/                       # Python CLI tool
│   ├── djinnbot/
│   │   ├── main.py            # Typer CLI entry point
│   │   ├── commands/          # Command groups
│   │   │   ├── pipeline.py
│   │   │   ├── run.py
│   │   │   ├── step.py
│   │   │   ├── agent.py
│   │   │   └── memory.py
│   │   ├── client.py          # HTTP client
│   │   └── formatting.py      # Rich terminal output
│   └── pyproject.toml
│
├── data/                      # Runtime state (generated)
│   ├── djinnbot.db            # SQLite database
│   ├── vaults/                # ClawVault agent memory
│   │   ├── shared/            # Shared knowledge
│   │   ├── eric/              # Per-agent vaults
│   │   ├── finn/
│   │   └── ...
│   └── progress/              # Loop progress tracking
│
├── docs/                      # Documentation
│   └── ARCHITECTURE.md        # Technical deep-dive
│
├── docker-compose.yml         # Multi-service orchestration
├── Dockerfile.engine          # Pipeline engine worker
├── Dockerfile.server          # API server
├── Dockerfile.dashboard       # React dashboard
├── package.json               # Root package (turborepo)
├── turbo.json                 # Build configuration
└── .env                       # Environment variables
```

## Pipelines

Pipelines are defined in YAML and describe a workflow as a series of steps, each executed by a specialized agent.

### Pipeline Structure

```yaml
id: engineering
name: Engineering Pipeline
version: 1.0.0
description: Full software development workflow from spec to deployment

defaults:
  model: openrouter/moonshotai/kimi-k2.5
  tools:
    - read
    - write
    - bash
  maxRetries: 3
  timeout: 3600

agents:
  - id: eric
    name: Eric (Product Owner)
    persona: docs/personas/eric.md
    model: anthropic/claude-opus-4
    tools:
      - web_search
      - read
      - write

steps:
  - id: SPEC
    agent: eric
    input: |
      You are the Product Owner for this project.
      Task: {{task_description}}
      
      Create comprehensive product requirements...
    outputs:
      - product_brief
      - requirements_doc
    onComplete: DESIGN

  - id: DESIGN
    agent: finn
    input: |
      You are the Solutions Architect.
      Requirements: {{requirements_doc}}
      
      Design the technical solution...
    outputs:
      - architecture_doc
      - api_design
    onComplete: IMPLEMENT

  # More steps...
```

### Key Pipeline Features

**Template Variables**: Reference previous step outputs with `{{output_name}}`

**Loop Steps**: Execute the same step multiple times over a list
```yaml
- id: IMPLEMENT
  agent: yukihiro
  input: "Current Task: {{current_item}}"
  loop:
    over: task_breakdown_json
    onEachComplete: REVIEW
    onAllComplete: DEPLOY
```

**Result Routing**: Branch based on agent tool calls
```yaml
- id: REVIEW
  agent: finn
  outputs:
    - review_result
  onResult:
    APPROVED:
      goto: TEST
    CHANGES_REQUESTED:
      goto: IMPLEMENT
```

**Retry Logic**: Automatically retry failed steps with feedback
```yaml
defaults:
  maxRetries: 3
```

See `pipelines/engineering.yml` for a complete example.

## Agents

Each agent has its own persona, memory vault, and can integrate with Slack.

### Agent Persona Files

Agents are defined by three markdown files in `agents/<agent-id>/`:

**IDENTITY.md** — Agent bio, role, and core responsibilities
```markdown
# Identity: Eric - Product Owner

## Who I Am
I'm Eric, the Product Owner for DjinnBot...

## My Role
I translate business needs into clear requirements...
```

**SOUL.md** — Personality, communication style, and values
```markdown
# Soul: Eric's Character

## Personality
- Enthusiastic but realistic
- User-focused...
```

**AGENTS.md** — Workflow guidance and tool usage
```markdown
# Agent Workflow: Eric

## Tools I Use
- web_search — Market research
- write — Product documents...
```

**slack.yml** (optional) — Slack credentials for agent presence
```yaml
bot_token: ${SLACK_ERIC_BOT_TOKEN}
app_token: ${SLACK_ERIC_APP_TOKEN}
```

### Available Agents

- **eric** — Product Owner (requirements, market analysis)
- **finn** — Solutions Architect (architecture, tech stack, planning)
- **shigeo** — UX Specialist (user experience, design systems)
- **yukihiro** — Senior Software Engineer (implementation)
- **chieko** — Senior Test Engineer (QA, testing)
- **stas** — SRE (deployment, infrastructure)
- **yang** — DevEx Engineer (CI/CD, tooling)

### Agent Memory

Agents use ClawVault to maintain persistent memory across runs:

**Personal Vault**: `data/vaults/<agent-id>/`
- Lessons learned
- Decision patterns
- Preferences

**Shared Vault**: `data/vaults/shared/`
- Cross-agent knowledge
- High-importance facts

Memory is automatically injected into agent context during `wake()` and stored during `sleep()`.

## CLI Reference

The DjinnBot CLI provides full control over the system.

### Installation

```bash
cd cli
pip install -e .
djinnbot --help
```

### Command Groups

#### `djinnbot status`
Show server health and statistics

#### `djinnbot pipeline`
Manage pipeline definitions

```bash
# List all pipelines
djinnbot pipeline list

# Show pipeline details
djinnbot pipeline show engineering

# Start a new run
djinnbot pipeline start engineering --task "Your task description"
```

#### `djinnbot run`
Manage and monitor pipeline runs

```bash
# List recent runs
djinnbot run list

# Show run details
djinnbot run show <run-id>

# Stream run output in real-time
djinnbot run stream <run-id>

# Cancel a running pipeline
djinnbot run cancel <run-id>

# Restart a failed run
djinnbot run restart <run-id>
```

#### `djinnbot step`
Inspect individual step executions

```bash
# List steps for a run
djinnbot step list <run-id>

# Show step details
djinnbot step show <run-id> <step-id>

# View step output
djinnbot step output <run-id> <step-id>
```

#### `djinnbot agent`
View agent status and runtime info

```bash
# List all agents
djinnbot agent list

# Show agent details
djinnbot agent show eric

# View agent run history
djinnbot agent runs eric
```

#### `djinnbot memory`
Search and manage agent memory vaults

```bash
# List vaults
djinnbot memory list-vaults

# Search agent memory
djinnbot memory search eric "architecture decisions"

# View vault contents
djinnbot memory vault eric

# Search shared knowledge
djinnbot memory shared "deployment patterns"
```

## API Reference

The FastAPI server exposes a REST API for all operations.

### Base URL
`http://localhost:8000`

### Endpoints

#### Status
- `GET /api/status` — Server health and statistics

#### Pipelines
- `GET /api/pipelines` — List all pipelines
- `GET /api/pipelines/{id}` — Get pipeline definition

#### Runs
- `GET /api/runs` — List runs (optional `?pipeline_id=` filter)
- `GET /api/runs/{id}` — Get run details
- `POST /api/runs` — Create new run
  ```json
  {
    "pipeline_id": "engineering",
    "task_description": "Build a CLI tool",
    "human_context": "Optional guidance"
  }
  ```
- `POST /api/runs/{id}/cancel` — Cancel running pipeline
- `POST /api/runs/{id}/restart` — Restart failed run

#### Steps
- `GET /api/steps/{run_id}` — List steps for run
- `GET /api/steps/{run_id}/{step_id}` — Get step details
- `GET /api/steps/{run_id}/{step_id}/output` — Get step output

#### Agents
- `GET /api/agents` — List all agents
- `GET /api/agents/{id}` — Get agent details
- `GET /api/agents/{id}/runs` — Get agent run history

#### Memory
- `GET /api/memory/vaults` — List all vaults
- `GET /api/memory/vaults/{agent_id}` — Get vault contents
- `GET /api/memory/search` — Search agent memory
  ```
  ?agent_id=eric&query=architecture&limit=5
  ```
- `GET /api/memory/shared` — Search shared knowledge

#### Events (SSE)
- `GET /api/events/stream` — Server-Sent Events stream for real-time updates
  ```
  ?run_id=run_123
  ```

### Example: Starting a Run

```bash
curl -X POST http://localhost:8000/api/runs \
  -H "Content-Type: application/json" \
  -d '{
    "pipeline_id": "engineering",
    "task_description": "Create a REST API for a todo app using FastAPI"
  }'
```

Response:
```json
{
  "id": "run_1708000000_abc123",
  "pipeline_id": "engineering",
  "status": "running",
  "task_description": "Create a REST API for a todo app using FastAPI",
  "created_at": 1708000000000
}
```

## Development

### Local Development Setup

**Requirements:**
- Node.js 20+
- Python 3.12+
- Redis (or use Docker)

**Setup:**

```bash
# Install dependencies
npm install
cd cli && pip install -e . && cd ..

# Start Redis (if not using Docker)
redis-server

# Start API server
cd packages/server
pip install -r requirements.txt
uvicorn app.main:app --reload --port 8000

# Start engine worker (separate terminal)
cd packages/core
npm run build
node dist/main.js

# Start dashboard (separate terminal)
cd packages/dashboard
npm run dev
```

### Building

```bash
# Build all packages
npm run build

# Build specific package
npm run build --filter=@djinnbot/core
```

### Type Checking

```bash
npm run typecheck
```

### Linting

```bash
npm run lint
```

## Configuration

### Environment Variables

#### Required
- `OPENROUTER_API_KEY` — OpenRouter API key for LLM access
- `REDIS_URL` — Redis connection string (default: `redis://localhost:6379`)
- `DATABASE_PATH` — SQLite database path (default: `./data/djinnbot.db`)

#### Optional
- `PIPELINES_DIR` — Pipeline YAML directory (default: `./pipelines`)
- `AGENTS_DIR` — Agent persona directory (default: `./agents`)
- `VAULTS_DIR` — ClawVault storage directory (default: `./data/vaults`)
- `DATA_DIR` — General data directory (default: `./data`)
- `API_PORT` — API server port (default: `8000`)
- `DASHBOARD_PORT` — Dashboard port (default: `3000`)
- `REDIS_PORT` — Redis port (default: `6379`)
- `MOCK_RUNNER` — Use mock agent runner for testing (default: `false`)

#### Slack Integration (Optional)
- `SLACK_CHANNEL_ID` — Default Slack channel for run threads
- `SLACK_<AGENT>_BOT_TOKEN` — Per-agent bot token (e.g., `SLACK_ERIC_BOT_TOKEN`)
- `SLACK_<AGENT>_APP_TOKEN` — Per-agent app token (e.g., `SLACK_ERIC_APP_TOKEN`)

### Agent Configuration

Each agent can override defaults in their persona definition or `slack.yml`:

**agents/eric/slack.yml:**
```yaml
bot_token: ${SLACK_ERIC_BOT_TOKEN}
app_token: ${SLACK_ERIC_APP_TOKEN}
```

### Pipeline Configuration

Pipeline defaults can be set at the root level:

```yaml
defaults:
  model: openrouter/moonshotai/kimi-k2.5
  tools:
    - read
    - write
    - bash
  maxRetries: 3
  timeout: 3600
```

Individual steps can override any default:

```yaml
steps:
  - id: SPEC
    agent: eric
    model: anthropic/claude-opus-4  # Override default
    timeout: 7200                   # Override default
```

## License

MIT License - see LICENSE file for details.

---

**Built with:**
- [Pi-Agent-Core](https://github.com/mariozechner/pi-agent-core) — Agent runtime
- [ClawVault](https://github.com/koi-labs-org/clawvault) — Persistent memory
- [FastAPI](https://fastapi.tiangolo.com/) — API server
- [React](https://react.dev/) — Dashboard UI
- [Redis Streams](https://redis.io/docs/data-types/streams/) — Event bus
- [Better-SQLite3](https://github.com/WiseLibs/better-sqlite3) — State storage

**Domain:** [djinn.bot](https://djinn.bot) (coming soon)
