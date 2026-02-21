---
title: Dashboard Tour
weight: 3
---

The DjinnBot dashboard at **http://localhost:3000** gives you real-time visibility into everything your AI team is doing.

{{< callout type="info" >}}
If authentication is enabled, you'll see a **login page** when first visiting the dashboard. If no accounts exist yet, you'll be redirected to the **setup page** to create your admin account. See [Your First Run](/docs/getting-started/first-run#initial-account-setup) for details.
{{< /callout >}}

## Home

The home page shows:

- **System status** — Redis connection, active runs, agent count
- **Recent runs** — latest pipeline executions with status
- **Active sessions** — live agent containers currently running
- **Quick actions** — start a new run, open chat, view projects

## Runs

The runs page lists all pipeline executions. Click any run to see:

- **Pipeline visualization** — step-by-step progress through the pipeline
- **Streaming output** — real-time text output from the active agent
- **Thinking blocks** — expandable reasoning sections (for models that support it)
- **Tool calls** — every tool invocation with arguments and results
- **Step history** — completed steps with full output and timing

## Chat

The chat interface lets you talk directly to any agent. Each chat session:

- Spawns an isolated container with the agent's full toolbox
- Loads the agent's persona and memories
- Supports multi-turn conversation
- Allows code execution, file operations, and web research

Choose an agent and model from the header, then start typing.

## Agents

The agents page shows all configured agents with:

- **Status** — current activity (idle, in pipeline, in chat)
- **Configuration** — model, thinking level, pulse settings
- **Recent runs** — pipeline steps this agent has executed
- **Memory** — browse and search the agent's vault

Click an agent to edit their configuration — change their default model, enable/disable pulse mode, adjust thinking settings.

## Projects

The projects page provides kanban-style project management:

- **Board view** — drag tasks between columns (Backlog, Ready, In Progress, Review, Done)
- **Task details** — description, acceptance criteria, assigned agent, linked PRs
- **Planning pipeline** — run the planning pipeline to auto-decompose projects into tasks
- **Pulse integration** — agents autonomously pick up and work on Ready tasks during pulse cycles

## Pipelines

Browse available pipeline definitions. View the YAML, see the step graph, and start new runs.

## Skills

Manage agent skills — reusable instruction sets that agents can load on demand:

- **Global skills** — available to all agents (stored in `agents/_skills/`)
- **Agent-specific skills** — scoped to individual agents
- **Enable/disable** — toggle skills without deleting them
- **Skill generator** — AI-assisted skill creation via chat

## MCP Tools

Configure MCP tool servers that agents can use:

- **Server list** — view all configured tool servers with status
- **Health monitoring** — live status (running, error, configuring)
- **Tool discovery** — see which tools each server provides
- **Add servers** — configure new MCP servers through the UI
- **Hot reload** — changes take effect immediately, no restart needed

## Memory

Browse and search agent memory vaults:

- **Personal vaults** — each agent's private memories
- **Shared vault** — team-wide knowledge
- **Semantic search** — find memories by meaning, not just keywords

## Settings

Configure global settings:

- **LLM providers** — add API keys for Anthropic, OpenAI, OpenRouter, and other providers
- **Default models** — set the default working model, thinking model, and Slack decision model
- **Pulse settings** — enable/disable autonomous pulse mode, set intervals
- **Secrets** — manage encrypted secrets (GitHub tokens, SSH keys, etc.)
- **Two-Factor Authentication** — enable/disable TOTP 2FA for your account, view recovery codes
- **API Keys** — generate and manage API keys for CLI and programmatic access
- **OIDC Providers** — configure external identity providers for single sign-on (Google, Azure AD, Okta, etc.)
- **Authentication** — view auth status and configuration
