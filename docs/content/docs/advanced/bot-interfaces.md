---
title: Bot Interfaces
weight: 2
---

DjinnBot agents can interact through multiple interfaces. The dashboard chat, CLI chat, and Slack are all supported today, with more platforms planned.

## Current Interfaces

### Dashboard Chat

The built-in chat interface at `http://localhost:3000/chat` requires no additional setup. Features:

- Select any agent and model
- Full tool access (code execution, file operations, web research)
- Persistent chat history
- Real-time streaming responses
- File uploads and image attachments
- HTML preview for generated content
- Supports onboarding and project-context sessions

This is the primary interface for users who prefer a browser-based experience.

### CLI Chat

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

### Slack

Each agent gets its own Slack bot via Socket Mode. See [Slack Bot Setup](/docs/guides/slack-setup) for configuration.

Features:
- Per-agent bot identity (name, avatar)
- Pipeline threads (watch agents collaborate)
- Direct mentions and DMs
- Active/passive thread participation

### Camoufox Anti-Detection Browser

Agent containers include [Camoufox](https://camoufox.com/), an anti-detection browser based on Firefox. This enables agents to browse the web with realistic browser fingerprints, bypassing bot detection on sites that block standard HTTP clients.

Camoufox runs as a local REST API inside each agent container (`http://127.0.0.1:9377`). Agents interact with it through browser tools:

- **`create_tab`** — open a URL in a new browser tab
- **`get_tab_content`** — extract page content as cleaned text or HTML
- **`click_element`** — click a page element by CSS selector or text
- **`type_text`** — type into form fields
- **`scroll`** — scroll the page
- **`screenshot`** — capture a screenshot
- **`close_tab`** — close a tab

#### Authenticated Browsing with Cookies

Agents can browse authenticated sites using cookies uploaded by the user. The flow:

1. User uploads a Netscape-format cookie file via the dashboard, CLI, or Cookie Bridge extension
2. Admin grants cookie access to specific agents
3. When the agent's container starts, granted cookies are mounted at `/home/agent/cookies/`
4. Camoufox loads the cookies before navigating, enabling authenticated sessions

### Cookie Bridge Browser Extension

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

## Planned Interfaces

### Discord

Discord bot support is on the roadmap. The architecture mirrors Slack — each agent gets its own bot account, pipeline runs create threads, and agents respond to mentions.

### Microsoft Teams

Teams integration is planned for enterprise environments that standardize on the Microsoft ecosystem.

### Custom Webhooks

A generic webhook interface will allow integration with any chat platform or custom application. Send messages in, receive agent responses out, via simple HTTP.

### API-Only

The REST API and SSE streaming already allow building custom frontends. Any application that can make HTTP requests can interact with DjinnBot agents.

## Architecture for New Interfaces

Adding a new chat interface involves:

1. **Bridge service** — connects to the external platform's API (similar to `packages/slack/`)
2. **Event routing** — maps platform events to DjinnBot's event bus
3. **Per-agent identity** — manages bot accounts/tokens for each agent
4. **Thread mapping** — links platform threads to pipeline runs

The engine's event-driven architecture makes this straightforward — new interfaces subscribe to Redis events and publish commands back.

## Contributing an Interface

If you want to add support for a new platform, the Slack package (`packages/slack/`) is the reference implementation. The key files:

- `slack-bridge.ts` — routes events between Slack and the engine
- `agent-slack-runtime.ts` — manages per-agent Socket Mode connections
- `thread-manager.ts` — maps runs to Slack threads
- `slack-streamer.ts` — streams agent output to Slack messages

A new interface would implement the same patterns for a different platform.
