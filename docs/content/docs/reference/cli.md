---
title: CLI Reference
weight: 2
---

The DjinnBot CLI (`djinn`) provides command-line access to setup, authentication, agents, pipelines, memory, model providers, and an interactive chat TUI.

## Installation

Install from PyPI:

```bash
pip install djinn-bot-cli
```

Or with [uv](https://docs.astral.sh/uv/):

```bash
uv tool install djinn-bot-cli
```

Or with [pipx](https://pipx.pypa.io/):

```bash
pipx install djinn-bot-cli
```

Verify installation:

```bash
djinn --help
```

The [one-line installer](/docs/getting-started/installation#one-line-install-recommended) also installs the CLI automatically.

### Development Install

For local development from source:

```bash
cd cli
uv sync --all-extras
uv run djinn --help
```

## Configuration

The CLI connects to the DjinnBot API server at `http://localhost:8000` by default. Override with:

```bash
# Flag
djinn --url http://your-server:8000 status

# Environment variable
export DJINNBOT_URL=http://your-server:8000
djinn status
```

### Authentication

When the server has authentication enabled, you need to log in before using most commands. The CLI automatically resolves credentials in this order:

1. `--api-key` flag (explicit)
2. `DJINNBOT_API_KEY` environment variable
3. Stored credentials from `djinn login` (saved in `~/.config/djinnbot/auth.json`)

Stored JWT tokens are automatically refreshed when expired.

## Commands

### Setup

```bash
djinn setup
```

Interactive setup wizard for first-time installation. Walks you through:

1. Locating or cloning the DjinnBot repository
2. Creating `.env` from `.env.example`
3. Generating encryption keys and secrets
4. Enabling authentication
5. Detecting your server IP
6. Optional SSL/TLS setup with Traefik
7. Checking for port conflicts
8. Configuring a model provider API key
9. Starting the Docker Compose stack

Options:

| Flag | Description |
|------|------------|
| `--dir`, `-d` | Directory to install DjinnBot (default: `~/djinnbot` or current dir if already a repo) |
| `--no-ssl` | Skip the SSL setup prompt |
| `--no-provider` | Skip the provider API key prompt |

Safe to re-run — detects existing configuration and skips what's already done.

### Login

```bash
djinn login
```

Interactive login with email and password. If the account has 2FA enabled, you'll be prompted for a TOTP code. Enter `r` at the TOTP prompt to use a recovery code instead.

```bash
# Login with an API key instead of credentials
djinn login --api-key <key>
```

API key login validates the key against the server and stores it for future use.

### Logout

```bash
djinn logout
```

Clears stored credentials and invalidates the server-side refresh session.

### Whoami

```bash
djinn whoami
```

Shows the currently authenticated user: display name, email, ID, admin status, service account status, and 2FA status.

### Status

```bash
djinn status
```

Show server health, Redis connection, active runs, and GitHub App status.

### Chat

Start an interactive TUI chat session with an agent:

```bash
# Interactive — pick agent and model from menus
djinn chat

# Direct — skip selection
djinn chat --agent stas --model anthropic/claude-sonnet-4-6
```

The chat TUI features:
- Streaming responses with markdown rendering
- Collapsible thinking blocks and tool calls with syntax-highlighted JSON
- Fuzzy search model picker (type to filter, arrow keys to navigate)
- Agent activity shown inline (`thinking...`, `using bash...`)

**Keybindings:**
| Key | Action |
|-----|--------|
| Enter | Send message / expand collapsible |
| Esc | Stop current response |
| Ctrl+C | End session and quit |
| Right arrow | Expand focused collapsible |
| Left arrow | Collapse focused collapsible |

### Providers

Manage model provider API keys:

```bash
# List all providers and their status
djinn provider list

# Show provider details and available models
djinn provider show anthropic

# Set an API key (prompts securely if key omitted)
djinn provider set-key anthropic
djinn provider set-key openrouter sk-or-v1-your-key

# Set extra config (e.g. Azure base URL)
djinn provider set-extra azure-openai-responses AZURE_OPENAI_BASE_URL https://myresource.openai.azure.com

# Enable/disable a provider
djinn provider enable openai
djinn provider disable openai

# List available models
djinn provider models              # all configured providers
djinn provider models anthropic    # specific provider

# Remove a provider's key
djinn provider remove openai
```

### Pipelines

```bash
# List all pipelines
djinn pipeline list

# Show pipeline details
djinn pipeline show engineering

# Validate a pipeline
djinn pipeline validate engineering

# Show raw YAML
djinn pipeline raw engineering
```

### Agents

```bash
# List all agents
djinn agent list

# Show agent details and persona files
djinn agent show stas

# Fleet status overview
djinn agent status

# Single agent status
djinn agent status stas

# Agent's run history
djinn agent runs stas

# Agent configuration
djinn agent config stas

# Projects an agent is assigned to
djinn agent projects stas
```

### Cookies

Manage browser cookies for authenticated agent browsing via Camoufox:

```bash
# List all uploaded cookie sets
djinn cookies list

# Upload a Netscape-format cookie file
djinn cookies upload cookies.txt --name "GitHub Session"

# Delete a cookie set
djinn cookies delete <cookie_set_id>

# List cookie grants for an agent
djinn cookies grants yukihiro

# Grant an agent access to a cookie set
djinn cookies grant yukihiro <cookie_set_id>

# Revoke access
djinn cookies revoke yukihiro <cookie_set_id>

# Export cookies from your local browser (Chrome/Firefox/Safari)
djinn cookies export
```

The `export` subcommand reads cookies directly from your local browser's cookie database (supports Chrome, Firefox, and Safari on macOS/Linux/Windows). It exports them in Netscape format and uploads to the server in one step.

### Memory

```bash
# List all memory vaults
djinn memory vaults

# List files in a vault
djinn memory list stas

# Show a memory file
djinn memory show stas session-log.md

# Search across vaults
djinn memory search "deployment patterns"
djinn memory search "architecture" --agent finn

# Delete a memory file
djinn memory delete stas old-notes.md
```
