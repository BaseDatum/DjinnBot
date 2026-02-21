import { createFileRoute, useNavigate } from '@tanstack/react-router';
import { useState } from 'react';
import { useAuth } from '@/hooks/useAuth';
import { setup, setupTOTP, confirmTOTP, type TOTPSetupResponse } from '@/lib/auth';
import { toast } from 'sonner';
import { QRCodeSVG } from 'qrcode.react';

export const Route = createFileRoute('/setup')({
  component: SetupPage,
});

type SetupStep = 'account' | 'recommend2fa' | 'totpSetup' | 'recoveryCodes';

function SetupPage() {
  const { authStatus, handleLoginSuccess, isAuthenticated } = useAuth();
  const navigate = useNavigate();

  // Account creation state
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [loading, setLoading] = useState(false);

  // Multi-step state
  const [step, setStep] = useState<SetupStep>('account');
  // TOTP state
  const [totpData, setTotpData] = useState<TOTPSetupResponse | null>(null);
  const [totpCode, setTotpCode] = useState('');
  const [recoveryCodes, setRecoveryCodes] = useState<string[]>([]);
  const [copiedCodes, setCopiedCodes] = useState(false);

  // Redirect if already set up
  if (authStatus?.setupComplete) {
    navigate({ to: '/login' as any });
    return null;
  }

  // Redirect if already authenticated (only after setup is fully complete)
  if (isAuthenticated && step === 'account') {
    navigate({ to: '/' });
    return null;
  }

  const handleSetup = async (e: React.FormEvent) => {
    e.preventDefault();

    if (password !== confirmPassword) {
      toast.error('Passwords do not match');
      return;
    }
    if (password.length < 8) {
      toast.error('Password must be at least 8 characters');
      return;
    }

    setLoading(true);
    try {
      const result = await setup(email, password, displayName || undefined);
      handleLoginSuccess(result);
      toast.success('Admin account created');
      setStep('recommend2fa');
    } catch (err: any) {
      toast.error(err.message || 'Setup failed');
    } finally {
      setLoading(false);
    }
  };

  const handleStartTOTP = async () => {
    setLoading(true);
    try {
      const data = await setupTOTP();
      setTotpData(data);
      setStep('totpSetup');
    } catch (err: any) {
      toast.error(err.message || 'Failed to start 2FA setup');
    } finally {
      setLoading(false);
    }
  };

  const handleConfirmTOTP = async (e: React.FormEvent) => {
    e.preventDefault();
    if (totpCode.length !== 6) {
      toast.error('Enter a 6-digit code');
      return;
    }
    setLoading(true);
    try {
      const result = await confirmTOTP(totpCode);
      setRecoveryCodes(result.recoveryCodes);
      toast.success('Two-factor authentication enabled');
      setStep('recoveryCodes');
    } catch (err: any) {
      toast.error(err.message || 'Invalid code, please try again');
    } finally {
      setLoading(false);
    }
  };

  const handleSkip2FA = () => {
    navigate({ to: '/' });
  };

  const handleFinish = () => {
    navigate({ to: '/' });
  };

  const handleCopyRecoveryCodes = () => {
    navigator.clipboard.writeText(recoveryCodes.join('\n'));
    setCopiedCodes(true);
    toast.success('Recovery codes copied to clipboard');
  };

  return (
    <div className="flex items-center justify-center min-h-screen bg-background">
      <div className="w-full max-w-sm p-8 space-y-6 bg-card rounded-lg border border-border shadow-lg">
        {step === 'account' && (
          <>
            <div className="text-center">
              <h1 className="text-2xl font-bold text-foreground">DjinnBot Setup</h1>
              <p className="text-sm text-muted-foreground mt-2">
                Create your admin account to get started.
              </p>
            </div>

            <form onSubmit={handleSetup} className="space-y-4">
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
                <label className="block text-sm font-medium text-foreground mb-1">Display Name</label>
                <input
                  type="text"
                  value={displayName}
                  onChange={(e) => setDisplayName(e.target.value)}
                  placeholder="Optional"
                  className="w-full px-3 py-2 rounded-md border border-input bg-background text-foreground focus:outline-none focus:ring-2 focus:ring-ring"
                />
              </div>

              <div>
                <label className="block text-sm font-medium text-foreground mb-1">Password</label>
                <input
                  type="password"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  className="w-full px-3 py-2 rounded-md border border-input bg-background text-foreground focus:outline-none focus:ring-2 focus:ring-ring"
                  minLength={8}
                  required
                />
              </div>

              <div>
                <label className="block text-sm font-medium text-foreground mb-1">Confirm Password</label>
                <input
                  type="password"
                  value={confirmPassword}
                  onChange={(e) => setConfirmPassword(e.target.value)}
                  className="w-full px-3 py-2 rounded-md border border-input bg-background text-foreground focus:outline-none focus:ring-2 focus:ring-ring"
                  minLength={8}
                  required
                />
              </div>

              <button
                type="submit"
                disabled={loading || !email || !password || !confirmPassword}
                className="w-full py-2 px-4 rounded-md bg-primary text-primary-foreground font-medium hover:bg-primary/90 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
              >
                {loading ? 'Creating account...' : 'Create Admin Account'}
              </button>
            </form>
          </>
        )}

        {step === 'recommend2fa' && (
          <>
            <div className="text-center">
              <h1 className="text-2xl font-bold text-foreground">Secure Your Account</h1>
              <p className="text-sm text-muted-foreground mt-2">
                We strongly recommend enabling two-factor authentication (2FA) to protect your admin account.
              </p>
            </div>

            <div className="rounded-md border border-yellow-500/30 bg-yellow-500/10 p-4 text-sm text-foreground">
              <p className="font-medium mb-1">Why enable 2FA?</p>
              <ul className="list-disc list-inside space-y-1 text-muted-foreground">
                <li>Prevents unauthorized access even if your password is compromised</li>
                <li>Required best practice for admin accounts</li>
                <li>Takes less than a minute to set up</li>
              </ul>
            </div>

            <div className="space-y-3">
              <button
                onClick={handleStartTOTP}
                disabled={loading}
                className="w-full py-2 px-4 rounded-md bg-primary text-primary-foreground font-medium hover:bg-primary/90 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
              >
                {loading ? 'Setting up...' : 'Enable Two-Factor Authentication'}
              </button>

              <button
                onClick={handleSkip2FA}
                className="w-full py-2 px-4 rounded-md border border-input bg-background text-muted-foreground font-medium hover:bg-accent hover:text-foreground transition-colors"
              >
                Skip for now
              </button>
            </div>
          </>
        )}

        {step === 'totpSetup' && totpData && (
          <>
            <div className="text-center">
              <h1 className="text-2xl font-bold text-foreground">Set Up 2FA</h1>
              <p className="text-sm text-muted-foreground mt-2">
                Scan this QR code with your authenticator app, then enter the 6-digit code to verify.
              </p>
            </div>

            <div className="flex justify-center">
              <div className="bg-white p-3 rounded-lg">
                <QRCodeSVG value={totpData.provisioningUri} size={192} />
              </div>
            </div>

            <div>
              <p className="text-xs text-muted-foreground text-center mb-1">
                Can't scan? Enter this key manually:
              </p>
              <code className="block text-center text-xs font-mono bg-muted p-2 rounded-md break-all select-all">
                {totpData.secret}
              </code>
            </div>

            <form onSubmit={handleConfirmTOTP} className="space-y-4">
              <div>
                <label className="block text-sm font-medium text-foreground mb-1">
                  Verification Code
                </label>
                <input
                  type="text"
                  inputMode="numeric"
                  pattern="[0-9]*"
                  maxLength={6}
                  value={totpCode}
                  onChange={(e) => setTotpCode(e.target.value.replace(/\D/g, ''))}
                  placeholder="000000"
                  className="w-full px-3 py-2 rounded-md border border-input bg-background text-foreground text-center text-lg tracking-widest font-mono focus:outline-none focus:ring-2 focus:ring-ring"
                  autoFocus
                  required
                />
              </div>

              <button
                type="submit"
                disabled={loading || totpCode.length !== 6}
                className="w-full py-2 px-4 rounded-md bg-primary text-primary-foreground font-medium hover:bg-primary/90 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
              >
                {loading ? 'Verifying...' : 'Verify & Enable'}
              </button>
            </form>
          </>
        )}

        {step === 'recoveryCodes' && (
          <>
            <div className="text-center">
              <h1 className="text-2xl font-bold text-foreground">Save Recovery Codes</h1>
              <p className="text-sm text-muted-foreground mt-2">
                Store these codes in a safe place. Each code can only be used once to access your account if you lose your authenticator device.
              </p>
            </div>

            <div className="rounded-md border border-border bg-muted p-4">
              <div className="grid grid-cols-2 gap-2">
                {recoveryCodes.map((code) => (
                  <code key={code} className="text-xs font-mono text-foreground text-center py-1">
                    {code}
                  </code>
                ))}
              </div>
            </div>

            <div className="space-y-3">
              <button
                onClick={handleCopyRecoveryCodes}
                className="w-full py-2 px-4 rounded-md border border-input bg-background text-foreground font-medium hover:bg-accent transition-colors"
              >
                {copiedCodes ? 'Copied!' : 'Copy to Clipboard'}
              </button>

              <button
                onClick={handleFinish}
                className="w-full py-2 px-4 rounded-md bg-primary text-primary-foreground font-medium hover:bg-primary/90 transition-colors"
              >
                Continue to Dashboard
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
