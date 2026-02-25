---
title: Agent Containers
weight: 8
---

Every agent session runs in an isolated Docker container. This is one of DjinnBot's key differentiators — while other tools give agents direct access to your machine, DjinnBot agents get a full engineering environment in a sandbox that's destroyed after every step. Zero risk to your system.

## What's Inside

The agent container (`Dockerfile.agent-runtime`) is built on Debian bookworm and includes:

### Languages & Runtimes
- **Node.js 22** — JavaScript/TypeScript
- **Python 3** — with pip and venv
- **Go 1.23+** — compiled language support
- **Rust** — via rustup (stable toolchain)
- **Bun 1.3.6** — for QMDR (semantic search)

### Developer Tools
- **git** + git-lfs — version control
- **GitHub CLI** (`gh`) — PR and issue management
- **ripgrep** (`rg`) — fast code search
- **fd** — fast file finder
- **bat** — syntax-highlighted cat
- **fzf** — fuzzy finder
- **delta** — better git diffs
- **eza** — modern ls replacement
- **jq** + **yq** — JSON/YAML processing
- **tree**, **dust** — directory visualization

### System Utilities
- curl, wget, httpie — HTTP clients
- netcat, socat, dnsutils — network tools
- imagemagick — image processing
- sqlite3, postgresql-client, redis-tools — database clients
- make, cmake, autoconf — build systems
- vim, nano — text editors
- htop, lsof, strace — system monitoring

### Memory Tools
- **QMDR** — semantic search CLI (ClawVault integration)
- **ClawVault CLI** — direct memory management

## Container Lifecycle

1. **Spawn** — engine creates a new container via Docker API
2. **Mount** — shared data volume is mounted, symlinks are set up for agent home directory
3. **Inject** — persona files, memories, secrets, and environment variables are provided
4. **Execute** — agent runtime starts, processes the step or chat message
5. **Stream** — output flows to engine via Redis pub/sub
6. **Destroy** — container is removed when the step completes

Each step gets a **fresh container** — there's no state leaking between steps. Persistence comes from:

- **Data volume** — shared across containers for memory vaults and workspaces
- **Database** — PostgreSQL stores step outputs, chat history, etc.
- **Git** — code changes are committed and pushed

## Volume Layout

Agent containers mount the shared JuiceFS filesystem at `/data`. The container's home directory (`/home/agent`) is symlinked to `/data/sandboxes/{agentId}/`, giving each agent a persistent home across sessions. See [Storage](/docs/concepts/storage) for details on the JuiceFS + RustFS layer.

```
/home/agent/                          → /data/sandboxes/{agentId}/
├── clawvault/
│   ├── {agent-id}/                   ← personal memory vault
│   └── shared/                       ← team shared knowledge
├── run-workspace/                    ← git worktree (pipeline sessions)
├── project-workspace/                ← full project repo (pipeline sessions)
└── task-workspaces/
    └── {taskId}/                     ← persistent git worktree (pulse sessions)
```

Which workspace paths are populated depends on the session type. See [Workspaces](/docs/concepts/workspaces) for the full comparison between pipeline and pulse workspace strategies.

## Security Model

- **No host access** — containers cannot reach the host filesystem
- **Network isolation** — containers are on the `djinnbot_default` bridge network
- **No Docker socket** — agent containers cannot spawn other containers (only the engine can)
- **Ephemeral** — containers are destroyed after each step
- **Credential injection** — API keys come from environment variables, not baked into the image

The engine container has Docker socket access (needed to spawn agent containers), but agent containers themselves are fully sandboxed.

## Customization

To add tools to the agent container, modify `Dockerfile.agent-runtime` and rebuild:

```bash
docker compose build engine
docker compose up -d
```

The agent-runtime image is built independently from the other services, so you can customize the toolbox without affecting the API server or dashboard.
