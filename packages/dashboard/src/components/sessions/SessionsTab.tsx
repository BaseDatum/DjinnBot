import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useSSE } from '@/hooks/useSSE';
import { fetchAgentSessions, API_BASE } from '@/lib/api';
import { SessionRow } from './SessionRow';
import { SessionDetail } from './SessionDetail';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Loader2, Inbox } from 'lucide-react';

interface SessionsTabProps {
  agentId: string;
}

export function SessionsTab({ agentId }: SessionsTabProps) {
  const [expandedId, setExpandedId] = useState<string | null>(null);
  
  const { data, isLoading, refetch } = useQuery({
    queryKey: ['sessions', agentId],
    queryFn: () => fetchAgentSessions(agentId),
    refetchInterval: 30000, // Fallback: poll every 30s
  });
  
  // Subscribe to live session updates
  useSSE({
    url: `${API_BASE}/events/sessions/${agentId}`,
    onMessage: (event: any) => {
      // Refetch on new session or status change
      if (event.type === 'created' || event.type === 'completed' || event.type === 'status_changed') {
        refetch();
      }
    },
  });
  
  const handleToggle = (sessionId: string) => {
    setExpandedId(expandedId === sessionId ? null : sessionId);
  };

  if (isLoading) {
    return (
      <div className="flex items-center justify-center h-[calc(100vh-220px)]">
        <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
      </div>
    );
  }

  if (!data || data.sessions.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center h-[calc(100vh-220px)] text-muted-foreground">
        <Inbox className="h-12 w-12 mb-4 opacity-50" />
        <p className="text-lg font-medium">No sessions yet</p>
        <p className="text-sm">Sessions will appear here when the agent handles requests</p>
      </div>
    );
  }

  return (
    <div className="h-[calc(100vh-220px)] overflow-hidden flex flex-col border rounded-lg">
      {/* Header */}
      <div className="p-3 border-b bg-muted/20 flex items-center justify-between">
        <div>
          <h3 className="font-semibold">Sessions</h3>
          <p className="text-xs text-muted-foreground">
            {data.total} total {data.hasMore && '(showing recent 50)'}
          </p>
        </div>
      </div>

      {/* Sessions List */}
      <ScrollArea className="flex-1">
        <div className="divide-y divide-border/50">
          {data.sessions.map((session) => (
            <div key={session.id}>
              <SessionRow
                session={session}
                isExpanded={expandedId === session.id}
                onToggle={() => handleToggle(session.id)}
                onSessionStopped={() => refetch()}
              />
              {expandedId === session.id && (
                <SessionDetail sessionId={session.id} />
              )}
            </div>
          ))}
        </div>
      </ScrollArea>
    </div>
  );
}
