/**
 * SwarmSessionManager — orchestrates parallel executor tasks as a DAG.
 *
 * Lifecycle:
 * 1. Planner calls POST /v1/internal/swarm-execute with a task DAG
 * 2. Server creates a SwarmSession and dispatches it via Redis
 * 3. Engine picks it up, topologically sorts the DAG, dispatches ready tasks
 * 4. As executors complete, newly-unblocked tasks are dispatched
 * 5. Progress events are published to Redis pub/sub for the planner to consume
 * 6. When all tasks are done (or global timeout), swarm:completed is published
 */

import {
  type SwarmRequest,
  type SwarmTaskDef,
  type SwarmTaskState,
  type SwarmSessionState,
  type SwarmProgressEvent,
  type SwarmSummary,
  type SwarmTaskStatus,
  swarmChannel,
  swarmStateKey,
} from './swarm-types.js';

export interface SwarmSessionDeps {
  /**
   * Spawn a single executor run. Returns the run_id.
   * Mirrors the existing spawn-executor API call.
   */
  spawnExecutor: (params: {
    agentId: string;
    projectId: string;
    taskId: string;
    executionPrompt: string;
    deviationRules: string;
    modelOverride?: string;
    timeoutSeconds: number;
    /** When spawned from a swarm, the unique task key for per-executor branch isolation. */
    swarmTaskKey?: string;
  }) => Promise<string>;

  /**
   * Poll a run's status. Returns status + outputs + error.
   */
  pollRun: (runId: string) => Promise<{
    status: string;
    outputs?: Record<string, string>;
    error?: string;
  }>;

  /**
   * Publish a swarm progress event to Redis pub/sub.
   */
  publishProgress: (swarmId: string, event: SwarmProgressEvent) => Promise<void>;

  /**
   * Persist swarm state to Redis (for recovery and polling).
   */
  persistState: (swarmId: string, state: SwarmSessionState) => Promise<void>;

  /**
   * Merge executor branches after swarm completion (Option B integration).
   * Called when all tasks succeed. Merges per-executor branches into the
   * canonical feat/{taskId} branch and optionally opens a PR.
   *
   * Returns merge result summary, or null if not available.
   */
  mergeExecutorBranches?: (params: {
    projectId: string;
    targetBranch: string;
    executorBranches: string[];
  }) => Promise<{
    success: boolean;
    merged: string[];
    conflicts: Array<{ branch: string; error: string }>;
    pushed: boolean;
    pushError?: string;
  }>;

  /**
   * Open a PR for the integrated branch after swarm completion.
   * Returns PR info or null if not available.
   */
  openPullRequest?: (params: {
    projectId: string;
    taskId: string;
    title: string;
    body: string;
  }) => Promise<{ pr_number: number; pr_url: string } | null>;
}

const DEFAULT_MAX_CONCURRENT = 3;
const DEFAULT_GLOBAL_TIMEOUT_SECONDS = 1800; // 30 min
const DEFAULT_TASK_TIMEOUT_SECONDS = 300;    // 5 min
const POLL_INTERVAL_MS = 2500;

export class SwarmSessionManager {
  private sessions = new Map<string, SwarmSession>();

  constructor(private deps: SwarmSessionDeps) {}

  /**
   * Create and start a new swarm session.
   */
  async startSwarm(swarmId: string, request: SwarmRequest): Promise<SwarmSessionState> {
    if (this.sessions.has(swarmId)) {
      throw new Error(`Swarm ${swarmId} already exists`);
    }

    const session = new SwarmSession(swarmId, request, this.deps);
    this.sessions.set(swarmId, session);

    const state = session.getState();
    await this.deps.persistState(swarmId, state);

    // Start execution in the background
    session.execute().then(() => {
      this.sessions.delete(swarmId);
    }).catch(err => {
      console.error(`[SwarmSession] Fatal error in swarm ${swarmId}:`, err);
      this.sessions.delete(swarmId);
    });

    return state;
  }

  /**
   * Cancel a running swarm.
   */
  async cancelSwarm(swarmId: string): Promise<void> {
    const session = this.sessions.get(swarmId);
    if (session) {
      session.cancel();
    }
  }

  /**
   * Get the current state of a swarm.
   */
  getSwarmState(swarmId: string): SwarmSessionState | undefined {
    return this.sessions.get(swarmId)?.getState();
  }
}

// ── Internal SwarmSession ─────────────────────────────────────────────────

class SwarmSession {
  private tasks: Map<string, SwarmTaskState> = new Map();
  private taskDefs: Map<string, SwarmTaskDef> = new Map();
  private request: SwarmRequest;
  private cancelled = false;
  private maxConcurrent: number;
  private deviationRules: string;
  private globalTimeoutMs: number;
  private startedAt: number;

  constructor(
    private swarmId: string,
    request: SwarmRequest,
    private deps: SwarmSessionDeps,
  ) {
    this.request = request;
    this.maxConcurrent = request.maxConcurrent ?? DEFAULT_MAX_CONCURRENT;
    this.deviationRules = request.deviationRules ?? '';
    this.globalTimeoutMs = (request.globalTimeoutSeconds ?? DEFAULT_GLOBAL_TIMEOUT_SECONDS) * 1000;
    this.startedAt = Date.now();

    // Validate and initialize task states
    this.validateDAG(request.tasks);

    for (const taskDef of request.tasks) {
      this.taskDefs.set(taskDef.key, taskDef);
      this.tasks.set(taskDef.key, {
        key: taskDef.key,
        title: taskDef.title,
        taskId: taskDef.taskId,
        projectId: taskDef.projectId,
        status: 'pending',
        dependencies: taskDef.dependencies,
      });
    }

    // Mark tasks with no dependencies as ready
    for (const [key, state] of this.tasks) {
      if (state.dependencies.length === 0) {
        state.status = 'ready';
      }
    }
  }

  /**
   * Validate the DAG: check for missing dependencies and cycles.
   */
  private validateDAG(tasks: SwarmTaskDef[]): void {
    const keys = new Set(tasks.map(t => t.key));

    // Check for missing dependency references
    for (const task of tasks) {
      for (const dep of task.dependencies) {
        if (!keys.has(dep)) {
          throw new Error(`Task "${task.key}" depends on "${dep}" which is not in the swarm`);
        }
      }
    }

    // Check for cycles using DFS
    const visited = new Set<string>();
    const inStack = new Set<string>();
    const adjList = new Map<string, string[]>();
    for (const task of tasks) {
      adjList.set(task.key, task.dependencies);
    }

    const hasCycle = (node: string): boolean => {
      if (inStack.has(node)) return true;
      if (visited.has(node)) return false;
      visited.add(node);
      inStack.add(node);
      for (const dep of adjList.get(node) || []) {
        if (hasCycle(dep)) return true;
      }
      inStack.delete(node);
      return false;
    };

    for (const task of tasks) {
      if (hasCycle(task.key)) {
        throw new Error(`Circular dependency detected involving task "${task.key}"`);
      }
    }
  }

  /**
   * Main execution loop.
   */
  async execute(): Promise<void> {
    const globalTimeout = setTimeout(() => {
      console.warn(`[SwarmSession] Global timeout reached for swarm ${this.swarmId}`);
      this.cancelled = true;
    }, this.globalTimeoutMs);

    try {
      while (!this.isDone() && !this.cancelled) {
        // Dispatch ready tasks up to concurrency limit
        await this.dispatchReady();

        // Poll running tasks
        await this.pollRunning();

        // Cascade: mark newly-ready tasks
        this.cascadeReady();

        // Skip tasks whose dependencies failed
        this.cascadeSkips();

        // Persist state
        await this.deps.persistState(this.swarmId, this.getState());

        // Wait before next poll cycle
        if (!this.isDone() && !this.cancelled) {
          await sleep(POLL_INTERVAL_MS);
        }
      }

      // Handle cancellation — cancel all pending/ready tasks
      if (this.cancelled) {
        for (const [, state] of this.tasks) {
          if (state.status === 'pending' || state.status === 'ready') {
            state.status = 'cancelled';
          }
        }
      }

      // Build summary and publish final event
      const summary = this.buildSummary();
      const allSucceeded = summary.failed === 0 && summary.skipped === 0 && summary.cancelled === 0;

      // ── Post-swarm branch integration (Option B) ────────────────────────
      // When all tasks succeed and mergeExecutorBranches is available, merge
      // the per-executor branches into the canonical task branch.
      if (allSucceeded && !this.cancelled && this.deps.mergeExecutorBranches) {
        await this.integrateExecutorBranches();
      }

      if (allSucceeded && !this.cancelled) {
        await this.publishEvent({
          type: 'swarm:completed',
          swarmId: this.swarmId,
          summary,
          timestamp: Date.now(),
        });
      } else {
        await this.publishEvent({
          type: 'swarm:failed',
          swarmId: this.swarmId,
          error: this.cancelled
            ? 'Swarm cancelled'
            : `${summary.failed} task(s) failed, ${summary.skipped} skipped`,
          summary,
          timestamp: Date.now(),
        });
      }

      // Final state persist
      await this.deps.persistState(this.swarmId, this.getState());
    } finally {
      clearTimeout(globalTimeout);
    }
  }

  /**
   * Dispatch ready tasks up to the concurrency limit.
   */
  private async dispatchReady(): Promise<void> {
    const running = this.countByStatus('running');
    const ready = [...this.tasks.values()].filter(t => t.status === 'ready');
    const slotsAvailable = this.maxConcurrent - running;

    for (let i = 0; i < Math.min(ready.length, slotsAvailable); i++) {
      const task = ready[i];
      const taskDef = this.taskDefs.get(task.key)!;

      try {
        console.log(`[SwarmSession] Dispatching task "${task.key}" (${task.title})`);

        const runId = await this.deps.spawnExecutor({
          agentId: this.request.agentId,
          projectId: taskDef.projectId,
          taskId: taskDef.taskId,
          executionPrompt: taskDef.executionPrompt,
          deviationRules: this.deviationRules,
          modelOverride: taskDef.model,
          timeoutSeconds: taskDef.timeoutSeconds ?? DEFAULT_TASK_TIMEOUT_SECONDS,
          swarmTaskKey: task.key,
        });

        task.status = 'running';
        task.runId = runId;
        task.startedAt = Date.now();

        await this.publishEvent({
          type: 'swarm:task_started',
          swarmId: this.swarmId,
          taskKey: task.key,
          taskTitle: task.title,
          runId,
          timestamp: Date.now(),
        });
      } catch (err) {
        console.error(`[SwarmSession] Failed to spawn executor for task "${task.key}":`, err);
        task.status = 'failed';
        task.error = `Spawn failed: ${err instanceof Error ? err.message : String(err)}`;
        task.completedAt = Date.now();

        await this.publishEvent({
          type: 'swarm:task_failed',
          swarmId: this.swarmId,
          taskKey: task.key,
          taskTitle: task.title,
          runId: '',
          error: task.error,
          durationMs: 0,
          timestamp: Date.now(),
        });
      }
    }
  }

  /**
   * Poll all running tasks for completion.
   */
  private async pollRunning(): Promise<void> {
    const running = [...this.tasks.values()].filter(t => t.status === 'running' && t.runId);

    const results = await Promise.allSettled(
      running.map(async (task) => {
        const result = await this.deps.pollRun(task.runId!);
        return { task, result };
      })
    );

    for (const settled of results) {
      if (settled.status === 'rejected') continue;

      const { task, result } = settled.value;

      if (result.status === 'completed') {
        task.status = 'completed';
        task.outputs = result.outputs || {};
        task.completedAt = Date.now();
        const durationMs = task.startedAt ? Date.now() - task.startedAt : 0;

        console.log(`[SwarmSession] Task "${task.key}" completed (${durationMs}ms)`);

        await this.publishEvent({
          type: 'swarm:task_completed',
          swarmId: this.swarmId,
          taskKey: task.key,
          taskTitle: task.title,
          runId: task.runId!,
          outputs: task.outputs,
          durationMs,
          timestamp: Date.now(),
        });
      } else if (result.status === 'failed') {
        task.status = 'failed';
        task.error = result.error || 'Unknown error';
        task.outputs = result.outputs;
        task.completedAt = Date.now();
        const durationMs = task.startedAt ? Date.now() - task.startedAt : 0;

        console.log(`[SwarmSession] Task "${task.key}" failed: ${task.error}`);

        await this.publishEvent({
          type: 'swarm:task_failed',
          swarmId: this.swarmId,
          taskKey: task.key,
          taskTitle: task.title,
          runId: task.runId!,
          error: task.error,
          outputs: task.outputs,
          durationMs,
          timestamp: Date.now(),
        });
      }
      // else still running — do nothing
    }
  }

  /**
   * Mark tasks whose dependencies are all completed as 'ready'.
   */
  private cascadeReady(): void {
    for (const [, state] of this.tasks) {
      if (state.status !== 'pending') continue;

      const allDepsMet = state.dependencies.every(dep => {
        const depState = this.tasks.get(dep);
        return depState?.status === 'completed';
      });

      if (allDepsMet) {
        state.status = 'ready';
        console.log(`[SwarmSession] Task "${state.key}" unblocked — ready for dispatch`);
      }
    }
  }

  /**
   * Skip tasks whose dependencies have failed or been skipped.
   */
  private cascadeSkips(): void {
    let changed = true;
    while (changed) {
      changed = false;
      for (const [, state] of this.tasks) {
        if (state.status !== 'pending') continue;

        const hasFailedDep = state.dependencies.some(dep => {
          const depState = this.tasks.get(dep);
          return depState?.status === 'failed' || depState?.status === 'skipped' || depState?.status === 'cancelled';
        });

        if (hasFailedDep) {
          state.status = 'skipped';
          state.completedAt = Date.now();
          changed = true;

          const failedDeps = state.dependencies.filter(dep => {
            const ds = this.tasks.get(dep);
            return ds?.status === 'failed' || ds?.status === 'skipped' || ds?.status === 'cancelled';
          });

          console.log(`[SwarmSession] Task "${state.key}" skipped — dependency failed: ${failedDeps.join(', ')}`);

          this.publishEvent({
            type: 'swarm:task_skipped',
            swarmId: this.swarmId,
            taskKey: state.key,
            taskTitle: state.title,
            reason: `Dependency failed: ${failedDeps.join(', ')}`,
            timestamp: Date.now(),
          }).catch(() => {});
        }
      }
    }
  }

  private isDone(): boolean {
    return [...this.tasks.values()].every(t =>
      t.status === 'completed' || t.status === 'failed' || t.status === 'skipped' || t.status === 'cancelled'
    );
  }

  private countByStatus(status: SwarmTaskStatus): number {
    return [...this.tasks.values()].filter(t => t.status === status).length;
  }

  private buildSummary(): SwarmSummary {
    const taskResults = [...this.tasks.values()].map(t => ({
      key: t.key,
      title: t.title,
      status: t.status,
      runId: t.runId,
      outputs: t.outputs,
      error: t.error,
      durationMs: t.startedAt && t.completedAt ? t.completedAt - t.startedAt : undefined,
    }));

    return {
      totalTasks: this.tasks.size,
      completed: this.countByStatus('completed'),
      failed: this.countByStatus('failed'),
      skipped: this.countByStatus('skipped'),
      cancelled: this.countByStatus('cancelled'),
      totalDurationMs: Date.now() - this.startedAt,
      taskResults,
    };
  }

  /**
   * After all swarm tasks complete, merge per-executor branches into a
   * single canonical task branch and optionally open a PR.
   *
   * Groups completed tasks by taskId (kanban task) and merges all executor
   * branches that share the same task. Solo tasks don't need merging.
   */
  private async integrateExecutorBranches(): Promise<void> {
    if (!this.deps.mergeExecutorBranches) return;

    // Group completed tasks by their kanban taskId
    const taskGroups = new Map<string, { projectId: string; branches: string[] }>();
    for (const [, state] of this.tasks) {
      if (state.status !== 'completed') continue;
      const def = this.taskDefs.get(state.key);
      if (!def) continue;

      const group = taskGroups.get(def.taskId) ?? { projectId: def.projectId, branches: [] };
      // The executor branch name is feat/{taskId}-{swarmTaskKey}
      // which was set when the run was created via spawn_executor
      // We reconstruct it here from the task key
      const baseBranch = `feat/${def.taskId}`;
      const executorBranch = `${baseBranch}-${state.key}`;
      group.branches.push(executorBranch);
      taskGroups.set(def.taskId, group);
    }

    for (const [taskId, { projectId, branches }] of taskGroups) {
      if (branches.length <= 1) {
        // Solo executor — its branch is already the right one, no merge needed.
        // Or we could rename it to the canonical branch, but push already happened
        // during run finalization.
        console.log(`[SwarmSession] Task ${taskId}: single executor, no merge needed`);
        continue;
      }

      const targetBranch = `feat/${taskId}`;
      console.log(`[SwarmSession] Merging ${branches.length} executor branches into ${targetBranch}`);

      try {
        const result = await this.deps.mergeExecutorBranches({
          projectId,
          targetBranch,
          executorBranches: branches,
        });

        if (result.success && result.pushed) {
          console.log(`[SwarmSession] Successfully integrated ${result.merged.length} branches into ${targetBranch}`);

          // Optionally open a PR
          if (this.deps.openPullRequest) {
            try {
              const pr = await this.deps.openPullRequest({
                projectId,
                taskId,
                title: `feat: swarm integration for task ${taskId}`,
                body: `Automated PR from swarm execution.\n\nMerged branches:\n${result.merged.map(b => `- ${b}`).join('\n')}`,
              });
              if (pr) {
                console.log(`[SwarmSession] Opened PR #${pr.pr_number} for ${targetBranch}`);
              }
            } catch (prErr) {
              console.warn(`[SwarmSession] Failed to open PR for ${targetBranch}:`, prErr);
            }
          }
        } else if (result.conflicts.length > 0) {
          console.warn(
            `[SwarmSession] Merge conflicts for ${targetBranch}:`,
            result.conflicts.map(c => `${c.branch}: ${c.error}`).join('; ')
          );
        }
      } catch (err) {
        console.error(`[SwarmSession] Failed to integrate branches for task ${taskId}:`, err);
      }
    }
  }

  cancel(): void {
    this.cancelled = true;
  }

  getState(): SwarmSessionState {
    const status: SwarmSessionState['status'] = this.cancelled
      ? 'cancelled'
      : this.isDone()
        ? (this.countByStatus('failed') > 0 || this.countByStatus('skipped') > 0 ? 'failed' : 'completed')
        : 'running';

    return {
      swarmId: this.swarmId,
      agentId: this.request.agentId,
      status,
      tasks: [...this.tasks.values()],
      maxConcurrent: this.maxConcurrent,
      activeCount: this.countByStatus('running'),
      completedCount: this.countByStatus('completed'),
      failedCount: this.countByStatus('failed'),
      totalCount: this.tasks.size,
      createdAt: this.startedAt,
      updatedAt: Date.now(),
    };
  }

  private async publishEvent(event: SwarmProgressEvent): Promise<void> {
    try {
      await this.deps.publishProgress(this.swarmId, event);
    } catch (err) {
      console.error(`[SwarmSession] Failed to publish event:`, err);
    }
  }
}

// ── Helpers ───────────────────────────────────────────────────────────────

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}
