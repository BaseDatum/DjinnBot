import { Card, CardHeader, CardTitle, CardContent } from '@/components/ui/card';
import { MessageSquare, User } from 'lucide-react';
import { useEffect, useRef } from 'react';

export interface SlackMessage {
  agentId: string;
  agentName: string;
  agentEmoji: string;
  userId?: string;
  userName?: string;
  message: string;
  isAgent: boolean;
  threadTs: string;
  messageTs: string;
  timestamp: number;
}

interface SlackChatFeedProps {
  messages: SlackMessage[];
}

function formatTimestamp(timestamp: number): string {
  const now = Date.now();
  const diff = now - timestamp;
  
  if (diff < 60000) return 'just now';
  if (diff < 3600000) return `${Math.floor(diff / 60000)}m ago`;
  if (diff < 86400000) return `${Math.floor(diff / 3600000)}h ago`;
  
  const date = new Date(timestamp);
  return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

export function SlackChatFeed({ messages }: SlackChatFeedProps) {
  const scrollRef = useRef<HTMLDivElement>(null);
  
  // Auto-scroll to bottom when new messages arrive
  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [messages]);
  
  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-lg">
          <MessageSquare className="h-4 w-4" />
          Slack Chat
        </CardTitle>
      </CardHeader>
      <CardContent>
        <div 
          ref={scrollRef}
          className="space-y-2 max-h-[250px] md:max-h-[400px] overflow-y-auto pr-2"
        >
          {messages.length === 0 ? (
            <div className="flex flex-col items-center justify-center py-8 text-muted-foreground">
              <MessageSquare className="h-8 w-8 mb-2 opacity-20" />
              <p className="text-sm">No Slack messages yet</p>
            </div>
          ) : (
            messages.map((msg, idx) => (
              <div
                key={`${msg.messageTs}-${idx}`}
                className={`rounded-md p-2.5 text-xs ${
                  msg.isAgent
                    ? 'bg-indigo-500/10 border border-indigo-500/20'
                    : 'bg-amber-500/10 border border-amber-500/20'
                }`}
              >
                <div className="flex items-start gap-2">
                  <div className="flex-shrink-0 mt-0.5">
                    {msg.isAgent ? (
                      <span className="text-base" title={msg.agentName}>
                        {msg.agentEmoji}
                      </span>
                    ) : (
                      <User className="h-3.5 w-3.5 text-amber-600 dark:text-amber-400" />
                    )}
                  </div>
                  <div className="flex-1 min-w-0">
                    <div className="flex items-baseline gap-2 mb-1">
                      <span className={`font-medium ${
                        msg.isAgent ? 'text-indigo-600 dark:text-indigo-300' : 'text-amber-600 dark:text-amber-300'
                      }`}>
                        {msg.isAgent ? msg.agentName : msg.userName || 'User'}
                      </span>
                      <span className="text-[10px] text-muted-foreground">
                        {formatTimestamp(msg.timestamp)}
                      </span>
                    </div>
                    <p className={`whitespace-pre-wrap break-words leading-relaxed ${
                      msg.isAgent ? 'text-foreground' : 'text-foreground/90'
                    }`}>
                      {msg.message}
                    </p>
                  </div>
                </div>
              </div>
            ))
          )}
        </div>
      </CardContent>
    </Card>
  );
}
