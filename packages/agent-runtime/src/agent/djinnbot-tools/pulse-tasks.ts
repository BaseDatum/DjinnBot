import { Type, type Static } from '@sinclair/typebox';
import type { AgentTool, AgentToolResult } from '@mariozechner/pi-agent-core';
import { authFetch } from '../../api/auth-fetch.js';

// ── Schemas ────────────────────────────────────────────────────────────────

const ExecuteTaskParamsSchema = Type.Object({
  projectId: Type.String({ description: 'Project ID containing the task' }),
  taskId: Type.String({ description: 'Task ID to execute' }),
  pipelineId: Type.Optional(Type.String({ description: 'Optional: specific pipeline ID to use for execution' })),
});
type ExecuteTaskParams = Static<typeof ExecuteTaskParamsSchema>;

const TransitionTaskParamsSchema = Type.Object({
  projectId: Type.String({ description: 'Project ID' }),
  taskId: Type.String({ description: 'Task ID' }),
  status: Type.String({ description: 'Target status: in_progress | review | done | failed | blocked | ready | backlog | planning' }),
  note: Type.Optional(Type.String({ description: 'Optional note explaining the transition' })),
});
type TransitionTaskParams = Static<typeof TransitionTaskParamsSchema>;

// ── Types ──────────────────────────────────────────────────────────────────

interface VoidDetails {}

export interface PulseTasksToolsConfig {
  agentId: string;
  apiBaseUrl?: string;
}

// ── Tool factories ─────────────────────────────────────────────────────────

export function createPulseTasksTools(config: PulseTasksToolsConfig): AgentTool[] {
  const { agentId } = config;

  const getApiBase = () =>
    config.apiBaseUrl || process.env.DJINNBOT_API_URL || 'http://api:8000';

  return [
    {
      name: 'claim_task',
      description:
        'Atomically claim an unassigned task so no other agent picks it up simultaneously. ' +
        'Provisions an authenticated git workspace at /home/agent/task-workspaces/{taskId}/ ' +
        'so you can commit and push immediately. Call this BEFORE starting work on a task.',
      label: 'claim_task',
      parameters: Type.Object({
        projectId: Type.String({ description: 'Project ID' }),
        taskId: Type.String({ description: 'Task ID to claim' }),
      }),
      execute: async (
        _toolCallId: string,
        params: unknown,
        signal?: AbortSignal,
      ): Promise<AgentToolResult<VoidDetails>> => {
        const { projectId, taskId } = params as { projectId: string; taskId: string };
        const apiBase = getApiBase();
        try {
          const claimUrl = `${apiBase}/v1/projects/${projectId}/tasks/${taskId}/claim`;
          const claimResp = await authFetch(claimUrl, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ agentId }),
            signal,
          });
          const claimData = (await claimResp.json()) as any;
          if (!claimResp.ok) throw new Error(claimData.detail || `${claimResp.status} ${claimResp.statusText}`);
          const branch: string = claimData.branch;

          let worktreePath = `/home/agent/task-workspaces/${taskId}`;
          let workspaceNote = '';
          try {
            const wsUrl = `${apiBase}/v1/projects/${projectId}/tasks/${taskId}/workspace`;
            const wsResp = await authFetch(wsUrl, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ agentId }),
              signal,
            });
            const wsData = (await wsResp.json()) as any;
            if (wsResp.ok) {
              worktreePath = wsData.worktree_path ?? worktreePath;
              workspaceNote = wsData.already_existed
                ? ' (workspace already existed — prior work is preserved)'
                : ' (new workspace provisioned)';
            } else {
              workspaceNote = ` (workspace setup failed: ${wsData.detail ?? wsResp.status} — you may need to set up git manually)`;
            }
          } catch (wsErr) {
            workspaceNote = ` (workspace setup error: ${wsErr instanceof Error ? wsErr.message : String(wsErr)})`;
          }

          return {
            content: [{
              type: 'text',
              text: [
                `Task claimed successfully.`, ``,
                `**Task ID**: ${taskId}`,
                `**Branch**: ${branch}`,
                `**Workspace**: ${worktreePath}${workspaceNote}`, ``,
                `Your workspace is a git worktree already checked out on branch \`${branch}\`.`,
                `Git credentials are configured — you can push directly:`, ``,
                '```bash',
                `cd ${worktreePath}`,
                `# ... make your changes ...`,
                `git add -A && git commit -m "your message"`,
                `git push`,
                '```', ``,
                `When you are done, call transition_task to move it to 'review'.`,
              ].join('\n'),
            }],
            details: {},
          };
        } catch (err) {
          return { content: [{ type: 'text', text: `Error claiming task: ${err instanceof Error ? err.message : String(err)}` }], details: {} };
        }
      },
    },

    {
      name: 'get_task_context',
      description:
        'Get full details of a specific task: description, status, priority, assigned agent, git branch, PR info. ' +
        'Use this to understand what a task requires before starting work.',
      label: 'get_task_context',
      parameters: Type.Object({
        projectId: Type.String({ description: 'Project ID' }),
        taskId: Type.String({ description: 'Task ID' }),
      }),
      execute: async (
        _toolCallId: string,
        params: unknown,
        signal?: AbortSignal,
      ): Promise<AgentToolResult<VoidDetails>> => {
        const { projectId, taskId } = params as { projectId: string; taskId: string };
        const apiBase = getApiBase();
        try {
          const url = `${apiBase}/v1/projects/${projectId}/tasks/${taskId}`;
          const response = await authFetch(url, { signal });
          const data = (await response.json()) as any;
          if (!response.ok) throw new Error(data.detail || `${response.status} ${response.statusText}`);
          const meta = data.metadata || {};
          const lines = [
            `**Task**: ${data.title} (${taskId})`,
            `**Status**: ${data.status}  **Priority**: ${data.priority}`,
            `**Assigned**: ${data.assigned_agent || 'unassigned'}`,
            `**Estimated**: ${data.estimated_hours ? `${data.estimated_hours}h` : 'unknown'}`,
            `**Branch**: ${meta.git_branch || 'not yet created (call get_task_branch)'}`,
            `**PR**: ${meta.pr_url || 'none'}`,
            `\n**Description**:\n${data.description || '(no description)'}`,
          ];
          return { content: [{ type: 'text', text: lines.join('\n') }], details: {} };
        } catch (err) {
          return { content: [{ type: 'text', text: `Error fetching task: ${err instanceof Error ? err.message : String(err)}` }], details: {} };
        }
      },
    },

    {
      name: 'open_pull_request',
      description:
        'Open a GitHub pull request for a task branch (feat/{taskId}) targeting main. ' +
        'Call this when your implementation is ready for review. ' +
        'Returns the PR URL and number. Stores the PR link in the task metadata.',
      label: 'open_pull_request',
      parameters: Type.Object({
        projectId: Type.String({ description: 'Project ID' }),
        taskId: Type.String({ description: 'Task ID' }),
        title: Type.String({ description: 'PR title' }),
        body: Type.Optional(Type.String({ description: 'PR description (markdown)' })),
        draft: Type.Optional(Type.Boolean({ description: 'Open as draft PR (default false)' })),
      }),
      execute: async (
        _toolCallId: string,
        params: unknown,
        signal?: AbortSignal,
      ): Promise<AgentToolResult<VoidDetails>> => {
        const { projectId, taskId, title, body, draft } = params as {
          projectId: string; taskId: string; title: string; body?: string; draft?: boolean;
        };
        const apiBase = getApiBase();
        try {
          const url = `${apiBase}/v1/projects/${projectId}/tasks/${taskId}/pull-request`;
          const response = await authFetch(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ agentId, title, body: body ?? '', draft: draft ?? false }),
            signal,
          });
          const data = (await response.json()) as any;
          if (!response.ok) throw new Error(data.detail || `${response.status} ${response.statusText}`);
          return {
            content: [{
              type: 'text',
              text: [
                `Pull request opened.`, ``,
                `**PR #${data.pr_number}**: ${data.title}`,
                `**URL**: ${data.pr_url}`,
                `**Status**: ${data.draft ? 'Draft' : 'Ready for review'}`, ``,
                `The PR link has been saved to the task. Call transition_task with status 'review' to move the task to the review column.`,
              ].join('\n'),
            }],
            details: {},
          };
        } catch (err) {
          return { content: [{ type: 'text', text: `Error opening PR: ${err instanceof Error ? err.message : String(err)}` }], details: {} };
        }
      },
    },

    {
      name: 'transition_task',
      description:
        'Move a task to a new kanban status (e.g. in_progress → review, review → done). ' +
        'Also cascades dependency unblocking when status is "done". ' +
        'Valid statuses: backlog, planning, ready, in_progress, review, blocked, done, failed.',
      label: 'transition_task',
      parameters: TransitionTaskParamsSchema,
      execute: async (
        _toolCallId: string,
        params: unknown,
        signal?: AbortSignal,
      ): Promise<AgentToolResult<VoidDetails>> => {
        const { projectId, taskId, status, note } = params as TransitionTaskParams;
        const apiBase = getApiBase();
        try {
          const url = `${apiBase}/v1/projects/${projectId}/tasks/${taskId}/transition`;
          const response = await authFetch(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ status, note }),
            signal,
          });
          const data = (await response.json()) as any;
          if (!response.ok) throw new Error(data.detail || `${response.status} ${response.statusText}`);
          return {
            content: [{ type: 'text', text: `Task transitioned: ${data.from_status} → ${data.to_status}${note ? `\nNote: ${note}` : ''}` }],
            details: {},
          };
        } catch (err) {
          return { content: [{ type: 'text', text: `Error transitioning task: ${err instanceof Error ? err.message : String(err)}` }], details: {} };
        }
      },
    },

    {
      name: 'execute_task',
      description:
        'Start executing a task by triggering its pipeline. This creates a new pipeline run and transitions the task to in_progress state. Use this to kick off structured multi-agent work during pulse.',
      label: 'execute_task',
      parameters: ExecuteTaskParamsSchema,
      execute: async (
        _toolCallId: string,
        params: unknown,
        signal?: AbortSignal,
      ): Promise<AgentToolResult<VoidDetails>> => {
        const p = params as ExecuteTaskParams;
        const apiBase = getApiBase();
        try {
          const url = `${apiBase}/v1/projects/${p.projectId}/tasks/${p.taskId}/execute`;
          const body: any = {};
          if (p.pipelineId) body.pipelineId = p.pipelineId;
          const response = await authFetch(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body),
            signal,
          });
          if (!response.ok) {
            const errorData = (await response.json().catch(() => ({}))) as { detail?: string };
            throw new Error(errorData.detail || `${response.status} ${response.statusText}`);
          }
          const data = (await response.json()) as { run_id?: string };
          return {
            content: [{
              type: 'text',
              text: `Task execution started!\n\nRun ID: ${data.run_id}\nTask: ${p.taskId}\nProject: ${p.projectId}\n\nThe pipeline is now running autonomously in the engine. Check the dashboard or call get_task_context to follow progress.`,
            }],
            details: {},
          };
        } catch (err) {
          return { content: [{ type: 'text', text: `Error executing task: ${err instanceof Error ? err.message : String(err)}` }], details: {} };
        }
      },
    },
  ];
}
