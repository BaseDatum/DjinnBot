import { useState, useEffect, useCallback } from 'react';
import { API_BASE } from '@/lib/api';
import { authFetch } from '@/lib/auth';
import { Card, CardHeader, CardTitle, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Badge } from '@/components/ui/badge';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Skeleton } from '@/components/ui/skeleton';
import {
  ExternalLink,
  Loader2,
  RefreshCw,
  Github,
  CheckCircle2,
  XCircle,
  Plus,
  Building2,
  User,
  AlertTriangle,
  Terminal,
} from 'lucide-react';
import { toast } from 'sonner';

interface SetupStatus {
  configured: boolean;
  missing: string[];
  app_name: string | null;
  app_id: number | null;
}

interface AppInstallation {
  installation_id: number;
  account_login: string;
  account_type: string;
  account_avatar_url: string;
  app_id: number;
  app_slug: string;
  repository_selection: string;
  installed_at: string;
}

/**
 * GitHubAppInstallations
 *
 * Shows all accounts/orgs the GitHub App is installed in.
 *
 * If the App is not configured it renders a clear setup guide explaining
 * exactly which env vars and files are missing instead of a generic error.
 */
export function GitHubAppInstallations() {
  const [setup, setSetup] = useState<SetupStatus | null>(null);
  const [installations, setInstallations] = useState<AppInstallation[]>([]);
  const [loading, setLoading] = useState(true);

  // Manual registration state
  const [manualId, setManualId] = useState('');
  const [manualLoading, setManualLoading] = useState(false);
  const [manualResult, setManualResult] = useState<{
    ok: boolean;
    account_login?: string;
    account_type?: string;
    message?: string;
  } | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      // Always fetch setup-status first — it never throws
      const statusRes = await authFetch(`${API_BASE}/github/setup-status`);
      const statusData: SetupStatus = await statusRes.json();
      setSetup(statusData);

      // Only fetch installations if the App is configured
      if (statusData.configured) {
        const instRes = await authFetch(`${API_BASE}/github/installations`);
        if (instRes.ok) {
          setInstallations(await instRes.json());
        }
      }
    } catch (err) {
      // Network failure — show a minimal message, don't crash
      setSetup({
        configured: false,
        missing: ['Could not reach the API server. Is the backend running?'],
        app_name: null,
        app_id: null,
      });
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const handleInstallNew = () => {
    const name = setup?.app_name;
    if (!name) return;
    window.open(
      `https://github.com/apps/${name}/installations/new`,
      '_blank',
      'noopener,noreferrer',
    );
  };

  const handleManualRegister = async () => {
    const id = parseInt(manualId.trim(), 10);
    if (isNaN(id) || id <= 0) {
      toast.error('Enter a valid numeric installation ID');
      return;
    }
    setManualLoading(true);
    setManualResult(null);
    try {
      const res = await authFetch(`${API_BASE}/github/manual-callback`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ installation_id: id }),
      });
      const data = await res.json();
      if (!res.ok) {
        setManualResult({ ok: false, message: data.detail || 'Registration failed' });
        return;
      }
      setManualResult({ ok: true, account_login: data.account_login, account_type: data.account_type });
      toast.success(`Installation ${id} (${data.account_login}) confirmed`);
      await load();
    } catch (err) {
      setManualResult({ ok: false, message: err instanceof Error ? err.message : 'Request failed' });
    } finally {
      setManualLoading(false);
    }
  };

  // ── Loading ──────────────────────────────────────────────────────────────
  if (loading) {
    return (
      <div className="space-y-6">
        {/* Header skeleton */}
        <div className="flex items-center justify-between">
          <div className="space-y-2 flex-1">
            <Skeleton width="30%" height={22} />
            <Skeleton width="65%" height={14} />
          </div>
          <div className="flex items-center gap-2 shrink-0">
            <Skeleton width={88} height={32} />
            <Skeleton width={120} height={32} />
          </div>
        </div>

        {/* Installations card skeleton */}
        <Card>
          <CardHeader className="pb-3">
            <Skeleton width="25%" height={14} />
          </CardHeader>
          <CardContent className="pt-0 space-y-0 divide-y">
            {[...Array(3)].map((_, i) => (
              <div key={i} className="py-3 flex items-center gap-3">
                <Skeleton circle width={32} height={32} />
                <div className="flex-1 space-y-1.5">
                  <div className="flex items-center gap-2">
                    <Skeleton width={100} height={14} />
                    <Skeleton width={70} height={20} />
                    <Skeleton width={60} height={20} />
                  </div>
                  <Skeleton width={120} height={12} />
                </div>
                <Skeleton width={14} height={14} />
              </div>
            ))}
          </CardContent>
        </Card>

        {/* Manual registration card skeleton */}
        <Card>
          <CardHeader className="pb-3">
            <Skeleton width="40%" height={14} />
          </CardHeader>
          <CardContent className="pt-0 space-y-3">
            <Skeleton height={14} />
            <Skeleton width="60%" height={14} />
            <div className="flex gap-2">
              <Skeleton width={240} height={36} />
              <Skeleton width={72} height={36} />
            </div>
          </CardContent>
        </Card>
      </div>
    );
  }

  // ── Not configured — show setup guide ───────────────────────────────────
  if (setup && !setup.configured) {
    return (
      <div className="space-y-6 max-w-2xl">
        <div>
          <h2 className="text-lg font-semibold flex items-center gap-2">
            <Github className="h-5 w-5" />
            GitHub App
          </h2>
          <p className="text-sm text-muted-foreground mt-1">
            Connect the backend to GitHub so agents can read and push to repositories.
          </p>
        </div>

        <Alert variant="destructive">
          <AlertTriangle className="h-4 w-4" />
          <AlertTitle>GitHub App is not configured</AlertTitle>
          <AlertDescription>
            The following {setup.missing.length === 1 ? 'item is' : 'items are'} missing:
            <ul className="mt-2 space-y-1 list-disc list-inside">
              {setup.missing.map((m, i) => (
                <li key={i} className="text-sm">{m}</li>
              ))}
            </ul>
          </AlertDescription>
        </Alert>

        {/* Setup guide */}
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="text-sm font-medium">Setup Guide</CardTitle>
          </CardHeader>
          <CardContent className="space-y-5 text-sm">
            <ol className="space-y-4 list-decimal list-inside">
              <li>
                <span className="font-medium">Create a GitHub App</span>
                <p className="text-muted-foreground mt-1 ml-5">
                  Go to{' '}
                  <a
                    href="https://github.com/settings/apps/new"
                    target="_blank"
                    rel="noopener noreferrer"
                    className="underline hover:no-underline inline-flex items-center gap-1"
                  >
                    github.com/settings/apps/new
                    <ExternalLink className="h-3 w-3" />
                  </a>
                  . Give it a name, set the homepage URL to your server URL, and configure the
                  webhook URL to <code className="bg-muted px-1 rounded">{'<your-server>/v1/github/webhooks'}</code>.
                  Grant <strong>Contents</strong> (read/write), <strong>Pull requests</strong> (read/write),
                  and <strong>Metadata</strong> (read) repository permissions, and subscribe to the
                  <strong> push</strong> and <strong>pull_request</strong> events.
                </p>
              </li>

              <li>
                <span className="font-medium">Download the private key</span>
                <p className="text-muted-foreground mt-1 ml-5">
                  On the App settings page scroll to <em>Private keys</em> and click{' '}
                  <em>Generate a private key</em>. Save the downloaded <code className="bg-muted px-1 rounded">.pem</code>{' '}
                  file to <code className="bg-muted px-1 rounded">secrets/github-app.pem</code> in the project root
                  (it is git-ignored).
                </p>
              </li>

              <li>
                <span className="font-medium">Set environment variables</span>
                <p className="text-muted-foreground mt-1 ml-5 mb-2">
                  Add the following to your <code className="bg-muted px-1 rounded">.env</code> file:
                </p>
                <div className="ml-5 rounded-md bg-muted p-3 font-mono text-xs space-y-0.5">
                  <div className="flex items-start gap-2">
                    <Terminal className="h-3.5 w-3.5 mt-0.5 shrink-0 text-muted-foreground" />
                    <div>
                      <div>GITHUB_APP_ID=<span className="text-muted-foreground italic">123456</span></div>
                      <div>GITHUB_APP_CLIENT_ID=<span className="text-muted-foreground italic">Iv1.abc123…</span></div>
                      <div>GITHUB_APP_WEBHOOK_SECRET=<span className="text-muted-foreground italic">your-secret</span></div>
                      <div>GITHUB_APP_PRIVATE_KEY_PATH=/data/secrets/github-app.pem</div>
                      <div>GITHUB_APP_NAME=<span className="text-muted-foreground italic">your-app-slug</span></div>
                    </div>
                  </div>
                </div>
                <p className="text-muted-foreground mt-2 ml-5">
                  You can find the App ID and Client ID on the App's General settings page.
                  The webhook secret is the value you set when creating the App.
                </p>
              </li>

              <li>
                <span className="font-medium">Restart the backend</span>
                <p className="text-muted-foreground mt-1 ml-5">
                  After updating <code className="bg-muted px-1 rounded">.env</code>, restart the server container
                  (or process) so the new environment variables are picked up. Then refresh this page.
                </p>
              </li>
            </ol>

            <div className="pt-2 border-t">
              <Button variant="outline" size="sm" onClick={load}>
                <RefreshCw className="h-3.5 w-3.5 mr-1.5" />
                Refresh after setup
              </Button>
            </div>
          </CardContent>
        </Card>
      </div>
    );
  }

  // ── Configured — show installations ─────────────────────────────────────
  const appName = setup?.app_name ?? '';

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-lg font-semibold flex items-center gap-2">
            <Github className="h-5 w-5" />
            GitHub App Installations
          </h2>
          <p className="text-sm text-muted-foreground mt-1">
            Accounts and organizations that have installed{' '}
            {appName ? (
              <code className="text-xs bg-muted px-1 py-0.5 rounded">{appName}</code>
            ) : (
              'this GitHub App'
            )}
            . Each installation grants the backend access to repos in that account.
          </p>
        </div>
        <div className="flex items-center gap-2 shrink-0">
          <Button variant="outline" size="sm" onClick={load}>
            <RefreshCw className="h-3.5 w-3.5 mr-1.5" />
            Refresh
          </Button>
          {appName && (
            <Button size="sm" onClick={handleInstallNew}>
              <Plus className="h-3.5 w-3.5 mr-1.5" />
              Install to Account
            </Button>
          )}
        </div>
      </div>

      {/* Installations list */}
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-sm font-medium text-muted-foreground uppercase tracking-wide">
            Active Installations
          </CardTitle>
        </CardHeader>
        <CardContent className="pt-0">
          {installations.length === 0 ? (
            <div className="text-center py-8">
              <p className="text-sm text-muted-foreground mb-3">
                No installations found. Install the App to a GitHub account to get started.
              </p>
              {appName && (
                <Button variant="outline" size="sm" onClick={handleInstallNew}>
                  <Plus className="h-3.5 w-3.5 mr-1.5" />
                  Install to Account
                </Button>
              )}
            </div>
          ) : (
            <ul className="divide-y">
              {installations.map((inst) => (
                <li key={inst.installation_id} className="py-3 flex items-center gap-3">
                  {inst.account_avatar_url ? (
                    <img
                      src={inst.account_avatar_url}
                      alt={inst.account_login}
                      className="h-8 w-8 rounded-full shrink-0"
                    />
                  ) : (
                    <div className="h-8 w-8 rounded-full bg-muted flex items-center justify-center shrink-0">
                      {inst.account_type === 'Organization' ? (
                        <Building2 className="h-4 w-4 text-muted-foreground" />
                      ) : (
                        <User className="h-4 w-4 text-muted-foreground" />
                      )}
                    </div>
                  )}
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 flex-wrap">
                      <span className="font-medium text-sm">{inst.account_login}</span>
                      <Badge variant="outline" className="text-xs">
                        {inst.account_type === 'Organization' ? (
                          <Building2 className="h-3 w-3 mr-1" />
                        ) : (
                          <User className="h-3 w-3 mr-1" />
                        )}
                        {inst.account_type}
                      </Badge>
                      <Badge variant="secondary" className="text-xs font-mono">
                        id: {inst.installation_id}
                      </Badge>
                      {inst.repository_selection === 'all' ? (
                        <Badge variant="outline" className="text-xs text-green-600 border-green-500/30">
                          All repos
                        </Badge>
                      ) : (
                        <Badge variant="outline" className="text-xs">
                          Selected repos
                        </Badge>
                      )}
                    </div>
                    {inst.installed_at && (
                      <p className="text-xs text-muted-foreground mt-0.5">
                        Installed {new Date(inst.installed_at).toLocaleDateString()}
                      </p>
                    )}
                  </div>
                  <a
                    href={`https://github.com/${inst.account_login}`}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="shrink-0 text-muted-foreground hover:text-foreground transition-colors"
                    title={`Open ${inst.account_login} on GitHub`}
                  >
                    <ExternalLink className="h-3.5 w-3.5" />
                  </a>
                </li>
              ))}
            </ul>
          )}
        </CardContent>
      </Card>

      {/* Manual registration */}
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-sm font-medium text-muted-foreground uppercase tracking-wide">
            Manual Installation Registration
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-3 pt-0">
          <p className="text-sm text-muted-foreground">
            If the OAuth callback URL is not publicly reachable (e.g. local dev or private
            deployment), install the App via the button above, then paste the{' '}
            <strong>installation ID</strong> here to verify it was received correctly.
            The installation will then appear in the list above.
          </p>
          <div className="flex gap-2">
            <Input
              type="number"
              placeholder="Installation ID (e.g. 12345678)"
              value={manualId}
              onChange={(e) => { setManualId(e.target.value); setManualResult(null); }}
              className="max-w-xs font-mono"
            />
            <Button
              onClick={handleManualRegister}
              disabled={manualLoading || !manualId.trim()}
              variant="outline"
            >
              {manualLoading ? <Loader2 className="h-4 w-4 animate-spin" /> : 'Verify'}
            </Button>
          </div>
          {manualResult && (
            <Alert variant={manualResult.ok ? 'default' : 'destructive'}>
              {manualResult.ok ? <CheckCircle2 className="h-4 w-4" /> : <XCircle className="h-4 w-4" />}
              <AlertDescription>
                {manualResult.ok
                  ? `Installation confirmed for ${manualResult.account_type} @${manualResult.account_login}. It now appears in the list above and can be used when connecting a project.`
                  : manualResult.message}
              </AlertDescription>
            </Alert>
          )}
          <p className="text-xs text-muted-foreground">
            Find installation IDs at{' '}
            <a
              href="https://github.com/settings/installations"
              target="_blank"
              rel="noopener noreferrer"
              className="underline hover:no-underline"
            >
              github.com/settings/installations
            </a>{' '}
            or in the list above after clicking Refresh.
          </p>
        </CardContent>
      </Card>
    </div>
  );
}
