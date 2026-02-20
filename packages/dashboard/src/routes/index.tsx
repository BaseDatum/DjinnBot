import { createFileRoute } from '@tanstack/react-router';
import { Card, CardHeader, CardTitle, CardDescription, CardContent } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Activity, Bot, Play, Clock } from 'lucide-react';
import { useState, useEffect, useRef, useCallback } from 'react';
import { fetchStatus, fetchRuns, fetchAgents, API_BASE } from '@/lib/api';
import { useSSE } from '@/hooks/useSSE';
import { getStatusVariant, formatTimeAgo } from '@/lib/format';
import { AllSessionsPanel } from '@/components/sessions/AllSessionsPanel';
import { DashboardQuickActionsMobile } from '@/components/DashboardQuickActions';

export const Route = createFileRoute('/')({
  component: DashboardHome,
});

interface StatusData {
  status?: string;
  version?: string;
  redis_connected?: boolean;
  active_runs?: number;
  completed_runs_last_hour?: number;
  total_agents?: number;
  total_pipelines?: number;
  avg_duration?: string;
}

interface Run {
  id: string;
  status: string;
  created_at: number;
  pipeline_id?: string;
}

function DashboardHome() {
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [statusData, setStatusData] = useState<StatusData>({});
  const [recentRuns, setRecentRuns] = useState<Run[]>([]);
  const [agents, setAgents] = useState<Array<{ id: string; name: string; emoji: string | null; role: string | null }>>([]);

  useEffect(() => {
    async function loadData() {
      try {
        setLoading(true);
        setError(null);
        
        // Fetch status, runs, and agents in parallel
        const [status, runsResponse, agentList] = await Promise.all([
          fetchStatus().catch(() => ({})),
          fetchRuns().catch(() => ({ runs: [] })),
          fetchAgents().catch(() => []),
        ]);
        
        setStatusData(status);
        setRecentRuns((Array.isArray(runsResponse) ? runsResponse : runsResponse.runs || []).slice(0, 4));
        setAgents(agentList);
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Failed to load data');
      } finally {
        setLoading(false);
      }
    }

    loadData();
  }, []);

  // Debounce ref for SSE updates that need full refresh (recent runs, etc.)
  const refreshTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const debouncedRefreshRuns = useCallback(() => {
    if (refreshTimeoutRef.current) {
      clearTimeout(refreshTimeoutRef.current);
    }
    refreshTimeoutRef.current = setTimeout(() => {
      fetchRuns()
        .then(response => {
          const runs = Array.isArray(response) ? response : response.runs || [];
          setRecentRuns(runs.slice(0, 4));
        })
        .catch(() => {});
      refreshTimeoutRef.current = null;
    }, 300);
  }, []);

  // Cleanup
  useEffect(() => {
    return () => {
      if (refreshTimeoutRef.current) clearTimeout(refreshTimeoutRef.current);
    };
  }, []);

  // Connect to global SSE stream for real-time updates
  // active_runs is updated directly from SSE event payloads (no polling)
  useSSE<any>({
    url: `${API_BASE}/events/stream`,
    enabled: !loading,
    onMessage: (event) => {
      // Update active_runs live from the event payload when available
      if (event.activeRuns !== undefined) {
        setStatusData(prev => ({ ...prev, active_runs: event.activeRuns }));
      }
      // Refresh recent runs list on run lifecycle events
      if (['RUN_CREATED', 'RUN_COMPLETE', 'RUN_FAILED', 'RUN_STATUS_CHANGED', 'STEP_STARTED', 'STEP_COMPLETE'].includes(event.type)) {
        debouncedRefreshRuns();
      }
    },
  });

  if (loading) {
    return (
      <div className="p-4 md:p-8 max-w-5xl mx-auto">
        <div className="mb-8">
          <h1 className="text-2xl md:text-3xl font-bold tracking-tight">Dashboard</h1>
          <p className="text-muted-foreground">
            Overview of your agent orchestration system
          </p>
        </div>
        <div className="flex items-center justify-center h-64">
          <p className="text-muted-foreground">Loading...</p>
        </div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="p-4 md:p-8 max-w-5xl mx-auto">
        <div className="mb-8">
          <h1 className="text-2xl md:text-3xl font-bold tracking-tight">Dashboard</h1>
          <p className="text-muted-foreground">
            Overview of your agent orchestration system
          </p>
        </div>
        <Card>
          <CardContent className="p-4 md:p-8">
            <p className="text-destructive">Error: {error}</p>
          </CardContent>
        </Card>
      </div>
    );
  }

  return (
    <div className="p-4 md:p-8 max-w-5xl mx-auto">
      <div className="mb-8">
        <h1 className="text-2xl md:text-3xl font-bold tracking-tight">Dashboard</h1>
        <p className="text-muted-foreground">
          Overview of your agent orchestration system
        </p>
      </div>

      <div className="grid gap-3 md:gap-4 grid-cols-2 lg:grid-cols-4">
        <Card>
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-sm font-medium">Active Runs</CardTitle>
            <div className="flex items-center gap-1.5">
              {(statusData.active_runs ?? 0) > 0 && (
                <span className="w-2 h-2 rounded-full bg-green-400 animate-pulse" title="Live" />
              )}
              <Activity className="h-4 w-4 text-muted-foreground" />
            </div>
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">{statusData.active_runs ?? 0}</div>
            <p className="text-xs text-muted-foreground">
              {statusData.completed_runs_last_hour ?? 0} completed in last hour
            </p>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-sm font-medium">Total Agents</CardTitle>
            <Bot className="h-4 w-4 text-muted-foreground" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">{statusData.total_agents ?? 0}</div>
            <p className="text-xs text-muted-foreground">
              {statusData.total_agents ? 'Registered agents' : 'No agents yet'}
            </p>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-sm font-medium">Pipelines</CardTitle>
            <Play className="h-4 w-4 text-muted-foreground" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">{statusData.total_pipelines ?? 0}</div>
            <p className="text-xs text-muted-foreground">
              {statusData.total_pipelines ? 'Available pipelines' : 'No pipelines yet'}
            </p>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-sm font-medium">Avg Duration</CardTitle>
            <Clock className="h-4 w-4 text-muted-foreground" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">{statusData.avg_duration ?? 'N/A'}</div>
            <p className="text-xs text-muted-foreground">
              Average run duration
            </p>
          </CardContent>
        </Card>
      </div>

      <div className="mt-8 grid gap-4 lg:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle>Recent Activity</CardTitle>
            <CardDescription>Latest events from your agents</CardDescription>
          </CardHeader>
          <CardContent>
            {recentRuns.length > 0 ? (
              <div className="space-y-4">
                {recentRuns.map((run) => (
                  <div key={run.id} className="flex items-center justify-between">
                    <div className="space-y-1">
                      <p className="text-sm font-medium">Run {run.id.substring(0, 8)}</p>
                      <p className="text-xs text-muted-foreground">
                        {run.pipeline_id || 'Unknown pipeline'}
                      </p>
                    </div>
                    <div className="flex items-center gap-2">
                      <Badge variant={getStatusVariant(run.status) as 'success' | 'destructive' | 'default' | 'outline'}>
                        {run.status}
                      </Badge>
                      <span className="text-xs text-muted-foreground">
                        {formatTimeAgo(run.created_at)}
                      </span>
                    </div>
                  </div>
                ))}
              </div>
            ) : (
              <p className="text-sm text-muted-foreground">No recent activity</p>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>System Status</CardTitle>
            <CardDescription>Current health of your infrastructure</CardDescription>
          </CardHeader>
          <CardContent>
            <div className="space-y-4">
              {[
                {
                  name: 'API Server',
                  status: statusData.status === 'ok' ? 'operational' : 'degraded',
                  variant: statusData.status === 'ok' ? 'success' : 'destructive'
                },
                {
                  name: 'Event Bus (Redis)',
                  status: statusData.redis_connected ? 'operational' : 'disconnected',
                  variant: statusData.redis_connected ? 'success' : 'destructive'
                },
                {
                  name: 'Database',
                  status: statusData.status === 'ok' ? 'operational' : 'unknown',
                  variant: statusData.status === 'ok' ? 'success' : 'warning'
                },
              ].map((service) => (
                <div key={service.name} className="flex items-center justify-between">
                  <span className="text-sm font-medium">{service.name}</span>
                  <Badge variant={service.variant as 'success' | 'warning' | 'destructive'}>
                    {service.status}
                  </Badge>
                </div>
              ))}
            </div>
          </CardContent>
        </Card>
      </div>

      {/* All Sessions Panel */}
      <div className="mt-8">
        <AllSessionsPanel agents={agents} />
      </div>

      {/* Mobile agent quick actions — floating button + bottom drawer */}
      <DashboardQuickActionsMobile agents={agents} />
    </div>
  );
}
