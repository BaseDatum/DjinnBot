---
title: Project Management
weight: 4
---

DjinnBot includes built-in project management with kanban boards, task decomposition, and GitHub integration. Agents can autonomously pick up and work on tasks during pulse cycles.

## Creating a Project

1. Go to **Projects** in the dashboard
2. Click **New Project**
3. Provide a name, description, and optionally a GitHub repository URL
4. The project board is created with default columns: Backlog, Ready, In Progress, Review, Done

## Planning Pipelines

DjinnBot offers two planning pipelines to decompose projects into tasks:

### Structured Planning (Default)

The multi-step structured pipeline uses structured output to produce task breakdowns:

1. Open your project
2. Click **Plan Project** (or start a planning pipeline run)
3. Describe the project scope
4. Eric (Product Owner) breaks it down into 5-20 tasks with priorities and dependencies
5. Finn (Architect) validates the breakdown, fixing dependencies and estimates
6. Eric decomposes into bite-sized subtasks (1-4 hours each)
7. Finn validates the subtasks

### Agentic Planning

The agentic planning pipeline (`planning-agentic`) uses a single agent with full tool access to incrementally create tasks via API calls. This approach:

- Eliminates output token limits (tasks created via tool calls, not JSON blobs)
- Enables perfect dependency resolution (real task IDs, not title matching)
- Survives large contexts (92k+ char project docs in a single context window)
- Provides incremental progress (tasks appear in the board as they're created)
- Uses the API's built-in cycle detection on each `add_dependency` call

The planner systematically works through four steps: create top-level tasks, wire dependencies, create subtasks, then wire subtask dependencies. It uses `create_task`, `create_subtask`, and `add_dependency` tools throughout.

Both pipelines produce tasks with:
- Priority labels (P0-P3)
- Dependency chains
- Hour estimates
- Tags (backend, frontend, devops, etc.)

## Workflow Policies

Workflow policies let you define per-project SDLC routing rules. For each task **work type** (e.g., `feature`, `bugfix`, `refactor`, `docs`), you configure which stages are required, optional, or skipped:

| Stage | Feature | Bugfix | Docs |
|-------|---------|--------|------|
| Spec | Required | Skip | Skip |
| Design | Required | Skip | Skip |
| Implement | Required | Required | Required |
| Test | Required | Required | Optional |
| Review | Required | Required | Required |
| Deploy | Optional | Required | Skip |

Agents use workflow policies to determine the correct kanban transitions for each task. Policies are managed via the dashboard (project settings) or the API:

```
GET  /v1/projects/{id}/workflow-policy
PUT  /v1/projects/{id}/workflow-policy
POST /v1/projects/{id}/tasks/{tid}/resolve-workflow
```

## Task Workflow

Tasks flow through the kanban board:

```
Backlog → Ready → In Progress → Review → Done
```

### Manual Workflow

Drag tasks between columns to manage work manually. Assign agents or yourself.

### Autonomous Workflow (Pulse Mode)

When pulse mode is enabled, agents automatically:

1. Check their assigned columns for ready tasks
2. Claim the highest-priority task
3. Create a feature branch
4. Implement the task
5. Open a pull request
6. Transition the task to Review

This happens on a configurable schedule (default: every 30 minutes). See [Pulse Mode](/docs/concepts/pulse) for details.

## GitHub Integration

When a project is linked to a GitHub repository:

- Tasks can be linked to GitHub issues
- Pull requests are automatically created when agents complete work
- Branch names follow the convention `feat/task_{id}-{slug}`
- Push access is configured via GitHub App or personal access token

### Setting Up GitHub Access

1. Add a GitHub token to your `.env`:
   ```bash
   GITHUB_TOKEN=ghp_your_personal_access_token
   ```

2. Or configure a GitHub App (for organization access):
   ```bash
   GITHUB_APP_ID=123456
   GITHUB_APP_CLIENT_ID=Iv1.abc123
   GITHUB_APP_WEBHOOK_SECRET=your-webhook-secret
   GITHUB_APP_PRIVATE_KEY_PATH=/data/secrets/github-app.pem
   ```

3. Restart the services:
   ```bash
   docker compose restart
   ```

## Task Dependencies

Tasks can depend on other tasks. The dependency resolver ensures:

- Tasks with unmet dependencies stay in Backlog
- When a dependency is completed, dependent tasks automatically move to Ready
- Circular dependencies are detected and flagged

Dependencies are set during project planning (via the planning pipeline) or manually through the dashboard.

## Code Knowledge Graph

Projects with a git workspace can be indexed into a Code Knowledge Graph. This gives agents structural understanding of the codebase — they can query functions, trace call chains, analyze impact of changes, and understand functional clusters.

See [Code Knowledge Graph](/docs/concepts/code-knowledge-graph) for full details on indexing, agent tools, and the dashboard visualization.
