---
title: Local Development
weight: 3
---

For contributing to DjinnBot or running without Docker.

## Prerequisites

- **Node.js 20+**
- **Python 3.12+** with pip
- **PostgreSQL 16**
- **Redis 7+**
- **Go** (for Hugo module support, if building docs)
- **Docker** (still needed for agent containers and mcpo)

## Setup

### Install Dependencies

```bash
# TypeScript packages (monorepo root)
npm install

# Python API server
cd packages/server
pip install -e ".[dev]"
cd ../..

# Python CLI
cd cli
pip install -e .
cd ..
```

### Start Infrastructure

You need PostgreSQL and Redis running. The simplest way is Docker for just those services:

```bash
docker compose up -d postgres redis
```

Or run them locally:

```bash
# macOS
brew services start postgresql@16
brew services start redis
```

### Start Services

Run each service in a separate terminal:

```bash
# 1. API Server
cd packages/server
uvicorn app.main:app --reload --port 8000

# 2. Pipeline Engine
cd packages/core
npm run build
node dist/main.js

# 3. Dashboard (dev server with hot reload)
cd packages/dashboard
npm run dev
```

### Environment Variables

Create a `.env` file at the repo root:

```bash
OPENROUTER_API_KEY=sk-or-v1-your-key
DATABASE_URL=postgresql+asyncpg://djinnbot:djinnbot@localhost:5432/djinnbot
REDIS_URL=redis://localhost:6379
PIPELINES_DIR=./pipelines
AGENTS_DIR=./agents
LOG_LEVEL=DEBUG
```

## Build

```bash
# Build all TypeScript packages
npm run build

# Build specific package
npm run build --filter=@djinnbot/core

# Type checking
npm run typecheck

# Linting
npm run lint
```

## Project Structure

The monorepo uses [Turborepo](https://turbo.build/) for build orchestration:

```
package.json          # Root workspace config
turbo.json            # Build pipeline config
packages/
├── core/             # Pipeline engine (TypeScript)
│   └── src/
│       ├── engine/       # Pipeline state machine
│       ├── events/       # Redis Streams event bus
│       ├── runtime/      # Agent executor
│       ├── container/    # Docker container management
│       ├── memory/       # ClawVault integration
│       ├── mcp/          # MCP/mcpo manager
│       ├── skills/       # Skill registry
│       ├── chat/         # Chat session manager
│       ├── projects/     # Project/task management
│       ├── lifecycle/    # Agent activity tracking
│       └── sessions/     # Session management
├── server/           # API server (Python/FastAPI)
│   └── app/
│       ├── routers/      # REST endpoints (30+ routers)
│       ├── models/       # SQLAlchemy models
│       ├── services/     # Business logic
│       └── alembic/      # Database migrations
├── dashboard/        # Web UI (React/TypeScript)
│   └── src/
│       ├── routes/       # TanStack Router pages
│       ├── components/   # React components
│       ├── hooks/        # Custom React hooks
│       └── lib/          # API client, SSE, formatters
├── slack/            # Slack integration (TypeScript)
│   └── src/
│       ├── slack-bridge.ts
│       ├── agent-slack-runtime.ts
│       └── thread-manager.ts
└── agent-runtime/    # Container entrypoint (TypeScript)
    └── src/
        ├── entrypoint.ts
        ├── agent/        # Agent initialization
        └── tools/        # Container-side tools (bash, read, write, edit)
```

## Database Migrations

The API server uses Alembic for PostgreSQL migrations:

```bash
cd packages/server

# Check migration status
alembic current

# Create a new migration
alembic revision --autogenerate -m "add_new_field"

# Run migrations
alembic upgrade head
```

Migrations run automatically on API server startup via `ensure_migrations()`.
