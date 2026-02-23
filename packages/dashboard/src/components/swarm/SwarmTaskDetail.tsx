import { Badge } from '@/components/ui/badge';
import { ExternalLink, Clock, GitCommit, FileCode, AlertTriangle } from 'lucide-react';
import type { SwarmTask } from '@/hooks/useSwarmSSE';

function formatDuration(ms: number): string {
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  return `${m}m ${s % 60}s`;
}

const STATUS_BADGE_VARIANT: Record<string, 'default' | 'secondary' | 'destructive' | 'outline'> = {
  completed: 'default',
  running: 'secondary',
  failed: 'destructive',
  skipped: 'outline',
  cancelled: 'outline',
  ready: 'secondary',
  pending: 'outline',
};

interface SwarmTaskDetailProps {
  task: SwarmTask;
}

export function SwarmTaskDetail({ task }: SwarmTaskDetailProps) {
  const now = Date.now();
  const durationMs = task.started_at
    ? (task.completed_at || now) - task.started_at
    : 0;

  return (
    <div className="flex flex-col gap-3 p-4 h-full overflow-auto">
      {/* Header */}
      <div>
        <h3 className="text-sm font-semibold text-zinc-100">{task.title}</h3>
        <div className="flex items-center gap-2 mt-1">
          <Badge variant={STATUS_BADGE_VARIANT[task.status] || 'outline'} className="text-[10px]">
            {task.status}
          </Badge>
          {task.run_id && (
            <span className="text-[10px] text-zinc-500 font-mono">{task.run_id}</span>
          )}
        </div>
      </div>

      {/* Duration */}
      {durationMs > 0 && (
        <div className="flex items-center gap-1.5 text-xs text-zinc-400">
          <Clock className="w-3 h-3" />
          <span>{formatDuration(durationMs)}</span>
        </div>
      )}

      {/* Error */}
      {task.error && (
        <div className="rounded-md bg-red-950/30 border border-red-900/50 px-3 py-2">
          <div className="flex items-center gap-1.5 mb-1">
            <AlertTriangle className="w-3 h-3 text-red-400" />
            <span className="text-[10px] font-medium text-red-400 uppercase">Error</span>
          </div>
          <p className="text-xs text-red-300">{task.error}</p>
        </div>
      )}

      {/* Outputs */}
      {task.outputs && Object.keys(task.outputs).length > 0 && (
        <div className="flex flex-col gap-2">
          <span className="text-[10px] font-medium text-zinc-400 uppercase tracking-wide">Outputs</span>

          {task.outputs.commit_hashes && (
            <div className="flex items-start gap-1.5">
              <GitCommit className="w-3 h-3 text-zinc-500 mt-0.5 shrink-0" />
              <span className="text-xs text-zinc-300 font-mono break-all">{task.outputs.commit_hashes}</span>
            </div>
          )}

          {task.outputs.files_changed && (
            <div className="flex items-start gap-1.5">
              <FileCode className="w-3 h-3 text-zinc-500 mt-0.5 shrink-0" />
              <span className="text-xs text-zinc-300 break-all">{task.outputs.files_changed}</span>
            </div>
          )}

          {task.outputs.summary && (
            <p className="text-xs text-zinc-300">{task.outputs.summary}</p>
          )}

          {task.outputs.deviations && (
            <div className="rounded-md bg-yellow-950/20 border border-yellow-900/30 px-2 py-1.5">
              <span className="text-[10px] font-medium text-yellow-500">Deviations: </span>
              <span className="text-[10px] text-yellow-300">{task.outputs.deviations}</span>
            </div>
          )}

          {task.outputs.blocked_by && (
            <div className="rounded-md bg-red-950/20 border border-red-900/30 px-2 py-1.5">
              <span className="text-[10px] font-medium text-red-400">Blocked (Rule 4): </span>
              <span className="text-[10px] text-red-300">{task.outputs.blocked_by}</span>
            </div>
          )}
        </div>
      )}

      {/* Dependencies */}
      {task.dependencies.length > 0 && (
        <div>
          <span className="text-[10px] font-medium text-zinc-400 uppercase tracking-wide">Dependencies</span>
          <div className="flex flex-wrap gap-1 mt-1">
            {task.dependencies.map(dep => (
              <Badge key={dep} variant="outline" className="text-[10px]">{dep}</Badge>
            ))}
          </div>
        </div>
      )}

      {/* Run link */}
      {task.run_id && (
        <a
          href={`/runs/${task.run_id}`}
          className="flex items-center gap-1.5 text-xs text-blue-400 hover:text-blue-300 mt-auto pt-2 border-t border-zinc-800"
        >
          <ExternalLink className="w-3 h-3" />
          View Run Logs
        </a>
      )}
    </div>
  );
}
