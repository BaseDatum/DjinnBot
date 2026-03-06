---
title: Discord Setup
weight: 6
---

Each DjinnBot agent can have its own Discord bot, appearing as a distinct team member in your server. Users can DM or @mention any agent, and pipeline runs create threads with rich streaming output.

{{< callout type="info" >}}
Discord integration is **optional**. The built-in dashboard chat works without any Discord configuration. Set this up only if you want agents visible in your Discord server.
{{< /callout >}}

## Quick Start

The fastest path from zero to working Discord bot:

1. Create a Discord application and bot in the Developer Portal
2. Enable required Gateway Intents
3. Invite the bot to your server
4. Add the bot token and allowlist in the DjinnBot dashboard
5. The bot connects automatically -- no restart needed

The rest of this guide walks through each step in detail.

## Step 1: Create a Discord Application

For each agent you want on Discord:

{{% steps %}}

### Go to the Discord Developer Portal

Navigate to [discord.com/developers/applications](https://discord.com/developers/applications) and click **New Application**.

### Name it after the agent

Use a descriptive name like "Yukihiro" or "Finn - Architect". This name appears in the bot's profile.

### Note the Application ID

On the **General Information** page, copy the **Application ID** -- you'll enter this in the DjinnBot dashboard later.

### Go to the Bot section

Click **Bot** in the left sidebar. The bot user is created automatically with the application. Click **Reset Token** and copy the **Bot Token** -- you'll need this shortly.

{{< callout type="warning" >}}
The bot token is shown only once after reset. Copy it immediately. If you lose it, you'll need to reset it again.
{{< /callout >}}

### Enable Privileged Gateway Intents

Still on the **Bot** page, scroll down to **Privileged Gateway Intents** and enable:

- **Server Members Intent** -- required for role-based allowlists and user lookup
- **Message Content Intent** -- **required** to read message text (without this, the bot connects but can't see what users type)

Click **Save Changes**.

{{< callout type="error" >}}
If you skip the Message Content Intent, the bot will fail to connect with the error `Used disallowed intents`. This is the most common setup mistake.
{{< /callout >}}

### Generate an Invite URL

Go to **OAuth2 > URL Generator**. Select:

**Scopes:**
- `bot`
- `applications.commands`

**Bot Permissions:**
- Send Messages
- Send Messages in Threads
- Create Public Threads
- Create Private Threads
- Read Message History
- Add Reactions
- Use Slash Commands

### Invite the Bot

Copy the generated URL and open it in your browser to add the bot to your Discord server.

{{% /steps %}}

## Step 2: Configure in the DjinnBot Dashboard

This is where you connect the Discord application you just created to a DjinnBot agent. All configuration is done through the dashboard -- no YAML files or environment variables needed.

{{% steps %}}

### Open the agent's channel settings

In the DjinnBot dashboard, navigate to the agent you want to connect (e.g., `yukihiro`), then go to **Channels > Discord**.

### Enter the Bot Token

Paste the bot token you copied from the Developer Portal.

### Enter the Application ID

Paste the Application ID from the General Information page.

### Set the Allowlist

This is critical: **if the allowlist is empty, the bot silently ignores all messages.** You must set it to allow at least some users.

| Value | Effect |
|-------|--------|
| `*` | Allow everyone in the server |
| `123456789012345678` | Allow only this specific Discord user ID |
| `123456789012345678,987654321` | Allow multiple specific users |
| `role:Admin` | Allow anyone with the "Admin" role |
| `role:Admin,role:Moderator` | Allow multiple roles |
| `role:Admin,123456789012345678` | Mix roles and user IDs |
| _(empty)_ | **Block all messages** -- the bot receives them but does nothing |

For initial testing, set the allowlist to `*` so all users can interact. You can restrict it later.

{{< callout type="warning" >}}
The allowlist defaults to empty, which means **no messages are processed**. This is the second most common setup issue after the Message Content Intent. Always set the allowlist when configuring a new bot.
{{< /callout >}}

### Set the DM Policy (optional)

Controls how direct messages are handled:

- `allowlist` (default) -- DMs are subject to the same allowlist as channel messages
- `open` -- respond to DMs from anyone, regardless of the allowlist

### Set the Guild ID (optional)

If you want to restrict this bot to a single Discord server, paste the server's Guild ID. Leave blank to allow the bot in all servers it has been added to.

To get a Guild ID: right-click the server name in Discord (with Developer Mode enabled) and click **Copy Server ID**.

### Save

Click save. The engine detects the change automatically and starts (or restarts) the bot within a few seconds -- **no restart required**. Check the engine logs to confirm:

```bash
docker compose logs engine | grep -i discord
```

You should see:
```
[DiscordBridge] Credential change for yukihiro/discord (updated)
[yukihiro] Connecting to Discord...
[yukihiro] Discord connected -- Yukihiro (Yukihiro#5688) is online
[DiscordBridge] Agent yukihiro reloaded successfully
```

{{% /steps %}}

## Step 3: Test It

1. Open Discord and send a DM to the bot, or @mention it in a channel
2. Check the engine logs -- you should see the message arrive:

```
[yukihiro] Discord message received -- from=yourname#0 (123456789012345678) DM: "hello"
[yukihiro] Routing to DM handler
```

If you see `Message BLOCKED` instead, check the allowlist configuration.

## How Discord Integration Works

### DMs

Send a DM to any agent's bot for a private conversation. Each DM session gets a full agent container with tools, memory, and workspace access. Sessions persist -- you can pick up where you left off.

### @Mentions

Mention an agent in any channel it's in (`@Yukihiro what do you think?`) and it will respond with its full persona and memory. In threads, the bot responds when mentioned.

### Pipeline Threads

When a pipeline run starts, the DiscordBridge creates a thread in the configured channel. Each step's output is posted as messages in the thread, attributed to the agent handling that step. The DiscordStreamer provides rich output with:

- **Task cards** showing current step status (in progress, complete, error)
- **Tool call tracking** with argument summaries and results
- **Timing** for each step
- **Feedback buttons** (thumbs up/down) on completed responses

### Hot Reload

All Discord configuration changes made in the dashboard take effect immediately. The engine subscribes to a Redis event that fires whenever channel credentials are updated. When it detects a change for a Discord agent, it:

1. Stops the existing bot runtime (disconnects from the Gateway)
2. Fetches the latest credentials from the database
3. Starts a new runtime with the updated configuration

This means you can change the allowlist, bot token, guild restriction, or DM policy without restarting the engine or any containers.

### Auth and User Linking

When `AUTH_ENABLED=true` (multi-user mode), DjinnBot requires Discord users to link their Discord ID to a DjinnBot account. This enables per-user API key resolution and access control. Users who haven't linked their account will see instructions on how to do so.

When `AUTH_ENABLED=false` (the default for single-user setups), user linking is skipped entirely. Any user who passes the allowlist can chat with the bot directly.

## Customizing Bot Appearance

In each Discord application's settings:

1. Go to **General Information** and set the app name, description, and icon (agent avatar)
2. Under **Bot**, optionally set a custom username
3. DjinnBot agents also have avatars in `agents/<agent-id>/avatar.png` -- upload the same image to Discord for consistency

## Alternative: Environment Variable Configuration

Instead of using the dashboard, you can configure Discord via YAML files and environment variables. This is useful for infrastructure-as-code setups or when deploying to environments where the dashboard isn't accessible during initial setup.

Create `agents/<agent-id>/discord.yml`:

```yaml
bot_token: ${DISCORD_YUKIHIRO_BOT_TOKEN}
app_id: ${DISCORD_YUKIHIRO_APP_ID}
```

Then set the environment variables in `.env`:

```bash
DISCORD_YUKIHIRO_BOT_TOKEN=MTIzNDU2Nzg5...
DISCORD_YUKIHIRO_APP_ID=123456789012345678
```

The naming convention is `DISCORD_{AGENT_ID_UPPERCASE}_BOT_TOKEN`. On startup, the engine reads these files, resolves the environment variables, and syncs the values into the database. The dashboard will then show them (masked) and you can manage them from there going forward.

{{< callout type="info" >}}
Note that the YAML/env-var approach does not support the allowlist or DM policy fields. Those must be set via the dashboard or API after the initial token setup. The dashboard approach (Step 2 above) is recommended because it lets you configure everything in one place.
{{< /callout >}}

## Troubleshooting

### "Used disallowed intents" error on startup

```
[yukihiro] Discord login FAILED -- Used disallowed intents
```

Go to the [Discord Developer Portal](https://discord.com/developers/applications), select your app, go to **Bot**, and enable **Message Content Intent** and **Server Members Intent** under Privileged Gateway Intents. Save, then update the agent's Discord config in the dashboard (or restart the engine if using env vars).

### Bot connects but ignores all messages

```
[yukihiro] Discord message received -- from=user#0 (123456789) DM: "hello"
[yukihiro] Message BLOCKED -- allowlist is empty (no users permitted)
```

The allowlist is empty. Go to the agent's Discord channel config in the dashboard and set the Allowlist field to `*` (allow everyone) or a specific user/role list.

### "Your Discord ID isn't linked" error in chat

This happens when `AUTH_ENABLED=true` and the Discord user hasn't linked their account. Either:

- Have the user link their Discord ID in the DjinnBot dashboard under **Profile > Discord**
- Or set `AUTH_ENABLED=false` in your `.env` if you don't need multi-user auth

### Bot is online but no logs appear when messaging

If the engine logs show no message-received lines at all when you send a DM or mention:

1. Confirm the bot is actually connected: look for `Discord connected` in the logs
2. Check that you're messaging the right bot (not a different application)
3. Verify the bot has permission to view the channel you're posting in
4. For DMs, make sure the bot's Discord application has the "Direct Messages" option (this is enabled by default)

### Bot is online but doesn't post pipeline output

- Verify a default Discord channel is configured in the dashboard or via `DISCORD_CHANNEL_ID`
- Make sure the bot has permission to create threads and send messages in the target channel
- Check that the bot has access to the channel (can it see the channel in the server?)

### Changes in the dashboard don't take effect

The engine hot-reloads Discord configuration automatically when you save in the dashboard. If changes aren't taking effect:

1. Check the engine logs for `Credential change for <agent>/discord` -- if you don't see this, the Redis event may not be reaching the engine
2. Verify Redis is healthy: `docker compose ps redis`
3. As a last resort, restart the engine: `docker compose restart engine`

## Discord Resources

- [Discord Developer Portal](https://discord.com/developers/applications)
- [discord.js Documentation](https://discord.js.org/)
- [Gateway Intents](https://discord.com/developers/docs/events/gateway#gateway-intents)
- [Bot Permissions Calculator](https://discordapi.com/permissions.html)
