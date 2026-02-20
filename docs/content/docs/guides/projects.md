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

## Planning Pipeline

Use the planning pipeline to automatically decompose a project into tasks:

1. Open your project
2. Click **Plan Project** (or start a planning pipeline run)
3. Describe the project scope
4. Eric (Product Owner) breaks it down into 5-20 tasks with priorities and dependencies
5. Finn (Architect) validates the breakdown, fixing dependencies and estimates
6. Eric decomposes into bite-sized subtasks (1-4 hours each)
7. Finn validates the subtasks

Tasks are automatically imported into the project board with:
- Priority labels (P0-P3)
- Dependency chains
- Hour estimates
- Tags (backend, frontend, devops, etc.)

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
