import { Type, type Static } from '@sinclair/typebox';
import type { AgentTool, AgentToolResult, AgentToolUpdateCallback } from '@mariozechner/pi-agent-core';
import { authFetch } from '../../api/auth-fetch.js';

// ── Schemas ────────────────────────────────────────────────────────────────

const GetRunHistoryParamsSchema = Type.Object({
  projectId: Type.Optional(Type.String({
    description: 'Filter runs by project ID. Omit to search across all projects.',
  })),
  taskId: Type.Optional(Type.String({
    description:
      'Filter runs by task ID. Returns only runs that were executed for this specific task. ' +
      'Use this to answer: "What happened last time someone worked on task X?"',
  })),
  agentId: Type.Optional(Type.String({
    description:
      'Filter by agent ID. Defaults to yourself. ' +
      'Set to another agent ID to see their run history, or omit to see your own.',
  })),
  status: Type.Optional(Type.Union([
    Type.Literal('completed'),
    Type.Literal('failed'),
    Type.Literal('cancelled'),
    Type.Literal('running'),
    Type.Literal('terminal'),
  ], {
    description:
      'Filter by run status. "terminal" matches completed + failed + cancelled. ' +
      'Omit to see all statuses.',
  })),
  since: Type.Optional(Type.String({
    description:
      'Only return runs created after this ISO 8601 timestamp (e.g. "2025-06-01T00:00:00Z"). ' +
      'Useful for "what happened since my last pulse?"',
  })),
  limit: Type.Optional(Type.Number({
    default: 10,
    description: 'Max runs to return (1-50, default 10). Use smaller values for quick checks.',
  })),
  includeSteps: Type.Optional(Type.Boolean({
    default: true,
    description: 'Include step-level details (agent, status, errors, outputs). Set false for a compact summary.',
  })),
});
type GetRunHistoryParams = Static<typeof GetRunHistoryParamsSchema>;

// ── Types ──────────────────────────────────────────────────────────────────

interface VoidDetails {}

export interface RunHistoryToolsConfig {
  agentId: string;
  apiBaseUrl?: string;
}

// ── Tool factory ───────────────────────────────────────────────────────────

export function createRunHistoryTools(config: RunHistoryToolsConfig): AgentTool[] {
  const { agentId } = config;

  const getApiBase = () =>
    config.apiBaseUrl || process.env.DJINNBOT_API_URL || 'http://api:8000';

  return [
    {
      name: 'get_run_history',
      description:
        'Query your execution history — past pipeline runs, executor results, and task attempts. ' +
        'Use this to learn from previous work:\n' +
        '- "What happened last time I worked on this task?" (filter by taskId)\n' +
        '- "What runs completed in my project since my last pulse?" (filter by projectId + since)\n' +
        '- "Did the executor I spawned succeed or fail, and why?" (filter by taskId + status)\n' +
        '- "What are my recent failures and what went wrong?" (status="failed")\n\n' +
        'Returns runs in reverse chronological order with step details, outputs (commit hashes, ' +
        'files changed, deviations), errors, and timing. Each run includes its task_id when ' +
        'available, so you can correlate runs with tasks on your kanban.\n\n' +
        'This is your procedural memory — it tells you what you DID, not what you KNOW ' +
        '(use recall/context_query for declarative knowledge).',
      label: 'get_run_history',
      parameters: GetRunHistoryParamsSchema,
      execute: async (
        _toolCallId: string,
        params: unknown,
        signal?: AbortSignal,
        _onUpdate?: AgentToolUpdateCallback<VoidDetails>,
      ): Promise<AgentToolResult<VoidDetails>> => {
        const p = params as GetRunHistoryParams;
        const apiBase = getApiBase();

        // Build query parameters
        const url = new URL(`${apiBase}/v1/internal/run-history`);
        if (p.projectId) url.searchParams.set('project_id', p.projectId);
        if (p.taskId) url.searchParams.set('task_id', p.taskId);

        // Default to self if no agent specified
        const targetAgent = p.agentId || agentId;
        url.searchParams.set('agent_id', targetAgent);

        if (p.status) url.searchParams.set('status', p.status);

        // Convert ISO timestamp to epoch-ms if provided
        if (p.since) {
          const sinceMs = new Date(p.since).getTime();
          if (!isNaN(sinceMs)) {
            url.searchParams.set('since', String(sinceMs));
          }
        }

        const limit = Math.max(1, Math.min(p.limit ?? 10, 50));
        url.searchParams.set('limit', String(limit));
        url.searchParams.set('include_steps', String(p.includeSteps ?? true));

        try {
          const response = await authFetch(url.toString(), { signal: signal ?? undefined });

          if (!response.ok) {
            const err = await response.json().catch(() => ({ detail: response.statusText })) as { detail?: string };
            return {
              content: [{
                type: 'text',
                text: `Failed to fetch run history: ${response.status} — ${err.detail ?? response.statusText}`,
              }],
              details: {},
            };
          }

          const data = await response.json() as {
            runs: Array<{
              run_id: string;
              pipeline_id: string;
              project_id?: string;
              task_id?: string;
              status: string;
              created_at: number;
              completed_at?: number;
              duration_ms?: number;
              task_branch?: string;
              model_override?: string;
              outputs: Record<string, string>;
              metadata?: Record<string, unknown>;
              steps?: Array<{
                step_id: string;
                agent_id: string;
                status: string;
                error?: string;
                outputs: Record<string, string>;
                started_at?: number;
                completed_at?: number;
                retry_count: number;
                model_used?: string;
              }>;
            }>;
            total: number;
          };

          if (data.total === 0) {
            const filters: string[] = [];
            if (p.projectId) filters.push(`project=${p.projectId}`);
            if (p.taskId) filters.push(`task=${p.taskId}`);
            if (p.status) filters.push(`status=${p.status}`);
            if (p.since) filters.push(`since=${p.since}`);
            const filterStr = filters.length > 0 ? ` (filters: ${filters.join(', ')})` : '';
            return {
              content: [{
                type: 'text',
                text: `No execution history found${filterStr}. This may be the first time this task/project has been worked on.`,
              }],
              details: {},
            };
          }

          // Format the runs into readable markdown
          const sections: string[] = [];
          sections.push(`## Execution History (${data.total} run${data.total !== 1 ? 's' : ''})\n`);

          for (const run of data.runs) {
            const statusIcon = run.status === 'completed' ? 'SUCCESS'
              : run.status === 'failed' ? 'FAILED'
              : run.status === 'cancelled' ? 'CANCELLED'
              : run.status === 'running' ? 'RUNNING'
              : run.status.toUpperCase();

            const duration = run.duration_ms != null
              ? `${Math.round(run.duration_ms / 1000)}s`
              : 'unknown';

            const createdDate = new Date(run.created_at).toISOString().replace('T', ' ').replace(/\.\d+Z$/, ' UTC');

            const lines: string[] = [];
            lines.push(`### ${statusIcon} — ${createdDate} (${duration})`);
            lines.push(`**Run**: ${run.run_id}`);
            if (run.task_id) lines.push(`**Task**: ${run.task_id}`);
            if (run.project_id) lines.push(`**Project**: ${run.project_id}`);
            if (run.task_branch) lines.push(`**Branch**: ${run.task_branch}`);
            if (run.model_override) lines.push(`**Model**: ${run.model_override}`);

            // Show outputs (commit hashes, files changed, summary, deviations)
            const outputs = run.outputs;
            if (outputs && Object.keys(outputs).length > 0) {
              if (outputs.commit_hashes) lines.push(`**Commits**: ${outputs.commit_hashes}`);
              if (outputs.files_changed) lines.push(`**Files Changed**: ${outputs.files_changed}`);
              if (outputs.summary) lines.push(`**Summary**: ${outputs.summary}`);
              if (outputs.status) lines.push(`**Result**: ${outputs.status}`);
              if (outputs.deviations) lines.push(`**Deviations**: ${outputs.deviations}`);
              if (outputs.blocked_by) lines.push(`**Blocked By**: ${outputs.blocked_by}`);

              // Show any other outputs not already displayed
              const shown = new Set(['commit_hashes', 'files_changed', 'summary', 'status', 'deviations', 'blocked_by']);
              const extra = Object.entries(outputs).filter(([k]) => !shown.has(k));
              if (extra.length > 0) {
                for (const [k, v] of extra) {
                  const val = typeof v === 'string' ? v : JSON.stringify(v);
                  if (val.length <= 200) {
                    lines.push(`**${k}**: ${val}`);
                  }
                }
              }
            }

            // Show step details if included
            if (run.steps && run.steps.length > 0) {
              for (const step of run.steps) {
                const stepDuration = step.started_at && step.completed_at
                  ? `${Math.round((step.completed_at - step.started_at) / 1000)}s`
                  : '';

                const stepStatus = step.status === 'completed' ? 'ok'
                  : step.status === 'failed' ? 'FAIL'
                  : step.status;

                lines.push(`  Step \`${step.step_id}\` (${step.agent_id}): ${stepStatus}${stepDuration ? ` in ${stepDuration}` : ''}${step.retry_count > 0 ? ` (${step.retry_count} retries)` : ''}`);

                if (step.error) {
                  // Truncate long errors
                  const errorPreview = step.error.length > 300
                    ? step.error.slice(0, 300) + '...'
                    : step.error;
                  lines.push(`  Error: ${errorPreview}`);
                }

                // Show step outputs if they have useful info
                if (step.outputs && Object.keys(step.outputs).length > 0) {
                  const stepOut = step.outputs;
                  if (stepOut.commit_hashes) lines.push(`  Commits: ${stepOut.commit_hashes}`);
                  if (stepOut.summary) lines.push(`  Summary: ${stepOut.summary}`);
                  if (stepOut.deviations) lines.push(`  Deviations: ${stepOut.deviations}`);
                  if (stepOut.blocked_by) lines.push(`  Blocked: ${stepOut.blocked_by}`);
                }
              }
            }

            // Metadata hints
            if (run.metadata?.spawn_executor) {
              lines.push(`_(spawned executor${run.metadata.memory_injection ? ', with memory injection' : ''})_`);
            }

            sections.push(lines.join('\n'));
          }

          return {
            content: [{ type: 'text', text: sections.join('\n\n') }],
            details: {},
          };

        } catch (err) {
          const errMsg = err instanceof Error ? err.message : String(err);
          return {
            content: [{
              type: 'text',
              text: `Error fetching run history: ${errMsg}`,
            }],
            details: {},
          };
        }
      },
    },
  ];
}
