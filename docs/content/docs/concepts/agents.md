---
title: Agents
weight: 2
---

Agents are the core of DjinnBot. Each agent is a specialized AI persona with its own identity, expertise, memory, and tools. They're not generic LLM wrappers — they're characters with opinions and domain knowledge.

## Agent Files

Every agent is defined by a directory under `agents/`:

```
agents/eric/
├── IDENTITY.md      # Name, origin, role, emoji
├── SOUL.md          # Deep personality, beliefs, anti-patterns, voice
├── AGENTS.md        # Workflow procedures, collaboration triggers, tool usage
├── DECISION.md      # Memory-first decision framework
├── PULSE.md         # Autonomous wake-up routine
├── config.yml       # Model, pulse schedule, thinking settings
└── slack.yml        # Slack bot credentials (optional)
```

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

The personality file. This is what makes agents feel real. It includes:

- **Who they are** — backstory, experience, what shaped their approach
- **Core beliefs** — principles forged through experience (e.g., "vague specs produce vague results")
- **Anti-patterns** — things they refuse to do, with reasoning
- **Productive flaws** — intentional trade-offs (e.g., Eric is ruthlessly aggressive about cutting scope)
- **How they work** — their process for their domain
- **Collaboration style** — how they interact with other agents
- **Key phrases** — characteristic things they say

The SOUL file is typically 100-200 lines of rich, specific character definition. This is injected into the agent's system prompt.

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

### PULSE.md

The autonomous wake-up routine for pulse mode. See [Pulse Mode](/docs/concepts/pulse) for details.

### config.yml

Runtime configuration for the agent:

```yaml
model: xai/grok-4-1-fast-reasoning        # Default LLM model
thinking_model: xai/grok-4-1-fast-reasoning  # Model for thinking/reasoning
thinking_level: 'off'                        # off, low, medium, high
thread_mode: passive                         # passive or active Slack mode
pulse_enabled: false                         # Autonomous pulse mode
pulse_interval_minutes: 30                   # How often to wake up
pulse_columns:                               # Which kanban columns to check
  - Backlog
  - Ready
pulse_container_timeout_ms: 120000           # Max container runtime
pulse_blackouts:                             # Don't pulse during these times
  - label: Nighttime
    start_time: '23:00'
    end_time: '07:00'
    type: recurring
```

All configuration can be edited through the dashboard Settings page.

### slack.yml

Slack bot credentials for this agent (see [Slack Setup](/docs/guides/slack-setup)):

```yaml
bot_token: ${SLACK_ERIC_BOT_TOKEN}
app_token: ${SLACK_ERIC_APP_TOKEN}
```

## The Default Team

DjinnBot ships with 10 agents covering a full product organization:

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

### Business Agents

| Agent | Role | Expertise |
|-------|------|-----------|
| **Holt** | Marketing & Sales | Sales strategy, outreach, deal management |
| **Luke** | SEO Specialist | Content strategy, keyword research, technical SEO |
| **Jim** | Finance Lead | Budget, pricing, runway, financial modeling |

Business agents currently work in chat and pulse modes. Structured marketing/sales pipeline support is on the roadmap.

## Agent Templates

Shared templates in `agents/_templates/` provide common workflow and memory instructions that all agents inherit:

- **AGENTS.md** — environment description, git workflow, memory tools, communication tools
- **DECISION.md** — memory-first decision framework
- **PULSE.md** — autonomous wake-up routine with project tools
- **MEMORY_TOOLS.md** — detailed memory tool reference with examples

When creating a new agent, these templates provide the baseline behavior. Agent-specific files add role-specific expertise on top.

## Creating Custom Agents

To create a new agent:

1. Create a directory under `agents/` with the agent's ID
2. Add at minimum `IDENTITY.md`, `SOUL.md`, and `config.yml`
3. Copy `AGENTS.md`, `DECISION.md`, and `PULSE.md` from `agents/_templates/` and customize
4. Restart the engine to pick up the new agent

The agent will immediately be available in the dashboard for chat sessions and can be referenced in pipeline YAML files.

## How Agents Execute

When an agent is assigned a pipeline step or chat message:

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
