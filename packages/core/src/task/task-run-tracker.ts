import type { Store } from '../db/store.js';
import type { EventBus } from '../events/event-bus.js';
import type { Task } from '../types/project.js';

export interface TaskRunTrackerConfig {
  store: Store;
  eventBus: EventBus;
}

/**
 * TaskRunTracker connects pipeline run lifecycle events to task status updates.
 * 
 * When a run completes or fails:
 * 1. Find the associated task via runId
 * 2. Update task status (done/failed)
 * 3. Update task_runs history
 * 4. Move task to appropriate kanban column
 * 5. Recompute readiness for dependent tasks
 * 6. Publish task lifecycle events
 */
export class TaskRunTracker {
  private store: Store;
  private eventBus: EventBus;
  private unsubscribers: (() => void)[] = [];
  
  constructor(config: TaskRunTrackerConfig) {
    this.store = config.store;
    this.eventBus = config.eventBus;
  }
  
  /**
   * Start listening for run completion events.
   * Note: This doesn't subscribe to Redis streams yet, as we'll wire it directly
   * from PipelineEngine for now. Future versions could use global event stream.
   */
  async start(): Promise<void> {
    console.log('[TaskRunTracker] Starting...');
    // TODO: Subscribe to global run completion events when available
  }
  
  async stop(): Promise<void> {
    this.unsubscribers.forEach(unsub => unsub());
    this.unsubscribers = [];
    console.log('[TaskRunTracker] Stopped');
  }
  
  /**
   * Handle successful run completion.
   * Updates task to 'done' status and cascades readiness to dependents.
   */
  async handleRunCompleted(runId: string, outputs: Record<string, string>): Promise<void> {
    console.log(`[TaskRunTracker] Run completed: ${runId}`);
    
    // 1. Find task associated with this run
    let task;
    try {
      task = await this.store.getTaskByRunId(runId);
    } catch (err) {
      // Handle any unexpected errors when looking up task
      if (err instanceof Error && err.message.includes('404')) {
        console.log(`[TaskRunTracker] No task found for run ${runId}, skipping`);
        return;
      }
      console.error(`[TaskRunTracker] Error looking up task for run ${runId}:`, err);
      throw err;
    }
    
    if (!task) {
      console.log(`[TaskRunTracker] No task associated with run ${runId}, skipping`);
      return;
    }
    
    console.log(`[TaskRunTracker] Updating task ${task.id} to done`);
    
    const now = Date.now();
    
    // 2. Update task status
    await this.store.updateTask(task.projectId, task.id, {
      status: 'done',
      runId: null,  // Clear active run reference
      completedAt: now,
      updatedAt: now,
    });
    
    // 3. Update task_runs history
    await this.store.updateTaskRun(task.id, runId, {
      status: 'completed',
      completedAt: now,
    });
    
    // 4. Move to Done column
    const columns = await this.store.getColumnsByProject(task.projectId);
    const doneColumn = columns.find(c => c.taskStatuses.includes('done'));
    if (doneColumn) {
      await this.store.moveTask(task.projectId, task.id, doneColumn.id, 0);
    } else {
      console.warn(`[TaskRunTracker] No 'done' column found for project ${task.projectId}`);
    }
    
    // 5. Recompute readiness for dependents
    await this.store.recomputeTaskReadiness(task.projectId, task.id, 'done');
    
    // 6. Publish event for dashboard
    await this.eventBus.publish('djinnbot:events:global', {
      type: 'TASK_COMPLETED' as any, // Extended event type
      projectId: task.projectId,
      taskId: task.id,
      runId,
      timestamp: now,
    } as any);
    
    console.log(`[TaskRunTracker] Task ${task.id} marked as done`);
  }
  
  /**
   * Handle run failure.
   * Updates task to 'failed' status and cascades blocking to dependents.
   */
  async handleRunFailed(runId: string, error: string): Promise<void> {
    console.log(`[TaskRunTracker] Run failed: ${runId} - ${error}`);
    
    let task;
    try {
      task = await this.store.getTaskByRunId(runId);
    } catch (err) {
      // Handle any unexpected errors when looking up task
      if (err instanceof Error && err.message.includes('404')) {
        console.log(`[TaskRunTracker] No task found for run ${runId}, skipping`);
        return;
      }
      console.error(`[TaskRunTracker] Error looking up task for run ${runId}:`, err);
      throw err;
    }
    
    if (!task) {
      console.log(`[TaskRunTracker] No task associated with run ${runId}, skipping`);
      return;
    }
    
    console.log(`[TaskRunTracker] Updating task ${task.id} to failed`);
    
    const now = Date.now();
    
    // Update task status
    await this.store.updateTask(task.projectId, task.id, {
      status: 'failed',
      runId: null,
      updatedAt: now,
    });
    
    // Update task_runs history
    await this.store.updateTaskRun(task.id, runId, {
      status: 'failed',
      completedAt: now,
      error,
    });
    
    // Move to Failed column
    const columns = await this.store.getColumnsByProject(task.projectId);
    const failedColumn = columns.find(c => c.taskStatuses.includes('failed'));
    if (failedColumn) {
      await this.store.moveTask(task.projectId, task.id, failedColumn.id, 0);
    } else {
      console.warn(`[TaskRunTracker] No 'failed' column found for project ${task.projectId}`);
    }
    
    // Recompute (cascade blocking to dependents)
    await this.store.recomputeTaskReadiness(task.projectId, task.id, 'failed');
    
    // Publish event
    await this.eventBus.publish('djinnbot:events:global', {
      type: 'TASK_FAILED' as any, // Extended event type
      projectId: task.projectId,
      taskId: task.id,
      runId,
      error,
      timestamp: now,
    } as any);
    
    console.log(`[TaskRunTracker] Task ${task.id} marked as failed`);
  }
}
