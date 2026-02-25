export interface ContainerCrashedEvent {
  type: 'CONTAINER_CRASHED';
  runId: string;
  exitCode: number;
  timestamp: number;
}

export interface ContainerStoppedEvent {
  type: 'CONTAINER_STOPPED';
  runId: string;
  unexpected: boolean;
  timestamp: number;
}

export interface ContainerCreateFailedEvent {
  type: 'CONTAINER_CREATE_FAILED';
  runId: string;
  error: string;
  timestamp: number;
}

export interface RedisConnectionErrorEvent {
  type: 'REDIS_CONNECTION_ERROR';
  runId: string;
  error: string;
  timestamp: number;
}

export interface ContainerRedisErrorEvent {
  type: 'CONTAINER_REDIS_ERROR';
  error: string;
  timestamp: number;
}

export interface ContainerRedisCloseEvent {
  type: 'CONTAINER_REDIS_CLOSE';
  timestamp: number;
}

export interface ContainerRedisReconnectingEvent {
  type: 'CONTAINER_REDIS_RECONNECTING';
  timestamp: number;
}

export interface ContainerCrashEvent {
  type: 'CONTAINER_CRASH';
  runId: string;
  containerId: string;
  exitCode: number;
  timestamp: number;
}

export interface ContainerStartErrorEvent {
  type: 'CONTAINER_START_ERROR';
  runId: string;
  error: string;
  timestamp: number;
}

export type PipelineEvent =
  | { type: 'RUN_CREATED'; runId: string; pipelineId: string; taskDescription: string; timestamp: number }
  | { type: 'STEP_QUEUED'; runId: string; stepId: string; agentId: string; timestamp: number }
  | { type: 'STEP_STARTED'; runId: string; stepId: string; sessionId: string; timestamp: number }
  | { type: 'STEP_OUTPUT'; runId: string; stepId: string; chunk: string; timestamp: number }
  | { type: 'STEP_THINKING'; runId: string; stepId: string; chunk: string; timestamp: number }
  | { type: 'STEP_COMPLETE'; runId: string; stepId: string; outputs: Record<string, string>; commitHash?: string; timestamp: number }
  | { type: 'STEP_FAILED'; runId: string; stepId: string; error: string; retryCount: number; timestamp: number }
  | { type: 'STEP_RETRYING'; runId: string; stepId: string; feedback: string; timestamp: number }
  | { type: 'STEP_CANCELLED'; runId: string; stepId: string; reason: string; timestamp: number }
  | { type: 'LOOP_ITEM_COMPLETE'; runId: string; stepId: string; itemId: string; itemIndex: number; timestamp: number }
  | { type: 'LOOP_ITEM_FAILED'; runId: string; stepId: string; itemId: string; error: string; timestamp: number }
  | { type: 'RUN_COMPLETE'; runId: string; outputs: Record<string, string>; timestamp: number }
  | { type: 'RUN_FAILED'; runId: string; error: string; timestamp: number }
  | { type: 'AGENT_MESSAGE'; runId: string; from: string; to: string; message: string; threadId: string; timestamp: number }
  | { type: 'HUMAN_INTERVENTION'; runId: string; stepId: string; action: 'restart' | 'stop' | 'inject_context'; context: string; timestamp: number }
  | { type: 'SLACK_MESSAGE'; runId: string; agentId: string; agentName: string; agentEmoji: string; userId?: string; userName?: string; message: string; isAgent: boolean; threadTs: string; messageTs: string; timestamp: number }
  | { type: 'AGENT_STATE'; runId: string; stepId: string; state: 'thinking' | 'streaming' | 'tool_calling' | 'idle'; toolName?: string; timestamp: number }
  | { type: 'TOOL_CALL_START'; runId: string; stepId: string; toolName: string; toolCallId: string; args: string; timestamp: number }
  | { type: 'TOOL_CALL_END'; runId: string; stepId: string; toolName: string; toolCallId: string; result: string; isError: boolean; durationMs: number; timestamp: number }
  | { type: 'FILE_CHANGED'; runId: string; stepId: string; path: string; action: 'create' | 'modify' | 'delete'; size?: number; timestamp: number }
  | { type: 'COMMIT_FAILED'; runId: string; stepId: string; error: string; timestamp: number }
  | { type: 'AGENT_STATE_CHANGED'; agentId: string; previousState: string; newState: string; runId: string; stepId: string; timestamp: number }
  | { type: 'STEP_ERROR'; runId: string; stepId: string; data: string; timestamp: number }
  | { type: 'AGENT_THINKING'; runId: string; stepId: string; thinking: string; timestamp: number }
  | { type: 'TOOL_STARTED'; runId: string; stepId: string; toolName: string; timestamp: number }
  | { type: 'TOOL_COMPLETE'; runId: string; stepId: string; toolName: string; result: string; timestamp: number }
  | ContainerCrashedEvent
  | ContainerStoppedEvent
  | ContainerCreateFailedEvent
  | RedisConnectionErrorEvent
  | ContainerRedisErrorEvent
  | ContainerRedisCloseEvent
  | ContainerRedisReconnectingEvent
  | ContainerCrashEvent
  | ContainerStartErrorEvent
  | { type: 'CONTAINER_CREATED' | 'CONTAINER_STARTING' | 'CONTAINER_READY' | 'CONTAINER_STOPPING' | 'CONTAINER_DESTROYED'; runId: string; detail?: string; timestamp: number };
