/**
 * Auth context provider and useAuth hook.
 *
 * Wraps the app to provide auth state and operations to all components.
 */

import { createContext, useContext, useState, useEffect, useCallback, type ReactNode } from 'react';
import {
  fetchAuthStatus,
  fetchMe,
  setTokens,
  clearTokens,
  hasTokens,
  refreshAccessToken,
  logout as doLogout,
  type AuthStatus,
  type AuthUserInfo,
  type AuthTokens,
} from '@/lib/auth';

interface AuthContextValue {
  /** Current user info (null if not authenticated) */
  user: AuthUserInfo | null;
  /** Auth system status */
  authStatus: AuthStatus | null;
  /** True while initial auth state is being resolved */
  isLoading: boolean;
  /** True when the user has a valid session */
  isAuthenticated: boolean;
  /** Store tokens after successful login/setup */
  handleLoginSuccess: (tokens: AuthTokens) => void;
  /** Log out and clear all tokens */
  handleLogout: () => Promise<void>;
  /** Re-fetch user info (e.g. after enabling TOTP) */
  refreshUser: () => Promise<void>;
}

const AuthContext = createContext<AuthContextValue | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<AuthUserInfo | null>(null);
  const [authStatus, setAuthStatus] = useState<AuthStatus | null>(null);
  const [isLoading, setIsLoading] = useState(true);

  // Bootstrap: fetch auth status, then try to restore session
  useEffect(() => {
    let cancelled = false;

    async function init() {
      try {
        const status = await fetchAuthStatus();
        if (cancelled) return;
        setAuthStatus(status);

        // If auth is disabled, treat everyone as an anonymous admin
        if (!status.authEnabled) {
          setUser({
            id: 'anonymous',
            email: null,
            displayName: 'Anonymous',
            isAdmin: true,
            totpEnabled: false,
          });
          setIsLoading(false);
          return;
        }

        // Try to restore session from refresh token
        if (hasTokens()) {
          const refreshed = await refreshAccessToken();
          if (refreshed && !cancelled) {
            try {
              const me = await fetchMe();
              if (!cancelled) setUser(me);
            } catch {
              clearTokens();
            }
          } else {
            clearTokens();
          }
        }
      } catch (err) {
        console.error('Auth init failed:', err);
      } finally {
        if (!cancelled) setIsLoading(false);
      }
    }

    init();
    return () => { cancelled = true; };
  }, []);

  const handleLoginSuccess = useCallback((tokens: AuthTokens) => {
    setTokens(tokens);
    setUser(tokens.user);
    // Mark setup as complete so AuthGate stops redirecting to /setup
    setAuthStatus(prev => prev ? { ...prev, setupComplete: true } : prev);
  }, []);

  const handleLogout = useCallback(async () => {
    await doLogout();
    setUser(null);
  }, []);

  const refreshUser = useCallback(async () => {
    try {
      const me = await fetchMe();
      setUser(me);
    } catch {
      // ignore
    }
  }, []);

  const isAuthenticated = !!user || (authStatus?.authEnabled === false);

  return (
    <AuthContext.Provider
      value={{
        user,
        authStatus,
        isLoading,
        isAuthenticated,
        handleLoginSuccess,
        handleLogout,
        refreshUser,
      }}
    >
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used within AuthProvider');
  return ctx;
}
