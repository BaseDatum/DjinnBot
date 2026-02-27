---
title: Telegram Setup
weight: 7
---

Each DjinnBot agent can have its own Telegram bot, created through BotFather. Users message the bot directly — no routing needed. The TelegramBridgeManager handles hot-reloading, so you can enable or disable agents' bots without restarting the engine.

{{< callout type="info" >}}
Telegram integration is **optional**. The built-in dashboard chat works without any Telegram configuration. Set this up only if you want agents reachable via Telegram.
{{< /callout >}}

## Overview

Telegram uses a one-bot-per-agent model:

- Each agent gets its own Telegram bot (created via BotFather)
- Users DM the bot directly — messages go straight to that agent
- No routing ambiguity, no shared accounts
- Bots use long-polling via [grammY](https://grammy.dev/), so no public URL or webhook endpoint is required

## Step 1: Create Bots with BotFather

For each agent you want on Telegram:

{{% steps %}}

### Open BotFather

Open Telegram and start a conversation with [@BotFather](https://t.me/BotFather).

### Create a new bot

Send `/newbot` and follow the prompts:

1. Choose a display name (e.g., "Eric - Product Owner")
2. Choose a username (must end in `bot`, e.g., `djinnbot_eric_bot`)
3. BotFather will reply with the **bot token** — save this

### Customize the bot (optional)

- `/setdescription` — what users see before starting a conversation
- `/setabouttext` — shown on the bot's profile page
- `/setuserpic` — upload the agent's avatar

{{% /steps %}}

Repeat for each agent you want on Telegram.

## Step 2: Configure in the Dashboard

The easiest way to set up Telegram is through the dashboard:

1. Open the DjinnBot dashboard
2. Go to **Settings > Integrations > Telegram**
3. For each agent, enter the bot token from BotFather
4. Toggle the agent to **Enabled**
5. Save

The engine picks up the change immediately via Redis pub/sub — no restart needed.

### Alternative: Environment Variables

You can also configure Telegram via environment variables and YAML files.

Add the bot token to `.env`:

```bash
TELEGRAM_ERIC_BOT_TOKEN=123456789:ABCdefGHIjklMNOpqrsTUVwxyz
TELEGRAM_FINN_BOT_TOKEN=987654321:ZYXwvuTSRqpoNMLkjihGFEdcba
```

Create `agents/<agent-id>/telegram.yml`:

```yaml
bot_token: ${TELEGRAM_ERIC_BOT_TOKEN}
```

Then restart:

```bash
docker compose restart engine
```

## Step 3: Set Up Allowlists

By default, Telegram bots are open to anyone who finds them. To restrict access:

1. Go to **Settings > Integrations > Telegram** in the dashboard
2. Under each agent, configure the **Allowlist**
3. Add allowed users by Telegram user ID or username
4. Or toggle **Allow All** if the bot should be publicly accessible

To find a user's Telegram ID, have them message [@userinfobot](https://t.me/userinfobot).

## How Telegram Integration Works

### Message Flow

1. User sends a message to an agent's Telegram bot
2. The grammY long-polling loop picks it up
3. Allowlist check — unauthorized users are silently ignored
4. Typing indicator starts (the bot shows "typing..." in the chat)
5. Message is routed to a ChatSessionManager session
6. Agent processes the message in a full container with tools and memory
7. Response is converted from markdown to Telegram HTML and sent back
8. Long responses are automatically split into multiple messages

### Typing Indicators

While an agent works, Telegram shows the "typing..." indicator. This is refreshed every few seconds (Telegram typing expires after ~5s), so the user always knows the agent is processing.

### Message Formatting

Agent responses are converted from markdown to Telegram's HTML format:

- `**bold**` becomes `<b>bold</b>`
- `` `code` `` becomes `<code>code</code>`
- Code blocks become `<pre>` blocks with language tags
- Links are preserved as `<a>` tags

If HTML parsing fails (edge cases in agent output), the bot falls back to plain text.

### Hot Reload

The TelegramBridgeManager listens for Redis pub/sub events on `telegram:config:changed:{agentId}`. When you update an agent's Telegram config in the dashboard:

1. The API publishes a config change event
2. The manager stops the old bot (if running)
3. The manager starts a new bot with the updated config

No engine restart required.

## Troubleshooting

### Bot doesn't respond

- Verify the bot token is correct — send `/token` to BotFather to see active tokens
- Check that the agent is enabled in the dashboard Telegram settings
- Check engine logs: `docker compose logs engine | grep -i telegram`
- Make sure the user is on the allowlist (or Allow All is on)

### "Chat sessions not yet configured" error

- The ChatSessionManager hasn't been injected yet — this usually means the engine is still starting up. Wait a few seconds and try again.

### Bot responds to some users but not others

- Check the allowlist — only users matching an allowlist entry (by Telegram user ID or username) get a response. Others are silently ignored.

## Telegram Resources

- [BotFather](https://t.me/BotFather) — create and manage Telegram bots
- [Telegram Bot API](https://core.telegram.org/bots/api)
- [grammY Framework](https://grammy.dev/) — the TypeScript Telegram bot framework used by DjinnBot
