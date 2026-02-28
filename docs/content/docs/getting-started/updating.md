---
title: Updating DjinnBot
weight: 4
---

DjinnBot is actively developed. Updating keeps you on the latest agents, pipelines, and features — without losing your data or configuration.

## Check for Updates

The dashboard and CLI both check for available updates:

```bash
# CLI
djinn status    # Shows current version and update availability

# API
curl http://localhost:8000/v1/updates/check
```

## Update via CLI

The recommended way to update:

```bash
djinn update
```

This command:

1. Pulls the latest code from GitHub (`git pull`)
2. Pulls updated Docker images
3. Rebuilds containers (build-from-source mode) or pulls new pre-built images (GHCR mode)
4. Restarts the stack
5. Runs database migrations automatically on API server startup

Your data is preserved — PostgreSQL, Redis, and JuiceFS/RustFS volumes are never touched during updates.

## Manual Update

If you prefer to update manually:

### Build-from-Source Mode

```bash
cd ~/djinnbot        # or wherever you cloned the repo

# Pull latest code
git pull origin main

# Rebuild and restart
docker compose build
docker compose up -d
```

### Pre-Built Image Mode (GHCR)

```bash
cd ~/djinnbot

git pull origin main

# Pull latest pre-built images
COMPOSE_FILE=docker-compose.ghcr.yml docker compose pull

# Restart with new images
COMPOSE_FILE=docker-compose.ghcr.yml docker compose up -d
```

## What Gets Updated

| Component | How It Updates |
|-----------|---------------|
| API server | Rebuilt from `Dockerfile.server` (or pulled from GHCR). Database migrations run automatically on startup. |
| Pipeline engine | Rebuilt from `Dockerfile.engine` (or pulled from GHCR). |
| Dashboard | Rebuilt from `Dockerfile.dashboard` (or pulled from GHCR). |
| mcpo proxy | Rebuilt from `Dockerfile.mcpo` (or pulled from GHCR). |
| Agent runtime | The pre-built image is pulled automatically. Override with `AGENT_RUNTIME_IMAGE` in `.env`. |
| Agent personas | Updated via `git pull` — persona files live in `agents/`. |
| Pipelines | Updated via `git pull` — pipeline YAML lives in `pipelines/`. |
| Skills | Updated via `git pull` — skill files live in `skills/` and `agents/_skills/`. |

## What Is Preserved

| Data | Storage | Safe? |
|------|---------|-------|
| Database (runs, projects, users, settings) | `postgres-data` Docker volume | Yes |
| Redis (event streams, JuiceFS metadata) | `redis-data` Docker volume | Yes |
| File storage (vaults, sandboxes, workspaces) | `rustfs-data` Docker volume | Yes |
| JuiceFS cache | `juicefs-cache` Docker volume | Yes |
| Your `.env` configuration | Local file | Yes |
| Custom agent personas you added | Local files in `agents/` | Yes (git-tracked) |
| Custom pipelines you added | Local files in `pipelines/` | Yes (git-tracked) |

{{< callout type="warning" >}}
Never run `docker compose down -v` unless you intend to delete all data. The `-v` flag removes Docker volumes, which destroys your database, Redis state, and file storage. Use `docker compose down` (without `-v`) to stop services while preserving data.
{{< /callout >}}

## Checking the Update

After updating, verify everything is healthy:

```bash
# Check all services are running
docker compose ps

# Check API health
curl http://localhost:8000/v1/status

# Check version
djinn status
```

If the API server fails to start after an update, check the logs:

```bash
docker logs djinnbot-api
```

The most common issue is a new required environment variable. Check the [Configuration reference](/docs/reference/configuration) and compare with your `.env`.

## Pinning a Version

If you need to stay on a specific version:

```bash
# Check out a specific tag
git checkout v0.1.0

# Or pin the GHCR image version in .env
DJINNBOT_VERSION=0.1.0
```
