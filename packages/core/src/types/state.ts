export type RunStatus = 'pending' | 'running' | 'completed' | 'failed' | 'cancelled';
export type StepStatus = 'pending' | 'queued' | 'running' | 'completed' | 'failed' | 'cancelled' | 'retrying';

/**
 * Captures the full key resolution context for a pipeline run or chat session.
 * Provides structured metadata about whose API keys are used and why, enabling
 * audit trails and explicit source tracking.
 */
export type KeyResolutionSource = 'project_key_user' | 'executing_user' | 'chat_session' | 'system';

export interface RunKeyContext {
  /** User whose keys to resolve (personal > admin-shared > nothing). */
  userId?: string;
  /** How the userId was determined. */
  source: KeyResolutionSource;
  /** Optional model override for this run (overrides agent/pipeline defaults). */
  modelOverride?: string;
}

export interface PipelineRun {
  id: string;
  pipelineId: string;
  projectId?: string;
  /**
   * Persistent git branch for this task (e.g. "feat/task_abc123-implement-oauth").
   * When set, the pipeline run's worktree is created on this branch instead of an
   * ephemeral "run/{runId}" branch. This ensures pipeline work lands on the same
   * branch that a pulse agent would push directly — they share one PR branch.
   * The branch is pushed to remote and becomes a PR — the engine never merges to main.
   */
  taskBranch?: string;
  taskDescription: string;
  status: RunStatus;
  outputs: Record<string, string>;
  currentStepId: string | null;
  createdAt: number;
  updatedAt: number;
  completedAt: number | null;
  humanContext?: string;
  /** DjinnBot user whose API keys are used for this run (per-user key resolution). */
  userId?: string;
  /** User who initiated this run (from dashboard "Execute" or API call). */
  initiatedByUserId?: string;
  /** Optional model override — takes priority over agent/pipeline defaults. */
  modelOverride?: string;
  /** JSON blob recording which providers were resolved and how. */
  keyResolution?: {
    userId?: string;
    source?: string;
    resolvedProviders?: string[];
  };
}

export interface StepExecution {
  id: string;
  runId: string;
  stepId: string;
  agentId: string;
  status: StepStatus;
  sessionId: string | null;
  inputs: Record<string, string>;
  outputs: Record<string, string>;
  error: string | null;
  retryCount: number;
  maxRetries: number;
  startedAt: number | null;
  completedAt: number | null;
  humanContext: string | null;
}

export interface LoopState {
  runId: string;
  stepId: string;
  items: LoopItem[];
  currentIndex: number;
}

export interface LoopItem {
  id: string;
  index: number;
  data: string;   // JSON string of the item
  status: 'pending' | 'running' | 'completed' | 'failed';
  retryCount: number;
  output: string | null;
}

export interface KnowledgeEntry {
  id: string;
  runId: string;
  agentId: string;
  category: 'pattern' | 'decision' | 'issue' | 'convention';
  content: string;
  importance: 'low' | 'medium' | 'high' | 'critical';
  createdAt: number;
}
