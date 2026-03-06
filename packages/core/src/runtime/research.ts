/**
 * performResearch — shared Perplexity/OpenRouter research helper.
 *
 * Used by both PiMonoRunner (in-process) and agent-runtime containers.
 * Makes a call to OpenRouter using the Perplexity sonar model family
 * and returns the synthesized answer with citations.
 */

import { chatCompletion, type ChatCompletionResult } from './openrouter-client.js';

const FOCUS_PROMPTS: Record<string, string> = {
  finance:
    'You are a financial research analyst. Provide precise, data-driven answers with specific numbers, valuations, multiples, and market data. Cite sources.',
  marketing:
    'You are a marketing research analyst. Focus on market positioning, competitor messaging, channel benchmarks, and campaign performance data. Cite sources.',
  technical:
    'You are a technical research analyst. Focus on documentation, best practices, library comparisons, security advisories, and engineering standards. Cite sources.',
  market:
    'You are a market research analyst. Provide TAM/SAM analysis, competitive landscapes, growth trends, and industry dynamics. Cite sources.',
  news:
    'You are a news research analyst. Surface the most recent and relevant developments, announcements, and breaking news on this topic. Cite sources.',
  general:
    'You are a research analyst. Provide thorough, accurate, well-structured answers with cited sources.',
};

/**
 * Structured result from a research call, including metadata for logging.
 */
export interface ResearchResult {
  /** Formatted answer with citations appended. */
  text: string;
  /** Model that served the request. */
  model: string;
  /** Token usage when reported. */
  usage?: {
    promptTokens: number;
    completionTokens: number;
    totalTokens: number;
  };
  /** Wall-clock duration in milliseconds. */
  durationMs: number;
}

/**
 * Research a topic and return structured result with metadata.
 * Use this when you need access to usage/duration for logging.
 */
export async function performResearchWithMeta(
  query: string,
  focus: string = 'general',
  model: string = 'perplexity/sonar-pro',
  signal?: AbortSignal,
): Promise<ResearchResult> {
  const systemPrompt = FOCUS_PROMPTS[focus] ?? FOCUS_PROMPTS.general;

  const result = await chatCompletion({
    model,
    messages: [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: query },
    ],
    signal,
  });

  // Append citations if present (Perplexity models)
  let text = result.content;
  if (result.citations && result.citations.length > 0) {
    text +=
      '\n\n---\n**Sources:**\n' +
      result.citations.map((c, i) => `[${i + 1}] ${c}`).join('\n');
  }

  return {
    text,
    model: result.model,
    usage: result.usage,
    durationMs: result.durationMs,
  };
}

/**
 * Research a topic via Perplexity on OpenRouter.
 *
 * Returns the synthesized answer as a plain string (backward-compatible).
 * For structured metadata (usage, duration), use `performResearchWithMeta`.
 */
export async function performResearch(
  query: string,
  focus: string = 'general',
  model: string = 'perplexity/sonar-pro',
  signal?: AbortSignal,
): Promise<string> {
  const result = await performResearchWithMeta(query, focus, model, signal);
  return result.text;
}
