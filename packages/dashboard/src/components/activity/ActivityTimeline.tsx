import { useMemo, useState } from 'react';
import { TimelineEvent, AggregatedTimelineItem } from '@/types/lifecycle';
import { ChevronDown, Play, MessageSquare, Zap, AlertCircle } from 'lucide-react';
import { cn } from '@/lib/utils';
import { format } from 'date-fns';
import { ExpandedTimelineItem } from './ExpandedTimelineItem';

interface ActivityTimelineProps {
  timeline: TimelineEvent[];
}

// Aggregation function (client-side version)
function aggregateTimeline(events: TimelineEvent[]): AggregatedTimelineItem[] {
  const items: AggregatedTimelineItem[] = [];
  const workGroups = new Map<string, TimelineEvent[]>();
  const slackThreads = new Map<string, TimelineEvent[]>();
  const pulseGroups: TimelineEvent[][] = [];
  let currentPulseGroup: TimelineEvent[] | null = null;

  // Group events
  for (const event of events) {
    if (event.type.startsWith('work_')) {
      const runId = (event.data as any).runId;
      const stepId = (event.data as any).stepId;
      const key = `${runId}_${stepId}`;

      if (!workGroups.has(key)) {
        workGroups.set(key, []);
      }
      workGroups.get(key)!.push(event);
    } else if (event.type.startsWith('slack_')) {
      const threadTs = (event.data as any).threadTs || 'default';
      if (!slackThreads.has(threadTs)) {
        slackThreads.set(threadTs, []);
      }
      slackThreads.get(threadTs)!.push(event);
    } else if (event.type.startsWith('pulse_')) {
      if (event.type === 'pulse_started') {
        if (currentPulseGroup && currentPulseGroup.length > 0) {
          pulseGroups.push(currentPulseGroup);
        }
        currentPulseGroup = [event];
      } else if (currentPulseGroup) {
        currentPulseGroup.push(event);
        if (event.type === 'pulse_complete') {
          pulseGroups.push(currentPulseGroup);
          currentPulseGroup = null;
        }
      } else {
        pulseGroups.push([event]);
      }
    } else {
      // System events
      items.push({
        id: event.id,
        type: 'system',
        startTime: event.timestamp,
        summary: generateSystemSummary(event),
        events: [event],
        expandable: false,
      });
    }
  }

  if (currentPulseGroup && currentPulseGroup.length > 0) {
    pulseGroups.push(currentPulseGroup);
  }

  // Convert work groups to items
  for (const [key, groupEvents] of workGroups) {
    const sorted = groupEvents.sort((a, b) => a.timestamp - b.timestamp);
    const start = sorted.find(e => e.type === 'work_started');
    const complete = sorted.find(e => e.type === 'work_complete' || e.type === 'work_failed');

    items.push({
      id: key,
      type: 'run',
      startTime: start?.timestamp || sorted[0].timestamp,
      endTime: complete?.timestamp,
      summary: generateWorkSummary(sorted),
      events: sorted,
      expandable: true,
      metadata: {
        runId: (start?.data as any)?.runId,
        stepId: (start?.data as any)?.stepId,
        status: complete?.type === 'work_complete' ? 'complete' : complete?.type === 'work_failed' ? 'failed' : 'running',
      },
    });
  }

  // Convert Slack threads to items
  for (const [threadTs, threadEvents] of slackThreads) {
    const sorted = threadEvents.sort((a, b) => a.timestamp - b.timestamp);
    items.push({
      id: `slack_${threadTs}`,
      type: 'slack_conversation',
      startTime: sorted[0].timestamp,
      endTime: sorted[sorted.length - 1].timestamp,
      summary: generateSlackSummary(sorted),
      events: sorted,
      expandable: true,
      metadata: { threadTs, messageCount: sorted.length },
    });
  }

  // Convert pulse groups to items
  for (const pulseEvents of pulseGroups) {
    const sorted = pulseEvents.sort((a, b) => a.timestamp - b.timestamp);
    const complete = sorted.find(e => e.type === 'pulse_complete');
    items.push({
      id: `pulse_${sorted[0].timestamp}`,
      type: 'pulse',
      startTime: sorted[0].timestamp,
      endTime: complete?.timestamp,
      summary: generatePulseSummary(sorted),
      events: sorted,
      expandable: true,
      metadata: {
        checksCompleted: (complete?.data as any)?.checksCompleted,
      },
    });
  }

  return items.sort((a, b) => b.startTime - a.startTime);
}

function generateWorkSummary(events: TimelineEvent[]): string {
  const start = events.find(e => e.type === 'work_started');
  const complete = events.find(e => e.type === 'work_complete' || e.type === 'work_failed');
  const stepType = (start?.data as any)?.stepType || 'unknown';
  
  if (complete?.type === 'work_complete') {
    const toolCalls = events.filter(e => e.type === 'work_tool_call').length;
    return `${stepType} step completed${toolCalls > 0 ? ` (${toolCalls} tool call${toolCalls === 1 ? '' : 's'})` : ''}`;
  } else if (complete?.type === 'work_failed') {
    return `${stepType} step failed`;
  }
  return `${stepType} step in progress...`;
}

function generateSlackSummary(events: TimelineEvent[]): string {
  const channel = (events[0].data as any).channel || 'unknown';
  const count = events.length;
  return `Slack conversation in #${channel} (${count} message${count === 1 ? '' : 's'})`;
}

function generatePulseSummary(events: TimelineEvent[]): string {
  const complete = events.find(e => e.type === 'pulse_complete');
  if (complete) {
    const summary = (complete.data as any).summary || 'Pulse completed';
    const checks = (complete.data as any).checksCompleted || 0;
    return `Pulse: ${summary} (${checks} checks)`;
  }
  return 'Pulse in progress...';
}

function generateSystemSummary(event: TimelineEvent): string {
  switch (event.type) {
    case 'state_change':
      return `State changed to ${(event.data as any).newState}`;
    case 'tool_install':
      return `Installed ${(event.data as any).toolName}`;
    case 'sandbox_reset':
      return 'Sandbox reset';
    case 'error':
      return `Error: ${(event.data as any).message}`;
    default:
      return event.type;
  }
}

function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`;
  return `${(ms / 60000).toFixed(1)}m`;
}

export function ActivityTimeline({ timeline }: ActivityTimelineProps) {
  const aggregated = useMemo(() => aggregateTimeline(timeline), [timeline]);

  if (!timeline || timeline.length === 0) {
    return (
      <div className="p-8 text-center text-muted-foreground">
        <p>No activity recorded yet</p>
      </div>
    );
  }

  return (
    <div className="p-4 space-y-3">
      {aggregated.map(item => (
        <TimelineItemCard key={item.id} item={item} />
      ))}
    </div>
  );
}

interface TimelineItemCardProps {
  item: AggregatedTimelineItem;
}

function TimelineItemCard({ item }: TimelineItemCardProps) {
  const [expanded, setExpanded] = useState(false);

  const Icon = getItemIcon(item.type);
  const color = getItemColor(item.type, item.metadata?.status);
  const duration = item.endTime ? item.endTime - item.startTime : null;

  return (
    <div className="border rounded-lg overflow-hidden bg-card">
      {/* Header */}
      <button
        onClick={() => item.expandable && setExpanded(!expanded)}
        disabled={!item.expandable}
        className={cn(
          "w-full flex items-center justify-between p-3",
          item.expandable && "hover:bg-muted/50 cursor-pointer"
        )}
      >
        <div className="flex items-center gap-3">
          <div className={cn("p-1.5 rounded", color.bg)}>
            <Icon className={cn("h-4 w-4", color.text)} />
          </div>
          <div className="flex flex-col items-start">
            <span className="font-medium text-sm">{item.summary}</span>
            {item.metadata?.runId && (
              <span className="text-xs text-muted-foreground">
                {item.metadata.runId.slice(0, 8)}...
              </span>
            )}
          </div>
        </div>

        <div className="flex items-center gap-3 text-xs text-muted-foreground">
          <span>{format(item.startTime, 'HH:mm:ss')}</span>
          {duration && <span className="text-green-600">({formatDuration(duration)})</span>}
          {item.expandable && (
            <ChevronDown
              className={cn("h-4 w-4 transition-transform", expanded && "rotate-180")}
            />
          )}
        </div>
      </button>

      {/* Expanded content */}
      {expanded && item.expandable && (
        <div className="border-t bg-muted/20">
          <ExpandedTimelineItem item={item} />
        </div>
      )}
    </div>
  );
}

function getItemIcon(type: AggregatedTimelineItem['type']) {
  switch (type) {
    case 'run':
      return Play;
    case 'slack_conversation':
      return MessageSquare;
    case 'pulse':
      return Zap;
    default:
      return AlertCircle;
  }
}

function getItemColor(type: AggregatedTimelineItem['type'], status?: string) {
  if (type === 'run') {
    if (status === 'complete') {
      return { bg: 'bg-green-100 dark:bg-green-900/30', text: 'text-green-600 dark:text-green-400' };
    } else if (status === 'failed') {
      return { bg: 'bg-red-100 dark:bg-red-900/30', text: 'text-red-600 dark:text-red-400' };
    } else {
      return { bg: 'bg-blue-100 dark:bg-blue-900/30', text: 'text-blue-600 dark:text-blue-400' };
    }
  }

  switch (type) {
    case 'slack_conversation':
      return { bg: 'bg-purple-100 dark:bg-purple-900/30', text: 'text-purple-600 dark:text-purple-400' };
    case 'pulse':
      return { bg: 'bg-green-100 dark:bg-green-900/30', text: 'text-green-600 dark:text-green-400' };
    default:
      return { bg: 'bg-gray-100 dark:bg-gray-900/30', text: 'text-gray-600 dark:text-gray-400' };
  }
}
