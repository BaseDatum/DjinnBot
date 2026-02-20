import { useState } from 'react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { ScrollArea } from '@/components/ui/scroll-area';
import { 
  ChevronDown, 
  ChevronRight, 
  Activity, 
  Wrench, 
  Terminal, 
  MessageSquare,
  CheckCircle,
  XCircle,
  Clock,
  Circle
} from 'lucide-react';
import type { ContainerEvent, ContainerEventDisplay } from '@/types/container';

interface ContainerEventStreamProps {
  events: ContainerEvent[];
  maxHeight?: string;
}

function formatEventForDisplay(event: ContainerEvent): ContainerEventDisplay {
  const baseId = `${event.type}-${event.timestamp}`;
  
  switch (event.type) {
    case 'ready':
    case 'busy':
    case 'idle':
    case 'error':
    case 'exiting':
      return {
        id: baseId,
        timestamp: event.timestamp,
        category: 'status',
        label: `Container ${event.type}`,
        description: event.message || `Container transitioned to ${event.type} state`,
        variant: event.type === 'error' ? 'error' : event.type === 'ready' ? 'success' : 'default',
        data: { runId: event.runId, code: event.code },
      };
    
    case 'stepStart':
      return {
        id: baseId,
        timestamp: event.timestamp,
        category: 'step',
        label: `Step ${event.stepNumber} started`,
        description: `Request: ${event.requestId.substring(0, 8)}`,
        variant: 'info',
        data: event,
      };
    
    case 'stepEnd':
      return {
        id: baseId,
        timestamp: event.timestamp,
        category: 'step',
        label: `Step ${event.stepNumber} ${event.success ? 'completed' : 'failed'}`,
        description: event.result || '',
        variant: event.success ? 'success' : 'error',
        data: event,
      };
    
    case 'toolStart':
      return {
        id: baseId,
        timestamp: event.timestamp,
        category: 'tool',
        label: `Tool: ${event.toolName}`,
        description: 'Starting...',
        variant: 'default',
        data: event,
      };
    
    case 'toolEnd':
      return {
        id: baseId,
        timestamp: event.timestamp,
        category: 'tool',
        label: `Tool: ${event.toolName}`,
        description: `${event.success ? 'Completed' : 'Failed'}${event.durationMs ? ` in ${event.durationMs}ms` : ''}`,
        variant: event.success ? 'success' : 'error',
        data: event,
      };
    
    case 'stdout':
      return {
        id: baseId,
        timestamp: event.timestamp,
        category: 'output',
        label: 'stdout',
        description: event.data,
        variant: 'default',
        data: event,
      };
    
    case 'stderr':
      return {
        id: baseId,
        timestamp: event.timestamp,
        category: 'output',
        label: 'stderr',
        description: event.data,
        variant: 'warning',
        data: event,
      };
    
    case 'agentMessage':
      return {
        id: baseId,
        timestamp: event.timestamp,
        category: 'message',
        label: `Message to ${event.to}`,
        description: event.message,
        variant: event.priority === 'urgent' ? 'error' : 'info',
        data: event,
      };
    
    case 'slackDm':
      return {
        id: baseId,
        timestamp: event.timestamp,
        category: 'message',
        label: 'Slack DM',
        description: event.message,
        variant: event.urgent ? 'warning' : 'info',
        data: event,
      };
    
    default:
      return {
        id: baseId,
        timestamp: event.timestamp,
        category: 'output',
        label: 'Unknown event',
        description: JSON.stringify(event),
        variant: 'default',
      };
  }
}

function EventItem({ event }: { event: ContainerEventDisplay }) {
  const [expanded, setExpanded] = useState(false);
  
  const categoryIcons = {
    status: Activity,
    step: Circle,
    tool: Wrench,
    output: Terminal,
    message: MessageSquare,
  };
  
  const variantStyles = {
    default: 'border-zinc-700 bg-zinc-800/30',
    success: 'border-emerald-500/30 bg-emerald-500/5',
    error: 'border-red-500/30 bg-red-500/5',
    warning: 'border-orange-500/30 bg-orange-500/5',
    info: 'border-blue-500/30 bg-blue-500/5',
  };
  
  const Icon = categoryIcons[event.category];
  const hasDetails = event.data && Object.keys(event.data).length > 0;
  
  return (
    <div className={`p-2 rounded-md border ${variantStyles[event.variant]} mb-2`}>
      <div className="flex items-start gap-2">
        <div className="flex items-center gap-1.5 min-w-0 flex-1">
          <Icon className="h-3.5 w-3.5 flex-shrink-0 text-muted-foreground" />
          <span className="text-xs font-medium truncate">{event.label}</span>
          <span className="text-xs text-muted-foreground ml-auto flex-shrink-0">
            {new Date(event.timestamp).toLocaleTimeString()}
          </span>
        </div>
        {hasDetails && (
          <button
            onClick={() => setExpanded(!expanded)}
            className="text-muted-foreground hover:text-foreground transition-colors"
          >
            {expanded ? (
              <ChevronDown className="h-3.5 w-3.5" />
            ) : (
              <ChevronRight className="h-3.5 w-3.5" />
            )}
          </button>
        )}
      </div>
      
      <p className="text-xs text-muted-foreground mt-1 pl-5 whitespace-pre-wrap break-words">
        {event.description}
      </p>
      
      {expanded && hasDetails && (
        <div className="mt-2 pl-5 text-xs">
          <pre className="bg-black/20 p-2 rounded text-xs overflow-x-auto">
            {JSON.stringify(event.data, null, 2)}
          </pre>
        </div>
      )}
    </div>
  );
}

export function ContainerEventStream({ events, maxHeight = '400px' }: ContainerEventStreamProps) {
  const displayEvents = events.map(formatEventForDisplay);
  
  // Group by category for stats
  const stats = displayEvents.reduce((acc, event) => {
    acc[event.category] = (acc[event.category] || 0) + 1;
    return acc;
  }, {} as Record<string, number>);
  
  return (
    <Card className="flex flex-col">
      <CardHeader className="pb-3">
        <div className="flex items-center justify-between">
          <CardTitle className="text-sm">Container Events</CardTitle>
          <div className="flex items-center gap-2">
            {Object.entries(stats).map(([category, count]) => (
              <Badge key={category} variant="secondary" className="text-xs">
                {category}: {count}
              </Badge>
            ))}
          </div>
        </div>
      </CardHeader>
      <CardContent className="flex-1 min-h-0 p-0">
        <ScrollArea style={{ height: maxHeight }}>
          <div className="p-4">
            {displayEvents.length > 0 ? (
              displayEvents.map((event) => (
                <EventItem key={event.id} event={event} />
              ))
            ) : (
              <div className="flex flex-col items-center justify-center py-12 text-center">
                <Activity className="h-12 w-12 text-muted-foreground/30 mb-3" />
                <p className="text-sm text-muted-foreground">No container events yet</p>
                <p className="text-xs text-muted-foreground mt-1">
                  Events will appear here as the container processes requests
                </p>
              </div>
            )}
          </div>
        </ScrollArea>
      </CardContent>
    </Card>
  );
}

// Compact version for sidebar or header
export function ContainerEventSummary({ events }: { events: ContainerEvent[] }) {
  const recent = events.slice(-5);
  const displayEvents = recent.map(formatEventForDisplay);
  
  return (
    <div className="space-y-1">
      {displayEvents.map((event) => {
        const Icon = event.category === 'status' ? Activity :
                     event.category === 'step' ? Circle :
                     event.category === 'tool' ? Wrench :
                     event.category === 'output' ? Terminal : MessageSquare;
        
        return (
          <div key={event.id} className="flex items-center gap-2 text-xs">
            <Icon className="h-3 w-3 text-muted-foreground" />
            <span className="truncate flex-1">{event.label}</span>
            <span className="text-muted-foreground">
              {new Date(event.timestamp).toLocaleTimeString()}
            </span>
          </div>
        );
      })}
    </div>
  );
}
