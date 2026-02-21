/**
 * ApiStore - Drop-in replacement for Store that uses HTTP API instead of SQLite.
 * Implements the same interface as Store for compatibility.
 */
import { ApiClient, createApiClient } from '../api/client.js';
import type { PipelineRun, StepExecution, LoopState, LoopItem, KnowledgeEntry } from '../types/state.js';
import type { Task, KanbanColumn } from '../types/project.js';

export interface ApiStoreConfig {
  apiUrl: string;
}

export class ApiStore {
  private client: ApiClient;

  constructor(config: ApiStoreConfig) {
    this.client = createApiClient(config.apiUrl);
  }

  initialize(): void {
    // No-op for API store - no local DB to initialize
    console.log('[ApiStore] Initialized (using HTTP API)');
  }

  // ═══════════════════════════════════════════════════════════════
  // RUNS - Note: createRun is handled by API's POST /runs endpoint
  // The Engine doesn't create runs, it receives them via Redis
  // ═══════════════════════════════════════════════════════════════

  async getRun(runId: string): Promise<PipelineRun | null> {
    return this.client.getRun(runId);
  }

  async updateRun(runId: string, updates: Partial<PipelineRun>): Promise<void> {
    await this.client.updateRun(runId, {
      status: updates.status,
      outputs: updates.outputs,
      current_step_id: updates.currentStepId ?? undefined,
      human_context: updates.humanContext ?? undefined,
      completed_at: updates.completedAt ?? undefined,
    });
  }

  async listRuns(pipelineId?: string): Promise<PipelineRun[]> {
    return this.client.listRuns(pipelineId);
  }

  // Note: createRun is handled by API's POST /runs endpoint
  // The Engine doesn't create runs, it receives them via Redis
  // This is a sync stub for Store interface compatibility
  createRun(run: Omit<PipelineRun, 'createdAt' | 'updatedAt'>): PipelineRun {
    console.log(`[ApiStore] createRun called for ${run.id} - run already exists in API`);
    return {
      ...run,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };
  }

  // ═══════════════════════════════════════════════════════════════
  // STEPS
  // ═══════════════════════════════════════════════════════════════

  async createStep(step: Omit<StepExecution, 'startedAt' | 'completedAt'>): Promise<StepExecution> {
    return this.client.createStep(step.runId, {
      id: step.id,
      step_id: step.stepId,
      agent_id: step.agentId,
      inputs: step.inputs,
      human_context: step.humanContext ?? undefined,
      max_retries: step.maxRetries,
    });
  }

  async getStep(runId: string, stepId: string): Promise<StepExecution | null> {
    return this.client.getStep(runId, stepId);
  }

  async listSteps(runId: string): Promise<StepExecution[]> {
    return this.client.listSteps(runId);
  }

  async updateStep(runId: string, stepId: string, updates: Partial<StepExecution>): Promise<void> {
    await this.client.updateStep(runId, stepId, {
      status: updates.status,
      session_id: updates.sessionId ?? undefined,
      inputs: updates.inputs,
      outputs: updates.outputs,
      error: updates.error ?? undefined,
      retry_count: updates.retryCount ?? undefined,
      started_at: updates.startedAt ?? undefined,
      completed_at: updates.completedAt ?? undefined,
      human_context: updates.humanContext ?? undefined,
    });
  }

  async getStepsByStatus(runId: string, status: string): Promise<StepExecution[]> {
    return this.client.getStepsByStatus(runId, status);
  }

  // ═══════════════════════════════════════════════════════════════
  // LOOP STATE
  // ═══════════════════════════════════════════════════════════════

  async createLoopState(state: LoopState): Promise<void> {
    await this.client.createLoopState(state.runId, {
      step_id: state.stepId,
      items: state.items,
      current_index: state.currentIndex,
    });
  }

  async getLoopState(runId: string, stepId: string): Promise<LoopState | null> {
    return this.client.getLoopState(runId, stepId);
  }

  async updateLoopItem(runId: string, stepId: string, itemId: string, updates: Partial<LoopItem>): Promise<void> {
    await this.client.updateLoopItem(runId, stepId, itemId, {
      status: updates.status,
      output: updates.output,
    });
  }

  async advanceLoop(runId: string, stepId: string): Promise<LoopItem | null> {
    return this.client.advanceLoop(runId, stepId);
  }

  // ═══════════════════════════════════════════════════════════════
  // OUTPUTS
  // ═══════════════════════════════════════════════════════════════

  async setOutput(runId: string, stepId: string, key: string, value: string): Promise<void> {
    await this.client.setOutput(runId, stepId, key, value);
  }

  async getOutputs(runId: string): Promise<Record<string, string>> {
    return this.client.getOutputs(runId);
  }

  // ═══════════════════════════════════════════════════════════════
  // TASKS (for TaskRunTracker)
  //
  // In the API-store path, TaskRunTracker calls updateTask / moveTask /
  // getColumnsByProject / updateTaskRun / recomputeTaskReadiness individually.
  // We route all of these through the single notifyTaskRunCompleted webhook on
  // the Python server, which handles status, column move, task_run history update,
  // and cascade readiness in one atomic operation.
  //
  // updateTask / moveTask / updateTaskRun are called BEFORE recomputeTaskReadiness,
  // so we buffer the intent and flush on recomputeTaskReadiness.
  // ═══════════════════════════════════════════════════════════════

  async getTaskByRunId(runId: string): Promise<Task | null> {
    return this.client.getTaskByRunId(runId);
  }

  async notifyTaskRunCompleted(projectId: string, taskId: string, runId: string, status: 'completed' | 'failed'): Promise<void> {
    await this.client.notifyTaskRunCompleted(projectId, taskId, runId, status);
  }

  /**
   * updateTask is called by TaskRunTracker to set status/runId/completedAt.
   * In API mode the Python webhook handles this, so we no-op here —
   * recomputeTaskReadiness (called last) triggers the webhook.
   */
  async updateTask(_projectId: string, _taskId: string, _updates: Partial<Task>): Promise<void> {
    // Handled by recomputeTaskReadiness → notifyTaskRunCompleted webhook
  }

  /**
   * updateTaskRun is called by TaskRunTracker to update task_runs history.
   * The Python webhook handles this too; no-op here.
   */
  async updateTaskRun(_taskId: string, _runId: string, _updates: { status?: string; completedAt?: number; error?: string }): Promise<void> {
    // Handled by recomputeTaskReadiness → notifyTaskRunCompleted webhook
  }

  /**
   * getColumnsByProject — return empty; not used in API mode since
   * moveTask is also a no-op (webhook handles column moves).
   */
  async getColumnsByProject(_projectId: string): Promise<KanbanColumn[]> {
    return [];
  }

  /**
   * moveTask — no-op in API mode; the webhook handles column transitions.
   */
  async moveTask(_projectId: string, _taskId: string, _columnId: string, _position: number): Promise<void> {
    // Handled by recomputeTaskReadiness → notifyTaskRunCompleted webhook
  }

  /**
   * recomputeTaskReadiness — in API mode, the Python server's background
   * _run_completion_listener already handles this automatically by listening
   * on the Redis global event stream for RUN_COMPLETE / RUN_FAILED events.
   * It calls _handle_task_run_event which updates the task status, moves it
   * to the correct column, and cascades readiness to dependent tasks.
   *
   * No explicit action needed here — just log so we can confirm the call path.
   */
  async recomputeTaskReadiness(projectId: string, taskId: string, newStatus: string): Promise<void> {
    console.log(`[ApiStore] recomputeTaskReadiness: task=${taskId} status=${newStatus} — handled by Python event listener`);
  }

  // ═══════════════════════════════════════════════════════════════
  // NOT IMPLEMENTED - These would need new API endpoints
  // ═══════════════════════════════════════════════════════════════

  async addKnowledge(entry: Omit<KnowledgeEntry, 'id' | 'createdAt'>): Promise<KnowledgeEntry> {
    console.warn('[ApiStore] addKnowledge not implemented - knowledge stays local');
    // Return a stub - knowledge can stay in memory or be implemented later
    return {
      ...entry,
      id: `knowledge_${Date.now()}`,
      createdAt: Date.now(),
    };
  }

  async getKnowledge(runId: string, options?: { category?: string; importance?: string }): Promise<KnowledgeEntry[]> {
    console.warn('[ApiStore] getKnowledge not implemented');
    return [];
  }

  // ═══════════════════════════════════════════════════════════════
  // PROJECTS
  // ═══════════════════════════════════════════════════════════════

  async getProjectRepository(projectId: string): Promise<string | null> {
    return this.client.getProjectRepository(projectId);
  }

  async getProjectSlackSettings(projectId: string): Promise<{
    slack_channel_id: string | null;
    slack_notify_user_id: string | null;
  } | null> {
    return this.client.getProjectSlackSettings(projectId);
  }

  // Stub methods for compatibility
  close(): void {
    console.log('[ApiStore] Close called (no-op for API store)');
  }
}
