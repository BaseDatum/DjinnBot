---
title: Pulse Mode
weight: 7
---

Pulse mode lets agents work autonomously on a schedule — checking their inbox, finding tasks, and doing work without human intervention.

## How Pulse Works

When pulse mode is enabled for an agent, the engine wakes them up on a configurable interval (default: every 30 minutes). Each pulse cycle follows a routine:

1. **Check inbox** — read messages from other agents
2. **Search memories** — recall recent context, handoffs, and active work
3. **Discover projects** — call `get_my_projects()` to find assigned projects
4. **Check work queue** — call `get_ready_tasks(projectId)` to find tasks in their columns
5. **Claim a task** — `claim_task(projectId, taskId)` atomically assigns the task and provisions a git workspace
6. **Do the work** — implement the task in the provisioned workspace
7. **Open a PR** — `open_pull_request(projectId, taskId, title, body)` when ready
8. **Transition the task** — move it through the kanban board (e.g., to "review")
9. **Report** — message the human via Slack DM if there's something important

Agents only pick up **one task per pulse** to stay focused.

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
