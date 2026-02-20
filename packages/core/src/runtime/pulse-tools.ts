import { Type, type Static } from '@sinclair/typebox';
import type {
  AgentTool,
  AgentToolResult,
  AgentToolUpdateCallback,
} from '@mariozechner/pi-agent-core';

// Type definitions for pulse tool parameters
const GetMyProjectsParamsSchema = Type.Object({
  includeArchived: Type.Optional(
    Type.Boolean({
      default: false,
      description: 'Include archived projects in results',
    })
  ),
});
type GetMyProjectsParams = Static<typeof GetMyProjectsParamsSchema>;

const GetReadyTasksParamsSchema = Type.Object({
  projectId: Type.String({
    description: 'Project ID to get ready tasks from',
  }),
  limit: Type.Optional(
    Type.Number({
      default: 5,
      description: 'Maximum number of tasks to return',
    })
  ),
});
type GetReadyTasksParams = Static<typeof GetReadyTasksParamsSchema>;

const ExecuteTaskParamsSchema = Type.Object({
  projectId: Type.String({
    description: 'Project ID containing the task',
  }),
  taskId: Type.String({
    description: 'Task ID to execute',
  }),
  pipelineId: Type.Optional(
    Type.String({
      description: 'Optional: specific pipeline ID to use for execution',
    })
  ),
});
type ExecuteTaskParams = Static<typeof ExecuteTaskParamsSchema>;

// Simple void details for our tools
// eslint-disable-next-line @typescript-eslint/no-empty-object-type
interface VoidDetails {}

// API base URL - resolved lazily so it picks up env overrides set after module load.
// Callers can also pass apiBaseUrl explicitly to createPulseTools().
function getApiBaseUrl(override?: string): string {
  return override || process.env.DJINNBOT_API_URL || 'http://localhost:8000';
}

/**
 * Create pulse-specific tools for task discovery and execution.
 * These tools allow agents to check for ready tasks during their pulse routine.
 *
 * @param agentId - The agent's ID
 * @param pulseColumns - Optional list of kanban column names this agent works from.
 *   Used to filter get_ready_tasks to the right status set.
 *   Defaults to ['Backlog', 'Ready'] if not provided.
 * @param apiBaseUrl - Optional override for the API base URL.
 *   Defaults to DJINNBOT_API_URL env var, then 'http://localhost:8000'.
 *   Pass this when the env var may not be set before module load (e.g. containers).
 */
export function createPulseTools(agentId: string, pulseColumns?: string[], apiBaseUrl?: string): AgentTool[] {
  const API_BASE_URL = getApiBaseUrl(apiBaseUrl);
  // Map column names → task statuses for server-side filtering
  const columnToStatus: Record<string, string> = {
    'Backlog': 'backlog',
    'Planning': 'planning',
    'Ready': 'ready',
    'In Progress': 'in_progress',
    'Review': 'review',
    'Blocked': 'blocked',
    'Done': 'done',
    'Failed': 'failed',
  };
  const defaultColumns = ['Backlog', 'Ready'];
  const agentColumns = pulseColumns && pulseColumns.length > 0 ? pulseColumns : defaultColumns;
  const agentStatuses = agentColumns
    .map(col => columnToStatus[col])
    .filter(Boolean)
    .join(',') || 'backlog,planning,ready';
  return [
    // get_my_projects tool
    {
      name: 'get_my_projects',
      description:
        'Get list of projects you are assigned to. Returns projects where you have an active role (owner or member). Use this during pulse to discover work.',
      label: 'get_my_projects',
      parameters: GetMyProjectsParamsSchema,
      execute: async (
        toolCallId: string,
        params: unknown,
        signal?: AbortSignal,
        onUpdate?: AgentToolUpdateCallback<VoidDetails>
      ): Promise<AgentToolResult<VoidDetails>> => {
        const typedParams = params as GetMyProjectsParams;

        try {
          const url = `${API_BASE_URL}/v1/agents/${agentId}/projects`;
          const response = await fetch(url, {
            signal,
          });

          if (!response.ok) {
            throw new Error(
              `Failed to get projects: ${response.status} ${response.statusText}`
            );
          }

          // API returns a flat array of project-agent assignment objects:
          // [{ project_id, project_name, project_status, project_description, role, ... }]
          const raw = (await response.json()) as any;
          const rawList: any[] = Array.isArray(raw) ? raw : (raw.projects || []);

          // Normalise to consistent shape { id, name, status, description, role }
          const projects = rawList.map((p: any) => ({
            id: p.project_id ?? p.id,
            name: p.project_name ?? p.name,
            status: p.project_status ?? p.status,
            description: p.project_description ?? p.description ?? '',
            role: p.role,
          }));

          // Filter out archived projects unless explicitly requested
          const filteredProjects = typedParams.includeArchived
            ? projects
            : projects.filter((p: any) => p.status !== 'archived');

          // Format results for readability
          if (filteredProjects.length === 0) {
            return {
              content: [
                {
                  type: 'text',
                  text: 'No active projects assigned to you.',
                },
              ],
              details: {},
            };
          }

          const projectList = filteredProjects
            .map(
              (p: any) =>
                `- **${p.name}** (${p.id})\n  Status: ${p.status}, Role: ${p.role}`
            )
            .join('\n');

          return {
            content: [
              {
                type: 'text',
                text: `Found ${filteredProjects.length} project(s):\n\n${projectList}`,
              },
            ],
            details: {},
          };
        } catch (error) {
          const errorMessage =
            error instanceof Error ? error.message : String(error);
          return {
            content: [
              {
                type: 'text',
                text: `Error fetching projects: ${errorMessage}`,
              },
            ],
            details: {},
          };
        }
      },
    },

    // get_ready_tasks tool
    {
      name: 'get_ready_tasks',
      description:
        'Get tasks that are ready to execute in a project. Returns:\n' +
        '- tasks: candidates assigned to you (or unassigned) with all dependencies met, sorted by priority (P0 > P1 > P2 > P3). Each task includes blocking_tasks (downstream tasks waiting on this one).\n' +
        '- in_progress: your tasks already running in this project, with their downstream dependents.\n' +
        'Use in_progress + blocking_tasks together to identify which ready tasks are independent of your current work and safe to start in parallel.',
      label: 'get_ready_tasks',
      parameters: GetReadyTasksParamsSchema,
      execute: async (
        toolCallId: string,
        params: unknown,
        signal?: AbortSignal,
        onUpdate?: AgentToolUpdateCallback<VoidDetails>
      ): Promise<AgentToolResult<VoidDetails>> => {
        const typedParams = params as GetReadyTasksParams;

        try {
          const limit = typedParams.limit || 5;
          // Pass agent_id and statuses so the server returns only tasks in
          // this agent's columns that are assigned to them (or unassigned).
          const url = `${API_BASE_URL}/v1/projects/${typedParams.projectId}/ready-tasks?agent_id=${encodeURIComponent(agentId)}&limit=${limit}&statuses=${encodeURIComponent(agentStatuses)}`;
          const response = await fetch(url, {
            signal,
          });

          if (!response.ok) {
            throw new Error(
              `Failed to get ready tasks: ${response.status} ${response.statusText}`
            );
          }

          const raw = (await response.json()) as any;
          // Handle both legacy flat array (pre-refactor) and new { tasks, in_progress } shape
          const tasks: any[] = Array.isArray(raw) ? raw : (raw.tasks || []);
          const inProgress: any[] = Array.isArray(raw) ? [] : (raw.in_progress || []);

          // Build in-progress section
          let inProgressSection = '';
          if (inProgress.length > 0) {
            inProgressSection = `\n### Your tasks currently in progress (${inProgress.length})\n`;
            inProgressSection += inProgress.map((t: any) => {
              const blocksInfo = t.blocks && t.blocks.length > 0
                ? `\n   Unblocks when done: ${t.blocks.map((b: any) => `${b.title} [${b.status}]`).join(', ')}`
                : '';
              return `- [${t.status}] **${t.title}** (${t.id}) [${t.priority || 'P2'}]${blocksInfo}`;
            }).join('\n');
          } else {
            inProgressSection = '\n### Your tasks currently in progress\nNone.';
          }

          if (tasks.length === 0) {
            return {
              content: [
                {
                  type: 'text',
                  text: `${inProgressSection}\n\n### Ready tasks\nNo ready tasks found in project ${typedParams.projectId}.`,
                },
              ],
              details: {},
            };
          }

          // Format ready candidates with downstream dependency info for parallel-safety reasoning
          const taskList = tasks
            .map((t: any, idx: number) => {
              const blockingInfo = t.blocking_tasks && t.blocking_tasks.length > 0
                ? `\n   Unlocks when done: ${t.blocking_tasks.map((b: any) => `${b.title} [${b.status}]`).join(', ')}`
                : '';
              const assigned = t.assigned_agent ? ` (assigned: ${t.assigned_agent})` : ' (unassigned — can claim)';
              return `${idx + 1}. [${t.priority || 'P2'}] **${t.title}** (${t.id})${assigned}\n   Status: ${t.status}${t.description ? `\n   ${t.description.substring(0, 100)}${t.description.length > 100 ? '...' : ''}` : ''}${blockingInfo}`;
            })
            .join('\n\n');

          return {
            content: [
              {
                type: 'text',
                text: `${inProgressSection}\n\n### Ready tasks — pick independent ones to run in parallel (${tasks.length} candidate(s))\n\n${taskList}\n\n**Parallelism tip**: A ready task is safe to start alongside your in-progress work if none of its blocking_tasks overlap with your in-progress task IDs.`,
              },
            ],
            details: {},
          };
        } catch (error) {
          const errorMessage =
            error instanceof Error ? error.message : String(error);
          return {
            content: [
              {
                type: 'text',
                text: `Error fetching ready tasks: ${errorMessage}`,
              },
            ],
            details: {},
          };
        }
      },
    },

    // execute_task tool
    {
      name: 'execute_task',
      description:
        'Start executing a task by triggering its pipeline. This creates a new pipeline run and transitions the task to in_progress state. Use this to pick up work during pulse.',
      label: 'execute_task',
      parameters: ExecuteTaskParamsSchema,
      execute: async (
        toolCallId: string,
        params: unknown,
        signal?: AbortSignal,
        onUpdate?: AgentToolUpdateCallback<VoidDetails>
      ): Promise<AgentToolResult<VoidDetails>> => {
        const typedParams = params as ExecuteTaskParams;

        try {
          const url = `${API_BASE_URL}/v1/projects/${typedParams.projectId}/tasks/${typedParams.taskId}/execute`;
          const body: any = {};
          if (typedParams.pipelineId) {
            body.pipelineId = typedParams.pipelineId;
          }

          const response = await fetch(url, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
            },
            body: JSON.stringify(body),
            signal,
          });

          if (!response.ok) {
            const errorData = (await response.json().catch(() => ({}))) as { detail?: string };
            const errorMsg =
              errorData.detail || `${response.status} ${response.statusText}`;
            throw new Error(`Failed to execute task: ${errorMsg}`);
          }

          const data = (await response.json()) as { run_id?: string };

          return {
            content: [
              {
                type: 'text',
                text: `✅ Task execution started!\n\nRun ID: ${data.run_id}\nTask: ${typedParams.taskId}\nProject: ${typedParams.projectId}\n\nThe pipeline is now running autonomously in the engine. Check the dashboard or call get_task_context to follow progress.`,
              },
            ],
            details: {},
          };
        } catch (error) {
          const errorMessage =
            error instanceof Error ? error.message : String(error);
          return {
            content: [
              {
                type: 'text',
                text: `❌ Error executing task: ${errorMessage}`,
              },
            ],
            details: {},
          };
        }
      },
    },

    // ── claim_task ────────────────────────────────────────────────────────────
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
        try {
          // 1. Atomically claim the task
          const claimUrl = `${API_BASE_URL}/v1/projects/${projectId}/tasks/${taskId}/claim`;
          const claimResp = await fetch(claimUrl, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ agentId }),
            signal,
          });
          const claimData = (await claimResp.json()) as any;
          if (!claimResp.ok) {
            throw new Error(claimData.detail || `${claimResp.status} ${claimResp.statusText}`);
          }
          const branch: string = claimData.branch;

          // 2. Provision the authenticated git workspace (engine creates worktree)
          //    This is async on the engine side — the API polls and returns when ready.
          let worktreePath = `/home/agent/task-workspaces/${taskId}`;
          let workspaceNote = '';
          try {
            const wsUrl = `${API_BASE_URL}/v1/projects/${projectId}/tasks/${taskId}/workspace`;
            const wsResp = await fetch(wsUrl, {
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
                `Task claimed successfully.`,
                ``,
                `**Task ID**: ${taskId}`,
                `**Branch**: ${branch}`,
                `**Workspace**: ${worktreePath}${workspaceNote}`,
                ``,
                `Your workspace is a git worktree already checked out on branch \`${branch}\`.`,
                `Git credentials are configured — you can push directly:`,
                ``,
                `\`\`\`bash`,
                `cd ${worktreePath}`,
                `# ... make your changes ...`,
                `git add -A && git commit -m "your message"`,
                `git push`,
                `\`\`\``,
                ``,
                `When you are done, call transition_task to move it to 'review'.`,
              ].join('\n'),
            }],
            details: {},
          };
        } catch (error) {
          return { content: [{ type: 'text', text: `Error claiming task: ${error instanceof Error ? error.message : String(error)}` }], details: {} };
        }
      },
    },

    // ── get_task_branch ───────────────────────────────────────────────────────
    {
      name: 'get_task_branch',
      description:
        'Get (or create) the persistent git branch for a task. ' +
        'Returns the feat/{taskId} branch name. Use claim_task instead — it provisions the branch AND the authenticated workspace in one call.',
      label: 'get_task_branch',
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
        try {
          const url = `${API_BASE_URL}/v1/projects/${projectId}/tasks/${taskId}/branch`;
          const response = await fetch(url, { signal });
          const data = (await response.json()) as any;
          if (!response.ok) {
            throw new Error(data.detail || `${response.status} ${response.statusText}`);
          }
          return {
            content: [{ type: 'text', text: `Task branch: ${data.branch}${data.created ? ' (newly created)' : ' (existing)'}` }],
            details: {},
          };
        } catch (error) {
          return { content: [{ type: 'text', text: `Error getting task branch: ${error instanceof Error ? error.message : String(error)}` }], details: {} };
        }
      },
    },

    // ── get_task_context ──────────────────────────────────────────────────────
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
        try {
          const url = `${API_BASE_URL}/v1/projects/${projectId}/tasks/${taskId}`;
          const response = await fetch(url, { signal });
          const data = (await response.json()) as any;
          if (!response.ok) {
            throw new Error(data.detail || `${response.status} ${response.statusText}`);
          }
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
        } catch (error) {
          return { content: [{ type: 'text', text: `Error fetching task: ${error instanceof Error ? error.message : String(error)}` }], details: {} };
        }
      },
    },

    // ── open_pull_request ─────────────────────────────────────────────────────
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
        try {
          const url = `${API_BASE_URL}/v1/projects/${projectId}/tasks/${taskId}/pull-request`;
          const response = await fetch(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ agentId, title, body: body ?? '', draft: draft ?? false }),
            signal,
          });
          const data = (await response.json()) as any;
          if (!response.ok) {
            throw new Error(data.detail || `${response.status} ${response.statusText}`);
          }
          return {
            content: [{
              type: 'text',
              text: [
                `Pull request opened.`,
                ``,
                `**PR #${data.pr_number}**: ${data.title}`,
                `**URL**: ${data.pr_url}`,
                `**Status**: ${data.draft ? 'Draft' : 'Ready for review'}`,
                ``,
                `The PR link has been saved to the task. Call transition_task with status 'review' to move the task to the review column.`,
              ].join('\n'),
            }],
            details: {},
          };
        } catch (error) {
          return { content: [{ type: 'text', text: `Error opening PR: ${error instanceof Error ? error.message : String(error)}` }], details: {} };
        }
      },
    },

    // ── transition_task ───────────────────────────────────────────────────────
    {
      name: 'transition_task',
      description:
        'Move a task to a new kanban status (e.g. in_progress → review, review → done). ' +
        'Also cascades dependency unblocking when status is "done". ' +
        'Valid statuses: backlog, planning, ready, in_progress, review, blocked, done, failed.',
      label: 'transition_task',
      parameters: Type.Object({
        projectId: Type.String({ description: 'Project ID' }),
        taskId: Type.String({ description: 'Task ID' }),
        status: Type.String({ description: 'Target status: in_progress | review | done | failed | blocked | ready | backlog | planning' }),
        note: Type.Optional(Type.String({ description: 'Optional note explaining the transition' })),
      }),
      execute: async (
        _toolCallId: string,
        params: unknown,
        signal?: AbortSignal,
      ): Promise<AgentToolResult<VoidDetails>> => {
        const { projectId, taskId, status, note } = params as { projectId: string; taskId: string; status: string; note?: string };
        try {
          const url = `${API_BASE_URL}/v1/projects/${projectId}/tasks/${taskId}/transition`;
          const response = await fetch(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ status, note }),
            signal,
          });
          const data = (await response.json()) as any;
          if (!response.ok) {
            throw new Error(data.detail || `${response.status} ${response.statusText}`);
          }
          return {
            content: [{
              type: 'text',
              text: `Task transitioned: ${data.from_status} → ${data.to_status}${note ? `\nNote: ${note}` : ''}`,
            }],
            details: {},
          };
        } catch (error) {
          return { content: [{ type: 'text', text: `Error transitioning task: ${error instanceof Error ? error.message : String(error)}` }], details: {} };
        }
      },
    },
  ];
}
