/**
 * focusedAnalysis — lightweight analytical delegation via OpenRouter.
 *
 * Fills the gap between an agent's own context window (expensive, limited,
 * gets polluted with detail) and spawn_executor (full container, 5+ min
 * overhead, requires project/task infrastructure).
 *
 * Use cases:
 *  - Pre-flight diff review ("does this diff have security issues?")
 *  - Impact analysis ("which of these 8 files need to change for feature X?")
 *  - Spec-to-test translation ("convert this spec to acceptance test cases")
 *  - Verification ("does this output satisfy these acceptance criteria?")
 *  - Summarisation ("summarise these 3 files into a concise architecture overview")
 *
 * The call is synchronous from the agent's perspective — it blocks until the
 * sub-inference completes (typically 5-30 seconds) and returns the result.
 * The agent's own context window stays clean for high-level planning.
 *
 * Costs ~50-100x less than spawning an executor container.
 */

import { chatCompletion } from './openrouter-client.js';

// ── Default model selection ────────────────────────────────────────────────

const DEFAULT_MODEL = 'anthropic/claude-sonnet-4' as const;

// ── Token budget guard ─────────────────────────────────────────────────────

const MAX_TOKENS_FLOOR = 256;
const MAX_TOKENS_CEILING = 16384;
const DEFAULT_MAX_TOKENS = 4096;

// ── Input context size guard ───────────────────────────────────────────────

const MAX_INPUT_CHARS = 200_000;

export interface FocusedAnalysisOptions {
  /** The focused question or instruction for the sub-model. */
  prompt: string;
  /** Optional content to analyse (file contents, diffs, specs, etc.). */
  context?: string;
  /**
   * OpenRouter model ID. Default: a fast/cheap model.
   * Use a stronger model for complex architectural or security analysis.
   */
  model?: string;
  /** Max response tokens (256–16384, default 4096). */
  maxTokens?: number;
  /**
   * Optional system-level persona for the sub-model.
   * Default: a terse, structured analytical assistant.
   */
  systemPrompt?: string;
  /** AbortSignal for cancellation. */
  signal?: AbortSignal;
}

export interface FocusedAnalysisResult {
  /** The sub-model's response. */
  content: string;
  /** Model actually used. */
  model: string;
  /** Token usage (when reported by the API). */
  usage?: {
    promptTokens: number;
    completionTokens: number;
    totalTokens: number;
  };
  /** Wall-clock duration in milliseconds. */
  durationMs: number;
}

const DEFAULT_SYSTEM_PROMPT =
  'You are a focused analytical assistant. Provide precise, structured, and concise answers. ' +
  'Do not include preamble, pleasantries, or caveats unless the analysis genuinely warrants them. ' +
  'When analysing code, reference specific file paths and line numbers. ' +
  'When listing items, use numbered or bulleted lists. ' +
  'Prioritise actionable insights over exhaustive description.';

export async function focusedAnalysis(
  options: FocusedAnalysisOptions,
): Promise<FocusedAnalysisResult> {
  const model =
    options.model ||
    process.env.FOCUSED_ANALYSIS_MODEL ||
    DEFAULT_MODEL;

  const maxTokens = Math.max(
    MAX_TOKENS_FLOOR,
    Math.min(options.maxTokens ?? DEFAULT_MAX_TOKENS, MAX_TOKENS_CEILING),
  );

  const systemPrompt = options.systemPrompt || DEFAULT_SYSTEM_PROMPT;

  // Build the user message: prompt + optional context block
  let userContent = options.prompt;
  if (options.context) {
    userContent += '\n\n<context>\n' + options.context + '\n</context>';
  }

  // Guard against oversized input
  if (userContent.length > MAX_INPUT_CHARS) {
    return {
      content:
        `Error: Combined prompt + context is ${userContent.length.toLocaleString()} characters ` +
        `(limit: ${MAX_INPUT_CHARS.toLocaleString()}). ` +
        'Trim the context to the relevant sections before calling focused_analysis.',
      model,
      durationMs: 0,
    };
  }

  const result = await chatCompletion({
    model,
    messages: [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userContent },
    ],
    maxTokens,
    signal: options.signal,
  });

  return {
    content: result.content,
    model: result.model,
    usage: result.usage,
    durationMs: result.durationMs,
  };
}
