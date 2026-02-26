import { authFetch } from '../api/auth-fetch.js';
import { Agent } from '@mariozechner/pi-agent-core';
import { registerBuiltInApiProviders } from '@mariozechner/pi-ai';
import type { AssistantMessage, TextContent } from '@mariozechner/pi-ai';
import type { AgentEvent, AgentTool, AgentToolResult } from '@mariozechner/pi-agent-core';
import type { AgentRunner, RunAgentOptions, AgentRunResult } from './agent-executor.js';
import { createDjinnBotTools } from './djinnbot-tools.js';
import type { DjinnBotToolCallbacks } from './djinnbot-tools.js';
import { createPulseTools } from './pulse-tools.js';
import { createMcpTools } from '../mcp/mcp-tools.js';
import { performResearch } from './research.js';
import { createReadTool, createWriteTool, createEditTool, createBashTool } from '@mariozechner/pi-coding-agent';
import { PROVIDER_ENV_MAP } from '../constants.js';
import { parseModelString, enrichNetworkError } from './model-resolver.js';
import { StructuredOutputRunner } from './structured-output-runner.js';

export interface PiMonoRunnerConfig {
  /**
   * Base URL of the Python API server (e.g. "http://api:8000").
   * When set, PiMonoRunner fetches fresh provider API keys from the DB on every
   * runAgent() call so keys set via the UI are picked up without a restart.
   */
  apiBaseUrl?: string;
  /**
   * Per-provider API keys fetched from settings at startup.
   * Deprecated: prefer apiBaseUrl so keys are fetched fresh per call.
   * If provided, these are used as a fallback when apiBaseUrl is not set.
   * Format: { anthropic: 'sk-ant-...', xai: 'xai-...', opencode: 'oc-...', ... }
   */
  providerApiKeys?: Record<string, string>;
  /** Called when agent emits streaming text (for STEP_OUTPUT events) */
  onStreamChunk?: (agentId: string, runId: string, stepId: string, chunk: string) => void;
  /** Called when agent emits thinking/reasoning text (for STEP_THINKING events) */
  onThinkingChunk?: (agentId: string, runId: string, stepId: string, chunk: string) => void;
  /** Called when agent shares knowledge */
  onShareKnowledge?: (agentId: string, runId: string, stepId: string, entry: { category: string; content: string; importance: string }) => Promise<void>;
  /** Called when agent remembers something */
  onRemember?: (agentId: string, runId: string, stepId: string, entry: { type: string; title: string; content: string; shared: boolean; links?: string[] }) => Promise<void>;
  /** Called when agent recalls something */
  onRecall?: (agentId: string, runId: string, stepId: string, query: string, scope: string, profile: string, budget: number) => Promise<string>;
  /** Called when agent queries the knowledge graph */
  onGraphQuery?: (agentId: string, runId: string, stepId: string, action: string, nodeId?: string, query?: string, maxHops?: number, scope?: string) => Promise<string>;
  /** Called when agent links two memories */
  onLinkMemory?: (agentId: string, runId: string, stepId: string, fromId: string, toId: string, relationType: string) => Promise<void>;
  /** Called when agent saves a checkpoint */
  onCheckpoint?: (agentId: string, runId: string, stepId: string, workingOn: string, focus?: string, decisions?: string[]) => Promise<void>;
  /** Called when a tool call starts */
  onToolCallStart?: (agentId: string, runId: string, stepId: string, toolName: string, toolCallId: string, args: string) => void;
  /** Called when a tool call ends */
  onToolCallEnd?: (agentId: string, runId: string, stepId: string, toolName: string, toolCallId: string, result: string, isError: boolean, durationMs: number) => void;
  /** Called when agent state changes (thinking, streaming, tool_calling, idle) */
  onAgentState?: (agentId: string, runId: string, stepId: string, state: 'thinking' | 'streaming' | 'tool_calling' | 'idle', toolName?: string) => void;
  /** Called when agent sends a message to another agent */
  onMessageAgent?: (agentId: string, runId: string, stepId: string, to: string, message: string, priority: string, type: string) => Promise<string>;
  /** Called when agent sends a Slack DM to the user */
  onSlackDm?: (agentId: string, runId: string, stepId: string, message: string, urgent: boolean) => Promise<string>;
  /** Called when agent calls the research tool (Perplexity via OpenRouter) */
  onResearch?: (agentId: string, runId: string, stepId: string, query: string, focus: string, model: string) => Promise<string>;
  /** Called when an onboarding agent triggers a handoff to the next agent */
  onOnboardingHandoff?: (agentId: string, runId: string, stepId: string, nextAgent: string, summary: string, context?: Record<string, unknown>) => Promise<string>;
}

/**
 * PiMonoRunner — AgentRunner implementation using @mariozechner/pi-agent-core's Agent class.
 *
 * Enables tool-based agent execution where agents call complete(), fail(), and share_knowledge()
 * tools instead of outputting raw text. Falls back to text parsing for backward compatibility.
 */
export class PiMonoRunner implements AgentRunner {
  private initialized = false;
  private config: PiMonoRunnerConfig;

  constructor(config: PiMonoRunnerConfig = {}) {
    this.config = config;
  }

  private ensureInitialized(): void {
    if (!this.initialized) {
      registerBuiltInApiProviders();
      this.initialized = true;
    }
  }

  /**
   * Inject a map of { providerId: apiKey } into process.env using PROVIDER_ENV_MAP.
   * Always overwrites so that DB-stored keys (which may be newer than the startup
   * value) take effect on every call, while still respecting keys that are only in
   * process.env (i.e. they won't be cleared if absent from the map).
   *
   * Custom providers (prefix "custom-") store their API key under
   * CUSTOM_<SLUG>_API_KEY — derived from the provider_id.
   */
  private injectKeys(keys: Record<string, string>): void {
    for (const [provider, apiKey] of Object.entries(keys)) {
      if (!apiKey) continue;

      // Custom provider: derive env var name from slug
      if (provider.startsWith('custom-')) {
        const slug = provider.slice('custom-'.length).toUpperCase().replace(/-/g, '_');
        const envVar = `CUSTOM_${slug}_API_KEY`;
        process.env[envVar] = apiKey;
        console.info(`[PiMonoRunner] Injected ${envVar} from settings (custom provider)`);
        continue;
      }

      const envVar = PROVIDER_ENV_MAP[provider];
      if (envVar) {
        process.env[envVar] = apiKey;
        console.info(`[PiMonoRunner] Injected ${envVar} from settings`);
      }
    }
  }

  /**
   * Fetch provider API keys and extra env vars from the DB and inject into process.env.
   * Called on every runAgent() so UI-set keys are picked up without restart.
   * Falls back to this.config.providerApiKeys if apiBaseUrl is not configured.
   */
  private async fetchAndInjectProviderApiKeys(userId?: string): Promise<void> {
    const apiBaseUrl = this.config.apiBaseUrl
      || process.env.DJINNBOT_API_URL
      || null;

    if (apiBaseUrl) {
      const userParam = userId ? `?user_id=${encodeURIComponent(userId)}` : '';
      console.log(`[PiMonoRunner] Key resolution: userId=${userId ?? 'system'}, mode=${userId ? 'per-user' : 'instance'}`);
      try {
        const res = await authFetch(`${apiBaseUrl}/v1/settings/providers/keys/all${userParam}`);
        if (res.ok) {
          const data = await res.json() as { keys: Record<string, string>; extra?: Record<string, string> };
          const keys = data.keys ?? {};
          const extra = data.extra ?? {};
          if (Object.keys(keys).length > 0 || Object.keys(extra).length > 0) {
            console.log(`[PiMonoRunner] Resolved providers: [${Object.keys(keys).join(', ')}]`);
            // Inject primary API keys (provider_id → env var via PROVIDER_ENV_MAP)
            this.injectKeys(keys);
            // Inject extra env vars directly (e.g. AZURE_OPENAI_BASE_URL)
            for (const [envVar, value] of Object.entries(extra)) {
              if (value) {
                process.env[envVar] = value;
                console.info(`[PiMonoRunner] Injected extra env var ${envVar} from settings`);
              }
            }
            return;
          }
        }
      } catch (err) {
        console.warn('[PiMonoRunner] Failed to fetch provider keys from settings:', err);
      }
    }

    // Fallback: use statically-provided keys (legacy path)
    if (this.config.providerApiKeys) {
      this.injectKeys(this.config.providerApiKeys);
    }
  }

  /**
   * Extract text content from an AssistantMessage.
   * Only includes text blocks, skips thinking blocks and tool calls.
   */
  private extractTextFromMessage(message: AssistantMessage): string {
    let result = '';

    for (const item of message.content) {
      if (item.type === 'text') {
        result += item.text;
      }
      // Skip thinking blocks and tool calls - they're internal
    }

    return result;
  }

  async runAgent(options: RunAgentOptions): Promise<AgentRunResult> {
    this.ensureInitialized();
    // Fetch and inject API keys from DB before resolving the model.
    // This ensures UI-set keys are always available without a restart.
    // Pass userId so per-user key resolution (personal > admin-shared) is applied
    // when the run is scoped to a specific user via project key_user_id or
    // initiated_by_user_id.
    await this.fetchAndInjectProviderApiKeys(options.userId);

    // Handle structured output steps in-process (PiMonoRunner path).
    // Delegates to StructuredOutputRunner for the actual HTTP call.
    if (options.outputSchema) {
      const sessionId = `pi_structured_${options.runId}_${options.stepId}_${Date.now()}`;
      console.log(`[PiMonoRunner] Structured output for step ${options.stepId}`);

      const structuredRunner = new StructuredOutputRunner({
        apiBaseUrl: this.config.apiBaseUrl,
        onStreamChunk: (runId, stepId, chunk) => {
          this.config.onStreamChunk?.(options.agentId, runId, stepId, chunk);
        },
      });

      const result = await structuredRunner.run({
        runId: options.runId,
        stepId: options.stepId,
        model: options.model,
        systemPrompt: options.systemPrompt,
        userPrompt: options.userPrompt,
        outputSchema: options.outputSchema,
        outputMethod: options.outputMethod,
        timeout: options.timeout,
        maxOutputTokens: options.maxOutputTokens,
        temperature: options.temperature,
        userId: options.userId,
      });

      if (result.success && result.data) {
        return {
          sessionId,
          output: result.rawJson,
          success: true,
          parsedOutputs: { _structured_json: result.rawJson },
          modelUsed: result.modelUsed,
        };
      }
      // On failure, fall through to normal agent execution as fallback
      console.warn(`[PiMonoRunner] Structured output failed: ${result.error}, falling back to agent`);
    }

    const sessionId = `pi_${options.runId}_${options.stepId}_${Date.now()}`;

    // State captured by tool callbacks
    let completed = false;
    let failed = false;
    let toolOutputs: Record<string, string> = {};
    let failError = '';
    let failDetails = '';
    let summary = '';
    let rawOutput = '';

    // Create tool callbacks
    const callbacks: DjinnBotToolCallbacks = {
      onComplete: (outputs, sum) => {
        completed = true;
        toolOutputs = outputs;
        summary = sum || '';
      },
      onFail: (error, details) => {
        failed = true;
        failError = error;
        failDetails = details || '';
      },
      onShareKnowledge: async (entry) => {
        if (this.config.onShareKnowledge) {
          await this.config.onShareKnowledge(options.agentId, options.runId, options.stepId, entry);
        }
      },
      onRemember: async (entry) => {
        if (this.config.onRemember) {
          await this.config.onRemember(options.agentId, options.runId, options.stepId, entry);
        }
      },
      onRecall: async (query, scope, profile, budget) => {
        if (this.config.onRecall) {
          return await this.config.onRecall(options.agentId, options.runId, options.stepId, query, scope, profile, budget);
        }
        return 'Memory not available.';
      },
      onGraphQuery: async (action, nodeId, query, maxHops, scope) => {
        if (this.config.onGraphQuery) {
          return await this.config.onGraphQuery(options.agentId, options.runId, options.stepId, action, nodeId, query, maxHops, scope);
        }
        return 'Graph query not available.';
      },
      onLinkMemory: async (fromId, toId, relationType) => {
        if (this.config.onLinkMemory) {
          await this.config.onLinkMemory(options.agentId, options.runId, options.stepId, fromId, toId, relationType);
        }
      },
      onCheckpoint: async (workingOn, focus, decisions) => {
        if (this.config.onCheckpoint) {
          await this.config.onCheckpoint(options.agentId, options.runId, options.stepId, workingOn, focus, decisions);
        }
      },
      onMessageAgent: async (to, message, priority, type) => {
        if (this.config.onMessageAgent) {
          return await this.config.onMessageAgent(options.agentId, options.runId, options.stepId, to, message, priority, type);
        }
        return 'Messaging not available.';
      },
      onSlackDm: async (message, urgent) => {
        if (this.config.onSlackDm) {
          return await this.config.onSlackDm(options.agentId, options.runId, options.stepId, message, urgent);
        }
        return 'Slack DM not available - user Slack ID may not be configured in Settings.';
      },
      onResearch: async (query, focus, model) => {
        if (this.config.onResearch) {
          return await this.config.onResearch(options.agentId, options.runId, options.stepId, query, focus, model);
        }
        // Default: call OpenRouter/Perplexity directly if API key is available
        return performResearch(query, focus, model);
      },
      onOnboardingHandoff: this.config.onOnboardingHandoff
        ? async (nextAgent, summary, context) => {
            return await this.config.onOnboardingHandoff!(options.agentId, options.runId, options.stepId, nextAgent, summary, context);
          }
        : undefined,
    };

    const tools = createDjinnBotTools(callbacks);

    // Add pulse tools for pulse sessions (detected by stepId starting with "STANDALONE_")
    const isPulseSession = options.stepId.startsWith('STANDALONE_');
    if (isPulseSession) {
      const pulseTools = createPulseTools(options.agentId, options.pulseColumns);
      tools.push(...pulseTools);
      console.log(`[PiMonoRunner] Added pulse tools for agent ${options.agentId} (columns: ${(options.pulseColumns || []).join(', ') || 'default'})`);
    }

    // Add native MCP tools for any server granted to this agent.
    // Fetched fresh on every runAgent() call so mid-run grant changes take effect.
    const apiBaseUrl = this.config.apiBaseUrl || process.env.DJINNBOT_API_URL || 'http://api:8000';
    const apiToken = process.env.ENGINE_INTERNAL_TOKEN || process.env.AGENT_API_KEY;
    const mcpTools = await createMcpTools(
      options.agentId,
      apiBaseUrl,
      process.env.MCPO_API_KEY || '',
      apiToken,
    );
    if (mcpTools.length > 0) {
      tools.push(...mcpTools as AgentTool[]);
      console.log(`[PiMonoRunner] Added ${mcpTools.length} MCP tool(s) for agent ${options.agentId}: [${mcpTools.map(t => t.name).join(', ')}]`);
    }

    // Add coding tools (read, write, edit, bash, grep, find, ls) if workspace is available
    if (options.workspacePath) {
      // In-process runner uses host paths directly (not container paths)
      // Container paths like /home/agent/clawvault are only valid inside containers
      const workspacePath = options.workspacePath;
      const vaultPath = options.vaultPath || `/data/vaults/${options.agentId}`;

      // Simple path resolution - translate agent paths to host paths
      const translatePath = (agentPath: string): string => {
        // Relative paths are resolved against workspace
        if (!agentPath.startsWith('/')) {
          return `${workspacePath}/${agentPath}`;
        }
        // Absolute paths - use as-is (in-process has direct filesystem access)
        return agentPath;
      };

      // In-process bash operations - commands run directly on host
      // No container isolation - this is for USE_CONTAINER_RUNNER=false
      const containerOps = {
        exec: async (
          command: string,
          cwd: string,
          execOpts: {
            onData: (data: Buffer) => void;
            signal?: AbortSignal;
            timeout?: number;
            env?: NodeJS.ProcessEnv;
          },
        ): Promise<{ exitCode: number | null }> => {
          console.log(`[PiMonoRunner] In-process bash for ${options.agentId}: ${command.slice(0, 100)}`);

          const { spawn } = await import('node:child_process');
          return new Promise((resolve) => {
            // Commands run in host environment with workspace as CWD
            const proc = spawn('/bin/bash', ['-c', command], {
              cwd: workspacePath,  // Host path to workspace
              env: {
                ...process.env,
                ...execOpts.env,
              },
            });

            if (execOpts.signal) {
              execOpts.signal.addEventListener('abort', () => proc.kill(), { once: true });
            }

            // execOpts.timeout is in seconds (from the bash tool schema); convert to ms.
            // Fall back to options.timeout (already in ms) or 300,000 ms (5 min).
            const timeout = execOpts.timeout != null
              ? execOpts.timeout * 1000
              : (options.timeout || 300_000);
            const timer = setTimeout(() => proc.kill(), timeout);

            proc.stdout.on('data', (data: Buffer) => execOpts.onData(data));
            proc.stderr.on('data', (data: Buffer) => execOpts.onData(data));

            proc.on('close', (code: number | null) => {
              clearTimeout(timer);
              resolve({ exitCode: code });
            });
          });
        },
      };

      // Create custom file operations that translate sandbox paths to host paths
      // This allows agents to use paths like "/workspace/file.txt" while the actual
      // files are stored in the sandbox directory on the host
      const { readFile, writeFile, mkdir, access, constants } = await import('node:fs/promises');
      const { dirname, isAbsolute, resolve: resolvePath } = await import('node:path');
      
      const sandboxedFileOps = {
        read: {
          readFile: async (agentPath: string) => {
            const hostPath = translatePath(agentPath);
            console.log(`[PiMonoRunner] read: ${agentPath} -> ${hostPath}`);
            return readFile(hostPath);
          },
          access: async (agentPath: string) => {
            const hostPath = translatePath(agentPath);
            return access(hostPath, constants.R_OK);
          },
        },
        write: {
          writeFile: async (agentPath: string, content: string) => {
            const hostPath = translatePath(agentPath);
            console.log(`[PiMonoRunner] write: ${agentPath} -> ${hostPath}`);
            return writeFile(hostPath, content, 'utf-8');
          },
          mkdir: async (agentDir: string) => {
            const hostDir = translatePath(agentDir);
            await mkdir(hostDir, { recursive: true });
          },
        },
      };

      // Create edit operations (needs readFile, writeFile, access)
      const sandboxedEditOps = {
        readFile: sandboxedFileOps.read.readFile,
        writeFile: sandboxedFileOps.write.writeFile,
        access: sandboxedFileOps.read.access,
      };

      // Pass /workspace as cwd so path resolution works from agent's perspective
      // The custom operations translate these virtual paths to actual host paths
      // For in-process runs, we use /workspace as the agent-facing path for consistency
      const readTool = createReadTool('/workspace', { operations: sandboxedFileOps.read });
      const writeTool = createWriteTool('/workspace', { operations: sandboxedFileOps.write });
      const editTool = createEditTool('/workspace', { operations: sandboxedEditOps });
      const bashTool = createBashTool('/workspace', { operations: containerOps });
      
      // Cast to AgentTool[] to match the tools array type (the generics are compatible at runtime)
      tools.push(
        readTool as unknown as AgentTool, 
        writeTool as unknown as AgentTool, 
        editTool as unknown as AgentTool, 
        bashTool as unknown as AgentTool
      );
    }

    // Hoisted so the catch block can use baseUrl for error enrichment.
    let modelBaseUrl: string | undefined;

    try {
      const model = parseModelString(options.model);
      modelBaseUrl = model.baseUrl;

      // Create Agent instance
      const agent = new Agent({
        initialState: {
          systemPrompt: options.systemPrompt,
          model,
          tools,
          messages: [],
          // Pass thinking level if provided — defaults to 'off' inside pi-agent-core
          ...(options.thinkingLevel ? { thinkingLevel: options.thinkingLevel as any } : {}),
        },
      });

      console.log(`[PiMonoRunner] Agent created for step ${options.stepId}. Model: ${model.id}, Tools: [${tools.map(t => t.name).join(', ')}], maxTokens: ${model.maxTokens}, reasoning: ${model.reasoning}`);

      // Track turns for maxTurns limit
      const maxTurns = options.maxTurns ?? 999;
      let turnCount = 0;

      // Track tool call durations
      const toolCallTimers = new Map<string, number>();

      // Track agent state transitions
      let currentAgentState: string = 'idle';
      const transitionTo = (newState: string, toolName?: string) => {
        if (newState !== currentAgentState) {
          currentAgentState = newState;
          this.config.onAgentState?.(options.agentId, options.runId, options.stepId, newState as any, toolName);
        }
      };

      // Subscribe for streaming updates
      const unsubscribe = agent.subscribe((event: AgentEvent) => {
        if (event.type === 'agent_start') {
          console.log(`[PiMonoRunner] agent_start for ${options.stepId}`);
        }
        if (event.type === 'agent_end') {
          console.log(`[PiMonoRunner] agent_end for ${options.stepId}`);
        }
        if (event.type === 'turn_start') {
          console.log(`[PiMonoRunner] turn_start for ${options.stepId}`);
        }
        if (event.type === 'turn_end') {
          turnCount++;
          transitionTo('idle');
          console.log(`[PiMonoRunner] turn_end for ${options.stepId}, stopReason: ${(event as any).message?.stopReason}, turn ${turnCount}/${maxTurns}`);
          if (turnCount >= maxTurns) {
            console.warn(`[PiMonoRunner] Max turns (${maxTurns}) reached for ${options.stepId}, aborting agent`);
            agent.abort();
          }
        }
        if (event.type === 'tool_execution_start') {
          const toolName = (event as any).toolName ?? 'unknown';
          transitionTo('tool_calling', toolName);
          const toolCallId = (event as any).toolCallId ?? '';
          const args = JSON.stringify((event as any).args ?? {});
          toolCallTimers.set(toolCallId || toolName, Date.now());
          this.config.onToolCallStart?.(options.agentId, options.runId, options.stepId, toolName, toolCallId, args);
          console.log(`[PiMonoRunner] tool_execution_start: ${toolName} for ${options.stepId}`);
        }
        if (event.type === 'tool_execution_end') {
          const toolName = (event as any).toolName ?? 'unknown';
          const toolCallId = (event as any).toolCallId ?? '';
          const rawResult = (event as any).result;
          const result = typeof rawResult === 'string' ? rawResult
            : rawResult?.content ? rawResult.content.map((c: any) => c.text ?? JSON.stringify(c)).join('\n')
            : JSON.stringify(rawResult ?? '');
          const isError = (event as any).isError ?? false;
          const startTime = toolCallTimers.get(toolCallId || toolName);
          const durationMs = startTime ? Date.now() - startTime : 0;
          toolCallTimers.delete(toolCallId || toolName);
          this.config.onToolCallEnd?.(options.agentId, options.runId, options.stepId, toolName, toolCallId, result, isError, durationMs);
          transitionTo('idle');
          console.log(`[PiMonoRunner] tool_execution_end: ${toolName} (error: ${isError}) for ${options.stepId}`);
        }
        if (event.type === 'message_update') {
          const assistantEvent = event.assistantMessageEvent;

          if (assistantEvent.type === 'thinking_delta') {
            // Thinking/reasoning content
            transitionTo('thinking');
            const delta = (assistantEvent as any).delta ?? '';
            if (delta && this.config.onThinkingChunk) {
              this.config.onThinkingChunk(options.agentId, options.runId, options.stepId, delta);
            }
          } else if (assistantEvent.type === 'text_delta') {
            // Regular text output
            transitionTo('streaming');
            const delta = assistantEvent.delta;
            rawOutput += delta;
            if (this.config.onStreamChunk) {
              this.config.onStreamChunk(options.agentId, options.runId, options.stepId, delta);
            }
          }
          // Ignore: text_start, text_end, thinking_start, thinking_end,
          // toolcall_start, toolcall_delta, toolcall_end, start, done, error
        }
        if (event.type === 'message_end') {
          const message = event.message;
          if (message.role === 'assistant') {
            // Extract final text, excluding thinking blocks
            const extracted = this.extractTextFromMessage(message);
            if (extracted && !rawOutput.includes(extracted)) {
              rawOutput = extracted;
            }
          }
        }
      });

      // Set up timeout
      const timeoutMs = options.timeout || 300_000;
      const timeoutId = setTimeout(() => {
        agent.abort();
      }, timeoutMs);

      // Wire up external abort signal (from stop button / cancellation)
      if (options.signal) {
        if (options.signal.aborted) {
          clearTimeout(timeoutId);
          throw new Error('Run was cancelled before agent started');
        }
        options.signal.addEventListener('abort', () => {
          console.log(`[PiMonoRunner] Received abort signal for step ${options.stepId}`);
          agent.abort();
        }, { once: true });
      }

      try {
        // Run the agent
        await agent.prompt(options.userPrompt);
        await agent.waitForIdle();
        clearTimeout(timeoutId);
      } catch (err) {
        clearTimeout(timeoutId);
        throw err;
      } finally {
        unsubscribe();
      }

      // Check results
      if (completed) {
        return {
          sessionId,
          output: JSON.stringify({ ...toolOutputs, status: 'done', summary }),
          success: true,
          parsedOutputs: { ...toolOutputs, status: 'done', summary },
        };
      } else if (failed) {
        return {
          sessionId,
          output: rawOutput,
          success: false,
          error: failError + (failDetails ? `\n${failDetails}` : ''),
        };
      } else {
        // Agent didn't call complete or fail — return raw output
        // The AgentExecutor's parseOutputKeyValues will handle it
        return {
          sessionId,
          output: rawOutput,
          success: true,
        };
      }
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      return {
        sessionId,
        output: rawOutput,
        success: false,
        error: enrichNetworkError(error, modelBaseUrl, /* inContainer */ false),
      };
    }
  }
}
