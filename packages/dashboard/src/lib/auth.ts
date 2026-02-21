/**
 * Auth state management — token storage, authenticated fetch, refresh logic.
 *
 * Access token is held in memory (not localStorage) for XSS protection.
 * Refresh token is stored in localStorage (httpOnly cookies require same-origin
 * API which we don't have in the VITE_API_URL=cross-origin Docker setup).
 */

import { API_BASE } from './api';

// ─── In-memory token store ──────────────────────────────────────────────────

let _accessToken: string | null = null;
let _refreshToken: string | null = null;
let _refreshPromise: Promise<boolean> | null = null;

const REFRESH_TOKEN_KEY = 'djinnbot_refresh_token';

export interface AuthUserInfo {
  id: string;
  email: string | null;
  displayName: string | null;
  isAdmin: boolean;
  totpEnabled: boolean;
}

export interface AuthTokens {
  accessToken: string;
  refreshToken: string;
  tokenType: string;
  expiresIn: number;
  user: AuthUserInfo;
}

export interface AuthStatus {
  authEnabled: boolean;
  setupComplete: boolean;
  oidcProviders: Array<{
    id: string;
    slug: string;
    name: string;
    buttonText: string;
    buttonColor: string | null;
    iconUrl: string | null;
  }>;
}

// ─── Token management ───────────────────────────────────────────────────────

export function setTokens(tokens: AuthTokens): void {
  _accessToken = tokens.accessToken;
  _refreshToken = tokens.refreshToken;
  localStorage.setItem(REFRESH_TOKEN_KEY, tokens.refreshToken);
}

export function clearTokens(): void {
  _accessToken = null;
  _refreshToken = null;
  localStorage.removeItem(REFRESH_TOKEN_KEY);
}

export function getAccessToken(): string | null {
  return _accessToken;
}

export function getRefreshToken(): string | null {
  return _refreshToken || localStorage.getItem(REFRESH_TOKEN_KEY);
}

export function hasTokens(): boolean {
  return !!_accessToken || !!getRefreshToken();
}

// ─── Auth status (public endpoint) ──────────────────────────────────────────

export async function fetchAuthStatus(): Promise<AuthStatus> {
  const res = await fetch(`${API_BASE}/auth/status`);
  if (!res.ok) {
    throw new Error('Failed to fetch auth status');
  }
  return res.json();
}

// ─── Token refresh ──────────────────────────────────────────────────────────

async function _doRefresh(): Promise<boolean> {
  const refreshToken = getRefreshToken();
  if (!refreshToken) return false;

  try {
    const res = await fetch(`${API_BASE}/auth/refresh`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ refreshToken }),
    });

    if (!res.ok) {
      clearTokens();
      return false;
    }

    const data: AuthTokens = await res.json();
    setTokens(data);
    return true;
  } catch {
    clearTokens();
    return false;
  }
}

/**
 * Attempt to refresh the access token. Deduplicates concurrent calls.
 */
export async function refreshAccessToken(): Promise<boolean> {
  if (_refreshPromise) return _refreshPromise;
  _refreshPromise = _doRefresh().finally(() => {
    _refreshPromise = null;
  });
  return _refreshPromise;
}

// ─── Authenticated fetch wrapper ────────────────────────────────────────────

/**
 * Drop-in replacement for `fetch` that injects the Authorization header
 * and handles 401 -> refresh -> retry.
 */
export async function authFetch(
  input: RequestInfo | URL,
  init?: RequestInit,
): Promise<Response> {
  const headers = new Headers(init?.headers);

  // Inject auth header if we have a token
  if (_accessToken && !headers.has('Authorization')) {
    headers.set('Authorization', `Bearer ${_accessToken}`);
  }

  let res = await fetch(input, { ...init, headers });

  // On 401, try to refresh and retry once
  if (res.status === 401 && getRefreshToken()) {
    const refreshed = await refreshAccessToken();
    if (refreshed && _accessToken) {
      headers.set('Authorization', `Bearer ${_accessToken}`);
      res = await fetch(input, { ...init, headers });
    }
  }

  return res;
}

// ─── Auth API calls ─────────────────────────────────────────────────────────

export async function login(
  email: string,
  password: string,
): Promise<AuthTokens & { requiresTOTP?: boolean; pendingToken?: string }> {
  const res = await fetch(`${API_BASE}/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password }),
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.detail || 'Login failed');
  }
  return res.json();
}

export async function verifyTOTP(
  pendingToken: string,
  code: string,
): Promise<AuthTokens> {
  const res = await fetch(`${API_BASE}/auth/login/totp`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ pendingToken, code }),
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.detail || 'TOTP verification failed');
  }
  return res.json();
}

export async function verifyRecoveryCode(
  pendingToken: string,
  code: string,
): Promise<AuthTokens & { remainingRecoveryCodes: number }> {
  const res = await fetch(`${API_BASE}/auth/login/recovery`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ pendingToken, code }),
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.detail || 'Recovery code verification failed');
  }
  return res.json();
}

export async function setup(
  email: string,
  password: string,
  displayName?: string,
): Promise<AuthTokens> {
  const res = await fetch(`${API_BASE}/auth/setup`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password, displayName }),
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.detail || 'Setup failed');
  }
  return res.json();
}

export interface TOTPSetupResponse {
  secret: string;
  provisioningUri: string;
}

export interface TOTPConfirmResponse {
  status: string;
  recoveryCodes: string[];
}

export async function setupTOTP(): Promise<TOTPSetupResponse> {
  const res = await authFetch(`${API_BASE}/auth/totp/setup`, {
    method: 'POST',
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.detail || 'TOTP setup failed');
  }
  return res.json();
}

export async function confirmTOTP(code: string): Promise<TOTPConfirmResponse> {
  const res = await authFetch(`${API_BASE}/auth/totp/confirm`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ code }),
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.detail || 'TOTP confirmation failed');
  }
  return res.json();
}

export async function logout(): Promise<void> {
  const refreshToken = getRefreshToken();
  if (refreshToken && _accessToken) {
    try {
      await fetch(`${API_BASE}/auth/logout`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${_accessToken}`,
        },
        body: JSON.stringify({ refreshToken }),
      });
    } catch {
      // Best-effort
    }
  }
  clearTokens();
}

export async function fetchMe(): Promise<AuthUserInfo> {
  const res = await authFetch(`${API_BASE}/auth/me`);
  if (!res.ok) throw new Error('Not authenticated');
  return res.json();
}
