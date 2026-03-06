import { useState, useCallback } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useSSE } from '@/hooks/useSSE';
import { fetchAllSessions, API_BASE } from '@/lib/api';
import { SessionRow } from './SessionRow';
import { SessionDetail } from './SessionDetail';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Card, CardHeader, CardTitle, CardDescription, CardContent } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Loader2, Inbox, X } from 'lucide-react';
import type { AgentListItem } from '@/lib/api';

interface AllSessionsPanelProps {
  agents: AgentListItem[];
}

export function AllSessionsPanel({ agents }: AllSessionsPanelProps) {
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [selectedAgentIds, setSelectedAgentIds] = useState<Set<string>>(new Set());
  const queryClient = useQueryClient();

  // Derive filtered agent ids for the query
  const activeFilter = selectedAgentIds.size > 0 ? [...selectedAgentIds] : undefined;

  const { data, isLoading, refetch } = useQuery({
    queryKey: ['all-sessions', activeFilter?.join(',') ?? 'all'],
    queryFn: () => fetchAllSessions({ agentIds: activeFilter, limit: 100 }),
    refetchInterval: 60000, // Fallback polling every 60s
  });

  // Subscribe to global session SSE stream for live updates
  useSSE({
    url: `${API_BASE}/events/sessions`,
    onMessage: (event: any) => {
      const type = event.type || event.event;
      if (
        type === 'created' ||
        type === 'completed' ||
        type === 'status_changed' ||
        type === 'failed'
      ) {
        // Invalidate all-sessions queries so the list refreshes
        queryClient.invalidateQueries({ queryKey: ['all-sessions'] });
        refetch();
      }
    },
  });

  const handleToggle = useCallback((sessionId: string) => {
    setExpandedId(prev => (prev === sessionId ? null : sessionId));
  }, []);

  const toggleAgent = useCallback((agentId: string) => {
    setSelectedAgentIds(prev => {
      const next = new Set(prev);
      if (next.has(agentId)) {
        next.delete(agentId);
      } else {
        next.add(agentId);
      }
      return next;
    });
  }, []);

  const clearFilter = useCallback(() => {
    setSelectedAgentIds(new Set());
  }, []);

  // Build agent lookup map for display
  const agentMap = new Map(agents.map(a => [a.id, a]));

  const sessions = data?.sessions ?? [];

  return (
    <Card>
      <CardHeader>
        <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
          <div>
            <CardTitle>All Sessions</CardTitle>
            <CardDescription>
              Sessions across all agents
              {data && (
                <span className="ml-1">
                  — {data.total} total{data.hasMore ? ' (showing first 100)' : ''}
                </span>
              )}
            </CardDescription>
          </div>

          {/* Live indicator */}
          <div className="flex items-center gap-1.5 text-xs text-muted-foreground flex-shrink-0">
            <span className="w-2 h-2 rounded-full bg-green-400 animate-pulse" />
            Live
          </div>
        </div>

        {/* Agent filter chips */}
        {agents.length > 0 && (
          <div className="flex flex-wrap gap-1.5 pt-1">
            {agents.map(agent => {
              const isSelected = selectedAgentIds.has(agent.id);
              return (
                <button
                  key={agent.id}
                  onClick={() => toggleAgent(agent.id)}
                  className={`inline-flex items-center gap-1 rounded-full border px-2.5 py-0.5 text-xs font-medium transition-colors
                    ${isSelected
                      ? 'border-primary bg-primary/10 text-primary'
                      : 'border-border bg-muted/40 text-muted-foreground hover:border-primary/50 hover:text-foreground'
                    }`}
                >
                  {agent.emoji && <span>{agent.emoji}</span>}
                  {agent.name}
                </button>
              );
            })}
            {selectedAgentIds.size > 0 && (
              <Button
                variant="ghost"
                size="sm"
                onClick={clearFilter}
                className="h-6 rounded-full px-2 text-xs text-muted-foreground hover:text-foreground"
              >
                <X className="mr-1 h-3 w-3" />
                Clear filter
              </Button>
            )}
          </div>
        )}

        {/* Active filter summary */}
        {selectedAgentIds.size > 0 && (
          <p className="text-xs text-muted-foreground">
            Showing sessions for{' '}
            {[...selectedAgentIds]
              .map(id => agentMap.get(id)?.name ?? id)
              .join(', ')}
          </p>
        )}
      </CardHeader>

      <CardContent className="p-0">
        {isLoading ? (
          <div className="flex items-center justify-center py-16">
            <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
          </div>
        ) : sessions.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-16 text-muted-foreground">
            <Inbox className="h-10 w-10 mb-3 opacity-40" />
            <p className="font-medium">No sessions yet</p>
            <p className="text-sm mt-1">
              {selectedAgentIds.size > 0
                ? 'No sessions found for the selected agents'
                : 'Sessions will appear here when agents handle requests'}
            </p>
          </div>
        ) : (
          <div className="border-t border-border/50">
            <ScrollArea className="max-h-[600px]">
              <div className="divide-y divide-border/50">
                {sessions.map(session => {
                  const agent = agentMap.get(session.agent_id);
                  return (
                    <div key={session.id}>
                      {/* Agent badge row */}
                      <div className="px-4 pt-2 pb-0 flex items-center gap-2">
                        <Badge
                          variant="outline"
                          className="text-xs h-5 px-1.5 text-muted-foreground border-border/60 font-normal"
                        >
                          {agent?.emoji && <span className="mr-1">{agent.emoji}</span>}
                          {agent?.name ?? session.agent_id}
                        </Badge>
                      </div>
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
                  );
                })}
              </div>
            </ScrollArea>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
