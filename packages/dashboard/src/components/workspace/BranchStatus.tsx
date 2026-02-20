import { useState, useEffect } from 'react';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { 
  GitBranch, 
  ChevronDown, 
  ChevronRight, 
  CheckCircle2, 
  AlertCircle,
  ArrowUp,
  ArrowDown,
  RotateCcw
} from 'lucide-react';
import { fetchGitStatus, type GitStatus } from '@/lib/api';

interface BranchStatusProps {
  runId: string;
  compact?: boolean;
  autoRefresh?: boolean;
}

export function BranchStatus({ runId, compact = false, autoRefresh = false }: BranchStatusProps) {
  const [status, setStatus] = useState<GitStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [expanded, setExpanded] = useState(!compact);

  const loadStatus = async () => {
    setLoading(true);
    try {
      const data = await fetchGitStatus(runId);
      setStatus(data);
    } catch (err) {
      console.error('Failed to load git status:', err);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    loadStatus();
    
    if (autoRefresh) {
      const interval = setInterval(loadStatus, 10000); // Refresh every 10s
      return () => clearInterval(interval);
    }
  }, [runId, autoRefresh]);

  if (loading && !status) {
    return compact ? (
      <span className="text-xs text-zinc-500">Loading...</span>
    ) : (
      <div className="mb-4 p-4 bg-zinc-950 rounded-md border border-zinc-800">
        <p className="text-sm text-zinc-500">Loading branch status...</p>
      </div>
    );
  }

  if (!status || !status.is_repo) {
    return compact ? null : (
      <div className="mb-4 p-4 bg-zinc-950 rounded-md border border-zinc-800">
        <p className="text-sm text-zinc-500">Not a git repository</p>
      </div>
    );
  }

  if (status.error) {
    return compact ? (
      <span className="text-xs text-red-400">Error</span>
    ) : (
      <div className="mb-4 p-4 bg-zinc-950 rounded-md border border-zinc-800">
        <p className="text-sm text-red-400">{status.error}</p>
      </div>
    );
  }

  const formatRelativeTime = (timestamp: number) => {
    const now = Date.now() / 1000;
    const diff = now - timestamp;
    if (diff < 60) return 'just now';
    if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
    if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
    return `${Math.floor(diff / 86400)}d ago`;
  };

  // Compact mode for runs list
  if (compact) {
    return (
      <div className="flex items-center gap-1.5 text-xs">
        <GitBranch className="h-3 w-3 text-zinc-500" />
        <code className="font-mono text-zinc-300">{status.branch}</code>
        {status.is_clean ? (
          <CheckCircle2 className="h-3 w-3 text-emerald-400" />
        ) : (
          <AlertCircle className="h-3 w-3 text-yellow-400" />
        )}
        {status.ahead !== undefined && status.ahead > 0 && (
          <span className="text-blue-400">↑{status.ahead}</span>
        )}
        {status.behind !== undefined && status.behind > 0 && (
          <span className="text-orange-400">↓{status.behind}</span>
        )}
      </div>
    );
  }

  // Full mode for run detail page
  return (
    <div className="mb-4 bg-zinc-950 rounded-md border border-zinc-800">
      <div className="py-3 px-4">
        <div className="flex items-center justify-between">
          <button
            onClick={() => setExpanded(!expanded)}
            className="flex items-center gap-2 text-sm font-medium text-zinc-300 hover:text-zinc-100 transition-colors"
          >
            {expanded ? <ChevronDown className="h-4 w-4" /> : <ChevronRight className="h-4 w-4" />}
            <GitBranch className="h-4 w-4" />
            <span>Branch Status</span>
          </button>
          {expanded && (
            <Button
              variant="ghost"
              size="sm"
              onClick={loadStatus}
              disabled={loading}
              className="h-7 px-2 text-xs"
            >
              <RotateCcw className={`h-3 w-3 mr-1 ${loading ? 'animate-spin' : ''}`} />
              Refresh
            </Button>
          )}
        </div>
      </div>

      {expanded && (
        <div className="pt-0 pb-4 px-4 space-y-3">
          {/* Current branch */}
          <div className="flex items-center justify-between">
            <span className="text-sm text-zinc-500">Current Branch</span>
            <code className="text-sm font-mono text-zinc-300">{status.branch}</code>
          </div>

          {/* Tracking branch */}
          {status.tracking_branch && (
            <div className="flex items-center justify-between">
              <span className="text-sm text-zinc-500">Tracking</span>
              <code className="text-sm font-mono text-blue-400">{status.tracking_branch}</code>
            </div>
          )}

          {/* Ahead/Behind status */}
          {(status.ahead !== undefined || status.behind !== undefined) && (
            <div className="flex items-center justify-between">
              <span className="text-sm text-zinc-500">Sync Status</span>
              <div className="flex items-center gap-2">
                {status.ahead !== undefined && status.ahead > 0 && (
                  <Badge variant="outline" className="text-blue-400 border-blue-400/30 bg-blue-400/5">
                    <ArrowUp className="h-3 w-3 mr-1" />
                    {status.ahead} ahead
                  </Badge>
                )}
                {status.behind !== undefined && status.behind > 0 && (
                  <Badge variant="outline" className="text-orange-400 border-orange-400/30 bg-orange-400/5">
                    <ArrowDown className="h-3 w-3 mr-1" />
                    {status.behind} behind
                  </Badge>
                )}
                {status.ahead === 0 && status.behind === 0 && (
                  <Badge variant="outline" className="text-emerald-400 border-emerald-400/30 bg-emerald-400/5">
                    <CheckCircle2 className="h-3 w-3 mr-1" />
                    Up to date
                  </Badge>
                )}
              </div>
            </div>
          )}

          {/* Working tree status */}
          <div className="flex items-center justify-between">
            <span className="text-sm text-zinc-500">Working Tree</span>
            <div className="flex items-center gap-2">
              {status.is_clean ? (
                <Badge variant="outline" className="text-emerald-400 border-emerald-400/30 bg-emerald-400/5">
                  <CheckCircle2 className="h-3 w-3 mr-1" />
                  Clean
                </Badge>
              ) : (
                <Badge variant="outline" className="text-yellow-400 border-yellow-400/30 bg-yellow-400/5">
                  <AlertCircle className="h-3 w-3 mr-1" />
                  {status.uncommitted_changes} uncommitted
                </Badge>
              )}
            </div>
          </div>

          {/* Uncommitted changes list */}
          {!status.is_clean && status.changes && status.changes.length > 0 && (
            <div className="mt-2 pt-2 border-t border-zinc-800">
              <p className="text-xs text-zinc-500 mb-2">Uncommitted Changes:</p>
              <div className="space-y-1">
                {status.changes.map((change, idx) => (
                  <div key={idx} className="flex items-center gap-2 text-xs font-mono">
                    <span className={`w-5 ${
                      change.status.includes('M') ? 'text-yellow-400' :
                      change.status.includes('A') ? 'text-emerald-400' :
                      change.status.includes('D') ? 'text-red-400' :
                      'text-blue-400'
                    }`}>
                      {change.status}
                    </span>
                    <span className="text-zinc-500 truncate">{change.file}</span>
                  </div>
                ))}
                {status.uncommitted_changes! > status.changes.length && (
                  <p className="text-xs text-zinc-500">
                    ... and {status.uncommitted_changes! - status.changes.length} more
                  </p>
                )}
              </div>
            </div>
          )}

          {/* Last commit */}
          {status.last_commit && (
            <div className="mt-2 pt-2 border-t border-zinc-800">
              <p className="text-xs text-zinc-500 mb-1">Last Commit:</p>
              <div className="flex items-center gap-2 text-xs">
                <code className="font-mono text-zinc-500">{status.last_commit.short_hash}</code>
                <span className="text-zinc-400 truncate">{status.last_commit.subject}</span>
                <span className="text-zinc-500 ml-auto">
                  {formatRelativeTime(status.last_commit.timestamp)}
                </span>
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
