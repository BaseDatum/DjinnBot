import { useQuery } from '@tanstack/react-query';
import { CurrentStateCard } from './CurrentStateCard';
import { ResourceUsageDisplay } from './ResourceUsage';
import { ActivityTimeline } from './ActivityTimeline';
import { fetchAgentLifecycle, fetchAgentActivity } from '@/lib/api';
import { useAgentLifecycle } from '@/hooks/useAgentLifecycle';
import { Loader2 } from 'lucide-react';
import { ScrollArea } from '@/components/ui/scroll-area';

interface AgentActivityProps {
  agentId: string;
}

export function AgentActivity({ agentId }: AgentActivityProps) {
  // Fetch current lifecycle state
  const { data: lifecycle, refetch: refetchLifecycle } = useQuery({
    queryKey: ['lifecycle', agentId],
    queryFn: () => fetchAgentLifecycle(agentId),
    refetchInterval: 10000, // Fallback: poll every 10s
  });

  // Fetch activity timeline
  const { data: activity, refetch: refetchActivity, isLoading } = useQuery({
    queryKey: ['activity', agentId],
    queryFn: () => fetchAgentActivity(agentId),
    refetchInterval: 30000, // Fallback: poll every 30s
  });

  // Real-time updates via SSE
  useAgentLifecycle({
    agentId,
    onEvent: () => {
      refetchLifecycle();
      refetchActivity();
    },
  });

  if (isLoading) {
    return (
      <div className="flex items-center justify-center h-[calc(100vh-220px)]">
        <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
      </div>
    );
  }

  return (
    <div className="h-[calc(100vh-220px)] overflow-hidden flex flex-col gap-4 p-4 bg-background">
      {/* Current State */}
      <CurrentStateCard lifecycle={lifecycle} />

      {/* Resource Usage */}
      <ResourceUsageDisplay resourceUsage={activity?.resourceUsage} />

      {/* Timeline */}
      <div className="flex-1 min-h-0 border rounded-lg overflow-hidden">
        <div className="p-3 border-b bg-muted/20">
          <h3 className="font-semibold">Timeline</h3>
          <p className="text-xs text-muted-foreground">Recent activity and state transitions</p>
        </div>
        <ScrollArea className="h-[calc(100%-60px)]">
          <ActivityTimeline timeline={activity?.timeline || []} />
        </ScrollArea>
      </div>
    </div>
  );
}
