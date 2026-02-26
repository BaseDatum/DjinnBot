/**
 * openrouter-client.ts — shared OpenRouter SDK wrapper.
 *
 * Provides a lazily-initialised, singleton OpenRouter client and a typed
 * `chatCompletion()` helper used by both the research tool and the
 * focused-analysis tool.
 *
 * Benefits over raw https.request:
 *  - Typed request/response via @openrouter/sdk
 *  - Automatic retries with exponential backoff
 *  - Timeout handling
 *  - Cleaner error surfaces
 */

import { OpenRouter } from '@openrouter/sdk';
import type { ChatResponse } from '@openrouter/sdk/models';

// ── Singleton client ───────────────────────────────────────────────────────

let _client: OpenRouter | null = null;

function getClient(): OpenRouter {
  if (!_client) {
    const apiKey = process.env.OPENROUTER_API_KEY;
    if (!apiKey) {
      throw new Error('OPENROUTER_API_KEY is not set');
    }
    _client = new OpenRouter({
      apiKey,
      httpReferer: 'https://djinnbot.ai',
      xTitle: 'DjinnBot',
    });
  }
  return _client;
}

/**
 * Reset the cached client (e.g. if the API key changes at runtime).
 * Primarily useful in tests.
 */
export function resetOpenRouterClient(): void {
  _client = null;
}

// ── Types ──────────────────────────────────────────────────────────────────

export interface ChatCompletionMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface ChatCompletionOptions {
  model: string;
  messages: ChatCompletionMessage[];
  maxTokens?: number;
  temperature?: number;
  signal?: AbortSignal;
  /** Request timeout in milliseconds (default: 120_000). */
  timeoutMs?: number;
}

export interface ChatCompletionResult {
  /** The model's response text. */
  content: string;
  /** Model that actually served the request (may differ from requested). */
  model: string;
  /** Token usage when reported by the API. */
  usage?: {
    promptTokens: number;
    completionTokens: number;
    totalTokens: number;
    cachedTokens?: number;
  };
  /** Wall-clock duration in milliseconds. */
  durationMs: number;
  /** Raw citations array (Perplexity models only). */
  citations?: string[];
}

// ── Main helper ────────────────────────────────────────────────────────────

/**
 * Send a non-streaming chat completion to OpenRouter and return a typed result.
 *
 * Handles:
 *  - API errors → returns error string in `content` (never throws)
 *  - Abort signals
 *  - Duration tracking
 *  - Token usage extraction
 */
export async function chatCompletion(
  options: ChatCompletionOptions,
): Promise<ChatCompletionResult> {
  const startTime = Date.now();
  const model = options.model;

  try {
    const client = getClient();

    const response = await client.chat.send(
      {
        chatGenerationParams: {
          model: options.model,
          messages: options.messages.map(m => {
            if (m.role === 'system') return { role: 'system' as const, content: m.content };
            if (m.role === 'assistant') return { role: 'assistant' as const, content: m.content };
            return { role: 'user' as const, content: m.content };
          }),
          maxTokens: options.maxTokens,
          temperature: options.temperature,
          stream: false,
        },
      },
      {
        timeoutMs: options.timeoutMs ?? 120_000,
        ...(options.signal ? { fetchOptions: { signal: options.signal } } : {}),
      },
    ) as ChatResponse;

    const durationMs = Date.now() - startTime;

    const choice = response.choices?.[0];
    const content = choice?.message?.content;

    if (!content) {
      return {
        content: `OpenRouter returned no content for model ${model}.`,
        model: response.model || model,
        durationMs,
      };
    }

    // Extract text content (may be string or array of content blocks)
    const textContent = typeof content === 'string'
      ? content
      : Array.isArray(content)
        ? content.map((c: any) => (typeof c === 'string' ? c : c.text ?? '')).join('')
        : String(content);

    const usage = response.usage
      ? {
          promptTokens: response.usage.promptTokens ?? 0,
          completionTokens: response.usage.completionTokens ?? 0,
          totalTokens: response.usage.totalTokens ?? 0,
          cachedTokens: response.usage.promptTokensDetails?.cachedTokens,
        }
      : undefined;

    // Perplexity models return citations at the top level
    const citations = (response as any).citations as string[] | undefined;

    return {
      content: textContent,
      model: response.model || model,
      usage,
      durationMs,
      citations,
    };
  } catch (err: unknown) {
    const durationMs = Date.now() - startTime;
    const message = err instanceof Error ? err.message : String(err);

    // If the API key was missing, clear the cached client so a retry
    // after setting the env var works.
    if (message.includes('OPENROUTER_API_KEY')) {
      resetOpenRouterClient();
    }

    return {
      content: `OpenRouter request failed: ${message}`,
      model,
      durationMs,
    };
  }
}
