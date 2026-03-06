---
title: WhatsApp Setup
weight: 9
---

DjinnBot's WhatsApp integration lets you message your agents from WhatsApp — the world's most widely used messenger. WhatsApp uses a shared phone number model (like Signal): one WhatsApp account is linked to DjinnBot, and incoming messages are routed to agents automatically.

{{< callout type="info" >}}
WhatsApp integration is **optional**. The built-in dashboard chat works without any WhatsApp configuration. Set this up only if you want to reach agents via WhatsApp.
{{< /callout >}}

## Overview

WhatsApp works similarly to Signal:

- **Shared phone number** — one WhatsApp account for all agents
- **Smart routing** — sticky sessions, explicit commands, per-sender defaults, or a fallback agent
- **Linked device** — DjinnBot links as a companion device to an existing WhatsApp account (like WhatsApp Web)
- **Baileys** — an unofficial WhatsApp Web API that runs in-process inside the engine (no external daemon)

## Prerequisites

- A **dedicated phone number** with an active WhatsApp account — this should **not** be your personal phone number, since all messages sent to this number will be handled by DjinnBot. You can register a WhatsApp account on a number without a separate phone — you just need a number that can receive an SMS or voice call for verification (a cheap prepaid SIM or VoIP number works well).
- DjinnBot must be running

DjinnBot links as a companion device. The WhatsApp account on the dedicated number continues to work normally.

{{< callout type="warning" >}}
**Do not use your personal phone number.** Any WhatsApp messages sent to the linked number will be routed to DjinnBot agents.
{{< /callout >}}

## Step 1: Link DjinnBot to WhatsApp

You can link via **QR code** or **pairing code**.

### Option A: QR Code

{{% steps %}}

### Open the Dashboard

Navigate to **Settings > Integrations > WhatsApp**.

### Start Linking

Click **Link Device**. DjinnBot will display a QR code.

### Scan with WhatsApp

On your phone, open WhatsApp:
1. Go to **Settings > Linked Devices**
2. Tap **Link a Device**
3. Scan the QR code from the dashboard

### Wait for Connection

After scanning, the Baileys socket completes the handshake. The dashboard will update to show the linked phone number.

{{% /steps %}}

### Option B: Pairing Code

If you can't scan a QR code (e.g., using a remote server):

1. In **Settings > Integrations > WhatsApp**, click **Use Pairing Code**
2. Enter your phone number (with country code)
3. A 6-digit pairing code will appear on screen
4. On your phone, go to WhatsApp > **Linked Devices** > **Link a Device** > **Link with phone number instead**
5. Enter the pairing code

## Step 2: Enable the Integration

After linking:

1. Toggle **Enabled** to ON
2. Select a **Default Agent** (fallback for unrouted messages)
3. Set the **Sticky TTL** (default 30 minutes)
4. Optionally set an **Ack Emoji** — the agent reacts to each incoming message with this emoji (e.g., `👀`) to confirm receipt
5. Save

## Step 3: Set Up Allowlists

Control who can message your agents:

1. In **Settings > Integrations > WhatsApp**, configure the **Allowlist**
2. Add phone numbers in E.164 format (e.g., `+15551234567`)
3. Optionally assign a **default agent** per phone number
4. Or toggle **Allow All** for open access

Unrecognized senders are silently ignored.

## How WhatsApp Routing Works

WhatsApp routing works identically to Signal:

| Priority | Method | Example |
|----------|--------|---------|
| 1 | **Sticky session** | You talked to Finn 5 minutes ago — new messages continue going to Finn |
| 2 | **Explicit command** | Send `/agent yukihiro` to switch to Yukihiro |
| 3 | **Per-sender default** | Your phone number has "Eric" set as default in the allowlist |
| 4 | **Global fallback** | The configured default agent handles it |

### Built-in Commands

| Command | Description |
|---------|-------------|
| `/agent <name>` | Switch to a specific agent |
| `/agents` | List all available agents |
| `/new` | Start a fresh conversation (clears history) |
| `/model <name>` | Switch the AI model for your session |
| `/modelfavs` | Show your favorite models |
| `/help` | Show available commands |

## WhatsApp Architecture

The Baileys socket runs in-process inside the engine container — no child process or external daemon needed.

- **Auth persistence** — session state is saved to JuiceFS at `/data/whatsapp/auth`, surviving container restarts
- **QR codes** — stored temporarily in Redis for dashboard polling
- **Presence updates** — the agent shows as "typing..." in WhatsApp while processing
- **Read receipts** — messages are automatically marked as read
- **Distributed lock** — ensures only one engine instance runs the Baileys socket
- **Message chunking** — long responses are automatically split to fit WhatsApp's message length limits

## Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `WHATSAPP_AUTH_DIR` | `/data/whatsapp/auth` | Path to Baileys auth state on JuiceFS |

This is usually left at its default. The engine's `docker-compose.yml` already maps it.

## Unlinking

To unlink DjinnBot from your WhatsApp account:

1. Go to **Settings > Integrations > WhatsApp** in the dashboard
2. Click **Unlink**

Or from your phone: WhatsApp > Settings > Linked Devices > remove the DjinnBot device.

After unlinking, the Baileys auth state is cleared. You'll need to re-link to use WhatsApp again.

## Troubleshooting

### "Another engine instance holds the WhatsApp lock"

- Only one engine instance can run the Baileys socket at a time. Stop other instances or wait for the lock TTL (30s) to expire.

### QR code doesn't appear

- The Baileys socket may still be initializing. Wait a few seconds and click **Link Device** again.
- Check engine logs: `docker compose logs engine | grep -i whatsapp`

### Messages not being received

- Check that WhatsApp is **Enabled** (not just linked) in the dashboard
- Verify the sender is on the allowlist (or Allow All is on)
- Make sure the Baileys socket is connected: look for `[WhatsAppBridge] Connection: open` in logs
- WhatsApp may disconnect idle sessions after extended periods — check the dashboard to see if re-linking is needed

### Messages sent but no response

- Confirm the ChatSessionManager is injected (look for `[WhatsAppBridge] ChatSessionManager injected` in logs)
- Check that the default agent is set and exists in the agent registry

### "WhatsApp is not connected" when sending via API

- The Baileys socket isn't connected. Check if the integration is enabled and the account is linked in the dashboard.

## WhatsApp Resources

- [WhatsApp Linked Devices](https://faq.whatsapp.com/1317564962315842/) — how companion devices work
- [Baileys](https://github.com/WhiskeySockets/Baileys) — the WhatsApp Web API library used by DjinnBot
