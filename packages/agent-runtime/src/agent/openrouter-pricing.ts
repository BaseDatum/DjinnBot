/**
 * openrouter-pricing.ts
 *
 * Fetches and caches per-model pricing from the OpenRouter API.
 * Used to compute accurate costs for OpenRouter calls when the pi-ai
 * model registry doesn't have pricing data (model not registered, or
 * cost rates are zero).
 *
 * The cache is populated lazily on first use and refreshed every 6 hours.
 * Pricing data comes from https://openrouter.ai/api/v1/models which is
 * a public, unauthenticated endpoint.
 */

/** Per-million-token pricing rates for a model. */
export interface ModelPricing {
  /** Input (prompt) cost per million tokens in USD. */
  input: number;
  /** Output (completion) cost per million tokens in USD. */
  output: number;
  /** Cached input cost per million tokens (0 if not supported). */
  cacheRead: number;
  /** Cache write cost per million tokens (0 if not supported). */
  cacheWrite: number;
}

/** modelId -> pricing map */
const pricingCache = new Map<string, ModelPricing>();
let lastFetchTime = 0;
let fetchPromise: Promise<void> | null = null;

const CACHE_TTL_MS = 6 * 60 * 60 * 1000; // 6 hours
const FETCH_TIMEOUT_MS = 10_000;

/**
 * Fetch model pricing from OpenRouter's public API.
 * Only one fetch runs at a time (deduped via fetchPromise).
 */
async function refreshCache(): Promise<void> {
  const now = Date.now();
  if (now - lastFetchTime < CACHE_TTL_MS && pricingCache.size > 0) return;

  if (fetchPromise) return fetchPromise;

  fetchPromise = (async () => {
    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);

      const res = await fetch('https://openrouter.ai/api/v1/models', {
        signal: controller.signal,
      });
      clearTimeout(timeoutId);

      if (!res.ok) {
        console.warn(`[OpenRouterPricing] Failed to fetch models: ${res.status}`);
        return;
      }

      const body = await res.json() as {
        data?: Array<{
          id: string;
          pricing?: {
            prompt?: string;
            completion?: string;
            request?: string;
            image?: string;
          };
        }>;
      };

      if (!body.data) return;

      pricingCache.clear();
      for (const model of body.data) {
        if (!model.pricing) continue;
        // OpenRouter returns per-token prices as strings.
        // Convert to per-million-token rates (matching pi-ai convention).
        const promptPerToken = parseFloat(model.pricing.prompt || '0');
        const completionPerToken = parseFloat(model.pricing.completion || '0');

        if (promptPerToken === 0 && completionPerToken === 0) continue;

        pricingCache.set(model.id, {
          input: promptPerToken * 1_000_000,
          output: completionPerToken * 1_000_000,
          cacheRead: 0,   // OpenRouter doesn't expose cache pricing separately
          cacheWrite: 0,
        });
      }

      lastFetchTime = now;
      console.info(`[OpenRouterPricing] Cached pricing for ${pricingCache.size} models.`);
    } catch (err) {
      console.warn(`[OpenRouterPricing] Error fetching pricing:`, err);
    } finally {
      fetchPromise = null;
    }
  })();

  return fetchPromise;
}

/**
 * Look up pricing for an OpenRouter model ID.
 *
 * @param modelId - The model ID as used in OpenRouter (e.g. "google/gemini-2.5-pro")
 * @returns Pricing rates or null if not found / cache not ready.
 */
export async function getOpenRouterPricing(modelId: string): Promise<ModelPricing | null> {
  await refreshCache();
  return pricingCache.get(modelId) ?? null;
}

/**
 * Compute cost for an OpenRouter call given token counts and model pricing.
 * Returns { input, output, total } in USD, or null if pricing is unavailable.
 */
export async function computeOpenRouterCost(
  modelId: string,
  inputTokens: number,
  outputTokens: number,
  cacheReadTokens: number = 0,
): Promise<{ input: number; output: number; total: number } | null> {
  const pricing = await getOpenRouterPricing(modelId);
  if (!pricing) return null;

  const costInput = (pricing.input / 1_000_000) * inputTokens;
  const costOutput = (pricing.output / 1_000_000) * outputTokens;
  const costCacheRead = (pricing.cacheRead / 1_000_000) * cacheReadTokens;
  const total = costInput + costOutput + costCacheRead;

  if (total === 0) return null;

  return { input: costInput, output: costOutput, total };
}
