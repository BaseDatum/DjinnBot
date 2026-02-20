# GitHub Integration UI Components

Complete UI for managing GitHub App integrations and event-to-agent assignments.

## Quick Start

```tsx
import { GitHubSettings } from '@/components/github';

function ProjectSettings({ projectId }: { projectId: string }) {
  return (
    <div>
      <h1>Project Settings</h1>
      <GitHubSettings projectId={projectId} />
    </div>
  );
}
```

## Components

### GitHubSettings
Main container component that orchestrates all GitHub integration UI.

**Props:**
- `projectId: string` - The project ID to manage

**Features:**
- Loads GitHub installation status
- Shows connection status card
- Shows event assignments table (if connected)
- Shows webhook activity log (if connected)

### ConnectionStatus
Displays GitHub App connection status and repository details.

**Props:**
- `projectId: string` - The project ID
- `installation: GitHubInstallation | null` - Installation data or null
- `onRefresh: () => void` - Callback to refresh status

**Features:**
- Connection indicator (green ✓ / red ✗)
- Repository name with GitHub link
- Installation ID
- Permissions badges
- Subscribed events badges
- Install button (when not connected)
- Refresh button

### EventAssignments
Full CRUD interface for managing which agents handle which GitHub events.

**Props:**
- `projectId: string` - The project ID

**Features:**
- Table view of all assignments
- Create new assignment (modal form)
- Edit existing assignment (modal form)
- Delete assignment (with confirmation)
- Toggle auto-respond inline
- Event type selector (issues, PRs, comments, etc.)
- Agent selector (loads from project)
- JSON filter editor
- Toast notifications

**Event Types:**
- `issues` - Issue events (opened, closed, etc.)
- `pull_request` - PR events (opened, closed, synchronize, etc.)
- `issue_comment` - Comment events
- `pull_request_review` - PR review events
- `push` - Push events
- `release` - Release events

**Filter Examples:**
```json
{
  "labels": ["bug", "help-wanted"],
  "author": "octocat"
}
```

### WebhookLog
Real-time activity log showing recent webhook events.

**Props:**
- `projectId: string` - The project ID

**Features:**
- Shows up to 50 recent events
- Status indicators (pending, processing, completed, failed)
- Event details (type, action, issue/PR number)
- Assigned agent badge
- Error messages
- Links to GitHub
- Relative timestamps ("5m ago")
- Auto-refresh every 10 seconds
- Manual refresh button

## API Requirements

These components expect the following API endpoints to be implemented:

- `GET /api/projects/:id/github/status` - Get installation status
- `GET /api/projects/:id/github/assignments` - List assignments
- `POST /api/projects/:id/github/assignments` - Create assignment
- `PUT /api/projects/:id/github/assignments/:assignmentId` - Update assignment
- `PATCH /api/projects/:id/github/assignments/:assignmentId` - Partial update
- `DELETE /api/projects/:id/github/assignments/:assignmentId` - Delete assignment
- `GET /api/projects/:id/github/webhook-log?limit=50` - Get webhook log
- `GET /api/projects/:id/agents` - Get project agents

## TypeScript Types

```typescript
interface GitHubInstallation {
  id: string;
  projectId: string;
  installationId: number;
  owner: string;
  repo: string;
  permissions: Record<string, string>;
  events: string[];
  createdAt: string;
  updatedAt: string;
}

interface EventAssignment {
  id: string;
  projectId: string;
  eventType: string;
  eventAction?: string;
  agentId: string;
  agentName: string;
  filters: Record<string, any>;
  autoRespond: boolean;
  createdAt: string;
}

interface WebhookEvent {
  id: string;
  eventType: string;
  eventAction: string;
  issueNumber?: number;
  prNumber?: number;
  agentId?: string;
  agentName?: string;
  status: 'pending' | 'processing' | 'completed' | 'failed';
  error?: string;
  responseUrl?: string;
  timestamp: string;
}
```

## Styling

Uses shadcn/ui components and Tailwind CSS. Consistent with the rest of the dashboard.

## Dependencies

- `@radix-ui/react-dialog` - Dialog modals
- `sonner` - Toast notifications
- `lucide-react` - Icons

All other dependencies are already in the dashboard.

## Development

```bash
# Build
cd packages/dashboard
npm run build

# Dev mode
npm run dev
```
