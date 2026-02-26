/**
 * model-resolver.ts
 *
 * Shared utility for resolving a "provider/model-id" string into a pi-ai Model
 * object that can be handed directly to pi-agent-core's Agent.
 *
 * Strategy:
 *  1. If the model is in pi-ai's static registry, return it as-is.
 *  2. If it's not registered, infer the correct (api, baseUrl) from the majority
 *     of the provider's known models — so newly released models work without
 *     waiting for pi-ai to regenerate its static list.
 *  3. For unknown providers, fall back to OpenRouter passthrough.
 *
 * The opencode.ai gateway requires `max_tokens` (not `max_completion_tokens`).
 * Inferred models for the opencode provider therefore carry an explicit `compat`
 * override so pi-ai's detectCompat() sends the correct field.
 */

import { getModel, getModels } from '@mariozechner/pi-ai';
import type { Model, Api } from '@mariozechner/pi-ai';
import { PROVIDER_ENV_MAP, isProviderConfigured } from '../constants.js';

/**
 * Extended Model type that tracks whether cost data is approximate.
 *
 * When a model is inferred from a sibling rather than found in the static
 * registry, cost rates are copied from the closest match and may not be
 * exact.  Downstream consumers (runner, dashboard) use this flag to show
 * an "approximate" indicator.
 */
export interface ResolvedModel<T extends Api = Api> extends Model<T> {
  /** True when cost rates are inherited from a sibling model, not exact. */
  costApproximate?: boolean;
}

/**
 * Providers whose modern models are known to support vision (image input).
 *
 * pi-ai's static registry may lag behind and list some models with
 * input:["text"] only.  The openai-completions provider silently strips
 * image_url blocks when model.input doesn't include "image", so we
 * force-enable vision for these providers to prevent attachments from
 * being silently dropped.
 */
const VISION_CAPABLE_PROVIDERS = new Set([
  'xai', 'openai', 'anthropic', 'google', 'opencode',
]);

/**
 * Detect whether a model id refers to a reasoning/thinking model based on
 * naming conventions used by major providers.  When `inferModelForProvider`
 * copies capabilities from a sibling that predates reasoning support, this
 * heuristic ensures the inferred model still gets `reasoning: true` so that
 * pi-agent-core requests thinking tokens and emits `thinking_delta` events.
 *
 * Known patterns:
 *  - xAI: grok-*-reasoning, grok-*-fast-reasoning
 *  - OpenAI: o1*, o3*, o4*
 *  - Google: gemini-*-thinking*
 *  - DeepSeek: deepseek-reasoner, deepseek-*-r1*
 */
const REASONING_MODEL_PATTERN =
  /[-/]reasoning|^o[134]-|[-/]thinking|[-/]reasoner$|[-/]r1/i;

/**
 * Ensure a model from a vision-capable provider includes "image" in its
 * input array.  Returns the model as-is if it already supports images,
 * or a shallow copy with the corrected input array.
 */
function maybeEnableVision<T extends Api>(model: Model<T>): Model<T> {
  if (!VISION_CAPABLE_PROVIDERS.has(model.provider as string)) return model;
  if (model.input.includes('image')) return model;
  return { ...model, input: ['text', 'image'] as any };
}

/**
 * Create a pass-through Model object that routes via OpenRouter.
 * Used for bare model ids, openrouter/-prefixed strings, and totally unknown
 * providers as a best-effort fallback.
 */
export function createOpenRouterModel(modelId: string): Model<'openai-completions'> {
  return {
    id: modelId,
    name: modelId,
    api: 'openai-completions',
    provider: 'openrouter',
    baseUrl: 'https://openrouter.ai/api/v1',
    reasoning: REASONING_MODEL_PATTERN.test(modelId),
    input: ['text', 'image'],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 1048576,
    maxTokens: 131072,
  };
}

/**
 * Infer a Model object for a provider/modelId pair that isn't in pi-ai's static
 * registry. pi-ai routes requests purely on model.api + model.baseUrl, so as long
 * as we get those right the call will work — cost/reasoning metadata will just be
 * unknown (zeroed out).
 *
 * Strategy: count which (api, baseUrl) combination appears most often among the
 * provider's registered models, then use that as the default for unregistered ones.
 *
 * Special case: opencode.ai's gateway crashes when it receives `max_completion_tokens`
 * (the OpenAI default) — it only accepts `max_tokens`. We inject a `compat` override
 * to force `maxTokensField: "max_tokens"` for any model inferred under opencode or
 * served from opencode.ai.
 */
export function inferModelForProvider(provider: string, modelId: string): ResolvedModel<Api> | null {
  const known = getModels(provider as any);
  if (known.length === 0) return null;

  // ── Step 1: Try to find the best (api, baseUrl) by matching the model id
  // against registered siblings.  A provider like "opencode" hosts models from
  // multiple upstream APIs (Anthropic, OpenAI, Google, …).  Picking the global
  // majority would route e.g. a new Claude model through openai-completions,
  // which silently drops tool calls.
  //
  // Strategy: find the registered model whose id shares the longest common
  // prefix with the unknown modelId.  If there's a good prefix match (>= 5
  // chars, e.g. "claude-" or "gpt-5"), use that model's api + baseUrl.
  // Otherwise fall back to the global majority.

  let sibling: typeof known[0] | null = null;
  let longestPrefix = 0;
  for (const m of known) {
    // Compute common prefix length between the unknown modelId and this known model
    let shared = 0;
    const limit = Math.min(modelId.length, m.id.length);
    while (shared < limit && modelId[shared] === m.id[shared]) shared++;
    if (shared > longestPrefix) {
      longestPrefix = shared;
      sibling = m;
    }
  }

  // Require a meaningful prefix match (e.g. "claude-" = 7, "gpt-5" = 5,
  // "gemini-" = 7) to avoid false positives on short coincidental overlaps.
  const MIN_PREFIX = 5;

  let bestApi: Api;
  let bestBaseUrl: string;

  if (sibling && longestPrefix >= MIN_PREFIX) {
    bestApi = sibling.api;
    bestBaseUrl = sibling.baseUrl;
    console.warn(
      `[ModelResolver] "${provider}/${modelId}" is not in pi-ai's model registry. ` +
      `Matched sibling "${sibling.id}" (prefix: ${longestPrefix} chars) → ` +
      `api="${bestApi}" baseUrl="${bestBaseUrl}".`
    );
  } else {
    // ── Step 2: Fall back to the global majority (api, baseUrl)
    const tally = new Map<string, { api: Api; baseUrl: string; count: number }>();
    for (const m of known) {
      const key = `${m.api}|${m.baseUrl}`;
      const entry = tally.get(key);
      if (entry) {
        entry.count++;
      } else {
        tally.set(key, { api: m.api, baseUrl: m.baseUrl, count: 1 });
      }
    }

    let best: { api: Api; baseUrl: string; count: number } = {
      api: known[0].api,
      baseUrl: known[0].baseUrl,
      count: 0,
    };
    for (const entry of tally.values()) {
      if (entry.count > best.count) best = entry;
    }

    bestApi = best.api;
    bestBaseUrl = best.baseUrl;
    console.warn(
      `[ModelResolver] "${provider}/${modelId}" is not in pi-ai's model registry. ` +
      `No sibling match — using majority api="${bestApi}" baseUrl="${bestBaseUrl}".`
    );
  }

  // Copy additional properties from the sibling when available so the inferred
  // model inherits capabilities like reasoning, input modalities, context
  // window size, max tokens, and cost rates from the closest known model.
  const hasSibling = !!(sibling && longestPrefix >= MIN_PREFIX);
  const siblingProps = hasSibling ? {
    reasoning: sibling!.reasoning ?? false,
    input: sibling!.input ?? ['text'] as any,
    contextWindow: sibling!.contextWindow ?? 128000,
    maxTokens: sibling!.maxTokens ?? 32768,
  } : {
    reasoning: false,
    input: ['text'] as any,
    contextWindow: 128000,
    maxTokens: 32768,
  };

  // Inherit cost rates from the sibling when available.  These are approximate
  // since the sibling may have different pricing, but far better than zeros.
  const hasSiblingCost = hasSibling &&
    sibling!.cost &&
    (sibling!.cost.input > 0 || sibling!.cost.output > 0);
  const costRates = hasSiblingCost
    ? { ...sibling!.cost }
    : { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };

  // Ensure vision support for providers whose recent models accept images.
  // pi-ai's static registry may list older model entries with input:["text"]
  // only, causing image content blocks to be silently stripped in the
  // openai-completions provider's convertMessages(). Override the input
  // array for providers where we know modern models support vision.
  if (VISION_CAPABLE_PROVIDERS.has(provider) && !siblingProps.input.includes('image')) {
    siblingProps.input = ['text', 'image'] as any;
  }

  // Force reasoning: true when the model id indicates it supports reasoning.
  // Sibling models that predate reasoning will have reasoning: false, causing
  // pi-agent-core to skip thinking tokens entirely (GitHub issue #2).
  if (!siblingProps.reasoning && REASONING_MODEL_PATTERN.test(modelId)) {
    siblingProps.reasoning = true;
    console.info(
      `[ModelResolver] Forcing reasoning: true for "${provider}/${modelId}" ` +
      `(model id matches reasoning pattern).`,
    );
  }

  // opencode.ai requires max_tokens, not max_completion_tokens.
  // Inject a compat override so pi-ai sends the correct field.
  const needsMaxTokensOverride =
    provider === 'opencode' || bestBaseUrl.includes('opencode.ai');

  if (hasSiblingCost) {
    console.info(
      `[ModelResolver] Inherited approximate cost rates from sibling "${sibling!.id}" ` +
      `for "${provider}/${modelId}": input=${costRates.input}, output=${costRates.output}.`
    );
  }

  return {
    id: modelId,
    name: modelId,
    api: bestApi,
    provider: provider as any,
    baseUrl: bestBaseUrl,
    ...siblingProps,
    cost: costRates,
    costApproximate: hasSiblingCost ? true : undefined,
    ...(needsMaxTokensOverride
      ? { compat: { maxTokensField: 'max_tokens' as const } }
      : {}),
  } as ResolvedModel<Api>;
}

/**
 * Detect whether an error message looks like a network connection failure.
 */
const NETWORK_ERROR_PATTERN = /ECONNREFUSED|ENOTFOUND|ETIMEDOUT|fetch failed|network.*error|connect.*failed|connection.*refused|failed to fetch/i;

/**
 * Detect whether a URL points to localhost / loopback.
 */
const LOCALHOST_PATTERN = /localhost|127\.0\.0\.1|::1/;

/**
 * Enrich a network error message when it was produced inside a Docker container
 * trying to reach a local LLM provider whose base URL contains "localhost" or
 * "127.0.0.1".  In bridge-network mode those addresses refer to the container
 * itself — not the Docker host — so the connection always fails.
 *
 * The enriched message is appended to the original so the raw error is preserved
 * while the actionable hint is immediately visible to the user.
 *
 * @param error       The raw error string from the failed LLM call.
 * @param baseUrl     The provider's configured base URL (may be undefined if not
 *                    a custom provider).
 * @param inContainer Pass true when the call originated inside a Docker container
 *                    (i.e. ContainerRunner path).  Pass false for in-process runs
 *                    (PiMonoRunner) where localhost resolves correctly.
 */
export function enrichNetworkError(
  error: string,
  baseUrl: string | undefined,
  inContainer: boolean,
): string {
  if (!NETWORK_ERROR_PATTERN.test(error)) return error;
  if (!baseUrl || !LOCALHOST_PATTERN.test(baseUrl)) return error;

  const suggested = baseUrl.replace(/localhost|127\.0\.0\.1|::1/g, 'host.docker.internal');

  if (inContainer) {
    return (
      `${error}\n\n` +
      `Hint: Agent containers run in an isolated Docker bridge network — "localhost" ` +
      `inside a container refers to the container itself, not the Docker host. ` +
      `Update your custom provider base URL from "${baseUrl}" to ` +
      `"${suggested}". ` +
      `On Linux you must also add ` +
      `'extra_hosts: ["host.docker.internal:host-gateway"]' ` +
      `to the engine service in your docker-compose.yml.`
    );
  }

  // In-process (PiMonoRunner): localhost works, but surface a softer note in
  // case the error is genuinely network-related (e.g. the local LLM isn't running).
  return (
    `${error}\n\n` +
    `Hint: Could not reach "${baseUrl}". Make sure your local LLM server is ` +
    `running and listening on that address.`
  );
}

/**
 * Create a Model object for a user-defined custom OpenAI-compatible provider.
 *
 * Custom providers are identified by the "custom-<slug>" prefix.  Their base URL
 * is injected into process.env as CUSTOM_<SLUG>_BASE_URL by PiMonoRunner /
 * ContainerRunner before model resolution happens.
 *
 * The API key (if any) is already in process.env as CUSTOM_<SLUG>_API_KEY and is
 * read automatically by the pi-ai HTTP layer via the Authorization header when the
 * provider is registered with registerBuiltInApiProviders() — but custom providers
 * are not part of pi-ai's built-in list, so we embed the key directly in the model
 * object's headers to guarantee it is sent.
 */
/**
 * The api discriminator used for all custom OpenAI-compatible providers.
 *
 * We intentionally do NOT reuse 'openai-completions' here.  pi-ai's built-in
 * openai-completions provider routes through streamSimpleOpenAICompletions,
 * which hard-throws when no API key is present in its internal env-var map.
 * Custom providers are not in that map, and local servers (LM Studio, Ollama,
 * vLLM) don't require keys.  By using a dedicated api string we can register
 * our own provider that routes through streamOpenAICompletions instead — that
 * function falls back to an empty string rather than throwing.
 *
 * The agent-runtime's runner.ts reads this constant to register the provider
 * with pi-ai before creating any Agent.
 */
export const CUSTOM_PROVIDER_API = 'custom-openai-completions' as const;

export function createCustomProviderModel(
  provider: string,
  modelId: string,
): Model<typeof CUSTOM_PROVIDER_API> {
  // Derive env var names from the provider slug (e.g. "custom-ollama" → "CUSTOM_OLLAMA")
  const slug = provider.slice('custom-'.length).toUpperCase().replace(/-/g, '_');
  const baseUrlEnv = `CUSTOM_${slug}_BASE_URL`;
  const apiKeyEnv = `CUSTOM_${slug}_API_KEY`;

  const baseUrl = (process.env[baseUrlEnv] ?? '').replace(/\/+$/, '');
  const apiKey = process.env[apiKeyEnv] ?? '';

  if (!baseUrl) {
    throw new Error(
      `Custom provider "${provider}" has no base URL configured. ` +
      `Set ${baseUrlEnv} or configure it in Settings → Model Providers.`,
    );
  }

  return {
    id: modelId,
    name: modelId,
    api: CUSTOM_PROVIDER_API,
    provider: provider as any,
    baseUrl,
    reasoning: false,
    input: ['text'],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 128000,
    maxTokens: 32768,
    // Embed the API key in headers when present.  For no-key local servers the
    // header is omitted; streamOpenAICompletions will use an empty string for
    // the apiKey param which is valid for unauthenticated endpoints.
    ...(apiKey ? { headers: { Authorization: `Bearer ${apiKey}` } } : {}),
  } as Model<typeof CUSTOM_PROVIDER_API>;
}

/**
 * Parse a "provider/model-id" string and return a pi-ai Model object ready for use.
 *
 * Resolution order:
 *  1. Bare id (no slash) → OpenRouter passthrough
 *  2. openrouter/... prefix → OpenRouter passthrough (strip prefix)
 *  3. custom-<slug>/... prefix → custom OpenAI-compatible provider
 *  4. Known direct provider → check credentials are configured
 *  5. Try pi-ai's static registry via getModel()
 *  6. Not in registry → infer from provider's known models
 *  7. Unknown provider → OpenRouter passthrough
 *
 * Throws only when a known direct provider is explicitly chosen but has no
 * credentials configured — a clear user-facing error is better than a silent
 * auth failure deep in the HTTP call.
 */
export function parseModelString(modelString: string): ResolvedModel<Api> {
  const parts = modelString.split('/');

  if (parts.length < 2) {
    // Bare model id with no provider prefix — OpenRouter passthrough
    return createOpenRouterModel(modelString);
  }

  const provider = parts[0];
  const modelId = parts.slice(1).join('/');

  // openrouter prefix: check pi-ai registry first (has real cost data),
  // then fall back to zero-cost passthrough for unregistered models.
  if (provider === 'openrouter') {
    const registered = getModel('openrouter' as any, modelId as any);
    if (registered !== undefined) {
      return registered;
    }
    // Not in registry — try sibling-based inference (inherits cost rates)
    const inferred = inferModelForProvider('openrouter', modelId);
    if (inferred !== null) {
      return inferred;
    }
    return createOpenRouterModel(modelId);
  }

  // custom-<slug> prefix: route to user-configured OpenAI-compatible endpoint
  if (provider.startsWith('custom-')) {
    return createCustomProviderModel(provider, modelId);
  }

  // Check credentials before proceeding for known direct providers
  const knownProvider =
    provider in PROVIDER_ENV_MAP ||
    provider === 'amazon-bedrock' ||
    provider === 'google-vertex';

  if (knownProvider && !isProviderConfigured(provider)) {
    const envVar = PROVIDER_ENV_MAP[provider];
    const envHint = envVar
      ? `Set the ${envVar} environment variable or configure it in Settings → Model Providers.`
      : `Configure credentials for "${provider}" in Settings → Model Providers.`;
    throw new Error(`Provider "${provider}" is not configured. ${envHint}`);
  }

  // Try pi-ai's static registry first
  const registered = getModel(provider as any, modelId as any);
  if (registered !== undefined) {
    return maybeEnableVision(registered);
  }

  // Not in registry — infer from the provider's known models if possible
  if (knownProvider) {
    const inferred = inferModelForProvider(provider, modelId);
    if (inferred !== null) {
      return inferred;
    }
  }

  // Completely unknown provider — best-effort OpenRouter passthrough
  console.info(`[ModelResolver] Unknown provider "${provider}", passing through to OpenRouter`);
  return createOpenRouterModel(modelString);
}
