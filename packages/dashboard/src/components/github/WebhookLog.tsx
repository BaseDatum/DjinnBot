import { useState, useEffect } from 'react';
import { API_BASE } from '@/lib/api';
import { authFetch } from '@/lib/auth';
import { Card, CardHeader, CardTitle, CardContent } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { RefreshCw, ExternalLink, Loader2 } from 'lucide-react';
import { toast } from 'sonner';

interface WebhookEvent {
  id: string;
  eventType: string;
  eventAction: string;
  issueNumber?: number;
  prNumber?: number;
  agentId?: string;
  agentName?: string;
  status: 'pending' | 'processing' | 'completed' | 'failed';
  error?: string;
  responseUrl?: string;
  timestamp: string;
}

interface WebhookLogProps {
  projectId: string;
}

export function WebhookLog({ projectId }: WebhookLogProps) {
  const [events, setEvents] = useState<WebhookEvent[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    fetchEvents();

    // Set up real-time updates via SSE if the endpoint exists
    // For now, we'll poll periodically as a fallback
    const interval = setInterval(fetchEvents, 10000); // Poll every 10 seconds

    return () => {
      clearInterval(interval);
    };
  }, [projectId]);

  async function fetchEvents() {
    try {
      const response = await authFetch(`${API_BASE}/projects/${projectId}/github/webhook-log?limit=50`);
      if (!response.ok) throw new Error('Failed to fetch webhook events');
      const data = await response.json();
      setEvents(data);
    } catch (error) {
      console.error('Failed to fetch webhook events:', error);
      // Don't show toast on every failed poll
      if (loading) {
        toast.error('Failed to load webhook events');
      }
    } finally {
      setLoading(false);
    }
  }

  function getStatusColor(status: string): string {
    switch (status) {
      case 'completed':
        return 'bg-green-500';
      case 'failed':
        return 'bg-red-500';
      case 'processing':
        return 'bg-blue-500';
      case 'pending':
        return 'bg-yellow-500';
      default:
        return 'bg-gray-500';
    }
  }

  function getStatusBadgeVariant(status: string): 'default' | 'secondary' | 'destructive' | 'outline' {
    switch (status) {
      case 'completed':
        return 'default';
      case 'failed':
        return 'destructive';
      case 'processing':
        return 'secondary';
      default:
        return 'outline';
    }
  }

  function formatTimestamp(timestamp: string): string {
    const date = new Date(timestamp);
    const now = new Date();
    const diffMs = now.getTime() - date.getTime();
    const diffSec = Math.floor(diffMs / 1000);
    const diffMin = Math.floor(diffSec / 60);
    const diffHour = Math.floor(diffMin / 60);
    const diffDay = Math.floor(diffHour / 24);

    if (diffDay > 0) return `${diffDay}d ago`;
    if (diffHour > 0) return `${diffHour}h ago`;
    if (diffMin > 0) return `${diffMin}m ago`;
    if (diffSec > 0) return `${diffSec}s ago`;
    return 'just now';
  }

  return (
    <Card>
      <CardHeader>
        <div className="flex items-center justify-between">
          <CardTitle>Webhook Activity</CardTitle>
          <Button variant="outline" size="sm" onClick={fetchEvents}>
            <RefreshCw className="h-4 w-4 mr-2" />
            Refresh
          </Button>
        </div>
      </CardHeader>
      <CardContent>
        {loading ? (
          <div className="flex items-center justify-center p-8">
            <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
          </div>
        ) : events.length === 0 ? (
          <div className="text-center py-8 text-muted-foreground">
            No webhook events received yet
          </div>
        ) : (
          <div className="space-y-3">
            {events.map((event) => (
              <div
                key={event.id}
                className="flex items-start gap-3 p-3 border rounded-lg hover:bg-muted/50 transition-colors"
              >
                {/* Status indicator dot */}
                <div 
                  className={`w-2 h-2 rounded-full mt-2 flex-shrink-0 ${getStatusColor(event.status)}`}
                  title={event.status}
                />
                
                {/* Event details */}
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2 flex-wrap">
                    <span className="font-medium">
                      {event.eventType}
                    </span>
                    {event.eventAction && (
                      <span className="text-sm text-muted-foreground">
                        · {event.eventAction}
                      </span>
                    )}
                    {event.issueNumber && (
                      <Badge variant="outline">#{event.issueNumber}</Badge>
                    )}
                    {event.prNumber && (
                      <Badge variant="outline">PR #{event.prNumber}</Badge>
                    )}
                    <Badge variant={getStatusBadgeVariant(event.status)}>
                      {event.status}
                    </Badge>
                  </div>
                  
                  {event.agentName && (
                    <div className="text-sm text-muted-foreground mt-1">
                      Handled by <Badge variant="secondary" className="text-xs">{event.agentName}</Badge>
                    </div>
                  )}
                  
                  {event.error && (
                    <div className="text-sm text-red-600 mt-1 truncate" title={event.error}>
                      Error: {event.error}
                    </div>
                  )}
                  
                  <div className="text-xs text-muted-foreground mt-1">
                    {formatTimestamp(event.timestamp)}
                  </div>
                </div>

                {/* Action button */}
                {event.responseUrl && (
                  <Button 
                    variant="ghost" 
                    size="sm" 
                    asChild
                    className="flex-shrink-0"
                  >
                    <a 
                      href={event.responseUrl} 
                      target="_blank" 
                      rel="noopener noreferrer"
                      title="View on GitHub"
                    >
                      <ExternalLink className="h-4 w-4" />
                    </a>
                  </Button>
                )}
              </div>
            ))}
          </div>
        )}
      </CardContent>
    </Card>
  );
}
