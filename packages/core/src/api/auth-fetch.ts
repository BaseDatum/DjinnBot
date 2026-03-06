/**
 * Authenticated fetch wrapper for engine-to-API calls.
 *
 * Automatically injects the ENGINE_INTERNAL_TOKEN as a Bearer token
 * into every request to the DjinnBot API.
 */

/**
 * Returns standard auth headers for API calls.
 * If ENGINE_INTERNAL_TOKEN is set, includes Authorization: Bearer <token>.
 */
export function getAuthHeaders(): Record<string, string> {
  const token = process.env.ENGINE_INTERNAL_TOKEN;
  if (token) {
    return { Authorization: `Bearer ${token}` };
  }
  return {};
}

/**
 * Wrapper around global fetch that injects the ENGINE_INTERNAL_TOKEN.
 * Drop-in replacement for `fetch()` in engine code that calls the API.
 */
export async function authFetch(
  input: string | URL | Request,
  init?: RequestInit,
): Promise<Response> {
  const token = process.env.ENGINE_INTERNAL_TOKEN;
  if (!token) {
    return fetch(input, init);
  }

  const headers = new Headers(init?.headers);
  if (!headers.has('Authorization')) {
    headers.set('Authorization', `Bearer ${token}`);
  }

  return fetch(input, { ...init, headers });
}
