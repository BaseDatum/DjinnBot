import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { AgentStatusCard } from './AgentStatusCard';
import { AgentListItem } from './AgentListItem';
import { AgentFleetSummary } from './AgentFleetSummary';
import { PulseTimeline } from '@/components/pulse';
import { fetchAgentsStatus, AgentStatus } from '@/lib/api';
import { useAgentLifecycle } from '@/hooks/useAgentLifecycle';
import { Button } from '@/components/ui/button';
import { LayoutGrid, List, Bot } from 'lucide-react';
import { Card } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';

export function AgentsOverview() {
  const [viewMode, setViewMode] = useState<'grid' | 'list'>('grid');

  // Fetch all agents status
  const { data, refetch, isLoading, isError } = useQuery({
    queryKey: ['agents-status'],
    queryFn: fetchAgentsStatus,
    refetchInterval: 10000,
  });

  const agents: AgentStatus[] = data?.agents || [];
  const workingCount = agents.filter(a => a.state === 'working').length;

  // Real-time updates via SSE (no agentId filter - listen to all)
  useAgentLifecycle({
    onEvent: () => {
      refetch();
    },
  });

  if (isLoading) {
    return (
      <div className="p-4 md:p-8 max-w-5xl mx-auto space-y-6">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-3">
            <Bot className="h-8 w-8 shrink-0" />
            <h1 className="text-2xl md:text-3xl font-bold tracking-tight">Agents</h1>
          </div>
        </div>
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-4">
          {[...Array(6)].map((_, i) => (
            <Card key={i} className="p-4 space-y-3">
              <div className="flex items-center gap-2">
                <Skeleton circle width={40} height={40} />
                <div className="space-y-1.5 flex-1">
                  <Skeleton width="60%" height={14} />
                  <Skeleton width="40%" height={12} />
                </div>
              </div>
              <Skeleton width="50%" height={20} />
              <div className="space-y-2">
                <Skeleton height={13} />
                <Skeleton height={13} />
                <Skeleton width="70%" height={13} />
              </div>
            </Card>
          ))}
        </div>
      </div>
    );
  }

  if (isError) {
    return (
      <div className="p-4 md:p-8 max-w-5xl mx-auto space-y-6">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-3">
            <Bot className="h-8 w-8 shrink-0" />
            <h1 className="text-2xl md:text-3xl font-bold tracking-tight">Agents</h1>
          </div>
        </div>
        <Card className="p-8 text-center">
          <p className="text-destructive">Failed to load agents. Please try again.</p>
          <Button variant="outline" className="mt-4" onClick={() => refetch()}>
            Retry
          </Button>
        </Card>
      </div>
    );
  }

  return (
    <div className="p-4 md:p-8 max-w-5xl mx-auto space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <Bot className="h-8 w-8 shrink-0" />
          <div>
            <h1 className="text-2xl md:text-3xl font-bold tracking-tight">Agents</h1>
            <p className="text-muted-foreground">
              {agents.length} agents · {workingCount} working
            </p>
          </div>
        </div>

        {/* View mode toggle */}
        <div className="flex items-center gap-2">
          <Button
            variant={viewMode === 'grid' ? 'default' : 'outline'}
            size="sm"
            onClick={() => setViewMode('grid')}
          >
            <LayoutGrid className="h-4 w-4" />
          </Button>
          <Button
            variant={viewMode === 'list' ? 'default' : 'outline'}
            size="sm"
            onClick={() => setViewMode('list')}
          >
            <List className="h-4 w-4" />
          </Button>
        </div>
      </div>

      {/* Fleet summary */}
      <AgentFleetSummary agents={agents} />

      {/* Pulse Timeline - shared view of all agent pulses */}
      <PulseTimeline hours={24} />

      {/* Agents display */}
      {viewMode === 'grid' ? (
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-4">
          {agents.map((agent) => (
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            <Link key={agent.id} to={`/agents/${agent.id}` as any} className="no-underline">
              <AgentStatusCard agent={agent} />
            </Link>
          ))}
        </div>
      ) : (
        <div className="space-y-2">
          {agents.map((agent) => (
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            <Link key={agent.id} to={`/agents/${agent.id}` as any} className="no-underline">
              <AgentListItem agent={agent} />
            </Link>
          ))}
        </div>
      )}

      {agents.length === 0 && (
        <div className="text-center py-12 text-muted-foreground">
          <p className="text-lg">No agents configured yet</p>
        </div>
      )}
    </div>
  );
}
