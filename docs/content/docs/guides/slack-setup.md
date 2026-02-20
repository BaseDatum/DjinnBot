---
title: Slack Bot Setup
weight: 1
---

Each DjinnBot agent can have its own Slack bot, appearing as a distinct team member in your workspace. This guide walks you through creating Slack apps for your agents.

{{< callout type="info" >}}
Slack integration is **optional**. The built-in dashboard chat works without any Slack configuration. Set this up only if you want agents visible in your Slack workspace.
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

{{< callout type="tip" >}}
**Slack's AI features:** Slack has recently released AI-powered features for bots including Agents & Assistants. DjinnBot agents use **Socket Mode** which is the recommended approach for internal tools and works within Slack's AI framework. See [Slack's Agents & Assistants documentation](https://api.slack.com/docs/agents-assistants) for the latest on building AI-powered Slack experiences.
{{< /callout >}}

## Step 2: Configure OAuth Permissions

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

## Step 3: Enable Socket Mode

Navigate to **Socket Mode** in the sidebar:

1. Toggle **Enable Socket Mode** to ON
2. Give the app-level token a name (e.g., "eric-socket")
3. Add the `connections:write` scope
4. Click **Generate**
5. Save the **App-Level Token** (`xapp-...`) — this is the `APP_TOKEN`

Socket Mode lets the bot connect without exposing a public URL, which is ideal for self-hosted deployments behind firewalls.

## Step 4: Enable Events

Navigate to **Event Subscriptions**:

1. Toggle **Enable Events** to ON
2. Under **Subscribe to bot events**, add:
   - `app_mention` — responds when someone @mentions the agent
   - `message.channels` — sees messages in channels it's in
   - `message.groups` — sees messages in private channels
   - `message.im` — receives DMs

3. Click **Save Changes**

## Step 5: Install to Workspace

Navigate to **Install App**:

1. Click **Install to Workspace**
2. Review the permissions and approve
3. Copy the **Bot User OAuth Token** (`xoxb-...`) — this is the `BOT_TOKEN`

## Step 6: Add Tokens to DjinnBot

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

## Step 7: Set Up the Channel

1. Create a channel for your DjinnBot team (e.g., `#djinnbot-dev`)
2. Invite each agent bot to the channel
3. Copy the channel ID (right-click channel name → Copy Link, the ID is the `C...` part)
4. Set `SLACK_CHANNEL_ID` in `.env`

## Step 8: Restart

```bash
docker compose down && docker compose up -d
```

The engine will connect each agent to Slack via Socket Mode on startup.

## How Slack Integration Works

### Pipeline Threads

When a pipeline run starts, the engine creates a thread in the configured channel. Each step's output is posted as replies in the thread, attributed to the agent handling that step. You can watch a full engineering pipeline unfold as a Slack conversation.

### Mentions

Mention an agent in any channel it's in (`@Eric what do you think about this feature?`) and it will respond in character, using its full persona and memory.

### DMs

Send a DM to any agent bot for a private conversation. Useful for quick questions or ad-hoc tasks.

### Thread Modes

Agents can operate in different thread modes:

- **passive** — only responds when directly mentioned
- **active** — proactively participates in conversations (watches for relevant topics)

Configure via `thread_mode` in the agent's `config.yml`.

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
