/**
 * Swarm Executor Types — shared between engine, server, and agent-runtime.
 *
 * A "swarm" is a DAG of executor tasks that the planner submits as a batch.
 * The engine topologically sorts the DAG, dispatches tasks whose dependencies
 * are satisfied, and streams progress events back via Redis pub/sub.
 */

// ── Swarm Task Definition (submitted by planner) ──────────────────────────

export interface SwarmTaskDef {
  /** Unique key for this task within the swarm (e.g. task ID or slug) */
  key: string;
  /** Human-readable title */
  title: string;
  /** Project ID for workspace provisioning */
  projectId: string;
  /** Task ID in the kanban (for workspace/branch provisioning) */
  taskId: string;
  /** The execution prompt the executor receives */
  executionPrompt: string;
  /** Keys of tasks this depends on (must complete before this starts) */
  dependencies: string[];
  /** Model override for this specific executor */
  model?: string;
  /** Timeout in seconds for this executor (default 300) */
  timeoutSeconds?: number;
}

// ── Swarm Request (planner → server → engine) ─────────────────────────────

export interface SwarmRequest {
  /** Agent ID of the planner */
  agentId: string;
  /** Tasks forming the DAG */
  tasks: SwarmTaskDef[];
  /** Max concurrent executors (default 3) */
  maxConcurrent?: number;
  /** Deviation rules injected into every executor */
  deviationRules?: string;
  /** Global timeout for the entire swarm in seconds (default 1800 = 30 min) */
  globalTimeoutSeconds?: number;
}

// ── Swarm Task Runtime State ──────────────────────────────────────────────

export type SwarmTaskStatus =
  | 'pending'      // Waiting for dependencies
  | 'ready'        // Dependencies met, queued for dispatch
  | 'running'      // Executor spawned and active
  | 'completed'    // Executor finished successfully
  | 'failed'       // Executor failed
  | 'cancelled'    // Cancelled by planner or timeout
  | 'skipped';     // Skipped due to failed dependency

export interface SwarmTaskState {
  key: string;
  title: string;
  taskId: string;
  projectId: string;
  status: SwarmTaskStatus;
  runId?: string;           // The executor run ID once spawned
  dependencies: string[];
  /** Structured outputs from the executor (commit_hashes, files_changed, etc.) */
  outputs?: Record<string, string>;
  error?: string;
  startedAt?: number;
  completedAt?: number;
}

// ── Swarm Session State ───────────────────────────────────────────────────

export type SwarmSessionStatus =
  | 'running'
  | 'completed'    // All tasks done (some may have failed)
  | 'failed'       // Global timeout or fatal error
  | 'cancelled';   // Planner cancelled

export interface SwarmSessionState {
  swarmId: string;
  agentId: string;
  status: SwarmSessionStatus;
  tasks: SwarmTaskState[];
  maxConcurrent: number;
  activeCount: number;
  completedCount: number;
  failedCount: number;
  totalCount: number;
  createdAt: number;
  updatedAt: number;
}

// ── Swarm Progress Events (engine → agent-runtime via Redis) ──────────────

export type SwarmProgressEvent =
  | SwarmTaskStartedEvent
  | SwarmTaskCompletedEvent
  | SwarmTaskFailedEvent
  | SwarmTaskSkippedEvent
  | SwarmCompletedEvent
  | SwarmFailedEvent;

export interface SwarmTaskStartedEvent {
  type: 'swarm:task_started';
  swarmId: string;
  taskKey: string;
  taskTitle: string;
  runId: string;
  timestamp: number;
}

export interface SwarmTaskCompletedEvent {
  type: 'swarm:task_completed';
  swarmId: string;
  taskKey: string;
  taskTitle: string;
  runId: string;
  outputs: Record<string, string>;
  durationMs: number;
  timestamp: number;
}

export interface SwarmTaskFailedEvent {
  type: 'swarm:task_failed';
  swarmId: string;
  taskKey: string;
  taskTitle: string;
  runId: string;
  error: string;
  outputs?: Record<string, string>;
  durationMs: number;
  timestamp: number;
}

export interface SwarmTaskSkippedEvent {
  type: 'swarm:task_skipped';
  swarmId: string;
  taskKey: string;
  taskTitle: string;
  reason: string;
  timestamp: number;
}

export interface SwarmCompletedEvent {
  type: 'swarm:completed';
  swarmId: string;
  summary: SwarmSummary;
  timestamp: number;
}

export interface SwarmFailedEvent {
  type: 'swarm:failed';
  swarmId: string;
  error: string;
  summary: SwarmSummary;
  timestamp: number;
}

// ── Swarm Summary ─────────────────────────────────────────────────────────

export interface SwarmSummary {
  totalTasks: number;
  completed: number;
  failed: number;
  skipped: number;
  cancelled: number;
  totalDurationMs: number;
  taskResults: Array<{
    key: string;
    title: string;
    status: SwarmTaskStatus;
    runId?: string;
    outputs?: Record<string, string>;
    error?: string;
    durationMs?: number;
  }>;
}

// ── Redis Channel ─────────────────────────────────────────────────────────

export function swarmChannel(swarmId: string): string {
  return `djinnbot:swarm:${swarmId}:progress`;
}

export function swarmStateKey(swarmId: string): string {
  return `djinnbot:swarm:${swarmId}:state`;
}
