Part 1: Current-State Architecture Analysis
1.1 Current Topology

┌─────────────────────────────────────────────────────────┐
│                    Docker Compose                        │
│                                                          │
│  ┌──────────┐  ┌──────────┐  ┌──────────┐  ┌─────────┐ │
│  │ postgres │  │  redis   │  │  rustfs  │  │ juicefs │ │
│  │ :5432    │  │  :6379   │  │  :9000   │  │  FUSE   │ │
│  └──────────┘  └──────────┘  └──────────┘  └─────────┘ │
│                                                          │
│  ┌──────────┐  ┌──────────┐  ┌──────────┐  ┌─────────┐ │
│  │   api    │  │  engine  │  │   mcpo   │  │dashboard│ │
│  │ :8000    │  │ (Node)   │  │  :8001   │  │  :3000  │ │
│  └──────────┘  └──────────┘  └──────────┘  └─────────┘ │
│                                                          │
│  ┌─────────────────────────────┐                         │
│  │   agent-runtime (dynamic,   │                         │
│  │   spawned per-run by engine │                         │
│  │   via Docker socket)        │                         │
│  └─────────────────────────────┘                         │
└─────────────────────────────────────────────────────────┘

1.2 Critical Architectural Facts
Component 	Technology 	Role
packages/server (api) 	Python/FastAPI + SQLAlchemy + PostgreSQL 	REST API, auth, all CRUD, SSE streaming
packages/core (engine) 	TypeScript/Node.js 	Pipeline execution, container orchestration, event bus, memory (ClawVault/QMDR)
packages/agent-runtime 	TypeScript/Node.js 	Runs inside per-run containers; agent loop, tools, memory I/O
packages/dashboard 	React + TanStack Router + Vite 	SPA frontend
packages/slack 	TypeScript/Node.js 	Slack bot bridges (embedded in engine)
Redis 	ioredis / redis.asyncio 	Event bus (Streams), pub/sub (commands, MCP grants), SSE relay, caching
JuiceFS + RustFS 	FUSE + S3 	Shared filesystem for vaults, sandboxes, workspaces, runs
Docker Socket 	Docker API 	Engine spawns agent-runtime containers dynamically
1.3 Current Auth Model

The system already has a user model (packages/server/app/models/auth.py) with JWT auth, TOTP 2FA, OIDC, API keys, and an is_admin flag. However, there is no tenant concept. The User model is flat — all users share the same set of agents, projects, pipelines, memory vaults, secrets, MCP servers, and settings. Agents are filesystem-defined (./agents/ directory) and globally visible.
1.4 Current Data Isolation Gaps

    Agents: Defined as filesystem directories (AGENTS_DIR). No per-user ownership. All users see all agents.
    Memory Vaults: Stored on JuiceFS at /data/vaults/{agentId}/. No user scoping. All agents share a global shared vault.
    Sandboxes: /data/sandboxes/{agentId}/. No user scoping.
    Projects: No owner_id or tenant_id column. All projects visible to all users.
    Runs/Sessions/Chat: Runs have initiated_by_user_id but no mandatory tenant filter. Sessions have user_id but queries don't filter by it.
    Pipelines: Filesystem-based (PIPELINES_DIR). Global.
    Settings/Providers: model_providers and global_settings are instance-wide. user_model_providers exists but settings like default models are global.
    Secrets: Have owner_user_id and scope but AgentSecretGrant has no tenant constraint.
    MCP Servers: Global. submitted_by_user_id exists but no tenant filtering.
    Skills: Global. No per-user scoping.
    Redis Channels: All use flat keys like djinnbot:events:run:{runId}. No tenant namespace.
    SSE Endpoints: No tenant filtering — any authenticated user can subscribe to any run's events.
    Container Spawning: Engine has Docker socket access. No tenant isolation on container env vars, network, or filesystem mounts.

Part 2: Multi-Tenant Data Model
2.1 Tenancy Strategy: Row-Level Tenant Isolation

Every user-scoped table gets a mandatory tenant_id column. A tenant is an account (initially 1:1 with a user on signup; expandable to organizations later). Agents become database-defined entities owned by tenants instead of filesystem directories.
2.2 New tenants Table

CREATE TABLE tenants (
    id          VARCHAR(64) PRIMARY KEY,      -- ten_xxxxxxxxxxxx
    name        VARCHAR(256) NOT NULL,
    slug        VARCHAR(128) NOT NULL UNIQUE,  -- URL-safe identifier
    owner_user_id VARCHAR(64),                 -- SET after user creation (see 2.2.1)
    status      VARCHAR(32) NOT NULL DEFAULT 'active',  -- active, suspended, deleted
    created_at  BIGINT NOT NULL,
    updated_at  BIGINT NOT NULL
);
CREATE INDEX idx_tenants_owner ON tenants(owner_user_id);
CREATE INDEX idx_tenants_slug ON tenants(slug);

-- FK added after both tables exist (see 2.2.1)
-- ALTER TABLE tenants ADD CONSTRAINT fk_tenants_owner FOREIGN KEY (owner_user_id) REFERENCES users(id);

2.2.1 Tenant-User Creation Protocol

The tenants and users tables have a circular dependency: a tenant references its owner user, and a user references its tenant. This is resolved with a two-phase insert within a single transaction:

1. INSERT tenant with owner_user_id = NULL
2. INSERT user with tenant_id = tenant.id
3. UPDATE tenant SET owner_user_id = user.id
4. COMMIT

The owner_user_id column is nullable to support this bootstrap sequence. The FK constraint from tenants.owner_user_id → users(id) is added via ALTER TABLE after both tables are created in the Alembic migration. An application-level CHECK ensures owner_user_id is never NULL after the creation transaction completes (enforced in the auth-svc registration endpoint, not as a DB constraint).

2.3 users Table Additions

ALTER TABLE users ADD COLUMN tenant_id VARCHAR(64) REFERENCES tenants(id) ON DELETE CASCADE;
CREATE INDEX idx_users_tenant ON users(tenant_id);

2.4 New agents Table (Replacing Filesystem)

CREATE TABLE agents (
    id              VARCHAR(128) PRIMARY KEY,     -- globally unique: agt_xxxxxxxxxxxx
    tenant_id       VARCHAR(64) NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    name            VARCHAR(256) NOT NULL,
    slug            VARCHAR(128) NOT NULL,         -- URL-safe, tenant-unique
    emoji           VARCHAR(16),
    role            VARCHAR(256),
    description     TEXT DEFAULT '',
    model           VARCHAR(256),                  -- default working model
    thinking_level  VARCHAR(32) DEFAULT 'off',
    pulse_enabled   BOOLEAN NOT NULL DEFAULT false,
    -- persona files stored as columns (no filesystem)
    identity_md     TEXT,
    soul_md         TEXT,
    agents_md       TEXT,
    decision_md     TEXT,
    -- config.yml content stored as JSON
    config_json     TEXT NOT NULL DEFAULT '{}',
    -- slack config stored as JSON (was slack.yml)
    slack_config    TEXT,
    status          VARCHAR(32) NOT NULL DEFAULT 'active',
    created_at      BIGINT NOT NULL,
    updated_at      BIGINT NOT NULL,
    UNIQUE(tenant_id, slug)
);
CREATE INDEX idx_agents_tenant ON agents(tenant_id);

The primary key (id) is globally unique (generated as agt_{random}). The UNIQUE(tenant_id, slug) constraint ensures human-readable agent slugs are unique within a tenant while allowing different tenants to use the same slug (e.g., both tenants can have an agent with slug "researcher"). API endpoints that accept agentId use the globally unique id, not the slug. The slug is for display and URL purposes only.

2.5 Tables Requiring tenant_id Column Addition

Every table below needs tenant_id VARCHAR(64) NOT NULL REFERENCES tenants(id) ON DELETE CASCADE plus a composite index:
Table 	Current PK 	New Index
runs 	id 	idx_runs_tenant(tenant_id, status)
steps 	(run_id, step_id) 	idx_steps_tenant(tenant_id)
sessions 	id 	idx_sessions_tenant(tenant_id, agent_id)
session_events 	id 	via session.tenant_id
projects 	id 	idx_projects_tenant(tenant_id, status)
kanban_columns 	id 	via project.tenant_id
tasks 	id 	idx_tasks_tenant(tenant_id, project_id)
dependency_edges 	id 	via project.tenant_id
project_workflows 	id 	via project.tenant_id
task_runs 	id 	via task.tenant_id
project_agents 	(project_id, agent_id) 	idx_project_agents_tenant(tenant_id)
chat_sessions 	id 	idx_chat_sessions_tenant(tenant_id, agent_id)
chat_messages 	id 	via session.tenant_id
chat_attachments 	id 	via session.tenant_id
onboarding_sessions 	id 	idx_onboarding_tenant(tenant_id)
onboarding_messages 	id 	via session.tenant_id
model_providers 	provider_id 	becomes (tenant_id, provider_id) PK
global_settings 	key 	becomes (tenant_id, key) PK
agent_channel_credentials 	(agent_id, channel) 	idx_channel_creds_tenant(tenant_id)
secrets 	id 	idx_secrets_tenant(tenant_id)
agent_secret_grants 	id 	idx_secret_grants_tenant(tenant_id)
mcp_servers 	id 	idx_mcp_servers_tenant(tenant_id)
agent_mcp_tools 	id 	idx_mcp_tools_tenant(tenant_id)
skills 	id 	idx_skills_tenant(tenant_id)
agent_skills 	(agent_id, skill_id) 	idx_agent_skills_tenant(tenant_id)
pulse_routines 	id 	idx_pulse_routines_tenant(tenant_id)
project_templates 	id 	idx_templates_tenant(tenant_id) (+ allow global where tenant_id IS NULL)
project_agent_routines 	id 	via project.tenant_id
agent_tool_overrides 	composite 	idx_tool_overrides_tenant(tenant_id)
user_model_providers 	(user_id, provider_id) 	via user.tenant_id
admin_shared_providers 	id 	idx_shared_providers_tenant(tenant_id)
user_secret_grants 	id 	via user.tenant_id
llm_call_logs 	id 	idx_llm_calls_tenant(tenant_id)
memory_retrieval_logs 	id 	idx_memory_logs_tenant(tenant_id)
memory_valuations 	id 	via tenant_id
memory_gaps 	id 	via tenant_id
memory_scores 	id 	via tenant_id
github_app_configs 	id 	idx_github_config_tenant(tenant_id)
webhook_events 	id 	idx_webhook_events_tenant(tenant_id)
webhook_secrets 	id 	via tenant_id
project_github 	project_id 	via project.tenant_id
project_github_agents 	id 	via tenant_id
github_agent_triggers 	id 	via tenant_id
github_installation_state 	id 	via tenant_id

Alembic migration ordering: The migration must create the tenants table first, then add tenant_id as a nullable column to all tables, then populate tenant_id for any seed data, then add the NOT NULL constraint. This prevents FK violations during the migration. A single Alembic migration file with multiple operations in the correct order is preferred over multiple migration files.

2.6 New pipelines Table (Replacing Filesystem)

Pipelines are currently loaded from YAML files in ./pipelines/. They must become database entities for tenant scoping.

CREATE TABLE pipelines (
    id           VARCHAR(128) PRIMARY KEY,     -- pipeline slug e.g. "engineering"
    tenant_id    VARCHAR(64) REFERENCES tenants(id) ON DELETE CASCADE,
    name         VARCHAR(256) NOT NULL,
    description  TEXT DEFAULT '',
    yaml_content TEXT NOT NULL,
    is_global    BOOLEAN NOT NULL DEFAULT false,  -- system-provided pipelines (seeded from ./pipelines/)
    created_at   BIGINT NOT NULL,
    updated_at   BIGINT NOT NULL
);
CREATE INDEX idx_pipelines_tenant ON pipelines(tenant_id);

On first boot, sync_pipelines_from_disk() imports ./pipelines/*.yml as is_global = true, tenant_id = NULL rows. Tenants create their own pipelines via the API. The engine's PipelineEngine.pipelines map key changes from pipelineId to ${tenantId}:${pipelineId}. Cache miss triggers an API fetch.

2.7 Skills is_global Column

System skills (from ./skills/ directory) are stored with tenant_id IS NULL and is_global = true. Tenant-created skills have tenant_id set.

ALTER TABLE skills ADD COLUMN is_global BOOLEAN NOT NULL DEFAULT false;

The GET /v1/skills/ endpoint returns: WHERE tenant_id = :tid OR is_global = true. On startup, sync_skills_from_disk() imports from ./skills/ as is_global = true, tenant_id = NULL.

2.8 admin_shared_providers Tenant Scoping

The admin_shared_providers table needs tenant_id to scope sharing within a tenant:

ALTER TABLE admin_shared_providers ADD COLUMN tenant_id VARCHAR(64) REFERENCES tenants(id) ON DELETE CASCADE;
CREATE INDEX idx_admin_shared_providers_tenant ON admin_shared_providers(tenant_id);

Sharing is scoped within a tenant. The admin_user_id must be an admin within the same tenant_id. There is no cross-tenant sharing mechanism. Each tenant manages their own provider keys independently through the existing model_providers -> user_model_providers -> admin_shared_providers hierarchy, all scoped by tenant_id.

Part 3: Microservices Decomposition

IMPORTANT: This migration is executed in two distinct stages. Stage 1 (multi-tenancy) is completed and validated before Stage 2 (microservice decomposition) begins. The system must be fully tenant-isolated and running correctly as a monolith before any service extraction starts. See Part 8 for the explicit phase ordering.

3.1 Target Architecture

                    ┌──────────────┐
                    │   haproxy    │ (ingress/TLS/rate-limit)
                    │   :443/80    │
                    └──────┬───────┘
                           │
            ┌──────────────┼──────────────┐
            │              │              │
            ▼              ▼              ▼
     ┌────────────┐ ┌────────────┐ ┌────────────┐
     │  dashboard │ │ auth-svc   │ │ webhook-gw │
     │  (nginx)   │ │ (FastAPI)  │ │ (FastAPI)  │
     │   :3000    │ │   :8010    │ │   :8002    │
     └────────────┘ └────────────┘ └─────┬──────┘
                                         │
          ┌───────────────┬──────────────┼──────────────┐
          ▼               ▼              ▼              ▼
   ┌────────────┐  ┌────────────┐ ┌────────────┐ ┌──────────┐
   │ project-svc│  │ agent-svc  │ │ sse-relay  │ │ mcp-svc  │
   │ (FastAPI)  │  │ (FastAPI)  │ │ (FastAPI)  │ │ (FastAPI) │
   │   :8020    │  │   :8030    │ │   :8040    │ │   :8001  │
   └────────────┘  └────────────┘ └────────────┘ └──────────┘
          │               │              │
          ▼               ▼              ▼
   ┌────────────┐  ┌────────────┐ ┌────────────┐
   │ memory-svc │  │ engine-svc │ │ slack-svc  │
   │ (FastAPI)  │  │ (Node.js)  │ │ (Node.js)  │
   │   :8050    │  │   :8060    │ │   :8070    │
   └────────────┘  └────────────┘ └────────────┘
          │               │
          ▼               ▼
   ┌────────────┐  ┌──────────────────────┐
   │ postgres   │  │ agent-runtime (N)    │
   │  (managed) │  │ (spawned dynamically)│
   └────────────┘  └──────────────────────┘
          │
   ┌────────────┐  ┌──────────┐  ┌──────────┐
   │   redis    │  │  rustfs  │  │ juicefs  │
   │  (managed) │  │  :9000   │  │  FUSE    │
   └────────────┘  └──────────┘  └──────────┘

3.2 Ingress & Routing: HAProxy

There is no custom API gateway service. HAProxy replaces both the ingress layer and request routing:

- TLS termination
- Path-based routing to backend services (ACL rules mapping URL prefixes to backends)
- Per-IP and per-tenant rate limiting via stick-tables
- Health-check-based backend selection
- Load balancing (round-robin with health checks for stateless services)

Each backend service validates its own JWT and extracts tenant_id independently. This eliminates a single point of auth failure and allows services to be tested and deployed independently. The JWT contains tenant_id as a claim, signed with a shared AUTH_SECRET_KEY that all services have access to.

HAProxy configuration maps URL prefixes to backends:
- /v1/auth/* -> auth-svc
- /v1/agents/*, /v1/agents/*/lifecycle, /v1/agents/*/sandbox, /v1/agents/*/queue, /v1/agents/*/inbox, /v1/agents/*/channels, /v1/agents/*/tools, /v1/agents/*/pulse-routines -> agent-svc
- /v1/projects/*, /v1/project-templates/*, /v1/onboarding/* -> project-svc
- /v1/memory/*, /v1/ingest/*, /v1/memory-scores/* -> memory-svc
- /v1/runs/*, /v1/pipelines/*, /v1/internal/* -> engine-svc
- /v1/events/* -> sse-relay
- /v1/webhooks/* -> webhook-gw
- /v1/mcp/* -> mcp-svc
- /v1/chat/*, /v1/agents/*/chat/* -> agent-svc (or a dedicated chat-svc if extracted later)
- /v1/secrets/*, /v1/settings/*, /v1/users/*, /v1/llm-calls/*, /v1/user-usage/*, /v1/skills/*, /v1/pulses/*, /v1/slack/*, /v1/github/* -> routed to owning service per decomposition table below

3.3 Service Decomposition Table
Service 	Owns 	Source Path 	Dockerfile
auth-svc 	User registration, login, JWT, TOTP, OIDC, API keys, tenant provisioning 	packages/server/app/routers/auth.py, users.py, waitlist.py 	Dockerfile.auth
project-svc 	Projects, tasks, kanban, workflows, dependency graph, onboarding, templates 	packages/server/app/routers/projects/, onboarding.py, project_templates.py 	Dockerfile.project
agent-svc 	Agent CRUD, lifecycle, config, sandbox, queue, inbox, channels, tools, pulse routines, chat, chat sessions, attachments, pulses, skills, secrets, settings, slack config 	packages/server/app/routers/agents.py, lifecycle.py, sandbox.py, queue.py, inbox.py, etc. 	Dockerfile.agent
memory-svc 	Vaults, graph, search, memory scores, ingest 	packages/server/app/routers/memory.py, memory_scores.py, ingest.py 	Dockerfile.memory
engine-svc 	Pipeline execution, container orchestration, run management, step execution 	packages/core/ (existing engine) 	Dockerfile.engine (existing, modified)
sse-relay 	All SSE endpoints, Redis->SSE fan-out, tenant-scoped event delivery 	packages/sse-relay/ (new) 	Dockerfile.sse-relay
webhook-gw 	GitHub webhook ingestion, signature verification, event storage 	packages/server/app/routers/github_webhooks.py 	Dockerfile.webhook
slack-svc 	Slack bot connections, message bridging 	packages/slack/ (extracted from engine) 	Dockerfile.slack
mcp-svc 	MCP server management, tool invocation, process pool 	packages/server/app/routers/mcp.py + mcpo 	Dockerfile.mcp
dashboard 	Frontend SPA 	packages/dashboard/ 	Dockerfile.dashboard (existing)

3.4 Inter-Service Communication
From -> To 	Protocol 	Channel
HAProxy -> all services 	HTTP (routing) 	External traffic routed by URL prefix
service -> service (internal) 	HTTP (direct) 	Docker Compose DNS / Kubernetes DNS (e.g., auth-svc:8010)
engine-svc -> agent-runtime 	Redis pub/sub 	djinnbot:run:{runId}:* channels
Any service -> sse-relay 	Redis Streams 	djinnbot:tenant:{tenantId}:events:*
sse-relay -> dashboard 	SSE (HTTP) 	Per-tenant scoped EventSource
webhook-gw -> Redis 	Redis pub/sub 	djinnbot:webhooks:github
All services -> Redis 	Redis pub/sub 	Event broadcasting

Internal service-to-service calls use direct HTTP via DNS (Docker Compose service names or Kubernetes service DNS). No traffic goes through HAProxy for internal calls. Each service is configured with the URLs of services it depends on via environment variables (e.g., AUTH_SVC_URL, AGENT_SVC_URL).

3.5 Redis Key Namespacing

All Redis keys must be tenant-scoped:

# Current (flat):
djinnbot:events:run:{runId}
djinnbot:events:global
djinnbot:run:{runId}:commands
djinnbot:run:{runId}:status
djinnbot:mcp:grants-changed
djinnbot:tools:overrides-changed

# New (tenant-namespaced):
djinnbot:t:{tenantId}:events:run:{runId}
djinnbot:t:{tenantId}:events:global
djinnbot:t:{tenantId}:run:{runId}:commands
djinnbot:t:{tenantId}:run:{runId}:status
djinnbot:t:{tenantId}:mcp:grants-changed
djinnbot:t:{tenantId}:tools:overrides-changed
djinnbot:t:{tenantId}:webhooks:github

3.5.1 Global Event Stream Strategy

The djinnbot:events:global Redis stream (used by the background listener in main.py for run completion, step events, and planning run auto-import) remains a single global stream. Every event published to it includes a tenantId field:

{
  "type": "RUN_COMPLETE",
  "tenantId": "ten_abc123",
  "runId": "run_xyz",
  "timestamp": 1234567890
}

The background listener (moved to engine-svc) processes events from this stream using a Redis consumer group (djinnbot:cg:engine-workers) so that when multiple engine-svc replicas are running, each event is processed by exactly one instance (see 3.8.3A for full consumer group design). DB queries within the listener use tenantId from the event for correct scoping.

For SSE delivery to dashboards, tenant-specific streams djinnbot:t:{tenantId}:events:global are used. The engine publishes to BOTH the global stream (for backend listeners) and the tenant-specific stream (for SSE relay). This dual-publish pattern prevents the SSE relay from needing to filter a global stream.

Affected files:
- packages/core/src/events/channels.ts — Add tenantGlobalChannel(tenantId: string) returning djinnbot:t:${tenantId}:events:global
- packages/core/src/engine/pipeline-engine.ts — Dual-publish to both global and tenant channel
- packages/server/app/main.py (_run_completion_listener) — Moved to engine-svc, reads from global stream, extracts tenantId per event

3.6 Filesystem Namespacing (JuiceFS)

# Current:
/data/vaults/{agentId}/
/data/sandboxes/{agentId}/
/data/workspaces/{projectId}/
/data/runs/{runId}/
/data/mcp/config.json

# New:
/data/tenants/{tenantId}/vaults/{agentId}/
/data/tenants/{tenantId}/sandboxes/{agentId}/
/data/tenants/{tenantId}/workspaces/{projectId}/
/data/tenants/{tenantId}/runs/{runId}/
/data/tenants/{tenantId}/mcp/config.json

3.7 MCP (mcpo) Multi-Tenant Strategy

mcpo currently reads a single config.json and serves all MCP tools on one port. Multi-tenant requires per-tenant isolation.

Architecture decision: Per-tenant mcpo config files.

Implementation:
1. agent-svc writes MCP server configs to /data/tenants/{tenantId}/mcp/config.json when servers are added/modified via the API.
2. When the engine spawns an agent-runtime container, it sets MCPO_CONFIG_PATH=/data/tenants/{tenantId}/mcp/config.json. The agent-runtime's MCP tool discovery already uses the API's /v1/mcp/agents/{agentId}/tools endpoint which returns tenant-scoped tool lists.
3. For MVP, use a single mcpo instance but namespace server entries as {tenantId}__{serverId} in the config JSON. Agent tool resolution in the runtime uses the API endpoint which filters by tenant.

Affected files:
- packages/server/app/routers/mcp.py — _sync_mcpo_config() writes to /data/tenants/{tenantId}/mcp/config.json
- packages/core/src/container/runner.ts — Sets MCPO_CONFIG_PATH per-tenant when spawning containers
- packages/agent-runtime/src/agent/mcp-tools.ts — Already uses API to discover tools; no structural change needed

3.7.1 MCP Horizontal Scaling Architecture

The per-tenant config file approach from 3.7 does NOT scale horizontally because each mcpo instance manages local child processes for stdio-based MCP servers. Running multiple replicas would spawn duplicate child processes.

Architecture: MCP Gateway with shared process registry.

Replace the raw mcpo sidecar with an mcp-svc (FastAPI) that wraps mcpo as a library or manages it as a subprocess pool:

1. mcp-svc is a new FastAPI service that:
   a. Owns the mcp_servers and agent_mcp_tools tables.
   b. Exposes /v1/mcp/invoke/{tenantId}/{serverId}/{toolName} — the single entry point for tool execution.
   c. Manages MCP server processes internally using a process pool keyed by (tenantId, serverId).
   d. Uses Redis distributed locks to ensure only ONE instance manages a given (tenantId, serverId) stdio process at a time.

2. Process ownership via Redis lease:
   - Key: djinnbot:mcp:lease:{tenantId}:{serverId}
   - Value: {instanceId} (unique per mcp-svc pod)
   - TTL: 30s, renewed every 10s by the owning instance via heartbeat.
   - On lease expiry (instance crash), another instance acquires the lease and spawns the process.
   - For SSE/HTTP-based MCP servers, no lease is needed — any instance can proxy directly.

3. Process routing:
   - When mcp-svc receives an invoke request:
     a. If server type is SSE/HTTP: proxy directly (stateless, any replica handles it).
     b. If server type is stdio: check Redis lease. If THIS instance owns the lease, invoke locally. If another instance owns it, forward the request via HTTP to the owning instance using a Redis-stored endpoint: djinnbot:mcp:endpoint:{tenantId}:{serverId} -> "http://mcp-svc-pod-3:8001".
   - This means mcp-svc instances must be addressable by pod IP (Kubernetes headless service).

4. Compose-mode fallback: When DEPLOYMENT_MODE=compose, mcp-svc runs as a single instance (replicas: 1). No lease coordination or request forwarding is needed — all stdio processes are owned by the single instance. The lease/routing code is bypassed entirely via a config check: if DEPLOYMENT_MODE == "compose", skip lease acquisition and invoke locally always. This avoids the Docker Compose limitation where individual container replicas are not directly addressable.

5. Idle process eviction:
   - Stdio processes that are idle for >10 minutes are killed and the lease is released.
   - This prevents resource waste for tenants with many configured but rarely-used MCP servers.
   - djinnbot:mcp:last-used:{tenantId}:{serverId} tracks last invocation timestamp.

6. No container-per-tenant: All tenants share the same mcp-svc replica set. Process isolation is at the OS process level (each stdio MCP server runs as a child process). Resource limits (memory, CPU) are enforced per-process via ulimit or cgroup controls.

Affected files:
- packages/mcp-svc/ (new) — New FastAPI service wrapping mcpo process management
- packages/mcp-svc/app/process_pool.py — Manages stdio child processes with Redis lease coordination
- packages/mcp-svc/app/routers/invoke.py — Tool invocation endpoint with lease-based routing
- packages/mcp-svc/app/routers/management.py — CRUD for mcp_servers (moved from packages/server/app/routers/mcp.py)
- packages/mcp-svc/app/lease.py — Redis lease acquisition/renewal/forwarding logic
- packages/agent-runtime/src/agent/mcp-tools.ts — Call /v1/mcp/invoke/{tenantId}/{serverId}/{toolName} instead of mcpo directly
- Dockerfile.mcp — Builds mcp-svc with mcpo as a dependency (pip install mcpo or bundled binary)

Redis keys for MCP scaling:
  djinnbot:mcp:lease:{tenantId}:{serverId}        -> instanceId (TTL 30s)
  djinnbot:mcp:endpoint:{tenantId}:{serverId}      -> "http://{podIP}:{port}" 
  djinnbot:mcp:last-used:{tenantId}:{serverId}     -> timestamp
  djinnbot:mcp:process-count:{instanceId}          -> integer (for load-aware routing)

3.8 Horizontal Scaling & Kubernetes

3.8.1 Deployment Mode

The platform supports two deployment modes controlled by the DEPLOYMENT_MODE environment variable:

  DEPLOYMENT_MODE=compose    (default) — Docker Compose for development and debugging
  DEPLOYMENT_MODE=kubernetes — Kubernetes with Helm chart for production deployments

Docker Compose mode is intended for local development, debugging, and single-node testing. Production deployments use Kubernetes.

When DEPLOYMENT_MODE=kubernetes:
- Service discovery uses Kubernetes DNS (e.g., auth-svc.djinnbot.svc.cluster.local)
- JuiceFS is mounted via a CSI driver (juicefs-csi) as a ReadWriteMany PersistentVolumeClaim instead of a privileged sidecar container
- The engine-svc spawns agent-runtime containers as bare Kubernetes Pods instead of Docker containers (see 3.8.4)
- Ingress is handled by HAProxy Ingress Controller
- All services support replica counts > 1 via Kubernetes Deployments
- PostgreSQL and Redis are expected to be managed services (RDS/Cloud SQL, ElastiCache/Memorystore) — not running in-cluster

3.8.2 Horizontal Scaling Matrix

Service             Min Replicas  Max Replicas  Scaling Strategy            Stateful?
─────────────────── ──────────── ──────────── ──────────────────────────── ─────────
auth-svc            2             5             HPA on CPU                  No
project-svc         2             5             HPA on CPU                  No
agent-svc           2             5             HPA on CPU                  No
memory-svc          2             5             HPA on CPU                  No
engine-svc          2             10            HPA on queue depth          No (see 3.8.3)
sse-relay           2             10            HPA on connection count     No
webhook-gw          2             5             HPA on CPU                  No
slack-svc           1             N             Partitioned (see 3.8.5)     Soft (leases)
mcp-svc             2             5             Lease-based (see 3.7.1)     Soft (leases)
dashboard           2             5             HPA on CPU                  No

HPA = Kubernetes Horizontal Pod Autoscaler

PostgreSQL and Redis: In production (Kubernetes mode), these are managed services (AWS RDS / Cloud SQL for Postgres; AWS ElastiCache / GCP Memorystore for Redis). They are NOT run as StatefulSets in-cluster. Managed services provide automatic failover, backups, read replicas, and connection pooling. In Docker Compose mode (dev/debug), they run as local containers.

Connection pooling: All services connect to PostgreSQL through PgBouncer (deployed as a sidecar or standalone pod). With 10+ services each maintaining async connection pools, direct connections to Postgres would exhaust max_connections. PgBouncer in transaction mode multiplexes connections efficiently.

Redis considerations: For production workloads with high event throughput, use Redis with Sentinel for HA. If single-thread throughput becomes a bottleneck (measurable via redis-cli --latency and INFO stats), shard by function: one Redis instance for event streams (high throughput), one for leases/locks (low throughput, high consistency), one for caching (tolerates eviction). This is simpler than Redis Cluster and avoids cross-slot limitations with multi-key operations.

3.8.3 engine-svc Horizontal Scaling

The engine is the most critical service to scale. The current implementation has three in-memory structures that prevent horizontal scaling:

Problem 1: In-memory pipeline map (PipelineEngine.pipelines: Map<string, PipelineConfig>)
Problem 2: In-memory active runs set (PipelineEngine.activeRuns: Set<string>)
Problem 3: In-memory container registry (ContainerManager.containers: Map<string, ContainerInfo>)

All three are moved to Redis:

A) Redis Consumer Groups for Event Processing

The EventBus (packages/core/src/events/event-bus.ts) currently uses plain XREAD which means every engine instance receives every event — causing duplicate processing. Replace with XREADGROUP:

Consumer group: djinnbot:cg:engine-workers
Each engine instance gets a unique consumer ID: engine-{hostname}-{pid}
Only ONE instance receives each event from the stream.
Failed messages are reclaimed via XPENDING + XCLAIM after 60s idle.

Affected files:
- packages/core/src/events/event-bus.ts — Replace XREAD with XREADGROUP. Add consumer group creation on startup (XGROUP CREATE ... MKSTREAM). Add XACK after successful processing. Add pending message reclaim loop.
- packages/core/src/engine/pipeline-engine.ts — Remove activeRuns Set. Use Redis SETNX lock per run:
    Key: djinnbot:lock:run:{runId}
    Value: {instanceId}
    TTL: 300s (matches container timeout)
    Before processing STEP_QUEUED, acquire lock. If lock exists, skip (another instance owns it).
    On run completion, delete lock.

B) Container Registry in Redis

Move ContainerManager.containers from in-memory Map to Redis hash:

  Key: djinnbot:containers:{runId}
  Fields: containerId, status, agentId, tenantId, createdAt, instanceId
  TTL: None (cleaned up explicitly on container stop)

Any engine instance can read/write container state. The instanceId field tracks which engine pod created the container (useful for cleanup on pod crash).

Affected files:
- packages/core/src/container/manager.ts — Replace this.containers Map with Redis hash operations:
    createContainer(): HSET djinnbot:containers:{runId} ...
    getContainer(): HGETALL djinnbot:containers:{runId}
    stopContainer(): DEL djinnbot:containers:{runId} after Docker stop
    listContainers(): SCAN for djinnbot:containers:* pattern
- packages/core/src/container/manager.ts — Add cleanup loop: on startup, scan for containers where instanceId matches this instance but Docker reports them as dead -> clean up Redis keys.

C) Pipeline Cache in Redis

Move PipelineEngine.pipelines from in-memory Map to Redis with TTL:

  Key: djinnbot:pipeline-cache:{tenantId}:{pipelineId}
  Value: JSON-serialized PipelineConfig
  TTL: 300s (5 minutes)

Cache miss -> fetch from API -> populate Redis. All engine instances share the cache.

Affected files:
- packages/core/src/engine/pipeline-engine.ts — Replace this.pipelines Map with Redis GET/SET:
    registerPipeline(): SET with TTL
    getPipeline(): GET, on miss fetch from API and SET
    Invalidation: when pipeline is updated via API, publish to djinnbot:pipeline:invalidate channel. Engine instances subscribe and DEL the cached key.

D) Kubernetes Pod Spawning

When DEPLOYMENT_MODE=kubernetes, the engine-svc spawns agent-runtime as bare Kubernetes Pods (not Jobs) instead of Docker containers. The engine already owns the full lifecycle — it creates the Pod, sends commands via Redis, monitors events, handles timeouts, cancels, and deletes. Job semantics (retries, backoffLimit, completion tracking) would duplicate and conflict with this existing orchestration.

Bare Pods advantages over Jobs:
- Faster startup: no Job controller reconciliation loop
- Clean cancellation: engine deletes the Pod directly, no cascading delete
- No retry fighting: if a Pod OOMs, the engine sees the failure and marks the run as failed — a Job controller would retry, creating a zombie
- Orphan cleanup is already handled by the engine startup sweep (see 3.8.3B) + a safety-net CronJob

Affected files:
- packages/core/src/container/manager.ts — Add KubernetesContainerManager implementing the same ContainerManager interface:
    Uses @kubernetes/client-node to create Pods in the djinnbot namespace
    Pod name: djinnbot-{tenantId[0:8]}-{runId}
    Pod spec includes:
      - restartPolicy: Never (engine manages retries, not the kubelet)
      - JuiceFS CSI volume mount (tenant-scoped subPath)
      - Resource limits from ContainerConfig (memoryLimit, cpuLimit)
      - Environment variables (same as Docker env)
      - Labels: djinnbot.io/managed-by=engine, djinnbot.io/tenant={tenantId}, djinnbot.io/run={runId}
      - Network policy restricting pod-to-pod traffic to same-tenant label
    Cleanup: engine deletes Pod on run completion/failure/timeout. Orphan safety net via CronJob (see below).
- packages/core/src/container/runner.ts — Accept ContainerManager interface (already does via constructor injection). No change needed — the runner is container-backend-agnostic.
- packages/core/src/config.ts — Read DEPLOYMENT_MODE env var. Instantiate DockerContainerManager or KubernetesContainerManager accordingly.

Orphan Pod cleanup:
- On startup, each engine instance: list Pods with label djinnbot.io/managed-by=engine, cross-reference Redis container registry (djinnbot:containers:{runId}). Delete any Pod whose runId has no Redis entry or whose Redis entry shows a dead instanceId.
- Safety-net CronJob (deploy/helm/djinnbot/templates/orphan-cleanup-cronjob.yaml): runs every 15 minutes, deletes Pods with label djinnbot.io/managed-by=engine that are older than 30 minutes (2x the default 300s timeout). This catches edge cases where all engine instances crash simultaneously.

New files:
- packages/core/src/container/k8s-manager.ts — KubernetesContainerManager implementation
- packages/core/src/container/k8s-types.ts — Kubernetes Pod spec types
- deploy/helm/djinnbot/templates/orphan-cleanup-cronjob.yaml — Safety-net CronJob for orphaned agent Pods

3.8.4 Agent Runtime on Kubernetes

Agent-runtime containers run as bare Kubernetes Pods (not Jobs). The engine-svc is the sole lifecycle manager — it creates, monitors, and deletes each Pod.

- Each run creates a single Pod with restartPolicy: Never
- Pod spec:
    metadata:
      name: djinnbot-{tenantId[0:8]}-{runId}
      labels:
        djinnbot.io/managed-by: engine
        djinnbot.io/tenant: {tenantId}
        djinnbot.io/run: {runId}
        djinnbot.io/agent: {agentId}
    spec:
      restartPolicy: Never    # Engine manages retries, not kubelet
      activeDeadlineSeconds: 600   # Hard kill safety net (2x default timeout)
      containers:
        - name: agent-runtime
          image: ${AGENT_RUNTIME_IMAGE}
          env: [... same env vars as Docker ...]
          resources:
            requests: { memory: "512Mi", cpu: "500m" }
            limits: { memory: "2Gi", cpu: "2" }
          volumeMounts:
            - name: tenant-data
              mountPath: /home/agent/clawvault
              subPath: tenants/{tenantId}/vaults/{agentId}
            - name: tenant-data
              mountPath: /home/agent/run-workspace
              subPath: tenants/{tenantId}/runs/{runId}
            - name: tenant-data
              mountPath: /home/agent/sandbox
              subPath: tenants/{tenantId}/sandboxes/{agentId}
      volumes:
        - name: tenant-data
          persistentVolumeClaim:
            claimName: djinnbot-juicefs-pvc   # ReadWriteMany via JuiceFS CSI

- Lifecycle:
    1. Engine creates Pod via @kubernetes/client-node createNamespacedPod()
    2. Engine watches Pod status (Running -> agent-runtime connects to Redis -> engine sends commands)
    3. On run completion/failure/timeout: engine deletes Pod via deleteNamespacedPod()
    4. Redis container registry entry cleaned up on delete
    5. If engine crashes: orphan cleanup on next engine startup + safety-net CronJob (see 3.8.3D)

- NetworkPolicy restricts egress to:
    - Redis (port 6379)
    - Service backends (direct HTTP for API calls)
    - mcp-svc (port 8001)
    - Internet (for LLM API calls, git clone, etc.)
  And blocks access to:
    - Other tenant Pods (label selector: djinnbot.io/tenant != {tenantId})
    - Kubernetes API server
    - Other internal services (postgres, auth-svc, etc.)

3.8.5 slack-svc Partitioned Scaling

Slack Socket Mode maintains a persistent WebSocket per bot token. Multiple replicas connecting the same bot token would cause duplicate message processing.

Strategy: Redis-based partition assignment with consistent hashing.

How it works:
1. Each slack-svc instance registers itself in Redis on startup:
     SADD djinnbot:slack:instances {instanceId}
     SET djinnbot:slack:heartbeat:{instanceId} 1 EX 15

2. A partition rebalance runs when:
   - An instance starts up
   - An instance's heartbeat expires (detected via keyspace notification or polling)
   - Tenant bot tokens are added/removed

3. Partition assignment algorithm:
   - Collect all active bot token entries from DB: SELECT DISTINCT agent_id, tenant_id FROM agent_channel_credentials WHERE channel = 'slack' AND enabled = true
   - Collect all live instances from Redis: SMEMBERS djinnbot:slack:instances (filtered by valid heartbeat)
   - Assign each (tenant_id, agent_id) to an instance via consistent hashing (hash ring on instanceId)
   - Write assignments to Redis:
       SET djinnbot:slack:assignment:{tenantId}:{agentId} {instanceId}
   - Each instance reads its assignments and connects ONLY the bot tokens assigned to it.

4. On rebalance:
   - Instances compare their current connections to new assignments
   - Disconnect tokens no longer assigned to them
   - Connect newly assigned tokens
   - Grace period: 5s overlap to prevent message drops during handoff

5. Singleton fallback: When only 1 instance is running (DEPLOYMENT_MODE=compose), it owns all tokens. No partitioning overhead.

Affected files:
- packages/slack/src/partition-manager.ts (new) — Implements consistent hashing, heartbeat, rebalance
- packages/slack/src/connection-manager.ts — Modified to accept token assignments from partition manager instead of connecting all tokens
- packages/slack/src/index.ts — On startup: register instance, run initial rebalance, subscribe to rebalance triggers

Redis keys for slack partitioning:
  djinnbot:slack:instances                          -> Set of instanceIds
  djinnbot:slack:heartbeat:{instanceId}             -> 1 (TTL 15s, renewed every 5s)
  djinnbot:slack:assignment:{tenantId}:{agentId}    -> instanceId
  djinnbot:slack:rebalance-trigger                  -> pub/sub channel (publish on token add/remove/instance change)

3.8.6 Kubernetes Manifests

The project ships a Helm chart at deploy/helm/djinnbot/:

deploy/helm/djinnbot/
├── Chart.yaml
├── values.yaml
├── templates/
│   ├── _helpers.tpl
│   ├── namespace.yaml
│   ├── configmap.yaml                    # Shared env vars
│   ├── secret.yaml                       # Passwords, API keys, encryption keys
│   ├── haproxy-configmap.yaml            # HAProxy routing configuration
│   ├── haproxy-deployment.yaml           # HAProxy ingress
│   ├── haproxy-service.yaml              # LoadBalancer or NodePort
│   ├── pgbouncer-deployment.yaml         # Connection pooling for managed Postgres
│   ├── pgbouncer-service.yaml
│   ├── juicefs-pvc.yaml                  # ReadWriteMany PVC via JuiceFS CSI
│   ├── auth-svc-deployment.yaml
│   ├── auth-svc-service.yaml
│   ├── project-svc-deployment.yaml
│   ├── project-svc-service.yaml
│   ├── agent-svc-deployment.yaml
│   ├── agent-svc-service.yaml
│   ├── memory-svc-deployment.yaml
│   ├── memory-svc-service.yaml
│   ├── engine-svc-deployment.yaml
│   ├── engine-svc-service.yaml
│   ├── engine-svc-hpa.yaml
│   ├── engine-svc-rbac.yaml              # ServiceAccount + Role for creating/deleting Pods
│   ├── sse-relay-deployment.yaml
│   ├── sse-relay-service.yaml
│   ├── webhook-gw-deployment.yaml
│   ├── webhook-gw-service.yaml
│   ├── slack-svc-deployment.yaml
│   ├── slack-svc-service.yaml            # Headless for pod-to-pod (rebalance)
│   ├── mcp-svc-deployment.yaml
│   ├── mcp-svc-service.yaml              # Headless for lease-based routing
│   ├── dashboard-deployment.yaml
│   ├── dashboard-service.yaml
│   ├── ingress.yaml                      # HAProxy Ingress Controller rules
│   ├── networkpolicy-agent-runtime.yaml  # Tenant-isolated agent pods
│   ├── networkpolicy-internal.yaml       # Service-to-service rules
│   └── orphan-cleanup-cronjob.yaml       # Safety-net cleanup for orphaned agent Pods

Key values.yaml entries:

  deploymentMode: kubernetes
  
  # External managed services (production)
  postgres:
    external: true
    host: "djinnbot-db.xxxx.us-east-1.rds.amazonaws.com"
    port: 5432
    database: djinnbot
    # Credentials via Secret reference
  
  redis:
    external: true
    host: "djinnbot-redis.xxxx.cache.amazonaws.com"
    port: 6379
    # Optional: separate instances for different workloads
    # eventStreamHost: ""   # High-throughput event streams
    # leaseHost: ""         # Locks and leases
  
  pgbouncer:
    enabled: true
    poolMode: transaction
    maxClientConn: 1000
    defaultPoolSize: 20
  
  engineSvc:
    replicas: 2
    resources:
      requests: { cpu: "500m", memory: "1Gi" }
      limits: { cpu: "2", memory: "4Gi" }
    hpa:
      minReplicas: 2
      maxReplicas: 10
      targetCPUUtilization: 70
  
  slackSvc:
    replicas: 2
    resources:
      requests: { cpu: "250m", memory: "512Mi" }
  
  mcpSvc:
    replicas: 2
    resources:
      requests: { cpu: "250m", memory: "512Mi" }
  
  agentRuntime:
    image: ghcr.io/basedatum/djinnbot/agent-runtime:latest
    defaultResources:
      requests: { cpu: "500m", memory: "512Mi" }
      limits: { cpu: "2", memory: "2Gi" }
    activeDeadlineSeconds: 600      # Hard kill safety net (2x default engine timeout)
    orphanCleanupMaxAge: 1800       # CronJob deletes pods older than 30 minutes
  
  juicefs:
    csiDriver: true
    metaUrl: redis://redis:6379/2
    storageClass: juicefs-sc

Part 4: Complete API Endpoint Changes
4.1 New Endpoints
Method 	Path 	Service 	Description
POST 	/v1/auth/register 	auth-svc 	Public signup — creates user + tenant
GET 	/v1/tenants/me 	auth-svc 	Get current user's tenant
PUT 	/v1/tenants/me 	auth-svc 	Update tenant name/slug
POST 	/v1/agents/ 	agent-svc 	Create a new agent (DB-defined)
DELETE 	/v1/agents/{agentId} 	agent-svc 	Delete an agent
POST 	/v1/agents/{agentId}/clone 	agent-svc 	Clone from template catalog
GET 	/v1/agents/templates 	agent-svc 	List agent templates (global catalog)
4.2 All Existing Endpoints Requiring Tenant Filtering

Every endpoint below must inject tenant_id from the JWT/session context and filter all DB queries by it. Each service validates its own JWT using the shared AUTH_SECRET_KEY. The format is: [HTTP method] [path] -> [router file].

Auth Router (packages/server/app/routers/auth.py)

    POST /v1/auth/setup — Must create tenant on first user setup
    POST /v1/auth/login — Return tenant_id in token claims
    POST /v1/auth/refresh — Preserve tenant_id claim
    GET /v1/auth/me — Return tenant_id in response
    POST /v1/auth/oidc/{slug}/callback — Auto-create tenant for new OIDC users

Agents Router (packages/server/app/routers/agents.py)

    GET /v1/agents/ — Filter by tenant_id
    GET /v1/agents/status — Filter by tenant_id
    GET /v1/agents/{agentId} — Verify tenant_id ownership
    GET /v1/agents/{agentId}/config — Verify tenant_id
    PUT /v1/agents/{agentId}/config — Verify tenant_id
    PUT /v1/agents/{agentId}/files/{filename} — Verify tenant_id
    GET /v1/agents/{agentId}/memory — Scoped vault path
    DELETE /v1/agents/{agentId}/memory/{path} — Scoped vault path

Lifecycle Router (packages/server/app/routers/lifecycle.py)

    GET /v1/agents/{agentId}/lifecycle — Filter by tenant_id
    GET /v1/agents/{agentId}/activity — Filter by tenant_id
    GET /v1/agents/{agentId}/activity/stats — Filter by tenant_id
    GET /v1/agents/{agentId}/wake-stats — Filter by tenant_id
    GET /v1/agents/{agentId}/work-ledger — Filter by tenant_id

Sandbox Router (packages/server/app/routers/sandbox.py)

    GET /v1/agents/{agentId}/sandbox — Tenant-scoped path
    GET /v1/agents/{agentId}/sandbox/file — Tenant-scoped path
    GET /v1/agents/{agentId}/sandbox/tree — Tenant-scoped path
    POST /v1/agents/{agentId}/sandbox/reset — Tenant-scoped path

Queue Router (packages/server/app/routers/queue.py)

    GET /v1/agents/{agentId}/queue — Filter by tenant_id
    DELETE /v1/agents/{agentId}/queue/{itemId} — Verify tenant_id
    POST /v1/agents/{agentId}/queue/clear — Verify tenant_id

Inbox Router (packages/server/app/routers/inbox.py)

    GET /v1/agents/{agentId}/inbox — Filter by tenant_id
    POST /v1/agents/{agentId}/inbox — Set tenant_id
    POST /v1/agents/{agentId}/inbox/mark-read — Verify tenant_id
    POST /v1/agents/{agentId}/inbox/clear — Verify tenant_id

Channels Router (packages/server/app/routers/channels.py)

    GET /v1/agents/{agentId}/channels — Filter by tenant_id
    PUT /v1/agents/{agentId}/channels/{channel} — Verify tenant_id
    DELETE /v1/agents/{agentId}/channels/{channel} — Verify tenant_id

Agent Tools Router (packages/server/app/routers/agent_tools.py)

    GET /v1/agents/{agentId}/tools/overrides — Filter by tenant_id
    PUT /v1/agents/{agentId}/tools/overrides — Verify tenant_id

Pulse Routines Router (packages/server/app/routers/pulse_routines.py)

    GET /v1/agents/{agentId}/pulse-routines — Filter by tenant_id
    POST /v1/agents/{agentId}/pulse-routines — Set tenant_id
    GET /v1/agents/{agentId}/pulse-routines/{routineId} — Verify tenant_id
    PUT /v1/agents/{agentId}/pulse-routines/{routineId} — Verify tenant_id
    DELETE /v1/agents/{agentId}/pulse-routines/{routineId} — Verify tenant_id

Runs Router (packages/server/app/routers/runs.py)

    GET /v1/runs/ — Filter by tenant_id
    POST /v1/runs/ — Set tenant_id
    GET /v1/runs/{runId} — Verify tenant_id
    PATCH /v1/runs/{runId} — Verify tenant_id
    DELETE /v1/runs/{runId} — Verify tenant_id
    DELETE /v1/runs/ (bulk) — Filter by tenant_id
    POST /v1/runs/{runId}/cancel — Verify tenant_id
    POST /v1/runs/{runId}/restart — Verify tenant_id
    GET /v1/runs/{runId}/logs — Verify tenant_id

Steps Router (packages/server/app/routers/steps.py)

    POST /v1/runs/{runId}/steps/{stepId}/restart — Verify tenant_id

Pipelines Router (packages/server/app/routers/pipelines.py)

    GET /v1/pipelines/ — Return WHERE tenant_id = :tid OR is_global = true
    POST /v1/pipelines/ — (new) Create tenant-owned pipeline, set tenant_id
    GET /v1/pipelines/{pipelineId} — Verify tenant access (owner or global)
    GET /v1/pipelines/{pipelineId}/raw — Verify tenant access (owner or global)
    PUT /v1/pipelines/{pipelineId} — Verify tenant ownership (cannot modify global)
    DELETE /v1/pipelines/{pipelineId} — (new) Verify tenant ownership (cannot delete global)
    POST /v1/pipelines/{pipelineId}/validate — Verify tenant access

Events Router (packages/server/app/routers/events.py)

    GET /v1/events/stream/{runId} — Verify tenant_id before streaming; use tenant-scoped Redis key
    GET /v1/events/stream (global) — Filter to tenant-scoped Redis stream

Memory Router (packages/server/app/routers/memory.py)

    GET /v1/memory/vaults — Tenant-scoped VAULTS_DIR
    GET /v1/memory/search — Tenant-scoped search
    GET /v1/memory/vaults/{agentId} — Tenant-scoped path
    GET /v1/memory/vaults/{agentId}/{path} — Tenant-scoped path
    PUT /v1/memory/vaults/{agentId}/{path} — Tenant-scoped path
    POST /v1/memory/vaults/{agentId}/files — Tenant-scoped path
    GET /v1/memory/vaults/{agentId}/graph — Tenant-scoped
    POST /v1/memory/vaults/{agentId}/graph/rebuild — Tenant-scoped
    GET /v1/memory/vaults/{agentId}/graph/neighbors/{nodeId} — Tenant-scoped
    GET /v1/memory/vaults/shared/graph — Tenant-scoped shared vault
    WS /v1/memory/vaults/{agentId}/graph/ws — Tenant-scoped

Projects Router (packages/server/app/routers/projects/)

    GET /v1/projects/ — Filter by tenant_id
    POST /v1/projects/ — Set tenant_id
    GET /v1/projects/{projectId} — Verify tenant_id
    PUT /v1/projects/{projectId} — Verify tenant_id
    DELETE /v1/projects/{projectId} — Verify tenant_id
    POST /v1/projects/{projectId}/archive — Verify tenant_id
    GET /v1/projects/{projectId}/tasks — Verify tenant_id
    POST /v1/projects/{projectId}/tasks — Set tenant_id
    GET /v1/projects/{projectId}/tasks/{taskId} — Verify tenant_id
    PUT /v1/projects/{projectId}/tasks/{taskId} — Verify tenant_id
    DELETE /v1/projects/{projectId}/tasks/{taskId} — Verify tenant_id
    POST /v1/projects/{projectId}/tasks/{taskId}/move — Verify tenant_id
    POST /v1/projects/{projectId}/tasks/{taskId}/execute — Verify tenant_id
    POST /v1/projects/{projectId}/tasks/{taskId}/execute-agent — Verify tenant_id
    POST /v1/projects/{projectId}/execute-ready — Verify tenant_id
    GET /v1/projects/{projectId}/ready-tasks — Verify tenant_id
    POST /v1/projects/{projectId}/tasks/{taskId}/dependencies — Verify tenant_id
    DELETE /v1/projects/{projectId}/tasks/{taskId}/dependencies/{depId} — Verify tenant_id
    GET /v1/projects/{projectId}/dependency-graph — Verify tenant_id
    GET /v1/projects/{projectId}/workflows — Verify tenant_id
    POST /v1/projects/{projectId}/workflows — Verify tenant_id
    PUT /v1/projects/{projectId}/workflows/{workflowId} — Verify tenant_id
    POST /v1/projects/{projectId}/import — Verify tenant_id
    POST /v1/projects/{projectId}/plan — Verify tenant_id
    GET /v1/projects/{projectId}/timeline — Verify tenant_id

Workspaces Router (packages/server/app/routers/workspaces.py)

    GET /v1/workspaces/{runId} — Verify tenant_id, tenant-scoped path
    GET /v1/workspaces/{runId}/{path} — Verify tenant_id
    GET /v1/workspaces/{runId}/git/history — Verify tenant_id
    GET /v1/workspaces/{runId}/git/status — Verify tenant_id
    GET /v1/workspaces/{runId}/git/diff/{commitHash} — Verify tenant_id
    GET /v1/workspaces/{runId}/git/show/{commitHash}/{filePath} — Verify tenant_id
    GET /v1/workspaces/{runId}/git/file-history/{filePath} — Verify tenant_id
    GET /v1/workspaces/{runId}/conflicts/{file} — Verify tenant_id
    POST /v1/workspaces/{runId}/merge — Verify tenant_id

Sessions Router (packages/server/app/routers/sessions.py)

    GET /v1/sessions — Filter by tenant_id
    GET /v1/agents/{agentId}/sessions — Filter by tenant_id
    GET /v1/sessions/{sessionId} — Verify tenant_id
    POST /v1/sessions/{sessionId}/stop — Verify tenant_id

Chat Router (packages/server/app/routers/chat.py)

    POST /v1/agents/{agentId}/chat/start — Set tenant_id
    POST /v1/agents/{agentId}/chat/{sessionId}/message — Verify tenant_id
    PATCH /v1/agents/{agentId}/chat/{sessionId}/model — Verify tenant_id
    POST /v1/agents/{agentId}/chat/{sessionId}/stop — Verify tenant_id
    POST /v1/agents/{agentId}/chat/{sessionId}/end — Verify tenant_id
    POST /v1/agents/{agentId}/chat/{sessionId}/restart — Verify tenant_id
    GET /v1/agents/{agentId}/chat/{sessionId}/status — Verify tenant_id

Chat Sessions Router (packages/server/app/routers/chat_sessions.py)

    GET /v1/chat/sessions/{sessionId} — Verify tenant_id
    GET /v1/agents/{agentId}/chat/sessions — Filter by tenant_id

Attachments Router (packages/server/app/routers/attachments.py)

    POST /v1/agents/{agentId}/chat/{sessionId}/upload — Verify tenant_id, tenant-scoped storage
    GET /v1/chat/attachments/{attachmentId}/content — Verify tenant_id

Pulses Router (packages/server/app/routers/pulses.py)

    GET /v1/pulses/timeline — Filter by tenant_id
    GET /v1/pulses/agents/{agentId}/schedule — Verify tenant_id
    PUT /v1/pulses/agents/{agentId}/schedule — Verify tenant_id
    POST /v1/pulses/agents/{agentId}/schedule/one-off — Verify tenant_id
    DELETE /v1/pulses/agents/{agentId}/schedule/one-off/{ts} — Verify tenant_id
    POST /v1/pulses/auto-spread — Filter by tenant_id
    GET /v1/agents/{agentId}/pulse/status — Verify tenant_id
    POST /v1/agents/{agentId}/pulse/trigger — Verify tenant_id

Onboarding Router (packages/server/app/routers/onboarding.py)

    POST /v1/onboarding/sessions — Set tenant_id
    GET /v1/onboarding/sessions/{sessionId} — Verify tenant_id
    POST /v1/onboarding/sessions/{sessionId}/message — Verify tenant_id
    GET /v1/onboarding/sessions — Filter by tenant_id

Skills Router (packages/server/app/routers/skills.py)

    GET /v1/skills/ — Return global + tenant-owned
    POST /v1/skills/ — Set tenant_id
    GET /v1/skills/{skillId} — Verify access
    PUT /v1/skills/{skillId} — Verify tenant_id
    DELETE /v1/skills/{skillId} — Verify tenant_id
    POST /v1/skills/{skillId}/agents/{agentId} — Verify tenant_id
    DELETE /v1/skills/{skillId}/agents/{agentId} — Verify tenant_id

Secrets Router (packages/server/app/routers/secrets.py)

    GET /v1/secrets/ — Filter by tenant_id
    POST /v1/secrets/ — Set tenant_id
    GET /v1/secrets/{secretId} — Verify tenant_id
    PUT /v1/secrets/{secretId} — Verify tenant_id
    DELETE /v1/secrets/{secretId} — Verify tenant_id
    GET /v1/secrets/agents/{agentId} — Verify tenant_id
    POST /v1/secrets/{secretId}/grant/{agentId} — Verify tenant_id
    DELETE /v1/secrets/{secretId}/grant/{agentId} — Verify tenant_id
    GET /v1/secrets/agents/{agentId}/env — Verify tenant_id (engine internal)

MCP Router (packages/server/app/routers/mcp.py)

    GET /v1/mcp/servers — Filter by tenant_id
    POST /v1/mcp/servers — Set tenant_id
    GET /v1/mcp/servers/{serverId} — Verify tenant_id
    PUT /v1/mcp/servers/{serverId} — Verify tenant_id
    DELETE /v1/mcp/servers/{serverId} — Verify tenant_id
    GET /v1/mcp/servers/{serverId}/tools — Verify tenant_id
    POST /v1/mcp/agents/{agentId}/grant — Verify tenant_id
    DELETE /v1/mcp/agents/{agentId}/revoke — Verify tenant_id
    GET /v1/mcp/agents/{agentId}/tools — Verify tenant_id

Settings Router (packages/server/app/routers/settings.py)

    GET /v1/settings/ — Filter by tenant_id
    PUT /v1/settings/ — Set tenant_id
    GET /v1/settings/providers — Filter by tenant_id
    PUT /v1/settings/providers/{providerId} — Set tenant_id
    DELETE /v1/settings/providers/{providerId} — Verify tenant_id
    GET /v1/settings/providers/keys/all — Filter by tenant_id

GitHub Router (packages/server/app/routers/github.py)

    GET /v1/github/status — Filter by tenant_id
    GET /v1/github/config — Filter by tenant_id
    PUT /v1/github/config — Set tenant_id
    All GitHub agent routers — Verify tenant_id

GitHub Webhooks Router (packages/server/app/routers/github_webhooks.py)

    POST /v1/webhooks/github — Resolve tenant from installation mapping

Admin Router (packages/server/app/routers/admin.py)

    GET /v1/admin/logs/stream/merged — Platform admin only (super-admin)
    GET /v1/admin/logs/stream/{container} — Platform admin only
    GET /v1/admin/logs/containers — Platform admin only
    GET /v1/admin/notifications — Platform admin only

Users Router (packages/server/app/routers/users.py)

    GET /v1/users/ — Filter by tenant_id (tenant admin sees their users)
    POST /v1/users/ — Create within tenant_id
    GET /v1/users/{userId} — Verify tenant_id
    PUT /v1/users/{userId} — Verify tenant_id
    DELETE /v1/users/{userId} — Verify tenant_id

LLM Calls Router (packages/server/app/routers/llm_calls.py)

    GET /v1/llm-calls — Filter by tenant_id
    POST /v1/llm-calls — Set tenant_id

User Usage Router (packages/server/app/routers/user_usage.py)

    GET /v1/user-usage/{userId} — Verify tenant_id

Internal Routers (packages/server/app/routers/spawn_executor.py, swarm_executor.py)

    POST /v1/internal/spawn-execute — Resolve tenant_id from run context
    POST /v1/internal/swarm-execute — Resolve tenant_id from run context
    GET /v1/internal/swarms — Filter by tenant_id

Ingest Router (packages/server/app/routers/ingest.py)

    POST /v1/ingest/file — Set tenant_id, tenant-scoped vault

Memory Scores Router (packages/server/app/routers/memory_scores.py)

    All endpoints — Filter by tenant_id

Project Templates Router (packages/server/app/routers/project_templates.py)

    GET /v1/project-templates/ — Return global + tenant-owned
    POST /v1/project-templates/ — Set tenant_id (or NULL for global)

Slack Router (packages/server/app/routers/slack.py)

    All endpoints — Filter by tenant_id

Updates Router (packages/server/app/routers/updates.py)

    GET /v1/system/updates/check — Platform admin only

Part 5: Dashboard (UI) Changes
5.1 Files Requiring Changes

Auth & Registration
File 	Change
packages/dashboard/src/lib/auth.ts 	Add tenantId to AuthUserInfo, AuthTokens. Add register() function.
packages/dashboard/src/hooks/useAuth.tsx 	Store tenantId in auth context.
packages/dashboard/src/routes/login.tsx 	Add registration link/tab.
packages/dashboard/src/routes/setup.tsx 	Becomes the registration flow (create account + tenant).
packages/dashboard/src/routes/__root.tsx 	PUBLIC_PATHS needs /register added.

New Routes
File 	Purpose
packages/dashboard/src/routes/register.tsx (new) 	Registration page (email, password, tenant name).
packages/dashboard/src/routes/agents/new.tsx (new) 	Agent creation form (replaces filesystem-based agent creation).

Agent Management (replacing filesystem reads)
File 	Change
packages/dashboard/src/routes/agents/index.tsx 	Remove filesystem assumptions. Agents come from API (DB-backed). Add "Create Agent" button.
packages/dashboard/src/routes/agents/$agentId.tsx 	Agent detail — all data from API. Persona editors save to DB.
packages/dashboard/src/lib/api.ts 	Add createAgent(), deleteAgent(), cloneAgent(), fetchAgentTemplates(), register(), createPipeline(), deletePipeline() functions. Update fetchAgents() (already API-backed, should work).

SSE Hooks — URL Changes
File 	Change
packages/dashboard/src/hooks/useSSE.ts 	No structural change (already uses API_BASE), but SSE endpoints move to sse-relay service. HAProxy routing handles this.
packages/dashboard/src/hooks/useChatStream.ts 	Same — endpoint stays at /v1/agents/{agentId}/chat/{sessionId}/stream but routed to sse-relay.
packages/dashboard/src/hooks/useLogStream.ts 	Admin log streaming stays but is platform-admin only.
packages/dashboard/src/hooks/useActivityStream.ts 	Tenant-scoped via backend.
packages/dashboard/src/hooks/useSwarmSSE.ts 	Tenant-scoped via backend.
packages/dashboard/src/hooks/useGraphWebSocket.ts 	WebSocket URL changes to go through HAProxy.
packages/dashboard/src/hooks/useMemoryWebSocket.ts 	WebSocket URL changes to go through HAProxy.

Settings & Admin
File 	Change
packages/dashboard/src/routes/settings.tsx 	Settings are now tenant-scoped. Remove "instance" language, use "workspace" or "tenant".
packages/dashboard/src/routes/admin.tsx 	Platform admin panel — only for super-admins. Tenant admins get a different view.
packages/dashboard/src/components/settings/index.ts 	Settings components remain but API calls are tenant-scoped.
packages/dashboard/src/routes/usage.tsx 	Tenant-scoped usage.
packages/dashboard/src/routes/profile.tsx 	Add tenant info display.

Pipeline Management (replacing filesystem reads)
File 	Change
packages/dashboard/src/routes/pipelines/index.tsx 	Add "Create Pipeline" button. Pipelines now come from DB (global + tenant-owned).
packages/dashboard/src/routes/pipelines/$pipelineId.tsx 	Pipeline detail — prevent editing global/system pipelines. Allow editing tenant-owned.

All other route files that call authFetch will work without changes because the backend enforces tenant filtering. These are covered implicitly:

    packages/dashboard/src/routes/projects/index.tsx
    packages/dashboard/src/routes/projects/$projectId.tsx
    packages/dashboard/src/routes/runs/index.tsx
    packages/dashboard/src/routes/runs/$runId.tsx
    packages/dashboard/src/routes/runs/swarm.$swarmId.tsx
    packages/dashboard/src/routes/memory.tsx
    packages/dashboard/src/routes/chat.tsx
    packages/dashboard/src/routes/skills.tsx
    packages/dashboard/src/routes/skills.generate.tsx
    packages/dashboard/src/routes/mcp.tsx
    packages/dashboard/src/routes/mcp.configure.tsx

Part 6: Engine & Agent Runtime Changes
6.1 Engine (packages/core/)
File 	Change
packages/core/src/engine/pipeline-engine.ts 	startRun() accepts tenantId. All event publishing uses tenant-scoped Redis keys. Pipeline map replaced with Redis cache (see 3.8.3C). activeRuns Set replaced with Redis distributed locks (see 3.8.3A). Cache miss triggers API fetch per-tenant.
packages/core/src/events/event-bus.ts 	publish() and subscribe() prepend djinnbot:t:{tenantId}: to channel names. Replace XREAD with XREADGROUP for consumer group support (see 3.8.3A). Add XACK after processing. Add pending message reclaim loop (XPENDING + XCLAIM after 60s idle).
packages/core/src/events/channels.ts 	All channel name generators accept tenantId parameter.
packages/core/src/container/runner.ts 	Pass TENANT_ID env var to agent-runtime containers. Scope vault/sandbox paths.
packages/core/src/container/manager.ts 	Container naming: djinnbot-{tenantId}-{runId}. Network isolation per tenant (Compose mode — dev/debug only, acceptable Docker network limits for development). Mount tenant-scoped JuiceFS subdirectories. ContainerConfig interface update (see 6.1.1 below). Container registry moved from in-memory Map to Redis hash (see 3.8.3B).
packages/core/src/container/k8s-manager.ts 	(new) KubernetesContainerManager — spawns agent-runtime as bare K8s Pods when DEPLOYMENT_MODE=kubernetes. Implements same ContainerManager interface as Docker backend. Includes orphan cleanup on startup (see 3.8.3D, 3.8.4).
packages/core/src/container/k8s-types.ts 	(new) Kubernetes Pod spec TypeScript types.
packages/core/src/config.ts 	Read DEPLOYMENT_MODE env var. Instantiate DockerContainerManager or KubernetesContainerManager accordingly. Generate unique instanceId for this engine pod.
packages/core/src/db/store.ts 	All DB queries include tenant_id filter.
packages/core/src/db/api-store.ts 	API calls include tenant context (from JWT in authFetch).
packages/core/src/api/auth-fetch.ts 	Include tenant context in service-to-service auth.
packages/core/src/api/agent-key-manager.ts 	Scope per-agent API keys by tenant.
packages/core/src/sessions/session-persister.ts 	Include tenant_id when creating sessions.
packages/core/src/memory/ 	All vault paths tenant-scoped.
packages/core/src/skills/registry.ts 	Skill resolution tenant-scoped.
packages/core/src/lifecycle/ 	Agent lifecycle tenant-scoped.

6.1.1 ContainerConfig Interface Update

The ContainerConfig interface in packages/core/src/container/manager.ts must add a required tenantId field:

export interface ContainerConfig {
  runId: string;
  agentId: string;
  tenantId: string;  // NEW — required for all container operations
  workspacePath: string;
  runWorkspacePath?: string;
  projectWorkspacePath?: string;
  image?: string;
  env?: Record<string, string>;
  memoryLimit?: number;
  cpuLimit?: number;
}

The createContainer() method uses tenantId to:
1. Compute bind mount paths:
   - Host: /data/tenants/${tenantId}/vaults/${agentId} -> Container: /home/agent/clawvault
   - Host: /data/tenants/${tenantId}/runs/${runId} -> Container: /home/agent/run-workspace
   - Host: /data/tenants/${tenantId}/sandboxes/${agentId} -> Container: /home/agent/sandbox
   - Host: /data/tenants/${tenantId}/workspaces/${projectId} -> Container: /home/agent/project-workspace
2. Name the container: djinnbot-${tenantId.slice(0,8)}-${runId}
3. Create/join a tenant-scoped Docker network: djinnbot-tenant-${tenantId} (Compose mode only — this is for development/debugging use where tenant counts are small. Production uses Kubernetes NetworkPolicy for tenant isolation.)
4. Set TENANT_ID=${tenantId} in the container environment

Since JuiceFS presents as a POSIX filesystem and the subdirectories are regular directories within the mount, this works without changes to JuiceFS configuration. The engine ensures the tenant subdirectory tree exists (mkdir -p) before mounting into containers.

6.2 Agent Runtime (packages/agent-runtime/)
File 	Change
packages/agent-runtime/src/config.ts 	Add tenantId to RuntimeConfig from TENANT_ID env var.
packages/agent-runtime/src/entrypoint.ts 	Use tenant-scoped Redis channels.
packages/agent-runtime/src/redis/listener.ts 	Subscribe to tenant-scoped command channel.
packages/agent-runtime/src/redis/publisher.ts 	Publish to tenant-scoped event channels.
packages/agent-runtime/src/redis/client.ts 	No structural change.
packages/agent-runtime/src/agent/runner.ts 	No structural change (vault path passed via mount).
packages/agent-runtime/src/agent/djinnbot-tools/memory.ts 	Vault path is already from config. API calls carry tenant context via AGENT_API_KEY.
packages/agent-runtime/src/agent/djinnbot-tools/shared-vault-api.ts 	API calls carry tenant context.
packages/agent-runtime/src/agent/djinnbot-tools/pulse-tasks.ts 	API calls carry tenant context.
packages/agent-runtime/src/agent/djinnbot-tools/pulse-projects.ts 	API calls carry tenant context.
packages/agent-runtime/src/agent/djinnbot-tools/github.ts 	API calls carry tenant context.
packages/agent-runtime/src/agent/djinnbot-tools/secrets.ts 	API calls carry tenant context.
packages/agent-runtime/src/agent/djinnbot-tools/skills.ts 	API calls carry tenant context.
packages/agent-runtime/src/agent/djinnbot-tools/messaging.ts 	API calls carry tenant context.
packages/agent-runtime/src/agent/djinnbot-tools/work-ledger.ts 	Redis keys tenant-scoped.
packages/agent-runtime/src/agent/djinnbot-tools/swarm-executor.ts 	API calls carry tenant context.
packages/agent-runtime/src/agent/djinnbot-tools/spawn-executor.ts 	API calls carry tenant context.
packages/agent-runtime/src/agent/djinnbot-tools/onboarding.ts 	API calls carry tenant context.
packages/agent-runtime/src/agent/djinnbot-tools/step-control.ts 	No change.
packages/agent-runtime/src/agent/djinnbot-tools/research.ts 	No change (external API).
packages/agent-runtime/src/agent/djinnbot-tools/slack.ts 	Tenant-scoped Slack config.
packages/agent-runtime/src/api/auth-fetch.ts 	Include AGENT_API_KEY (already does).
packages/agent-runtime/src/tools/bash.ts 	No change (sandbox-scoped).
packages/agent-runtime/src/tools/read.ts 	No change (path-scoped).
packages/agent-runtime/src/tools/write.ts 	No change (path-scoped).
packages/agent-runtime/src/tools/edit.ts 	No change (path-scoped).
Part 7: Docker Compose & Infrastructure

NOTE: Docker Compose mode is for local development and debugging. Production deployments use Kubernetes (see Part 3.8 and 7.3).

7.1 New docker-compose.yml

services:
  # ── Data Layer ─────────────────────────────
  postgres:
    image: postgres:16-alpine
    environment:
      POSTGRES_USER: djinnbot
      POSTGRES_PASSWORD: ${POSTGRES_PASSWORD}
      POSTGRES_DB: djinnbot
    volumes:
      - postgres-data:/var/lib/postgresql/data
    networks: [djinnbot_internal]
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U djinnbot"]
      interval: 5s
      timeout: 5s
      retries: 5

  redis:
    image: redis:7-alpine
    command: redis-server --appendonly yes --databases 16 --maxmemory 2gb --maxmemory-policy volatile-lru
    volumes:
      - redis-data:/data
    networks: [djinnbot_internal]
    healthcheck:
      test: ["CMD", "redis-cli", "ping"]
      interval: 10s
      timeout: 5s
      retries: 5

  rustfs:
    image: rustfs/rustfs:latest
    environment:
      RUSTFS_VOLUMES: /data
      RUSTFS_ADDRESS: "0.0.0.0:9000"
      RUSTFS_ACCESS_KEY: ${RUSTFS_ACCESS_KEY}
      RUSTFS_SECRET_KEY: ${RUSTFS_SECRET_KEY}
    volumes:
      - rustfs-data:/data
    networks: [djinnbot_internal]
    healthcheck:
      test: ["CMD", "sh", "-c", "curl -sf http://localhost:9000/health"]
      interval: 10s
      timeout: 5s
      retries: 5

  juicefs-mount:
    image: juicedata/mount:ce-v1.3.1
    privileged: true
    environment:
      REDIS_URL: redis://redis:6379/2
      RUSTFS_ACCESS_KEY: ${RUSTFS_ACCESS_KEY}
      RUSTFS_SECRET_KEY: ${RUSTFS_SECRET_KEY}
    volumes:
      - juicefs-data:/jfs
      - juicefs-cache:/var/jfsCache
    command: [... same as current ...]
    networks: [djinnbot_internal]
    depends_on:
      redis: { condition: service_healthy }
      rustfs: { condition: service_healthy }

  # ── HAProxy (ingress/routing) ──────────────
  haproxy:
    image: haproxy:2.9-alpine
    ports:
      - "${BIND_HOST:-0.0.0.0}:${API_PORT:-8000}:8000"
      - "${BIND_HOST:-0.0.0.0}:${DASHBOARD_PORT:-3000}:3000"
    volumes:
      - ./deploy/haproxy/haproxy.cfg:/usr/local/etc/haproxy/haproxy.cfg:ro
    networks: [djinnbot_internal]
    depends_on:
      auth-svc: { condition: service_healthy }

  # ── Auth Service ───────────────────────────
  auth-svc:
    build:
      context: .
      dockerfile: Dockerfile.auth
    environment:
      DATABASE_URL: postgresql+asyncpg://djinnbot:${POSTGRES_PASSWORD}@postgres:5432/djinnbot
      REDIS_URL: redis://redis:6379
      AUTH_SECRET_KEY: ${AUTH_SECRET_KEY}
      AUTH_TOTP_ISSUER: ${AUTH_TOTP_ISSUER:-DjinnBot}
      SECRET_ENCRYPTION_KEY: ${SECRET_ENCRYPTION_KEY}
    networks: [djinnbot_internal]
    depends_on:
      postgres: { condition: service_healthy }
    healthcheck:
      test: ["CMD", "curl", "-f", "http://localhost:8010/health"]
      interval: 15s
      timeout: 5s
      retries: 3

  # ── Project Service ────────────────────────
  project-svc:
    build:
      context: .
      dockerfile: Dockerfile.project
    environment:
      DATABASE_URL: postgresql+asyncpg://djinnbot:${POSTGRES_PASSWORD}@postgres:5432/djinnbot
      REDIS_URL: redis://redis:6379
      AUTH_SECRET_KEY: ${AUTH_SECRET_KEY}
      ENGINE_INTERNAL_TOKEN: ${ENGINE_INTERNAL_TOKEN}
    networks: [djinnbot_internal]
    depends_on:
      postgres: { condition: service_healthy }
    healthcheck:
      test: ["CMD", "curl", "-f", "http://localhost:8020/health"]
      interval: 15s
      timeout: 5s
      retries: 3

  # ── Agent Service ──────────────────────────
  agent-svc:
    build:
      context: .
      dockerfile: Dockerfile.agent
    environment:
      DATABASE_URL: postgresql+asyncpg://djinnbot:${POSTGRES_PASSWORD}@postgres:5432/djinnbot
      REDIS_URL: redis://redis:6379
      AUTH_SECRET_KEY: ${AUTH_SECRET_KEY}
      DJINN_DATA_PATH: /data
    volumes:
      - juicefs-data:/data
    networks: [djinnbot_internal]
    depends_on:
      postgres: { condition: service_healthy }
      juicefs-mount: { condition: service_healthy }
    healthcheck:
      test: ["CMD", "curl", "-f", "http://localhost:8030/health"]
      interval: 15s
      timeout: 5s
      retries: 3

  # ── SSE Relay ──────────────────────────────
  sse-relay:
    build:
      context: .
      dockerfile: Dockerfile.sse-relay
    environment:
      REDIS_URL: redis://redis:6379
      AUTH_SECRET_KEY: ${AUTH_SECRET_KEY}
    networks: [djinnbot_internal]
    depends_on:
      redis: { condition: service_healthy }
    healthcheck:
      test: ["CMD", "curl", "-f", "http://localhost:8040/health"]
      interval: 15s
      timeout: 5s
      retries: 3

  # ── Memory Service ─────────────────────────
  memory-svc:
    build:
      context: .
      dockerfile: Dockerfile.memory
    environment:
      DATABASE_URL: postgresql+asyncpg://djinnbot:${POSTGRES_PASSWORD}@postgres:5432/djinnbot
      REDIS_URL: redis://redis:6379
      AUTH_SECRET_KEY: ${AUTH_SECRET_KEY}
      DJINN_DATA_PATH: /data
      OPENROUTER_API_KEY: ${OPENROUTER_API_KEY}
      QMD_OPENAI_API_KEY: ${OPENROUTER_API_KEY}
      QMD_OPENAI_BASE_URL: https://openrouter.ai/api/v1
      QMD_EMBED_PROVIDER: openai
      QMD_OPENAI_EMBED_MODEL: openai/text-embedding-3-small
    volumes:
      - juicefs-data:/data
    networks: [djinnbot_internal]
    depends_on:
      postgres: { condition: service_healthy }
      juicefs-mount: { condition: service_healthy }
    healthcheck:
      test: ["CMD", "curl", "-f", "http://localhost:8050/health"]
      interval: 15s
      timeout: 5s
      retries: 3

  # ── Engine Service ─────────────────────────
  engine-svc:
    build:
      context: .
      dockerfile: Dockerfile.engine
    cap_add: [SYS_ADMIN]
    environment:
      DJINNBOT_API_URL: http://haproxy:8000
      AGENT_SVC_URL: http://agent-svc:8030
      PROJECT_SVC_URL: http://project-svc:8020
      AUTH_SVC_URL: http://auth-svc:8010
      MEMORY_SVC_URL: http://memory-svc:8050
      REDIS_URL: redis://redis:6379
      AUTH_SECRET_KEY: ${AUTH_SECRET_KEY}
      DJINN_DATA_PATH: /data
      USE_CONTAINER_RUNNER: "true"
      ENGINE_INTERNAL_TOKEN: ${ENGINE_INTERNAL_TOKEN}
      AGENT_RUNTIME_IMAGE: ${AGENT_RUNTIME_IMAGE:-ghcr.io/basedatum/djinnbot/agent-runtime:latest}
      JFS_META_URL: redis://redis:6379/2
      DEPLOYMENT_MODE: compose
    volumes:
      - juicefs-data:/data
      - /var/run/docker.sock:/var/run/docker.sock
    networks: [djinnbot_internal]
    depends_on:
      redis: { condition: service_healthy }
      juicefs-mount: { condition: service_healthy }

  # ── Webhook Gateway ────────────────────────
  webhook-gw:
    build:
      context: .
      dockerfile: Dockerfile.webhook
    environment:
      DATABASE_URL: postgresql+asyncpg://djinnbot:${POSTGRES_PASSWORD}@postgres:5432/djinnbot
      REDIS_URL: redis://redis:6379
      AUTH_SECRET_KEY: ${AUTH_SECRET_KEY}
      GITHUB_APP_WEBHOOK_SECRET: ${GITHUB_APP_WEBHOOK_SECRET}
    networks: [djinnbot_internal]
    depends_on:
      postgres: { condition: service_healthy }
    healthcheck:
      test: ["CMD", "curl", "-f", "http://localhost:8002/health"]
      interval: 15s
      timeout: 5s
      retries: 3

  # ── Slack Service ──────────────────────────
  slack-svc:
    build:
      context: .
      dockerfile: Dockerfile.slack
    environment:
      REDIS_URL: redis://redis:6379
      AUTH_SECRET_KEY: ${AUTH_SECRET_KEY}
      DJINNBOT_API_URL: http://haproxy:8000
      ENGINE_INTERNAL_TOKEN: ${ENGINE_INTERNAL_TOKEN}
      DEPLOYMENT_MODE: compose
    networks: [djinnbot_internal]
    depends_on:
      redis: { condition: service_healthy }

  # ── MCP Service ────────────────────────────
  mcp-svc:
    build:
      context: .
      dockerfile: Dockerfile.mcp
    environment:
      DATABASE_URL: postgresql+asyncpg://djinnbot:${POSTGRES_PASSWORD}@postgres:5432/djinnbot
      REDIS_URL: redis://redis:6379
      AUTH_SECRET_KEY: ${AUTH_SECRET_KEY}
      DJINN_DATA_PATH: /data
      MCPO_API_KEY: ${MCPO_API_KEY}
      DEPLOYMENT_MODE: compose
    volumes:
      - juicefs-data:/data
    networks: [djinnbot_internal]
    healthcheck:
      test: ["CMD", "curl", "-sf", "http://localhost:8001/health"]
      interval: 15s
      timeout: 5s
      retries: 5

  # ── Dashboard ──────────────────────────────
  dashboard:
    build:
      context: .
      dockerfile: Dockerfile.dashboard
    environment:
      VITE_API_URL: ${VITE_API_URL:-http://localhost:8000}
    networks: [djinnbot_internal]

  # ── Agent Runtime (pull-only) ──────────────
  agent-runtime:
    image: ${AGENT_RUNTIME_IMAGE:-ghcr.io/basedatum/djinnbot/agent-runtime:latest}
    profiles: [pull-only]
    entrypoint: ["true"]

networks:
  djinnbot_internal:
    driver: bridge

volumes:
  postgres-data:
  redis-data:
  rustfs-data:
  juicefs-cache:
  juicefs-data:

7.2 New Environment Variables

# .env additions
POSTGRES_PASSWORD=strong-random-password

# Deployment mode — controls container orchestration backend
DEPLOYMENT_MODE=compose         # 'compose' (default, dev/debug) or 'kubernetes' (production)

# Instance identity — auto-generated at startup if not set.
# Used by engine-svc for consumer group IDs, container ownership, and lease keys.
# In Kubernetes, defaults to the pod name via HOSTNAME env var.
# ENGINE_INSTANCE_ID=engine-pod-0

# All existing vars remain. tenant_id is derived from JWT at runtime.
# AUTH_SECRET_KEY is shared across all services for independent JWT validation.

7.3 Kubernetes Deployment

When deploying on Kubernetes, use the Helm chart at deploy/helm/djinnbot/ (see 3.8.6 for full manifest listing). The docker-compose.yml above serves as the reference for Docker Compose mode (development/debugging only). Both modes use identical container images and environment variables — only the orchestration layer differs.

Key differences from Docker Compose mode:
- PostgreSQL and Redis: Managed services (RDS/Cloud SQL, ElastiCache/Memorystore). NOT deployed in-cluster.
- PgBouncer: Deployed as a connection pooler between services and managed Postgres
- JuiceFS: CSI driver (juicefs-csi-driver) provides a ReadWriteMany PVC instead of a privileged sidecar
- Agent runtime: bare Kubernetes Pods (restartPolicy: Never) instead of Docker containers (engine-svc uses @kubernetes/client-node)
- Service discovery: Kubernetes DNS instead of Docker Compose service names
- Ingress: HAProxy Ingress Controller instead of exposed ports
- Scaling: HPA autoscaling on all stateless services
- engine-svc: Requires RBAC (ServiceAccount with create/delete/get/list/watch permissions on Pods in the djinnbot namespace)
- MCP/Slack: Full lease-based coordination and request forwarding (not compose-mode singleton fallback)

Part 8: Implementation Phases

This migration is structured as two distinct stages executed sequentially:

**Stage 1: Multi-Tenancy** (Phases 1-5) — Add tenant isolation to the existing monolith. The system continues running as a single API server, single engine, and single dashboard. No service extraction occurs. The monolith becomes fully tenant-aware and all data paths are isolated. Stage 1 is validated end-to-end before Stage 2 begins.

**Stage 2: Decomposition & Scaling** (Phases 6-9) — Extract services from the tenant-aware monolith, add horizontal scaling infrastructure, and build the Kubernetes deployment. This stage ONLY starts after Stage 1 is complete and validated.

This ordering is non-negotiable. Attempting tenancy and decomposition simultaneously multiplies failure modes and makes debugging cross-tenant bugs indistinguishable from cross-service bugs.

--- Stage 1: Multi-Tenancy ---

Phase 1: Tenant Data Model & Auth

    Create Alembic migration adding tenants table and tenant_id to all tables listed in 2.5 (respecting migration ordering: create tenants first, add nullable columns, populate, add NOT NULL constraint)
    Add agents table (DB-defined agents)
    Add pipelines table (DB-defined pipelines)
    Implement tenant-user creation protocol (2.2.1): two-phase insert within single transaction
    Modify POST /v1/auth/setup to create tenant
    Add POST /v1/auth/register endpoint
    Add tenant_id to JWT claims
    Create get_tenant_id() FastAPI dependency that extracts tenant from JWT
    Create TenantFilter mixin for SQLAlchemy queries

Phase 2: Row-Level Tenant Isolation

    Create TenantMixin base class with tenant_id column
    Update every SQLAlchemy model to inherit TenantMixin
    Update every router to use get_tenant_id() dependency
    Update every DB query to filter by tenant_id
    Add DB-level constraint: CHECK (tenant_id IS NOT NULL) on all tenant-scoped tables

Phase 3: Agent & Pipeline DB Migration

    Create agent CRUD API endpoints
    Migrate agents.py router from filesystem reads to DB queries
    Create agent template catalog (seeded on startup)
    Create pipeline CRUD API endpoints (POST /v1/pipelines/, DELETE /v1/pipelines/{pipelineId})
    Migrate pipelines.py router from filesystem reads to DB queries
    Seed global pipelines from ./pipelines/ directory on first boot (sync_pipelines_from_disk())
    Update engine to resolve agent configs and pipelines from API instead of filesystem
    Update agent-runtime to receive agent config via env vars / API

Phase 4: Filesystem Tenant Scoping

    Update VAULTS_DIR resolution to {VAULTS_DIR}/{tenant_id}/{agent_id}/
    Update SANDBOXES_DIR to {SANDBOXES_DIR}/{tenant_id}/{agent_id}/
    Update WORKSPACES_DIR to {WORKSPACES_DIR}/{tenant_id}/{project_id}/
    Update SHARED_RUNS_DIR to {SHARED_RUNS_DIR}/{tenant_id}/{run_id}/
    Update container mounts in ContainerManager to mount tenant-scoped subdirectories

Phase 5: Redis Tenant Namespacing

    Update packages/core/src/events/channels.ts to accept tenantId
    Update EventBus to namespace all channels
    Update ContainerRunner to pass TENANT_ID to containers
    Update agent-runtime Redis publisher/listener to use tenant-scoped keys
    Update SSE endpoints to read from tenant-scoped streams

Phase 5.1: Stage 1 Validation Gate

Before proceeding to Stage 2, validate:
    - Tenant isolation integration tests pass (cross-tenant access denied on all endpoints)
    - End-to-end flow: registration -> agent creation -> chat -> memory -> project
    - Redis key isolation verification (no flat keys remain)
    - Container filesystem isolation verification (agent containers only see their tenant's data)
    - SSE stream isolation (tenant A cannot receive tenant B's events)

--- Stage 2: Decomposition & Scaling ---

Phase 6: Horizontal Scaling Infrastructure

This phase makes all services horizontally scalable BEFORE decomposing into separate containers. These changes apply to the current monolith and carry forward into the microservice split.

    engine-svc: Replace XREAD with XREADGROUP consumer groups (see 3.8.3A)
    engine-svc: Move pipeline cache from in-memory Map to Redis with TTL (see 3.8.3C)
    engine-svc: Move container registry from in-memory Map to Redis hash (see 3.8.3B)
    engine-svc: Add Redis distributed lock (SETNX) for run deduplication (see 3.8.3A)
    engine-svc: Implement KubernetesContainerManager for bare K8s Pod spawning with orphan cleanup (see 3.8.3D, 3.8.4)
    engine-svc: Add DEPLOYMENT_MODE config switch between Docker and K8s backends
    slack-svc: Implement partition manager with consistent hashing (see 3.8.5)
    slack-svc: Add Redis heartbeat registration and rebalance trigger
    mcp-svc: Implement Redis lease-based process ownership (see 3.7.1)
    mcp-svc: Implement lease-based request routing with compose-mode fallback (see 3.7.1 item 4)
    mcp-svc: Add idle process eviction (10 min TTL)
    All services: Add ENGINE_INSTANCE_ID / unique pod identity generation

Phase 7: Microservice Decomposition

    Extract auth-svc from server routers (auth.py, users.py, waitlist.py)
    Extract project-svc from server routers (projects/, onboarding.py, project_templates.py)
    Extract agent-svc from server routers (agents.py, lifecycle.py, sandbox.py, queue.py, inbox.py, channels.py, agent_tools.py, pulse_routines.py, pulses.py, chat.py, chat_sessions.py, attachments.py, skills.py, secrets.py, settings.py, slack.py)
    Create sse-relay service (new)
    Extract memory-svc from server routers (memory.py, memory_scores.py, ingest.py)
    Create mcp-svc (new — replaces raw mcpo sidecar, see 3.7.1)
    Extract webhook-gw from server routers (github_webhooks.py)
    Extract slack-svc from engine (already separate package)
    Add independent JWT validation to every service (shared AUTH_SECRET_KEY, each service validates its own tokens)
    Create all Dockerfiles
    Create HAProxy configuration (deploy/haproxy/haproxy.cfg) with URL-prefix-to-backend routing rules
    Update docker-compose.yml
    Create Helm chart at deploy/helm/djinnbot/ (see 3.8.6)

Phase 8: Dashboard Updates

    Add registration page
    Add agent creation/management UI
    Update auth context with tenant info
    Verify all existing pages work with tenant-scoped backend

Phase 9: Testing & Hardening

    Load testing for multi-tenant SSE delivery
    Horizontal scaling tests: run 3 engine-svc replicas, verify no duplicate run processing
    Horizontal scaling tests: run 2 slack-svc replicas, verify partition rebalance on pod kill
    Horizontal scaling tests: run 2 mcp-svc replicas, verify lease failover for stdio servers
    Container isolation verification (network, filesystem)
    Redis key isolation verification
    Kubernetes deployment test: full Helm install on a test cluster
    End-to-end registration -> agent creation -> chat -> memory -> project flow

Part 10: Engineering Standards
10.1 Microservice Design Rules

    Single Responsibility: Each service owns one bounded context. No shared mutable state except via the database and Redis.
    Database per logical domain, shared physical instance: All services connect to the same PostgreSQL instance (via PgBouncer in production) but only query their own tables. Consider schema-level separation if table ownership is ambiguous.
    No distributed transactions: Use eventual consistency via Redis events.
    API contracts: Each service exposes a versioned REST API. Use OpenAPI specs.
    No direct service-to-service DB queries: Services communicate via HTTP or Redis, never by querying another service's tables directly.
    Circuit breakers: Use httpx with retries and timeouts for inter-service calls.
    Health checks: Every service exposes GET /health returning 200 OK with readiness and liveness differentiation (K8s probes).
    Observability: Structured JSON logging with tenant_id, request_id, service_name, instance_id in every log line.
    Idempotent operations: All write operations that go through Redis must be idempotent.
    No Docker socket sharing across tenants: Agent containers have no Docker socket access. Only the engine-svc has it (Docker mode) or K8s RBAC (K8s mode).
    No in-memory state for distributed data: All shared state lives in Redis or PostgreSQL. In-memory caches must have TTLs and invalidation channels. No service may assume it is the only instance running.
    Stateless by default: Every service must be safe to run as N replicas behind a load balancer, with the specific exceptions documented in 3.8.2 (slack-svc and mcp-svc use soft leases).
    Shared schema package: Cross-service types (Pydantic models for API request/response contracts, event payloads) live in a packages/shared-schemas/ package. This follows the Google protobuf registry pattern: schemas are versioned with semver, changes must be additive only (new optional fields), removals go through a deprecation cycle (mark deprecated -> remove in next major version), and services pin to specific versions and upgrade on their own schedule. CI validates backward compatibility on every PR to the shared-schemas package. This is an explicit trade-off: accept tight schema coupling in exchange for eliminating contract drift between services. The alternative (per-service schema definitions with no shared code) leads to silent deserialization failures that are worse than coordinated deploys.

10.2 Security Standards

    Tenant isolation is mandatory: No endpoint may return data for a tenant other than the authenticated user's tenant. This is enforced at the query layer, not just at the route layer.
    Defense in depth: Even if a JWT is forged with a wrong tenant_id, the DB constraint CHECK (user.tenant_id = tenant_id) prevents cross-tenant access.
    Independent JWT validation: Every service validates JWTs independently using the shared AUTH_SECRET_KEY. There is no centralized auth gateway — a compromised or unavailable auth-svc does not prevent other services from validating existing tokens.
    Container network isolation: In Kubernetes, NetworkPolicy restricts agent-runtime pods to same-tenant communication. In Docker Compose (dev only), per-tenant Docker networks provide equivalent isolation.
    Filesystem isolation: JuiceFS mounts are scoped to /data/tenants/{tenantId}/. Agent containers only see their tenant's subdirectory.
    Redis key isolation: Tenant ID is part of every Redis key. A bug in one service cannot leak events to another tenant's SSE stream.
    Rate limiting: Per-IP rate limiting at HAProxy via stick-tables. Per-tenant rate limiting at the service level (tracked via Redis counters).
    Secret encryption: Existing AES-256-GCM encryption of secrets is retained. SECRET_ENCRYPTION_KEY is system-wide (not per-tenant).

10.3 Anti-Pattern Avoidance
Anti-Pattern 	How Avoided
Distributed monolith 	Services have independent deployability. Shared schema package uses semver with strict backward compatibility — services upgrade on their own schedule, never forced to deploy simultaneously.
Shared database coupling 	Services query only their own tables. Cross-service data is fetched via API.
Synchronous chains 	SSE relay uses Redis streams (async). Engine->API calls are fire-and-forget where possible.
Custom API gateway 	HAProxy handles routing, TLS, rate limiting. No custom Python reverse proxy adding latency and maintenance burden.
Chatty microservices 	Batch APIs where needed. Engine fetches all provider keys in one call.
Hardcoded service URLs 	All URLs via environment variables. Docker Compose service discovery / Kubernetes DNS.
Missing circuit breakers 	httpx with retry policies. Fallback to degraded mode.
Schema drift 	Shared Pydantic models in packages/shared-schemas/ with additive-only changes, semver, and CI-enforced backward compatibility.
No observability 	Structured logging, health checks, Redis-based metrics.
God service 	Largest service (agent-svc) has many routers but one bounded context (agent management).
In-memory singleton state 	All shared state (pipeline cache, container registry, active runs) stored in Redis. No service assumes single-instance deployment.
Scaling via vertical only 	Every service is designed for horizontal scaling. Vertical scaling (bigger pods) is a temporary measure only.
Sticky sessions 	No service requires sticky sessions. SSE reconnects to any replica. Slack/MCP use Redis leases for partition affinity (not session affinity).
Running databases in-cluster 	PostgreSQL and Redis are managed services in production. In-cluster instances are for development only.

10.4 Kubernetes-Specific Standards

    Pod disruption budgets: All services with replicas >= 2 must have a PodDisruptionBudget allowing at most 1 unavailable pod.
    Graceful shutdown: All services handle SIGTERM with a 30s grace period. In-flight requests complete before exit. Engine-svc completes current run step before draining.
    Resource limits: Every Deployment must specify resource requests AND limits. No unbounded pods.
    Liveness vs readiness: Liveness probes detect deadlocks (restart the pod). Readiness probes detect temporary inability to serve (remove from Service endpoints). These must be different endpoints: GET /health/live and GET /health/ready.
    ConfigMap/Secret separation: Configuration via ConfigMaps, credentials via Secrets. Never bake secrets into images.
    Image immutability: All images tagged with git SHA, never :latest in production. Helm values.yaml references specific image tags.
    Rolling updates: All Deployments use RollingUpdate strategy with maxSurge=1, maxUnavailable=0 to ensure zero-downtime deploys.
    Network policies: Default-deny ingress on the djinnbot namespace. Explicit allow rules for each service-to-service path. Agent-runtime pods restricted to Redis + service backends + mcp-svc + internet egress only.
    No privileged containers: Only the JuiceFS CSI driver runs privileged (required for FUSE). Engine-svc uses K8s RBAC (not Docker socket) in Kubernetes mode.
    Anti-affinity: Engine-svc pods should prefer spreading across nodes (podAntiAffinity with preferredDuringSchedulingIgnoredDuringExecution on kubernetes.io/hostname).
    Connection pooling: All services connect to PostgreSQL through PgBouncer. Direct connections from 10+ service pools would exhaust max_connections.
