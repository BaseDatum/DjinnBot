import { join } from 'node:path';
import { statSync } from 'node:fs';
import { AgentLifecycleManager } from './agent-lifecycle.js';
import { AgentLifecycleTracker } from '../lifecycle/agent-lifecycle-tracker.js';
import { EventBus } from '../events/event-bus.js';
import { runChannel } from '../events/channels.js';
import { resolveTemplate, createLoopVariables, mergeVariables } from '../pipeline/template.js';
import type { PipelineConfig, StepConfig, AgentConfig } from '../types/pipeline.js';
import type { PipelineEvent } from '../types/events.js';
import type { AgentPersona, PersonaLoader } from './persona-loader.js';
import type { ContextAssembler } from '../memory/context-assembler.js';
import type { ProgressFileManager } from '../memory/progress-file.js';
import type { AgentMemoryManager } from '../memory/agent-memory.js';
import { StructuredOutputRunner } from './structured-output-runner.js';
import type { WorkspaceManager } from './workspace-manager.js';

export interface AgentExecutorConfig {
  eventBus: EventBus;
  agentRunner: AgentRunner;
  personaLoader: PersonaLoader;
  pipelines: Map<string, PipelineConfig>;
  getOutputs: (runId: string) => Record<string, string>;
  getRunTask?: (runId: string) => string | Promise<string>;
  getRunHumanContext?: (runId: string) => string | undefined | Promise<string | undefined>;
  getRunProjectId?: (runId: string) => string | undefined | Promise<string | undefined>;
  getRunUserId?: (runId: string) => string | undefined | Promise<string | undefined>;
  getRunTaskBranch?: (runId: string) => string | undefined | Promise<string | undefined>;
  getLoopState?: (runId: string, stepId: string) => { currentIndex: number; items: Array<{ data: string; status: string }> } | null;
  contextAssembler?: ContextAssembler;
  progressFiles?: ProgressFileManager;
  agentMemoryManager?: AgentMemoryManager;
  workspaceManager?: WorkspaceManager;
  lifecycleManager?: AgentLifecycleManager;
  lifecycleTracker?: AgentLifecycleTracker;
  sessionPersister?: import('../sessions/session-persister.js').SessionPersister;
  /** API base URL forwarded to StructuredOutputRunner for DB key injection */
  apiBaseUrl?: string;
  /** Lookup the default model from an agent's config.yml (via AgentRegistry). */
  getAgentDefaultModel?: (agentId: string) => string | undefined;
  /** Lookup a run-level model override (set via dashboard task execution). */
  getRunModelOverride?: (runId: string) => string | undefined | Promise<string | undefined>;
}

// Abstract interface for running agent sessions
// Implementations: PiMonoRunner, MockRunner, etc.
export interface AgentRunner {
  // Start an agent session and return when it completes
  runAgent(options: RunAgentOptions): Promise<AgentRunResult>;
}

export interface RunAgentOptions {
  runId: string;
  stepId: string;
  agentId: string;           // Which agent persona to use
  model: string;             // LLM model to use
  systemPrompt: string;      // Assembled from persona files
  userPrompt: string;        // The resolved step input
  tools?: string[];          // Available tools for this step
  timeout?: number;          // Session timeout in ms
  workspacePath?: string;    // Agent personal workspace (used by in-process PiMonoRunner)
  /** Absolute host path to the run's git worktree — mounted as /home/agent/run-workspace in the container. */
  runWorkspacePath?: string;
  /** Absolute host path to the project's main git repo — mounted as /home/agent/project-workspace in the container. */
  projectWorkspacePath?: string;
  vaultPath?: string;        // Path to agent's ClawVault for sandbox mount
  signal?: AbortSignal;      // Abort signal for cancellation
  maxTurns?: number;         // Max agent turns before forced stop (default: 50)
  projectId?: string;        // Project ID for git worktree support in sandbox
  /** Kanban column names this agent is allowed to work from (for pulse sessions). */
  pulseColumns?: string[];
  /** Thinking level to pass to the Agent ('off'|'minimal'|'low'|'medium'|'high'|'xhigh') */
  thinkingLevel?: string;
  /** DjinnBot user ID who initiated this run — for per-user provider key resolution. */
  userId?: string;
}

export interface AgentRunResult {
  sessionId: string;
  output: string;            // Raw agent output
  success: boolean;
  error?: string;
  parsedOutputs?: Record<string, string>;  // NEW: tool-based outputs
}

/**
 * AgentExecutor listens for STEP_QUEUED events, spawns agent sessions,
 * parses outputs, and publishes STEP_COMPLETE or STEP_FAILED events.
 */
export class AgentExecutor {
  private eventBus: EventBus;
  private agentRunner: AgentRunner;
  private structuredRunner: StructuredOutputRunner;
  private personaLoader: PersonaLoader;
  private pipelines: Map<string, PipelineConfig>;
  private getOutputs: (runId: string) => Record<string, string>;
  private getRunTask?: AgentExecutorConfig['getRunTask'];
  private getRunHumanContext?: AgentExecutorConfig['getRunHumanContext'];
  private getRunProjectId?: AgentExecutorConfig['getRunProjectId'];
  private getRunUserId?: AgentExecutorConfig['getRunUserId'];
  private getRunTaskBranch?: AgentExecutorConfig['getRunTaskBranch'];
  private getLoopState?: AgentExecutorConfig['getLoopState'];
  private contextAssembler?: ContextAssembler;
  private progressFiles?: ProgressFileManager;
  private agentMemoryManager?: AgentMemoryManager;
  private unsubscribers: Map<string, () => void> = new Map();
  private activeRuns: Set<string> = new Set();
  private abortControllers: Map<string, AbortController> = new Map();
  private workspaceManager?: WorkspaceManager;
  private lifecycleManager?: AgentLifecycleManager;
  private lifecycleTracker?: AgentLifecycleTracker;
  private sessionPersister?: import('../sessions/session-persister.js').SessionPersister;
  private getAgentDefaultModel?: (agentId: string) => string | undefined;
  private getRunModelOverride?: AgentExecutorConfig['getRunModelOverride'];

  constructor(config: AgentExecutorConfig) {
    this.eventBus = config.eventBus;
    this.agentRunner = config.agentRunner;
    this.personaLoader = config.personaLoader;
    this.pipelines = config.pipelines;
    this.getOutputs = config.getOutputs;
    this.getRunTask = config.getRunTask;
    this.getRunHumanContext = config.getRunHumanContext;
    this.getRunProjectId = config.getRunProjectId;
    this.getRunUserId = config.getRunUserId;
    this.getRunTaskBranch = config.getRunTaskBranch;
    this.getLoopState = config.getLoopState;
    this.workspaceManager = config.workspaceManager;
    this.contextAssembler = config.contextAssembler;
    this.progressFiles = config.progressFiles;
    this.agentMemoryManager = config.agentMemoryManager;
    this.lifecycleManager = config.lifecycleManager;
    this.lifecycleTracker = config.lifecycleTracker;
    this.sessionPersister = config.sessionPersister;
    this.getAgentDefaultModel = config.getAgentDefaultModel;
    this.getRunModelOverride = config.getRunModelOverride;
    
    // Initialize structured output runner
    this.structuredRunner = new StructuredOutputRunner({
      apiBaseUrl: config.apiBaseUrl,
      onStreamChunk: (runId, stepId, chunk) => {
        // Emit STEP_OUTPUT event for streaming
        this.eventBus.publish(runChannel(runId), {
          type: 'STEP_OUTPUT',
          runId,
          stepId,
          chunk,
          timestamp: Date.now(),
        }).catch(err => {
          console.error(`[AgentExecutor] Failed to publish STEP_OUTPUT:`, err);
        });

        // Persist to session database
        if (this.sessionPersister) {
          this.sessionPersister.addEvent(`${runId}_${stepId}`, {
            type: 'output',
            timestamp: Date.now(),
            data: {
              stream: 'stdout',
              content: chunk,
            },
          }).catch(err => {
            console.error(`[AgentExecutor] Failed to persist output event:`, err);
          });
        }
      },
    });
  }

  /** Get the underlying agent runner (for pulse sessions, etc.) */
  getAgentRunner(): AgentRunner {
    return this.agentRunner;
  }

  /**
   * Resolve the model for a pipeline step using the precedence chain:
   *  1. Step-level model override (stepConfig.model)
   *  2. Pipeline agent model (agentConfig.model in the pipeline YAML)
   *  3. Pipeline defaults model (pipeline.defaults.model)
   *  4. Agent default model (from agent's config.yml via registry)
   *  5. Global fallback
   */
  private resolveStepModel(
    stepConfig: StepConfig,
    agentConfig: AgentConfig,
    pipeline: PipelineConfig,
    agentId: string,
    runModelOverride?: string,
  ): string {
    return (
      runModelOverride ??
      stepConfig.model ??
      agentConfig.model ??
      pipeline.defaults.model ??
      this.getAgentDefaultModel?.(agentId) ??
      'openrouter/moonshotai/kimi-k2.5'
    );
  }

  /**
   * Start the executor - subscribe to run channels for all pipelines.
   */
  start(): void {
    console.log('[AgentExecutor] Started');
  }

  /**
   * Subscribe to a specific run channel.
   * Called when a new run starts.
   */
  subscribeToRun(runId: string, pipelineId: string): void {
    if (this.unsubscribers.has(runId)) {
      return; // Already subscribed
    }

    const channel = runChannel(runId);
    const unsubscribe = this.eventBus.subscribe(channel, async (event) => {
      await this.handleEvent(runId, pipelineId, event);
    });

    this.unsubscribers.set(runId, unsubscribe);
    this.activeRuns.add(runId);
    console.log(`[AgentExecutor] Subscribed to run channel: ${channel}`);
  }

  /**
   * Unsubscribe from a run channel.
   */
  unsubscribeFromRun(runId: string): void {
    const unsub = this.unsubscribers.get(runId);
    if (unsub) {
      unsub();
      this.unsubscribers.delete(runId);
      this.activeRuns.delete(runId);
      console.log(`[AgentExecutor] Unsubscribed from run: ${runId}`);
    }
  }

  /**
   * Handle events from the event bus.
   */
  /**
   * Abort a running agent session for a specific run.
   */
  abortRun(runId: string): void {
    const controller = this.abortControllers.get(runId);
    if (controller) {
      console.log(`[AgentExecutor] Aborting agent session for run ${runId}`);
      controller.abort();
      this.abortControllers.delete(runId);
    }
  }

  private async handleEvent(
    runId: string,
    pipelineId: string,
    event: PipelineEvent
  ): Promise<void> {
    // Handle step cancellation — abort the running agent
    // Also handle RUN_DELETED as a backup (in case PipelineEngine doesn't catch it)
    if (event.type === 'STEP_CANCELLED' || event.type === 'RUN_FAILED' || (event as any).type === 'RUN_DELETED') {
      console.log(`[AgentExecutor] Aborting run ${runId} due to ${event.type}`);
      this.abortRun(runId);
      return;
    }

    // Only handle STEP_QUEUED events
    if (event.type !== 'STEP_QUEUED') {
      return;
    }

    // Validate this event is for our run
    if (event.runId !== runId) {
      return;
    }

    // Use lifecycle manager if available for concurrency control
    if (this.lifecycleManager) {
      const result = this.lifecycleManager.queueWork(event.runId, event.stepId, event.agentId, pipelineId);
      if (result.executing) {
        // Execute immediately
        this.executeStepWithLifecycle(runId, pipelineId, event.stepId, event.agentId).catch(err => {
          console.error(`[AgentExecutor] Unhandled error in executeStep:`, err);
        });
      } else {
        console.log(`[AgentExecutor] Queued step ${event.stepId} for agent ${event.agentId} (position: ${result.position})`);
      }
    } else {
      // Fallback: no lifecycle manager, fire and forget (legacy behavior)
      this.executeStep(runId, pipelineId, event.stepId, event.agentId).catch(err => {
        console.error(`[AgentExecutor] Unhandled error in executeStep:`, err);
      });
    }
  }

  /**
   * Execute a step with lifecycle manager integration.
   * After completing the step, checks for queued work and executes it.
   */
  private async executeStepWithLifecycle(
    runId: string,
    pipelineId: string,
    stepId: string,
    agentId: string
  ): Promise<void> {
    try {
      await this.executeStep(runId, pipelineId, stepId, agentId);
    } finally {
      if (this.lifecycleManager) {
        const nextWork = this.lifecycleManager.markComplete(agentId);
        if (nextWork) {
          console.log(`[AgentExecutor] Dequeuing next work for ${agentId}: step ${nextWork.stepId} (run ${nextWork.runId})`);
          // Use the runId and pipelineId stored when the work was queued — not
          // the current closure values, which belong to the just-completed run.
          this.executeStepWithLifecycle(nextWork.runId, nextWork.pipelineId, nextWork.stepId, agentId).catch(err => {
            console.error(`[AgentExecutor] Error in dequeued step:`, err);
          });
        }
      }
    }
  }

  /**
   * Execute a queued step by spawning an agent session.
   */
  private async executeStep(
    runId: string,
    pipelineId: string,
    stepId: string,
    agentId: string
  ): Promise<void> {
    const pipeline = this.pipelines.get(pipelineId);
    if (!pipeline) {
      console.error(`[AgentExecutor] Pipeline not found: ${pipelineId}`);
      await this.publishStepFailed(runId, stepId, `Pipeline not found: ${pipelineId}`);
      return;
    }

    const stepConfig = pipeline.steps.find((s) => s.id === stepId);
    if (!stepConfig) {
      console.error(`[AgentExecutor] Step not found: ${stepId}`);
      await this.publishStepFailed(runId, stepId, `Step not found: ${stepId}`);
      return;
    }

    const agentConfig = pipeline.agents.find((a) => a.id === agentId);
    if (!agentConfig) {
      console.error(`[AgentExecutor] Agent not found: ${agentId}`);
      await this.publishStepFailed(runId, stepId, `Agent not found: ${agentId}`);
      return;
    }

    // Set up abort controller for this run (allows cancellation via stop button)
    const abortController = new AbortController();
    this.abortControllers.set(runId, abortController);

    const startTime = Date.now();

    try {
      // Record work started in lifecycle tracker
      if (this.lifecycleTracker) {
        await this.lifecycleTracker.recordWorkStarted(
          agentId,
          runId,
          stepId,
          stepConfig.type || 'step'
        );
      }

      // Load agent persona with step context and session context for pipeline runs
      const persona = await this.personaLoader.loadPersona(
        agentId,
        {
          stepId,
          outputs: stepConfig.outputs,
        },
        {
          sessionType: 'pipeline',
          runId,
        }
      );

      // Resolve the user prompt template
      let userPrompt = await this.resolveStepInput(runId, stepConfig, pipeline);
      let systemPrompt = persona.systemPrompt;

      // Use ContextAssembler if available for rich context injection
      if (this.contextAssembler) {
        // Build loop context if this is a loop step
        let loopContext: { currentItem: string; completedItems: string[]; totalItems: number } | undefined;
        
        if (stepConfig.type === 'loop' && stepConfig.loop) {
          const loopState = this.getLoopState?.(runId, stepConfig.id);
          if (loopState && loopState.currentIndex < loopState.items.length) {
            const currentItem = loopState.items[loopState.currentIndex];
            const completedItems = loopState.items
              .slice(0, loopState.currentIndex)
              .filter((item) => item.status === 'completed')
              .map((item) => item.data);
            
            loopContext = {
              currentItem: currentItem?.data || '',
              completedItems,
              totalItems: loopState.items.length,
            };
          }
        }

        const assembled = await this.contextAssembler.assemble({
          runId,
          stepId,
          agentId,
          stepInput: userPrompt,
          systemPrompt: persona.systemPrompt,
          loopContext,
        });

        // Use assembled context as the full user prompt
        userPrompt = assembled.fullPrompt;
        // Keep the system prompt from persona
        systemPrompt = assembled.systemPrompt;
      }

      // Create session for this step execution (BEFORE any agent execution)
      if (this.sessionPersister) {
        const taskDesc = this.getRunTask ? await this.getRunTask(runId) : '';
        await this.sessionPersister.createSession({
          id: `${runId}_${stepId}`,  // Unique per step — runId alone causes PK collision across steps
          agentId: agentId,
          source: 'pipeline',
          sourceId: stepId,
          userPrompt: (taskDesc || '').slice(0, 500),  // Truncate for storage
          model: this.resolveStepModel(stepConfig, agentConfig, pipeline, agentId),
        });
      }

      // Resolve userId and model override early — needed by both structured output
      // and normal agent paths for per-user provider key resolution and model selection.
      const userId = this.getRunUserId ? await this.getRunUserId(runId) : undefined;
      const runModelOverride = this.getRunModelOverride ? await this.getRunModelOverride(runId) : undefined;

      // Check if this step uses structured output
      if (stepConfig.outputSchema) {
        console.log(`[AgentExecutor] Using structured output for step ${stepId}`);
        
        // Publish STEP_STARTED
        const sessionId = `session_${Date.now()}_${Math.random().toString(36).slice(2, 11)}`;
        await this.eventBus.publish(runChannel(runId), {
          type: 'STEP_STARTED',
          runId,
          stepId,
          sessionId,
          timestamp: Date.now(),
        });

        const result = await this.structuredRunner.run({
          runId,
          stepId: stepConfig.id,
          model: this.resolveStepModel(stepConfig, agentConfig, pipeline, agentId, runModelOverride),
          systemPrompt,
          userPrompt,
          outputSchema: stepConfig.outputSchema,
          outputMethod: stepConfig.outputMethod,
          timeout: (stepConfig.timeoutSeconds ?? pipeline.defaults.timeoutSeconds ?? 300) * 1000,
          userId,
        });

        console.log(`[AgentExecutor] Structured output result: success=${result.success}, hasData=${!!result.data}, error=${result.error || 'none'}`);
        if (result.success && result.data) {
          // Map the structured data to step outputs
          const outputs: Record<string, string> = {};
          if (stepConfig.outputs) {
            for (const outputKey of stepConfig.outputs) {
              if (outputKey in (result.data as any)) {
                const val = (result.data as any)[outputKey];
                outputs[outputKey] = typeof val === 'string' ? val : JSON.stringify(val);
              }
            }
          }
          // Also store the full JSON as a special output
          outputs['_structured_json'] = result.rawJson;

          // If only one output key and it's not in the data, store the whole thing
          if (stepConfig.outputs?.length === 1 && !outputs[stepConfig.outputs[0]]) {
            outputs[stepConfig.outputs[0]] = result.rawJson;
          }

          // Record work complete in lifecycle tracker
          const duration = Date.now() - startTime;
          if (this.lifecycleTracker) {
            await this.lifecycleTracker.recordWorkComplete(
              agentId,
              runId,
              stepId,
              outputs,
              duration
            );
          }

          // Publish completion (which includes auto-commit)
          await this.publishStepComplete(runId, stepId, agentId, outputs, result.rawJson);
          return;
        } else {
          console.error(`[AgentExecutor] Structured output failed for step ${stepId}: ${result.error}`);
          console.warn(`[AgentExecutor] Falling back to normal agent execution`);
          // Fall through to normal agent execution as fallback
        }
      }

      // Publish STEP_STARTED (for non-structured or fallback path)
      const sessionId = `session_${Date.now()}_${Math.random().toString(36).slice(2, 11)}`;
      await this.eventBus.publish(runChannel(runId), {
        type: 'STEP_STARTED',
        runId,
        stepId,
        sessionId,
        timestamp: Date.now(),
      });

      // Set up workspace for file tools
      // Container system handles workspace directly
      let workspacePath: string | undefined;
      let runWorkspacePath: string | undefined;
      let projectWorkspacePath: string | undefined;
      let unwatchWorkspace: (() => void) | undefined;

      // Agent personal workspace (used by in-process PiMonoRunner for file tools)
      const workspacesDir = process.env.WORKSPACES_DIR || '/data/workspaces';
      workspacePath = `${workspacesDir}/${agentId}`;

      // Get projectId — used for workspace setup. userId is already resolved above
      // (before the structured output check) for per-user key resolution.
      const projectId = this.getRunProjectId ? await this.getRunProjectId(runId) : undefined;

      if (this.workspaceManager) {
        try {
          // Compute run workspace path (deterministic: SHARED_RUNS_DIR/{runId})
          // Only set for pipeline runs (runId starts with 'run_')
          const isPipelineRun = runId.startsWith('run_');
          if (isPipelineRun) {
            const runsDir = process.env.SHARED_RUNS_DIR || '/data/runs';
            runWorkspacePath = `${runsDir}/${runId}`;

            // Project workspace path — the project's main git repo
            if (projectId) {
              projectWorkspacePath = `${workspacesDir}/${projectId}`;
            }

            console.log(`[AgentExecutor] Run workspace: ${runWorkspacePath}${projectId ? `, Project workspace: ${projectWorkspacePath}` : ' (no project)'}`);

            // Only create the workspace if it doesn't already exist.
            // PipelineEngine.setupRunWorkspace() creates it before the first step is queued.
            // We only fall through here as a safety net for retried/crash-recovered steps.
            if (!this.workspaceManager.getRunPath(runId)) {
              console.log(`[AgentExecutor] Run workspace missing — creating (crash-recovery path)`);
              try {
                if (projectId) {
                  // Look up the task branch so the crash-recovered worktree lands on the
                  // correct feat/{taskId} branch rather than creating a new ephemeral run branch.
                  const taskBranch = this.getRunTaskBranch ? await this.getRunTaskBranch(runId) : undefined;
                  await this.workspaceManager.createRunWorktreeAsync(projectId, runId, undefined, taskBranch);
                } else {
                  this.workspaceManager.ensureRunWorkspace(runId);
                }
              } catch (wsErr) {
                const errorMsg = `Failed to create run workspace: ${wsErr instanceof Error ? wsErr.message : String(wsErr)}`;
                console.error(`[AgentExecutor] ${errorMsg}`);
                await this.publishStepFailed(runId, stepId, errorMsg);
                return;
              }
            }
          }

          // Watch the run workspace for file changes (pipeline activity feed)
          if (runWorkspacePath) {
            unwatchWorkspace = this.workspaceManager.watchWorkspace(runWorkspacePath, (filePath, action) => {
              // Collect file metadata (size) for create/modify events
              let size: number | undefined;
              if (action !== 'delete') {
                try {
                  const fullPath = join(runWorkspacePath!, filePath);
                  const stats = statSync(fullPath);
                  size = stats.size;
                } catch (err) {
                  // File might have been deleted between detection and stat
                  size = undefined;
                }
              }

              this.eventBus.publish(runChannel(runId), {
                type: 'FILE_CHANGED',
                runId,
                stepId,
                path: filePath,
                action,
                size,
                timestamp: Date.now(),
              }).catch(() => {});
            });
          }
        } catch (err) {
          console.error(`[AgentExecutor] Failed to set up workspace:`, err);
        }
      }

      try {
        // Run the agent (normal path)
        const result = await this.agentRunner.runAgent({
          runId,
          stepId,
          agentId,
          model: this.resolveStepModel(stepConfig, agentConfig, pipeline, agentId, runModelOverride),
          thinkingLevel: agentConfig.thinkingLevel,
          systemPrompt,
          userPrompt,
          tools: agentConfig.tools,
          timeout: (stepConfig.timeoutSeconds ?? pipeline.defaults.timeoutSeconds ?? 300) * 1000,
          // For in-process runners (PiMonoRunner): workspacePath is the agent's personal dir
          // used as the bash/file tool CWD when there's no run workspace.
          // When runWorkspacePath is set, PiMonoRunner should prefer it — see note below.
          workspacePath: runWorkspacePath ?? workspacePath,
          // For container runner: these map to /home/agent/run-workspace and /home/agent/project-workspace
          runWorkspacePath,
          projectWorkspacePath,
          vaultPath: `${process.env.VAULTS_DIR || '/data/vaults'}/${agentId}`,
          signal: abortController.signal,
          maxTurns: stepConfig.maxTurns ?? pipeline.defaults.maxTurns ?? 50,
          projectId,
          userId,
        });

        // Parse the output (prefer parsedOutputs from tools, fall back to parsing)
        const parsedOutputs = result.parsedOutputs ?? parseOutputKeyValues(result.output);

        // Check for status in output
        const status = parsedOutputs.status?.toLowerCase();

        if (!result.success || status === 'fail' || status === 'failed' || status === 'error') {
          const errorMessage = result.error ||
            parsedOutputs.error ||
            parsedOutputs.result ||
            'Agent execution failed';

          // Record work failed in lifecycle tracker
          if (this.lifecycleTracker) {
            await this.lifecycleTracker.recordWorkFailed(
              agentId,
              runId,
              stepId,
              errorMessage
            );
          }

          await this.publishStepFailed(runId, stepId, errorMessage, result.output);
        } else {
          // Record work complete in lifecycle tracker
          const duration = Date.now() - startTime;
          if (this.lifecycleTracker) {
            await this.lifecycleTracker.recordWorkComplete(
              agentId,
              runId,
              stepId,
              parsedOutputs,
              duration
            );
          }

          await this.publishStepComplete(runId, stepId, agentId, parsedOutputs, result.output);
        }
      } finally {
        unwatchWorkspace?.();
        this.abortControllers.delete(runId);
      }
    } catch (err) {
      this.abortControllers.delete(runId);
      // Don't publish failure for aborted runs — already handled by cancellation
      if (abortController?.signal?.aborted) {
        console.log(`[AgentExecutor] Step ${stepId} aborted for run ${runId}`);
        
        // Still record work failed for aborted runs
        if (this.lifecycleTracker) {
          await this.lifecycleTracker.recordWorkFailed(
            agentId,
            runId,
            stepId,
            'Step aborted'
          );
        }
        return;
      }
      const errorMessage = err instanceof Error ? err.message : String(err);
      console.error(`[AgentExecutor] Step execution error: ${errorMessage}`);
      
      // Record work failed in lifecycle tracker
      if (this.lifecycleTracker) {
        await this.lifecycleTracker.recordWorkFailed(
          agentId,
          runId,
          stepId,
          errorMessage
        );
      }
      
      await this.publishStepFailed(runId, stepId, errorMessage);
    }
  }

  /**
   * Resolve template variables for step input.
   */
  private async resolveStepInput(
    runId: string,
    stepConfig: StepConfig,
    pipeline: PipelineConfig
  ): Promise<string> {
    // Get accumulated outputs — await to handle async ApiStore implementation
    const outputs = await Promise.resolve(this.getOutputs(runId));

    // Build variable context
    const taskDesc = this.getRunTask ? await this.getRunTask(runId) : undefined;
    let variables: Record<string, string> = {
      ...outputs,
      task_description: taskDesc || outputs.task_description || '',
    };

    // Merge human_context JSON fields (e.g. project_name, project_description from planning runs)
    const humanContext = this.getRunHumanContext ? await this.getRunHumanContext(runId) : undefined;
    if (humanContext) {
      try {
        const ctx = JSON.parse(humanContext);
        if (typeof ctx === 'object' && ctx !== null) {
          for (const [k, v] of Object.entries(ctx)) {
            if (typeof v === 'string' && !(k in variables)) {
              variables[k] = v;
            }
          }
        }
      } catch { /* not JSON, ignore */ }
    }

    // Add loop variables if this is a loop step
    if (stepConfig.type === 'loop' && stepConfig.loop) {
      const loopState = this.getLoopState?.(runId, stepConfig.id);
      if (loopState && loopState.currentIndex < loopState.items.length) {
        const currentItem = loopState.items[loopState.currentIndex];
        const completedItems = loopState.items
          .slice(0, loopState.currentIndex)
          .filter((item) => item.status === 'completed')
          .map((item) => item.data);

        const loopVars = createLoopVariables(
          currentItem?.data || '',
          completedItems,
          outputs.progress_file || ''
        );

        variables = mergeVariables(variables, loopVars);
      }
    }

    // Resolve the template
    return resolveTemplate(stepConfig.input, variables);
  }

  /**
   * Extract a meaningful commit summary from step outputs.
   * Tries multiple keys in priority order.
   */
  private extractCommitSummary(outputs: Record<string, string>): string {
    // Priority order for finding a good summary
    const summaryKeys = [
      'summary',
      'result',
      'decision',
      'implementation',
      'status',
      'description',
    ];

    for (const key of summaryKeys) {
      const value = outputs[key];
      if (value && typeof value === 'string') {
        // Truncate to first 100 chars and first line
        const truncated = value.split('\n')[0].slice(0, 100);
        return truncated || 'completed';
      }
    }

    // Fallback: use first non-empty output value
    const firstValue = Object.values(outputs).find(v => v && typeof v === 'string');
    if (firstValue) {
      return firstValue.split('\n')[0].slice(0, 100);
    }

    return 'completed';
  }

  /**
   * Publish STEP_COMPLETE event.
   */
  private async publishStepComplete(
    runId: string,
    stepId: string,
    agentId: string,
    outputs: Record<string, string>,
    rawOutput: string
  ): Promise<void> {
    const timestamp = Date.now();

    // AUTO-COMMIT WORKSPACE CHANGES BEFORE PUBLISHING EVENT
    let commitHash: string | undefined;
    if (this.workspaceManager) {
      const runPath = this.workspaceManager.getRunPath(runId);
      if (runPath) {
        try {
          const summary = this.extractCommitSummary(outputs);
          const hash = this.workspaceManager.commitStep(runPath, stepId, agentId, summary);
          if (hash) {
            commitHash = hash;
            console.log(`[AgentExecutor] Auto-committed step ${stepId}: ${hash.slice(0, 8)}`);
          } else {
            console.log(`[AgentExecutor] No changes to commit for step ${stepId}`);
          }
        } catch (err) {
          console.error(`[AgentExecutor] Failed to commit step ${stepId}:`, err);
          // Don't fail the step if commit fails — git issues shouldn't block progress
          // But publish an event so dashboard can show warning
          await this.eventBus.publish(runChannel(runId), {
            type: 'COMMIT_FAILED',
            runId,
            stepId,
            error: err instanceof Error ? err.message : String(err),
            timestamp: Date.now(),
          }).catch(() => {});
        }
      }
    }

    // Update progress file with step results
    if (this.progressFiles) {
      try {
        const outputsFormatted = Object.entries(outputs)
          .map(([k, v]) => `- **${k}**: ${v}`)
          .join('\n');

        await this.progressFiles.append(runId, {
          timestamp,
          agentId,
          stepId,
          content: `**Outputs:**\n${outputsFormatted}\n\n**Raw Output:**\n\`\`\`\n${rawOutput}\n\`\`\``,
        });

        // COMMIT PROGRESS FILE UPDATE IF WE HAVE A WORKTREE
        if (this.workspaceManager && commitHash) {
          const runPath = this.workspaceManager.getRunPath(runId);
          if (runPath) {
            try {
              const progressCommitHash = this.workspaceManager.commitStep(
                runPath,
                `${stepId}-progress`,
                'system',
                `Updated progress file for step ${stepId}`
              );
              if (progressCommitHash) {
                console.log(`[AgentExecutor] Committed progress file update: ${progressCommitHash.slice(0, 8)}`);
              }
            } catch (err) {
              console.error(`[AgentExecutor] Failed to commit progress file:`, err);
            }
          }
        }
      } catch (err) {
        console.error(`[AgentExecutor] Failed to update progress file for run ${runId}:`, err);
      }
    }

    // Store handoff in agent memory (persistent)
    if (this.agentMemoryManager) {
      try {
        const memory = await this.agentMemoryManager.get(agentId);
        const taskForHandoff = this.getRunTask ? await this.getRunTask(runId) : '';
        await memory.sleep({
          runId,
          stepId,
          workingOn: [taskForHandoff || ''],
          decisions: Object.entries(outputs)
            .filter(([k]) => k.toLowerCase().includes('decision') || k.toLowerCase().includes('design'))
            .map(([k, v]) => `${k}: ${v.slice(0, 200)}`),
          nextSteps: [],
          outputs,
        });
      } catch (err) {
        console.error(`[AgentExecutor] Failed to store agent memory handoff:`, err);
      }
    }

    // PUBLISH STEP_COMPLETE WITH COMMIT HASH
    await this.eventBus.publish(runChannel(runId), {
      type: 'STEP_COMPLETE',
      runId,
      stepId,
      outputs,
      commitHash,  // INCLUDE COMMIT HASH
      timestamp,
    });

    // Complete session in database
    if (this.sessionPersister) {
      await this.sessionPersister.completeSession(
        `${runId}_${stepId}`,
        rawOutput,
        true,  // success
        undefined
      );
    }

    console.log(`[AgentExecutor] Step ${stepId} completed for run ${runId}${commitHash ? ` (commit: ${commitHash.slice(0, 8)})` : ''}`);
  }

  /**
   * Publish STEP_FAILED event.
   */
  private async publishStepFailed(
    runId: string,
    stepId: string,
    error: string,
    rawOutput?: string
  ): Promise<void> {
    await this.eventBus.publish(runChannel(runId), {
      type: 'STEP_FAILED',
      runId,
      stepId,
      error,
      retryCount: 0, // Retry count is managed by PipelineEngine
      timestamp: Date.now(),
    });

    // Mark session as failed in database
    if (this.sessionPersister) {
      await this.sessionPersister.completeSession(
        `${runId}_${stepId}`,
        rawOutput || '',
        false,  // failed
        error
      );
    }

    console.log(`[AgentExecutor] Step ${stepId} failed for run ${runId}: ${error}`);
  }

  /**
   * Shutdown the executor.
   */
  async shutdown(): Promise<void> {
    for (const [runId, unsub] of this.unsubscribers) {
      unsub();
    }
    this.unsubscribers.clear();
    this.activeRuns.clear();
    console.log('[AgentExecutor] Shutdown complete');
  }
}

/**
 * Parse KEY: value pairs from agent output.
 * Keys are uppercase with underscores (e.g., STATUS:, RESULT:)
 * or lowercase_with_underscores (e.g., status:, test_result:).
 * Values can span multiple lines if indented.
 */
export function parseOutputKeyValues(output: string): Record<string, string> {
  const result: Record<string, string> = {};
  const lines = output.split('\n');
  let currentKey: string | null = null;
  let currentValue: string[] = [];

  for (const line of lines) {
    // Match UPPER_CASE or lower_with_underscores patterns (no spaces in key)
    const match = line.match(/^([A-Z_][A-Z0-9_]+|[a-z_][a-z0-9_]+):\s*(.*)/);
    if (match) {
      // Save previous key-value
      if (currentKey) {
        result[currentKey.toLowerCase()] = currentValue.join('\n').trim();
      }
      currentKey = match[1];
      currentValue = [match[2]];
    } else if (currentKey && line.startsWith('  ')) {
      // Continuation line (indented)
      currentValue.push(line.trim());
    }
  }

  // Save last key-value
  if (currentKey) {
    result[currentKey.toLowerCase()] = currentValue.join('\n').trim();
  }

  return result;
}
