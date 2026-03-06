import { Type, type Static } from '@sinclair/typebox';
import type { AgentTool, AgentToolResult } from '@mariozechner/pi-agent-core';
import { authFetch } from '../../api/auth-fetch.js';

// ── Schemas ────────────────────────────────────────────────────────────────

const ExecutorCompleteParamsSchema = Type.Object({
  status: Type.String({
    description: 'Completion status: "success" (all work done) or "partial" (some work done, notes in deviations)',
  }),
  commit_hashes: Type.String({
    description: 'Comma-separated list of git commit SHAs you created. Empty string if no commits.',
  }),
  files_changed: Type.String({
    description: 'Comma-separated list of files you modified. Empty string if no files changed.',
  }),
  deviations: Type.Optional(Type.String({
    description: 'Description of any auto-fixes applied (Rules 1-3) or empty string if none.',
  })),
  blocked_by: Type.Optional(Type.String({
    description: 'Description of any architectural blockers encountered (Rule 4) or empty string.',
  })),
  summary: Type.String({
    description: 'One-sentence summary of what you accomplished.',
  }),
});
type ExecutorCompleteParams = Static<typeof ExecutorCompleteParamsSchema>;

const ExecutorFailParamsSchema = Type.Object({
  error: Type.String({
    description: 'What went wrong — clear, actionable description.',
  }),
  details: Type.Optional(Type.String({
    description: 'Additional context: stack traces, file paths, what you tried.',
  })),
  blocked_by: Type.Optional(Type.String({
    description: 'Architectural blocker that requires planner judgment (Rule 4).',
  })),
  deviations: Type.Optional(Type.String({
    description: 'Any auto-fixes applied before the failure.',
  })),
  commit_hashes: Type.Optional(Type.String({
    description: 'Commits made before the failure (partial work). Empty string if none.',
  })),
});
type ExecutorFailParams = Static<typeof ExecutorFailParamsSchema>;

// ── Types ──────────────────────────────────────────────────────────────────

interface VoidDetails {}

export interface ExecutorControlToolsConfig {
  onComplete: (outputs: Record<string, string>, summary?: string) => void;
  onFail: (error: string, details?: string) => void;
  apiBaseUrl: string;
  /** The DB run ID (from RUN_ID env var). Used to store outputs on the Run record. */
  runId: string;
}

// ── Tool factory ───────────────────────────────────────────────────────────

export function createExecutorControlTools(config: ExecutorControlToolsConfig): AgentTool[] {
  const { onComplete, onFail, apiBaseUrl, runId } = config;

  return [
    {
      name: 'executor_complete',
      description:
        'Signal that your execution work is done. This stores your structured results ' +
        '(commit hashes, files changed, summary) on the run record so the planner can ' +
        'read them, then ends your session. ALWAYS call this when you finish your work ' +
        'successfully. Make sure you have committed and pushed all changes before calling this.',
      label: 'executor_complete',
      parameters: ExecutorCompleteParamsSchema,
      execute: async (
        _toolCallId: string,
        params: unknown,
        signal?: AbortSignal,
      ): Promise<AgentToolResult<VoidDetails>> => {
        const p = params as ExecutorCompleteParams;

        const outputs: Record<string, string> = {
          status: p.status,
          commit_hashes: p.commit_hashes,
          files_changed: p.files_changed,
          deviations: p.deviations || '',
          blocked_by: p.blocked_by || '',
          summary: p.summary,
        };

        // Store outputs on the Run record so the planner can read them via polling
        try {
          await authFetch(`${apiBaseUrl}/v1/internal/executor-result`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              run_id: runId,
              success: true,
              outputs,
            }),
            signal,
          });
        } catch (err) {
          console.error(`[executor_complete] Failed to store outputs on run ${runId}:`, err);
          // Continue — session end is more important than persisting outputs
        }

        // Signal session end via the runner's onComplete callback
        onComplete(outputs, p.summary);

        return {
          content: [{
            type: 'text',
            text: `Executor completed. Results stored on run ${runId}.\n\nStatus: ${p.status}\nSummary: ${p.summary}`,
          }],
          details: {},
        };
      },
    },

    {
      name: 'executor_fail',
      description:
        'Signal that your execution work has failed or hit an architectural blocker. ' +
        'This stores the error details on the run record and ends your session. ' +
        'Call this when you encounter a Rule 4 stopper (needs architectural decision), ' +
        'when you cannot complete the task after multiple attempts, or when something ' +
        'is fundamentally broken. Include any partial commits you made.',
      label: 'executor_fail',
      parameters: ExecutorFailParamsSchema,
      execute: async (
        _toolCallId: string,
        params: unknown,
        signal?: AbortSignal,
      ): Promise<AgentToolResult<VoidDetails>> => {
        const p = params as ExecutorFailParams;

        const outputs: Record<string, string> = {
          error: p.error,
          details: p.details || '',
          blocked_by: p.blocked_by || '',
          deviations: p.deviations || '',
          commit_hashes: p.commit_hashes || '',
        };

        // Store error + outputs on the Run record
        try {
          await authFetch(`${apiBaseUrl}/v1/internal/executor-result`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              run_id: runId,
              success: false,
              error: p.error,
              outputs,
            }),
            signal,
          });
        } catch (err) {
          console.error(`[executor_fail] Failed to store error on run ${runId}:`, err);
        }

        // Signal session end via the runner's onFail callback
        onFail(p.error, p.details);

        return {
          content: [{
            type: 'text',
            text: `Executor failed. Error stored on run ${runId}.\n\nError: ${p.error}`,
          }],
          details: {},
        };
      },
    },
  ];
}
