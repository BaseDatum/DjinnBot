import { useState, useEffect } from 'react';
import { MergeButton } from './MergeButton';
import { PushButton } from './PushButton';
import { Badge } from '@/components/ui/badge';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { 
  GitBranch, 
  CheckCircle2, 
  CloudOff, 
  AlertCircle,
  RotateCcw,
  Github
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { fetchGitStatus, type GitStatus } from '@/lib/api';

interface MergePushPanelProps {
  runId: string;
  runStatus: string;
  autoRefresh?: boolean;
}

export function MergePushPanel({ runId, runStatus, autoRefresh = false }: MergePushPanelProps) {
  const [status, setStatus] = useState<GitStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [mergedToMain, setMergedToMain] = useState(false);
  const [pushedToRemote, setPushedToRemote] = useState(false);

  const loadStatus = async () => {
    setLoading(true);
    try {
      const data = await fetchGitStatus(runId);
      setStatus(data);
      
      // Check if we're on main branch (indicates merge completed)
      if (data.branch === 'main') {
        setMergedToMain(true);
      }
      
      // If ahead count is 0 and we have a tracking branch, we're in sync
      if (data.tracking_branch && data.ahead === 0) {
        setPushedToRemote(true);
      }
    } catch (err) {
      console.error('Failed to load git status:', err);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    loadStatus();
    
    if (autoRefresh) {
      const interval = setInterval(loadStatus, 10000);
      return () => clearInterval(interval);
    }
  }, [runId, autoRefresh]);

  if (loading && !status) {
    return (
      <div className="mb-4 p-4 bg-zinc-950 rounded-md border border-zinc-800">
        <p className="text-sm text-zinc-500">Loading git status...</p>
      </div>
    );
  }

  if (!status || !status.is_repo) {
    return null;
  }

  const hasRemote = !!status.tracking_branch;
  const canMerge = runStatus === 'completed' && !mergedToMain;
  const canPush = mergedToMain && hasRemote && !pushedToRemote;

  // Determine connection status
  const getConnectionStatus = () => {
    if (pushedToRemote) {
      return { icon: CheckCircle2, text: 'Synced to Remote', color: 'text-emerald-400' };
    }
    if (mergedToMain && !hasRemote) {
      return { icon: CloudOff, text: 'No Remote Configured', color: 'text-zinc-500' };
    }
    if (mergedToMain) {
      return { icon: AlertCircle, text: 'Not Pushed', color: 'text-yellow-400' };
    }
    return { icon: GitBranch, text: `On Branch: ${status.branch}`, color: 'text-blue-400' };
  };

  const connectionStatus = getConnectionStatus();
  const StatusIcon = connectionStatus.icon;

  return (
    <div className="mb-4 bg-zinc-950 rounded-md border border-zinc-800">
      <div className="p-4 space-y-4">
        {/* Status Bar */}
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <StatusIcon className={`h-4 w-4 ${connectionStatus.color}`} />
            <span className="text-sm font-medium text-zinc-300">
              {connectionStatus.text}
            </span>
            {hasRemote && (
              <>
                <span className="text-zinc-600">•</span>
                <span className="text-xs text-zinc-500 flex items-center gap-1">
                  <Github className="h-3 w-3" />
                  {status.tracking_branch}
                </span>
              </>
            )}
          </div>

          <Button
            variant="ghost"
            size="sm"
            onClick={loadStatus}
            disabled={loading}
            className="h-7 px-2 text-xs"
          >
            <RotateCcw className={`h-3 w-3 ${loading ? 'animate-spin' : ''}`} />
          </Button>
        </div>

        {/* Action Buttons */}
        <div className="flex gap-2">
          <MergeButton
            runId={runId}
            disabled={!canMerge}
            onSuccess={() => {
              setMergedToMain(true);
              loadStatus();
            }}
            className="flex-1"
          />

          <PushButton
            runId={runId}
            disabled={!canPush}
            onSuccess={() => {
              setPushedToRemote(true);
              loadStatus();
            }}
            className="flex-1"
          />
        </div>

        {/* Status Messages */}
        {mergedToMain && (
          <Alert>
            <CheckCircle2 className="h-4 w-4 text-emerald-400" />
            <AlertDescription className="text-xs">
              Changes have been merged to main branch
            </AlertDescription>
          </Alert>
        )}

        {!canMerge && !mergedToMain && runStatus === 'completed' && (
          <Alert>
            <AlertCircle className="h-4 w-4 text-zinc-500" />
            <AlertDescription className="text-xs">
              This run has not been merged yet
            </AlertDescription>
          </Alert>
        )}

        {mergedToMain && !hasRemote && (
          <Alert>
            <CloudOff className="h-4 w-4 text-zinc-500" />
            <AlertDescription className="text-xs">
              No remote repository configured. Push is not available.
            </AlertDescription>
          </Alert>
        )}

        {pushedToRemote && (
          <Alert>
            <CheckCircle2 className="h-4 w-4 text-emerald-400" />
            <AlertDescription className="text-xs">
              All changes have been pushed to remote repository
            </AlertDescription>
          </Alert>
        )}

        {/* Sync Status */}
        {hasRemote && status.ahead !== undefined && status.ahead > 0 && !pushedToRemote && (
          <div className="flex items-center gap-2 text-xs text-zinc-500">
            <span>Local is {status.ahead} commit{status.ahead !== 1 ? 's' : ''} ahead of remote</span>
          </div>
        )}
      </div>
    </div>
  );
}
