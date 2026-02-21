---
title: Your First Run
weight: 2
---

Now that DjinnBot is running, let's set up a project and watch agents work.

## The Two Workflows

DjinnBot has two complementary ways of getting work done:

1. **Projects + Board + Pulse** (primary) — agents are assigned to kanban columns and autonomously pick up, work on, and advance tasks on a schedule
2. **Pipelines** (supporting) — structured multi-step workflows for specific operations like project planning, onboarding, or running a full SDLC pass on a single task

Most of the time you'll use projects. Pipelines are the machinery that powers planning, structured output, and predefined workflows.

## Create a Project

1. Open **http://localhost:3000**
2. Go to **Projects** and click **New Project**
3. The guided onboarding walks you through describing your project — what you're building, the tech stack, constraints, and goals
4. Optionally link a GitHub repository

## Plan the Project

Once your project exists, decompose it into tasks:

1. Open your project and click **Plan Project**
2. This runs the **planning pipeline** — Eric (Product Owner) breaks the project into tasks with priorities and dependencies, Finn (Architect) validates the breakdown
3. Tasks are automatically imported onto the kanban board with priority labels (P0-P3), dependency chains, hour estimates, and tags

The board starts with columns: **Backlog**, **Ready**, **In Progress**, **Review**, **Done**.

## Assign Agents and Enable Pulse

Each agent is configured to watch specific board columns matching their role:

- **Yukihiro** (SWE) watches **Ready** — picks up implementation tasks
- **Finn** (Architect) watches **Review** — reviews implementations
- **Chieko** (QA) watches **Review** — tests implementations
- **Stas** (SRE) watches deployment-related tasks

Enable pulse mode for your agents via the dashboard (Settings > Agents) or in each agent's `config.yml`:

```yaml
pulse_enabled: true
pulse_interval_minutes: 30
pulse_columns:
  - Ready
```

When pulse fires, agents autonomously:
1. Check the board for tasks in their columns
2. Claim the highest-priority task
3. Create a feature branch and spin up an isolated container
4. Do the work — write code, run tests, use tools
5. Open a pull request
6. Move the task to the next column

## Watch It Happen

The dashboard shows everything in real-time:

- **Board view** — tasks moving across columns as agents work
- **Streaming output** — live agent output as they think and work
- **Thinking blocks** — expandable reasoning sections
- **Tool calls** — every file read, write, bash command, and git operation
- **Slack threads** — if configured, watch agents discuss in your workspace

## Chat With Agents

Talk to any agent directly without going through a project:

1. Go to the **Chat** page in the dashboard
2. Select an agent (e.g., Finn for architecture advice)
3. Start a conversation

Chat sessions use the same isolated containers and full toolbox.

## Run a Pipeline Directly

For one-off structured workflows, you can also run pipelines directly:

1. Click **New Run** in the dashboard
2. Select a pipeline (e.g., `engineering`, `feature`, `bugfix`)
3. Describe the task
4. Watch agents execute the predefined steps

| Pipeline | Best For |
|----------|---------|
| `planning` | Decomposing a project into board tasks |
| `engineering` | Full SDLC for a single task (spec → design → implement → review → test → deploy) |
| `feature` | Adding a feature to existing code |
| `bugfix` | Diagnosing and fixing a specific bug |

## Next Steps

{{< cards >}}
  {{< card link="../dashboard-tour" title="Dashboard Tour" subtitle="Learn to navigate the full dashboard interface." >}}
  {{< card link="/docs/concepts/pulse" title="Pulse Mode" subtitle="How agents work autonomously on a schedule." >}}
  {{< card link="/docs/guides/slack-setup" title="Set Up Slack" subtitle="Give each agent its own Slack bot." >}}
{{< /cards >}}
