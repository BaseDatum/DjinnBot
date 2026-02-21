# djinn-bot-cli

CLI for the [DjinnBot](https://github.com/BaseDatum/djinnbot) agent orchestration platform. Set up DjinnBot, authenticate, chat with agents, manage pipelines, configure model providers, and browse agent memory — all from the terminal.

## Installation

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

The [one-line installer](https://github.com/BaseDatum/djinnbot#one-line-install-recommended) also installs the CLI automatically.

## Quick Start

```bash
# First-time setup (interactive wizard)
djinn setup

# Log in to the server
djinn login

# Check server connectivity
djinn status

# Chat with an agent (interactive picker for agent + model)
djinn chat

# Chat directly
djinn chat --agent stas --model anthropic/claude-sonnet-4

# Configure a model provider API key
djinn provider set-key anthropic
```

## Commands

### `djinn setup`

Interactive setup wizard for first-time installation. Handles cloning the repo, generating secrets, configuring a model provider, optional SSL/TLS with Traefik, and starting the Docker stack. Safe to re-run.

```bash
djinn setup                         # interactive setup
djinn setup --dir /opt/djinnbot     # specify install directory
djinn setup --no-ssl                # skip SSL prompt
djinn setup --no-provider           # skip provider prompt
```

### `djinn login` / `djinn logout` / `djinn whoami`

Authentication commands for servers with `AUTH_ENABLED=true`.

```bash
djinn login                         # interactive email/password + optional 2FA
djinn login --api-key <key>         # login with an API key
djinn whoami                        # show current user info
djinn logout                        # clear credentials and invalidate session
```

Credentials are stored per server URL in `~/.config/djinnbot/auth.json`. JWT tokens are automatically refreshed when expired.

**Authentication resolution order:** `--api-key` flag > `DJINNBOT_API_KEY` env var > stored credentials.

### `djinn status`

Show server health, Redis connection, active runs, and GitHub App status.

### `djinn chat`

Interactive TUI chat session with an agent. Features streaming responses with markdown rendering, collapsible thinking blocks and tool calls with syntax-highlighted JSON, and a fuzzy-search model picker.

```bash
djinn chat                          # interactive agent + model selection
djinn chat -a finn -m anthropic/claude-sonnet-4  # skip pickers
```

### `djinn provider`

Manage model provider API keys and configuration.

```bash
djinn provider list                 # show all providers and status
djinn provider show anthropic       # details + available models
djinn provider set-key openrouter   # set API key (secure prompt)
djinn provider models               # list models from configured providers
djinn provider enable openai        # enable a provider
djinn provider disable openai       # disable (keeps key)
djinn provider remove openai        # delete key and config
```

### `djinn pipeline`

Manage pipeline definitions.

```bash
djinn pipeline list                 # list all pipelines
djinn pipeline show engineering     # show steps and agents
djinn pipeline validate engineering # validate a pipeline
djinn pipeline raw engineering      # show raw YAML
```

### `djinn agent`

Manage agents and view their status.

```bash
djinn agent list                    # list all agents
djinn agent show stas               # detailed info + persona files
djinn agent status                  # fleet overview
djinn agent status stas             # single agent status
djinn agent runs stas               # run history
djinn agent config stas             # agent configuration
djinn agent projects stas           # assigned projects
```

### `djinn memory`

Browse and search agent memory vaults.

```bash
djinn memory vaults                 # list all vaults
djinn memory list stas              # files in a vault
djinn memory show stas session.md   # view a file
djinn memory search "deployments"   # search across vaults
djinn memory search "arch" -a finn  # search within an agent
djinn memory delete stas old.md     # delete a file
```

## Configuration

The CLI connects to `http://localhost:8000` by default. Override with:

```bash
djinn --url http://your-server:8000 status
```

Or set the environment variable:

```bash
export DJINNBOT_URL=http://your-server:8000
```

## Development

```bash
cd cli
uv sync --all-extras
uv run djinn --help
uv run pytest tests/ -v
```
