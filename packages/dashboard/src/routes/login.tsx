import { createFileRoute, useNavigate } from '@tanstack/react-router';
import { useState } from 'react';
import { useAuth } from '@/hooks/useAuth';
import { login, verifyTOTP, verifyRecoveryCode } from '@/lib/auth';
import { API_BASE } from '@/lib/api';
import { toast } from 'sonner';
import { ArrowLeft } from 'lucide-react';

export const Route = createFileRoute('/login')({
  component: LoginPage,
});

function LoginPage() {
  const { authStatus, handleLoginSuccess, isAuthenticated } = useAuth();
  const navigate = useNavigate();

  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [loading, setLoading] = useState(false);

  // TOTP challenge state
  const [pendingToken, setPendingToken] = useState<string | null>(null);
  const [totpCode, setTotpCode] = useState('');
  const [useRecovery, setUseRecovery] = useState(false);

  // Waitlist state
  const [showWaitlist, setShowWaitlist] = useState(false);
  const [waitlistEmail, setWaitlistEmail] = useState('');
  const [waitlistLoading, setWaitlistLoading] = useState(false);
  const [waitlistSubmitted, setWaitlistSubmitted] = useState(false);

  // Redirect if already authenticated
  if (isAuthenticated) {
    navigate({ to: '/' });
    return null;
  }

  // Redirect to setup if not yet set up
  if (authStatus && !authStatus.setupComplete) {
    navigate({ to: '/setup' });
    return null;
  }

  const handleLogin = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoading(true);
    try {
      const result = await login(email, password);
      if (result.requiresTOTP && result.pendingToken) {
        setPendingToken(result.pendingToken);
      } else {
        handleLoginSuccess(result);
        navigate({ to: '/' });
      }
    } catch (err: any) {
      toast.error(err.message || 'Login failed');
    } finally {
      setLoading(false);
    }
  };

  const handleTOTP = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!pendingToken) return;
    setLoading(true);
    try {
      let result;
      if (useRecovery) {
        result = await verifyRecoveryCode(pendingToken, totpCode);
        if (result.remainingRecoveryCodes <= 2) {
          toast.warning(`Only ${result.remainingRecoveryCodes} recovery codes remaining`);
        }
      } else {
        result = await verifyTOTP(pendingToken, totpCode);
      }
      handleLoginSuccess(result);
      navigate({ to: '/' });
    } catch (err: any) {
      toast.error(err.message || 'Verification failed');
    } finally {
      setLoading(false);
    }
  };

  const handleOIDCLogin = (slug: string) => {
    // Redirect to the OIDC authorize endpoint — the backend returns the authorization URL
    window.location.href = `${API_BASE}/auth/oidc/${slug}/authorize`;
  };

  const handleWaitlistSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!waitlistEmail.trim()) return;
    setWaitlistLoading(true);
    try {
      const res = await fetch(`${API_BASE}/waitlist/join`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: waitlistEmail.trim() }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.detail || 'Failed to join waitlist');
      }
      setWaitlistSubmitted(true);
    } catch (err: any) {
      toast.error(err.message || 'Failed to join waitlist');
    } finally {
      setWaitlistLoading(false);
    }
  };

  // Waitlist screen
  if (showWaitlist) {
    return (
      <div className="flex items-center justify-center min-h-screen bg-background">
        <div className="w-full max-w-sm p-8 space-y-6 bg-card rounded-lg border border-border shadow-lg">
          {waitlistSubmitted ? (
            <>
              <div className="text-center space-y-3">
                <div className="mx-auto w-14 h-14 rounded-full bg-primary/10 flex items-center justify-center">
                  <svg className="w-7 h-7 text-primary" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                    <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
                  </svg>
                </div>
                <h1 className="text-2xl font-bold text-foreground">You're on the list!</h1>
                <p className="text-sm text-muted-foreground">
                  We'll send an invite to <strong className="text-foreground">{waitlistEmail}</strong> when a spot opens up.
                </p>
              </div>
              <button
                onClick={() => {
                  setShowWaitlist(false);
                  setWaitlistSubmitted(false);
                  setWaitlistEmail('');
                }}
                className="w-full py-2 px-4 rounded-md border border-input font-medium hover:bg-accent transition-colors text-sm"
              >
                Back to login
              </button>
            </>
          ) : (
            <>
              <div className="text-center">
                <h1 className="text-2xl font-bold text-foreground">Join the Waitlist</h1>
                <p className="text-sm text-muted-foreground mt-2">
                  DjinnBot is currently invite-only. Enter your email and we'll let you know when a spot opens up.
                </p>
              </div>

              <form onSubmit={handleWaitlistSubmit} className="space-y-4">
                <div>
                  <label className="block text-sm font-medium text-foreground mb-1">Email</label>
                  <input
                    type="email"
                    value={waitlistEmail}
                    onChange={(e) => setWaitlistEmail(e.target.value)}
                    className="w-full px-3 py-2 rounded-md border border-input bg-background text-foreground focus:outline-none focus:ring-2 focus:ring-ring"
                    placeholder="you@example.com"
                    autoFocus
                    required
                  />
                </div>
                <button
                  type="submit"
                  disabled={waitlistLoading || !waitlistEmail.trim()}
                  className="w-full py-2 px-4 rounded-md bg-primary text-primary-foreground font-medium hover:bg-primary/90 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
                >
                  {waitlistLoading ? 'Joining...' : 'Join the Waitlist'}
                </button>
              </form>

              <button
                onClick={() => setShowWaitlist(false)}
                className="w-full flex items-center justify-center gap-1 text-sm text-muted-foreground hover:text-foreground transition-colors"
              >
                <ArrowLeft className="h-3.5 w-3.5" />
                Back to login
              </button>
            </>
          )}
        </div>
      </div>
    );
  }

  // TOTP challenge screen
  if (pendingToken) {
    return (
      <div className="flex items-center justify-center min-h-screen bg-background">
        <div className="w-full max-w-sm p-8 space-y-6 bg-card rounded-lg border border-border shadow-lg">
          <div className="text-center">
            <h1 className="text-2xl font-bold text-foreground">Two-Factor Authentication</h1>
            <p className="text-sm text-muted-foreground mt-2">
              {useRecovery
                ? 'Enter one of your recovery codes'
                : 'Enter the 6-digit code from your authenticator app'}
            </p>
          </div>

          <form onSubmit={handleTOTP} className="space-y-4">
            <div>
              <input
                type="text"
                value={totpCode}
                onChange={(e) => setTotpCode(e.target.value)}
                placeholder={useRecovery ? 'XXXX-XXXX' : '000000'}
                className="w-full px-3 py-2 rounded-md border border-input bg-background text-foreground text-center text-lg tracking-widest font-mono focus:outline-none focus:ring-2 focus:ring-ring"
                autoFocus
                autoComplete="one-time-code"
              />
            </div>

            <button
              type="submit"
              disabled={loading || !totpCode.trim()}
              className="w-full py-2 px-4 rounded-md bg-primary text-primary-foreground font-medium hover:bg-primary/90 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
            >
              {loading ? 'Verifying...' : 'Verify'}
            </button>
          </form>

          <div className="text-center">
            <button
              onClick={() => {
                setUseRecovery(!useRecovery);
                setTotpCode('');
              }}
              className="text-sm text-muted-foreground hover:text-foreground transition-colors"
            >
              {useRecovery ? 'Use authenticator app instead' : 'Use a recovery code'}
            </button>
          </div>

          <button
            onClick={() => {
              setPendingToken(null);
              setTotpCode('');
              setUseRecovery(false);
            }}
            className="w-full text-sm text-muted-foreground hover:text-foreground transition-colors"
          >
            Back to login
          </button>
        </div>
      </div>
    );
  }

  // Main login screen
  return (
    <div className="flex items-center justify-center min-h-screen bg-background">
      <div className="w-full max-w-sm p-8 space-y-6 bg-card rounded-lg border border-border shadow-lg">
        <div className="text-center">
          <h1 className="text-2xl font-bold text-foreground">DjinnBot</h1>
          <p className="text-sm text-muted-foreground mt-1">Sign in to continue</p>
          <span className="inline-block mt-2 px-2.5 py-0.5 text-xs font-medium rounded-full bg-primary/10 text-primary border border-primary/20">
            Invite Only
          </span>
        </div>

        {/* OIDC provider buttons */}
        {authStatus?.oidcProviders && authStatus.oidcProviders.length > 0 && (
          <div className="space-y-2">
            {authStatus.oidcProviders.map((provider) => (
              <button
                key={provider.id}
                onClick={() => handleOIDCLogin(provider.slug)}
                className="w-full flex items-center justify-center gap-2 py-2 px-4 rounded-md border border-input font-medium hover:bg-accent transition-colors"
                style={provider.buttonColor ? { backgroundColor: provider.buttonColor, color: '#fff', borderColor: provider.buttonColor } : undefined}
              >
                {provider.iconUrl && (
                  <img src={provider.iconUrl} alt="" className="w-5 h-5" />
                )}
                {provider.buttonText}
              </button>
            ))}
            <div className="relative my-4">
              <div className="absolute inset-0 flex items-center">
                <div className="w-full border-t border-border" />
              </div>
              <div className="relative flex justify-center text-xs uppercase">
                <span className="bg-card px-2 text-muted-foreground">or</span>
              </div>
            </div>
          </div>
        )}

        {/* Email/password form */}
        <form onSubmit={handleLogin} className="space-y-4">
          <div>
            <label className="block text-sm font-medium text-foreground mb-1">Email</label>
            <input
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              className="w-full px-3 py-2 rounded-md border border-input bg-background text-foreground focus:outline-none focus:ring-2 focus:ring-ring"
              autoFocus
              required
            />
          </div>
          <div>
            <label className="block text-sm font-medium text-foreground mb-1">Password</label>
            <input
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              className="w-full px-3 py-2 rounded-md border border-input bg-background text-foreground focus:outline-none focus:ring-2 focus:ring-ring"
              required
            />
          </div>

          <button
            type="submit"
            disabled={loading || !email || !password}
            className="w-full py-2 px-4 rounded-md bg-primary text-primary-foreground font-medium hover:bg-primary/90 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
          >
            {loading ? 'Signing in...' : 'Sign in'}
          </button>
        </form>

        <div className="relative">
          <div className="absolute inset-0 flex items-center">
            <div className="w-full border-t border-border" />
          </div>
          <div className="relative flex justify-center text-xs uppercase">
            <span className="bg-card px-2 text-muted-foreground">or</span>
          </div>
        </div>

        <button
          onClick={() => setShowWaitlist(true)}
          className="w-full py-2 px-4 rounded-md border border-primary/30 text-primary font-medium hover:bg-primary/5 transition-colors text-sm"
        >
          Join the Waitlist
        </button>
      </div>
    </div>
  );
}
