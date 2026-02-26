import { Type, type Static } from '@sinclair/typebox';
import type { AgentTool, AgentToolResult, AgentToolUpdateCallback } from '@mariozechner/pi-agent-core';
import type { RedisPublisher } from '../../redis/publisher.js';
import type { RequestIdRef } from '../runner.js';
import { authFetch } from '../../api/auth-fetch.js';

// ── Schemas ────────────────────────────────────────────────────────────────

const SwarmTaskSchema = Type.Object({
  key: Type.String({ description: 'Unique key for this task within the swarm (e.g. task ID or descriptive slug)' }),
  title: Type.String({ description: 'Short human-readable title' }),
  projectId: Type.String({ description: 'Project ID' }),
  taskId: Type.String({ description: 'Task ID in the kanban' }),
  executionPrompt: Type.String({
    description:
      'The complete execution prompt for this task. Write it as if briefing ' +
      'a skilled engineer with zero prior context. Include: what to build, ' +
      'which files to modify, acceptance criteria, verification steps.',
  }),
  dependencies: Type.Array(Type.String(), {
    description: 'Keys of tasks that must complete before this one starts. Empty array for root tasks.',
  }),
  model: Type.Optional(Type.String({ description: 'Override the executor model for this specific task' })),
  timeoutSeconds: Type.Optional(Type.Number({ description: 'Timeout in seconds for this task (default: 300, max: 600)' })),
});

const SwarmExecuteParamsSchema = Type.Object({
  tasks: Type.Array(SwarmTaskSchema, {
    description:
      'Array of tasks forming a DAG. Each task has a unique key and declares ' +
      'which other task keys it depends on. Root tasks (no dependencies) start ' +
      'immediately. Dependent tasks start when all their dependencies complete. ' +
      'If a task fails, all tasks that depend on it are skipped.',
  }),
  maxConcurrent: Type.Optional(Type.Number({
    description: 'Max executors running in parallel (default: 3, max: 8). ' +
      'Higher values = faster but more resource usage.',
  })),
  globalTimeoutSeconds: Type.Optional(Type.Number({
    description: 'Timeout for the entire swarm in seconds (default: 1800 = 30 min, max: 3600)',
  })),
});
type SwarmExecuteParams = Static<typeof SwarmExecuteParamsSchema>;

// ── Types ──────────────────────────────────────────────────────────────────

interface VoidDetails {}

export interface SwarmExecutorToolsConfig {
  publisher: RedisPublisher;
  requestIdRef: RequestIdRef;
  agentId: string;
  apiBaseUrl?: string;
}

// ── Deviation rules (same as spawn-executor) ──────────────────────────────

const EXECUTOR_DEVIATION_RULES = `
## Deviation Rules (Always Active)

You are an executor agent. Follow the task prompt precisely. These rules govern
how you handle unexpected situations during implementation.

### Rule 0: Respect workflow policy
**Context:** Each task has a work_type (feature, bugfix, test, refactor, docs, infrastructure, design, custom)
that determines which SDLC stages apply. If the task's work_type is provided in your prompt,
only perform work relevant to the stages that are required or optional for that type.
For example, a "test" task does NOT need UX design, deployment, or spec writing.
Transition the task to its next valid stage when done — use get_task_workflow to check.

### Rule 1: Auto-fix bugs
**Trigger:** Code doesn't work as intended (errors, wrong output, type errors, null pointer exceptions)
**Action:** Fix inline. Add or update tests if applicable. Commit with prefix "fix:".
**Track:** Note the deviation in your completion report.

### Rule 2: Auto-add missing critical functionality
**Trigger:** Missing error handling, input validation, null guards, auth checks, CSRF protection, rate limiting
**Action:** Add the missing code. Commit with prefix "fix:".
**Track:** Note the deviation in your completion report.

### Rule 3: Auto-fix blocking issues
**Trigger:** Missing dependency, broken import, wrong types, build config error, missing env var
**Action:** Fix the blocker. Commit with prefix "chore:".
**Track:** Note the deviation in your completion report.

### Rule 4: STOP for architectural decisions
**Trigger:** Needs a new DB table (not column), major schema migration, switching libraries/frameworks, breaking API changes, new infrastructure requirements
**Action:** STOP immediately. Call fail() with a clear description of what you found, what you propose, and why. Do NOT implement architectural changes.

### Limits
- **Max 3 auto-fix attempts per issue.** After 3 attempts on the same problem, document it and move on.
- **Only fix issues caused by YOUR changes.** Pre-existing bugs, linting warnings, or failures in unrelated files are out of scope. Note them but don't fix them.
- **Scope boundary:** If you discover work beyond the task prompt, note it but don't do it.

### Completion Protocol
When done, call complete() with outputs including:
- \`status\`: "success" or "partial"
- \`commit_hashes\`: comma-separated list of your commit SHAs
- \`files_changed\`: comma-separated list of files you modified
- \`deviations\`: description of any auto-fixes applied (Rules 1-3) or empty string
- \`blocked_by\`: description of any Rule 4 stoppers encountered or empty string
- \`summary\`: one-sentence summary of what you accomplished
`.trim();

// ── Constants ──────────────────────────────────────────────────────────────

const POLL_INTERVAL_MS = 3000;
const MAX_POLL_ATTEMPTS = 800; // ~40 min with 3s interval

// ── Tool factory ───────────────────────────────────────────────────────────

export function createSwarmExecutorTools(config: SwarmExecutorToolsConfig): AgentTool[] {
  const { agentId } = config;

  const getApiBase = () =>
    config.apiBaseUrl || process.env.DJINNBOT_API_URL || 'http://api:8000';

  return [
    {
      name: 'swarm_execute',
      description:
        'Execute multiple tasks IN PARALLEL as a dependency-aware swarm. ' +
        'Submit a DAG of tasks — root tasks (no dependencies) start immediately, ' +
        'dependent tasks auto-start when their dependencies complete. ' +
        'If a task fails, all downstream tasks are automatically skipped.\n\n' +
        'This is MUCH faster than sequential spawn_executor calls. Use it whenever ' +
        'you have multiple tasks where some can run in parallel.\n\n' +
        'Each executor runs in a fresh container with a clean context window. ' +
        'The call blocks until ALL tasks complete (or timeout). ' +
        'Returns a comprehensive result with per-task status, outputs, and timing.\n\n' +
        'Example DAG: tasks A and B have no dependencies (run in parallel), ' +
        'task C depends on [A, B] (waits for both), task D depends on [C].',
      label: 'swarm_execute',
      parameters: SwarmExecuteParamsSchema,
      execute: async (
        _toolCallId: string,
        params: unknown,
        signal?: AbortSignal,
        _onUpdate?: AgentToolUpdateCallback<VoidDetails>,
      ): Promise<AgentToolResult<VoidDetails>> => {
        const p = params as SwarmExecuteParams;
        const apiBase = getApiBase();

        try {
          // 1. Submit the swarm to the API
          console.log(`[swarm_execute] Submitting swarm with ${p.tasks.length} tasks (maxConcurrent: ${p.maxConcurrent ?? 3})`);

          const submitResponse = await authFetch(`${apiBase}/v1/internal/swarm-execute`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              agent_id: agentId,
              tasks: p.tasks.map(t => ({
                key: t.key,
                title: t.title,
                project_id: t.projectId,
                task_id: t.taskId,
                execution_prompt: t.executionPrompt,
                dependencies: t.dependencies,
                model: t.model || process.env.EXECUTOR_MODEL || undefined,
                timeout_seconds: t.timeoutSeconds,
              })),
              max_concurrent: p.maxConcurrent ?? 3,
              deviation_rules: EXECUTOR_DEVIATION_RULES,
              global_timeout_seconds: p.globalTimeoutSeconds ?? 1800,
            }),
            signal,
          });

          if (!submitResponse.ok) {
            const errData = await submitResponse.json().catch(() => ({})) as { detail?: string };
            throw new Error(errData.detail || `Submit failed: ${submitResponse.status} ${submitResponse.statusText}`);
          }

          const submitData = await submitResponse.json() as {
            swarm_id: string;
            total_tasks: number;
            max_concurrent: number;
            root_tasks: string[];
            max_depth: number;
          };

          const swarmId = submitData.swarm_id;
          console.log(`[swarm_execute] Swarm created: ${swarmId} (${submitData.total_tasks} tasks, depth=${submitData.max_depth})`);

          // 2. Poll for completion
          let pollCount = 0;
          let lastLog = '';

          while (pollCount < MAX_POLL_ATTEMPTS) {
            if (signal?.aborted) {
              // Try to cancel the swarm
              await authFetch(`${apiBase}/v1/internal/swarm/${swarmId}/cancel`, {
                method: 'POST',
              }).catch(() => {});
              throw new Error('Aborted');
            }

            await new Promise(resolve => setTimeout(resolve, POLL_INTERVAL_MS));
            pollCount++;

            const stateResponse = await authFetch(`${apiBase}/v1/internal/swarm/${swarmId}`, { signal });
            if (!stateResponse.ok) {
              console.warn(`[swarm_execute] Failed to poll swarm ${swarmId}: ${stateResponse.status}`);
              continue;
            }

            const state = await stateResponse.json() as {
              swarm_id: string;
              status: string;
              tasks: Array<{
                key: string;
                title: string;
                status: string;
                run_id?: string;
                outputs?: Record<string, string>;
                error?: string;
                started_at?: number;
                completed_at?: number;
              }>;
              active_count: number;
              completed_count: number;
              failed_count: number;
              total_count: number;
            };

            // Log progress periodically
            const progressLog = `${state.completed_count + state.failed_count}/${state.total_count} done, ${state.active_count} active`;
            if (progressLog !== lastLog) {
              console.log(`[swarm_execute] Progress: ${progressLog}`);
              lastLog = progressLog;
            }

            if (state.status === 'completed' || state.status === 'failed' || state.status === 'cancelled') {
              return formatSwarmResult(state);
            }
          }

          // Timeout
          return {
            content: [{
              type: 'text',
              text: `## Swarm Result: TIMEOUT\n**Swarm ID**: ${swarmId}\n\nThe swarm did not complete within the polling window. Some tasks may still be running. Check the dashboard for status.`,
            }],
            details: {},
          };

        } catch (err) {
          const errMsg = err instanceof Error ? err.message : String(err);
          console.error(`[swarm_execute] Error:`, errMsg);
          return {
            content: [{
              type: 'text',
              text: `## Swarm Execute Failed\n**Error**: ${errMsg}\n\nCould not execute swarm. Check that all tasks exist and projects have repositories configured.`,
            }],
            details: {},
          };
        }
      },
    },
  ];
}

// ── Result Formatting ─────────────────────────────────────────────────────

function formatSwarmResult(state: {
  swarm_id: string;
  status: string;
  tasks: Array<{
    key: string;
    title: string;
    status: string;
    run_id?: string;
    outputs?: Record<string, string>;
    error?: string;
    started_at?: number;
    completed_at?: number;
  }>;
  active_count: number;
  completed_count: number;
  failed_count: number;
  total_count: number;
}): AgentToolResult<VoidDetails> {
  const lines: string[] = [];

  const allSuccess = state.failed_count === 0 && state.status === 'completed';
  lines.push(`## Swarm Result: ${allSuccess ? 'SUCCESS' : 'PARTIAL / FAILED'}`);
  lines.push(`**Swarm ID**: ${state.swarm_id}`);
  lines.push(`**Status**: ${state.status}`);
  lines.push(`**Tasks**: ${state.completed_count} completed, ${state.failed_count} failed, ${state.total_count} total`);
  lines.push('');

  // Group tasks by status
  const completed = state.tasks.filter(t => t.status === 'completed');
  const failed = state.tasks.filter(t => t.status === 'failed');
  const skipped = state.tasks.filter(t => t.status === 'skipped');
  const cancelled = state.tasks.filter(t => t.status === 'cancelled');

  if (completed.length > 0) {
    lines.push('### Completed Tasks');
    for (const t of completed) {
      const duration = t.started_at && t.completed_at
        ? `${Math.round((t.completed_at - t.started_at) / 1000)}s`
        : 'unknown';
      lines.push(`\n**${t.title}** (${t.key}) — ${duration}`);
      if (t.outputs?.commit_hashes) lines.push(`  Commits: ${t.outputs.commit_hashes}`);
      if (t.outputs?.files_changed) lines.push(`  Files: ${t.outputs.files_changed}`);
      if (t.outputs?.summary) lines.push(`  Summary: ${t.outputs.summary}`);
      if (t.outputs?.deviations) lines.push(`  Deviations: ${t.outputs.deviations}`);
    }
    lines.push('');
  }

  if (failed.length > 0) {
    lines.push('### Failed Tasks');
    for (const t of failed) {
      lines.push(`\n**${t.title}** (${t.key})`);
      lines.push(`  Error: ${t.error || 'Unknown'}`);
      if (t.outputs?.blocked_by) lines.push(`  Blocked by (Rule 4): ${t.outputs.blocked_by}`);
      if (t.run_id) lines.push(`  Run ID: ${t.run_id}`);
    }
    lines.push('');
  }

  if (skipped.length > 0) {
    lines.push('### Skipped Tasks (dependency failed)');
    for (const t of skipped) {
      lines.push(`- **${t.title}** (${t.key})`);
    }
    lines.push('');
  }

  if (cancelled.length > 0) {
    lines.push('### Cancelled Tasks');
    for (const t of cancelled) {
      lines.push(`- **${t.title}** (${t.key})`);
    }
    lines.push('');
  }

  // Action guidance for the planner
  if (failed.length > 0) {
    lines.push('### Recommended Actions');
    for (const t of failed) {
      if (t.outputs?.blocked_by) {
        lines.push(`- **${t.key}**: Review the architectural blocker and decide how to proceed`);
      } else {
        lines.push(`- **${t.key}**: Investigate failure and retry with a revised execution prompt`);
      }
    }
    if (skipped.length > 0) {
      lines.push(`- Re-run skipped tasks after fixing their failed dependencies`);
    }
  }

  return {
    content: [{ type: 'text', text: lines.join('\n') }],
    details: {},
  };
}
