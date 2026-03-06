import { useState, useMemo, lazy, Suspense } from 'react';
import { useQuery } from '@tanstack/react-query';
import { InboxFilters } from './InboxFilters';
import { InboxMessage } from './InboxMessage';
import { InboxStatusBar } from './InboxStatusBar';
import { fetchAgentInbox, markAgentMessagesRead } from '@/lib/api';
import { useAgentLifecycle } from '@/hooks/useAgentLifecycle';
import { Button } from '@/components/ui/button';
import { ScrollArea } from '@/components/ui/scroll-area';
import { AlertCircle, Loader2, Mail } from 'lucide-react';
import type { AgentMessage, InboxFilter } from '@/types/inbox';

// Lazy load ComposeMessage - will be created in C1
const ComposeMessage = lazy(() => import('./ComposeMessage').then(module => ({ default: module.ComposeMessage })));

interface AgentInboxProps {
  agentId: string;
}

export function AgentInbox({ agentId }: AgentInboxProps) {
  const [filter, setFilter] = useState<InboxFilter>('all');
  const [composeOpen, setComposeOpen] = useState(false);

  // Fetch inbox messages
  const { data, isLoading, refetch, error } = useQuery({
    queryKey: ['inbox', agentId],
    queryFn: () => fetchAgentInbox(agentId),
    refetchInterval: 30000, // Fallback: poll every 30s
  });

  const messages: AgentMessage[] = data?.messages || [];
  const unreadCount = data?.unreadCount || 0;

  // Real-time updates via SSE
  useAgentLifecycle({
    agentId,
    onEvent: (event) => {
      if (event.type === 'AGENT_MESSAGE_RECEIVED') {
        refetch();
      }
    },
  });

  // Apply filters
  const filteredMessages = useMemo(() => {
    let filtered: AgentMessage[] = messages;
    
    switch (filter) {
      case 'unread':
        filtered = messages.filter((m: AgentMessage) => !m.read);
        break;
      case 'urgent':
        filtered = messages.filter((m: AgentMessage) => m.priority === 'urgent');
        break;
      case 'review_request':
        filtered = messages.filter((m: AgentMessage) => m.type === 'review_request');
        break;
      case 'help_request':
        filtered = messages.filter((m: AgentMessage) => m.type === 'help_request');
        break;
      default:
        filtered = messages;
    }
    
    return filtered.sort((a: AgentMessage, b: AgentMessage) => b.timestamp - a.timestamp);
  }, [messages, filter]);

  const handleMarkRead = async (messageIds: string[]) => {
    try {
      await markAgentMessagesRead(agentId, messageIds);
      refetch();
    } catch (err) {
      console.error('Failed to mark messages as read:', err);
    }
  };

  const handleMarkAllRead = async () => {
    const unreadIds = messages.filter((m: AgentMessage) => !m.read).map((m: AgentMessage) => m.id);
    if (unreadIds.length > 0) {
      try {
        await markAgentMessagesRead(agentId, unreadIds);
        refetch();
      } catch (err) {
        console.error('Failed to mark all as read:', err);
      }
    }
  };

  if (isLoading) {
    return (
      <div className="flex items-center justify-center h-[calc(100vh-220px)]">
        <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
      </div>
    );
  }

  if (error) {
    return (
      <div className="flex items-center justify-center h-[calc(100vh-220px)]">
        <div className="text-center">
          <AlertCircle className="h-8 w-8 mx-auto mb-2 text-red-500" />
          <p className="text-muted-foreground">Failed to load inbox</p>
          <Button variant="outline" size="sm" onClick={() => refetch()} className="mt-2">
            Retry
          </Button>
        </div>
      </div>
    );
  }

  return (
    <div className="h-[calc(100vh-220px)] border rounded-lg overflow-hidden flex flex-col bg-background">
      {/* Header */}
      <div className="p-4 border-b bg-muted/20 flex items-center justify-between">
        <div className="flex items-center gap-2">
          <Mail className="h-5 w-5 text-muted-foreground" />
          <h2 className="text-lg font-semibold">
            Inbox {unreadCount > 0 && <span className="text-sm text-muted-foreground">({unreadCount} unread)</span>}
          </h2>
        </div>
        <div className="flex items-center gap-2">
          {unreadCount > 0 && (
            <Button size="sm" variant="outline" onClick={handleMarkAllRead}>
              Mark All Read
            </Button>
          )}
          <Button size="sm" onClick={() => setComposeOpen(!composeOpen)}>
            {composeOpen ? 'Hide Compose' : 'Compose Message'}
          </Button>
        </div>
      </div>

      {/* Filters */}
      <InboxFilters filter={filter} onFilterChange={setFilter} />

      {/* Messages list */}
      <ScrollArea className="flex-1">
        <div className="p-4 space-y-3">
          {filteredMessages.length === 0 ? (
            <div className="text-center py-12 text-muted-foreground">
              <Mail className="h-12 w-12 mx-auto mb-3 opacity-50" />
              <p className="text-lg font-medium">No messages</p>
              <p className="text-sm">
                {filter !== 'all' ? 'Try changing the filter' : 'Messages from other agents will appear here'}
              </p>
            </div>
          ) : (
            filteredMessages.map((message: AgentMessage) => (
              <InboxMessage
                key={message.id}
                message={message}
                onMarkRead={() => handleMarkRead([message.id])}
              />
            ))
          )}
        </div>
      </ScrollArea>

      {/* Compose panel */}
      {composeOpen && (
        <div className="border-t bg-muted/10">
          <Suspense fallback={<div className="p-4"><Loader2 className="h-6 w-6 animate-spin" /></div>}>
            <ComposeMessage
              agentId={agentId}
              onMessageSent={() => {
                refetch();
                setComposeOpen(false);
              }}
              onCancel={() => setComposeOpen(false)}
            />
          </Suspense>
        </div>
      )}

      {/* Status bar */}
      <InboxStatusBar messageCount={filteredMessages.length} totalCount={messages.length} />
    </div>
  );
}
