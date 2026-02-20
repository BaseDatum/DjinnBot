import { useState, useEffect } from 'react';
import { Card, CardHeader, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { ChevronDown, ChevronRight, RotateCcw, FileText, GitCommit } from 'lucide-react';
import { fetchGitHistory } from '@/lib/api';
import { DiffView } from './DiffView';

interface Commit {
  hash: string;
  short_hash: string;
  author: string;
  email: string;
  timestamp: number;
  subject: string;
  step_id?: string;
  agent_id?: string;
  summary?: string;
  stats?: {
    files: number;
    insertions: number;
    deletions: number;
  };
}

interface GitHistoryProps {
  runId: string;
  onCommitClick?: (commit: Commit) => void;
}

export function GitHistory({ runId, onCommitClick }: GitHistoryProps) {
  const [expanded, setExpanded] = useState(false);
  const [commits, setCommits] = useState<Commit[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [selectedCommitHash, setSelectedCommitHash] = useState<string | null>(null);

  const loadHistory = async () => {
    setLoading(true);
    setError(null);
    try {
      const data = await fetchGitHistory(runId);
      setCommits(data.commits || []);
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : 'Failed to load git history';
      // Provide better UX for common error cases
      if (errorMsg.includes('not found') || errorMsg.includes('404') || errorMsg.includes('Workspace not found')) {
        setError('Workspace not ready. The run may still be initializing, or the workspace was not created.');
      } else if (errorMsg.includes('Not a git repository')) {
        setError('Workspace exists but is not a git repository.');
      } else {
        setError(errorMsg);
      }
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    if (expanded) {
      loadHistory();
    }
  }, [expanded, runId]);

  const formatRelativeTime = (timestamp: number) => {
    const now = Date.now() / 1000;
    const diff = now - timestamp;
    
    if (diff < 60) return 'just now';
    if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
    if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
    return `${Math.floor(diff / 86400)}d ago`;
  };

  const handleCommitClick = (commit: Commit) => {
    // If parent provided a click handler, call it
    if (onCommitClick) {
      onCommitClick(commit);
    }
    // Always show the diff view
    setSelectedCommitHash(commit.hash);
  };

  return (
    <>
      <Card className="mb-4">
        <CardHeader className="py-3">
          <div className="flex items-center justify-between">
            <button
              onClick={() => setExpanded(!expanded)}
              className="flex items-center gap-2 text-sm font-medium hover:text-foreground transition-colors"
            >
              {expanded ? <ChevronDown className="h-4 w-4" /> : <ChevronRight className="h-4 w-4" />}
              <GitCommit className="h-4 w-4" />
              <span>Git History</span>
              {commits.length > 0 && (
                <span className="text-muted-foreground">({commits.length} commits)</span>
              )}
            </button>
            {expanded && (
              <Button
                variant="ghost"
                size="sm"
                onClick={loadHistory}
                disabled={loading}
              >
                <RotateCcw className={`h-3 w-3 mr-1 ${loading ? 'animate-spin' : ''}`} />
                Refresh
              </Button>
            )}
          </div>
        </CardHeader>
        
        {expanded && (
          <CardContent className="pt-0 pb-4">
            {error && (
              <div className="text-sm text-destructive mb-2">{error}</div>
            )}
            
            {loading && commits.length === 0 ? (
              <div className="text-sm text-muted-foreground">Loading commits...</div>
            ) : commits.length === 0 ? (
              <div className="text-sm text-muted-foreground">No commits yet</div>
            ) : (
              <div className="space-y-3">
                {commits.map((commit) => (
                  <div
                    key={commit.hash}
                    className="border rounded-md p-3 hover:bg-accent/50 transition-colors cursor-pointer"
                    onClick={() => handleCommitClick(commit)}
                  >
                    <div className="flex items-start gap-3">
                      <div className="flex-shrink-0 mt-0.5">
                        <div className={`h-2 w-2 rounded-full ${
                          commit.step_id ? 'bg-blue-400' : 'bg-zinc-500'
                        }`} />
                      </div>
                      
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-2 mb-1">
                          <code className="text-xs font-mono text-muted-foreground">
                            {commit.short_hash}
                          </code>
                          {commit.step_id && (
                            <>
                              <span className="text-xs font-mono text-blue-400">
                                {commit.step_id}
                              </span>
                              <span className="text-xs text-muted-foreground">
                                ({commit.agent_id})
                              </span>
                            </>
                          )}
                          <span className="text-xs text-muted-foreground ml-auto">
                            {formatRelativeTime(commit.timestamp)}
                          </span>
                        </div>
                        
                        <div className="text-sm font-medium mb-1">
                          {commit.summary || commit.subject}
                        </div>
                        
                        {commit.stats && commit.stats.files > 0 && (
                          <div className="flex items-center gap-2 text-xs text-muted-foreground">
                            <FileText className="h-3 w-3" />
                            <span>
                              {commit.stats.files} file{commit.stats.files !== 1 ? 's' : ''} changed
                            </span>
                            {commit.stats.insertions > 0 && (
                              <span className="text-green-400">+{commit.stats.insertions}</span>
                            )}
                            {commit.stats.deletions > 0 && (
                              <span className="text-red-400">-{commit.stats.deletions}</span>
                            )}
                          </div>
                        )}
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </CardContent>
        )}
      </Card>

      {selectedCommitHash && (
        <DiffView
          runId={runId}
          commitHash={selectedCommitHash}
          onClose={() => setSelectedCommitHash(null)}
        />
      )}
    </>
  );
}
