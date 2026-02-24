import { useState, useEffect, useCallback, useRef } from 'react';
import { formatDistanceToNow } from 'date-fns';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  Zap,
  X,
  ChevronRight,
  Loader2,
  CheckCircle2,
  XCircle,
  Clock,
  Bot,
} from 'lucide-react';
import { fetchProjectSwarms } from '@/lib/api';
import { SwarmView } from '@/components/swarm/SwarmView';

interface SwarmEntry {
  swarm_id: string;
  status: string;
  agent_id: string;
  total_tasks?: number;
  completed_tasks?: number;
  failed_tasks?: number;
  created_at: number;
  completed_at?: number;
  tasks?: Array<{
    key: string;
    title: string;
    status: string;
  }>;
}

interface ProjectSwarmHistoryProps {
  projectId: string;
  open: boolean;
  onClose: () => void;
}

function statusBadge(status: string) {
  switch (status) {
    case 'running':
      return (
        <Badge variant="outline" className="text-[10px] text-amber-500 border-amber-500/30 bg-amber-500/5 gap-1">
          <span className="relative flex h-1.5 w-1.5">
            <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-amber-500 opacity-75" />
            <span className="relative inline-flex rounded-full h-1.5 w-1.5 bg-amber-500" />
          </span>
          Running
        </Badge>
      );
    case 'completed':
      return (
        <Badge variant="outline" className="text-[10px] text-green-500 border-green-500/30 bg-green-500/5 gap-1">
          <CheckCircle2 className="h-2.5 w-2.5" />
          Completed
        </Badge>
      );
    case 'failed':
      return (
        <Badge variant="outline" className="text-[10px] text-red-500 border-red-500/30 bg-red-500/5 gap-1">
          <XCircle className="h-2.5 w-2.5" />
          Failed
        </Badge>
      );
    case 'cancelled':
      return (
        <Badge variant="outline" className="text-[10px] text-zinc-400 border-zinc-400/30 bg-zinc-400/5 gap-1">
          <X className="h-2.5 w-2.5" />
          Cancelled
        </Badge>
      );
    default:
      return (
        <Badge variant="outline" className="text-[10px] gap-1">
          <Clock className="h-2.5 w-2.5" />
          {status}
        </Badge>
      );
  }
}

export function ProjectSwarmHistory({ projectId, open, onClose }: ProjectSwarmHistoryProps) {
  const [swarms, setSwarms] = useState<SwarmEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [expandedSwarmId, setExpandedSwarmId] = useState<string | null>(null);
  const refreshTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const loadSwarms = useCallback(async () => {
    try {
      const data = await fetchProjectSwarms(projectId);
      const sorted = (data.swarms || []).sort(
        (a: SwarmEntry, b: SwarmEntry) => (b.created_at || 0) - (a.created_at || 0),
      );
      setSwarms(sorted);
    } catch {
      // Silently fail — swarm history is best-effort from Redis
    } finally {
      setLoading(false);
    }
  }, [projectId]);

  // Load on open + auto-refresh if any swarm is running
  useEffect(() => {
    if (!open) return;

    setLoading(true);
    loadSwarms();

    return () => {
      if (refreshTimerRef.current) {
        clearInterval(refreshTimerRef.current);
        refreshTimerRef.current = null;
      }
    };
  }, [open, loadSwarms]);

  // Set up polling when there are running swarms
  useEffect(() => {
    if (!open) return;

    const hasRunning = swarms.some((s) => s.status === 'running');

    if (hasRunning && !refreshTimerRef.current) {
      refreshTimerRef.current = setInterval(loadSwarms, 5000);
    } else if (!hasRunning && refreshTimerRef.current) {
      clearInterval(refreshTimerRef.current);
      refreshTimerRef.current = null;
    }

    return () => {
      if (refreshTimerRef.current) {
        clearInterval(refreshTimerRef.current);
        refreshTimerRef.current = null;
      }
    };
  }, [open, swarms, loadSwarms]);

  if (!open) return null;

  return (
    <>
      {/* Backdrop */}
      <div className="fixed inset-0 z-40 bg-black/20" onClick={onClose} />

      {/* Slide-over panel */}
      <div className="fixed right-0 top-0 bottom-0 z-50 w-full max-w-lg bg-card border-l shadow-xl flex flex-col animate-in slide-in-from-right duration-200">
        {/* Header */}
        <div className="flex items-center justify-between px-4 py-3 border-b shrink-0">
          <div className="flex items-center gap-2">
            <Zap className="h-4 w-4 text-amber-500" />
            <h2 className="text-sm font-semibold">Swarm History</h2>
            {swarms.length > 0 && (
              <Badge variant="secondary" className="text-[10px]">
                {swarms.length}
              </Badge>
            )}
          </div>
          <Button variant="ghost" size="sm" className="h-7 w-7 p-0" onClick={onClose}>
            <X className="h-4 w-4" />
          </Button>
        </div>

        {/* Content */}
        <div className="flex-1 overflow-y-auto min-h-0">
          {loading ? (
            <div className="flex items-center justify-center py-12 gap-2 text-muted-foreground">
              <Loader2 className="h-4 w-4 animate-spin" />
              <span className="text-sm">Loading swarm history...</span>
            </div>
          ) : swarms.length === 0 ? (
            <div className="flex flex-col items-center justify-center py-16 px-6 text-center">
              <Zap className="h-8 w-8 text-muted-foreground/40 mb-3" />
              <p className="text-sm text-muted-foreground">
                No swarms executed yet.
              </p>
              <p className="text-xs text-muted-foreground/70 mt-1 max-w-xs">
                Select tasks on the board and use "Execute as Swarm" to run tasks in parallel.
              </p>
            </div>
          ) : (
            <div className="divide-y">
              {swarms.map((swarm) => {
                const isExpanded = expandedSwarmId === swarm.swarm_id;
                const taskCount = swarm.total_tasks ?? swarm.tasks?.length ?? 0;

                return (
                  <div key={swarm.swarm_id}>
                    {/* Swarm row */}
                    <button
                      className="w-full text-left px-4 py-3 hover:bg-muted/50 transition-colors"
                      onClick={() =>
                        setExpandedSwarmId(isExpanded ? null : swarm.swarm_id)
                      }
                    >
                      <div className="flex items-center gap-2 mb-1">
                        {statusBadge(swarm.status)}
                        <span className="text-[11px] font-mono text-muted-foreground">
                          {swarm.swarm_id.slice(0, 12)}
                        </span>
                        <div className="flex-1" />
                        <ChevronRight
                          className={`h-3.5 w-3.5 text-muted-foreground transition-transform ${
                            isExpanded ? 'rotate-90' : ''
                          }`}
                        />
                      </div>
                      <div className="flex items-center gap-3 text-xs text-muted-foreground">
                        <span className="flex items-center gap-1">
                          <Bot className="h-3 w-3" />
                          {swarm.agent_id}
                        </span>
                        <span>
                          {taskCount} task{taskCount !== 1 ? 's' : ''}
                        </span>
                        {swarm.created_at && (
                          <span>
                            {formatDistanceToNow(swarm.created_at * 1000, {
                              addSuffix: true,
                            })}
                          </span>
                        )}
                      </div>
                    </button>

                    {/* Expanded SwarmView */}
                    {isExpanded && (
                      <div className="border-t bg-zinc-950" style={{ height: '400px' }}>
                        <SwarmView swarmId={swarm.swarm_id} />
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </div>
      </div>
    </>
  );
}
