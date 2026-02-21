---
title: Pulse Mode
weight: 7
---

Pulse mode lets agents work autonomously on a schedule — checking their inbox, finding tasks, and doing work without human intervention.

## How Pulse Works

When pulse mode is enabled for an agent, the engine wakes them up on a configurable interval (default: every 30 minutes). Each pulse cycle is driven by the agent's **PULSE.md** file — a fully customizable markdown file that defines the agent's wake-up routine.

The default template (`agents/_templates/PULSE.md`) provides a general-purpose routine, but each agent can override it with their own `PULSE.md` to define entirely different behavior. The file is injected as part of the agent's system prompt during pulse sessions, so whatever instructions you write become the agent's autonomous behavior.

### Default Pulse Routine

The default template covers:

1. **Check inbox** — read messages from other agents
2. **Search memories** — recall recent context, handoffs, and active work
3. **Discover projects** — call `get_my_projects()` to find assigned projects
4. **Check work queue** — call `get_ready_tasks(projectId)` to find tasks in their columns
5. **Claim a task** — `claim_task(projectId, taskId)` atomically assigns the task and provisions a git workspace
6. **Do the work** — implement the task in the provisioned workspace
7. **Open a PR** — `open_pull_request(projectId, taskId, title, body)` when ready
8. **Transition the task** — move it through the kanban board (e.g., to "review")
9. **Report** — message the human via Slack DM if there's something important

But you can rewrite `PULSE.md` to do anything — check monitoring dashboards, run reports, review PRs, triage issues, or follow any custom workflow you define.

### Customizing Pulse Behavior

Edit `agents/<id>/PULSE.md` to change what an agent does when it wakes up. For example, a QA agent might:

```markdown
# Pulse Routine

### 1. Check for open PRs that need review
Search for PRs assigned to you or your team.

### 2. Run regression tests
Execute the test suite and report any failures.

### 3. Review recently merged code
Check for untested code paths in recent merges.
```

The engine doesn't hard-code the routine — it's entirely defined by the markdown file you provide.

## Configuration

Pulse is configured per-agent in `config.yml`:

```yaml
pulse_enabled: true
pulse_interval_minutes: 30
pulse_columns:              # Which kanban columns this agent checks
  - Backlog
  - Ready
pulse_container_timeout_ms: 120000
pulse_max_consecutive_skips: 5
pulse_offset_minutes: 3     # Stagger to avoid all agents waking simultaneously
pulse_blackouts:
  - label: Nighttime
    start_time: '23:00'
    end_time: '07:00'
    type: recurring
pulse_transitions_to:       # Allowed kanban transitions
  - planning
  - ready
  - in_progress
```

All settings can be edited through the dashboard agent configuration page.

## Project Tools

During pulse sessions, agents have access to project management tools:

| Tool | Purpose |
|------|---------|
| `get_my_projects()` | List assigned projects |
| `get_ready_tasks(projectId)` | Find tasks in your columns |
| `claim_task(projectId, taskId)` | Claim a task + provision git workspace |
| `get_task_context(projectId, taskId)` | Full task details and acceptance criteria |
| `open_pull_request(projectId, taskId, title, body)` | Open a GitHub PR |
| `transition_task(projectId, taskId, status)` | Move task through kanban |
| `execute_task(projectId, taskId)` | Kick off a pipeline run for the task |

## Git Workflow

When an agent claims a task, the system:

1. Creates a feature branch: `feat/task_abc123-implement-oauth`
2. Provisions a git workspace at `/home/agent/task-workspaces/{taskId}/`
3. Configures git credentials for push access

The agent works in this workspace, commits, pushes, and opens a PR — all within the isolated container.

## Blackout Windows

You can prevent agents from pulsing during certain times:

```yaml
pulse_blackouts:
  - label: Nighttime
    start_time: '23:00'
    end_time: '07:00'
    type: recurring
  - label: Weekend
    start_time: '2026-03-01T00:00:00'
    end_time: '2026-03-03T00:00:00'
    type: one_off
```

## Communication

Agents can communicate during pulse sessions:

- **`message_agent(agentId, message)`** — send a message to another agent's inbox
- **`slack_dm(message)`** — message the human via Slack DM (use sparingly — only for urgent findings or blockers)
