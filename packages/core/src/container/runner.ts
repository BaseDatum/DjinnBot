import { Redis } from 'ioredis';
import { authFetch } from '../api/auth-fetch.js';
import { getAgentApiKey } from '../api/agent-key-manager.js';
import { ContainerManager, type ContainerConfig } from './manager.js';
import { CommandSender } from './command-sender.js';
import { EventReceiver } from './event-receiver.js';
import type { AgentRunner, RunAgentOptions, AgentRunResult } from '../runtime/agent-executor.js';
import type { OutputMessage, EventMessage, StatusMessage } from '../redis-protocol/types.js';
import { PROVIDER_ENV_MAP } from '../constants.js';
import { enrichNetworkError } from '../runtime/model-resolver.js';
export interface ContainerRunnerConfig {
  redisUrl: string;
  dataPath?: string;  // Base path for volumes (default: /data)
  image?: string;     // Container image (default: djinnbot/agent-runtime:latest)
  defaultTimeout?: number;  // Default timeout in ms (default: 300000 = 5 min)
  /** Base URL for the Python API server — used to fetch provider keys */
  apiBaseUrl?: string;
  onStreamChunk?: (agentId: string, runId: string, stepId: string, chunk: string) => void;
  onThinkingChunk?: (agentId: string, runId: string, stepId: string, chunk: string) => void;
  onToolCallStart?: (agentId: string, runId: string, stepId: string, toolName: string, toolCallId: string, args: Record<string, unknown>) => void;
  onToolCallEnd?: (agentId: string, runId: string, stepId: string, toolName: string, toolCallId: string, result: string, isError: boolean, durationMs: number) => void;
  /** Called when an agent sends a message to another agent via the message_agent tool. */
  onMessageAgent?: (agentId: string, runId: string, stepId: string, to: string, message: string, priority: string, messageType: string) => Promise<string>;
  /** Called when an agent sends a Slack DM to the user via the slack_dm tool. */
  onSlackDm?: (agentId: string, runId: string, stepId: string, message: string, urgent: boolean) => Promise<string>;
  /** Called on container lifecycle and status events (created, started, ready, destroyed, etc.). */
  onContainerEvent?: (runId: string, event: { type: string; detail?: string; timestamp: number }) => void;
}

/**
 * ContainerRunner implements AgentRunner by spawning agent-runtime containers
 * and communicating via Redis pub/sub.
 */
export class ContainerRunner implements AgentRunner {
  private redis: Redis;
  private containerManager: ContainerManager;
  private commandSender: CommandSender;
  private eventReceiver: EventReceiver;
  private config: ContainerRunnerConfig;

  constructor(config: ContainerRunnerConfig) {
    this.config = config;
    this.redis = new Redis(config.redisUrl);
    this.containerManager = new ContainerManager(this.redis);
    this.commandSender = new CommandSender(this.redis);
    this.eventReceiver = new EventReceiver(() => new Redis(config.redisUrl));
  }

  /** Map from provider_id → canonical env var name (imported from constants.ts) */
  private static readonly PROVIDER_ENV_MAP = PROVIDER_ENV_MAP;

  /** Per-provider key source metadata returned by the last fetchProviderEnvVars call. */
  private _lastKeySources: Record<string, { source: string; masked_key: string }> = {};

  /**
   * Fetch all configured provider API keys and extra env vars, returning them
   * as { ENV_VAR_NAME: value } ready to spread into a container env block.
   * DB-stored values override process.env.
   *
   * Side-effect: populates `this._lastKeySources` with per-provider key source
   * metadata (source type + masked key) for recording in key_resolution.
   */
  private async fetchProviderEnvVars(userId?: string): Promise<Record<string, string>> {
    const result: Record<string, string> = {};
    this._lastKeySources = {};
    // When fetching for a specific user, don't seed from process.env —
    // strict mode means only user-owned or admin-shared keys are used.
    if (!userId) {
      for (const envVar of Object.values(ContainerRunner.PROVIDER_ENV_MAP)) {
        const val = process.env[envVar];
        if (val) result[envVar] = val;
      }
    }
    const apiBaseUrl = this.config.apiBaseUrl
      || process.env.DJINNBOT_API_URL
      || 'http://api:8000';
    const userParam = userId ? `?user_id=${encodeURIComponent(userId)}` : '';
    try {
      const res = await authFetch(`${apiBaseUrl}/v1/settings/providers/keys/all${userParam}`);
      if (res.ok) {
        const data = await res.json() as {
          keys: Record<string, string>;
          extra?: Record<string, string>;
          key_sources?: Record<string, { source: string; masked_key: string }>;
        };
        // Capture per-provider key source metadata
        if (data.key_sources) {
          this._lastKeySources = data.key_sources;
        }
        // Inject primary API keys
        for (const [providerId, apiKey] of Object.entries(data.keys)) {
          if (!apiKey) continue;
          // Custom providers: derive env var from slug
          if (providerId.startsWith('custom-')) {
            const slug = providerId.slice('custom-'.length).toUpperCase().replace(/-/g, '_');
            result[`CUSTOM_${slug}_API_KEY`] = apiKey;
          } else {
            const envVar = ContainerRunner.PROVIDER_ENV_MAP[providerId];
            if (envVar) result[envVar] = apiKey;
          }
        }
        // Inject extra env vars (e.g. AZURE_OPENAI_BASE_URL)
        for (const [envVar, value] of Object.entries(data.extra ?? {})) {
          if (value) result[envVar] = value;
        }
      }
    } catch (err) {
      console.warn('[ContainerRunner] Failed to fetch provider keys from settings:', err);
    }
    return result;
  }

  /**
   * Fetch the current agentRuntimeImage from the settings API.
   * Falls back to the constructor-provided image (or env/default) on failure.
   */
  private async fetchRuntimeImage(): Promise<string> {
    const apiBaseUrl = this.config.apiBaseUrl
      || process.env.DJINNBOT_API_URL
      || 'http://api:8000';
    try {
      const res = await authFetch(`${apiBaseUrl}/v1/settings/`);
      if (res.ok) {
        const data = await res.json() as { agentRuntimeImage?: string };
        const dbImage = data.agentRuntimeImage?.trim();
        if (dbImage) {
          return dbImage;
        }
      }
    } catch (err) {
      console.warn('[ContainerRunner] Failed to fetch runtime image from settings:', err);
    }
    return this.config.image || process.env.AGENT_RUNTIME_IMAGE || 'ghcr.io/basedatum/djinnbot/agent-runtime:latest';
  }

  /**
   * Extract the base URL for the model from the collected provider env vars.
   * Returns undefined if the model isn't a custom provider or if no base URL
   * is configured — in which case enrichNetworkError is a no-op.
   *
   * Custom providers are expected to have their base URL stored under
   * CUSTOM_PROVIDER_{ID_UPPERCASE}_BASE_URL, matching what fetchProviderEnvVars()
   * injects once the custom provider DB support is in place.
   */
  private extractBaseUrlForModel(model: string, envVars: Record<string, string>): string | undefined {
    const parts = model.split('/');
    if (parts.length < 2) return undefined;
    const provider = parts[0];
    if (!provider.startsWith('custom-')) return undefined;
    const id = provider.slice(7).toUpperCase().replace(/-/g, '_');
    return envVars[`CUSTOM_${id}_BASE_URL`];
  }

  async runAgent(options: RunAgentOptions): Promise<AgentRunResult> {
    const {
      runId,
      stepId,
      agentId,
      model,
      systemPrompt,
      userPrompt,
      tools = [],
      timeout = this.config.defaultTimeout ?? 300000,
      workspacePath,
      runWorkspacePath,
      projectWorkspacePath,
      vaultPath,
      signal,
      maxTurns = 999,
      projectId,
      pulseColumns,
      userId,
    } = options;

    const sessionId = `session_${Date.now()}_${Math.random().toString(36).slice(2, 11)}`;
    const dataPath = this.config.dataPath ?? '/data';

    // Collect output and events
    let output = '';
    let success = false;
    let error: string | undefined;
    const parsedOutputs: Record<string, string> = {};
    let stepCompleted = false;

    // Hoisted so the catch block can use it for error enrichment.
    let providerEnvVars: Record<string, string> = {};

    // Create abort handler — will reject the output promise when triggered
    let aborted = false;
    let rejectOutput: ((err: Error) => void) | undefined;
    const abortHandler = () => {
      aborted = true;
      rejectOutput?.(new Error('Run cancelled'));
    };
    signal?.addEventListener('abort', abortHandler);

    try {
      // 1. Create container
      console.log(`[ContainerRunner] Creating container for run ${runId} (agent: ${agentId})`);
      
      // Fetch all provider API keys (DB + env vars) and the current
      // runtime image (may have been changed via dashboard since engine start).
      // When userId is set, keys are resolved per-user (strict mode).
      const [fetchedProviderEnvVars, runtimeImage] = await Promise.all([
        this.fetchProviderEnvVars(userId),
        this.fetchRuntimeImage(),
      ]);
      providerEnvVars = fetchedProviderEnvVars;

      // Record key resolution metadata on the run (non-blocking).
      // Includes per-provider source (personal / admin_shared / instance) and masked keys.
      const resolvedProviders = Object.keys(providerEnvVars)
        .filter(k => k.endsWith('_API_KEY') || k.endsWith('_TOKEN'))
        .map(k => {
          // Reverse-map env var to provider id for readability
          for (const [pid, env] of Object.entries(ContainerRunner.PROVIDER_ENV_MAP)) {
            if (env === k) return pid;
          }
          return k;
        });
      const apiBase = this.config.apiBaseUrl || process.env.DJINNBOT_API_URL || 'http://api:8000';
      authFetch(`${apiBase}/v1/runs/${runId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          key_resolution: JSON.stringify({
            userId: userId ?? null,
            source: userId ? 'executing_user' : 'system',
            resolvedProviders,
            providerSources: this._lastKeySources,
          }),
        }),
      }).catch(() => {}); // Non-fatal — don't block container creation

      const containerConfig: ContainerConfig = {
        runId,
        agentId,
        // Legacy field — kept for backward compat; ContainerManager prefers runWorkspacePath.
        workspacePath: workspacePath ?? `${dataPath}/workspaces/${agentId}`,
        // The run's git worktree — this is what the agent works on inside the container.
        runWorkspacePath: runWorkspacePath ?? (runId.startsWith('run_') ? `${dataPath}/runs/${runId}` : undefined),
        // The project's main repo — only present for project-associated runs.
        projectWorkspacePath,
        image: runtimeImage,
        env: {
          AGENT_MODEL: model,
          // Executor model for spawn_executor tool — defaults to AGENT_MODEL if not set.
          ...(options.executorModel ? { EXECUTOR_MODEL: options.executorModel } : {}),
          // All configured provider API keys injected by their canonical env var names
          ...providerEnvVars,
          // Pass pulse columns so the agent-runtime can scope get_ready_tasks correctly.
          PULSE_COLUMNS: (pulseColumns ?? []).join(','),
          DJINNBOT_API_URL: process.env.DJINNBOT_API_URL || 'http://api:8000',
          // Per-agent API key for authenticating to the DjinnBot API
          ...(getAgentApiKey(agentId) ? { AGENT_API_KEY: getAgentApiKey(agentId)! } : {}),
          // MCP / mcpo: agent-runtime calls createMcpTools() on each turn using these.
          ...(process.env.MCPO_BASE_URL ? { MCPO_BASE_URL: process.env.MCPO_BASE_URL } : {}),
          ...(process.env.MCPO_API_KEY ? { MCPO_API_KEY: process.env.MCPO_API_KEY } : {}),
          // LLM call logging context — used by the runtime to tag each API call
          RUN_ID: runId,
          // User attribution — agent-runtime includes this in LLM call logs
          // so daily usage can be tracked per-user for share limit enforcement.
          ...(userId ? { DJINNBOT_USER_ID: userId } : {}),
          ...(() => {
            const provider = model.includes('/') ? model.split('/')[0] : model;
            const ks = this._lastKeySources[provider];
            return ks ? { KEY_SOURCE: ks.source, KEY_MASKED: ks.masked_key } : {} as Record<string, string>;
          })(),
        },
      };

      await this.containerManager.createContainer(containerConfig);
      this.config.onContainerEvent?.(runId, { type: 'CONTAINER_CREATED', detail: `Image: ${runtimeImage}`, timestamp: Date.now() });

      // 2. Subscribe to events BEFORE starting container
      await this.eventReceiver.subscribeToRun(runId);

      // Set up event handlers
      const outputPromise = new Promise<void>((resolve, reject) => {
        // Wire abort signal into the promise so cancellation stops the container
        rejectOutput = reject;

        const timeoutId = setTimeout(() => {
          reject(new Error(`Container execution timed out after ${timeout}ms`));
        }, timeout);

        // Handle output streaming
        this.eventReceiver.onOutput((evtRunId, msg) => {
          if (evtRunId !== runId) return;

          // Skip tool output (bash stdout/stderr) — it leaks into the agent
          // output stream and gets rendered as markdown on the runs page.
          // Tool output is already surfaced via toolEnd events with the full result.
          if ((msg as any).source === 'tool') return;
          
          if (msg.type === 'stdout') {
            output += msg.data;
            this.config.onStreamChunk?.(agentId, runId, stepId, msg.data);
          } else if (msg.type === 'stderr') {
            // stderr also goes to output
            output += msg.data;
            this.config.onStreamChunk?.(agentId, runId, stepId, msg.data);
          }
        });

        // Handle structured events
        this.eventReceiver.onEvent((evtRunId, msg) => {
          if (evtRunId !== runId) return;
          
          if (msg.type !== 'thinking') {
            console.log(`[ContainerRunner] Received event: ${msg.type} for run ${runId}`);
          }

          switch (msg.type) {
            case 'stepEnd':
              clearTimeout(timeoutId);
              stepCompleted = true;
              success = msg.success;
              if (!msg.success) {
                error = msg.result;
              } else {
                // Capture the agent's output from stepEnd result
                if (msg.result) {
                  output = msg.result;
                }
                // For structured output steps, the result IS the raw JSON.
                // Store it as _structured_json so AgentExecutor can map it.
                if (options.outputSchema && msg.result) {
                  try {
                    // Validate it's parseable JSON before storing
                    JSON.parse(msg.result);
                    parsedOutputs['_structured_json'] = msg.result;
                  } catch {
                    // Not valid JSON — fall through to key-value parsing
                    const parsed = this.parseOutputKeyValues(msg.result);
                    Object.assign(parsedOutputs, parsed);
                  }
                } else {
                  // Normal agent step — parse key-value outputs from result
                  const parsed = this.parseOutputKeyValues(msg.result);
                  Object.assign(parsedOutputs, parsed);
                }
              }
              resolve();
              break;

            case 'toolStart':
              this.config.onToolCallStart?.(
                agentId, runId, stepId,
                msg.toolName,
                msg.requestId,
                msg.args as Record<string, unknown>
              );
              break;

            case 'toolEnd':
              this.config.onToolCallEnd?.(
                agentId, runId, stepId,
                msg.toolName,
                msg.requestId,
                String(msg.result),
                !msg.success,
                msg.durationMs ?? 0
              );
              break;

            case 'thinking':
              this.config.onThinkingChunk?.(agentId, runId, stepId, msg.thinking);
              break;

            case 'agentMessage':
              // Route inter-agent messages to the inbox so they're not lost
              if (this.config.onMessageAgent) {
                this.config.onMessageAgent(
                  agentId, runId, stepId,
                  msg.to, msg.message, msg.priority, msg.messageType
                ).catch(err => console.error(`[ContainerRunner] Failed to route agentMessage:`, err));
              }
              break;

            case 'slackDm':
              if (this.config.onSlackDm) {
                this.config.onSlackDm(
                  agentId, runId, stepId,
                  msg.message, msg.urgent
                ).catch(err => console.error(`[ContainerRunner] Failed to route slackDm:`, err));
              }
              break;
          }
        });

        // Handle status changes
        this.eventReceiver.onStatus((evtRunId, msg) => {
          if (evtRunId !== runId) return;

          if (msg.type === 'error') {
            clearTimeout(timeoutId);
            error = msg.message;
            success = false;
            reject(new Error(msg.message));
          } else if (msg.type === 'exiting') {
            // Container is shutting down
            if (!stepCompleted) {
              clearTimeout(timeoutId);
              error = 'Container exited before step completed';
              success = false;
              reject(new Error(error));
            }
          }
        });

        // Handle errors
        this.eventReceiver.onError((evtRunId, err) => {
          if (evtRunId !== runId) return;
          clearTimeout(timeoutId);
          error = err.message;
          success = false;
          reject(err);
        });
      });

      // 3. Start container and wait for ready
      console.log(`[ContainerRunner] Starting container for run ${runId}`);
      this.config.onContainerEvent?.(runId, { type: 'CONTAINER_STARTING', timestamp: Date.now() });
      await this.containerManager.startContainer(runId);
      this.config.onContainerEvent?.(runId, { type: 'CONTAINER_READY', timestamp: Date.now() });
      console.log(`[ContainerRunner] Container ready for run ${runId}`);

      // Check if aborted
      if (aborted) {
        throw new Error('Aborted');
      }

      // 4. Send command — either structuredOutput or agentStep
      let requestId: string;
      if (options.outputSchema) {
        // Structured output: single constrained-decoding API call inside the container
        console.log(`[ContainerRunner] Sending structuredOutput command for run ${runId}`);
        requestId = await this.commandSender.sendStructuredOutput(runId, userPrompt, {
          systemPrompt,
          outputSchema: options.outputSchema,
          outputMethod: options.outputMethod,
          model,
        });
      } else {
        // Normal agent step: full agent loop with tools
        const fullPrompt = systemPrompt 
          ? `${systemPrompt}\n\n---\n\n${userPrompt}`
          : userPrompt;

        console.log(`[ContainerRunner] Sending agentStep command for run ${runId}`);
        requestId = await this.commandSender.sendAgentStep(runId, fullPrompt, {
          tools,
          maxSteps: maxTurns,
        });
      }

      // 5. Wait for completion or timeout
      await outputPromise;

      console.log(`[ContainerRunner] Step completed for run ${runId}: success=${success}`);

      const baseUrl = this.extractBaseUrlForModel(model, providerEnvVars);
      return {
        sessionId,
        output,
        success,
        error: error ? enrichNetworkError(error, baseUrl, /* inContainer */ true) : undefined,
        parsedOutputs: Object.keys(parsedOutputs).length > 0 ? parsedOutputs : undefined,
      };

    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : String(err);
      console.error(`[ContainerRunner] Error in run ${runId}:`, errorMessage);

      const baseUrl = this.extractBaseUrlForModel(model, providerEnvVars);
      return {
        sessionId,
        output,
        success: false,
        error: enrichNetworkError(errorMessage, baseUrl, /* inContainer */ true),
      };

    } finally {
      // Cleanup
      signal?.removeEventListener('abort', abortHandler);

      // Unsubscribe from events
      await this.eventReceiver.unsubscribeFromRun(runId).catch(err => {
        console.error(`[ContainerRunner] Failed to unsubscribe from run ${runId}:`, err);
      });

      // Stop container
      this.config.onContainerEvent?.(runId, { type: 'CONTAINER_STOPPING', timestamp: Date.now() });
      await this.containerManager.stopContainer(runId, true).catch(err => {
        console.error(`[ContainerRunner] Failed to stop container for run ${runId}:`, err);
      });
      this.config.onContainerEvent?.(runId, { type: 'CONTAINER_DESTROYED', timestamp: Date.now() });
    }
  }

  /**
   * Parse KEY: value pairs from agent output.
   */
  private parseOutputKeyValues(output: string): Record<string, string> {
    const result: Record<string, string> = {};
    const lines = output.split('\n');
    let currentKey: string | null = null;
    let currentValue: string[] = [];

    for (const line of lines) {
      const match = line.match(/^([A-Z_][A-Z0-9_]+|[a-z_][a-z0-9_]+):\s*(.*)/);
      if (match) {
        if (currentKey) {
          result[currentKey.toLowerCase()] = currentValue.join('\n').trim();
        }
        currentKey = match[1];
        currentValue = [match[2]];
      } else if (currentKey && line.startsWith('  ')) {
        currentValue.push(line.trim());
      }
    }

    if (currentKey) {
      result[currentKey.toLowerCase()] = currentValue.join('\n').trim();
    }

    return result;
  }

  /**
   * Shutdown the runner and cleanup resources.
   */
  async shutdown(): Promise<void> {
    await this.eventReceiver.close();
    await this.redis.quit();
    console.log('[ContainerRunner] Shutdown complete');
  }
}
