import type { PipelineRun, StepExecution, LoopState, LoopItem } from '../types/state.js';
import type { Task } from '../types/project.js';
import { authFetch } from './auth-fetch.js';

export interface ApiClientConfig {
  baseUrl: string;
  timeout?: number;
}

interface UpdateRunRequest {
  status?: string;
  outputs?: Record<string, unknown>;
  current_step_id?: string;
  human_context?: string;
  completed_at?: number;
}

interface CreateStepRequest {
  id: string;
  step_id: string;
  agent_id: string;
  inputs?: Record<string, unknown>;
  human_context?: string;
  max_retries?: number;
}

interface UpdateStepRequest {
  status?: string;
  session_id?: string;
  inputs?: Record<string, unknown>;
  outputs?: Record<string, unknown>;
  error?: string;
  retry_count?: number;
  started_at?: number;
  completed_at?: number;
  human_context?: string;
}

interface CreateLoopStateRequest {
  step_id: string;
  items: LoopItem[];
  current_index?: number;
}

interface UpdateLoopItemRequest {
  status?: string;
  output?: unknown;
}

export class ApiClient {
  private baseUrl: string;
  private timeout: number;

  constructor(config: ApiClientConfig) {
    this.baseUrl = config.baseUrl.replace(/\/$/, ''); // Remove trailing slash
    this.timeout = config.timeout ?? 30000;
  }

  private async request<T>(
    method: string,
    path: string,
    body?: unknown
  ): Promise<T> {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), this.timeout);

    try {
      const response = await authFetch(`${this.baseUrl}${path}`, {
        method,
        headers: {
          'Content-Type': 'application/json',
        },
        body: body ? JSON.stringify(body) : undefined,
        signal: controller.signal,
      });

      if (!response.ok) {
        const error = await response.text();
        throw new Error(`API error ${response.status}: ${error}`);
      }

      // Handle empty responses
      if (response.status === 204) {
        return undefined as T;
      }

      return response.json() as T;
    } finally {
      clearTimeout(timeoutId);
    }
  }

  // ══════════════════════════════════════════════════════════════
  // RUNS
  // ══════════════════════════════════════════════════════════════

  async getRun(runId: string): Promise<PipelineRun | null> {
    try {
      const r = await this.request<any>('GET', `/v1/runs/${runId}`);
      if (!r) return null;

      // Map API response (snake_case) to PipelineRun (camelCase)
      return {
        id: r.id,
        pipelineId: r.pipeline_id,
        projectId: r.project_id,
        taskDescription: r.task,
        status: r.status,
        outputs: r.outputs || {},
        currentStepId: r.current_step,
        humanContext: r.human_context,
        userId: r.key_user_id ?? undefined,
        initiatedByUserId: r.initiated_by_user_id ?? undefined,
        modelOverride: r.model_override ?? undefined,
        keyResolution: r.key_resolution ?? undefined,
        createdAt: r.created_at,
        updatedAt: r.updated_at,
        completedAt: r.completed_at,
      };
    } catch (error) {
      if (error instanceof Error && error.message.includes('404')) {
        return null;
      }
      throw error;
    }
  }

  async updateRun(runId: string, updates: UpdateRunRequest): Promise<void> {
    await this.request('PATCH', `/v1/runs/${runId}`, updates);
  }

  async listRuns(pipelineId?: string): Promise<PipelineRun[]> {
    const query = pipelineId ? `?pipeline_id=${encodeURIComponent(pipelineId)}` : '';
    const runs = await this.request<any[]>('GET', `/v1/runs/${query}`);
    return runs.map(r => ({
      id: r.id,
      pipelineId: r.pipeline_id,
      projectId: r.project_id,
      taskDescription: r.task,
      status: r.status,
      outputs: r.outputs || {},
      currentStepId: r.current_step,
      humanContext: r.human_context,
      createdAt: r.created_at,
      updatedAt: r.updated_at,
      completedAt: r.completed_at,
    }));
  }

  // ══════════════════════════════════════════════════════════════
  // STEPS
  // ══════════════════════════════════════════════════════════════

  async listSteps(runId: string, status?: string): Promise<StepExecution[]> {
    const query = status ? `?status=${encodeURIComponent(status)}` : '';
    return this.request<StepExecution[]>('GET', `/v1/runs/${runId}/steps${query}`);
  }

  async getStep(runId: string, stepId: string): Promise<StepExecution | null> {
    const steps = await this.listSteps(runId);
    return steps.find(s => s.stepId === stepId) ?? null;
  }

  async createStep(runId: string, req: CreateStepRequest): Promise<StepExecution> {
    return this.request<StepExecution>('POST', `/v1/runs/${runId}/steps`, req);
  }

  async updateStep(runId: string, stepId: string, updates: UpdateStepRequest): Promise<void> {
    await this.request('PATCH', `/v1/runs/${runId}/steps/${stepId}`, updates);
  }

  async getStepsByStatus(runId: string, status: string): Promise<StepExecution[]> {
    return this.listSteps(runId, status);
  }

  // ══════════════════════════════════════════════════════════════
  // LOOP STATE
  // ══════════════════════════════════════════════════════════════

  async createLoopState(runId: string, req: CreateLoopStateRequest): Promise<LoopState> {
    return this.request<LoopState>('POST', `/v1/runs/${runId}/loop-state`, req);
  }

  async getLoopState(runId: string, stepId: string): Promise<LoopState | null> {
    try {
      return await this.request<LoopState>('GET', `/v1/runs/${runId}/loop-state/${stepId}`);
    } catch (error) {
      if (error instanceof Error && error.message.includes('404')) {
        return null;
      }
      throw error;
    }
  }

  async updateLoopItem(
    runId: string,
    stepId: string,
    itemId: string,
    updates: UpdateLoopItemRequest
  ): Promise<void> {
    await this.request(
      'PATCH',
      `/v1/runs/${runId}/loop-state/${stepId}/items/${itemId}`,
      updates
    );
  }

  async advanceLoop(runId: string, stepId: string): Promise<LoopItem | null> {
    const result = await this.request<{ next_item: LoopItem | null }>(
      'POST',
      `/v1/runs/${runId}/loop-state/${stepId}/advance`
    );
    return result.next_item;
  }

  // ══════════════════════════════════════════════════════════════
  // OUTPUTS
  // ══════════════════════════════════════════════════════════════

  async getOutputs(runId: string): Promise<Record<string, string>> {
    return this.request<Record<string, string>>('GET', `/v1/runs/${runId}/outputs`);
  }

  async setOutput(runId: string, stepId: string, key: string, value: string): Promise<void> {
    await this.request('PUT', `/v1/runs/${runId}/outputs`, { step_id: stepId, key, value });
  }

  // ══════════════════════════════════════════════════════════════
  // TASKS (for TaskRunTracker)
  // ══════════════════════════════════════════════════════════════

  async getTaskByRunId(runId: string): Promise<Task | null> {
    try {
      const result = await this.request<Task | null>('GET', `/v1/runs/tasks?run_id=${runId}`);
      return result;
    } catch (error) {
      if (error instanceof Error && error.message.includes('404')) {
        return null;
      }
      throw error;
    }
  }

  async notifyTaskRunCompleted(
    projectId: string,
    taskId: string,
    runId: string,
    status: 'completed' | 'failed'
  ): Promise<void> {
    await this.request(
      'POST',
      `/v1/projects/${projectId}/tasks/${taskId}/run-completed?run_id=${runId}&status=${status}`
    );
  }

  // ══════════════════════════════════════════════════════════════
  // PROJECTS
  // ══════════════════════════════════════════════════════════════

  async getProjectRepository(projectId: string): Promise<string | null> {
    try {
      const project = await this.request<{ repository?: string }>(
        'GET',
        `/v1/projects/${projectId}`
      );
      return project?.repository || null;
    } catch (err) {
      console.warn(`[ApiClient] Failed to fetch repository for project ${projectId}:`, err);
      return null;
    }
  }

  async getProjectSlackSettings(projectId: string): Promise<{
    slack_channel_id: string | null;
    slack_notify_user_id: string | null;
  } | null> {
    try {
      return await this.request<{
        slack_channel_id: string | null;
        slack_notify_user_id: string | null;
      }>('GET', `/v1/projects/${projectId}/slack`);
    } catch (err) {
      console.warn(`[ApiClient] Failed to fetch Slack settings for project ${projectId}:`, err);
      return null;
    }
  }
}

// Factory function for convenience
export function createApiClient(baseUrl: string = 'http://api:8000'): ApiClient {
  return new ApiClient({ baseUrl });
}
