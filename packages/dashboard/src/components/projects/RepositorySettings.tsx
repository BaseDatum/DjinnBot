import { useState, useEffect } from 'react';
import { API_BASE } from '@/lib/api';
import { authFetch } from '@/lib/auth';
import { Card, CardHeader, CardTitle, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Badge } from '@/components/ui/badge';
import { Alert, AlertDescription } from '@/components/ui/alert';
import {
  CheckCircle2,
  XCircle,
  Loader2,
  GitBranch,
  GitCommit,
  ExternalLink,
  Trash2,
  Github,
} from 'lucide-react';

interface RepositoryInfo {
  url: string;
  accessible: boolean;
  defaultBranch?: string;
  latestCommit?: string;
  branches?: Array<{ name: string; commit: string }>;
  error?: string;
}

interface Props {
  projectId: string;
  currentRepoUrl?: string;
  onUpdate: () => void;
}

// Module-level cache: persists repo info across tab switches for the lifetime of the page.
// Keyed by projectId so multiple projects stay isolated.
const repoInfoCache = new Map<string, RepositoryInfo>();

export function RepositorySettings({ projectId, currentRepoUrl, onUpdate }: Props) {
  const [repoUrl, setRepoUrl] = useState(currentRepoUrl || '');
  // Seed from cache so info is available instantly on re-mount (tab switch back)
  const [info, setInfo] = useState<RepositoryInfo | null>(() => repoInfoCache.get(projectId) ?? null);
  const [infoLoading, setInfoLoading] = useState(false);
  const [validating, setValidating] = useState(false);
  const [saving, setSaving] = useState(false);
  const [cloning, setCloning] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);

  // Load repository info on mount if repo is configured and not already cached
  useEffect(() => {
    if (currentRepoUrl) {
      loadInfo();
    }
  }, [currentRepoUrl, projectId]);

  const loadInfo = async () => {
    // If we already have cached info, show it immediately and refresh silently in background
    const cached = repoInfoCache.get(projectId);
    if (!cached) {
      setInfoLoading(true);
    }
    try {
      const res = await authFetch(`${API_BASE}/projects/${projectId}/repository/status`);
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.detail || 'Failed to load repository info');
      }
      const data = await res.json();
      repoInfoCache.set(projectId, data);
      setInfo(data);
    } catch (err) {
      console.error('Failed to load repo info:', err);
      // Don't show error if it's just not configured yet
      if (currentRepoUrl) {
        setError(err instanceof Error ? err.message : 'Failed to load repository info');
      }
    } finally {
      setInfoLoading(false);
    }
  };

  const handleValidate = async () => {
    setValidating(true);
    setError(null);
    setSuccess(null);
    try {
      const res = await authFetch(`${API_BASE}/projects/${projectId}/repository/status`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ repoUrl }),
      });
      
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.detail || 'Validation failed');
      }
      
      const result = await res.json();
      setInfo(result);
      
      if (!result.accessible) {
        setError(result.error || 'Repository not accessible');
      } else {
        setSuccess('Repository is accessible!');
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Validation failed');
    } finally {
      setValidating(false);
    }
  };

  const handleSave = async () => {
    setSaving(true);
    setError(null);
    setSuccess(null);
    try {
      const res = await authFetch(`${API_BASE}/projects/${projectId}/repository`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ repoUrl }),
      });
      
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.detail || 'Failed to save repository URL');
      }
      
      const result = await res.json();
      
      if (result.cloned) {
        setSuccess('Repository saved and cloned automatically!');
      } else if (result.cloneError) {
        setSuccess(`Repository URL saved. Auto-clone failed: ${result.cloneError}. You can clone manually below.`);
      } else {
        setSuccess('Repository URL saved!');
      }
      // Invalidate cache so next load fetches fresh data
      repoInfoCache.delete(projectId);
      onUpdate();
      loadInfo();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to save');
    } finally {
      setSaving(false);
    }
  };

  const handleRemove = async () => {
    if (!confirm('Remove repository association? This will not delete the cloned files.')) {
      return;
    }
    try {
      const res = await authFetch(`${API_BASE}/projects/${projectId}/repository`, {
        method: 'DELETE',
      });
      
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.detail || 'Failed to remove repository');
      }
      
      setRepoUrl('');
      setInfo(null);
      // Clear cache so the removed repo doesn't resurface on next mount
      repoInfoCache.delete(projectId);
      setSuccess('Repository removed');
      onUpdate();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to remove');
    }
  };

  const handleClone = async () => {
    setCloning(true);
    setError(null);
    setSuccess(null);
    try {
      const res = await authFetch(`${API_BASE}/projects/${projectId}/repository/clone`, {
        method: 'POST',
      });
      
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.detail || 'Clone failed');
      }
      
      setSuccess('Repository cloned successfully!');
      loadInfo();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Clone failed');
    } finally {
      setCloning(false);
    }
  };

  const isConfigured = Boolean(currentRepoUrl);
  const hasChanges = repoUrl !== currentRepoUrl;

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Github className="w-5 h-5" />
          Git Repository
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        {/* Repository URL Input */}
        <div>
          <label className="text-sm font-medium mb-2 block">
            Repository URL
          </label>
          <div className="flex gap-2">
            <Input
              value={repoUrl}
              onChange={(e) => setRepoUrl(e.target.value)}
              placeholder="https://github.com/user/repo.git"
              className="flex-1"
            />
            <Button
              onClick={handleValidate}
              disabled={!repoUrl || validating}
              variant="outline"
              size="sm"
            >
              {validating ? (
                <Loader2 className="w-4 h-4 animate-spin" />
              ) : (
                'Test Connection'
              )}
            </Button>
          </div>
          <p className="text-xs text-muted-foreground mt-1">
            Supported: HTTPS, SSH, or github.com/user/repo shorthand
          </p>
        </div>

        {/* Actions */}
        <div className="flex gap-2">
          <Button
            onClick={handleSave}
            disabled={!repoUrl || !hasChanges || saving}
            size="sm"
          >
            {saving ? <Loader2 className="w-4 h-4 animate-spin mr-2" /> : null}
            {isConfigured ? 'Update' : 'Save'}
          </Button>

          {isConfigured && (
            <Button
              onClick={handleRemove}
              variant="destructive"
              size="sm"
            >
              <Trash2 className="w-4 h-4 mr-2" />
              Remove
            </Button>
          )}
        </div>

        {/* Status Messages */}
        {error && (
          <Alert variant="destructive">
            <XCircle className="w-4 h-4" />
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        )}

        {success && (
          <Alert>
            <CheckCircle2 className="w-4 h-4" />
            <AlertDescription>{success}</AlertDescription>
          </Alert>
        )}

        {/* Repository Info skeleton — shown on first load when no cached data yet */}
        {isConfigured && infoLoading && !info && (
          <div className="border rounded-lg p-4 space-y-3 bg-muted/30 animate-pulse">
            <div className="flex items-center justify-between">
              <div className="h-4 w-12 rounded bg-muted-foreground/20" />
              <div className="h-5 w-24 rounded-full bg-muted-foreground/20" />
            </div>
            <div className="flex items-center gap-2">
              <div className="h-4 w-4 rounded bg-muted-foreground/20 shrink-0" />
              <div className="h-4 w-28 rounded bg-muted-foreground/20" />
              <div className="h-5 w-16 rounded bg-muted-foreground/20" />
            </div>
            <div className="flex items-center gap-2">
              <div className="h-4 w-4 rounded bg-muted-foreground/20 shrink-0" />
              <div className="h-4 w-24 rounded bg-muted-foreground/20" />
              <div className="h-5 w-20 rounded bg-muted-foreground/20" />
            </div>
            <div className="space-y-1.5">
              <div className="h-4 w-20 rounded bg-muted-foreground/20" />
              <div className="flex gap-1">
                <div className="h-5 w-14 rounded-full bg-muted-foreground/20" />
                <div className="h-5 w-16 rounded-full bg-muted-foreground/20" />
                <div className="h-5 w-12 rounded-full bg-muted-foreground/20" />
              </div>
            </div>
          </div>
        )}

        {/* Repository Info */}
        {info && (
          <div className="border rounded-lg p-4 space-y-3 bg-muted/30">
            <div className="flex items-center justify-between">
              <span className="text-sm font-medium">Status</span>
              <Badge variant={info.accessible ? 'default' : 'destructive'}>
                {info.accessible ? (
                  <>
                    <CheckCircle2 className="w-3 h-3 mr-1" />
                    Connected
                  </>
                ) : (
                  <>
                    <XCircle className="w-3 h-3 mr-1" />
                    Not Accessible
                  </>
                )}
              </Badge>
            </div>

            {info.accessible && (
              <>
                {info.defaultBranch && (
                  <div className="flex items-center gap-2 text-sm">
                    <GitBranch className="w-4 h-4 text-muted-foreground" />
                    <span className="text-muted-foreground">Default Branch:</span>
                    <code className="bg-background px-2 py-0.5 rounded">
                      {info.defaultBranch}
                    </code>
                  </div>
                )}

                {info.latestCommit && (
                  <div className="flex items-center gap-2 text-sm">
                    <GitCommit className="w-4 h-4 text-muted-foreground" />
                    <span className="text-muted-foreground">Latest Commit:</span>
                    <code className="bg-background px-2 py-0.5 rounded text-xs">
                      {info.latestCommit.slice(0, 8)}
                    </code>
                  </div>
                )}

                {info.branches && info.branches.length > 0 && (
                  <div>
                    <span className="text-sm text-muted-foreground block mb-2">
                      Branches ({info.branches.length}):
                    </span>
                    <div className="flex flex-wrap gap-1">
                      {info.branches.slice(0, 5).map((branch) => (
                        <Badge
                          key={branch.name}
                          variant="outline"
                          className="text-xs"
                        >
                          {branch.name}
                        </Badge>
                      ))}
                      {info.branches.length > 5 && (
                        <Badge variant="outline" className="text-xs">
                          +{info.branches.length - 5} more
                        </Badge>
                      )}
                    </div>
                  </div>
                )}
              </>
            )}

            {!info.accessible && info.error && (
              <p className="text-sm text-destructive">{info.error}</p>
            )}
          </div>
        )}

        {/* Additional Actions */}
        {isConfigured && info?.accessible && (
          <div className="flex gap-2 pt-2">
            <Button
              onClick={handleClone}
              disabled={cloning}
              variant="outline"
              size="sm"
            >
              {cloning ? (
                <Loader2 className="w-4 h-4 animate-spin mr-2" />
              ) : null}
              Clone Now
            </Button>

            {currentRepoUrl && currentRepoUrl.includes('github.com') && (
              <Button
                onClick={() => window.open(currentRepoUrl, '_blank')}
                variant="outline"
                size="sm"
              >
                <ExternalLink className="w-4 h-4 mr-2" />
                View on GitHub
              </Button>
            )}
          </div>
        )}
      </CardContent>
    </Card>
  );
}
