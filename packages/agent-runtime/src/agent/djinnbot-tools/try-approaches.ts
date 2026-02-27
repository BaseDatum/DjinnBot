/**
 * try_approaches — Speculative multi-path execution with evaluation.
 *
 * The missing tier in the execution hierarchy:
 *
 *   focused_analysis  (3-30s, cheap, analytical only, no tools)
 *         ↓
 *   spawn_executor    (5-10min, full container, single task)
 *         ↓
 *   swarm_execute     (parallel DAG of cooperating tasks)
 *         ↓
 *   try_approaches    (parallel COMPETING approaches, auto-evaluated)
 *
 * Unlike swarm_execute (which models cooperating tasks in a dependency DAG),
 * try_approaches forks execution into N **competing** approaches that run in
 * parallel isolation, then evaluates results against stated criteria and
 * selects the winner.
 *
 * This addresses the fundamental LLM failure mode: premature commitment to
 * one path. Instead of reasoning sequentially and sunk-costing into a single
 * approach, the planner can explore uncertainty in parallel and let evidence
 * determine the best path.
 *
 * Implementation: each approach spawns a fresh executor container with its own
 * git branch. After all complete, a focused_analysis evaluation call scores
 * each against the criteria. The winning branch is identified for the planner
 * to merge/rebase.
 */

import { Type, type Static } from '@sinclair/typebox';
import type { AgentTool, AgentToolResult, AgentToolUpdateCallback } from '@mariozechner/pi-agent-core';
import type { RedisPublisher } from '../../redis/publisher.js';
import type { RequestIdRef } from '../runner.js';
import { authFetch } from '../../api/auth-fetch.js';
import { focusedAnalysis } from '@djinnbot/core';
import { logToolLlmCall } from './log-tool-llm-call.js';

// ── Schemas ────────────────────────────────────────────────────────────────

const ApproachSchema = Type.Object({
  key: Type.String({
    description:
      'Unique identifier for this approach (e.g. "adapter-pattern", "strategy-v1"). ' +
      'Used as branch suffix and in evaluation results.',
  }),
  title: Type.String({ description: 'Short human-readable title (e.g. "Adapter Pattern approach")' }),
  executionPrompt: Type.String({
    description:
      'The complete execution prompt for this approach. Write it as if briefing ' +
      'a skilled engineer with zero prior context. Each approach should take a ' +
      'meaningfully DIFFERENT strategy — not just cosmetic variations. ' +
      'Include: the specific approach/pattern to use, which files to modify, ' +
      'acceptance criteria, and verification steps.',
  }),
  model: Type.Optional(Type.String({
    description: 'Override the executor model for this approach',
  })),
  timeoutSeconds: Type.Optional(Type.Number({
    description: 'Timeout for this approach in seconds (default: 300, max: 600)',
  })),
});

const TryApproachesParamsSchema = Type.Object({
  projectId: Type.String({ description: 'Project ID containing the task' }),
  taskId: Type.String({ description: 'Task ID being worked on' }),
  approaches: Type.Array(ApproachSchema, {
    minItems: 2,
    maxItems: 5,
    description:
      'Two to five competing approaches to try in parallel. Each runs in an ' +
      'isolated container with its own git branch. Approaches should represent ' +
      'genuinely different strategies — e.g. different design patterns, ' +
      'different libraries, different algorithms, or different architectures.',
  }),
  evaluationCriteria: Type.String({
    description:
      'How to judge which approach is best. Be specific and measurable — ' +
      'e.g. "1) All tests pass 2) Fewer files changed 3) No new dependencies 4) ' +
      'Cleaner separation of concerns". The evaluation model will score each ' +
      'approach against these criteria and pick a winner.',
  }),
  evaluationModel: Type.Optional(Type.String({
    description:
      'Model for the evaluation step (default: anthropic/claude-sonnet-4). ' +
      'Use a strong model for nuanced architectural decisions, a fast model ' +
      'for simple pass/fail criteria.',
  })),
  globalTimeoutSeconds: Type.Optional(Type.Number({
    description:
      'Timeout for the entire speculative execution in seconds. ' +
      'Default: 900 (15 min). Max: 1800 (30 min).',
  })),
});
type TryApproachesParams = Static<typeof TryApproachesParamsSchema>;

// ── Types ──────────────────────────────────────────────────────────────────

interface VoidDetails {}

export interface TryApproachesToolsConfig {
  publisher: RedisPublisher;
  requestIdRef: RequestIdRef;
  agentId: string;
  apiBaseUrl?: string;
}

// ── Deviation rules tailored for speculative approaches ───────────────────

const APPROACH_EXECUTOR_RULES = `
## Deviation Rules (Always Active)

You are an executor agent testing ONE specific approach to a problem.
Other approaches are being tried in parallel. Follow the task prompt precisely.

### Rule 1: Auto-fix bugs
**Trigger:** Code doesn't work as intended (errors, wrong output, type errors)
**Action:** Fix inline. Commit with prefix "fix:".
**Track:** Note in your completion report.

### Rule 2: Auto-fix blockers
**Trigger:** Missing dependency, broken import, wrong types, build config error
**Action:** Fix the blocker. Commit with prefix "chore:".
**Track:** Note in your completion report.

### Rule 3: STOP if approach is fundamentally unworkable
**Trigger:** The specific approach assigned to you (not the task itself) turns out to
be technically infeasible — e.g. a library doesn't support the needed feature,
the pattern doesn't apply to the data model, or it would require rewriting
unrelated subsystems.
**Action:** Call fail() with a clear explanation of WHY this approach doesn't work.
This is valuable signal — it tells the planner which strategies to rule out.

### Rule 4: Stay in scope
You are testing a SPECIFIC approach. Do not deviate to a different strategy
even if you think it would be better. The whole point is to test THIS approach
faithfully so it can be compared against alternatives.

### Limits
- **Max 3 auto-fix attempts per issue.**
- **Only fix issues caused by YOUR changes.**

### Completion Protocol
When done, call complete() with outputs including:
- \`status\`: "success" or "partial"
- \`commit_hashes\`: comma-separated list of your commit SHAs
- \`files_changed\`: comma-separated list of files you modified
- \`test_results\`: summary of test outcomes (pass/fail counts, any failures)
- \`approach_notes\`: observations about this approach's strengths/weaknesses
- \`summary\`: one-sentence summary of what you accomplished
`.trim();

// ── Constants ──────────────────────────────────────────────────────────────

const DEFAULT_TIMEOUT_SECONDS = 300;
const MAX_APPROACH_TIMEOUT_SECONDS = 600;
const DEFAULT_GLOBAL_TIMEOUT_SECONDS = 900;
const MAX_GLOBAL_TIMEOUT_SECONDS = 1800;
const POLL_INTERVAL_MS = 3000;
const EVALUATION_TIMEOUT_MS = 120_000; // 2 min for the focused_analysis evaluation

// ── Tool factory ───────────────────────────────────────────────────────────

export function createTryApproachesTools(config: TryApproachesToolsConfig): AgentTool[] {
  const { publisher, requestIdRef, agentId } = config;

  const getApiBase = () =>
    config.apiBaseUrl || process.env.DJINNBOT_API_URL || 'http://api:8000';

  return [
    {
      name: 'try_approaches',
      description:
        'Execute multiple COMPETING approaches to a task in parallel and auto-select the best one. ' +
        'Each approach runs in an isolated container with its own git branch. ' +
        'After all complete, an evaluation model scores each against your criteria and picks a winner.\n\n' +
        'Use this when you are UNCERTAIN which approach is best:\n' +
        '  - "Should we use adapter pattern or strategy pattern for this refactor?"\n' +
        '  - "Would it be better to use a SQL query or an in-memory cache here?"\n' +
        '  - "Should we restructure the module hierarchy or add a facade?"\n\n' +
        'This is DIFFERENT from swarm_execute:\n' +
        '  - swarm_execute = cooperating tasks in a dependency DAG (do A then B)\n' +
        '  - try_approaches = competing alternatives in parallel (try A vs B, pick best)\n\n' +
        'Requires 2-5 approaches. Each should represent a genuinely different strategy. ' +
        'Returns the evaluation with scores, the winning approach key, and branch info ' +
        'so you can merge the winner into the task branch.\n\n' +
        'TIP: Include test execution in your prompts ("run tests and report results") ' +
        'so the evaluation has concrete pass/fail data to work with.',
      label: 'try_approaches',
      parameters: TryApproachesParamsSchema,
      execute: async (
        _toolCallId: string,
        params: unknown,
        signal?: AbortSignal,
        _onUpdate?: AgentToolUpdateCallback<VoidDetails>,
      ): Promise<AgentToolResult<VoidDetails>> => {
        const p = params as TryApproachesParams;
        const apiBase = getApiBase();
        const globalTimeout = Math.min(
          p.globalTimeoutSeconds ?? DEFAULT_GLOBAL_TIMEOUT_SECONDS,
          MAX_GLOBAL_TIMEOUT_SECONDS,
        );

        try {
          // ── 1. Submit speculative execution to the API ──────────────────
          console.log(
            `[try_approaches] Submitting ${p.approaches.length} approaches for task ${p.taskId}`,
          );

          const submitResponse = await authFetch(`${apiBase}/v1/internal/try-approaches`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              agent_id: agentId,
              project_id: p.projectId,
              task_id: p.taskId,
              approaches: p.approaches.map(a => ({
                key: a.key,
                title: a.title,
                execution_prompt: a.executionPrompt,
                model: a.model || process.env.EXECUTOR_MODEL || undefined,
                timeout_seconds: Math.min(
                  a.timeoutSeconds ?? DEFAULT_TIMEOUT_SECONDS,
                  MAX_APPROACH_TIMEOUT_SECONDS,
                ),
              })),
              evaluation_criteria: p.evaluationCriteria,
              deviation_rules: APPROACH_EXECUTOR_RULES,
              global_timeout_seconds: globalTimeout,
            }),
            signal,
          });

          if (!submitResponse.ok) {
            const errData = await submitResponse.json().catch(() => ({})) as { detail?: string };
            throw new Error(
              errData.detail || `Submit failed: ${submitResponse.status} ${submitResponse.statusText}`,
            );
          }

          const submitData = await submitResponse.json() as {
            speculation_id: string;
            approach_count: number;
            approach_run_ids: Record<string, string>;
            approach_branches: Record<string, string>;
          };

          const speculationId = submitData.speculation_id;
          console.log(
            `[try_approaches] Speculation created: ${speculationId} ` +
            `(${submitData.approach_count} approaches)`,
          );

          // ── 2. Poll all approach runs until completion ──────────────────
          const deadline = Date.now() + (globalTimeout * 1000) + 30_000;
          const runIds = submitData.approach_run_ids; // key → run_id
          const branches = submitData.approach_branches; // key → branch name

          interface ApproachResult {
            key: string;
            title: string;
            status: 'completed' | 'failed' | 'timeout' | 'running';
            runId: string;
            branch: string;
            outputs: Record<string, string>;
            error?: string;
            durationSeconds?: number;
          }

          const results = new Map<string, ApproachResult>();

          // Initialize tracking for all approaches
          for (const approach of p.approaches) {
            results.set(approach.key, {
              key: approach.key,
              title: approach.title,
              status: 'running',
              runId: runIds[approach.key] || '',
              branch: branches[approach.key] || '',
              outputs: {},
            });
          }

          // Poll until all finish or timeout
          let lastProgressLog = '';
          while (Date.now() < deadline) {
            if (signal?.aborted) throw new Error('Aborted');

            // Check if all approaches have terminal status
            const allDone = [...results.values()].every(
              r => r.status !== 'running',
            );
            if (allDone) break;

            await new Promise(resolve => setTimeout(resolve, POLL_INTERVAL_MS));

            // Poll each still-running approach
            for (const [key, result] of results) {
              if (result.status !== 'running') continue;

              try {
                const statusResponse = await authFetch(
                  `${apiBase}/v1/runs/${result.runId}`,
                  { signal },
                );
                if (!statusResponse.ok) continue;

                const runData = await statusResponse.json() as {
                  status: string;
                  outputs?: Record<string, string>;
                  error?: string;
                  created_at?: number;
                  completed_at?: number;
                };

                if (runData.status === 'completed') {
                  result.status = 'completed';
                  result.outputs = runData.outputs || {};
                  if (runData.created_at && runData.completed_at) {
                    result.durationSeconds = Math.round(
                      (runData.completed_at - runData.created_at) / 1000,
                    );
                  }
                  console.log(`[try_approaches] Approach "${key}" completed`);
                } else if (runData.status === 'failed') {
                  result.status = 'failed';
                  result.outputs = runData.outputs || {};
                  result.error = runData.error || 'Unknown error';
                  console.log(`[try_approaches] Approach "${key}" failed: ${result.error}`);
                }
              } catch {
                // Transient poll error — retry next cycle
              }
            }

            // Log progress
            const running = [...results.values()].filter(r => r.status === 'running').length;
            const done = [...results.values()].filter(r => r.status !== 'running').length;
            const progressLog = `${done}/${p.approaches.length} done, ${running} running`;
            if (progressLog !== lastProgressLog) {
              console.log(`[try_approaches] Progress: ${progressLog}`);
              lastProgressLog = progressLog;
            }
          }

          // Mark any still-running approaches as timed out
          for (const result of results.values()) {
            if (result.status === 'running') {
              result.status = 'timeout';
              result.error = 'Timed out waiting for completion';
            }
          }

          // ── 3. Evaluate approaches ─────────────────────────────────────
          const completedApproaches = [...results.values()].filter(
            r => r.status === 'completed',
          );

          let evaluation: {
            winner: string | null;
            reasoning: string;
            scores: Record<string, { score: number; reasoning: string }>;
            model: string;
          };

          if (completedApproaches.length === 0) {
            // No approaches succeeded — skip evaluation
            evaluation = {
              winner: null,
              reasoning: 'No approaches completed successfully. All failed or timed out.',
              scores: {},
              model: 'none',
            };
          } else if (completedApproaches.length === 1) {
            // Only one completed — it wins by default
            const only = completedApproaches[0];
            evaluation = {
              winner: only.key,
              reasoning: `Only "${only.title}" completed successfully. It wins by default.`,
              scores: {
                [only.key]: { score: 1.0, reasoning: 'Only completed approach' },
              },
              model: 'none',
            };
          } else {
            // Multiple completed — use focused_analysis to evaluate
            console.log(
              `[try_approaches] Evaluating ${completedApproaches.length} completed approaches`,
            );

            evaluation = await evaluateApproaches(
              agentId,
              p.evaluationCriteria,
              completedApproaches,
              [...results.values()].filter(r => r.status === 'failed'),
              p.evaluationModel || 'anthropic/claude-sonnet-4',
              signal,
            );
          }

          // ── 4. Format and return results ────────────────────────────────
          return formatSpeculationResult(
            speculationId,
            p.evaluationCriteria,
            [...results.values()],
            evaluation,
          );

        } catch (err) {
          const errMsg = err instanceof Error ? err.message : String(err);
          console.error(`[try_approaches] Error:`, errMsg);
          return {
            content: [{
              type: 'text',
              text:
                `## Speculative Execution Failed\n**Error**: ${errMsg}\n\n` +
                `Could not execute approaches. Check that the task exists and ` +
                `the project has a repository configured.`,
            }],
            details: {},
          };
        }
      },
    },
  ];
}

// ── Evaluation via focused_analysis ───────────────────────────────────────

async function evaluateApproaches(
  agentId: string,
  criteria: string,
  completed: Array<{
    key: string;
    title: string;
    outputs: Record<string, string>;
    branch: string;
    durationSeconds?: number;
  }>,
  failed: Array<{
    key: string;
    title: string;
    error?: string;
  }>,
  evaluationModel: string,
  signal?: AbortSignal,
): Promise<{
  winner: string | null;
  reasoning: string;
  scores: Record<string, { score: number; reasoning: string }>;
  model: string;
}> {
  // Build the evaluation prompt with all approach outputs
  const approachSections = completed.map(a => {
    const lines = [
      `### Approach: "${a.title}" (key: ${a.key})`,
      `Branch: ${a.branch}`,
    ];
    if (a.durationSeconds) lines.push(`Duration: ${a.durationSeconds}s`);
    if (a.outputs.summary) lines.push(`Summary: ${a.outputs.summary}`);
    if (a.outputs.commit_hashes) lines.push(`Commits: ${a.outputs.commit_hashes}`);
    if (a.outputs.files_changed) lines.push(`Files changed: ${a.outputs.files_changed}`);
    if (a.outputs.test_results) lines.push(`Test results: ${a.outputs.test_results}`);
    if (a.outputs.approach_notes) lines.push(`Approach notes: ${a.outputs.approach_notes}`);
    if (a.outputs.deviations) lines.push(`Deviations: ${a.outputs.deviations}`);
    if (a.outputs.status) lines.push(`Status: ${a.outputs.status}`);
    return lines.join('\n');
  });

  const failedSection = failed.length > 0
    ? '\n\n## Failed Approaches (for context)\n' +
      failed.map(f =>
        `- "${f.title}" (${f.key}): ${f.error || 'unknown error'}`,
      ).join('\n')
    : '';

  const evaluationPrompt =
    `You are evaluating ${completed.length} competing approaches to a software task.\n\n` +
    `## Evaluation Criteria\n${criteria}\n\n` +
    `## Completed Approaches\n${approachSections.join('\n\n')}` +
    `${failedSection}\n\n` +
    `## Instructions\n` +
    `Score each completed approach on a scale of 0.0 to 1.0 against the evaluation criteria.\n` +
    `Then select the BEST approach as the winner.\n\n` +
    `Respond in EXACTLY this JSON format (no markdown fences, no extra text):\n` +
    `{\n` +
    `  "winner": "<key of the winning approach>",\n` +
    `  "reasoning": "<2-3 sentence explanation of why this approach won>",\n` +
    `  "scores": {\n` +
    `    "<approach-key>": {\n` +
    `      "score": <0.0 to 1.0>,\n` +
    `      "reasoning": "<1 sentence per-approach reasoning>"\n` +
    `    }\n` +
    `  }\n` +
    `}`;

  try {
    // Use focusedAnalysis from @djinnbot/core (direct OpenRouter call, no API hop)
    const result = await focusedAnalysis({
      prompt: evaluationPrompt,
      model: evaluationModel,
      maxTokens: 2048,
      systemPrompt:
        'You are a senior engineering evaluator. You objectively score competing ' +
        'implementations against stated criteria. Be precise and evidence-based. ' +
        'Output ONLY valid JSON — no markdown fences, no commentary.',
      signal,
    });

    // Log the evaluation LLM call for cost tracking
    logToolLlmCall({
      agentId,
      model: result.model,
      source: 'try_approaches_eval',
      usage: result.usage,
      durationMs: result.durationMs,
    });

    const evalText = result.content || '';

    // Parse the JSON response — handle potential markdown fences
    let jsonStr = evalText.trim();
    if (jsonStr.startsWith('```')) {
      jsonStr = jsonStr.replace(/^```(?:json)?\s*/, '').replace(/\s*```$/, '');
    }

    try {
      const parsed = JSON.parse(jsonStr) as {
        winner: string;
        reasoning: string;
        scores: Record<string, { score: number; reasoning: string }>;
      };

      // Validate winner is actually a completed approach
      const validKeys = new Set(completed.map(a => a.key));
      if (!validKeys.has(parsed.winner)) {
        console.warn(
          `[try_approaches] Evaluation winner "${parsed.winner}" is not a valid approach key`,
        );
        return fallbackEvaluation(completed);
      }

      return {
        ...parsed,
        model: evaluationModel,
      };
    } catch (parseErr) {
      console.warn(
        `[try_approaches] Failed to parse evaluation JSON: ${parseErr}`,
      );
      return fallbackEvaluation(completed);
    }
  } catch (err) {
    console.warn(`[try_approaches] Evaluation error: ${err}`);
    return fallbackEvaluation(completed);
  }
}

/**
 * Fallback evaluation when the LLM evaluation fails.
 * Picks the approach with the most complete outputs (heuristic).
 */
function fallbackEvaluation(
  completed: Array<{
    key: string;
    title: string;
    outputs: Record<string, string>;
  }>,
): {
  winner: string | null;
  reasoning: string;
  scores: Record<string, { score: number; reasoning: string }>;
  model: string;
} {
  if (completed.length === 0) {
    return { winner: null, reasoning: 'No approaches completed.', scores: {}, model: 'fallback' };
  }

  // Score by completeness of outputs
  const scored = completed.map(a => {
    let score = 0;
    if (a.outputs.status === 'success') score += 0.4;
    if (a.outputs.test_results?.includes('pass')) score += 0.3;
    if (a.outputs.commit_hashes) score += 0.2;
    if (a.outputs.files_changed) score += 0.1;
    return { key: a.key, title: a.title, score };
  });

  scored.sort((a, b) => b.score - a.score);
  const winner = scored[0];

  const scores: Record<string, { score: number; reasoning: string }> = {};
  for (const s of scored) {
    scores[s.key] = {
      score: s.score,
      reasoning: 'Heuristic scoring (LLM evaluation failed)',
    };
  }

  return {
    winner: winner.key,
    reasoning:
      `LLM evaluation failed — fell back to heuristic scoring. ` +
      `"${winner.title}" scored highest based on output completeness. ` +
      `Review the results manually to confirm this is the best approach.`,
    scores,
    model: 'fallback',
  };
}

// ── Result formatting ─────────────────────────────────────────────────────

function formatSpeculationResult(
  speculationId: string,
  criteria: string,
  allResults: Array<{
    key: string;
    title: string;
    status: string;
    branch: string;
    runId: string;
    outputs: Record<string, string>;
    error?: string;
    durationSeconds?: number;
  }>,
  evaluation: {
    winner: string | null;
    reasoning: string;
    scores: Record<string, { score: number; reasoning: string }>;
    model: string;
  },
): AgentToolResult<VoidDetails> {
  const lines: string[] = [];

  const hasWinner = evaluation.winner !== null;
  lines.push(
    `## Speculative Execution: ${hasWinner ? 'WINNER SELECTED' : 'NO WINNER'}`,
  );
  lines.push(`**Speculation ID**: ${speculationId}`);
  lines.push(
    `**Approaches**: ${allResults.length} tried, ` +
    `${allResults.filter(r => r.status === 'completed').length} completed, ` +
    `${allResults.filter(r => r.status === 'failed').length} failed`,
  );
  lines.push('');

  // Winner announcement
  if (evaluation.winner) {
    const winnerResult = allResults.find(r => r.key === evaluation.winner);
    lines.push(`### Winner: "${winnerResult?.title || evaluation.winner}"`);
    lines.push(`**Branch**: \`${winnerResult?.branch || 'unknown'}\``);
    lines.push(`**Reasoning**: ${evaluation.reasoning}`);
    if (winnerResult?.outputs?.commit_hashes) {
      lines.push(`**Commits**: ${winnerResult.outputs.commit_hashes}`);
    }
    if (winnerResult?.outputs?.files_changed) {
      lines.push(`**Files Changed**: ${winnerResult.outputs.files_changed}`);
    }
    lines.push('');
    lines.push(
      `To use this approach, merge or rebase branch \`${winnerResult?.branch}\` ` +
      `into your task branch.`,
    );
    lines.push('');
  } else {
    lines.push(`### No Winner`);
    lines.push(evaluation.reasoning);
    lines.push('');
  }

  // Evaluation scores
  if (Object.keys(evaluation.scores).length > 0) {
    lines.push(`### Evaluation Scores (model: ${evaluation.model})`);
    lines.push(`Criteria: ${criteria}`);
    lines.push('');

    // Sort by score descending
    const sortedScores = Object.entries(evaluation.scores)
      .sort(([, a], [, b]) => b.score - a.score);

    for (const [key, scoreData] of sortedScores) {
      const isWinner = key === evaluation.winner;
      const pct = Math.round(scoreData.score * 100);
      lines.push(
        `- **${key}**: ${pct}%${isWinner ? ' ← WINNER' : ''} — ${scoreData.reasoning}`,
      );
    }
    lines.push('');
  }

  // Per-approach details
  const completed = allResults.filter(r => r.status === 'completed');
  const failed = allResults.filter(r => r.status === 'failed');
  const timedOut = allResults.filter(r => r.status === 'timeout');

  if (completed.length > 0) {
    lines.push('### Completed Approaches');
    for (const a of completed) {
      const duration = a.durationSeconds ? `${a.durationSeconds}s` : 'unknown';
      const isWinner = a.key === evaluation.winner;
      lines.push(`\n**${a.title}** (${a.key})${isWinner ? ' ← WINNER' : ''} — ${duration}`);
      lines.push(`  Branch: \`${a.branch}\``);
      if (a.outputs.commit_hashes) lines.push(`  Commits: ${a.outputs.commit_hashes}`);
      if (a.outputs.files_changed) lines.push(`  Files: ${a.outputs.files_changed}`);
      if (a.outputs.test_results) lines.push(`  Tests: ${a.outputs.test_results}`);
      if (a.outputs.approach_notes) lines.push(`  Notes: ${a.outputs.approach_notes}`);
      if (a.outputs.summary) lines.push(`  Summary: ${a.outputs.summary}`);
    }
    lines.push('');
  }

  if (failed.length > 0) {
    lines.push('### Failed Approaches');
    for (const a of failed) {
      lines.push(`\n**${a.title}** (${a.key})`);
      lines.push(`  Error: ${a.error || 'Unknown'}`);
      if (a.outputs?.approach_notes) lines.push(`  Notes: ${a.outputs.approach_notes}`);
    }
    lines.push('');
  }

  if (timedOut.length > 0) {
    lines.push('### Timed Out Approaches');
    for (const a of timedOut) {
      lines.push(`- **${a.title}** (${a.key}) — run ${a.runId}`);
    }
    lines.push('');
  }

  // Action guidance
  lines.push('### Recommended Next Steps');
  if (evaluation.winner) {
    const winnerResult = allResults.find(r => r.key === evaluation.winner);
    lines.push(
      `1. Review the winning approach's commits on branch \`${winnerResult?.branch}\``,
    );
    lines.push(
      `2. Merge or cherry-pick the winner's commits into the task branch`,
    );
    lines.push(
      `3. Clean up losing approach branches if desired`,
    );
    if (failed.length > 0) {
      lines.push(
        `4. Note: ${failed.length} approach(es) failed — their failure reasons ` +
        `may contain useful information about what NOT to do`,
      );
    }
  } else {
    lines.push(`1. Review why all approaches failed`);
    lines.push(`2. Consider a fundamentally different strategy`);
    lines.push(`3. Or refine the most promising approach and try again`);
  }

  return {
    content: [{ type: 'text', text: lines.join('\n') }],
    details: {},
  };
}
