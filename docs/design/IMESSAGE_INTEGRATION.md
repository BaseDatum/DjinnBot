# iMessage Channel Integration Design

> Status: **Design** | Created: 2026-02-27
> Branch: (not yet created — aligned with `feat/signal-integration`)

## Overview

One iMessage account (phone number / Apple ID) serves the entire DjinnBot platform.
Messages are routed to agents via an `iMessageRouter` identical in design to `SignalRouter`.
The bridge runs as a **standalone sidecar process on the host Mac** — not inside Docker —
because iMessage requires macOS GUI/Automation framework access.

---

## How OpenClaw Does iMessage (Reference)

OpenClaw's ecosystem has two main approaches:

**A. `imsg` CLI binary** (`secure-openclaw/adapters/imessage.js`)
- Spawns `imsg watch --json` as a child process; receives messages via NDJSON on stdout.
- Sends via `imsg send --chat-id <id> --text <text>`.
- Requires the `imsg` binary installed on macOS + Full Disk Access.
- No typing indicators, no read receipts.

**B. Native AppleScript + SQLite polling** (`openclaw-imessage-skill`)
- Polls `~/Library/Messages/chat.db` via `sqlite3` every 2 seconds.
- Sends via `osascript` calling `tell application "Messages" to send ...`.
- Tracks `lastMessageTime` and `knownMessageIds` to avoid duplicates.
- Supports attachments; resolves file paths from the Attachments directory.
- No typing indicators (AppleScript limitation).

**Key OpenClaw limitations** we are solving:
- No typing indicators (except BlueBubbles, which adds setup weight).
- No multi-agent routing (single-agent model).
- No allowlist system.
- No dashboard UI for setup — config-file-driven.
- No read receipt handling in the simple approaches.

---

## Architecture

```
┌─────────────────────────────┐     ┌──────────────────────────────┐
│  Docker: DjinnBot Engine    │     │  macOS Host: iMessage Sidecar│
│  ┌───────────────────────┐  │     │  ┌────────────────────────┐  │
│  │ API Server (Python)   │  │     │  │ iMessageBridge (Node)  │  │
│  │ /v1/imessage/*        │──┼─────┼─▶│ - SQLite poller        │  │
│  └───────────────────────┘  │Redis│  │ - AppleScript sender   │  │
│  ┌───────────────────────┐  │RPC  │  │ - Router               │  │
│  │ ChatSessionManager    │◀─┼─────┼──│ - Allowlist checker    │  │
│  └───────────────────────┘  │     │  └────────────────────────┘  │
└─────────────────────────────┘     │          │                   │
                                    │          ▼                   │
                                    │  ~/Library/Messages/chat.db  │
                                    │  Messages.app (AppleScript)  │
                                    └──────────────────────────────┘
```

### Why a Sidecar?

DjinnBot runs in Docker (`Dockerfile.engine`, `docker-compose.yml`).
macOS's `~/Library/Messages/chat.db` is not accessible from inside a container,
and `osascript` requires the macOS GUI/Automation framework.
Signal solved this by embedding `signal-cli` (a cross-platform Java binary)
inside the container — that approach is not available for iMessage.

The sidecar is a lightweight Node.js process started on the host Mac.
It communicates exclusively via Redis pub/sub (RPC), keeping it cleanly
decoupled from the containerized engine.

---

## Package Structure

```
packages/imessage/
  src/
    imessage-bridge.ts          # Top-level coordinator (mirrors SignalBridge)
    imessage-client.ts          # AppleScript send + SQLite read abstraction
    imessage-router.ts          # Multi-agent routing (same pattern as SignalRouter)
    imessage-typing-manager.ts  # Noop stub + optional "processing" ack message
    imessage-format.ts          # Markdown → plain text stripping
    imessage-poller.ts          # SQLite chat.db polling loop
    allowlist.ts                # Import from @djinnbot/core (shared with Signal)
    types.ts
  package.json
```

---

## Transport Layer

### Receiving Messages

Poll `~/Library/Messages/chat.db` every 2 seconds via `sqlite3` subprocess.

```sql
SELECT
  message.ROWID,
  message.text,
  message.date,
  message.is_from_me,
  handle.id,
  chat.chat_identifier,
  message.associated_message_type
FROM message
LEFT JOIN handle ON message.handle_id = handle.ROWID
LEFT JOIN chat_message_join ON message.ROWID = chat_message_join.message_id
LEFT JOIN chat ON chat_message_join.chat_id = chat.ROWID
WHERE message.date > {lastMessageTime}
  AND message.is_from_me = 0
  AND message.associated_message_type = 0
ORDER BY message.date ASC
LIMIT 500
```

State tracking:
- `lastMessageDate` — Apple's internal nanosecond timestamp.
- `Set<rowid>` — deduplicate within the polling window.
- Prune `Set` when it exceeds 1000 entries (drop oldest 500).

### Sending Messages

```bash
osascript -e 'tell application "Messages" to send "text" to buddy "+15551234567"'
```

### Address Handling

iMessage addresses can be E.164 phone numbers **or** email addresses (Apple ID).
All normalization, allowlist matching, and routing must support both formats.

```typescript
function normalizeAddress(raw: string): string {
  const trimmed = raw.trim();
  // If it looks like an email, lowercase it
  if (trimmed.includes('@')) return trimmed.toLowerCase();
  // Otherwise treat as phone number → E.164
  return normalizeE164(trimmed);
}
```

### Prerequisites (macOS Host)

1. Messages.app signed into the desired iMessage account.
2. Full Disk Access granted to the engine process (for `chat.db` reads).
3. Automation permission for Messages.app (for AppleScript sends).
4. Redis accessible from the Mac (same network as the Docker host).

---

## iMessageBridge Lifecycle

Mirrors `SignalBridge` from the signal-integration branch:

```
1. Connect to Redis
2. Acquire distributed lock (key: djinnbot:imessage:daemon-lock)
3. Load config from API (GET /v1/imessage/config)
4. If not enabled → exit
5. Start SQLite poller loop
6. Initialize iMessageRouter with agentRegistry
7. Start Redis RPC handler (subscribe to imessage:rpc:request)
8. Log startup: address, default agent
```

### Incoming Message Flow

```
1. Normalize sender address (phone or email)
2. Allowlist check → reject if not allowed
3. Built-in command check (/help, /agents, /switch, /end)
4. Route to agent via iMessageRouter
5. Optionally send "processing..." ack (if send_ack enabled in config)
6. Process with ChatSessionManager (session ID: imessage_{address}_{agentId})
7. Send response via AppleScript (prefixed with agent emoji + name)
```

---

## Multi-Agent Routing (iMessageRouter)

Identical design to `SignalRouter`. Redis key prefix: `imessage:conv:`.

### Routing Priority (first match wins)

1. **Explicit prefix** — message starts with `@agentname` or `/agentname`
2. **Sticky conversation** — sender recently talked to an agent (Redis TTL)
3. **Sender default** — allowlist entry has a `default_agent_id`
4. **Fallback** — system-wide `default_agent_id` from `imessage_config`

### Built-in Commands

| Command | Description |
|---------|-------------|
| `/help` | List available commands |
| `/agents` | List agents available on iMessage |
| `/switch <name>` | Switch to a different agent |
| `/end` | Clear sticky conversation; next message goes to default agent |

---

## Typing Indicators

iMessage has **no public API for typing indicators**. The `iMessageTypingManager`
is a noop stub that maintains interface parity with `SignalTypingManager`.

### Mitigations

1. **Processing acknowledgment** (opt-in via `send_ack` config flag): Send a brief
   `"..."` message when processing starts. Not ideal but provides user feedback.
2. **Future BlueBubbles support**: If the transport layer is swapped to BlueBubbles,
   the typing manager can be upgraded to use its WebSocket-based typing indicator API.
3. **Read receipts**: Setup instructions recommend enabling read receipts in Messages.app
   settings so the sender at least sees the message was read.

---

## Agent Send Tool (Escalation / Outbound)

Agents get an MCP tool for proactive outreach:

```typescript
{
  name: "send_imessage",
  description: "Send an iMessage to a user for escalation or notification",
  parameters: {
    address: string,   // E.164 phone number or email
    message: string,
  }
}
```

Routes through Redis RPC → sidecar → AppleScript.
Message is prefixed with agent identity (emoji + name) for identification.

---

## Allowlist System

### Shared Logic (extract to `@djinnbot/core`)

Used by both Signal and iMessage integrations:

- `normalizeAddress(raw)` — handles E.164 and email
- `isSenderAllowed(address, entries, allowAll)`
- `resolveAllowlist(dbEntries)`

### Supported Patterns

| Pattern | Example | Matches |
|---------|---------|---------|
| Exact phone | `+15551234567` | That number only |
| Prefix wildcard | `+1555*` | All numbers starting with `+1555` |
| Exact email | `user@example.com` | That email only |
| Domain wildcard | `*@example.com` | All addresses at that domain |
| Accept all | `*` | Everything |

The `allow_all` toggle on the config bypasses the allowlist entirely.

---

## Database Schema

### `imessage_config` (singleton, id = 1)

| Column | Type | Notes |
|--------|------|-------|
| `id` | INTEGER PK | Always 1 |
| `enabled` | BOOLEAN | Master toggle |
| `address` | VARCHAR(128) | The iMessage address being used |
| `verified` | BOOLEAN | Messages.app health check passed |
| `default_agent_id` | VARCHAR(128) | Fallback agent |
| `sticky_ttl_minutes` | INTEGER | Default 30 |
| `allow_all` | BOOLEAN | Skip allowlist |
| `send_ack` | BOOLEAN | Send "processing..." message on receipt |
| `updated_at` | BIGINT | |

### `imessage_allowlist`

| Column | Type | Notes |
|--------|------|-------|
| `id` | INTEGER PK AUTO | |
| `address` | VARCHAR(128) | Phone, email, or pattern |
| `label` | VARCHAR(256) | Friendly name for dashboard |
| `default_agent_id` | VARCHAR(128) | Per-sender agent routing |
| `created_at` | BIGINT | |
| `updated_at` | BIGINT | |

### Alembic Migration

File: `alembic/versions/zb4_add_imessage_integration.py`

- Create `imessage_config` with singleton row.
- Create `imessage_allowlist`.

---

## Server API Endpoints

`packages/server/app/routers/imessage.py` — mounted at `/v1/imessage`:

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/config` | Read config + verified status |
| `PUT` | `/config` | Update config |
| `POST` | `/verify` | Health check via Redis RPC (can we poll chat.db and send?) |
| `GET` | `/allowlist` | List entries |
| `POST` | `/allowlist` | Add entry |
| `PUT` | `/allowlist/{id}` | Update entry |
| `DELETE` | `/allowlist/{id}` | Remove entry |
| `POST` | `/{agent_id}/send` | Send message as agent (Redis RPC → sidecar) |
| `GET` | `/health` | Sidecar liveness check (Redis RPC) |

### Redis RPC Protocol

Same pattern as Signal:

- API publishes to `imessage:rpc:request`
- Sidecar subscribes, processes, publishes reply to `imessage:rpc:reply:{id}`
- Methods: `send`, `health`, `verify`

---

## Dashboard UI

System-level page (not per-agent — one iMessage account serves all agents).

### 1. Setup Tab (Manual Instructions)

Step-by-step guide rendered in the dashboard:

1. Ensure Messages.app is signed in on this Mac.
2. Grant Full Disk Access to the sidecar process in
   System Settings > Privacy & Security > Full Disk Access.
3. Grant Automation permission for Messages.app.
4. Start the sidecar on the Mac:
   ```bash
   npx @djinnbot/imessage --redis-url redis://localhost:6379
   ```
5. Click **Verify Connection** → calls `POST /v1/imessage/verify`.

Status display:
- Green/red badge with detected iMessage address.
- Enable/disable toggle.

### 2. Allowlist Tab

- Table: address, label, default agent, edit/delete actions.
- Add button → form with address input, label, agent dropdown.
- "Allow All" toggle at top with warning text.
- Tooltip explaining wildcard patterns.

### 3. Routing Tab

- Default agent dropdown.
- Sticky conversation TTL slider (5–120 min).
- List of agents enabled for iMessage channel.

---

## Format Handler

`imessage-format.ts` — strip markdown for plain text delivery (iMessage has no
rich text API via AppleScript):

| Markdown | Output |
|----------|--------|
| `**bold**` | `bold` |
| `*italic*` | `italic` |
| `` `code` `` | `code` |
| `~~strike~~` | `strike` |
| Code blocks | Preserved as indented text |
| URLs | Preserved as-is (iMessage renders links natively) |

Simpler than Signal's `signal-format.ts` which produces positional style ranges.

---

## Differences from Signal Integration

| Aspect | Signal | iMessage |
|--------|--------|----------|
| Daemon location | signal-cli inside Docker | Sidecar on host Mac |
| Protocol | JSON-RPC + SSE | SQLite polling + AppleScript |
| Linking | QR code scan in dashboard | Manual setup + verify button |
| Typing indicators | Real indicators via signal-cli | Noop stub (platform limitation) |
| Address format | E.164 only | E.164 + email |
| Transport binary | `signal-cli` (GraalVM native) | `osascript` + `sqlite3` |
| Redis RPC channel | `signal:rpc:*` | `imessage:rpc:*` |
| Sticky key prefix | `signal:conv:*` | `imessage:conv:*` |
| Lock key | `djinnbot:signal:daemon-lock` | `djinnbot:imessage:daemon-lock` |

---

## File Inventory

| Layer | File | Purpose |
|-------|------|---------|
| Engine | `packages/imessage/src/imessage-bridge.ts` | Top-level coordinator |
| Engine | `packages/imessage/src/imessage-client.ts` | AppleScript send + SQLite read |
| Engine | `packages/imessage/src/imessage-router.ts` | Multi-agent routing |
| Engine | `packages/imessage/src/imessage-typing-manager.ts` | Noop stub |
| Engine | `packages/imessage/src/imessage-poller.ts` | chat.db polling loop |
| Engine | `packages/imessage/src/imessage-format.ts` | Markdown stripping |
| Engine | `packages/imessage/src/allowlist.ts` | Shared from `@djinnbot/core` |
| Engine | `packages/imessage/src/types.ts` | Type definitions |
| Server | `packages/server/app/models/imessage.py` | DB models |
| Server | `packages/server/app/routers/imessage.py` | API endpoints |
| Server | `alembic/versions/zb4_imessage.py` | Migration |
| Dashboard | `packages/dashboard/src/routes/imessage.tsx` | Settings page |
| Dashboard | `packages/dashboard/src/components/channels/iMessageSetup.tsx` | Setup wizard |

---

## Implementation Order

1. DB migration + server models (`imessage_config`, `imessage_allowlist`).
2. Server API endpoints (`routers/imessage.py`).
3. Extract shared allowlist logic to `@djinnbot/core`.
4. `packages/imessage` — bridge, client, router, poller, format.
5. Dashboard UI — setup page, allowlist CRUD, routing config.
6. Agent MCP tool registration (`send_imessage`).
7. Integration testing on macOS host.
