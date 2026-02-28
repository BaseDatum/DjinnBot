import { useState, useCallback } from 'react';
import { Link } from '@tanstack/react-router';
import { Card, CardHeader, CardContent } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import {
  GitPullRequestArrow,
  Loader2,
  AlertCircle,
  ExternalLink,
  ArrowRight,
  Github,
  CheckCircle2,
  User,
  History,
} from 'lucide-react';
import {
  resolveIssue,
  parseIssueUrl,
  fetchRuns,
  type ResolveResponse,
  type ParsedIssue,
} from '@/lib/api';

interface ProjectResolveViewProps {
  projectId: string;
  repoFullName?: string | null;
}

/**
 * Extract "owner/repo" from a repository reference that may be a full URL
 * (e.g. "https://github.com/owner/repo.git") or already shorthand ("owner/repo").
 * Strips any trailing ".git" suffix from the repo name.
 */
function normalizeRepoFullName(raw: string | null | undefined): string | null {
  if (!raw) return null;
  // Try to match github.com URLs (HTTPS or SSH-like)
  const m = raw.match(/github\.com[/:]([^/]+)\/([^/.]+?)(?:\.git)?\/?$/);
  if (m) return `${m[1]}/${m[2]}`;
  // Already looks like owner/repo (possibly with .git)
  const parts = raw.replace(/\.git$/, '').split('/');
  if (parts.length === 2 && parts[0] && parts[1]) return `${parts[0]}/${parts[1]}`;
  return null;
}

export function ProjectResolveView({ projectId, repoFullName: rawRepoFullName }: ProjectResolveViewProps) {
  const repoFullName = normalizeRepoFullName(rawRepoFullName) ?? rawRepoFullName;
  const [issueUrl, setIssueUrl] = useState('');
  const [parsedIssue, setParsedIssue] = useState<ParsedIssue | null>(null);
  const [parseError, setParseError] = useState<string | null>(null);
  const [parsing, setParsing] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<ResolveResponse | null>(null);

  // Recent resolve runs for this project
  const [recentRuns, setRecentRuns] = useState<any[]>([]);
  const [runsLoaded, setRunsLoaded] = useState(false);

  // Load recent resolve runs on first render
  useState(() => {
    fetchRuns({ pipeline_id: 'resolve' })
      .then((data) => {
        const runs = Array.isArray(data) ? data : data.runs || [];
        // Filter to this project's runs
        setRecentRuns(
          runs
            .filter((r: any) => r.project_id === projectId)
            .slice(0, 5),
        );
        setRunsLoaded(true);
      })
      .catch(() => setRunsLoaded(true));
  });

  const handleUrlChange = useCallback(async (value: string) => {
    setIssueUrl(value);
    setParseError(null);
    setParsedIssue(null);
    setResult(null);
    setError(null);

    const trimmed = value.trim();
    if (!trimmed) return;

    // Accept issue numbers directly if we know the repo
    if (repoFullName && /^\d+$/.test(trimmed)) {
      setParsedIssue({
        owner: repoFullName.split('/')[0],
        repo: repoFullName.split('/')[1],
        number: parseInt(trimmed, 10),
        full_name: repoFullName,
      });
      return;
    }

    // Accept #123 shorthand if we know the repo
    if (repoFullName && /^#\d+$/.test(trimmed)) {
      setParsedIssue({
        owner: repoFullName.split('/')[0],
        repo: repoFullName.split('/')[1],
        number: parseInt(trimmed.slice(1), 10),
        full_name: repoFullName,
      });
      return;
    }

    if (
      !trimmed.includes('github.com') &&
      !trimmed.match(/^[^/#]+\/[^/#]+#\d+$/)
    ) {
      return;
    }

    setParsing(true);
    try {
      const parsed = await parseIssueUrl(trimmed);
      setParsedIssue(parsed);
    } catch (err) {
      setParseError(err instanceof Error ? err.message : 'Invalid issue reference');
    } finally {
      setParsing(false);
    }
  }, [repoFullName]);

  const handleSubmit = async () => {
    if (!parsedIssue) return;

    // Build the full issue URL for the API
    const fullUrl = `https://github.com/${parsedIssue.full_name}/issues/${parsedIssue.number}`;

    setSubmitting(true);
    setError(null);
    try {
      const res = await resolveIssue({
        issue_url: fullUrl,
        project_id: projectId,
      });
      setResult(res);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to start resolve pipeline');
    } finally {
      setSubmitting(false);
    }
  };

  const statusColor: Record<string, string> = {
    pending: 'bg-muted text-muted-foreground',
    running: 'bg-yellow-500/10 text-yellow-600 border-yellow-500/30',
    completed: 'bg-green-500/10 text-green-600 border-green-500/30',
    failed: 'bg-red-500/10 text-red-600 border-red-500/30',
  };

  return (
    <div className="flex-1 p-4 md:px-6 overflow-auto">
      <div className="max-w-2xl mx-auto space-y-6">

        {/* Success banner */}
        {result && (
          <Card className="border-green-500/30 bg-green-500/5">
            <CardContent className="pt-6">
              <div className="flex items-start gap-4">
                <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-green-500/10">
                  <CheckCircle2 className="h-5 w-5 text-green-500" />
                </div>
                <div className="flex-1 min-w-0">
                  <h3 className="font-semibold">Resolve Started</h3>
                  <p className="text-sm text-muted-foreground mt-0.5">
                    {result.repo_full_name}#{result.issue_number} — {result.issue_title}
                  </p>
                  <div className="flex items-center gap-3 mt-3">
                    <Link
                      to="/runs/$runId"
                      params={{ runId: result.run_id }}
                      className="inline-flex items-center gap-1.5 text-sm font-medium text-primary hover:underline"
                    >
                      View Run <ArrowRight className="h-3.5 w-3.5" />
                    </Link>
                    <button
                      onClick={() => {
                        setResult(null);
                        setIssueUrl('');
                        setParsedIssue(null);
                      }}
                      className="text-sm text-muted-foreground hover:text-foreground"
                    >
                      Resolve another
                    </button>
                  </div>
                </div>
              </div>
            </CardContent>
          </Card>
        )}

        {/* Main form */}
        <Card>
          <CardHeader>
            <div className="flex items-center gap-2">
              <GitPullRequestArrow className="h-5 w-5" />
              <h2 className="font-semibold">Resolve GitHub Issue</h2>
            </div>
            <p className="text-sm text-muted-foreground">
              Paste a GitHub issue URL and agents will analyze the codebase, implement a fix,
              run tests, and open a pull request.
              {repoFullName && (
                <> You can also type just an issue number (e.g. <code className="text-xs bg-muted px-1 py-0.5 rounded">42</code> or <code className="text-xs bg-muted px-1 py-0.5 rounded">#42</code>).</>
              )}
            </p>
          </CardHeader>
          <CardContent className="space-y-4">
            {/* Issue input */}
            <div className="space-y-2">
              <Label htmlFor="issue-url">Issue</Label>
              <div className="relative">
                <Github className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
                <input
                  id="issue-url"
                  type="text"
                  value={issueUrl}
                  onChange={(e) => handleUrlChange(e.target.value)}
                  placeholder={
                    repoFullName
                      ? `#123, 123, or https://github.com/${repoFullName}/issues/123`
                      : 'https://github.com/owner/repo/issues/123 or owner/repo#123'
                  }
                  className="h-10 w-full rounded-md border border-input bg-background pl-10 pr-4 text-sm ring-offset-background placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                  autoFocus
                />
                {parsing && (
                  <Loader2 className="absolute right-3 top-1/2 h-4 w-4 -translate-y-1/2 animate-spin text-muted-foreground" />
                )}
              </div>
              {parseError && <p className="text-xs text-destructive">{parseError}</p>}
            </div>

            {/* Preview */}
            {parsedIssue && (
              <div className="rounded-lg border bg-muted/30 p-3 space-y-2">
                <div className="flex items-center justify-between">
                  <span className="font-mono text-sm font-medium">
                    {parsedIssue.full_name}#{parsedIssue.number}
                  </span>
                  <a
                    href={`https://github.com/${parsedIssue.full_name}/issues/${parsedIssue.number}`}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="text-xs text-muted-foreground hover:text-foreground flex items-center gap-1"
                  >
                    GitHub <ExternalLink className="h-3 w-3" />
                  </a>
                </div>
                <div className="flex items-center gap-1.5 text-xs text-muted-foreground flex-wrap">
                  <Badge variant="outline" className="text-[10px]">ANALYZE</Badge>
                  <ArrowRight className="h-3 w-3" />
                  <Badge variant="outline" className="text-[10px]">IMPLEMENT</Badge>
                  <ArrowRight className="h-3 w-3" />
                  <Badge variant="outline" className="text-[10px]">VALIDATE</Badge>
                  <ArrowRight className="h-3 w-3" />
                  <Badge variant="outline" className="text-[10px]">PR</Badge>
                </div>
                <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
                  <User className="h-3 w-3" />
                  <span>Yukihiro (analyze, implement, PR) + Chieko (validate)</span>
                </div>
              </div>
            )}

            {/* Error */}
            {error && (
              <div className="flex items-start gap-2 p-3 rounded-md bg-destructive/10 text-destructive text-sm">
                <AlertCircle className="h-4 w-4 mt-0.5 flex-shrink-0" />
                <p>{error}</p>
              </div>
            )}

            {/* Submit */}
            <Button
              onClick={handleSubmit}
              disabled={!parsedIssue || submitting}
              className="w-full"
            >
              {submitting ? (
                <>
                  <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                  Starting...
                </>
              ) : (
                <>
                  <GitPullRequestArrow className="mr-2 h-4 w-4" />
                  Resolve Issue
                </>
              )}
            </Button>
          </CardContent>
        </Card>

        {/* Recent resolve runs for this project */}
        {runsLoaded && recentRuns.length > 0 && (
          <Card>
            <CardHeader>
              <div className="flex items-center gap-2">
                <History className="h-4 w-4 text-muted-foreground" />
                <h3 className="text-sm font-semibold">Recent Resolutions</h3>
              </div>
            </CardHeader>
            <CardContent>
              <div className="space-y-2">
                {recentRuns.map((run: any) => (
                  <Link
                    key={run.id}
                    to="/runs/$runId"
                    params={{ runId: run.id }}
                    className="flex items-center justify-between gap-3 rounded-lg border p-3 transition-colors hover:bg-accent"
                  >
                    <div className="min-w-0">
                      <p className="text-sm font-medium truncate">
                        {run.task || run.task_description || run.id}
                      </p>
                      <p className="text-xs text-muted-foreground">
                        {new Date(run.created_at).toLocaleDateString()} {new Date(run.created_at).toLocaleTimeString()}
                      </p>
                    </div>
                    <Badge
                      variant="outline"
                      className={`text-[10px] shrink-0 ${statusColor[run.status] || ''}`}
                    >
                      {run.status}
                    </Badge>
                  </Link>
                ))}
              </div>
            </CardContent>
          </Card>
        )}

        {/* How it works */}
        <div className="space-y-3">
          <h3 className="text-xs font-semibold text-muted-foreground uppercase tracking-wider">
            How it works
          </h3>
          <div className="grid gap-2">
            {[
              { step: '1', title: 'Analyze', desc: 'Agent reads the codebase via the Code Knowledge Graph and plans the fix.' },
              { step: '2', title: 'Implement', desc: 'Code changes are made, tests added, and committed to a feature branch.' },
              { step: '3', title: 'Validate', desc: 'Test suite is run to verify correctness and check for regressions.' },
              { step: '4', title: 'Pull Request', desc: 'A PR is opened referencing the issue with a summary of changes.' },
            ].map((item) => (
              <div key={item.step} className="flex items-start gap-3 rounded-lg border p-2.5">
                <div className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-primary text-primary-foreground text-[10px] font-bold">
                  {item.step}
                </div>
                <div>
                  <p className="text-xs font-medium">{item.title}</p>
                  <p className="text-[11px] text-muted-foreground">{item.desc}</p>
                </div>
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}
