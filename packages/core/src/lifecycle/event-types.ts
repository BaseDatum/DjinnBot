// ─────────────────────────────────────────────────────────────
// Enhanced Timeline Event Types
// ─────────────────────────────────────────────────────────────

export type TimelineEventType =
  // Work events
  | 'work_started'
  | 'work_output'      // Streaming output chunk
  | 'work_thinking'    // Thinking block
  | 'work_tool_call'   // Tool invocation
  | 'work_complete'
  | 'work_failed'
  
  // Communication events
  | 'slack_message_sent'
  | 'slack_message_received'
  | 'inbox_message_received'
  | 'inbox_message_sent'
  
  // Pulse events
  | 'pulse_started'
  | 'pulse_check_complete'
  | 'pulse_complete'
  
  // System events
  | 'state_change'
  | 'tool_install'
  | 'sandbox_reset'
  | 'error';

// ─────────────────────────────────────────────────────────────
// Work Event Schemas
// ─────────────────────────────────────────────────────────────

export interface WorkStartedEvent {
  type: 'work_started';
  data: {
    runId: string;
    stepId: string;
    stepType: string;
    pipelineId: string;
    input?: string;          // Step input (truncated if large)
  };
}

export interface WorkOutputEvent {
  type: 'work_output';
  data: {
    runId: string;
    stepId: string;
    chunk: string;           // Output text chunk
    totalLength: number;     // Running total
  };
}

export interface WorkThinkingEvent {
  type: 'work_thinking';
  data: {
    runId: string;
    stepId: string;
    thinking: string;        // Thinking content
  };
}

export interface WorkToolCallEvent {
  type: 'work_tool_call';
  data: {
    runId: string;
    stepId: string;
    tool: string;            // Tool name
    args: Record<string, any>;
    result?: any;            // Tool result
    error?: string;
    durationMs: number;
  };
}

export interface WorkCompleteEvent {
  type: 'work_complete';
  data: {
    runId: string;
    stepId: string;
    outputs: Record<string, string>;
    durationMs: number;
    tokensUsed?: number;
    cost?: number;
  };
}

export interface WorkFailedEvent {
  type: 'work_failed';
  data: {
    runId: string;
    stepId: string;
    error: string;
    durationMs?: number;
  };
}

// ─────────────────────────────────────────────────────────────
// Communication Event Schemas
// ─────────────────────────────────────────────────────────────

export interface SlackMessageSentEvent {
  type: 'slack_message_sent';
  data: {
    threadTs: string;
    channel: string;
    message: string;
    runId?: string;          // If related to a run
  };
}

export interface SlackMessageReceivedEvent {
  type: 'slack_message_received';
  data: {
    threadTs: string;
    channel: string;
    message: string;
    userName?: string;
    userId?: string;
  };
}

export interface InboxMessageReceivedEvent {
  type: 'inbox_message_received';
  data: {
    from: string;
    subject?: string;
    preview: string;
    messageId: string;
  };
}

export interface InboxMessageSentEvent {
  type: 'inbox_message_sent';
  data: {
    to: string;
    subject?: string;
    preview: string;
    messageId: string;
  };
}

// ─────────────────────────────────────────────────────────────
// Pulse Event Schemas
// ─────────────────────────────────────────────────────────────

export interface PulseStartedEvent {
  type: 'pulse_started';
  data: {
    // Intentionally minimal - just marks pulse start
  };
}

export interface PulseCheckCompleteEvent {
  type: 'pulse_check_complete';
  data: {
    checkName: string;
    status: 'pass' | 'fail' | 'skip';
    details?: string;
  };
}

export interface PulseCompleteEvent {
  type: 'pulse_complete';
  data: {
    durationMs: number;
    checksCompleted: number;
    checksFailed: number;
    summary: string;
    checks: {
      name: string;
      status: 'pass' | 'fail' | 'skip';
      details?: string;
    }[];
    taskStarted?: {
      projectId: string;
      taskId: string;
      taskTitle: string;
    };
  };
}

// ─────────────────────────────────────────────────────────────
// System Event Schemas
// ─────────────────────────────────────────────────────────────

export interface StateChangeEvent {
  type: 'state_change';
  data: {
    newState: 'idle' | 'thinking' | 'working';
    previousState?: 'idle' | 'thinking' | 'working';
    work?: {
      runId: string;
      stepId: string;
      stepType: string;
    };
  };
}

export interface ToolInstallEvent {
  type: 'tool_install';
  data: {
    toolName: string;
    version?: string;
    success: boolean;
  };
}

export interface SandboxResetEvent {
  type: 'sandbox_reset';
  data: {
    reason?: string;
  };
}

export interface ErrorEvent {
  type: 'error';
  data: {
    message: string;
    context?: Record<string, any>;
    stack?: string;
  };
}

// ─────────────────────────────────────────────────────────────
// Union Type
// ─────────────────────────────────────────────────────────────

export type DetailedTimelineEvent =
  | WorkStartedEvent
  | WorkOutputEvent
  | WorkThinkingEvent
  | WorkToolCallEvent
  | WorkCompleteEvent
  | WorkFailedEvent
  | SlackMessageSentEvent
  | SlackMessageReceivedEvent
  | InboxMessageReceivedEvent
  | InboxMessageSentEvent
  | PulseStartedEvent
  | PulseCheckCompleteEvent
  | PulseCompleteEvent
  | StateChangeEvent
  | ToolInstallEvent
  | SandboxResetEvent
  | ErrorEvent;

// ─────────────────────────────────────────────────────────────
// Base Timeline Event with ID and Timestamp
// ─────────────────────────────────────────────────────────────

export interface TimelineEvent {
  id: string;
  timestamp: number;
  type: TimelineEventType;
  data: Record<string, any>;
}

// ─────────────────────────────────────────────────────────────
// Helper type guard functions
// ─────────────────────────────────────────────────────────────

export function isWorkEvent(event: TimelineEvent): boolean {
  return event.type.startsWith('work_');
}

export function isSlackEvent(event: TimelineEvent): boolean {
  return event.type.startsWith('slack_');
}

export function isPulseEvent(event: TimelineEvent): boolean {
  return event.type.startsWith('pulse_');
}

export function isSystemEvent(event: TimelineEvent): boolean {
  return ['state_change', 'tool_install', 'sandbox_reset', 'error'].includes(event.type);
}
