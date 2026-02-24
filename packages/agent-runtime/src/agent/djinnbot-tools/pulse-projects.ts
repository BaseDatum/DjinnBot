import { Type, type Static } from '@sinclair/typebox';
import type { AgentTool, AgentToolResult } from '@mariozechner/pi-agent-core';
import { authFetch } from '../../api/auth-fetch.js';

// ── Schemas ────────────────────────────────────────────────────────────────

const GetMyProjectsParamsSchema = Type.Object({
  includeArchived: Type.Optional(Type.Boolean({
    default: false,
    description: 'Include archived projects in results',
  })),
});
type GetMyProjectsParams = Static<typeof GetMyProjectsParamsSchema>;

const GetReadyTasksParamsSchema = Type.Object({
  projectId: Type.String({ description: 'Project ID to get ready tasks from' }),
  limit: Type.Optional(Type.Number({ default: 5, description: 'Maximum number of tasks to return' })),
});
type GetReadyTasksParams = Static<typeof GetReadyTasksParamsSchema>;

const GetProjectVisionParamsSchema = Type.Object({
  projectId: Type.String({ description: 'Project ID to get the vision for' }),
});
type GetProjectVisionParams = Static<typeof GetProjectVisionParamsSchema>;

// ── Types ──────────────────────────────────────────────────────────────────

interface VoidDetails {}

export interface PulseProjectsToolsConfig {
  agentId: string;
  apiBaseUrl?: string;
  /**
   * Kanban column names this agent works from during pulse.
   * Defaults to PULSE_COLUMNS env var (comma-separated), then ['Backlog','Ready'].
   */
  pulseColumns?: string[];
}

// ── Tool factories ─────────────────────────────────────────────────────────

export function createPulseProjectsTools(config: PulseProjectsToolsConfig): AgentTool[] {
  const { agentId } = config;

  const getApiBase = () =>
    config.apiBaseUrl || process.env.DJINNBOT_API_URL || 'http://api:8000';

  return [
    {
      name: 'get_my_projects',
      description: 'Get list of projects you are assigned to. Returns projects where you have an active role (owner or member). Use this during pulse to discover work.',
      label: 'get_my_projects',
      parameters: GetMyProjectsParamsSchema,
      execute: async (
        _toolCallId: string,
        params: unknown,
        signal?: AbortSignal,
      ): Promise<AgentToolResult<VoidDetails>> => {
        const p = params as GetMyProjectsParams;
        const apiBase = getApiBase();
        try {
          const url = `${apiBase}/v1/agents/${agentId}/projects`;
          const response = await authFetch(url, { signal });
          if (!response.ok) throw new Error(`${response.status} ${response.statusText}`);
          const raw = (await response.json()) as any;
          const rawList: any[] = Array.isArray(raw) ? raw : (raw.projects || []);
          const projects = rawList.map((proj: any) => ({
            id: proj.project_id ?? proj.id,
            name: proj.project_name ?? proj.name,
            status: proj.project_status ?? proj.status,
            description: proj.project_description ?? proj.description ?? '',
            role: proj.role,
          }));
          const filtered = p.includeArchived ? projects : projects.filter((proj: any) => proj.status !== 'archived');
          if (filtered.length === 0) {
            return { content: [{ type: 'text', text: 'No active projects assigned to you.' }], details: {} };
          }
          const list = filtered.map((proj: any) =>
            `- **${proj.name}** (${proj.id})\n  Status: ${proj.status}, Role: ${proj.role}`
          ).join('\n');
          return { content: [{ type: 'text', text: `Found ${filtered.length} project(s):\n\n${list}` }], details: {} };
        } catch (err) {
          return { content: [{ type: 'text', text: `Error fetching projects: ${err instanceof Error ? err.message : String(err)}` }], details: {} };
        }
      },
    },

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
        _toolCallId: string,
        params: unknown,
        signal?: AbortSignal,
      ): Promise<AgentToolResult<VoidDetails>> => {
        const p = params as GetReadyTasksParams;
        const apiBase = getApiBase();

        // Resolve columns → statuses at call time (env may have been set after module load)
        const columnToStatus: Record<string, string> = {
          'Backlog': 'backlog', 'Planning': 'planning', 'Planned': 'planned',
          'UX': 'ux', 'Ready': 'ready', 'In Progress': 'in_progress',
          'Review': 'review', 'Test': 'test', 'Blocked': 'blocked',
          'Done': 'done', 'Failed': 'failed',
        };
        const columns: string[] = config.pulseColumns
          || (process.env.PULSE_COLUMNS ? process.env.PULSE_COLUMNS.split(',').map((c: string) => c.trim()).filter(Boolean) : [])
          || ['Backlog', 'Ready'];
        const statuses = columns.map((c: string) => columnToStatus[c]).filter(Boolean).join(',') || 'backlog,planning,ready';

        try {
          const limit = p.limit || 5;
          const url = `${apiBase}/v1/projects/${p.projectId}/ready-tasks?agent_id=${encodeURIComponent(agentId)}&limit=${limit}&statuses=${encodeURIComponent(statuses)}`;
          const response = await authFetch(url, { signal });
          if (!response.ok) throw new Error(`${response.status} ${response.statusText}`);
          const raw = (await response.json()) as any;
          const tasks: any[] = Array.isArray(raw) ? raw : (raw.tasks || []);
          const inProgress: any[] = Array.isArray(raw) ? [] : (raw.in_progress || []);

          const inProgressSection = inProgress.length > 0
            ? `\n### Your tasks currently in progress (${inProgress.length})\n` +
              inProgress.map((t: any) => {
                const blocksInfo = t.blocks?.length > 0
                  ? `\n   Unblocks when done: ${t.blocks.map((b: any) => `${b.title} [${b.status}]`).join(', ')}`
                  : '';
                return `- [${t.status}] **${t.title}** (${t.id}) [${t.priority || 'P2'}]${blocksInfo}`;
              }).join('\n')
            : '\n### Your tasks currently in progress\nNone.';

          if (tasks.length === 0) {
            return { content: [{ type: 'text', text: `${inProgressSection}\n\n### Ready tasks\nNo ready tasks found in project ${p.projectId}.` }], details: {} };
          }

          const taskList = tasks.map((t: any, idx: number) => {
            const blockingInfo = t.blocking_tasks?.length > 0
              ? `\n   Unlocks when done: ${t.blocking_tasks.map((b: any) => `${b.title} [${b.status}]`).join(', ')}`
              : '';
            const assigned = t.assigned_agent ? ` (assigned: ${t.assigned_agent})` : ' (unassigned — can claim)';
            return `${idx + 1}. [${t.priority || 'P2'}] **${t.title}** (${t.id})${assigned}\n   Status: ${t.status}${t.description ? `\n   ${t.description.substring(0, 100)}${t.description.length > 100 ? '...' : ''}` : ''}${blockingInfo}`;
          }).join('\n\n');

          return {
            content: [{
              type: 'text',
              text: `${inProgressSection}\n\n### Ready tasks — pick independent ones to run in parallel (${tasks.length} candidate(s))\n\n${taskList}\n\n**Parallelism tip**: A ready task is safe to start alongside your in-progress work if none of its blocking_tasks overlap with your in-progress task IDs.`,
            }],
            details: {},
          };
        } catch (err) {
          return { content: [{ type: 'text', text: `Error fetching ready tasks: ${err instanceof Error ? err.message : String(err)}` }], details: {} };
        }
      },
    },

    {
      name: 'get_project_vision',
      description:
        'Get the project vision document — a living markdown document maintained by the project ' +
        'owner that describes the project\'s goals, architecture, constraints, and current priorities. ' +
        'ALWAYS call this before starting work on a project to ensure your work aligns with the ' +
        'project\'s direction. The vision may be updated at any time by the user.',
      label: 'get_project_vision',
      parameters: GetProjectVisionParamsSchema,
      execute: async (
        _toolCallId: string,
        params: unknown,
        signal?: AbortSignal,
      ): Promise<AgentToolResult<VoidDetails>> => {
        const p = params as GetProjectVisionParams;
        const apiBase = getApiBase();
        try {
          const url = `${apiBase}/v1/projects/${p.projectId}/vision`;
          const response = await authFetch(url, { signal });
          if (!response.ok) throw new Error(`${response.status} ${response.statusText}`);
          const data = (await response.json()) as any;
          const vision = data.vision || '';

          if (!vision) {
            return {
              content: [{
                type: 'text',
                text: 'No project vision has been set for this project. Proceed using the task descriptions and your best judgment.',
              }],
              details: {},
            };
          }

          return {
            content: [{
              type: 'text',
              text: `## Project Vision\n\n${vision}`,
            }],
            details: {},
          };
        } catch (err) {
          return { content: [{ type: 'text', text: `Error fetching project vision: ${err instanceof Error ? err.message : String(err)}` }], details: {} };
        }
      },
    },
  ];
}
