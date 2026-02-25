# Create a Slack app for each agent.
# The slash command is /<agent-id> (the map key), which matches the handler
# registered by AgentSlackRuntime: app.command(`/${agentId}`).
#
# Subcommands:
#   /<agent-id> model execution <provider/model-id>  — switch execution model
#   /<agent-id> model                                — show current model
#   /<agent-id> config                               — show agent configuration
#   /<agent-id> thinking <level>                     — set thinking level
#   /<agent-id> help                                 — list available subcommands
data "slackapp_manifest" "agent" {
  for_each = local.agents

  display_information {
    name        = each.value.name
    description = "${each.value.description} - OpenClaw connector"
  }

  features {
    bot_user {
      display_name  = each.value.name
      always_online = false
    }

    app_home {
      messages_tab_enabled           = true
      messages_tab_read_only_enabled = false
    }

    slash_command {
      command       = "/${each.key}"
      description   = "Talk to or configure ${each.value.name}"
      usage_hint    = "model [execution <provider/model>] | config | thinking <level> | help"
      should_escape = false
    }
  }

  oauth_config {
    scopes {
      bot = [
        "chat:write",
        "channels:history",
        "channels:read",
        "groups:history",
        "groups:read",
        "groups:write",
        "im:history",
        "im:read",
        "im:write",
        "mpim:history",
        "mpim:read",
        "mpim:write",
        "users:read",
        "app_mentions:read",
        "reactions:read",
        "reactions:write",
        "pins:read",
        "pins:write",
        "emoji:read",
        "commands",
        "files:read",
        "files:write"
      ]
    }
  }

  settings {
    org_deploy_enabled     = false
    socket_mode_enabled    = true
    token_rotation_enabled = false

    event_subscriptions {
      bot_events = [
        "app_mention",
        "message.channels",
        "message.groups",
        "message.im",
        "message.mpim",
        "reaction_added",
        "reaction_removed",
        "member_joined_channel",
        "member_left_channel",
        "channel_rename",
        "pin_added",
        "pin_removed"
      ]
    }
  }
}

resource "slackapp_application" "agent" {
  for_each = local.agents
  manifest = data.slackapp_manifest.agent[each.key].json
}

# Output the app IDs and tokens for configuration
output "agent_apps" {
  value = {
    for k, v in slackapp_application.agent : k => {
      app_id  = v.id
      name    = local.agents[k].name
      command = "/${k}"
    }
  }
  description = "Created Slack apps for each agent"
}
