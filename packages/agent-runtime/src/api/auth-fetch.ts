/**
 * Authenticated fetch wrapper for agent-runtime-to-API calls.
 *
 * Prefers AGENT_API_KEY (per-agent, scoped) over ENGINE_INTERNAL_TOKEN (global).
 * The key is injected into the container env by the engine at container creation.
 */

export async function authFetch(
  input: string | URL | Request,
  init?: RequestInit,
): Promise<Response> {
  // Prefer agent-specific key, fall back to engine internal token
  const token = process.env.AGENT_API_KEY || process.env.ENGINE_INTERNAL_TOKEN;
  if (!token) {
    return fetch(input, init);
  }

  const headers = new Headers(init?.headers);
  if (!headers.has('Authorization')) {
    headers.set('Authorization', `Bearer ${token}`);
  }

  return fetch(input, { ...init, headers });
}
