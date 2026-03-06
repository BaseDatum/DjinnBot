---
title: Your First Run
weight: 2
---

Now that DjinnBot is running, let's complete initial setup and get agents working.

## Initial Account Setup

If you enabled authentication (`AUTH_ENABLED=true`), the first time you open the dashboard you'll be redirected to the **setup page**:

{{% steps %}}

### Create your admin account

Enter email, display name, and password (minimum 8 characters).

### Enable 2FA (recommended)

The setup wizard prompts you to set up TOTP two-factor authentication. Scan the QR code with your authenticator app.

### Save recovery codes

If you enabled 2FA, store these somewhere safe. They're your backup if you lose your authenticator.

{{% /steps %}}

After completing setup, you're logged in and ready to go. Additional users can be created through the admin panel or API.

If authentication is disabled, you skip this step and go straight to the dashboard.

## The Three Workflows

DjinnBot has three complementary ways of getting work done:

| Workflow | Best For | How It Works |
|----------|---------|-------------|
| **Projects + Board + Pulse** | Ongoing development | Agents autonomously pick up, work on, and advance tasks on a schedule |
| **Pipelines** | Structured one-off workflows | Multi-step SDLC — planning, engineering, feature, bugfix |
| **Swarm Execution** | Maximum throughput | Parallel multi-agent processing on DAG-aware task graphs |

Most of the time you'll use projects. Pipelines power planning, structured output, and predefined workflows. Swarms are for when you want to throw multiple agents at a decomposed task set simultaneously.

## Create a Project

{{% steps %}}

### Open the dashboard

Navigate to **http://localhost:3000** and go to **Projects**.

### Start a new project

Click **New Project**. The guided onboarding walks you through describing your project — what you're building, the tech stack, constraints, and goals.

### Link a GitHub repository (optional)

Connect a repo for automated branch creation, PR management, and code integration.

{{% /steps %}}

## Plan the Project

Once your project exists, decompose it into tasks:

1. Open your project and click **Plan Project**
2. This runs the **two-stage planning pipeline**:
   - **Stage 1:** Eric (Product Owner) breaks the project into high-level tasks with priorities and dependencies. Finn (Architect) validates the breakdown.
   - **Stage 2:** Eric decomposes into bite-sized subtasks (1-4 hours each). Finn validates the subtasks.
3. Tasks are automatically imported onto the kanban board with priority labels (P0-P3), dependency chains, hour estimates, and tags

The board starts with columns: **Backlog**, **Ready**, **In Progress**, **Review**, **Done**.

## Assign Agents and Enable Pulse

Each agent is configured to watch specific board columns matching their role:

- **Yukihiro** (SWE) watches **Ready** — picks up implementation tasks
- **Finn** (Architect) watches **Review** — reviews implementations
- **Chieko** (QA) watches **Review** — tests implementations
- **Stas** (SRE) watches deployment-related tasks

Enable pulse mode for your agents via the dashboard (Agents page) or in each agent's `config.yml`:

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

## Run a Swarm

For maximum throughput on a set of independent tasks:

1. Click **New Run** in the dashboard
2. Select **Swarm** mode
3. Describe the overall objective
4. The planning agent decomposes it into a task DAG
5. The swarm executor runs multiple agents in parallel, respecting dependency chains
6. Watch progress in the real-time DAG visualization

## Watch It Happen

The dashboard shows everything in real-time:

- **Activity feed** — live SSE-streamed events as they happen
- **Board view** — tasks moving across columns as agents work
- **Streaming output** — live agent output as they think and work
- **Thinking blocks** — expandable reasoning sections
- **Tool calls** — every file read, write, bash command, and git operation
- **Swarm DAG** — parallel execution visualization with dependency edges
- **Messaging threads** — if configured, watch agents discuss in Slack, Discord, or other connected platforms

## Chat With Agents

Talk to any agent directly without going through a project:

1. Go to the **Chat** page in the dashboard (or use the floating chat widget)
2. Select an agent (e.g., Finn for architecture advice, Grace for meeting transcript processing)
3. Start a conversation — upload files, paste images, or just type

Chat sessions use the same isolated containers and full toolbox.

## CLI Access

If you want to interact from the terminal:

```bash
pip install djinn-bot-cli

djinn login           # If auth is enabled
djinn chat            # Interactive agent + model selection
djinn status          # Server health
djinn provider list   # See configured providers
```

## Next Steps

{{< cards >}}
  {{< card link="../dashboard-tour" title="Dashboard Tour" subtitle="Learn to navigate the full dashboard interface." >}}
  {{< card link="/docs/concepts/pulse" title="Pulse Mode" subtitle="How agents work autonomously on a schedule." >}}
  {{< card link="/docs/advanced/security" title="Security Model" subtitle="Authentication, 2FA, API keys, and SSL setup." >}}
  {{< card link="/docs/guides/slack-setup" title="Connect Messaging" subtitle="Set up Slack, Discord, Telegram, Signal, or WhatsApp." >}}
{{< /cards >}}
