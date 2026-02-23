import { useMemo } from 'react';
import { cn } from '@/lib/utils';
import type { SwarmState } from '@/hooks/useSwarmSSE';

// ── Helpers ────────────────────────────────────────────────────────────────

function formatDuration(ms: number): string {
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  return `${m}m ${s % 60}s`;
}

const STATUS_BAR_COLORS: Record<string, string> = {
  completed: 'bg-green-500',
  running:   'bg-blue-500 animate-pulse',
  failed:    'bg-red-500',
  skipped:   'bg-zinc-600',
  cancelled: 'bg-zinc-600',
  ready:     'bg-blue-800',
  pending:   'bg-zinc-700',
};

// ── Component ──────────────────────────────────────────────────────────────

interface SwarmTimelineProps {
  state: SwarmState;
}

export function SwarmTimeline({ state }: SwarmTimelineProps) {
  const now = Date.now();
  const swarmStart = state.created_at;
  const wallClock = now - swarmStart;

  // Sort tasks by their start time (or creation order for unstarted)
  const sortedTasks = useMemo(() => {
    return [...state.tasks].sort((a, b) => {
      const aStart = a.started_at ?? Infinity;
      const bStart = b.started_at ?? Infinity;
      return aStart - bStart;
    });
  }, [state.tasks]);

  // Compute total time span for the timeline
  const latestEnd = useMemo(() => {
    let latest = now;
    for (const t of state.tasks) {
      if (t.completed_at && t.completed_at > latest) latest = t.completed_at;
    }
    return latest;
  }, [state.tasks, now]);

  const timeSpan = Math.max(latestEnd - swarmStart, 1000); // At least 1s

  // Estimate sequential time (sum of all completed durations)
  const sequentialMs = useMemo(() => {
    return state.tasks.reduce((sum, t) => {
      if (t.started_at && t.completed_at) return sum + (t.completed_at - t.started_at);
      if (t.status === 'running' && t.started_at) return sum + (now - t.started_at);
      return sum;
    }, 0);
  }, [state.tasks, now]);

  const speedup = sequentialMs > 0 && wallClock > 0
    ? (sequentialMs / wallClock).toFixed(1)
    : null;

  // Progress percentage
  const doneCount = state.completed_count + state.failed_count;
  const progressPct = state.total_count > 0 ? Math.round((doneCount / state.total_count) * 100) : 0;

  return (
    <div className="flex flex-col gap-3 p-4 h-full overflow-auto">
      {/* Header */}
      <div className="flex items-center justify-between text-xs">
        <span className="text-zinc-400 font-mono">{state.swarm_id}</span>
        <span className="text-zinc-300">
          {doneCount}/{state.total_count} tasks
        </span>
      </div>

      {/* Progress bar */}
      <div className="relative h-2 bg-zinc-800 rounded-full overflow-hidden">
        <div
          className="absolute inset-y-0 left-0 bg-green-500 rounded-full transition-all duration-500"
          style={{ width: `${progressPct}%` }}
        />
      </div>

      {/* Swim-lane bars */}
      <div className="flex flex-col gap-1.5 mt-2">
        {sortedTasks.map(task => {
          const start = task.started_at ? task.started_at - swarmStart : 0;
          const end = task.completed_at
            ? task.completed_at - swarmStart
            : task.status === 'running' && task.started_at
              ? now - swarmStart
              : 0;
          const duration = end - start;

          const leftPct = timeSpan > 0 ? (start / timeSpan) * 100 : 0;
          const widthPct = timeSpan > 0 ? Math.max((duration / timeSpan) * 100, 1) : 0;

          const barColor = STATUS_BAR_COLORS[task.status] || STATUS_BAR_COLORS.pending;
          const isActive = task.status === 'running' || task.status === 'completed' || task.status === 'failed';

          return (
            <div key={task.key} className="flex items-center gap-2 h-6">
              <span className="text-[10px] text-zinc-400 w-20 truncate shrink-0 text-right" title={task.title}>
                {task.title}
              </span>
              <div className="flex-1 relative h-4 bg-zinc-800/50 rounded">
                {isActive && (
                  <div
                    className={cn('absolute inset-y-0 rounded transition-all duration-500', barColor)}
                    style={{ left: `${leftPct}%`, width: `${widthPct}%`, minWidth: 4 }}
                  />
                )}
              </div>
              <span className="text-[10px] text-zinc-500 w-10 shrink-0 font-mono text-right">
                {duration > 0 ? formatDuration(duration) : ''}
              </span>
            </div>
          );
        })}
      </div>

      {/* Stats footer */}
      <div className="flex items-center justify-between text-[10px] text-zinc-500 mt-auto pt-2 border-t border-zinc-800">
        <span>Wall clock: <span className="text-zinc-300 font-mono">{formatDuration(wallClock)}</span></span>
        {sequentialMs > 0 && (
          <span>Sequential est: <span className="text-zinc-400 font-mono">{formatDuration(sequentialMs)}</span></span>
        )}
        {speedup && parseFloat(speedup) > 1.1 && (
          <span className="text-green-400 font-medium">{speedup}x faster</span>
        )}
      </div>
    </div>
  );
}
