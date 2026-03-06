---
title: GitHub Integration
weight: 5
---

DjinnBot integrates with GitHub for repository management, pull requests, and webhook-triggered automation.

## MCP GitHub Tools

The default MCP configuration includes a GitHub tool server that gives agents read access to repositories, issues, and context:

```json
{
  "github": {
    "command": "/usr/local/bin/github-mcp-server",
    "args": ["stdio", "--read-only", "--toolsets", "context,repos,issues"],
    "env": {
      "GITHUB_PERSONAL_ACCESS_TOKEN": "${GITHUB_TOKEN}"
    }
  }
}
```

Set `GITHUB_TOKEN` in your `.env` to enable this.

## Agent Git Workflow

### Pipeline Sessions

During pipeline runs, agents work in git worktrees:

1. The engine creates a worktree from the project's repository
2. The agent receives the workspace path via `$WORKSPACE_PATH`
3. The agent reads, modifies, and creates files
4. The engine commits and pushes after each step completes

### Pulse Sessions

During autonomous pulse work:

1. Agent calls `claim_task(projectId, taskId)` — this provisions an authenticated git workspace on branch `feat/{taskId}`
2. Agent works in `/home/agent/task-workspaces/{taskId}/`
3. Agent commits and pushes directly (credentials are pre-configured)
4. Agent calls `open_pull_request(projectId, taskId, title, body)` when ready

## GitHub App (Optional)

For organization-level access and webhook support, configure a GitHub App:

1. Create a GitHub App at `github.com/organizations/{org}/settings/apps/new`
2. Configure permissions:
   - Repository: Contents (Read & Write), Issues (Read & Write), Pull Requests (Read & Write)
   - Organization: Members (Read)
3. Generate a private key and save it as `secrets/github-app.pem`
4. Set environment variables:
   ```bash
   GITHUB_APP_ID=123456
   GITHUB_APP_CLIENT_ID=Iv1.abc123
   GITHUB_APP_WEBHOOK_SECRET=your-webhook-secret
   GITHUB_APP_NAME=djinnbot
   ```

## Webhooks

The API server can receive GitHub webhooks at `/v1/github/webhooks`. Configure your GitHub App or repository webhook to point to:

```
https://your-djinnbot-host:8000/v1/github/webhooks
```

This enables triggering pipelines from GitHub events (issues, PRs, etc.).
