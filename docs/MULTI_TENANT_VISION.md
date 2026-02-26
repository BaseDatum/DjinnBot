# Project Vision: DjinnBot Multi-Tenant Migration

## What This Project Is

DjinnBot is an autonomous AI agent platform — a distributed system where specialized AI agents collaborate to deliver software through pipelines, pulse-driven task execution, and a kanban-based project board. The platform currently operates as a single-tenant system where all users share agents, projects, memory vaults, pipelines, and infrastructure.

**This project transforms DjinnBot into a multi-tenant SaaS platform** where each tenant has fully isolated agents, data, memory, infrastructure, and configuration — then decomposes the monolithic API server into purpose-built microservices.

## Why This Matters

The current architecture has zero tenant isolation. All users see all agents, all projects, all memory vaults, all secrets, all pipelines. This blocks:
- **Commercial deployment** — can't offer DjinnBot as a hosted service
- **Data safety** — one user's secrets/memory could leak to another
- **Scalability** — can't independently scale hot services (SSE, engine, memory)
- **Operational independence** — a single user's runaway agent affects everyone

## Goals (What Success Looks Like)

1. **Complete tenant isolation** — no endpoint returns data from another tenant. Enforced at query layer, not just route layer.
2. **Agents defined in database** — agents move from filesystem directories to DB-backed entities owned by tenants, with a global template catalog for cloning.
3. **Pipelines defined in database** — pipelines move from YAML files to DB-backed entities, with system defaults seeded from disk as `is_global = true`.
4. **Tenant-scoped infrastructure** — Redis keys, JuiceFS paths, container mounts all namespaced by tenant. Kubernetes NetworkPolicies for production isolation.
5. **Microservice decomposition** — monolithic FastAPI server split into auth-svc, project-svc, agent-svc, memory-svc, sse-relay, webhook-gw, slack-svc, engine-svc, mcp-svc. HAProxy for ingress and routing (no custom API gateway).
6. **Registration flow** — new users create an account + tenant in one step. OIDC auto-provisions tenants.
7. **Dashboard updates** — registration page, agent creation UI, tenant-scoped settings, pipeline management.
8. **Zero cross-tenant data leaks** — defense in depth across DB constraints, API filtering, Redis namespacing, filesystem scoping, and container network isolation.
9. **Horizontal scalability** — every service scales horizontally. Engine uses Redis consumer groups. Slack uses partitioned scaling. MCP uses lease-based process ownership. No in-memory singleton state.
10. **Kubernetes-first production** — production deployments on Kubernetes via Helm chart (`DEPLOYMENT_MODE=kubernetes`). Agent-runtime runs as bare K8s Pods. JuiceFS via CSI driver. PostgreSQL and Redis as managed services. All services support HPA autoscaling. Docker Compose for development/debugging only.

## Non-Goals

- Per-tenant billing/metering (future)
- Organization/team management within a tenant (future — currently 1:1 user:tenant)
- Multi-region deployment (future)

---

## Architecture Overview

### Current State (Single-Tenant Monolith)

```
Docker Compose: postgres, redis, rustfs, juicefs, api (FastAPI), engine (Node.js), mcpo, dashboard, agent-runtime (dynamic)
```

All data is flat — no tenant concept. Agents are filesystem directories. Pipelines are YAML files. Memory vaults are global. Redis keys are unscoped.

### Target State (Multi-Tenant Microservices)

```
HAProxy (ingress/TLS/rate-limit) → auth-svc, project-svc, agent-svc, sse-relay, memory-svc, engine-svc, webhook-gw, slack-svc, mcp-svc
                                 → dashboard (nginx)
```

- **No custom API gateway**: HAProxy handles ingress, TLS termination, path-based routing, and rate limiting (stick-tables). Each service validates its own JWT using a shared `AUTH_SECRET_KEY`. No single point of auth failure.
- **Tenant model**: Row-level isolation via mandatory `tenant_id` on every user-scoped table
- **Agents**: Database-defined, tenant-owned, with global template catalog. Globally unique PK (`agt_xxxxxxxxxxxx`), `UNIQUE(tenant_id, slug)` for human-readable uniqueness within a tenant.
- **Pipelines**: Database-defined, tenant-owned, with system defaults (`is_global = true`)
- **Redis**: All keys namespaced `djinnbot:t:{tenantId}:...`. Consumer groups for engine event processing. Leases for mcp-svc and slack-svc coordination.
- **Filesystem**: `/data/tenants/{tenantId}/vaults/`, `/data/tenants/{tenantId}/runs/`, etc.
- **Containers**: Kubernetes NetworkPolicies for production tenant isolation. Per-tenant Docker networks in compose mode (dev/debug only, acceptable network limits for development).
- **Orchestration**: Docker Compose (dev/debug) or Kubernetes via Helm chart (`DEPLOYMENT_MODE` env var). Agent-runtime spawned as Docker containers or bare K8s Pods (restartPolicy: Never).
- **Data layer**: PostgreSQL and Redis as managed services in production (RDS/Cloud SQL, ElastiCache/Memorystore). PgBouncer for connection pooling. In-cluster instances for development only.

### Tenancy Strategy

**Row-level tenant isolation.** Every user-scoped table gets a mandatory `tenant_id` column referencing the `tenants` table. A tenant is an account (initially 1:1 with a user on signup; expandable to organizations later).

```sql
CREATE TABLE tenants (
    id              VARCHAR(64) PRIMARY KEY,  -- ten_xxxxxxxxxxxx
    name            VARCHAR(256) NOT NULL,
    slug            VARCHAR(128) NOT NULL UNIQUE,
    owner_user_id   VARCHAR(64),              -- nullable for bootstrap (see creation protocol)
    status          VARCHAR(32) NOT NULL DEFAULT 'active',
    created_at      BIGINT NOT NULL,
    updated_at      BIGINT NOT NULL
);
```

**Tenant-User Creation Protocol**: The tenants and users tables have a circular dependency (tenant references owner user, user references tenant). Resolved with a two-phase insert in a single transaction: (1) INSERT tenant with `owner_user_id = NULL`, (2) INSERT user with `tenant_id`, (3) UPDATE tenant SET `owner_user_id`, (4) COMMIT. See MIGRATION.md 2.2.1 for full details.

---

## Tech Stack

| Component | Technology |
|-----------|-----------|
| API Services | Python / FastAPI + SQLAlchemy + Alembic |
| Engine | TypeScript / Node.js (pipeline execution, container orchestration) |
| Agent Runtime | TypeScript / Node.js (runs inside per-run containers) |
| Dashboard | React + TanStack Router + Vite + Tailwind |
| Database | PostgreSQL 16 (managed service in production, PgBouncer for connection pooling) |
| Event Bus | Redis 7 (Streams + Pub/Sub) (managed service in production) |
| Object Storage | RustFS (S3-compatible) |
| Filesystem | JuiceFS FUSE mount (CSI driver in Kubernetes) |
| Ingress | HAProxy (path-based routing, TLS, rate limiting via stick-tables) |
| MCP Service | mcp-svc (FastAPI, wraps mcpo with Redis lease-based process management) |
| Containers | Docker (compose mode) or bare K8s Pods (kubernetes mode) |
| Orchestration | Docker Compose (dev/debug) or Kubernetes + Helm (production) |
| Shared Schemas | packages/shared-schemas/ (Pydantic models, semver, additive-only changes) |
| Build System | Turborepo (npm workspaces) |

---

## Implementation Phases

This migration is executed in two distinct stages. **Stage 1 (Multi-Tenancy) completes and is validated before Stage 2 (Decomposition) begins.** This ordering is non-negotiable — attempting both simultaneously multiplies failure modes and makes cross-tenant bugs indistinguishable from cross-service bugs.

### Stage 1: Multi-Tenancy

#### Phase 1: Tenant Data Model & Auth
- Create `tenants` table and add `tenant_id` to all user-scoped tables (~50 tables)
- Create `agents` table (DB-defined, globally unique PK, `UNIQUE(tenant_id, slug)`)
- Create `pipelines` table (DB-defined)
- Implement tenant-user creation protocol (two-phase insert)
- Modify auth to create tenant on signup, include `tenant_id` in JWT
- Create `get_tenant_id()` FastAPI dependency and `TenantFilter` mixin
- Alembic migration ordering: create tenants first, add nullable columns, populate, add NOT NULL constraint

#### Phase 2: Row-Level Tenant Isolation
- Create `TenantMixin` base class for SQLAlchemy models
- Update every router to use `get_tenant_id()` dependency
- Update every DB query to filter by `tenant_id`
- Add DB-level `CHECK (tenant_id IS NOT NULL)` constraints

#### Phase 3: Agent & Pipeline DB Migration
- Create agents table CRUD API, agent template catalog
- Create `pipelines` table CRUD API, seed global pipelines from disk
- Update engine to resolve configs from API instead of filesystem

#### Phase 4: Filesystem Tenant Scoping
- Scope all JuiceFS paths: vaults, sandboxes, workspaces, runs, MCP configs
- Update `ContainerManager` to mount tenant-scoped subdirectories

#### Phase 5: Redis Tenant Namespacing
- All channel generators accept `tenantId`
- EventBus namespaces all keys: `djinnbot:t:{tenantId}:...`
- Agent-runtime uses tenant-scoped Redis channels
- SSE endpoints read from tenant-scoped streams

#### Phase 5.1: Stage 1 Validation Gate
Before proceeding to Stage 2, validate:
- Tenant isolation integration tests pass (cross-tenant access denied on all endpoints)
- End-to-end flow: registration -> agent creation -> chat -> memory -> project
- Redis key isolation verification (no flat keys remain)
- Container filesystem isolation verification
- SSE stream isolation (tenant A cannot receive tenant B's events)

### Stage 2: Decomposition & Scaling

#### Phase 6: Horizontal Scaling Infrastructure
- Engine: replace XREAD with XREADGROUP consumer groups, move pipeline cache/container registry/active runs to Redis
- Engine: implement KubernetesContainerManager for bare K8s Pod spawning with orphan cleanup
- Slack: implement Redis-based partition manager with consistent hashing
- MCP: implement lease-based process ownership with compose-mode fallback (single instance, no lease coordination)
- All services: no in-memory singleton state, unique instance ID generation

#### Phase 7: Microservice Decomposition
- Extract: auth-svc, project-svc, agent-svc, sse-relay, memory-svc, webhook-gw, slack-svc
- Create: mcp-svc (replaces raw mcpo sidecar)
- Add independent JWT validation to every service (shared `AUTH_SECRET_KEY`)
- Create HAProxy configuration (path-based routing to backends)
- Create all Dockerfiles and Helm chart (`deploy/helm/djinnbot/`)

#### Phase 8: Dashboard Updates
- Registration page, agent creation/management UI
- Auth context with tenant info, pipeline management
- Verify all existing pages work with tenant-scoped backend

#### Phase 9: Testing & Hardening
- Horizontal scaling tests: engine (3 replicas, no duplicate runs), slack (partition rebalance), mcp (lease failover)
- Load testing for multi-tenant SSE delivery
- Container/Redis/filesystem isolation verification
- Kubernetes Helm deployment test on a test cluster
- End-to-end registration -> agent creation -> chat -> memory -> project flow

---

## Key Data Model Changes

### New Tables
- `tenants` — tenant identity and ownership (with circular FK resolution via creation protocol)
- `agents` (DB-defined) — replaces filesystem `agents/` directories. Globally unique PK (`agt_xxxxxxxxxxxx`), `UNIQUE(tenant_id, slug)`.
- `pipelines` (DB-defined) — replaces filesystem `pipelines/` YAML files

### Tables Requiring `tenant_id` Addition
Over 50 tables need a mandatory `tenant_id` column with foreign key to `tenants(id)` and composite indexes. Major ones include:
- `users`, `runs`, `steps`, `sessions`, `projects`, `tasks`, `kanban_columns`
- `chat_sessions`, `chat_messages`, `secrets`, `agent_secret_grants`
- `mcp_servers`, `skills`, `pulse_routines`, `model_providers`, `global_settings`
- `llm_call_logs`, `memory_scores`, `github_app_configs`, `webhook_events`

### Agents Table (Key Schema)
```sql
CREATE TABLE agents (
    id              VARCHAR(128) PRIMARY KEY,  -- globally unique: agt_xxxxxxxxxxxx
    tenant_id       VARCHAR(64) NOT NULL REFERENCES tenants(id),
    name            VARCHAR(256) NOT NULL,
    slug            VARCHAR(128) NOT NULL,     -- URL-safe, tenant-unique
    -- persona files as columns (no filesystem)
    identity_md     TEXT,
    soul_md         TEXT,
    agents_md       TEXT,
    decision_md     TEXT,
    config_json     TEXT NOT NULL DEFAULT '{}',
    UNIQUE(tenant_id, slug)
);
```

---

## Branching & PR Policy

- **Base branch**: `multi-tenant`
- All feature branches are created FROM `multi-tenant`
- All PRs target `multi-tenant` as merge base
- Never branch from or target `main` directly
- Branch naming: `feat/task_{taskId}-{description}`

---

## Engineering Standards

### Tenant Isolation (Mandatory)
- Every endpoint filters by `tenant_id` from JWT — no exceptions
- DB queries use `TenantFilter` mixin — defense in depth
- Redis keys include tenant namespace — `djinnbot:t:{tenantId}:...`
- JuiceFS paths scoped to `/data/tenants/{tenantId}/...`
- Kubernetes NetworkPolicies for production container isolation. Per-tenant Docker networks for dev/debug only.
- Even if JWT is forged, DB constraints prevent cross-tenant access

### Microservice Design Rules
- Single responsibility per service
- No shared mutable state except DB and Redis
- No direct cross-service DB queries — use HTTP or Redis
- No custom API gateway — HAProxy handles routing, TLS, and rate limiting
- Independent JWT validation per service — shared `AUTH_SECRET_KEY`, no centralized auth dependency
- Circuit breakers on all inter-service calls (httpx with retries)
- Health check on every service: `GET /health/live` and `GET /health/ready` (K8s liveness/readiness differentiation)
- Structured JSON logging with `tenant_id`, `request_id`, `service_name`, `instance_id`
- All write operations through Redis must be idempotent
- **No in-memory state for distributed data** — all shared state in Redis or PostgreSQL. In-memory caches must have TTLs and invalidation channels.
- **Stateless by default** — every service safe to run as N replicas. Exceptions: slack-svc and mcp-svc use soft Redis leases.
- Only engine-svc has Docker socket access (compose mode) or K8s Pod RBAC (kubernetes mode)
- **Shared schema package** (`packages/shared-schemas/`): Cross-service Pydantic models versioned with semver. Changes must be additive only. Removals go through deprecation. CI validates backward compatibility.

### Security Standards
- Tenant isolation at query layer, not just route layer
- Independent JWT validation — no single point of auth failure
- Container network isolation per tenant (Kubernetes NetworkPolicies in production)
- Filesystem isolation per tenant
- Redis key isolation per tenant
- Per-IP rate limiting at HAProxy (stick-tables). Per-tenant rate limiting at service level (Redis counters).
- Existing AES-256-GCM secret encryption retained
- In K8s: agent-runtime Pods restricted to Redis + service backends + mcp-svc + internet egress only. No access to other tenants' Pods, K8s API server, or internal services.
- No privileged containers except JuiceFS CSI driver. Engine uses RBAC, not Docker socket, in K8s mode.

### Production Infrastructure Standards
- PostgreSQL and Redis as managed services (not in-cluster)
- PgBouncer for connection pooling (10+ services sharing one Postgres)
- Redis: Sentinel for HA. Shard by function if single-thread throughput becomes a bottleneck (event streams, leases/locks, caching on separate instances).
- Redis eviction policy: `volatile-lru` (not `allkeys-lru` — prevents silent eviction of lease keys and consumer group state)

---

## Key Files & Directories

| Path | What It Contains |
|------|-----------------|
| `packages/server/` | Current monolithic FastAPI API server (to be decomposed) |
| `packages/core/` | Engine — pipeline execution, containers, events, memory, swarm |
| `packages/agent-runtime/` | Runs inside per-run Docker containers |
| `packages/dashboard/` | React SPA frontend |
| `packages/slack/` | Slack bot bridges |
| `packages/shared-schemas/` | Cross-service Pydantic models (semver, additive-only) |
| `agents/` | Current filesystem-based agent definitions (migrating to DB) |
| `pipelines/` | Current filesystem-based pipeline YAML (migrating to DB) |
| `deploy/haproxy/` | HAProxy configuration for routing |
| `deploy/helm/djinnbot/` | Kubernetes Helm chart |
| `MIGRATION.md` | Complete technical specification for this migration |

---

## Current Priorities

1. **Phase 1-2 (highest)**: Tenant data model, auth changes, row-level isolation — this is the foundation everything else builds on
2. **Phase 3 (high)**: Agent & pipeline DB migration — unblocks tenant-scoped agent management
3. **Phase 4-5 (high)**: Filesystem and Redis scoping — completes the isolation layer
4. **Phase 5.1 (gate)**: Stage 1 validation — must pass before any decomposition work begins
5. **Phase 6 (high)**: Horizontal scaling infrastructure — must be done before microservice split to avoid retrofitting
6. **Phase 7 (medium)**: Microservice decomposition + HAProxy config + Helm chart — can proceed incrementally
7. **Phase 8 (medium)**: Dashboard updates — can start in parallel with Phase 3+
8. **Phase 9 (high, after others)**: Testing & hardening — must be thorough before any production deployment

---

## What Agents Need to Know

- **Finn**: Architecture reviews must verify tenant isolation in every PR — check DB queries for `tenant_id` scoping, Redis key namespacing, filesystem path scoping. No microservices beyond what's specified. No custom API gateway — HAProxy only.
- **Shigeo**: Dashboard UX needs tenant context — tenant switcher (future), scoped settings, registration flow, agent creation forms.
- **Yukihiro**: Every DB query must include `tenant_id`. Use `TenantMixin` and `get_tenant_id()` dependency. Never write unscoped queries. Test with multi-tenant scenarios. Agents table uses globally unique PK with `UNIQUE(tenant_id, slug)`. Tenant creation uses two-phase insert protocol.
- **Chieko**: Test cross-tenant isolation explicitly — Tenant A must never see Tenant B's data. Test at API, Redis, filesystem, and container levels.
- **Stas**: Container spawning must use Kubernetes NetworkPolicies (production) or per-tenant Docker networks (dev). JuiceFS mounts scoped to tenant subdirectories. Redis keys namespaced. Health checks (liveness + readiness) on every service. Engine must work with both Docker and K8s backends — no in-memory singleton state. Agent-runtime as bare K8s Pods (restartPolicy: Never), not Jobs. PostgreSQL and Redis are managed services in production — never in-cluster. PgBouncer required.
- **Yang**: Build/CI must support multi-tenant branch as base. Dev environment needs multi-tenant simulation. Error messages for tenant-related failures must be clear. Helm chart at `deploy/helm/djinnbot/` must be tested in CI. Shared schemas package needs CI backward-compat validation.
