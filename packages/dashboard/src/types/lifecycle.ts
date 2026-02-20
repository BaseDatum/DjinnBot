export type AgentState = 'idle' | 'working' | 'thinking';

export interface WorkInfo {
  runId: string;
  stepId: string;
  stepType: string;
  startedAt: number;
}

export interface AgentLifecycle {
  state: AgentState;
  currentWork?: WorkInfo;
  queueLength: number;
  lastActivity: number;
}

export interface PulseStatus {
  enabled: boolean;
  intervalMs: number;
  lastPulse: number | null;
  nextPulse: number | null;
}

export interface LifecycleData {
  state: AgentState;
  lastActive: number | null;
  queueDepth: number;
  currentWork: WorkInfo | null;
  pulse: PulseStatus;
}

export interface TimelineEventData {
  id: string;
  timestamp: number;
  type: 'state_change' | 'message' | 'pulse' | 'tool_install' | 'sandbox_reset' | 'work_queued' | 'work_dequeued';
  data: Record<string, any>;
}

export interface ResourceUsage {
  memory: { used: number; limit: number; unit: 'MB' | 'GB'; peak24h: number };
  cpu: { used: number; cores: number; peak24h: number };
  pids: { count: number; limit: number; peak24h: number };
}

// LifecycleResponse matches the API response shape
export interface LifecycleResponse {
  state: AgentState;
  lastActive: number | null;
  queueDepth: number;
  currentWork: {
    runId: string;
    step: string;
    startedAt: number;
  } | null;
  pulse: {
    enabled: boolean;
    lastPulse: number | null;
    nextPulse: number | null;
    intervalMs: number;
  };
}

export type TimelineEventType =
  // Work events
  | 'work_started'
  | 'work_output'
  | 'work_thinking'
  | 'work_tool_call'
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
  // System events (legacy compatibility)
  | 'state_change'
  | 'message'
  | 'pulse'
  | 'tool_install'
  | 'sandbox_reset'
  | 'work_queued'
  | 'work_dequeued'
  | 'error';

export interface TimelineEvent {
  id: string;
  timestamp: number;
  type: TimelineEventType;
  data: Record<string, any>;
}

// Aggregated timeline types
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

export interface ActivityResponse {
  timeline: TimelineEvent[];
  resourceUsage: ResourceUsage;
}
