---
title: Troubleshooting
weight: 10
---

Solutions to common issues during installation, configuration, and operation. If your problem isn't listed here, check the [GitHub Issues](https://github.com/BaseDatum/djinnbot/issues) or open a new one.

## Installation & Startup

### Docker Compose fails to start

**Symptom:** `docker compose up -d` exits with errors.

**Check the basics:**

```bash
# Verify Docker is running
docker info

# Verify Compose is available
docker compose version

# Check which services failed
docker compose ps
```

**Common causes:**

| Issue | Fix |
|-------|-----|
| Port already in use | Another service is on 3000, 5432, 6379, or 8000. Stop the conflicting service or change ports in `.env` (`API_PORT`, `DASHBOARD_PORT`, `REDIS_PORT`, `POSTGRES_PORT`). |
| Docker socket permission denied | Add your user to the `docker` group: `sudo usermod -aG docker $USER` then log out and back in. |
| Not enough disk space | Agent container images are large (~3 GB). Free disk space or prune old images: `docker system prune -a`. |
| macOS Docker Desktop not running | Open Docker Desktop from Applications and wait for it to start before running `docker compose`. |

### JuiceFS mount fails

**Symptom:** The `djinnbot-juicefs` container keeps restarting or the API/engine can't write to `/jfs`.

```bash
# Check JuiceFS container logs
docker logs djinnbot-juicefs

# Check if the mount succeeded
docker exec djinnbot-juicefs mountpoint -q /jfs && echo "Mounted" || echo "NOT mounted"
```

**Common causes:**

| Issue | Fix |
|-------|-----|
| RustFS not healthy yet | JuiceFS depends on RustFS. Check: `docker logs djinnbot-rustfs`. If RustFS is still starting, wait and restart JuiceFS: `docker compose restart juicefs-mount`. |
| Redis DB 2 not available | JuiceFS uses Redis DB 2 for metadata. Ensure Redis is running: `docker exec djinnbot-redis redis-cli -n 2 PING`. |
| FUSE not available | The JuiceFS container needs `privileged: true` and `/dev/fuse`. This is set in `docker-compose.yml` by default. If you modified the compose file, restore these settings. |

### API server won't start

**Symptom:** `djinnbot-api` container exits or health check fails.

```bash
docker logs djinnbot-api
```

**Common causes:**

| Issue | Fix |
|-------|-----|
| `AUTH_SECRET_KEY` missing | When `AUTH_ENABLED=true`, this is required. Generate with: `python3 -c "import secrets; print(secrets.token_urlsafe(64))"` |
| `ENGINE_INTERNAL_TOKEN` missing | Required when `AUTH_ENABLED=true`. Generate with: `python3 -c "import secrets; print(secrets.token_urlsafe(32))"` |
| PostgreSQL not ready | The API depends on Postgres. Check: `docker logs djinnbot-postgres`. |
| Database migration error | Check the API logs for Alembic errors. Try: `docker compose restart api` — migrations run on startup. |

## Agent Containers

### Agent container fails to start or times out

**Symptom:** Pipeline steps fail with container creation errors or timeout.

```bash
# Check engine logs
docker logs djinnbot-engine --tail 100

# Check if the agent runtime image exists
docker images | grep agent-runtime
```

**Common causes:**

| Issue | Fix |
|-------|-----|
| Agent runtime image not pulled | Run: `docker compose pull agent-runtime` or use the admin panel to pull the image. |
| Docker socket not mounted | The engine needs `/var/run/docker.sock` mounted. This is set in `docker-compose.yml` by default. |
| Out of memory | Agent containers default to using available resources. If your machine is low on memory, reduce concurrent sessions in agent `config.yml`: `coordination.max_concurrent_pulse_sessions: 1`. |

### Agent has no tools / MCP tools missing

**Symptom:** Agent output mentions it can't find tools, or MCP tools don't appear.

```bash
# Check mcpo health
curl http://localhost:8001/docs

# Check mcpo logs
docker logs djinnbot-mcpo
```

**Fix:** Ensure the `mcp/config.json` file exists and is valid JSON. The engine writes this file. If it's missing, restart the engine: `docker compose restart engine`.

## Authentication

### Locked out — forgot password or lost 2FA

If you have database access:

```bash
# Connect to the database
docker exec -it djinnbot-postgres psql -U djinnbot -d djinnbot

# Disable 2FA for a user
UPDATE users SET totp_secret = NULL, totp_enabled = false WHERE email = 'your@email.com';

# Reset password (you'll need to use the API or re-run setup)
```

If you have the recovery codes from when you set up 2FA, use those at the login prompt. In the CLI, enter `r` at the TOTP prompt to use a recovery code.

### "Unauthorized" on every API call

| Check | Fix |
|-------|-----|
| `AUTH_ENABLED` mismatch | Ensure the dashboard's `VITE_API_URL` matches the API address. If using SSL, it must be `https://`. |
| Expired tokens | The CLI auto-refreshes. The dashboard auto-refreshes. If manual API calls fail, get a new token via `POST /v1/auth/login`. |
| Wrong `ENGINE_INTERNAL_TOKEN` | The engine, API, and agent containers must all share the same token. Check `.env`. |

## Performance

### Agents are slow

| Cause | Fix |
|-------|-----|
| Slow LLM provider | Check latency in the admin LLM Call Log. Consider switching to a faster provider or model. |
| Large context windows | Enable [Programmatic Tool Calling](/docs/concepts/programmatic-tool-calling) (`PTC_ENABLED=true`) to reduce context usage by 30-40%. |
| JuiceFS cache cold | First access to files is slower. The cache warms over time. Increase `JUICEFS_CACHE_SIZE` for better read performance. |
| Too many concurrent agents | Reduce `max_concurrent_pulse_sessions` in agent configs. Each agent container consumes CPU and memory. |

### High LLM costs

1. Check the **Admin > API Usage** dashboard for per-agent and per-model breakdowns
2. Use cheaper models for routine tasks (`executor_model` in the Plan+Execute pattern)
3. Enable PTC to reduce token usage
4. Use the Code Knowledge Graph instead of having agents read raw files
5. Set `pulse_blackouts` to prevent agents from running during off-hours
6. Lower `max_wakes_per_day` in agent coordination settings

## Messaging Integrations

### Slack bot not connecting

```bash
docker logs djinnbot-engine 2>&1 | grep -i slack
```

| Issue | Fix |
|-------|-----|
| Socket Mode not enabled | In Slack App settings, enable **Socket Mode** under Settings. |
| Wrong token type | `bot_token` should start with `xoxb-`, `app_token` should start with `xapp-`. |
| Missing scopes | The bot needs at minimum: `chat:write`, `channels:history`, `im:history`, `app_mentions:read`. |

### Discord bot fails to connect

| Issue | Fix |
|-------|-----|
| Message Content Intent disabled | In the Discord Developer Portal, go to Bot > Privileged Gateway Intents and enable **Message Content Intent**. Without it, the bot can't read messages. |
| Empty allowlist | By default, all messages are blocked. Set the allowlist to `*` in the dashboard to allow all users during setup. |
| Invalid token | Regenerate the bot token in the Discord Developer Portal and update via the dashboard. |

### Signal/WhatsApp not linking

Both use a shared phone number that must be linked:

1. Go to **Settings > Integrations** in the dashboard
2. Follow the linking flow (QR code for Signal, QR or pairing code for WhatsApp)
3. The link must be completed within the timeout window
4. Only one engine instance can run the Signal daemon at a time (distributed lock)

## Data & Storage

### Memory search returns no results

| Check | Fix |
|-------|-----|
| `OPENROUTER_API_KEY` not set | Memory search uses embeddings via OpenRouter. The key is required. |
| Fresh install | Agents have no memories yet. Memories are created as agents work. Start a chat session or run a pipeline. |
| Wrong vault path | Check that JuiceFS is mounted: `docker exec djinnbot-engine ls /jfs/vaults/` |

### Lost data after restart

DjinnBot stores data in three places:

1. **PostgreSQL** — Docker volume `postgres-data`. Safe across restarts.
2. **Redis** — Docker volume `redis-data` with AOF persistence. Safe across restarts.
3. **JuiceFS/RustFS** — Docker volumes `rustfs-data`, `juicefs-data`, `juicefs-cache`. Safe across restarts.

Data is only lost if you run `docker compose down -v` (the `-v` flag deletes volumes). Never use `-v` unless you intend to delete all data.

## Getting Help

If your issue isn't covered here:

1. Check [GitHub Issues](https://github.com/BaseDatum/djinnbot/issues) for existing reports
2. Collect diagnostic info: `docker compose ps`, `docker logs <container>`, and your `.env` (redact secrets)
3. Open a new issue with the diagnostic info and steps to reproduce
