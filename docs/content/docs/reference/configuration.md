---
title: Configuration
weight: 3
---

All configuration is done through environment variables in `.env` and per-agent `config.yml` files.

## Environment Variables

### Required

| Variable | Description | Example |
|----------|------------|---------|
| `OPENROUTER_API_KEY` | OpenRouter API key (also used for memory embeddings) | `sk-or-v1-...` |

That's the only required variable when using OpenRouter. Everything else has defaults.

### LLM Providers

| Variable | Provider |
|----------|---------|
| `OPENROUTER_API_KEY` | OpenRouter (access to all models) |
| `ANTHROPIC_API_KEY` | Anthropic (Claude) |
| `OPENAI_API_KEY` | OpenAI (GPT) |
| `GEMINI_API_KEY` | Google (Gemini) |
| `XAI_API_KEY` | xAI (Grok) |
| `GROQ_API_KEY` | Groq |
| `MISTRAL_API_KEY` | Mistral |
| `CEREBRAS_API_KEY` | Cerebras |
| `AZURE_OPENAI_API_KEY` | Azure OpenAI |
| `HF_TOKEN` | Hugging Face |

### Services

| Variable | Default | Description |
|----------|---------|------------|
| `API_PORT` | `8000` | API server port |
| `DASHBOARD_PORT` | `3000` | Dashboard port |
| `REDIS_PORT` | `6379` | Redis port |
| `POSTGRES_PORT` | `5432` | PostgreSQL port |
| `MCPO_PORT` | `8001` | MCP proxy port |

### Paths

| Variable | Default | Description |
|----------|---------|------------|
| `PIPELINES_DIR` | `./pipelines` | Pipeline YAML directory |
| `AGENTS_DIR` | `./agents` | Agent persona directory |
| `DATA_DIR` | `./data` | General data directory |

### Security

| Variable | Description |
|----------|------------|
| `SECRET_ENCRYPTION_KEY` | AES-256-GCM key for encrypting secrets at rest |
| `MCPO_API_KEY` | API key protecting the mcpo proxy |

### Slack

| Variable | Description |
|----------|------------|
| `SLACK_CHANNEL_ID` | Default channel for pipeline threads |
| `SLACK_{AGENT}_BOT_TOKEN` | Per-agent Slack bot token |
| `SLACK_{AGENT}_APP_TOKEN` | Per-agent Slack app token |
| `SKY_SLACK_USER_ID` | Human user ID for DM notifications |

### GitHub

| Variable | Description |
|----------|------------|
| `GITHUB_TOKEN` | Personal access token for git operations |
| `GITHUB_APP_ID` | GitHub App ID |
| `GITHUB_APP_CLIENT_ID` | GitHub App client ID |
| `GITHUB_APP_WEBHOOK_SECRET` | Webhook signature verification |
| `GITHUB_APP_PRIVATE_KEY_PATH` | Path to App private key PEM |
| `GITHUB_APP_NAME` | GitHub App name |

### Engine

| Variable | Default | Description |
|----------|---------|------------|
| `MOCK_RUNNER` | `false` | Use mock agent runner for testing |
| `USE_CONTAINER_RUNNER` | `true` | Use Docker containers for agents |
| `LOG_LEVEL` | `INFO` | Logging level |
| `VITE_API_URL` | `http://192.168.8.234:8000` | API URL baked into dashboard build |

## Agent Configuration (config.yml)

Per-agent settings in `agents/<id>/config.yml`:

```yaml
# LLM Model
model: anthropic/claude-sonnet-4
thinking_model: anthropic/claude-sonnet-4
thinking_level: 'off'          # off, low, medium, high

# Slack
thread_mode: passive            # passive or active

# Pulse (autonomous mode)
pulse_enabled: false
pulse_interval_minutes: 30
pulse_offset_minutes: 3
pulse_max_consecutive_skips: 5
pulse_container_timeout_ms: 120000
pulse_columns:
  - Backlog
  - Ready
pulse_transitions_to:
  - planning
  - ready
  - in_progress
pulse_blackouts:
  - label: Nighttime
    start_time: '23:00'
    end_time: '07:00'
    type: recurring
pulse_one_offs: []
```

All agent config can also be edited through the dashboard Settings and Agent pages.

## Global Settings (Dashboard)

The Settings page in the dashboard provides UI access to:

- **Default working model** — model for pipeline steps and chat
- **Default thinking model** — model for extended reasoning
- **Pulse interval** — global pulse frequency
- **Provider API keys** — add/update provider credentials
- **Custom providers** — configure OpenAI-compatible endpoints
