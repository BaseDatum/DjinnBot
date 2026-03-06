---
title: Dashboard Tour
weight: 3
---

The DjinnBot dashboard at **http://localhost:3000** gives you real-time visibility into everything your AI team is doing — from live agent output to cost analytics.

{{< callout type="info" >}}
If authentication is enabled, you'll see a **login page** when first visiting the dashboard. If no accounts exist yet, you'll be redirected to the **setup page** to create your admin account. See [Your First Run](/docs/getting-started/first-run#initial-account-setup) for details.
{{< /callout >}}

## Home

The home page shows:

- **System status** — Redis connection, active runs, agent count
- **Recent runs** — latest pipeline and swarm executions with status
- **Active sessions** — live agent containers currently running
- **Quick actions** — start a new run, open chat, view projects, launch a swarm

## Activity Feed

The activity page provides a **live SSE-streamed feed** of everything happening in the system:

- Agent wake/sleep events
- Task claims and transitions
- Pipeline step progress
- Tool call summaries
- Memory operations
- Quick stats (active sessions, tasks completed today, etc.)

The feed updates in real-time with no polling — events appear the instant they happen.

## Runs

The runs page lists all pipeline and swarm executions. Click any run to see:

- **Pipeline visualization** — step-by-step progress through the pipeline
- **Streaming output** — real-time text output from the active agent
- **Thinking blocks** — expandable reasoning sections (for models that support it)
- **Tool call groups** — grouped tool invocations with arguments and results
- **Step history** — completed steps with full output and timing
- **Key source badge** — shows which API key was used (system, user, or agent override)

### New Run Dialog

The new run dialog lets you:
- Select a pipeline or create a swarm
- Choose an agent and model
- Describe the task
- Link to a project
- Launch with one click

### Swarm Runs

Swarm runs have their own dedicated visualization:

- **DAG view** — interactive directed acyclic graph showing task dependencies and parallel execution
- **Status bar** — overall progress, active/completed/failed task counts
- **Timeline** — chronological view of task execution with durations
- **Task detail** — click any task to see its output, agent, model, and timing

## Chat

The chat interface lets you talk directly to any agent. Each chat session:

- Spawns an isolated container with the agent's full toolbox
- Loads the agent's persona and memories
- Supports multi-turn conversation with streaming responses
- Allows **file uploads** — drag and drop images, PDFs, or documents
- Supports **image attachments** sent as vision inputs to multimodal models
- Extracts text from uploaded PDFs automatically
- Shows **key source badges** indicating which API key is being used
- Supports **inline HTML previews** for agents that generate HTML output
- Groups related tool calls for cleaner display

Choose an agent and model from the header, then start typing. The floating chat widget provides quick access from any page.

## Agents

The agents page shows all configured agents with:

- **Status** — current activity (idle, in pipeline, in chat, pulsing)
- **Configuration** — model, thinking level, pulse settings, coordination limits
- **Pulse routines** — view and manage named routines with independent schedules
- **Built-in tools** — enable/disable specific tools per agent
- **Coordination** — wake guardrails, concurrent session limits, messaging
- **Recent runs** — pipeline steps and pulse sessions this agent has executed
- **Memory** — browse and search the agent's vault

Click an agent to edit their configuration — change models, enable pulse routines, adjust coordination settings, or modify tool access.

## Projects

The projects page provides kanban-style project management:

- **Board view** — drag tasks between columns (Backlog, Ready, In Progress, Review, Done)
- **Task details** — description, acceptance criteria, assigned agent, linked PRs, review fields, work type classification
- **Project vision** — high-level project description and goals
- **Planning pipeline** — run the planning pipeline to auto-decompose projects into tasks (structured or agentic)
- **Workflow policies** — per-project SDLC stage routing rules that define which stages are required/optional/skip per task work type
- **Code tab** — interactive Sigma.js visualization of the project's [Code Knowledge Graph](/docs/concepts/code-knowledge-graph) with community clustering, node details, and index management
- **Pulse integration** — agents autonomously pick up and work on Ready tasks during pulse cycles
- **User provider settings** — per-user API key configuration for cost control

## Pipelines

Browse available pipeline definitions. View the YAML, see the step graph, and start new runs.

## Skills

Manage agent skills — reusable instruction sets that agents can load on demand:

- **Global skills** — available to all agents (stored in `agents/_skills/`)
- **Agent-specific skills** — scoped to individual agents
- **Skill packages** — skills with reference files and HTML templates (e.g., visual-explainer)
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
- **2D graph view** — interactive graph showing wiki-link connections
- **3D graph view** — immersive WebGL visualization with Three.js — rotate, zoom, and explore memory clusters

## Usage

The personal usage page shows per-user LLM API consumption:

- **Token breakdown** — input, output, and cache tokens per provider
- **Cost tracking** — estimated costs per model and provider
- **Session history** — which sessions consumed the most resources
- **Key resolution** — whether system or personal API keys were used

## Admin Panel

{{< callout type="info" >}}
The admin panel is available to admin users when authentication is enabled.
{{< /callout >}}

The admin panel provides full operational control:

- **API Usage** — per-provider API call analytics with key source tracking (system vs. user keys)
- **LLM Call Log** — searchable log of every LLM API call with model, tokens, latency, cost, and approximate USD cost per call
- **Container Logs** — real-time streaming logs from all Docker containers
- **Notifications** — system notifications and alerts
- **User Management** — create, edit, and manage user accounts
- **System Health** — service status, active containers, and resource usage

## Browser Cookies

Manage browser cookies for authenticated agent browsing via Camoufox:

- **Upload cookies** — upload Netscape-format cookie files (exported from your browser or the Cookie Bridge extension)
- **Cookie sets** — view, rename, and delete uploaded cookie sets
- **Agent grants** — grant or revoke cookie access per agent, controlling which agents can browse with your credentials
- **Cookie Bridge extension** — install the Chrome/Firefox extension to export cookies directly from your browser to DjinnBot

See [Bot Interfaces](/docs/advanced/bot-interfaces#cookie-bridge-browser-extension) for extension installation details.

## Settings

Configure global and personal settings:

- **LLM providers** — add API keys for Anthropic, OpenAI, OpenRouter, and other providers
- **Default models** — set the default working model, thinking model, and Slack decision model
- **Pulse settings** — enable/disable autonomous pulse mode, set intervals
- **Memory scoring** — configure how memory relevance is calculated
- **Secrets** — manage encrypted secrets (GitHub tokens, SSH keys, etc.)
- **User provider keys** — configure personal API keys that override system keys
- **Browser cookies** — manage cookie sets and agent grants (also accessible from the dedicated Browser Cookies page)
- **Two-Factor Authentication** — enable/disable TOTP 2FA, view recovery codes
- **API Keys** — generate and manage API keys for CLI and programmatic access
- **OIDC Providers** — configure external identity providers for single sign-on
