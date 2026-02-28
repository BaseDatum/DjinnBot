import { createFileRoute, useNavigate } from '@tanstack/react-router';
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
} from 'lucide-react';
import { useState, useCallback } from 'react';
import {
  resolveIssue,
  parseIssueUrl,
  fetchProjects,
  type ResolveResponse,
  type ParsedIssue,
} from '@/lib/api';

export const Route = createFileRoute('/resolve')({
  component: ResolvePage,
});

function ResolvePage() {
  const navigate = useNavigate();
  const [issueUrl, setIssueUrl] = useState('');
  const [parsedIssue, setParsedIssue] = useState<ParsedIssue | null>(null);
  const [parseError, setParseError] = useState<string | null>(null);
  const [parsing, setParsing] = useState(false);
  const [projectId, setProjectId] = useState('');
  const [projects, setProjects] = useState<Array<{ id: string; name: string }>>([]);
  const [projectsLoaded, setProjectsLoaded] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<ResolveResponse | null>(null);

  // Debounced URL parsing
  const handleUrlChange = useCallback(
    async (value: string) => {
      setIssueUrl(value);
      setParseError(null);
      setParsedIssue(null);
      setResult(null);
      setError(null);

      const trimmed = value.trim();
      if (!trimmed) return;

      // Only try to parse if it looks like a GitHub reference
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

        // Load projects if not loaded yet
        if (!projectsLoaded) {
          try {
            const data = await fetchProjects();
            const pjs = Array.isArray(data) ? data : data.projects || [];
            setProjects(pjs.filter((p: any) => p.status !== 'archived'));
            setProjectsLoaded(true);
          } catch {
            // Non-fatal
          }
        }
      } catch (err) {
        const msg =
          err instanceof Error ? err.message : 'Invalid issue reference';
        setParseError(msg);
      } finally {
        setParsing(false);
      }
    },
    [projectsLoaded],
  );

  const handleSubmit = async () => {
    if (!parsedIssue) return;

    setSubmitting(true);
    setError(null);
    try {
      const res = await resolveIssue({
        issue_url: issueUrl.trim(),
        project_id: projectId || undefined,
      });
      setResult(res);
    } catch (err) {
      setError(
        err instanceof Error ? err.message : 'Failed to start resolve pipeline',
      );
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="p-4 md:p-8 max-w-2xl mx-auto">
      {/* Header */}
      <div className="mb-6 md:mb-8 flex items-center gap-3">
        <GitPullRequestArrow className="h-8 w-8 shrink-0" />
        <div>
          <h1 className="text-2xl md:text-3xl font-bold tracking-tight">
            Resolve Issue
          </h1>
          <p className="text-muted-foreground">
            Turn a GitHub issue into a pull request automatically
          </p>
        </div>
      </div>

      {/* Success state */}
      {result ? (
        <Card>
          <CardContent className="pt-6">
            <div className="text-center space-y-4">
              <div className="flex justify-center">
                <div className="flex h-16 w-16 items-center justify-center rounded-full bg-green-500/10">
                  <CheckCircle2 className="h-8 w-8 text-green-500" />
                </div>
              </div>
              <div>
                <h2 className="text-xl font-semibold">Resolve Started</h2>
                <p className="text-muted-foreground mt-1">
                  {result.repo_full_name}#{result.issue_number} —{' '}
                  {result.issue_title}
                </p>
              </div>
              <div className="flex flex-col sm:flex-row items-center justify-center gap-3">
                <Button
                  onClick={() =>
                    navigate({
                      to: '/runs/$runId',
                      params: { runId: result.run_id },
                    })
                  }
                >
                  <ArrowRight className="mr-2 h-4 w-4" />
                  View Run
                </Button>
                <Button
                  variant="outline"
                  onClick={() => {
                    setResult(null);
                    setIssueUrl('');
                    setParsedIssue(null);
                  }}
                >
                  Resolve Another
                </Button>
              </div>
              <p className="text-xs text-muted-foreground">
                Run ID: <code className="font-mono">{result.run_id}</code>
              </p>
            </div>
          </CardContent>
        </Card>
      ) : (
        <Card>
          <CardHeader>
            <p className="text-sm text-muted-foreground">
              Paste a GitHub issue URL and DjinnBot will analyze the issue, implement
              a fix, run tests, and open a pull request.
            </p>
          </CardHeader>
          <CardContent className="space-y-6">
            {/* Issue URL input */}
            <div className="space-y-2">
              <Label htmlFor="issue-url">GitHub Issue</Label>
              <div className="relative">
                <Github className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
                <input
                  id="issue-url"
                  type="text"
                  value={issueUrl}
                  onChange={(e) => handleUrlChange(e.target.value)}
                  placeholder="https://github.com/owner/repo/issues/123 or owner/repo#123"
                  className="h-11 w-full rounded-md border border-input bg-background pl-10 pr-4 text-sm ring-offset-background placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                  autoFocus
                />
                {parsing && (
                  <Loader2 className="absolute right-3 top-1/2 h-4 w-4 -translate-y-1/2 animate-spin text-muted-foreground" />
                )}
              </div>
              {parseError && (
                <p className="text-xs text-destructive">{parseError}</p>
              )}
            </div>

            {/* Parsed issue preview */}
            {parsedIssue && (
              <div className="rounded-lg border bg-muted/30 p-4 space-y-3">
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-2">
                    <Github className="h-4 w-4 text-muted-foreground" />
                    <span className="font-mono text-sm font-medium">
                      {parsedIssue.full_name}#{parsedIssue.number}
                    </span>
                  </div>
                  <a
                    href={`https://github.com/${parsedIssue.full_name}/issues/${parsedIssue.number}`}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="text-xs text-muted-foreground hover:text-foreground flex items-center gap-1"
                  >
                    View on GitHub
                    <ExternalLink className="h-3 w-3" />
                  </a>
                </div>

                {/* Pipeline steps preview */}
                <div className="flex items-center gap-2 text-xs text-muted-foreground">
                  <span className="font-medium text-foreground">Pipeline:</span>
                  <Badge variant="outline" className="text-[10px]">
                    ANALYZE
                  </Badge>
                  <ArrowRight className="h-3 w-3" />
                  <Badge variant="outline" className="text-[10px]">
                    IMPLEMENT
                  </Badge>
                  <ArrowRight className="h-3 w-3" />
                  <Badge variant="outline" className="text-[10px]">
                    VALIDATE
                  </Badge>
                  <ArrowRight className="h-3 w-3" />
                  <Badge variant="outline" className="text-[10px]">
                    PR
                  </Badge>
                </div>

                <div className="flex items-center gap-2 text-xs text-muted-foreground">
                  <User className="h-3 w-3" />
                  <span>Yukihiro (implement) + Chieko (validate)</span>
                </div>
              </div>
            )}

            {/* Project selector (optional) */}
            {parsedIssue && projects.length > 0 && (
              <div className="space-y-2">
                <Label htmlFor="project-select">
                  Project{' '}
                  <span className="text-muted-foreground font-normal">
                    (optional — auto-detected if repo matches)
                  </span>
                </Label>
                <select
                  id="project-select"
                  value={projectId}
                  onChange={(e) => setProjectId(e.target.value)}
                  className="w-full h-10 rounded-md border border-input bg-background px-3 text-sm ring-offset-background focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                >
                  <option value="">Auto-detect</option>
                  {projects.map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.name}
                    </option>
                  ))}
                </select>
              </div>
            )}

            {/* Error display */}
            {error && (
              <div className="flex items-start gap-2 p-3 rounded-md bg-destructive/10 text-destructive text-sm">
                <AlertCircle className="h-4 w-4 mt-0.5 flex-shrink-0" />
                <p>{error}</p>
              </div>
            )}

            {/* Submit button */}
            <Button
              onClick={handleSubmit}
              disabled={!parsedIssue || submitting}
              className="w-full"
              size="lg"
            >
              {submitting ? (
                <>
                  <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                  Starting resolve pipeline...
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
      )}

      {/* How it works */}
      <div className="mt-8 space-y-3">
        <h3 className="text-sm font-semibold text-muted-foreground uppercase tracking-wider">
          How it works
        </h3>
        <div className="grid gap-3">
          {[
            {
              step: '1',
              title: 'Analyze',
              desc: 'Yukihiro reads the codebase and the issue, identifies root cause, and plans the fix.',
            },
            {
              step: '2',
              title: 'Implement',
              desc: 'Code is written, tests are added, and changes are committed to a feature branch.',
            },
            {
              step: '3',
              title: 'Validate',
              desc: 'Chieko runs the test suite to verify correctness and check for regressions.',
            },
            {
              step: '4',
              title: 'Pull Request',
              desc: 'A PR is opened referencing the issue with a summary of changes and test results.',
            },
          ].map((item) => (
            <div
              key={item.step}
              className="flex items-start gap-3 rounded-lg border p-3"
            >
              <div className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-primary text-primary-foreground text-xs font-bold">
                {item.step}
              </div>
              <div>
                <p className="text-sm font-medium">{item.title}</p>
                <p className="text-xs text-muted-foreground">{item.desc}</p>
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
