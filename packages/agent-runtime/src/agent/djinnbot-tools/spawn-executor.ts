import { Type, type Static } from '@sinclair/typebox';
import type { AgentTool, AgentToolResult, AgentToolUpdateCallback } from '@mariozechner/pi-agent-core';
import type { RedisPublisher } from '../../redis/publisher.js';
import type { RequestIdRef } from '../runner.js';
import { authFetch } from '../../api/auth-fetch.js';

// ── Schemas ────────────────────────────────────────────────────────────────

const SpawnExecutorParamsSchema = Type.Object({
  projectId: Type.String({ description: 'Project ID containing the task' }),
  taskId: Type.String({ description: 'Task ID being executed' }),
  executionPrompt: Type.String({
    description:
      'The complete execution prompt you have written for the executor. ' +
      'This should include: what to build, which files to read/modify, ' +
      'acceptance criteria, and verification steps. ' +
      'The executor gets ONLY this prompt in a fresh context window — ' +
      'write it as if briefing a skilled engineer who has zero prior context.',
  }),
  model: Type.Optional(Type.String({
    description:
      'Override the executor model. Defaults to your executor_model from config. ' +
      'Use a fast/cheap model for straightforward tasks, a strong model for complex ones.',
  })),
  timeoutSeconds: Type.Optional(Type.Number({
    description: 'Max execution time in seconds. Default: 300 (5 min). Max: 600 (10 min).',
  })),
});
type SpawnExecutorParams = Static<typeof SpawnExecutorParamsSchema>;

// ── Types ──────────────────────────────────────────────────────────────────

interface VoidDetails {}

export interface SpawnExecutorToolsConfig {
  publisher: RedisPublisher;
  requestIdRef: RequestIdRef;
  agentId: string;
  apiBaseUrl?: string;
}

// ── Constants ──────────────────────────────────────────────────────────────

const DEFAULT_TIMEOUT_SECONDS = 300;
const MAX_TIMEOUT_SECONDS = 600;
const POLL_INTERVAL_MS = 2000;

// ── Deviation rules injected into every executor's system context ──────────

const EXECUTOR_DEVIATION_RULES = `
## Deviation Rules (Always Active)

You are an executor agent. Follow the task prompt precisely. These rules govern
how you handle unexpected situations during implementation.

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

// ── Tool factory ───────────────────────────────────────────────────────────

export function createSpawnExecutorTools(config: SpawnExecutorToolsConfig): AgentTool[] {
  const { agentId } = config;

  const getApiBase = () =>
    config.apiBaseUrl || process.env.DJINNBOT_API_URL || 'http://api:8000';

  return [
    {
      name: 'spawn_executor',
      description:
        'Spawn a fresh agent instance to execute a task with a clean context window. ' +
        'YOU (the planner) write a thorough execution prompt, and the executor gets ONLY ' +
        'that prompt — no conversation history, no context pollution. ' +
        'Use this for any implementation work. The executor runs in a separate container ' +
        'with the task\'s git workspace already set up. ' +
        'This call blocks until the executor finishes (up to timeout). ' +
        'Returns the executor\'s result including commit hashes and any deviations.',
      label: 'spawn_executor',
      parameters: SpawnExecutorParamsSchema,
      execute: async (
        _toolCallId: string,
        params: unknown,
        signal?: AbortSignal,
        _onUpdate?: AgentToolUpdateCallback<VoidDetails>,
      ): Promise<AgentToolResult<VoidDetails>> => {
        const p = params as SpawnExecutorParams;
        const apiBase = getApiBase();
        const timeout = Math.min(p.timeoutSeconds ?? DEFAULT_TIMEOUT_SECONDS, MAX_TIMEOUT_SECONDS);

        try {
          // 1. Call the spawn-executor API endpoint which creates a run and dispatches it
          console.log(`[spawn_executor] Spawning executor for task ${p.taskId} (timeout: ${timeout}s)`);

          const spawnResponse = await authFetch(`${apiBase}/v1/internal/spawn-executor`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              agent_id: agentId,
              project_id: p.projectId,
              task_id: p.taskId,
              execution_prompt: p.executionPrompt,
              deviation_rules: EXECUTOR_DEVIATION_RULES,
              model_override: p.model || process.env.EXECUTOR_MODEL || undefined,
              timeout_seconds: timeout,
            }),
            signal,
          });

          if (!spawnResponse.ok) {
            const errData = await spawnResponse.json().catch(() => ({})) as { detail?: string };
            throw new Error(errData.detail || `Spawn failed: ${spawnResponse.status} ${spawnResponse.statusText}`);
          }

          const spawnData = await spawnResponse.json() as { run_id: string };
          const runId = spawnData.run_id;
          console.log(`[spawn_executor] Executor run created: ${runId}`);

          // 2. Poll for completion
          const deadline = Date.now() + (timeout * 1000) + 30_000; // Extra 30s buffer for startup
          let lastStatus = 'pending';

          while (Date.now() < deadline) {
            if (signal?.aborted) {
              throw new Error('Aborted');
            }

            await new Promise(resolve => setTimeout(resolve, POLL_INTERVAL_MS));

            const statusResponse = await authFetch(`${apiBase}/v1/runs/${runId}`, { signal });
            if (!statusResponse.ok) {
              console.warn(`[spawn_executor] Failed to poll run ${runId}: ${statusResponse.status}`);
              continue;
            }

            const runData = await statusResponse.json() as {
              status: string;
              outputs?: Record<string, string>;
              error?: string;
            };

            lastStatus = runData.status;

            if (runData.status === 'completed') {
              console.log(`[spawn_executor] Executor completed successfully: ${runId}`);
              const outputs = runData.outputs || {};

              // Format the result for the planner
              const resultParts = [
                `## Executor Result: SUCCESS`,
                `**Run ID**: ${runId}`,
              ];

              if (outputs.status) resultParts.push(`**Status**: ${outputs.status}`);
              if (outputs.commit_hashes) resultParts.push(`**Commits**: ${outputs.commit_hashes}`);
              if (outputs.files_changed) resultParts.push(`**Files Changed**: ${outputs.files_changed}`);
              if (outputs.summary) resultParts.push(`**Summary**: ${outputs.summary}`);
              if (outputs.deviations) resultParts.push(`\n### Deviations\n${outputs.deviations}`);
              if (outputs.blocked_by) resultParts.push(`\n### Blocked By (Rule 4)\n${outputs.blocked_by}`);

              // Include raw output if no structured outputs were captured
              if (Object.keys(outputs).length === 0) {
                resultParts.push(`\n### Raw Output\n(No structured outputs captured. The executor may not have called complete().)`);
              }

              return {
                content: [{ type: 'text', text: resultParts.join('\n') }],
                details: {},
              };
            }

            if (runData.status === 'failed') {
              console.log(`[spawn_executor] Executor failed: ${runId}`);
              const error = runData.error || 'Unknown error';
              const outputs = runData.outputs || {};

              const resultParts = [
                `## Executor Result: FAILED`,
                `**Run ID**: ${runId}`,
                `**Error**: ${error}`,
              ];

              if (outputs.blocked_by) {
                resultParts.push(`\n### Architectural Blocker (Rule 4)\n${outputs.blocked_by}`);
                resultParts.push(`\nThe executor stopped because it encountered an architectural decision that requires your judgment. Review the blocker and decide how to proceed.`);
              }

              if (outputs.deviations) resultParts.push(`\n### Deviations Before Failure\n${outputs.deviations}`);

              return {
                content: [{ type: 'text', text: resultParts.join('\n') }],
                details: {},
              };
            }

            // Still running — continue polling
          }

          // Timeout
          return {
            content: [{
              type: 'text',
              text: `## Executor Result: TIMEOUT\n**Run ID**: ${runId}\n**Last Status**: ${lastStatus}\n\nThe executor did not complete within ${timeout} seconds. The work may be partially done — check the task branch for commits.`,
            }],
            details: {},
          };

        } catch (err) {
          const errMsg = err instanceof Error ? err.message : String(err);
          console.error(`[spawn_executor] Error:`, errMsg);
          return {
            content: [{
              type: 'text',
              text: `## Executor Spawn Failed\n**Error**: ${errMsg}\n\nCould not spawn executor. Check that the task exists and the project has a repository configured.`,
            }],
            details: {},
          };
        }
      },
    },
  ];
}
