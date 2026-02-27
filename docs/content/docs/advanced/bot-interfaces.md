---
title: Bot Interfaces
weight: 2
---

DjinnBot agents can interact through multiple interfaces. The dashboard chat, CLI, Slack, Discord, Telegram, Signal, and WhatsApp are all supported today. Slack remains the most feature-rich integration (pipeline threads, AI agent features, per-agent Socket Mode bots), but every platform gives you direct access to the same agents, tools, and memory.

## Interface Overview

| Interface | Identity Model | Setup | Best For |
|-----------|---------------|-------|----------|
| **Dashboard Chat** | Any agent, browser | None | Full-featured browser experience |
| **CLI Chat** | Any agent, terminal | `pip install djinn-bot-cli` | Terminal-native workflows |
| **Slack** | One bot per agent | Per-agent Slack apps | Teams already on Slack; pipeline threads |
| **Discord** | One bot per agent | Per-agent Discord bots | Teams already on Discord; pipeline threads |
| **Telegram** | One bot per agent | Per-agent BotFather tokens | Quick mobile access; per-agent DMs |
| **Signal** | Shared phone number | Link one device | Privacy-first; end-to-end encrypted |
| **WhatsApp** | Shared phone number | Link via QR/pairing code | Mobile-first teams; broadest reach |

Every messaging integration routes messages through the same ChatSessionManager, which means every conversation — regardless of platform — gets a full agent container with tools, memory, and workspace access.

## Dashboard Chat

The built-in chat interface at `http://localhost:3000/chat` requires no additional setup. Features:

- Select any agent and model
- Full tool access (code execution, file operations, web research)
- Persistent chat history
- Real-time streaming responses
- File uploads and image attachments
- HTML preview for generated content
- Supports onboarding and project-context sessions

This is the primary interface for users who prefer a browser-based experience.

## CLI Chat

The `djinn chat` command provides a full terminal-based chat TUI built with [Textual](https://textual.textualize.io/). It connects to the same API and agent containers as the dashboard — same tools, same models, same persistence.

```bash
# Interactive — pick agent and model from menus
djinn chat

# Direct — skip selection
djinn chat --agent finn --model anthropic/claude-sonnet-4
```

Features:

- **Streaming markdown** — responses render as markdown in the terminal in real-time
- **Collapsible thinking blocks** — extended thinking is collapsed by default, expand with Enter or right arrow
- **Collapsible tool calls** — each tool call and result appears inline as a collapsed block with syntax-highlighted JSON. Expand to inspect arguments and output
- **Fuzzy-search model picker** — type to filter, arrow keys to navigate
- **Activity indicators** — the agent's current state (`thinking...`, `using bash...`, `writing...`) is shown inline next to the agent name
- **Stop and resume** — press Esc to abort the current response mid-stream
- **Copyable content** — tool call arguments and results use read-only text areas that support text selection

**Keybindings:**

| Key | Action |
|-----|--------|
| Enter | Send message / expand collapsible |
| Esc | Stop current response |
| Ctrl+C | End session and quit |
| Right arrow | Expand focused collapsible |
| Left arrow | Collapse focused collapsible |

The CLI chat creates a real chat session backed by a Docker container — the agent has the same tools, memory access, and workspace capabilities as in the dashboard. Sessions persist server-side, so you can see CLI chat history in the dashboard afterward.

Requires the CLI to be installed and authenticated:

```bash
pip install djinn-bot-cli
djinn login
djinn chat
```

See the [CLI Reference](/docs/reference/cli) for full installation and configuration details.

## Slack

Each agent gets its own Slack bot via Socket Mode. This is the most mature messaging integration and supports pipeline threads, @mentions, DMs, and AI agent features.

See [Slack Setup](/docs/guides/slack-setup) for the full configuration walkthrough.

Features:
- Per-agent bot identity (name, avatar)
- Pipeline threads (watch agents collaborate step-by-step)
- Direct mentions and DMs
- Active/passive thread participation
- Slack AI Agent & Assistants framework support (dynamic prompts, MCP)

## Discord

Each agent gets its own Discord bot via the Gateway API (discord.js). The architecture mirrors Slack -- per-agent identity, pipeline threads, and persistent conversation sessions via the session pool. All configuration is done through the DjinnBot dashboard with instant hot-reload -- no restarts needed.

See [Discord Setup](/docs/guides/discord-setup) for the full configuration walkthrough.

Features:
- Per-agent bot identity (name, avatar, separate Discord application per agent)
- Pipeline threads in a configured channel
- DM conversations with any agent
- @mention support in channels and threads
- Rich streaming output via DiscordStreamer (task cards, progress indicators, tool call status)
- Feedback reactions (thumbs up/down) on agent responses
- Allowlist support: wildcard (`*`), user IDs, or role-based (`role:Admin`)
- Hot reload -- token, allowlist, and config changes via the dashboard take effect immediately
- Optional user-to-DjinnBot account linking when `AUTH_ENABLED=true`

### How Discord Routing Works

Unlike Signal and WhatsApp which use a shared phone number and route messages to agents, Discord gives each agent its own bot. When a user DMs the Yukihiro bot, the message goes directly to Yukihiro. When a user mentions `@Finn` in a channel, Finn responds. No routing ambiguity.

Every incoming message is checked against the agent's **allowlist** before processing. If the allowlist is empty (the default), all messages are silently blocked -- this is a deliberate safety default. Set the allowlist to `*` during initial setup to allow all users, then restrict later if needed.

Pipeline runs create threads in the configured channel. Each step posts output attributed to the agent handling that step, with real-time streaming via DiscordStreamer -- including collapsible task cards showing tool calls and their results.

### Key Setup Requirements

1. **Message Content Intent** must be enabled in the Discord Developer Portal (Bot > Privileged Gateway Intents) -- without it, the bot fails to connect
2. **Server Members Intent** should be enabled for role-based allowlists
3. **Allowlist** must be set (e.g., `*`) in the dashboard -- empty allowlist = all messages blocked
4. **Auth linking** is only required when `AUTH_ENABLED=true` -- single-user setups skip this entirely

## Telegram

Each agent gets its own Telegram bot via [BotFather](https://t.me/BotFather). The architecture uses one-bot-per-agent with long-polling via [grammY](https://grammy.dev/).

See [Telegram Setup](/docs/guides/telegram-setup) for the full configuration walkthrough.

Features:
- Per-agent bot identity (each agent is a separate Telegram bot)
- DM conversations — message any agent's bot directly
- Typing indicators while the agent works
- HTML-formatted responses (markdown converted to Telegram HTML)
- Long messages automatically chunked to fit Telegram's limits
- Allowlist support (restrict by Telegram user ID or username)
- Hot reload — change bot tokens or enable/disable agents via the dashboard without restarting
- Redis pub/sub config listener for instant updates

### How Telegram Routing Works

Since each agent is its own Telegram bot, there's no routing needed. Message `@YukihiroBot` and Yukihiro answers. Message `@FinnBot` and Finn answers. Each bot runs its own grammY long-polling loop independently.

The TelegramBridgeManager starts one TelegramAgentBridge per enabled agent and monitors Redis for config changes, so you can enable or disable agents' Telegram bots without restarting the engine.

## Signal

Signal uses a shared phone number model — one Signal account linked to DjinnBot, with intelligent routing that directs incoming messages to the right agent.

See [Signal Setup](/docs/guides/signal-setup) for the full configuration walkthrough.

Features:
- End-to-end encrypted messaging via Signal protocol
- Shared phone number with smart agent routing
- Typing indicators while the agent works
- Signal text styles (bold, italic, monospace) converted from markdown
- Read receipts
- Allowlist support (restrict by phone number)
- Built-in commands: `/agent <name>` to switch agents, `/agents` to list, `/help`
- Sticky routing — once you start a conversation with an agent, replies stay with that agent until timeout or explicit switch
- Dashboard linking flow (QR code via signal-cli)
- Distributed lock ensures only one engine instance runs the signal-cli daemon

### How Signal Routing Works

Signal uses a single linked phone number for all agents. The SignalRouter determines which agent handles each message:

1. **Sticky routing** — if you recently talked to an agent, new messages continue going to them (configurable TTL, default 30 minutes)
2. **Explicit switch** — send `/agent finn` to route to Finn
3. **Per-sender defaults** — the allowlist can assign a default agent per phone number
4. **Fallback** — messages go to the configured default agent

The signal-cli daemon runs as a child process inside the engine container, communicating via a local HTTP API and SSE event stream.

## WhatsApp

WhatsApp uses a shared phone number model via [Baileys](https://github.com/WhiskeySockets/Baileys) (unofficial WhatsApp Web API). One WhatsApp account linked to DjinnBot, with the same smart routing as Signal.

See [WhatsApp Setup](/docs/guides/whatsapp-setup) for the full configuration walkthrough.

Features:
- Message agents from WhatsApp on any phone
- Shared phone number with smart agent routing (same as Signal)
- Typing indicators ("composing" presence)
- WhatsApp-formatted responses (markdown converted to WhatsApp bold/italic/monospace)
- Read receipts and acknowledgment reactions
- Long messages automatically chunked
- Allowlist support (restrict by phone number)
- Built-in commands: `/agent <name>`, `/agents`, `/help`
- Sticky routing with configurable TTL
- Dashboard linking flow (QR code or pairing code)
- Distributed lock for single-writer safety

### How WhatsApp Routing Works

WhatsApp routing works identically to Signal — sticky sessions, explicit `/agent` commands, per-sender defaults from the allowlist, and a configurable fallback agent.

The Baileys socket runs in-process inside the engine (no child process needed). Auth state is persisted to JuiceFS at `/data/whatsapp/auth`, so the session survives container restarts.

## Camoufox Anti-Detection Browser

Agent containers include [Camoufox](https://camoufox.com/), an anti-detection browser based on Firefox. This enables agents to browse the web with realistic browser fingerprints, bypassing bot detection on sites that block standard HTTP clients.

Camoufox runs as a local REST API inside each agent container (`http://127.0.0.1:9377`). Agents interact with it through browser tools:

- **`create_tab`** — open a URL in a new browser tab
- **`get_tab_content`** — extract page content as cleaned text or HTML
- **`click_element`** — click a page element by CSS selector or text
- **`type_text`** — type into form fields
- **`scroll`** — scroll the page
- **`screenshot`** — capture a screenshot
- **`close_tab`** — close a tab

### Authenticated Browsing with Cookies

Agents can browse authenticated sites using cookies uploaded by the user. The flow:

1. User uploads a Netscape-format cookie file via the dashboard, CLI, or Cookie Bridge extension
2. Admin grants cookie access to specific agents
3. When the agent's container starts, granted cookies are mounted at `/home/agent/cookies/`
4. Camoufox loads the cookies before navigating, enabling authenticated sessions

## Cookie Bridge Browser Extension

The **DjinnBot Cookie Bridge** is a Chrome/Firefox extension that exports browser cookies directly to DjinnBot:

1. Install the extension from `apps/browser-extension/` (load unpacked in Chrome, or build for Firefox)
2. Click the extension icon and enter your DjinnBot server URL
3. Click **Export Cookies** — the extension reads all cookies for the current domain and uploads them to the DjinnBot API
4. Grant agent access via the dashboard or CLI

This eliminates the need to manually export cookie files from browser developer tools.

```bash
# Build the extension
cd apps/browser-extension
./build.sh chrome    # or: ./build.sh firefox
```

## Shared Architecture

All messaging integrations follow the same patterns:

1. **Bridge service** — connects to the external platform's API (e.g., `packages/slack/`, `packages/discord/`, `packages/telegram/`, `packages/signal/`, `packages/whatsapp/`)
2. **Event routing** — maps platform events to DjinnBot's event bus via Redis
3. **Per-agent identity** — manages bot accounts/tokens for each agent (Slack, Discord, Telegram) or routes through a shared number (Signal, WhatsApp)
4. **Thread mapping** — links platform threads to pipeline runs (Slack, Discord)
5. **ChatSessionManager** — all platforms use the same session manager, so every conversation gets a full agent container with tools, memory, and workspace access
6. **Typing indicators** — platform-native typing status while agents work
7. **Message formatting** — markdown converted to each platform's native format (Slack mrkdwn, Discord markdown, Telegram HTML, Signal text styles, WhatsApp formatting)
8. **Allowlists** — restrict which users can interact, managed via the dashboard

The engine's event-driven architecture makes adding new interfaces straightforward — new bridges subscribe to Redis events and publish commands back.

## Contributing an Interface

If you want to add support for a new platform, the existing bridge packages are the reference:

| Package | Platform | Key Pattern |
|---------|----------|-------------|
| `packages/slack/` | Slack | Per-agent Socket Mode bots |
| `packages/discord/` | Discord | Per-agent Gateway bots via discord.js |
| `packages/telegram/` | Telegram | Per-agent long-polling bots via grammY |
| `packages/signal/` | Signal | Shared number, signal-cli daemon + SSE |
| `packages/whatsapp/` | WhatsApp | Shared number, Baileys in-process socket |

A new interface would implement the same bridge pattern for a different platform.
