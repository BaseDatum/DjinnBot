import { TimelineEvent, isWorkEvent, isSlackEvent, isPulseEvent, isSystemEvent } from './event-types.js';

// ─────────────────────────────────────────────────────────────
// Aggregated Timeline Item Types
// ─────────────────────────────────────────────────────────────

export type AggregatedItemType = 'run' | 'slack_conversation' | 'pulse' | 'system' | 'inbox';

export interface AggregatedTimelineItem {
  id: string;
  type: AggregatedItemType;
  startTime: number;
  endTime?: number;
  summary: string;
  events: TimelineEvent[];
  expandable: boolean;
  metadata?: Record<string, any>;
}

// ─────────────────────────────────────────────────────────────
// Aggregation Logic
// ─────────────────────────────────────────────────────────────

export function aggregateTimeline(events: TimelineEvent[]): AggregatedTimelineItem[] {
  const items: AggregatedTimelineItem[] = [];

  // Create grouping maps
  const workGroups = new Map<string, TimelineEvent[]>();
  const slackThreads = new Map<string, TimelineEvent[]>();
  const pulseGroups: TimelineEvent[][] = [];
  let currentPulseGroup: TimelineEvent[] | null = null;

  // Group events
  for (const event of events) {
    if (isWorkEvent(event)) {
      // Group work events by runId+stepId
      const runId = (event.data as any).runId;
      const stepId = (event.data as any).stepId;
      const key = `${runId}_${stepId}`;

      if (!workGroups.has(key)) {
        workGroups.set(key, []);
      }
      workGroups.get(key)!.push(event);
    } else if (isSlackEvent(event)) {
      // Group Slack messages by thread
      const threadTs = (event.data as any).threadTs || 'default';
      if (!slackThreads.has(threadTs)) {
        slackThreads.set(threadTs, []);
      }
      slackThreads.get(threadTs)!.push(event);
    } else if (isPulseEvent(event)) {
      // Group pulse events together
      if (event.type === 'pulse_started') {
        // Start a new pulse group
        if (currentPulseGroup && currentPulseGroup.length > 0) {
          pulseGroups.push(currentPulseGroup);
        }
        currentPulseGroup = [event];
      } else if (currentPulseGroup) {
        currentPulseGroup.push(event);
        if (event.type === 'pulse_complete') {
          // End the pulse group
          pulseGroups.push(currentPulseGroup);
          currentPulseGroup = null;
        }
      } else {
        // Orphaned pulse event (no pulse_started) - create a single-event group
        pulseGroups.push([event]);
      }
    } else if (isSystemEvent(event)) {
      // System events are standalone (not grouped)
      items.push({
        id: event.id,
        type: 'system',
        startTime: event.timestamp,
        summary: generateSystemEventSummary(event),
        events: [event],
        expandable: false,
      });
    }
  }

  // Flush any remaining pulse group
  if (currentPulseGroup && currentPulseGroup.length > 0) {
    pulseGroups.push(currentPulseGroup);
  }

  // Convert work groups to items
  for (const [key, groupEvents] of workGroups) {
    const sortedEvents = groupEvents.sort((a, b) => a.timestamp - b.timestamp);
    const startEvent = sortedEvents.find(e => e.type === 'work_started');
    const completeEvent = sortedEvents.find(e => e.type === 'work_complete' || e.type === 'work_failed');

    items.push({
      id: key,
      type: 'run',
      startTime: startEvent?.timestamp || sortedEvents[0].timestamp,
      endTime: completeEvent?.timestamp,
      summary: generateWorkSummary(sortedEvents),
      events: sortedEvents,
      expandable: true,
      metadata: {
        runId: (startEvent?.data as any)?.runId,
        stepId: (startEvent?.data as any)?.stepId,
        stepType: (startEvent?.data as any)?.stepType,
        status: completeEvent?.type === 'work_complete' ? 'complete' : completeEvent?.type === 'work_failed' ? 'failed' : 'running',
      },
    });
  }

  // Convert Slack threads to items
  for (const [threadTs, threadEvents] of slackThreads) {
    const sortedEvents = threadEvents.sort((a, b) => a.timestamp - b.timestamp);
    const firstEvent = sortedEvents[0];
    const lastEvent = sortedEvents[sortedEvents.length - 1];

    items.push({
      id: `slack_${threadTs}`,
      type: 'slack_conversation',
      startTime: firstEvent.timestamp,
      endTime: lastEvent.timestamp,
      summary: generateSlackSummary(sortedEvents),
      events: sortedEvents,
      expandable: true,
      metadata: {
        threadTs,
        messageCount: sortedEvents.length,
        channel: (firstEvent.data as any).channel,
      },
    });
  }

  // Convert pulse groups to items
  for (const pulseEvents of pulseGroups) {
    const sortedEvents = pulseEvents.sort((a, b) => a.timestamp - b.timestamp);
    const startEvent = sortedEvents.find(e => e.type === 'pulse_started');
    const completeEvent = sortedEvents.find(e => e.type === 'pulse_complete');

    items.push({
      id: `pulse_${startEvent?.timestamp || sortedEvents[0].timestamp}`,
      type: 'pulse',
      startTime: startEvent?.timestamp || sortedEvents[0].timestamp,
      endTime: completeEvent?.timestamp,
      summary: generatePulseSummary(sortedEvents),
      events: sortedEvents,
      expandable: true,
      metadata: {
        checksCompleted: (completeEvent?.data as any)?.checksCompleted,
        checksFailed: (completeEvent?.data as any)?.checksFailed,
      },
    });
  }

  // Sort all items by start time (newest first)
  return items.sort((a, b) => b.startTime - a.startTime);
}

// ─────────────────────────────────────────────────────────────
// Summary Generation Helpers
// ─────────────────────────────────────────────────────────────

function generateWorkSummary(events: TimelineEvent[]): string {
  const startEvent = events.find(e => e.type === 'work_started');
  const completeEvent = events.find(e => e.type === 'work_complete' || e.type === 'work_failed');

  if (!startEvent) {
    return 'Work step (unknown)';
  }

  const stepType = (startEvent.data as any).stepType || 'unknown';
  const runId = (startEvent.data as any).runId || 'unknown';
  const stepId = (startEvent.data as any).stepId || 'unknown';

  if (completeEvent?.type === 'work_complete') {
    const toolCalls = events.filter(e => e.type === 'work_tool_call').length;
    const toolSuffix = toolCalls > 0 ? ` (${toolCalls} tool call${toolCalls === 1 ? '' : 's'})` : '';
    return `${stepType} step completed${toolSuffix}`;
  } else if (completeEvent?.type === 'work_failed') {
    return `${stepType} step failed`;
  } else {
    return `${stepType} step in progress...`;
  }
}

function generateSlackSummary(events: TimelineEvent[]): string {
  const channel = (events[0].data as any).channel || 'unknown';
  const messageCount = events.length;
  const sentCount = events.filter(e => e.type === 'slack_message_sent').length;
  const receivedCount = events.filter(e => e.type === 'slack_message_received').length;

  if (sentCount > 0 && receivedCount > 0) {
    return `Slack conversation in #${channel} (${messageCount} messages)`;
  } else if (sentCount > 0) {
    return `Sent ${sentCount} message${sentCount === 1 ? '' : 's'} to #${channel}`;
  } else {
    return `Received ${receivedCount} message${receivedCount === 1 ? '' : 's'} from #${channel}`;
  }
}

function generatePulseSummary(events: TimelineEvent[]): string {
  const completeEvent = events.find(e => e.type === 'pulse_complete');

  if (completeEvent) {
    const summary = (completeEvent.data as any).summary || 'Pulse completed';
    const checksCompleted = (completeEvent.data as any).checksCompleted || 0;
    const checksFailed = (completeEvent.data as any).checksFailed || 0;

    if (checksFailed > 0) {
      return `Pulse: ${summary} (${checksFailed} failed)`;
    } else {
      return `Pulse: ${summary} (${checksCompleted} checks)`;
    }
  } else {
    return 'Pulse in progress...';
  }
}

function generateSystemEventSummary(event: TimelineEvent): string {
  switch (event.type) {
    case 'state_change':
      const newState = (event.data as any).newState;
      return `State changed to ${newState}`;

    case 'tool_install':
      const toolName = (event.data as any).toolName;
      const success = (event.data as any).success;
      return success ? `Installed ${toolName}` : `Failed to install ${toolName}`;

    case 'sandbox_reset':
      return 'Sandbox reset';

    case 'error':
      const message = (event.data as any).message || 'Unknown error';
      return `Error: ${message}`;

    default:
      return event.type;
  }
}

// ─────────────────────────────────────────────────────────────
// Utility Functions
// ─────────────────────────────────────────────────────────────

/**
 * Get all events of a specific type from an aggregated item
 */
export function getEventsOfType(item: AggregatedTimelineItem, type: string): TimelineEvent[] {
  return item.events.filter(e => e.type === type);
}

/**
 * Calculate duration of an aggregated item in milliseconds
 */
export function getItemDuration(item: AggregatedTimelineItem): number | null {
  if (!item.endTime) return null;
  return item.endTime - item.startTime;
}

/**
 * Get the status of a run item
 */
export function getRunStatus(item: AggregatedTimelineItem): 'running' | 'complete' | 'failed' | 'unknown' {
  if (item.type !== 'run') return 'unknown';
  return (item.metadata?.status as any) || 'unknown';
}
