/**
 * log-tool-llm-call.ts — log an LLM call made by a tool (not the agent's own turns).
 *
 * The runner's logLlmCall only fires for the agent's own pi-agent-core turns.
 * Tools that make their own OpenRouter calls (research, focused_analysis) use
 * this helper to log to the same /v1/internal/llm-calls endpoint so that every
 * LLM call appears in the dashboard, usage tracking, and billing.
 */

import { authFetch } from '../../api/auth-fetch.js';
import { computeOpenRouterCost } from '../openrouter-pricing.js';

export interface ToolLlmCallMeta {
  agentId: string;
  model: string;
  /** Which tool made this call (e.g. 'focused_analysis', 'research'). */
  source: string;
  usage?: {
    promptTokens: number;
    completionTokens: number;
    totalTokens: number;
  };
  durationMs: number;
}

/**
 * Fire-and-forget: log an LLM call made by a tool to the backend.
 * Never throws — logging must never fail the tool.
 */
export function logToolLlmCall(meta: ToolLlmCallMeta): void {
  const apiBaseUrl = process.env.DJINNBOT_API_URL || 'http://api:8000';
  const sessionId = process.env.SESSION_ID || process.env.CHAT_SESSION_ID || undefined;
  const runId = process.env.RUN_ID || undefined;
  const keySource = process.env.KEY_SOURCE || undefined;
  const keyMasked = process.env.KEY_MASKED || undefined;
  const userId = process.env.DJINNBOT_USER_ID || undefined;

  const inputTokens = meta.usage?.promptTokens ?? 0;
  const outputTokens = meta.usage?.completionTokens ?? 0;

  const sendPayload = (
    cost: { input: number; output: number; total: number } | null,
  ) => {
    const payload = {
      session_id: sessionId,
      run_id: runId,
      agent_id: meta.agentId,
      user_id: userId,
      provider: 'openrouter',
      model: meta.model,
      key_source: keySource || 'openrouter',
      key_masked: keyMasked,
      input_tokens: inputTokens,
      output_tokens: outputTokens,
      cache_read_tokens: 0,
      cache_write_tokens: 0,
      total_tokens: meta.usage?.totalTokens ?? 0,
      cost_input: cost?.input || undefined,
      cost_output: cost?.output || undefined,
      cost_total: cost?.total || undefined,
      cost_approximate: cost ? true : undefined,
      duration_ms: meta.durationMs,
      tool_call_count: 0,
      has_thinking: false,
      stop_reason: 'end_turn',
      // Tag so these are identifiable in the dashboard / logs
      metadata: { source: meta.source },
    };

    authFetch(`${apiBaseUrl}/v1/internal/llm-calls`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    }).catch(err => {
      console.warn(`[${meta.source}] Failed to log LLM call:`, err);
    });
  };

  // Attempt to compute cost from OpenRouter's live pricing
  if (inputTokens > 0 || outputTokens > 0) {
    computeOpenRouterCost(meta.model, inputTokens, outputTokens)
      .then(cost => sendPayload(cost))
      .catch(() => sendPayload(null));
  } else {
    sendPayload(null);
  }
}
