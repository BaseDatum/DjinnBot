import { EventBus } from '../events/event-bus.js';
import { runChannel, GLOBAL_CHANNEL } from '../events/channels.js';
import { resolveTemplate, createLoopVariables, mergeVariables } from '../pipeline/template.js';
import type { PipelineConfig, StepConfig, StepResultAction } from '../types/pipeline.js';
import type { PipelineEvent } from '../types/events.js';
import type { PipelineRun, StepExecution, LoopState, LoopItem } from '../types/state.js';

export interface PipelineEngineConfig {
  eventBus: EventBus;
  store: EngineStore;
  workspaceManager?: WorkspaceManager;
  onRunCompleted?: (runId: string, outputs: Record<string, string>) => Promise<void>;
  onRunFailed?: (runId: string, error: string) => Promise<void>;
}

// Forward declaration
interface WorkspaceManager {
  createRunWorktree(projectId: string, runId: string, repoUrl?: string): { projectPath: string; runPath: string; branch: string };
  createRunWorktreeAsync(projectId: string, runId: string, repoUrl?: string, taskBranch?: string): Promise<{ projectPath: string; runPath: string; branch: string }>;
  ensureRunWorkspace(runId: string): string;
  getRunPath(runId: string): string | null;
  /**
   * Push the run's task branch to remote, then remove the worktree.
   * No merge to main — that happens via PR review.
   */
  finalizeRunWorkspace(runId: string, projectId?: string): Promise<{
    pushed: boolean;
    branch?: string;
    commitHash?: string;
    pushError?: string;
  }>;
}

// Minimal store interface the engine needs
export interface EngineStore {
  getRun(runId: string): PipelineRun | null | Promise<PipelineRun | null>;
  updateRun(runId: string, updates: Partial<PipelineRun>): void;
  createRun(run: Omit<PipelineRun, 'createdAt' | 'updatedAt'>): PipelineRun;
  getStep(runId: string, stepId: string): StepExecution | null;
  createStep(step: Omit<StepExecution, 'startedAt' | 'completedAt'>): StepExecution;
  updateStep(runId: string, stepId: string, updates: Partial<StepExecution>): void;
  getOutputs(runId: string): Record<string, string>;
  setOutput(runId: string, stepId: string, key: string, value: string): void;
  // Loop operations
  getLoopState(runId: string, stepId: string): LoopState | null;
  createLoopState(state: LoopState): void;
  updateLoopItem(runId: string, stepId: string, itemId: string, updates: Partial<LoopItem>): void;
  advanceLoop(runId: string, stepId: string): LoopItem | null;
}

export class PipelineEngine {
  private eventBus: EventBus;
  private store: EngineStore;
  private config: PipelineEngineConfig;
  private workspaceManager?: WorkspaceManager;
  private pipelines: Map<string, PipelineConfig> = new Map();
  private unsubscribers: Map<string, () => void> = new Map();
  private activeRuns: Set<string> = new Set();

  constructor(config: PipelineEngineConfig) {
    this.config = config;
    this.eventBus = config.eventBus;
    this.store = config.store;
    this.workspaceManager = config.workspaceManager;
    this.setupRedisErrorHandlers();
  }

  // Register a pipeline config
  registerPipeline(config: PipelineConfig): void {
    this.pipelines.set(config.id, config);
    console.log(`[PipelineEngine] Registered pipeline: ${config.id} (${config.name})`);
  }

  // Start a new pipeline run
   async startRun(
    pipelineId: string, 
    taskDescription: string, 
    humanContext?: string, 
    projectId?: string,
    repoUrl?: string,
    taskBranch?: string,
    /** DjinnBot user whose API keys are used for this run (per-user key resolution). */
    userId?: string,
  ): Promise<string> {
    const pipeline = this.pipelines.get(pipelineId);
    if (!pipeline) {
      throw new Error(`Pipeline not found: ${pipelineId}`);
    }

    if (pipeline.steps.length === 0) {
      throw new Error(`Pipeline ${pipelineId} has no steps`);
    }

    const runId = `run_${Date.now()}_${Math.random().toString(36).slice(2, 11)}`;
    const now = Date.now();

    // Create the run record
    const run: PipelineRun = {
      id: runId,
      pipelineId,
      projectId,
      taskBranch,
      taskDescription,
      status: 'pending',
      outputs: {},
      currentStepId: null,
      createdAt: now,
      updatedAt: now,
      completedAt: null,
      humanContext,
      userId,
    };

    // Store the run (implementation depends on store)
    this.store.createRun(run);

    // Setup workspace — must succeed before any steps are queued.
    if (this.workspaceManager) {
      try {
        await this.setupRunWorkspace(runId, projectId, repoUrl, taskBranch);
      } catch (wsErr) {
        const wsError = `Workspace setup failed: ${wsErr instanceof Error ? wsErr.message : String(wsErr)}`;
        console.error(`[PipelineEngine] ${wsError}`);
        this.store.updateRun(runId, { status: 'failed', updatedAt: now, completedAt: now });
        await this.eventBus.publish(runChannel(runId), {
          type: 'RUN_FAILED', runId, error: wsError, timestamp: now,
        });
        if (this.config.onRunFailed) await this.config.onRunFailed(runId, wsError);
        throw new Error(wsError);
      }
    }

    // Publish RUN_CREATED event
    await this.eventBus.publish(runChannel(runId), {
      type: 'RUN_CREATED',
      runId,
      pipelineId,
      taskDescription,
      timestamp: now,
    });

    // Subscribe to events for this run
    this.subscribeToRun(runId);

    // Queue the first step
    const firstStep = pipeline.steps[0];
    await this.queueStep(runId, firstStep.id, humanContext);

    console.log(`[PipelineEngine] Started run ${runId} for pipeline ${pipelineId}`);
    return runId;
  }

  /**
   * Setup workspace for a run — must succeed before any steps are queued.
   *
   * For project runs: creates a git worktree at RUNS_DIR/{runId} on the task's
   * persistent branch (feat/{taskId}) or an ephemeral run/{runId} branch if no
   * taskBranch is specified.  Multiple runs on the same task share the same branch.
   *
   * For standalone runs: initialises an independent empty git repo at RUNS_DIR/{runId}.
   *
   * Throws on failure so the caller can fail the run with a clear error rather than
   * silently letting agents start without a valid workspace.
   */
  private async setupRunWorkspace(runId: string, projectId?: string, repoUrl?: string, taskBranch?: string): Promise<void> {
    if (!this.workspaceManager) return;

    if (projectId) {
      // Project-associated run — use async path so GitHub App tokens work.
      const workspaceInfo = await this.workspaceManager.createRunWorktreeAsync(projectId, runId, repoUrl, taskBranch);
      console.log(`[PipelineEngine] Created project worktree for run ${runId}:`);
      console.log(`  - Project: ${workspaceInfo.projectPath}`);
      console.log(`  - Run:     ${workspaceInfo.runPath}`);
      console.log(`  - Branch:  ${workspaceInfo.branch}${taskBranch ? ' (task branch — shared across runs)' : ' (ephemeral run branch)'}`);
    } else {
      // Standalone run — independent git repo
      const runPath = this.workspaceManager.ensureRunWorkspace(runId);
      console.log(`[PipelineEngine] Created standalone workspace for run ${runId}: ${runPath}`);
    }
  }

  // Resume an existing run (created by API) without creating a new one
  async resumeRun(runId: string, repoUrl?: string): Promise<void> {
    // Idempotency guard — prevent double execution from concurrent resume paths
    if (this.activeRuns.has(runId)) {
      console.log(`[PipelineEngine] Run ${runId} already active, skipping duplicate resume`);
      return;
    }

    const run = await this.store.getRun(runId);
    if (!run) {
      throw new Error(`Run ${runId} not found`);
    }

    // Allow resuming from pending or running state (running = crashed mid-execution)
    if (run.status !== 'pending' && run.status !== 'running') {
      throw new Error(`Run ${runId} is not in a resumable state: ${run.status}`);
    }

    this.activeRuns.add(runId);

    const pipeline = this.pipelines.get(run.pipelineId);
    if (!pipeline) {
      throw new Error(`Pipeline not found: ${run.pipelineId}`);
    }

    if (pipeline.steps.length === 0) {
      throw new Error(`Pipeline ${run.pipelineId} has no steps`);
    }

    const now = Date.now();

    // Ensure workspace exists — only creates if missing (idempotent).
    try {
      await this.setupRunWorkspace(runId, run.projectId, repoUrl, run.taskBranch);
    } catch (wsErr) {
      const wsError = `Workspace setup failed on resume: ${wsErr instanceof Error ? wsErr.message : String(wsErr)}`;
      console.error(`[PipelineEngine] ${wsError}`);
      this.store.updateRun(runId, { status: 'failed', updatedAt: now, completedAt: now });
      await this.eventBus.publish(runChannel(runId), {
        type: 'RUN_FAILED', runId, error: wsError, timestamp: now,
      });
      if (this.config.onRunFailed) await this.config.onRunFailed(runId, wsError);
      this.activeRuns.delete(runId);
      return;
    }

    // Update run to running status
    this.store.updateRun(runId, {
      status: 'running',
      updatedAt: now,
    });

    // Publish RUN_CREATED event for logging/monitoring
    await this.eventBus.publish(runChannel(runId), {
      type: 'RUN_CREATED',
      runId,
      pipelineId: run.pipelineId,
      taskDescription: run.taskDescription,
      timestamp: now,
    });

    // Subscribe to events for this run
    this.subscribeToRun(runId);

    // Find the right step to resume from:
    // 1. Look for any step in 'queued' or 'running' state (was interrupted)
    // 2. Find the first step whose onComplete target hasn't been started
    // 3. Fall back to the first step
    let resumeStep = pipeline.steps[0];

    // Check for queued/running steps (interrupted execution)
    for (const stepConfig of pipeline.steps) {
      const step = this.store.getStep(runId, stepConfig.id);
      if (step && (step.status === 'queued' || step.status === 'running')) {
        resumeStep = stepConfig;
        // Reset running steps back to queued so they re-execute cleanly
        if (step.status === 'running') {
          this.store.updateStep(runId, stepConfig.id, {
            status: 'queued',
            startedAt: undefined as any,
            sessionId: undefined as any,
          });
        }
        console.log(`[PipelineEngine] Resuming from interrupted step: ${stepConfig.id} (was ${step.status})`);
        break;
      }
    }

    // If no interrupted step found, find first non-completed step
    if (resumeStep === pipeline.steps[0]) {
      const firstStep = this.store.getStep(runId, pipeline.steps[0].id);
      if (firstStep && firstStep.status === 'completed') {
        // First step already done, find the next incomplete one
        for (const stepConfig of pipeline.steps) {
          const step = this.store.getStep(runId, stepConfig.id);
          if (!step || step.status === 'pending' || step.status === 'queued') {
            resumeStep = stepConfig;
            console.log(`[PipelineEngine] Resuming from next pending step: ${stepConfig.id}`);
            break;
          }
        }
      }
    }

    await this.queueStep(runId, resumeStep.id, run.humanContext || undefined);

    console.log(`[PipelineEngine] Resumed run ${runId} for pipeline ${run.pipelineId} at step ${resumeStep.id}`);
  }

  // Subscribe to events for a specific run
  private subscribeToRun(runId: string): void {
    if (this.unsubscribers.has(runId)) {
      return; // Already subscribed
    }

    const unsubscribe = this.eventBus.subscribe(runChannel(runId), async (event) => {
      await this.handleEvent(runId, event);
    });

    this.unsubscribers.set(runId, unsubscribe);
  }

  // Handle incoming events for a run
  private async handleEvent(runId: string, event: PipelineEvent): Promise<void> {
    // Handle stop/cancellation events BEFORE checking if run exists in DB
    // This ensures we can stop agents even if the run was already deleted
    if (event.type === 'HUMAN_INTERVENTION' && event.action === 'stop') {
      console.log(`[PipelineEngine] Received stop request for run ${runId}`);
      // Try to cancel current step if we have one
      if (event.stepId) {
        const step = this.store.getStep(runId, event.stepId);
        if (step) {
          await this.cancelStep(runId, event.stepId, `Human stop: ${event.context}`);
        }
      }
      // Update run status if it still exists
      const existingRun = await this.store.getRun(runId);
      if (existingRun) {
        this.store.updateRun(runId, {
          status: 'cancelled',
          updatedAt: Date.now(),
          completedAt: Date.now(),
        });
      }
      // Always publish RUN_FAILED to ensure agent gets abort signal
      await this.eventBus.publish(runChannel(runId), {
        type: 'RUN_FAILED',
        runId,
        error: `Run stopped by human: ${event.context}`,
        timestamp: Date.now(),
      });
      this.stopRun(runId);
      return;
    }

    // Handle RUN_DELETED event - agent should stop immediately
    if (event.type === 'RUN_DELETED' as any) {
      console.log(`[PipelineEngine] Run ${runId} was deleted, stopping`);
      await this.eventBus.publish(runChannel(runId), {
        type: 'RUN_FAILED',
        runId,
        error: 'Run deleted',
        timestamp: Date.now(),
      });
      this.stopRun(runId);
      return;
    }

    const run = await this.store.getRun(runId);
    if (!run) {
      console.error(`[PipelineEngine] Run not found: ${runId}`);
      return;
    }

    const pipeline = this.pipelines.get(run.pipelineId);
    if (!pipeline) {
      console.error(`[PipelineEngine] Pipeline not found: ${run.pipelineId}`);
      return;
    }

    switch (event.type) {
      case 'STEP_STARTED': {
        const step = this.store.getStep(runId, event.stepId);
        if (step) {
          this.store.updateStep(runId, event.stepId, {
            status: 'running',
            sessionId: event.sessionId,
            startedAt: event.timestamp,
          });
          this.store.updateRun(runId, {
            currentStepId: event.stepId,
            status: 'running',
            updatedAt: event.timestamp,
          });
          // Publish to global channel for server DB sync
          await this.eventBus.publish(GLOBAL_CHANNEL, event);
        }
        break;
      }

      case 'STEP_OUTPUT': {
        // Step output is logged but doesn't change state
        // Could be used for streaming updates to UI
        break;
      }

      case 'STEP_COMPLETE': {
        const step = this.store.getStep(runId, event.stepId);
        if (!step) {
          console.error(`[PipelineEngine] Step not found: ${event.stepId}`);
          return;
        }

        // Update step with outputs
        this.store.updateStep(runId, event.stepId, {
          status: 'completed',
          outputs: event.outputs,
          completedAt: event.timestamp,
        });

        // Store ALL outputs for template resolution in subsequent steps.
        // await Promise.resolve() to handle both sync (local Store) and
        // async (ApiStore) implementations without changing the interface.
        const stepConfig = pipeline.steps.find(s => s.id === event.stepId);
        for (const [key, value] of Object.entries(event.outputs)) {
          if (value !== undefined && value !== '') {
            await Promise.resolve(this.store.setOutput(runId, event.stepId, key, value));
          }
        }

        // Publish to global channel for server DB sync
        await this.eventBus.publish(GLOBAL_CHANNEL, event);

        // Handle result routing and next steps
        await this.handleStepResult(runId, stepConfig!, event.outputs);
        break;
      }

      case 'STEP_FAILED': {
        const step = this.store.getStep(runId, event.stepId);
        if (!step) {
          console.error(`[PipelineEngine] Step not found: ${event.stepId}`);
          return;
        }

        const stepConfig = pipeline.steps.find(s => s.id === event.stepId);
        const maxRetries = stepConfig?.maxRetries ?? pipeline.defaults.maxRetries ?? 3;

        if (step.retryCount < maxRetries) {
          // Retry the step
          this.store.updateStep(runId, event.stepId, {
            status: 'retrying',
            retryCount: step.retryCount + 1,
            error: event.error,
          });

          await this.eventBus.publish(runChannel(runId), {
            type: 'STEP_RETRYING',
            runId,
            stepId: event.stepId,
            feedback: `Retry ${step.retryCount + 1}/${maxRetries} after error: ${event.error}`,
            timestamp: Date.now(),
          });

          // Re-queue the step with retry context
          const retryContext = `${step.humanContext || ''}\n\n[RETRY ${step.retryCount + 1}/${maxRetries}] Previous attempt failed: ${event.error}`;
          await this.queueStep(runId, event.stepId, retryContext);
        } else {
          // Max retries exceeded, fail the run
          this.store.updateStep(runId, event.stepId, {
            status: 'failed',
            error: event.error,
            completedAt: event.timestamp,
          });

          this.store.updateRun(runId, {
            status: 'failed',
            updatedAt: event.timestamp,
            completedAt: event.timestamp,
          });

          // Publish step failure to global channel for server DB sync
          await this.eventBus.publish(GLOBAL_CHANNEL, event);

          await this.eventBus.publish(runChannel(runId), {
            type: 'RUN_FAILED',
            runId,
            error: `Step ${event.stepId} failed after ${maxRetries} retries: ${event.error}`,
            timestamp: Date.now(),
          });

          this.stopRun(runId);
        }
        break;
      }

      case 'STEP_CANCELLED': {
        const step = this.store.getStep(runId, event.stepId);
        if (step) {
          this.store.updateStep(runId, event.stepId, {
            status: 'cancelled',
            completedAt: event.timestamp,
          });
        }
        break;
      }

      case 'HUMAN_INTERVENTION': {
        // Note: 'stop' action is handled earlier in this function before run existence check
        switch (event.action) {
          case 'restart': {
            const step = this.store.getStep(runId, event.stepId);
            if (!step) {
              console.error(`[PipelineEngine] Step not found for restart: ${event.stepId}`);
              return;
            }
            // Cancel current step and re-queue with additional context
            await this.cancelStep(runId, event.stepId, 'Human restart requested');
            const newContext = `${step.humanContext || ''}\n\n[HUMAN RESTART] ${event.context}`;
            await this.queueStep(runId, event.stepId, newContext);
            break;
          }
          case 'inject_context': {
            const injectStep = this.store.getStep(runId, event.stepId);
            if (!injectStep) {
              console.error(`[PipelineEngine] Step not found for inject_context: ${event.stepId}`);
              return;
            }
            // Update step with additional context but don't restart
            const updatedContext = `${injectStep.humanContext || ''}\n\n[ADDITIONAL CONTEXT] ${event.context}`;
            this.store.updateStep(runId, event.stepId, {
              humanContext: updatedContext,
            });
            break;
          }
        }
        break;
      }

      default:
        // Ignore other event types
        break;
    }
  }

  // Handle step completion with result routing (PASS/FAIL etc)
  private async handleStepResult(
    runId: string,
    stepConfig: StepConfig,
    outputs: Record<string, string>
  ): Promise<void> {
    const run = await this.store.getRun(runId);
    if (!run) return;

    const pipeline = this.pipelines.get(run.pipelineId);
    if (!pipeline) return;

    // Check if this is a loop step (by explicit type or presence of loop config)
    if ((stepConfig.type === 'loop' || stepConfig.loop) && stepConfig.loop) {
      await this.handleLoopAdvance(runId, stepConfig, outputs);
      return;
    }

    // Check for result-based routing
    if (stepConfig.onResult) {
      // Check each output value against the onResult routing table
      for (const [outputKey, outputValue] of Object.entries(outputs)) {
        const normalizedValue = outputValue.trim().toUpperCase();
        // Check if this output value matches any onResult key
        for (const [resultKey, action] of Object.entries(stepConfig.onResult)) {
          if (normalizedValue === resultKey.toUpperCase() || outputValue.trim() === resultKey) {
            await this.executeResultAction(runId, stepConfig, action, outputs);
            return;
          }
        }
      }
    }

    // Default: follow onComplete
    if (stepConfig.onComplete) {
      await this.advancePipeline(runId, stepConfig.id, outputs);
    } else {
      // No next step - check if this was the last step
      const stepIndex = pipeline.steps.findIndex(s => s.id === stepConfig.id);
      if (stepIndex === pipeline.steps.length - 1) {
        // Last step completed
        await this.completeRun(runId, outputs);
      } else {
        // Not the last step but no onComplete - this is a config error
        console.error(`[PipelineEngine] Step ${stepConfig.id} has no onComplete and is not the last step`);
        await this.failRun(runId, `Step ${stepConfig.id} has no onComplete configured`);
      }
    }
  }

  // Execute a result-based action
  private async executeResultAction(
    runId: string,
    stepConfig: StepConfig,
    action: StepResultAction,
    outputs: Record<string, string>
  ): Promise<void> {
    const run = await this.store.getRun(runId);
    if (!run) return;

    const pipeline = this.pipelines.get(run.pipelineId);
    if (!pipeline) return;

    // Handle goto
    if (action.goto) {
      const nextStep = pipeline.steps.find(s => s.id === action!.goto);
      if (nextStep) {
        await this.queueStep(runId, nextStep.id, run.humanContext);
      } else {
        console.error(`[PipelineEngine] goto step ${action.goto} not found`);
        await this.failRun(runId, `goto step ${action.goto} not found`);
      }
      return;
    }

    // Handle retry
    if (action.retry) {
      const step = this.store.getStep(runId, stepConfig.id);
      if (step) {
        const maxRetries = action.maxRetries ?? step.maxRetries;
        if (step.retryCount < maxRetries) {
          this.store.updateStep(runId, stepConfig.id, {
            status: 'retrying',
            retryCount: step.retryCount + 1,
          });

          await this.eventBus.publish(runChannel(runId), {
            type: 'STEP_RETRYING',
            runId,
            stepId: stepConfig.id,
            feedback: `Retry ${step.retryCount + 1}/${maxRetries} based on result action`,
            timestamp: Date.now(),
          });

          // Re-queue with feedback context
          const retryContext = `${run.humanContext || ''}\n\n[RESULT RETRY ${step.retryCount + 1}/${maxRetries}] Result action triggered retry`;
          await this.queueStep(runId, stepConfig.id, retryContext);
        } else {
          await this.failRun(runId, `Max retries exceeded for step ${stepConfig.id}`);
        }
      }
      return;
    }

    // Handle notify
    if (action.notify) {
      await this.eventBus.publish(runChannel(runId), {
        type: 'AGENT_MESSAGE',
        runId,
        from: 'system',
        to: action.notify.agent,
        message: action.notify.message,
        threadId: `${runId}_notification`,
        timestamp: Date.now(),
      });
    }

    // Handle continueLoop — advance the parent loop step, not the current step
    if (action.continueLoop) {
      // Find the active loop step for this run by checking which step has loop state
      const loopStep = pipeline.steps.find(s => {
        if (!s.loop) return false;
        const loopState = this.store.getLoopState(runId, s.id);
        return loopState !== null;
      });
      if (loopStep) {
        await this.handleLoopAdvance(runId, loopStep, outputs, true);
      } else {
        console.error(`[PipelineEngine] continueLoop: no active loop found for run ${runId}`);
      }
    }
  }

  // Handle loop step advancement
  // skipOnEachComplete: true when called from continueLoop (we're returning FROM onEachComplete)
  private async handleLoopAdvance(
    runId: string,
    stepConfig: StepConfig,
    itemOutputs: Record<string, string>,
    skipOnEachComplete = false
  ): Promise<void> {
    const run = await this.store.getRun(runId);
    if (!run) return;

    const pipeline = this.pipelines.get(run.pipelineId);
    if (!pipeline) return;

    if (!stepConfig.loop) {
      console.error(`[PipelineEngine] Step ${stepConfig.id} is not a loop step`);
      return;
    }

    // Get or create loop state
    let loopState = this.store.getLoopState(runId, stepConfig.id);

    if (!loopState) {
      // First time entering this loop - initialize
      if (!stepConfig.loop.over) {
        console.error(`[PipelineEngine] Loop step ${stepConfig.id} missing required 'over' variable name`);
        await this.failRun(runId, `Loop step ${stepConfig.id} missing required 'over' variable in configuration`);
        return;
      }

      const outputs = await Promise.resolve(this.store.getOutputs(runId));
      if (!outputs) {
        console.error(`[PipelineEngine] Failed to retrieve outputs for run ${runId}`);
        await this.failRun(runId, `Failed to retrieve outputs for run ${runId}`);
        return;
      }

      const overData = outputs[stepConfig.loop.over];

      if (!overData) {
        console.error(`[PipelineEngine] Loop variable ${stepConfig.loop.over} not found in outputs [${Object.keys(outputs).join(', ')}]`);
        await this.failRun(runId, `Loop variable ${stepConfig.loop.over} not found`);
        return;
      }

      let items: string[];
      try {
        items = JSON.parse(overData);
        if (!Array.isArray(items)) {
          throw new Error('Not an array');
        }
      } catch (err) {
        console.error(`[PipelineEngine] Loop variable ${stepConfig.loop.over} is not a valid JSON array`);
        await this.failRun(runId, `Loop variable ${stepConfig.loop.over} is not a valid JSON array`);
        return;
      }

      const loopItems: LoopItem[] = items.map((item, index) => ({
        id: `${stepConfig.id}_item_${index}`,
        index,
        data: typeof item === 'string' ? item : JSON.stringify(item),
        status: 'pending' as const,
        retryCount: 0,
        output: null,
      }));

      loopState = {
        runId,
        stepId: stepConfig.id,
        items: loopItems,
        currentIndex: 0,
      };

      this.store.createLoopState(loopState);
      console.log(`[PipelineEngine] Initialized loop for ${stepConfig.id} with ${loopItems.length} items`);
    } else {
      // Mark current item as done
      const currentItem = loopState.items[loopState.currentIndex];
      if (currentItem) {
        this.store.updateLoopItem(runId, stepConfig.id, currentItem.id, {
          status: 'completed',
          output: JSON.stringify(itemOutputs),
        });
      }
    }

    // Check if onEachComplete exists (e.g., review/test after each item)
    // Skip if we're returning from onEachComplete (continueLoop)
    if (!skipOnEachComplete && stepConfig.loop.onEachComplete) {
      const reviewStep = pipeline.steps.find(s => s.id === stepConfig.loop!.onEachComplete);
      if (reviewStep) {
        await this.queueStep(runId, reviewStep.id, undefined);
        return;
      }
    }

    // Advance to next item
    const nextItem = this.store.advanceLoop(runId, stepConfig.id);
    if (nextItem) {
      // More items to process
      const loopState = this.store.getLoopState(runId, stepConfig.id);
      const totalItems = loopState?.items.length ?? 0;
      const currentIndex = nextItem.index + 1;
      console.log(`[PipelineEngine] Loop ${stepConfig.id}: advancing to item ${currentIndex}/${totalItems}`);
      await this.queueStep(runId, stepConfig.id, undefined);
    } else {
      // All items done
      console.log(`[PipelineEngine] Loop ${stepConfig.id}: all items complete`);

      if (stepConfig.loop.onAllComplete) {
        const nextStep = pipeline.steps.find(s => s.id === stepConfig.loop!.onAllComplete);
        if (nextStep) {
          await this.queueStep(runId, nextStep.id, undefined);
          return;
        }
      }

      // Follow onComplete if no onAllComplete
      if (stepConfig.onComplete) {
        await this.advancePipeline(runId, stepConfig.id, itemOutputs);
      } else {
        await this.completeRun(runId, itemOutputs);
      }
    }
  }

  // Advance pipeline to the next step
  private async advancePipeline(
    runId: string,
    completedStepId: string,
    outputs: Record<string, string>
  ): Promise<void> {
    const run = await this.store.getRun(runId);
    if (!run) return;

    const pipeline = this.pipelines.get(run.pipelineId);
    if (!pipeline) return;

    const stepConfig = pipeline.steps.find(s => s.id === completedStepId);
    if (!stepConfig?.onComplete) {
      console.error(`[PipelineEngine] No onComplete for step ${completedStepId}`);
      return;
    }

    const nextStep = pipeline.steps.find(s => s.id === stepConfig.onComplete);
    if (!nextStep) {
      console.error(`[PipelineEngine] Next step ${stepConfig.onComplete} not found`);
      await this.failRun(runId, `Next step ${stepConfig.onComplete} not found`);
      return;
    }

    await this.queueStep(runId, nextStep.id, run.humanContext);
  }

  // Queue a step for execution
  private async queueStep(runId: string, stepId: string, humanContext?: string): Promise<void> {
    const run = await this.store.getRun(runId);
    if (!run) return;

    const pipeline = this.pipelines.get(run.pipelineId);
    if (!pipeline) return;

    const stepConfig = pipeline.steps.find(s => s.id === stepId);
    if (!stepConfig) {
      console.error(`[PipelineEngine] Step config not found: ${stepId}`);
      return;
    }

    // Check if step already exists (retry case)
    let step = await this.store.getStep(runId, stepId);
    if (!step) {
      step = await this.store.createStep({
        id: `${runId}_${stepId}`,
        runId,
        stepId,
        agentId: stepConfig.agent,
        status: 'queued',
        sessionId: null,
        inputs: {},
        outputs: {},
        error: null,
        retryCount: 0,
        maxRetries: stepConfig.maxRetries ?? pipeline.defaults.maxRetries ?? 3,
        humanContext: humanContext ?? null,
      });
    } else {
      await this.store.updateStep(runId, stepId, {
        status: 'queued',
        humanContext: humanContext ?? step.humanContext,
      });
    }

    // Publish STEP_QUEUED event
    await this.eventBus.publish(runChannel(runId), {
      type: 'STEP_QUEUED',
      runId,
      stepId,
      agentId: stepConfig.agent,
      timestamp: Date.now(),
    });

    console.log(`[PipelineEngine] Queued step ${stepId} (agent: ${stepConfig.agent}) for run ${runId}`);
  }

  // Cancel a running step
  async cancelStep(runId: string, stepId: string, reason: string): Promise<void> {
    this.store.updateStep(runId, stepId, {
      status: 'cancelled',
      error: reason,
      completedAt: Date.now(),
    });

    await this.eventBus.publish(runChannel(runId), {
      type: 'STEP_CANCELLED',
      runId,
      stepId,
      reason,
      timestamp: Date.now(),
    });

    console.log(`[PipelineEngine] Cancelled step ${stepId}: ${reason}`);
  }

  // Restart a step with additional context
  async restartStep(runId: string, stepId: string, additionalContext: string): Promise<void> {
    await this.cancelStep(runId, stepId, 'Restarting with additional context');
    const step = this.store.getStep(runId, stepId);
    const newContext = `${step?.humanContext || ''}\n\n[RESTART] ${additionalContext}`;
    await this.queueStep(runId, stepId, newContext);
  }

  // Complete a run
  private async completeRun(runId: string, lastStepOutputs: Record<string, string>): Promise<void> {
    const now = Date.now();
    
    // Merge ALL accumulated outputs from all steps, not just the last step.
    // await Promise.resolve() handles both sync and async store implementations.
    const allOutputs = { ...await Promise.resolve(this.store.getOutputs(runId)), ...lastStepOutputs };
    
    this.store.updateRun(runId, {
      status: 'completed',
      outputs: allOutputs,
      updatedAt: now,
      completedAt: now,
    });

    const completeEvent = {
      type: 'RUN_COMPLETE' as const,
      runId,
      outputs: allOutputs,
      timestamp: now,
    };
    await this.eventBus.publish(runChannel(runId), completeEvent);
    await this.eventBus.publish(GLOBAL_CHANNEL, completeEvent);

    // Finalize workspace: push the task branch to remote, then remove the worktree.
    // No merge to main — agents open PRs which are reviewed and merged separately.
    // Run after publishing RUN_COMPLETE so the dashboard updates immediately.
    if (this.workspaceManager) {
      const run = await this.store.getRun(runId);
      try {
        const result = await this.workspaceManager.finalizeRunWorkspace(runId, run?.projectId);
        if (result.pushed) {
          console.log(`[PipelineEngine] Pushed branch ${result.branch} for run ${runId} (${result.commitHash?.slice(0, 8)})`);
        } else if (result.pushError) {
          // Non-fatal — work is committed locally; push can be retried by the agent
          console.warn(`[PipelineEngine] Push failed for run ${runId}: ${result.pushError}`);
          await this.eventBus.publish(runChannel(runId), {
            type: 'COMMIT_FAILED',
            runId,
            stepId: 'finalize',
            error: `Push failed: ${result.pushError}`,
            timestamp: Date.now(),
          });
        }
      } catch (err) {
        // Non-fatal — run is already marked completed
        console.error(`[PipelineEngine] finalizeRunWorkspace threw for run ${runId}:`, err);
      }
    }

    // Notify task tracker
    if (this.config.onRunCompleted) {
      await this.config.onRunCompleted(runId, allOutputs);
    }

    this.stopRun(runId);
    console.log(`[PipelineEngine] Run ${runId} completed`);
  }

  // Fail a run
  private async failRun(runId: string, error: string): Promise<void> {
    const now = Date.now();
    this.store.updateRun(runId, {
      status: 'failed',
      updatedAt: now,
      completedAt: now,
    });

    const failEvent = {
      type: 'RUN_FAILED' as const,
      runId,
      error,
      timestamp: now,
    };
    await this.eventBus.publish(runChannel(runId), failEvent);
    await this.eventBus.publish(GLOBAL_CHANNEL, failEvent);

    // Notify task tracker
    if (this.config.onRunFailed) {
      await this.config.onRunFailed(runId, error);
    }

    this.stopRun(runId);
    console.log(`[PipelineEngine] Run ${runId} failed: ${error}`);
  }

  // Stop listening for a run
  stopRun(runId: string): void {
    const unsub = this.unsubscribers.get(runId);
    if (unsub) {
      unsub();
      this.unsubscribers.delete(runId);
    }
    this.activeRuns.delete(runId);
  }

  // Setup Redis error handlers
  private setupRedisErrorHandlers(): void {
    // Note: EventBus has its own error handlers for the Redis connections.
    // This method is a placeholder for any additional PipelineEngine-specific
    // Redis error handling that may be needed in the future.
    // Currently, Redis connection errors are handled at the EventBus level,
    // and PipelineEngine will be notified via REDIS_CONNECTION_ERROR events.
  }

  // Handle Redis connection loss for a specific run
  private async handleRedisConnectionLoss(runId: string, err: Error): Promise<void> {
    console.error(`[PipelineEngine] Redis connection lost for run ${runId}:`, err.message);

    // Publish REDIS_CONNECTION_ERROR event to EventBus
    try {
      await this.eventBus.publish(runChannel(runId), {
        type: 'REDIS_CONNECTION_ERROR',
        runId,
        error: err.message,
        timestamp: Date.now(),
      });
    } catch (publishErr) {
      console.error(`[PipelineEngine] Failed to publish REDIS_CONNECTION_ERROR event:`, publishErr);
    }

    // Check if run is still active
    if (!this.activeRuns.has(runId)) {
      console.log(`[PipelineEngine] Run ${runId} is not active, skipping failure marking`);
      return;
    }

    // Mark run as failed
    const run = await this.store.getRun(runId);
    if (run && (run.status === 'pending' || run.status === 'running')) {
      const now = Date.now();
      this.store.updateRun(runId, {
        status: 'failed',
        updatedAt: now,
        completedAt: now,
      });

      // Publish RUN_FAILED event
      try {
        await this.eventBus.publish(runChannel(runId), {
          type: 'RUN_FAILED',
          runId,
          error: `Redis connection error: ${err.message}`,
          timestamp: now,
        });
      } catch (publishErr) {
        console.error(`[PipelineEngine] Failed to publish RUN_FAILED event:`, publishErr);
      }

      console.log(`[PipelineEngine] Marked run ${runId} as failed due to Redis connection loss`);
    }

    // Remove from activeRuns
    this.activeRuns.delete(runId);
  }

  // Shutdown engine
  async shutdown(): Promise<void> {
    for (const [runId, unsub] of this.unsubscribers) {
      unsub();
    }
    this.unsubscribers.clear();
    this.activeRuns.clear();
    this.pipelines.clear();
    console.log('[PipelineEngine] Shutdown complete');
  }
}