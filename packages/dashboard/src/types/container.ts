/**
 * Container event types based on Redis protocol
 * See packages/core/src/redis-protocol/types.ts
 */

// Container Status
export type ContainerStatus = 'ready' | 'busy' | 'idle' | 'error' | 'exiting';

export interface ContainerStatusEvent {
  type: ContainerStatus;
  runId: string;
  requestId?: string;
  timestamp: number;
  message?: string;
  code?: string | number;
}

// Step Events
export interface StepStartEvent {
  type: 'stepStart';
  requestId: string;
  stepNumber: number;
  timestamp: number;
}

export interface StepEndEvent {
  type: 'stepEnd';
  requestId: string;
  stepNumber: number;
  result: string;
  success: boolean;
  timestamp: number;
}

// Tool Events
export interface ToolStartEvent {
  type: 'toolStart';
  requestId: string;
  toolName: string;
  args: Record<string, unknown>;
  timestamp: number;
}

export interface ToolEndEvent {
  type: 'toolEnd';
  requestId: string;
  toolName: string;
  result: unknown;
  success: boolean;
  durationMs?: number;
  timestamp: number;
}

// Output Events
export interface StdoutEvent {
  type: 'stdout';
  requestId?: string;
  data: string;
  timestamp: number;
}

export interface StderrEvent {
  type: 'stderr';
  requestId?: string;
  data: string;
  timestamp: number;
}

// Container Lifecycle Events (published by engine, not container-internal)
export interface ContainerLifecycleEvent {
  type: 'CONTAINER_CREATED' | 'CONTAINER_STARTING' | 'CONTAINER_READY' | 'CONTAINER_STOPPING' | 'CONTAINER_DESTROYED';
  runId: string;
  detail?: string;
  timestamp: number;
}

// Messaging Events
export interface AgentMessageEvent {
  type: 'agentMessage';
  requestId: string;
  to: string;
  message: string;
  priority: 'normal' | 'high' | 'urgent';
  messageType: 'info' | 'review_request' | 'help_request' | 'unblock';
  timestamp: number;
}

export interface SlackDmEvent {
  type: 'slackDm';
  requestId: string;
  message: string;
  urgent: boolean;
  timestamp: number;
}

// Union type for all container events
export type ContainerEvent =
  | ContainerStatusEvent
  | ContainerLifecycleEvent
  | StepStartEvent
  | StepEndEvent
  | ToolStartEvent
  | ToolEndEvent
  | StdoutEvent
  | StderrEvent
  | AgentMessageEvent
  | SlackDmEvent;

// UI representation
export interface ContainerEventDisplay {
  id: string;
  timestamp: number;
  category: 'status' | 'step' | 'tool' | 'output' | 'message';
  label: string;
  description: string;
  variant: 'default' | 'success' | 'warning' | 'error' | 'info';
  data?: any;
  expanded?: boolean;
}
