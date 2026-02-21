---
title: CLI Reference
weight: 2
---

The DjinnBot CLI (`djinn`) provides command-line access to agents, pipelines, memory, model providers, and an interactive chat TUI.

## Installation

Install from PyPI:

```bash
pip install djinn-bot-cli
```

Or with [uv](https://docs.astral.sh/uv/):

```bash
uv tool install djinn-bot-cli
```

Verify installation:

```bash
djinn --help
```

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

## Commands

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
