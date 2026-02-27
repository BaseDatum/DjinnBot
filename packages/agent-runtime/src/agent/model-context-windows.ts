/**
 * Model Context Window Registry
 *
 * Static lookup of context window sizes (in tokens) for known models.
 * Used by the token tracker and compaction system to determine when
 * a session is approaching its context limit.
 *
 * The container can also receive AGENT_CONTEXT_WINDOW as an env var
 * override from the engine for models not listed here.
 */

// ── Known model context windows (tokens) ────────────────────────────────────

const MODEL_CONTEXT_WINDOWS: Record<string, number> = {
  // Anthropic
  'claude-opus-4': 200_000,
  'claude-opus-4-6': 200_000,
  'claude-sonnet-4': 200_000,
  'claude-sonnet-4-5': 200_000,
  'claude-haiku-4': 200_000,
  'claude-3-5-sonnet': 200_000,
  'claude-3-5-haiku': 200_000,
  'claude-3-opus': 200_000,
  'claude-3-sonnet': 200_000,
  'claude-3-haiku': 200_000,

  // OpenAI
  'gpt-4.1': 1_000_000,
  'gpt-4.1-mini': 1_000_000,
  'gpt-4.1-nano': 1_000_000,
  'gpt-4o': 128_000,
  'gpt-4o-mini': 128_000,
  'gpt-4-turbo': 128_000,
  'o1': 200_000,
  'o1-mini': 128_000,
  'o1-pro': 200_000,
  'o3': 200_000,
  'o3-mini': 200_000,
  'o3-pro': 200_000,
  'o4-mini': 200_000,

  // Google
  'gemini-2.5-pro': 1_000_000,
  'gemini-2.5-flash': 1_000_000,
  'gemini-2.0-flash': 1_000_000,
  'gemini-2.0-pro': 1_000_000,
  'gemini-3-pro': 2_000_000,

  // xAI
  'grok-3': 131_072,
  'grok-3-mini': 131_072,
  'grok-beta': 131_072,

  // DeepSeek
  'deepseek-chat': 64_000,
  'deepseek-reasoner': 64_000,
  'deepseek-r1': 64_000,
  'deepseek-v3': 64_000,

  // MiniMax
  'minimax-m2.5': 1_000_000,

  // Mistral
  'mistral-large': 128_000,
  'mistral-medium': 128_000,
  'codestral': 256_000,

  // Meta
  'llama-4-maverick': 1_000_000,
  'llama-4-scout': 512_000,
  'llama-3.3-70b': 128_000,
  'llama-3.1-405b': 128_000,

  // Qwen
  'qwen-2.5-72b': 128_000,
  'qwen3-235b': 128_000,
  'qwen-max': 128_000,

  // Moonshot / Kimi
  'kimi-k2.5': 128_000,
  'kimi-k2': 128_000,
};

// Default when model is not found in registry
const DEFAULT_CONTEXT_WINDOW = 128_000;

/**
 * Resolve the context window size for a model.
 *
 * Lookup order:
 *   1. AGENT_CONTEXT_WINDOW env var (explicit override from engine)
 *   2. Full model ID match in registry (e.g. "claude-sonnet-4")
 *   3. Partial match — strip version suffixes and date stamps
 *   4. Default fallback (128k)
 */
export function getModelContextWindow(modelId: string): number {
  // 1. Env var override
  const envOverride = process.env.AGENT_CONTEXT_WINDOW;
  if (envOverride) {
    const parsed = parseInt(envOverride, 10);
    if (!isNaN(parsed) && parsed > 0) return parsed;
  }

  // 2. Direct match
  const normalized = modelId.toLowerCase();
  if (MODEL_CONTEXT_WINDOWS[normalized]) {
    return MODEL_CONTEXT_WINDOWS[normalized];
  }

  // 3. Try stripping provider prefix (e.g. "anthropic/claude-sonnet-4" -> "claude-sonnet-4")
  const withoutProvider = normalized.includes('/')
    ? normalized.split('/').slice(-1)[0]
    : normalized;
  if (MODEL_CONTEXT_WINDOWS[withoutProvider]) {
    return MODEL_CONTEXT_WINDOWS[withoutProvider];
  }

  // 4. Fuzzy match — strip date suffixes like "-20250514"
  const withoutDate = withoutProvider.replace(/-\d{8}$/, '');
  if (MODEL_CONTEXT_WINDOWS[withoutDate]) {
    return MODEL_CONTEXT_WINDOWS[withoutDate];
  }

  // 5. Try matching just the base model name (e.g. "claude-sonnet-4-20250514" -> check each key)
  for (const [key, value] of Object.entries(MODEL_CONTEXT_WINDOWS)) {
    if (withoutProvider.startsWith(key) || withoutDate.startsWith(key)) {
      return value;
    }
  }

  return DEFAULT_CONTEXT_WINDOW;
}
