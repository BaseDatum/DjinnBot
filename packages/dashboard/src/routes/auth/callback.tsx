import { createFileRoute, useNavigate } from '@tanstack/react-router';
import { useEffect, useState } from 'react';
import { useAuth } from '@/hooks/useAuth';
import { setTokens, verifyTOTP, verifyRecoveryCode } from '@/lib/auth';
import type { AuthTokens } from '@/lib/auth';
import { toast } from 'sonner';

export const Route = createFileRoute('/auth/callback')({
  component: OIDCCallbackPage,
});

function OIDCCallbackPage() {
  const { handleLoginSuccess } = useAuth();
  const navigate = useNavigate();
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  // TOTP challenge after OIDC
  const [pendingToken, setPendingToken] = useState<string | null>(null);
  const [totpCode, setTotpCode] = useState('');
  const [useRecovery, setUseRecovery] = useState(false);
  const [totpLoading, setTotpLoading] = useState(false);

  useEffect(() => {
    // The OIDC callback returns the result as query params.
    // The actual token exchange happens on the backend's callback endpoint,
    // which returns the tokens as JSON. We need to fetch that endpoint.
    //
    // However, the OIDC flow redirects the browser to the backend callback URL,
    // which then needs to redirect back to the frontend with tokens.
    //
    // Approach: The backend callback returns JSON. The frontend's authorize
    // endpoint opens a new window or redirects. For simplicity, we handle
    // the case where the frontend receives the tokens via the URL hash or
    // by the backend redirecting to this page with a code.
    
    const params = new URLSearchParams(window.location.search);
    const accessToken = params.get('accessToken');
    const refreshToken = params.get('refreshToken');
    const requiresTOTP = params.get('requiresTOTP') === 'true';
    const pending = params.get('pendingToken');
    const errorParam = params.get('error');

    if (errorParam) {
      setError(errorParam);
      setLoading(false);
      return;
    }

    if (requiresTOTP && pending) {
      setPendingToken(pending);
      setLoading(false);
      return;
    }

    if (accessToken && refreshToken) {
      const tokens: AuthTokens = {
        accessToken,
        refreshToken,
        tokenType: 'Bearer',
        expiresIn: 900,
        user: {
          id: '',
          email: null,
          displayName: null,
          isAdmin: false,
          totpEnabled: false,
        },
      };
      setTokens(tokens);
      // Fetch actual user info
      handleLoginSuccess(tokens);
      navigate({ to: '/' });
      return;
    }

    setError('Invalid callback — no tokens received');
    setLoading(false);
  }, []);

  const handleTOTP = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!pendingToken) return;
    setTotpLoading(true);
    try {
      let result;
      if (useRecovery) {
        result = await verifyRecoveryCode(pendingToken, totpCode);
      } else {
        result = await verifyTOTP(pendingToken, totpCode);
      }
      handleLoginSuccess(result);
      navigate({ to: '/' });
    } catch (err: any) {
      toast.error(err.message || 'Verification failed');
    } finally {
      setTotpLoading(false);
    }
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center min-h-screen bg-background">
        <div className="text-center">
          <div className="animate-spin w-8 h-8 border-2 border-primary border-t-transparent rounded-full mx-auto" />
          <p className="mt-4 text-muted-foreground">Completing sign-in...</p>
        </div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="flex items-center justify-center min-h-screen bg-background">
        <div className="w-full max-w-sm p-8 space-y-4 bg-card rounded-lg border border-border shadow-lg text-center">
          <h1 className="text-xl font-bold text-destructive">Sign-in Failed</h1>
          <p className="text-sm text-muted-foreground">{error}</p>
          <button
            onClick={() => navigate({ to: '/login' as any })}
            className="w-full py-2 px-4 rounded-md bg-primary text-primary-foreground font-medium hover:bg-primary/90 transition-colors"
          >
            Back to Login
          </button>
        </div>
      </div>
    );
  }

  // TOTP challenge
  if (pendingToken) {
    return (
      <div className="flex items-center justify-center min-h-screen bg-background">
        <div className="w-full max-w-sm p-8 space-y-6 bg-card rounded-lg border border-border shadow-lg">
          <div className="text-center">
            <h1 className="text-2xl font-bold text-foreground">Two-Factor Authentication</h1>
            <p className="text-sm text-muted-foreground mt-2">
              {useRecovery
                ? 'Enter a recovery code'
                : 'Enter the code from your authenticator app'}
            </p>
          </div>
          <form onSubmit={handleTOTP} className="space-y-4">
            <input
              type="text"
              value={totpCode}
              onChange={(e) => setTotpCode(e.target.value)}
              placeholder={useRecovery ? 'XXXX-XXXX' : '000000'}
              className="w-full px-3 py-2 rounded-md border border-input bg-background text-foreground text-center text-lg tracking-widest font-mono focus:outline-none focus:ring-2 focus:ring-ring"
              autoFocus
            />
            <button
              type="submit"
              disabled={totpLoading || !totpCode.trim()}
              className="w-full py-2 px-4 rounded-md bg-primary text-primary-foreground font-medium hover:bg-primary/90 disabled:opacity-50 transition-colors"
            >
              {totpLoading ? 'Verifying...' : 'Verify'}
            </button>
          </form>
          <button
            onClick={() => { setUseRecovery(!useRecovery); setTotpCode(''); }}
            className="w-full text-sm text-muted-foreground hover:text-foreground transition-colors text-center"
          >
            {useRecovery ? 'Use authenticator app' : 'Use a recovery code'}
          </button>
        </div>
      </div>
    );
  }

  return null;
}
