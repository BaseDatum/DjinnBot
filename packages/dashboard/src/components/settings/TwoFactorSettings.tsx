/**
 * Two-Factor Authentication settings — enable/disable TOTP, show QR code, recovery codes.
 */

import { useState } from 'react';
import { toast } from 'sonner';
import { authFetch, setupTOTP, confirmTOTP, type TOTPSetupResponse } from '@/lib/auth';
import { API_BASE } from '@/lib/api';
import { useAuth } from '@/hooks/useAuth';
import { Shield, ShieldCheck, Copy, Download } from 'lucide-react';
import { QRCodeSVG } from 'qrcode.react';

export function TwoFactorSettings() {
  const { user, refreshUser } = useAuth();

  const [setupData, setSetupData] = useState<TOTPSetupResponse | null>(null);
  const [confirmCode, setConfirmCode] = useState('');
  const [recoveryCodes, setRecoveryCodes] = useState<string[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [copiedCodes, setCopiedCodes] = useState(false);

  // Disable state
  const [showDisable, setShowDisable] = useState(false);
  const [disablePassword, setDisablePassword] = useState('');
  const [disableCode, setDisableCode] = useState('');

  const startSetup = async () => {
    setLoading(true);
    try {
      const data = await setupTOTP();
      setSetupData(data);
    } catch (err: any) {
      toast.error(err.message || 'Failed to start TOTP setup');
    } finally {
      setLoading(false);
    }
  };

  const confirmSetup = async () => {
    if (confirmCode.length !== 6) {
      toast.error('Enter a 6-digit code');
      return;
    }
    setLoading(true);
    try {
      const data = await confirmTOTP(confirmCode);
      setRecoveryCodes(data.recoveryCodes);
      setSetupData(null);
      setConfirmCode('');
      await refreshUser();
      toast.success('Two-factor authentication enabled');
    } catch (err: any) {
      toast.error(err.message || 'Invalid code');
    } finally {
      setLoading(false);
    }
  };

  const disableTOTP = async () => {
    setLoading(true);
    try {
      const res = await authFetch(`${API_BASE}/auth/totp`, {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          password: disablePassword || undefined,
          totpCode: disableCode || undefined,
        }),
      });
      if (!res.ok) throw new Error((await res.json()).detail);
      setShowDisable(false);
      setDisablePassword('');
      setDisableCode('');
      await refreshUser();
      toast.success('Two-factor authentication disabled');
    } catch (err: any) {
      toast.error(err.message || 'Verification failed');
    } finally {
      setLoading(false);
    }
  };

  const copyRecoveryCodes = () => {
    if (recoveryCodes) {
      navigator.clipboard.writeText(recoveryCodes.join('\n'));
      setCopiedCodes(true);
      toast.success('Recovery codes copied');
    }
  };

  const downloadRecoveryCodes = () => {
    if (!recoveryCodes) return;
    const text = `DjinnBot Recovery Codes\n${'='.repeat(30)}\n\nSave these codes in a safe place.\nEach code can only be used once.\n\n${recoveryCodes.join('\n')}\n`;
    const blob = new Blob([text], { type: 'text/plain' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'djinnbot-recovery-codes.txt';
    a.click();
    URL.revokeObjectURL(url);
  };

  // Recovery codes display (shown once after enabling)
  if (recoveryCodes) {
    return (
      <div className="space-y-4">
        <div className="flex items-center gap-2">
          <ShieldCheck className="w-5 h-5 text-green-500" />
          <h3 className="text-lg font-semibold text-foreground">Save Recovery Codes</h3>
        </div>
        <div className="p-4 rounded-md border border-yellow-500/30 bg-yellow-500/5 space-y-3">
          <p className="text-sm font-medium text-yellow-500">
            Save these codes now — they will not be shown again.
          </p>
          <p className="text-xs text-muted-foreground">
            Store these codes in a safe place. Each code can only be used once
            to access your account if you lose your authenticator device.
          </p>
          <div className="grid grid-cols-2 gap-2 p-3 bg-background rounded border border-input">
            {recoveryCodes.map((code, i) => (
              <code key={i} className="text-sm font-mono text-foreground text-center py-1">{code}</code>
            ))}
          </div>
          <div className="flex items-center gap-2">
            <button onClick={copyRecoveryCodes}
              className="flex items-center gap-1.5 px-3 py-1.5 text-sm rounded-md border border-input hover:bg-accent transition-colors">
              <Copy className="w-3.5 h-3.5" /> {copiedCodes ? 'Copied!' : 'Copy'}
            </button>
            <button onClick={downloadRecoveryCodes}
              className="flex items-center gap-1.5 px-3 py-1.5 text-sm rounded-md border border-input hover:bg-accent transition-colors">
              <Download className="w-3.5 h-3.5" /> Download
            </button>
            <button onClick={() => setRecoveryCodes(null)}
              className="px-3 py-1.5 text-sm rounded-md bg-primary text-primary-foreground hover:bg-primary/90 transition-colors">
              I've saved them
            </button>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          {user?.totpEnabled ? (
            <ShieldCheck className="w-5 h-5 text-green-500" />
          ) : (
            <Shield className="w-5 h-5 text-muted-foreground" />
          )}
          <div>
            <h3 className="text-lg font-semibold text-foreground">Two-Factor Authentication</h3>
            <p className="text-sm text-muted-foreground">
              {user?.totpEnabled
                ? 'TOTP is enabled — your account is protected with an authenticator app'
                : 'Add an extra layer of security with an authenticator app'}
            </p>
          </div>
        </div>
      </div>

      {/* TOTP is enabled — show disable option */}
      {user?.totpEnabled && !showDisable && (
        <button
          onClick={() => setShowDisable(true)}
          className="px-4 py-1.5 text-sm rounded-md border border-destructive/30 text-destructive hover:bg-destructive/10 transition-colors"
        >
          Disable 2FA
        </button>
      )}

      {/* Disable confirmation */}
      {showDisable && (
        <div className="p-4 rounded-md border border-destructive/30 bg-destructive/5 space-y-3">
          <p className="text-sm text-destructive font-medium">Confirm disabling two-factor authentication</p>
          <p className="text-xs text-muted-foreground">Enter your password or a TOTP code to verify your identity.</p>
          <div className="flex gap-3">
            <input type="password" value={disablePassword} onChange={e => setDisablePassword(e.target.value)}
              placeholder="Password" className="flex-1 px-3 py-1.5 text-sm rounded-md border border-input bg-background" />
            <span className="text-sm text-muted-foreground self-center">or</span>
            <input value={disableCode} onChange={e => setDisableCode(e.target.value.replace(/\D/g, ''))}
              inputMode="numeric" pattern="[0-9]*" maxLength={6}
              placeholder="TOTP code" className="w-32 px-3 py-1.5 text-sm rounded-md border border-input bg-background text-center font-mono" />
          </div>
          <div className="flex gap-2">
            <button onClick={disableTOTP} disabled={loading || (!disablePassword && !disableCode)}
              className="px-4 py-1.5 text-sm rounded-md bg-destructive text-destructive-foreground hover:bg-destructive/90 disabled:opacity-50 transition-colors">
              {loading ? 'Disabling...' : 'Disable 2FA'}
            </button>
            <button onClick={() => { setShowDisable(false); setDisablePassword(''); setDisableCode(''); }}
              className="px-4 py-1.5 text-sm rounded-md border border-input hover:bg-accent transition-colors">
              Cancel
            </button>
          </div>
        </div>
      )}

      {/* TOTP not enabled — show recommendation + setup button */}
      {!user?.totpEnabled && !setupData && (
        <div className="space-y-3">
          <div className="rounded-md border border-yellow-500/30 bg-yellow-500/10 p-4 text-sm text-foreground">
            <p className="font-medium mb-1">Why enable 2FA?</p>
            <ul className="list-disc list-inside space-y-1 text-muted-foreground">
              <li>Prevents unauthorized access even if your password is compromised</li>
              <li>Required best practice for admin accounts</li>
              <li>Takes less than a minute to set up</li>
            </ul>
          </div>
          <button
            onClick={startSetup}
            disabled={loading}
            className="px-4 py-1.5 text-sm rounded-md bg-primary text-primary-foreground hover:bg-primary/90 disabled:opacity-50 transition-colors"
          >
            {loading ? 'Setting up...' : 'Enable 2FA'}
          </button>
        </div>
      )}

      {/* QR code / setup step */}
      {setupData && (
        <div className="p-4 rounded-md border border-border bg-card space-y-4">
          <p className="text-sm text-foreground">
            Scan this QR code with your authenticator app (Google Authenticator, Authy, 1Password, etc.):
          </p>

          <div className="flex justify-center">
            <div className="bg-white p-3 rounded-lg">
              <QRCodeSVG value={setupData.provisioningUri} size={192} />
            </div>
          </div>

          <div>
            <p className="text-xs text-muted-foreground text-center mb-1">
              Can't scan? Enter this key manually:
            </p>
            <code className="block text-center text-xs font-mono bg-muted p-2 rounded-md break-all select-all">
              {setupData.secret}
            </code>
          </div>

          <form onSubmit={(e) => { e.preventDefault(); confirmSetup(); }} className="space-y-3">
            <div>
              <label className="block text-sm font-medium text-foreground mb-1">
                Verification Code
              </label>
              <input
                type="text"
                inputMode="numeric"
                pattern="[0-9]*"
                maxLength={6}
                value={confirmCode}
                onChange={e => setConfirmCode(e.target.value.replace(/\D/g, ''))}
                placeholder="000000"
                className="w-full px-3 py-2 rounded-md border border-input bg-background text-foreground text-center text-lg tracking-widest font-mono focus:outline-none focus:ring-2 focus:ring-ring"
                autoFocus
                required
              />
            </div>
            <div className="flex gap-2">
              <button
                type="submit"
                disabled={loading || confirmCode.length !== 6}
                className="flex-1 py-2 px-4 text-sm rounded-md bg-primary text-primary-foreground hover:bg-primary/90 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
              >
                {loading ? 'Verifying...' : 'Verify & Enable'}
              </button>
              <button
                type="button"
                onClick={() => { setSetupData(null); setConfirmCode(''); }}
                className="px-4 py-2 text-sm rounded-md border border-input hover:bg-accent transition-colors"
              >
                Cancel
              </button>
            </div>
          </form>
        </div>
      )}
    </div>
  );
}
