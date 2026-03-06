---
title: Agents
weight: 2
---

Agents are the core of DjinnBot. Each agent is a specialized AI persona with its own identity, expertise, memory, and tools. They're not generic LLM wrappers — they're characters with opinions, domain knowledge, and the ability to coordinate with each other autonomously.

## Agent Files

Every agent is defined by a directory under `agents/`:

{{< filetree/container >}}
  {{< filetree/folder name="agents/eric" >}}
    {{< filetree/file name="IDENTITY.md" >}}
    {{< filetree/file name="SOUL.md" >}}
    {{< filetree/file name="AGENTS.md" >}}
    {{< filetree/file name="DECISION.md" >}}
    {{< filetree/file name="config.yml" >}}
    {{< filetree/file name="slack.yml" >}}
    {{< filetree/file name="discord.yml" >}}
    {{< filetree/file name="telegram.yml" >}}
  {{< /filetree/folder >}}
{{< /filetree/container >}}

### IDENTITY.md

The basics — name, origin country, role title, emoji, and which pipeline stage(s) this agent handles.

```markdown
# Eric — Product Owner

- **Name:** Eric
- **Origin:** Denmark
- **Role:** Product Owner
- **Abbreviation:** PO
- **Emoji:** 📋
- **Pipeline Stage:** SPEC
```

### SOUL.md

The personality file. This is what makes agents feel real — and what separates DjinnBot from tools that wrap an LLM in a system prompt and call it an "agent." It includes:

- **Who they are** — backstory, experience, what shaped their approach
- **Core beliefs** — principles forged through experience (e.g., "vague specs produce vague results")
- **Anti-patterns** — things they refuse to do, with reasoning
- **Productive flaws** — intentional trade-offs (e.g., Eric is ruthlessly aggressive about cutting scope)
- **How they work** — their process for their domain
- **Collaboration style** — how they interact with other agents
- **Key phrases** — characteristic things they say

The SOUL file is typically 100-200 lines of rich, specific character definition. This is injected into the agent's system prompt, and it produces dramatically different behavior from generic instructions.

### AGENTS.md

The workflow file. This tells the agent exactly how to do their job:

- **Session startup** — what to do every time they wake up (read SOUL, search memories)
- **Step-by-step procedures** — detailed workflows for their role
- **Collaboration triggers** — when to loop in other agents
- **Tool usage** — how to use memory, research, messaging, and domain tools
- **Templates** — output formats and document structures

### DECISION.md

A memory-first decision framework shared across agents:

1. Search memories before every response
2. Create memories when learning something new
3. Reflect on interactions for self-improvement
4. Stay in character and add value

### config.yml

Runtime configuration for the agent:

```yaml
model: xai/grok-4-1-fast-reasoning
thinking_model: xai/grok-4-1-fast-reasoning
thinking_level: 'off'
thread_mode: passive
pulse_enabled: false
pulse_interval_minutes: 30
pulse_columns:
  - Backlog
  - Ready
pulse_container_timeout_ms: 120000
pulse_blackouts:
  - label: Nighttime
    start_time: '23:00'
    end_time: '07:00'
    type: recurring

# Agent coordination (controls multi-agent interaction)
coordination:
  max_concurrent_pulse_sessions: 2
  wake_guardrails:
    cooldown_seconds: 300
    max_daily_session_minutes: 120
    max_wakes_per_day: 12
    max_wakes_per_pair_per_day: 5

# Model overrides for plan+execute delegation
planning_model: openrouter/anthropic/claude-sonnet-4
executor_model: openrouter/x-ai/grok-4.1-fast
```

All configuration can be edited through the dashboard Settings page — no YAML editing required.

### Channel YAML Files

Each messaging platform has its own credentials file. Create only the ones for the platforms you use:

**slack.yml** — Slack bot credentials (see [Slack Setup](/docs/guides/slack-setup)):

```yaml
bot_token: ${SLACK_ERIC_BOT_TOKEN}
app_token: ${SLACK_ERIC_APP_TOKEN}
```

**discord.yml** — Discord bot credentials (see [Discord Setup](/docs/guides/discord-setup)):

```yaml
bot_token: ${DISCORD_ERIC_BOT_TOKEN}
```

**telegram.yml** — Telegram bot credentials (see [Telegram Setup](/docs/guides/telegram-setup)):

```yaml
bot_token: ${TELEGRAM_ERIC_BOT_TOKEN}
```

Signal and WhatsApp use a shared account model (one number for all agents) and are configured via the dashboard — no per-agent YAML files needed.

## The Default Team

DjinnBot ships with 11 agents covering a full product organization:

### Engineering Pipeline Agents

| Agent | Role | Pipeline Stages | Expertise |
|-------|------|----------------|-----------|
| **Eric** | Product Owner | SPEC | Requirements, user stories, scope, prioritization |
| **Finn** | Solutions Architect | DESIGN, REVIEW | Architecture, tech decisions, code review |
| **Shigeo** | UX Specialist | UX | User flows, design systems, accessibility |
| **Yukihiro** | Senior SWE | IMPLEMENT, FIX | Writing code, debugging, implementation |
| **Chieko** | Test Engineer | TEST | QA, test strategy, regression detection |
| **Stas** | SRE | DEPLOY | Infrastructure, deployment, monitoring |
| **Yang** | DevEx Specialist | DX (on-demand) | CI/CD, tooling, developer workflow |

### Operations & Business Agents

| Agent | Role | Expertise |
|-------|------|-----------|
| **Grace** | Executive Assistant | Meeting transcripts, commitment tracking, relationship management, proactive follow-ups |
| **Holt** | Marketing & Sales | Sales strategy, outreach, deal management |
| **Luke** | SEO Specialist | Content strategy, keyword research, technical SEO |
| **Jim** | Finance Lead | Budget, pricing, runway, financial modeling |

### Grace — The Executive Assistant

Grace is a different kind of agent. She doesn't write code or run pipelines — she manages organizational memory. When you feed her a meeting transcript (via the `/v1/ingest` endpoint or chat), she:

1. **Extracts every actionable detail** — people, decisions, commitments, action items, relationships, facts
2. **Stores them as linked memories** — each piece of information becomes a searchable, graph-connected memory entry
3. **Tracks commitments to closure** — on pulse cycles, she checks for overdue items and follows up via Slack DM
4. **Surfaces context proactively** — before your next meeting with someone, she can recall everything relevant from past interactions

Grace's memories are shared (`shared: true`), so the entire agent team benefits from the organizational context she builds.

## Agent Coordination

When multiple agents work autonomously, they need coordination to avoid conflicts and communicate effectively. DjinnBot provides:

### Work Ledger

A structured task coordination system where agents can:
- See what other agents are working on
- Avoid claiming the same tasks
- Hand off work between roles (e.g., "implementation done, ready for review")

### Two-Tier Messaging

Agents communicate through two channels:

1. **Inbox messages** — direct agent-to-agent messages with priority levels (`normal`, `high`, `urgent`) and types (`info`, `help_request`, `review_request`, `unblock`, `handoff`)
2. **Slack DMs** — messages to the human, used sparingly for urgent findings or blockers

### Wake Guardrails

Configurable limits prevent agents from running away with resources:

```yaml
coordination:
  max_concurrent_pulse_sessions: 2    # Max simultaneous containers
  wake_guardrails:
    cooldown_seconds: 300              # Minimum time between wakes
    max_daily_session_minutes: 120     # Daily runtime cap
    max_wakes_per_day: 12              # Daily wake limit
    max_wakes_per_pair_per_day: 5      # Prevent infinite agent loops
```

These guardrails ensure agents collaborate effectively without exhausting compute resources or getting stuck in infinite message loops.

## Agent Templates

Shared templates in `agents/_templates/` provide common workflow and memory instructions that all agents inherit:

- **AGENTS.md** — environment description, git workflow, memory tools, communication tools
- **DECISION.md** — memory-first decision framework
- **MEMORY_TOOLS.md** — detailed memory tool reference with examples

When creating a new agent, these templates provide the baseline behavior. Agent-specific files add role-specific expertise on top.

## Built-In Tool Control

Admins can control which built-in tools each agent has access to via the dashboard. This allows you to:

- Disable `bash` for agents that shouldn't run shell commands
- Restrict file operations for read-only analysis agents
- Customize the toolbox per agent without modifying code

Tool overrides are stored in the database and take effect immediately — no restart needed.

## Creating Custom Agents

{{% steps %}}

### Create the agent directory

```bash
mkdir agents/nova
```

### Add IDENTITY.md, SOUL.md, and config.yml

At minimum, define who the agent is, their personality, and their runtime configuration. See the [Custom Agents guide](/docs/guides/custom-agents) for detailed examples.

### Copy shared templates

```bash
cp agents/_templates/AGENTS.md agents/nova/AGENTS.md
cp agents/_templates/DECISION.md agents/nova/DECISION.md
```

### Customize and restart

Edit the workflow files with role-specific procedures, then restart the engine:

```bash
docker compose restart engine
```

{{% /steps %}}

The agent will immediately be available in the dashboard for chat sessions, pulse mode, and pipeline references.

## How Agents Execute

When an agent is assigned a pipeline step, chat message, or pulse cycle:

1. The engine spawns a Docker container from `Dockerfile.agent-runtime`
2. The container loads the agent's persona files (IDENTITY + SOUL + AGENTS + DECISION)
3. ClawVault memories are loaded and injected as context
4. Skills matching the task keywords are auto-injected
5. The agent receives the step input (with template variables resolved)
6. The agent works — calling tools, writing files, running commands
7. Output streams back to the engine via Redis pub/sub
8. Memories are saved on session end
9. The container is destroyed

Each execution is stateless at the container level — all persistence comes from the database, memory vaults, and git workspaces.
