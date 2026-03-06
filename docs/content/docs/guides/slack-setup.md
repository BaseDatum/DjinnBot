---
title: Slack Bot Setup
weight: 1
---

Each DjinnBot agent can have its own Slack bot, appearing as a distinct team member in your workspace. This guide walks you through creating Slack apps for your agents.

{{< callout type="info" >}}
Slack integration is **optional**. DjinnBot also supports [Discord](/docs/guides/discord-setup), [Telegram](/docs/guides/telegram-setup), [Signal](/docs/guides/signal-setup), and [WhatsApp](/docs/guides/whatsapp-setup) — or just use the built-in dashboard chat and CLI.
{{< /callout >}}

## Overview

Each agent needs its own Slack app because:

- Agents post messages under their own name and avatar
- Each agent can be mentioned independently (`@Eric`, `@Finn`, etc.)
- Socket Mode allows real-time bidirectional communication
- Each bot has its own OAuth scopes and permissions

You'll create one Slack app per agent, then add the tokens to your `.env` file.

## Step 1: Create a Slack App

For each agent you want in Slack:

1. Go to [api.slack.com/apps](https://api.slack.com/apps)
2. Click **Create New App** → **From scratch**
3. Name it after the agent (e.g., "Eric - Product Owner")
4. Select your workspace
5. Click **Create App**

## Step 2: Enable AI Agent Features

Slack has released AI-powered features specifically for bots. Enable these to get the best experience:

1. In your app settings, go to **Features** in the sidebar
2. Click **Agents & AI Apps**
3. Toggle **Enable Agent or Assistant** to ON
4. Under **Agent Settings**:
   - Enable **Dynamic Prompts** — this allows DjinnBot to provide rich, context-aware responses
   - Enable **Model Context Protocol** — this allows the agent to use MCP tools natively within Slack's AI framework
5. Click **Save Changes**

{{< callout type="tip" >}}
Slack's Agents & Assistants framework is what makes DjinnBot agents feel native in your workspace. With dynamic prompts enabled, agents can provide contextual suggestions and structured responses. With MCP enabled, agents can surface tool results directly in Slack threads. See [Slack's Agents & Assistants documentation](https://api.slack.com/docs/agents-assistants) for the latest on these features.
{{< /callout >}}

## Step 3: Configure OAuth Permissions

Navigate to **OAuth & Permissions** and add these **Bot Token Scopes**:

| Scope | Purpose |
|-------|---------|
| `app_mentions:read` | Detect when the agent is @mentioned |
| `channels:history` | Read messages in public channels |
| `channels:read` | List channels |
| `chat:write` | Send messages |
| `files:read` | Access shared files |
| `files:write` | Upload files |
| `groups:history` | Read private channel messages |
| `groups:read` | List private channels |
| `im:history` | Read DMs |
| `im:read` | List DMs |
| `im:write` | Send DMs |
| `reactions:write` | Add emoji reactions |
| `users:read` | Look up user info |

## Step 4: Enable Socket Mode

Navigate to **Socket Mode** in the sidebar:

1. Toggle **Enable Socket Mode** to ON
2. Give the app-level token a name (e.g., "eric-socket")
3. Add the `connections:write` scope
4. Click **Generate**
5. Save the **App-Level Token** (`xapp-...`) — this is the `APP_TOKEN`

Socket Mode lets the bot connect without exposing a public URL, which is ideal for self-hosted deployments behind firewalls.

## Step 5: Enable Events

Navigate to **Event Subscriptions**:

1. Toggle **Enable Events** to ON
2. Under **Subscribe to bot events**, add:
   - `app_mention` — responds when someone @mentions the agent
   - `message.channels` — sees messages in channels it's in
   - `message.groups` — sees messages in private channels
   - `message.im` — receives DMs

3. Click **Save Changes**

## Step 6: Install to Workspace

Navigate to **Install App**:

1. Click **Install to Workspace**
2. Review the permissions and approve
3. Copy the **Bot User OAuth Token** (`xoxb-...`) — this is the `BOT_TOKEN`

## Step 7: Add Tokens to DjinnBot

Edit your `.env` file and add the tokens for each agent:

```bash
# Slack channel where agents post pipeline updates
SLACK_CHANNEL_ID=C0123456789

# Eric (Product Owner)
SLACK_ERIC_BOT_TOKEN=xoxb-your-eric-bot-token
SLACK_ERIC_APP_TOKEN=xapp-your-eric-app-token

# Finn (Solutions Architect)
SLACK_FINN_BOT_TOKEN=xoxb-your-finn-bot-token
SLACK_FINN_APP_TOKEN=xapp-your-finn-app-token

# Add more agents as needed...
```

The naming convention is `SLACK_{AGENT_ID_UPPERCASE}_BOT_TOKEN` and `SLACK_{AGENT_ID_UPPERCASE}_APP_TOKEN`.

Also create `agents/<agent-id>/slack.yml` for each agent:

```yaml
bot_token: ${SLACK_ERIC_BOT_TOKEN}
app_token: ${SLACK_ERIC_APP_TOKEN}
```

## Step 8: Set Up the Channel

1. Create a channel for your DjinnBot team (e.g., `#djinnbot-dev`)
2. Invite each agent bot to the channel
3. Copy the channel ID (right-click channel name → Copy Link, the ID is the `C...` part)
4. Set `SLACK_CHANNEL_ID` in `.env`

## Step 9: Restart

```bash
docker compose down && docker compose up -d
```

The engine will connect each agent to Slack via Socket Mode on startup.

## Project-Level Slack Configuration

In addition to the global Slack channel, you can configure Slack settings per project through the dashboard:

1. Open your project in the dashboard
2. Go to **Settings > Slack**
3. Configure a project-specific Slack channel

This allows different projects to post updates to different channels, keeping conversations organized.

## How Slack Integration Works

### Pipeline Threads

When a pipeline run starts, the engine creates a thread in the configured channel (project-specific or global fallback). Each step's output is posted as replies in the thread, attributed to the agent handling that step. You can watch a full engineering pipeline unfold as a Slack conversation.

### Mentions

Mention an agent in any channel it's in (`@Eric what do you think about this feature?`) and it will respond in character, using its full persona and memory.

### DMs

Send a DM to any agent bot for a private conversation. Useful for quick questions or ad-hoc tasks.

### Thread Modes

Agents can operate in different thread modes:

- **passive** — only responds when directly mentioned
- **active** — proactively participates in conversations (watches for relevant topics)

Configure via `thread_mode` in the agent's `config.yml`.

## Step 10: Register Slash Commands

Each agent can expose a `/<agent-id>` slash command that lets users inspect and configure the agent directly from Slack. To enable this:

1. In the Slack app settings for the agent, go to **Slash Commands**
2. Click **Create New Command**
3. Configure:
   - **Command**: `/<agent-id>` (e.g., `/eric`)
   - **Short Description**: `Configure and control this agent`
   - **Usage Hint**: `[model|models|config|thinking|help]`
4. Click **Save**
5. Reinstall the app to the workspace when prompted

Repeat for each agent's Slack app.

Additionally, ensure **Interactivity** is enabled (required for the interactive model chooser modal):

1. In the app settings, go to **Interactivity & Shortcuts**
2. Toggle **Interactivity** to ON
3. Click **Save Changes**

{{< callout type="info" >}}
The slash command name **must** match the agent's ID exactly. DjinnBot registers a handler for `/<agent-id>` on startup — if the command name doesn't match, Slack won't route it to the correct handler. When using Socket Mode, no Request URL is needed for interactivity — all events are routed through the WebSocket connection.
{{< /callout >}}

## Slash Commands Reference

Every agent registers a `/<agent-id>` slash command with several subcommands. All responses are **ephemeral** — only the user who invoked the command can see the output.

### `/<agent> help`

Shows all available subcommands with usage examples.

```
/<agent> help
```

**Output:**

```
🛠 Eric — Available commands:

/eric model                          — Show the current active model
/eric model execution <provider/model-id> — Switch the execution model
/eric models                         — Quick-switch from your favorited models
/eric models select                  — Browse all configured providers and models
/eric config                         — Show agent configuration
/eric thinking <level>               — Set thinking level
/eric help                           — Show this help message

Examples:
/eric model execution anthropic/claude-sonnet-4
/eric model execution openai/gpt-4o
/eric model execution openrouter/google/gemini-2.5-pro
```

### `/<agent> model`

Displays the model currently in use for this agent's conversation session in the current channel.

```
/eric model
```

If there is an active session (a container is running for this agent in the channel), the response shows the **active model** — the model actually being used for inference right now. If no session is active, it shows the **configured model** from the agent's `config.yml`.

### `/<agent> model execution <provider/model-id>`

Switches the agent's execution model mid-conversation without losing context.

```
/eric model execution anthropic/claude-sonnet-4
/eric model execution openai/gpt-4o
/eric model execution openrouter/google/gemini-2.5-pro
```

**How it works:**

1. The model string is validated using the same `parseModelString()` logic the engine uses.
2. If an active session pool container exists for this agent in the current channel, the model is hot-swapped — the running container receives the new model, and the **next message** uses it. Full conversation context is preserved.
3. If no active session exists (e.g., the agent hasn't been messaged recently, or the idle timeout expired), the model is queued and will be used when the next conversation starts.

**Model string format:** `<provider>/<model-id>`, where provider is one of `anthropic`, `openai`, `openrouter`, `google`, `mistral`, etc. When using OpenRouter, include the full path: `openrouter/<org>/<model>`.

{{< callout type="tip" >}}
The shorthand `/<agent> model <provider/model-id>` also works — the `execution` keyword is optional. For example, `/<agent> model anthropic/claude-sonnet-4` is equivalent.
{{< /callout >}}

### `/<agent> models`

Displays an interactive dropdown of your **favorited models** for quick switching. Favorites are the same models you've starred in the dashboard's model picker — they sync via the DjinnBot API.

```
/eric models
```

The response is an ephemeral message with a `static_select` dropdown. Pick a model and it's applied immediately — the agent's next response will use the new model. The dropdown also shows the currently active model as the default selection.

If you have no favorites yet, the command tells you how to add them (star models in the dashboard, or use `/<agent> models select` to browse).

### `/<agent> models select`

Opens a **full interactive modal** for browsing all configured providers and their models. This mirrors the two-stage model picker in the dashboard:

```
/eric models select
```

**Stage 1 — Provider select:**
A modal opens with a dropdown of all providers that have an API key configured (unconfigured providers are hidden). Providers are sorted in the same canonical order as the dashboard: OpenCode, xAI, Anthropic, OpenAI, Google, OpenRouter, Groq, etc.

**Stage 2 — Model select:**
After choosing a provider, the modal updates to show a second dropdown with that provider's available models (fetched live from the DjinnBot API, same source as the dashboard). Each option shows the model's display name and description.

Click **Switch Model** to apply. The modal closes and the model switch takes effect on the agent's next response. Full conversation context is preserved.

{{< callout type="info" >}}
The modal requires Slack's **Interactivity** to be enabled on the app. This is already configured if you followed the Socket Mode setup above. The `trigger_id` from the slash command is used to open the modal — no additional scopes are needed.
{{< /callout >}}

### `/<agent> config`

Displays the agent's current configuration, including all model slots, thread mode, and installed tools.

```
/eric config
```

**Output:**

```
🛠 Eric — Product Owner

Active model:    anthropic/claude-sonnet-4
Configured model: anthropic/claude-sonnet-4
Thinking model:  anthropic/claude-sonnet-4
Planning model:  same as model
Executor model:  same as model
Thread mode:     passive
Tools:           recall, memorize, read, write, bash, ...
```

**Fields explained:**

| Field | Description |
|-------|-------------|
| **Active model** | The model currently in use for this channel's live session (may differ from configured if switched via slash command) |
| **Configured model** | The default model from the agent's `config.yml` |
| **Thinking model** | Model used for reasoning and decision-making (often a stronger/more expensive model) |
| **Planning model** | Model used for pipeline planning |
| **Executor model** | Model used for step execution in pipelines |
| **Thread mode** | `passive` (only responds when mentioned) or `active` (proactively participates) |
| **Tools** | List of tools available to the agent |

### `/<agent> thinking <level>`

Sets the extended thinking level for the agent's conversation sessions. This controls how much internal reasoning the model does before responding.

```
/eric thinking medium
```

**Valid levels:**

| Level | Description |
|-------|-------------|
| `off` | No extended thinking — fastest responses |
| `minimal` | Very brief reasoning |
| `low` | Light reasoning for straightforward tasks |
| `medium` | Balanced reasoning (good default) |
| `high` | Deep reasoning for complex problems |
| `xhigh` | Maximum reasoning depth — slowest but most thorough |

{{< callout type="warning" >}}
Thinking level changes take effect on the **next conversation session**. The thinking level is set as an environment variable (`AGENT_THINKING_LEVEL`) when the container starts, so an active session will continue using its current thinking level until it times out and a new container is created.
{{< /callout >}}

## How Slash Commands Work Internally

### Registration

When DjinnBot starts, each agent's `AgentSlackRuntime` registers a handler for `/<agent-id>` using Slack Bolt's `app.command()` API. This happens automatically — no manual wiring is needed beyond creating the slash command in the Slack app manifest.

### Session Pool Integration

The `model` subcommand interacts directly with the `SlackSessionPool`, which manages persistent container sessions for each conversation:

- **DM sessions** are keyed by `slack_dm:{agentId}:{channelId}` with a **20-minute idle timeout**.
- **Channel thread sessions** are keyed by `slack_thread:{agentId}:{channelId}:{threadTs}` with a **10-minute idle timeout**.

When you switch models via `/<agent> model execution`, the pool sends a `changeModel` command to the running container. The model switch is seamless — no container restart, no context loss.

### Interactive Model Chooser

The `models` and `models select` commands use Slack's Block Kit interactive elements:

- **`models` (favorites)** — Responds with an ephemeral message containing a `static_select` element. When the user picks a model, a `block_actions` event fires with `action_id: model_favorites_select:<agentId>`. The handler validates the model string, applies it to the session pool, and posts an ephemeral confirmation.

- **`models select` (full modal)** — Opens a modal via `views.open` with a provider `static_select`. When the provider is selected, a `block_actions` event triggers `views.update` to populate a second `static_select` with that provider's models (fetched from `GET /v1/settings/providers/{providerId}/models`). On `view_submission`, the selected model is applied to the session pool.

Both paths call the same `SlackSessionPool.updateSessionModel()` method as the text-based `model execution` command. The model validation uses `parseModelString()` to ensure the model string is valid before applying.

### Ephemeral Responses

All slash command responses use `response_type: 'ephemeral'`, meaning only the invoking user sees them. This prevents slash command output from cluttering shared channels. Interactive element responses (block_actions from `static_select`, modal submissions) also only affect the invoking user.

### Error Handling

If a slash command fails (invalid model string, session pool unavailable, etc.), an ephemeral error message is returned with the specific error. The agent's runtime catches all errors so a bad slash command never crashes the bot.

## Customizing Bot Appearance

In each Slack app's settings:

1. Go to **Basic Information** → **Display Information**
2. Set the bot name (e.g., "Eric - Product Owner")
3. Upload a profile photo (agent avatar)
4. Set a description and background color

## Troubleshooting

### Bot doesn't respond to mentions

- Verify the bot is invited to the channel
- Check that `app_mention` event subscription is enabled
- Confirm Socket Mode is enabled and tokens are correct
- Check engine logs: `docker compose logs engine | grep -i slack`

### Bot posts but doesn't show agent name

- Each agent needs its own Slack app — you can't use one bot for all agents
- Verify `slack.yml` exists for the agent with correct token references

### Socket Mode disconnects

- Socket Mode tokens expire — regenerate if needed
- Check network connectivity between the engine container and `wss://wss-primary.slack.com`

## Slack Resources

- [Slack API Documentation](https://api.slack.com/docs)
- [Socket Mode Guide](https://api.slack.com/apis/socket-mode)
- [Bot Token Scopes Reference](https://api.slack.com/scopes)
- [Agents & Assistants](https://api.slack.com/docs/agents-assistants) — Slack's AI bot framework
- [Slack App Manifest](https://api.slack.com/reference/manifests) — automate app creation
