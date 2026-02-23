import { createFileRoute, Link } from '@tanstack/react-router';
import { Card, CardHeader, CardContent } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Play, Search, Trash2, ChevronDown, Square, Loader2, Key, Network } from 'lucide-react';
import { useState, useEffect, useRef, useCallback } from 'react';
import { fetchRuns, fetchSwarms, deleteRun, bulkDeleteRuns, cancelRun, API_BASE } from '@/lib/api';
import { useSSE } from '@/hooks/useSSE';
import { getStatusVariant, formatDuration } from '@/lib/format';
import { ConfirmDialog } from '@/components/ConfirmDialog';
import { KeySourceBadge } from '@/components/ui/KeySourceBadge';
import { SessionTokenStats } from '@/components/ui/SessionTokenStats';

interface Run {
  id: string;
  pipeline_id?: string;
  agent_id?: string;
  status: string;
  created_at: number;
  completed_at?: number | null;
  duration?: string;
  key_resolution?: {
    source?: string;
    userId?: string | null;
    resolvedProviders?: string[];
    providerSources?: Record<string, { source: string; masked_key: string }>;
  } | null;
  initiated_by_user_id?: string | null;
}

export const Route = createFileRoute('/runs/')({
  component: RunsList,
});

function RunsList() {
  const [filter, setFilter] = useState('');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [runs, setRuns] = useState<Run[]>([]);
  const [showCleanup, setShowCleanup] = useState(false);
  const [confirmAction, setConfirmAction] = useState<{ title: string; desc: string; action: () => void } | null>(null);
  const [stoppingRuns, setStoppingRuns] = useState<Set<string>>(new Set());
  const [swarms, setSwarms] = useState<any[]>([]);

  // Debounce ref for SSE updates
  const refreshTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const debouncedRefresh = useCallback(() => {
    if (refreshTimeoutRef.current) {
      clearTimeout(refreshTimeoutRef.current);
    }
    refreshTimeoutRef.current = setTimeout(() => {
      fetchRuns()
        .then(response => setRuns(Array.isArray(response) ? response : response.runs || []))
        .catch(() => {});
      refreshTimeoutRef.current = null;
    }, 300);
  }, []);

  // Cleanup timeout on unmount
  useEffect(() => {
    return () => {
      if (refreshTimeoutRef.current) clearTimeout(refreshTimeoutRef.current);
    };
  }, []);

  useEffect(() => {
    async function loadRuns() {
      try {
        setLoading(true);
        setError(null);
        const [runsResponse, swarmsResponse] = await Promise.all([
          fetchRuns(),
          fetchSwarms().catch(() => ({ swarms: [] })),
        ]);
        setRuns(Array.isArray(runsResponse) ? runsResponse : runsResponse.runs || []);
        setSwarms(swarmsResponse.swarms || []);
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Failed to load runs');
      } finally {
        setLoading(false);
      }
    }

    loadRuns();
  }, []);

  // Connect to global SSE stream for real-time updates
  useSSE<any>({
    url: `${API_BASE}/events/stream`,
    enabled: !loading,
    onMessage: (event) => {
      switch (event.type) {
        case 'RUN_CREATED':
        case 'RUN_STATUS_CHANGED':
          // A new run was created or status changed — refetch with debounce
          debouncedRefresh();
          break;
        case 'RUN_COMPLETE':
        case 'RUN_FAILED':
          // Update in place
          setRuns(prev => prev.map(r => 
            r.id === event.runId 
              ? { ...r, status: event.type === 'RUN_COMPLETE' ? 'completed' : 'failed', completed_at: event.timestamp }
              : r
          ));
          break;
        case 'STEP_STARTED':
          // Mark run as running
          setRuns(prev => prev.map(r =>
            r.id === event.runId && r.status === 'pending'
              ? { ...r, status: 'running' }
              : r
          ));
          break;
      }
    },
  });

  const filteredRuns = runs.filter(run => 
    (run.pipeline_id?.toLowerCase().includes(filter.toLowerCase()) ||
     run.agent_id?.toLowerCase().includes(filter.toLowerCase()) ||
     run.id.toLowerCase().includes(filter.toLowerCase()))
  );

  const handleStopRun = async (runId: string, e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    
    if (stoppingRuns.has(runId)) return;
    
    setStoppingRuns(prev => new Set(prev).add(runId));
    try {
      await cancelRun(runId);
      // Update local state immediately for responsiveness
      setRuns(prev => prev.map(r => 
        r.id === runId ? { ...r, status: 'cancelled' } : r
      ));
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to stop run');
    } finally {
      setStoppingRuns(prev => {
        const next = new Set(prev);
        next.delete(runId);
        return next;
      });
    }
  };

  const handleDeleteRun = async (runId: string, e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    
    setConfirmAction({
      title: 'Delete Run',
      desc: 'Are you sure you want to delete this run? This action cannot be undone.',
      action: async () => {
        try {
          await deleteRun(runId);
          setRuns(prev => prev.filter(r => r.id !== runId));
        } catch (err) {
          setError(err instanceof Error ? err.message : 'Failed to delete run');
        }
      }
    });
  };

  const handleBulkDelete = async (type: 'completed' | 'failed' | 'old') => {
    let params: { status?: string; before?: number } = {};
    let confirmMsg = '';
    
    switch (type) {
      case 'completed':
        params = { status: 'completed' };
        confirmMsg = 'Delete all completed runs?';
        break;
      case 'failed':
        params = { status: 'failed' };
        confirmMsg = 'Delete all failed runs?';
        break;
      case 'old':
        const sevenDaysAgo = Date.now() - (7 * 24 * 60 * 60 * 1000);
        params = { before: sevenDaysAgo };
        confirmMsg = 'Delete all runs older than 7 days?';
        break;
    }
    
    setConfirmAction({
      title: 'Bulk Delete',
      desc: confirmMsg,
      action: async () => {
        try {
          const result = await bulkDeleteRuns(params);
          setShowCleanup(false);
          await fetchRuns()
            .then(response => setRuns(Array.isArray(response) ? response : response.runs || []))
            .catch(console.error);
          // Success - silently refresh the list
        } catch (err) {
          setError(err instanceof Error ? err.message : 'Failed to delete runs');
        }
      }
    });
  };

  return (
    <div className="p-4 md:p-8 max-w-5xl mx-auto">
      <div className="mb-6 md:mb-8 flex flex-col sm:flex-row sm:items-center justify-between gap-4">
        <div className="flex items-center gap-3">
          <Play className="h-8 w-8 shrink-0" />
          <div>
            <h1 className="text-2xl md:text-3xl font-bold tracking-tight">Runs</h1>
            <p className="text-muted-foreground">
              View and manage agent execution runs
            </p>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <div className="relative">
            <Button
              variant="outline"
              onClick={() => setShowCleanup(!showCleanup)}
              className="gap-2"
            >
              <Trash2 className="h-4 w-4" />
              Clean Up
              <ChevronDown className="h-4 w-4" />
            </Button>
            {showCleanup && (
              <div className="absolute right-0 mt-2 w-56 rounded-md border bg-popover p-1 shadow-md z-50">
                <button
                  onClick={() => handleBulkDelete('completed')}
                  className="w-full text-left px-3 py-2 text-sm rounded hover:bg-accent"
                >
                  Delete all completed runs
                </button>
                <button
                  onClick={() => handleBulkDelete('failed')}
                  className="w-full text-left px-3 py-2 text-sm rounded hover:bg-accent"
                >
                  Delete all failed runs
                </button>
                <button
                  onClick={() => handleBulkDelete('old')}
                  className="w-full text-left px-3 py-2 text-sm rounded hover:bg-accent"
                >
                  Delete runs older than 7 days
                </button>
              </div>
            )}
          </div>
          <Button>
            <Play className="mr-2 h-4 w-4" />
            New Run
          </Button>
        </div>
      </div>

      {/* Active Swarms */}
      {swarms.length > 0 && (
        <Card className="mb-4">
          <CardHeader>
            <div className="flex items-center gap-2">
              <Network className="h-4 w-4 text-indigo-400" />
              <span className="text-sm font-semibold">Swarm Executions</span>
              <Badge variant="outline" className="text-[10px]">{swarms.length}</Badge>
            </div>
          </CardHeader>
          <CardContent>
            <div className="space-y-2">
              {swarms.map((swarm: any) => {
                const isActive = swarm.status === 'running';
                const isFailed = swarm.status === 'failed';
                const variant = isActive ? 'default' : isFailed ? 'destructive' : 'outline';
                const doneCount = (swarm.completed_count || 0) + (swarm.failed_count || 0);
                const total = swarm.total_count || 0;
                const elapsed = swarm.created_at ? Date.now() - swarm.created_at : 0;
                const elapsedStr = elapsed > 60000 ? `${Math.floor(elapsed / 60000)}m` : `${Math.floor(elapsed / 1000)}s`;

                return (
                  <Link
                    key={swarm.swarm_id}
                    to="/runs/swarm/$swarmId"
                    params={{ swarmId: swarm.swarm_id }}
                    className="group flex items-center justify-between gap-3 rounded-lg border p-3 transition-colors hover:bg-accent"
                  >
                    <div className="flex items-center gap-3">
                      <div className="flex h-10 w-10 items-center justify-center rounded-full bg-indigo-500/10">
                        <Network className="h-4 w-4 text-indigo-400" />
                      </div>
                      <div>
                        <p className="font-medium font-mono text-sm">{swarm.swarm_id}</p>
                        <p className="text-xs text-muted-foreground">
                          {swarm.agent_id} — {total} tasks, max {swarm.max_concurrent || 3} parallel
                        </p>
                      </div>
                    </div>
                    <div className="flex items-center gap-4">
                      <div className="text-right">
                        <p className="text-xs text-muted-foreground">Progress</p>
                        <p className="text-sm font-mono">{doneCount}/{total}</p>
                      </div>
                      <div className="text-right">
                        <p className="text-xs text-muted-foreground">Elapsed</p>
                        <p className="text-sm">{elapsedStr}</p>
                      </div>
                      <Badge variant={variant as any}>
                        {isActive && <Loader2 className="h-3 w-3 mr-1 animate-spin" />}
                        {swarm.status}
                      </Badge>
                    </div>
                  </Link>
                );
              })}
            </div>
          </CardContent>
        </Card>
      )}

      <Card>
        <CardHeader>
          <div className="flex items-center gap-4">
            <div className="relative flex-1">
              <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
              <input
                type="text"
                placeholder="Filter runs..."
                value={filter}
                onChange={(e) => setFilter(e.target.value)}
                className="h-10 w-full rounded-md border border-input bg-background pl-10 pr-4 text-sm ring-offset-background placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              />
            </div>
          </div>
        </CardHeader>
        <CardContent>
          {loading ? (
            <div className="flex items-center justify-center py-8">
              <p className="text-muted-foreground">Loading runs...</p>
            </div>
          ) : error ? (
            <div className="flex items-center justify-center py-8">
              <p className="text-destructive">Error: {error}</p>
            </div>
          ) : filteredRuns.length === 0 ? (
            <div className="flex items-center justify-center py-8">
              <p className="text-muted-foreground">
                {runs.length === 0 ? 'No runs yet' : 'No runs match your filter'}
              </p>
            </div>
          ) : (
            <div className="space-y-2">
              {filteredRuns.map((run) => (
                <Link
                  key={run.id}
                  to="/runs/$runId"
                  params={{ runId: run.id }}
                  className="group flex flex-col sm:flex-row sm:items-center justify-between gap-3 rounded-lg border p-3 md:p-4 transition-colors hover:bg-accent"
                >
                  <div className="flex items-center gap-4">
                    <div className="flex h-10 w-10 items-center justify-center rounded-full bg-muted">
                      <Play className="h-4 w-4" />
                    </div>
                    <div>
                      <p className="font-medium font-mono text-sm truncate max-w-[200px] sm:max-w-none">{run.id.substring(0, 8)}…</p>
                      <p className="text-sm text-muted-foreground">
                        {run.pipeline_id || run.agent_id || 'Unknown'}
                      </p>
                    </div>
                  </div>
                  <div className="flex items-center gap-4">
                    <div className="text-right">
                      <p className="text-sm text-muted-foreground">Started</p>
                      <p className="text-sm">{new Date(run.created_at).toLocaleTimeString()}</p>
                    </div>
                    <div className="text-right">
                      <p className="text-sm text-muted-foreground">Duration</p>
                      <p className="text-sm">{formatDuration(run.created_at, run.completed_at, run.duration)}</p>
                    </div>
                    <Badge variant={getStatusVariant(run.status) as 'success' | 'destructive' | 'default' | 'outline'}>
                      {run.status}
                    </Badge>
                    {run.key_resolution && (
                      <KeySourceBadge keyResolution={run.key_resolution} />
                    )}
                    <SessionTokenStats runId={run.id} />
                    {(run.status === 'running' || run.status === 'pending') && (
                      <Button
                        variant="ghost"
                        size="icon"
                        className="h-8 w-8 text-red-400 hover:text-red-300 hover:bg-red-500/10"
                        onClick={(e) => handleStopRun(run.id, e)}
                        disabled={stoppingRuns.has(run.id)}
                        title="Stop run"
                      >
                        {stoppingRuns.has(run.id) ? (
                          <Loader2 className="h-4 w-4 animate-spin" />
                        ) : (
                          <Square className="h-4 w-4" />
                        )}
                      </Button>
                    )}
                    <Button
                      variant="ghost"
                      size="icon"
                      className="h-8 w-8 opacity-0 group-hover:opacity-100 transition-opacity"
                      onClick={(e) => handleDeleteRun(run.id, e)}
                      title="Delete run"
                    >
                      <Trash2 className="h-4 w-4 text-destructive" />
                    </Button>
                  </div>
                </Link>
              ))}
            </div>
          )}
        </CardContent>
      </Card>

      {confirmAction && (
        <ConfirmDialog
          open={!!confirmAction}
          onOpenChange={(open) => !open && setConfirmAction(null)}
          title={confirmAction.title}
          description={confirmAction.desc}
          onConfirm={confirmAction.action}
        />
      )}
    </div>
  );
}
