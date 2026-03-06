/**
 * AgentKeyManager — Ensures each agent has a unique API key for
 * authenticating with the DjinnBot API.
 *
 * On engine startup, call ensureAgentKey(agentId) for each known agent.
 * The key is cached in memory and injected into agent containers as
 * AGENT_API_KEY instead of the engine's ENGINE_INTERNAL_TOKEN.
 *
 * If the API returns `created: false` (key already exists but we don't
 * have the plaintext), we fall back to ENGINE_INTERNAL_TOKEN for that
 * agent until the key is rotated.
 */

import { authFetch } from './auth-fetch.js';

const apiBaseUrl = process.env.DJINNBOT_API_URL || 'http://api:8000';

/** In-memory cache: agentId → plaintext API key */
const agentKeys = new Map<string, string>();

/**
 * Ensure an API key exists for the given agent.
 * Returns the plaintext key if available, or null if the key exists
 * but we don't have the plaintext (created in a previous engine run).
 */
export async function ensureAgentKey(agentId: string): Promise<string | null> {
  // Already cached from this engine session
  const cached = agentKeys.get(agentId);
  if (cached) return cached;

  try {
    const res = await authFetch(`${apiBaseUrl}/v1/auth/api-keys/agent`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ agentId }),
    });

    if (!res.ok) {
      console.warn(`[AgentKeyManager] Failed to ensure key for ${agentId}: HTTP ${res.status}`);
      return null;
    }

    const data = await res.json() as {
      id: string;
      agentId: string;
      key?: string;       // Only present when created: true
      keyPrefix: string;
      created: boolean;
    };

    if (data.created && data.key) {
      // New key — cache the plaintext
      agentKeys.set(agentId, data.key);
      console.log(`[AgentKeyManager] Created API key for agent ${agentId} (${data.keyPrefix}...)`);
      return data.key;
    }

    // Key exists but we don't have the plaintext (created in a previous run).
    // The agent will fall back to ENGINE_INTERNAL_TOKEN.
    console.log(`[AgentKeyManager] Key already exists for agent ${agentId} (${data.keyPrefix}...), no plaintext available`);
    return null;
  } catch (err) {
    console.error(`[AgentKeyManager] Error ensuring key for ${agentId}:`, err);
    return null;
  }
}

/**
 * Get the API key to inject into an agent container.
 * Returns the agent-specific key if available, falls back to ENGINE_INTERNAL_TOKEN.
 */
export function getAgentApiKey(agentId: string): string | undefined {
  return agentKeys.get(agentId) || process.env.ENGINE_INTERNAL_TOKEN || undefined;
}

/**
 * Ensure keys for multiple agents at once (called on engine startup).
 */
export async function ensureAgentKeys(agentIds: string[]): Promise<void> {
  const results = await Promise.allSettled(
    agentIds.map(id => ensureAgentKey(id))
  );
  const created = results.filter(r => r.status === 'fulfilled' && r.value !== null).length;
  const fallback = results.filter(r => r.status === 'fulfilled' && r.value === null).length;
  const failed = results.filter(r => r.status === 'rejected').length;
  console.log(
    `[AgentKeyManager] Ensured keys for ${agentIds.length} agents: ` +
    `${created} new, ${fallback} existing (using fallback), ${failed} failed`
  );
}
