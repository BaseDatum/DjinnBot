import { Agent } from '@mariozechner/pi-agent-core';
import { registerBuiltInApiProviders, registerApiProvider, streamOpenAICompletions } from '@mariozechner/pi-ai';
import type { AssistantMessage, ImageContent, TextContent } from '@mariozechner/pi-ai';
import type { AgentEvent, AgentTool, AgentMessage } from '@mariozechner/pi-agent-core';
import type { RedisPublisher } from '../redis/publisher.js';
import { createDjinnBotTools } from './djinnbot-tools.js';
import { createContainerTools } from './tools.js';
import { createMcpTools } from './mcp-tools.js';
import { parseModelString, CUSTOM_PROVIDER_API } from '@djinnbot/core';
import { buildAttachmentBlocks, type AttachmentMeta } from './attachments.js';
import { authFetch } from '../api/auth-fetch.js';
import { MemoryRetrievalTracker } from './djinnbot-tools/memory-scoring.js';

export interface StepResult {
  output?: string;
  error?: string;
  success: boolean;
}

/**
 * Mutable ref shared with tool closures so they always read the current
 * requestId without needing to be recreated every turn.
 */
export interface RequestIdRef {
  current: string;
}

export interface ContainerAgentRunnerOptions {
  publisher: RedisPublisher;
  /** Redis client for direct operations (work ledger, coordination). */
  redis: import('../redis/client.js').RedisClient;
  agentId: string;
  workspacePath: string;
  vaultPath: string;
  sharedPath: string;
  model?: string;
  runId?: string;
  /** Path to agents directory — used by skill tools. Defaults to AGENTS_DIR env var. */
  agentsDir?: string;
  /** Extended thinking level. When set (and not 'off'), the Agent requests reasoning tokens. */
  thinkingLevel?: string;
}

let initialized = false;

function ensureInitialized(): void {
  if (!initialized) {
    registerBuiltInApiProviders();
    initialized = true;
  }
}

/**
 * Register the custom OpenAI-compatible api type with pi-ai's api registry.
 *
 * Custom providers use api:'custom-openai-completions' (CUSTOM_PROVIDER_API)
 * instead of the built-in 'openai-completions'.  The built-in routes through
 * streamSimpleOpenAICompletions which hard-throws when no API key is found in
 * its internal env-var map — local servers like LM Studio and Ollama are not
 * in that map and don't need a key.  We register our own api type backed by
 * streamOpenAICompletions, which falls back to an empty apiKey string and
 * lets the request proceed unauthenticated.
 */
let customProviderRegistered = false;

function ensureCustomProviderRegistered(): void {
  if (customProviderRegistered) return;
  customProviderRegistered = true;
  registerApiProvider(
    {
      api: CUSTOM_PROVIDER_API as any,
      stream: streamOpenAICompletions as any,
      streamSimple: streamOpenAICompletions as any,
    },
    'djinnbot-custom',
  );
  console.log(`[AgentRunner] Registered custom api provider: ${CUSTOM_PROVIDER_API}`);
}



function extractTextFromMessage(message: AssistantMessage): string {
  let result = '';
  for (const item of message.content) {
    if (item.type === 'text') {
      result += item.text;
    }
  }
  return result;
}

export class ContainerAgentRunner {
  // ── Mutable refs shared with tool closures ──────────────────────────────
  // Tools capture these refs once at construction time and read `.current`
  // on each invocation, so they always use the latest value without needing
  // to be recreated every turn.
  private requestIdRef: RequestIdRef = { current: '' };
  private stepCompleted = false;
  private stepResult: StepResult = { success: false };
  private currentAgent: Agent | null = null;

  // Persistent agent instance reused across turns so conversation history
  // (including tool calls and results) is preserved natively by pi-agent-core.
  private persistentAgent: Agent | null = null;
  private persistentSystemPrompt: string = '';

  // ── Cached across turns (built once, reused) ───────────────────────────
  private resolvedModel: ReturnType<typeof parseModelString> | null = null;
  private tools: AgentTool[] | null = null;
  private mcpTools: AgentTool[] = [];
  private mcpToolsDirty = true; // Start dirty so first turn fetches
  // Set of built-in tool names that the user has explicitly disabled.
  private disabledTools: Set<string> = new Set();
  private disabledToolsDirty = true; // Start dirty so first turn fetches
  private unsubscribeAgent: (() => void) | null = null;

  // ── Per-step mutable state read by the persistent subscription ──────────
  private rawOutput = '';
  private turnCount = 0;
  private toolCallStartTimes = new Map<string, number>();

  // ── LLM call logging ──────────────────────────────────────────────────
  private turnStartTime = 0;
  private turnToolCallCount = 0;
  private turnHasThinking = false;

  // ── Memory retrieval tracking ──────────────────────────────────────────
  /** Tracks which memories were recalled during this step for adaptive scoring. */
  readonly retrievalTracker: MemoryRetrievalTracker;

  constructor(private options: ContainerAgentRunnerOptions) {
    ensureInitialized();
    ensureCustomProviderRegistered();
    this.retrievalTracker = new MemoryRetrievalTracker(
      options.agentId,
      process.env.DJINNBOT_API_URL || 'http://api:8000',
    );
  }

  /**
   * Abort the currently running agent step.
   */
  abort(): void {
    if (this.currentAgent) {
      console.log(`[AgentRunner] Aborting current agent step (requestId: ${this.requestIdRef.current})`);
      this.currentAgent.abort();
      this.currentAgent = null;
    } else {
      console.log(`[AgentRunner] No active agent to abort`);
    }
  }

  /**
   * Reset the persistent agent (e.g. when starting a fresh session).
   */
  resetSession(): void {
    if (this.unsubscribeAgent) {
      this.unsubscribeAgent();
      this.unsubscribeAgent = null;
    }
    this.persistentAgent = null;
    this.persistentSystemPrompt = '';
    this.resolvedModel = null;
    this.tools = null;
    this.mcpTools = [];
    this.mcpToolsDirty = true;
    this.disabledTools = new Set();
    this.disabledToolsDirty = true;
    console.log(`[AgentRunner] Session reset — conversation history cleared`);
  }

  /**
   * Mark MCP tool cache as stale. Called when the engine sends an
   * invalidateMcpTools command (triggered by grant/revoke in the API).
   * The next runStep() will re-fetch tool definitions from the API.
   */
  invalidateMcpTools(): void {
    this.mcpToolsDirty = true;
    console.log(`[AgentRunner] MCP tools marked dirty — will refresh on next turn`);
  }

  /**
   * Mark built-in tool override cache as stale.
   * Called when the 'djinnbot:tools:overrides-changed' Redis broadcast arrives.
   * The next runStep() will re-fetch the disabled-tools list from the API.
   */
  invalidateToolOverrides(): void {
    this.disabledToolsDirty = true;
    console.log(`[AgentRunner] Tool overrides marked dirty — will refresh on next turn`);
  }

  // ── Model resolution (once) ─────────────────────────────────────────────

  private getModel() {
    if (!this.resolvedModel) {
      this.resolvedModel = parseModelString(this.options.model || 'anthropic/claude-sonnet-4');
      console.log(`[AgentRunner] Model resolved: ${this.resolvedModel.id} (api: ${this.resolvedModel.api})`);
    }
    return this.resolvedModel;
  }

  // ── Tool construction (once, uses requestIdRef) ─────────────────────────

  private buildTools(): AgentTool[] {
    const apiBaseUrl = process.env.DJINNBOT_API_URL || 'http://api:8000';
    const pulseColumnsRaw = process.env.PULSE_COLUMNS || '';
    const pulseColumns = pulseColumnsRaw
      ? pulseColumnsRaw.split(',').map(c => c.trim()).filter(Boolean)
      : [];

    // Detect session context from env vars injected by the engine at container start.
    // RUN_ID format signals the run type:
    //   'run_*'        → pipeline step (agent executing a task in a pipeline)
    //   'standalone_*' → pulse/standalone session (agent discovering and dispatching work)
    //   anything else  → plain chat session
    const runId = process.env.RUN_ID || '';
    const isPipelineRun = runId.startsWith('run_');
    const isPulseSession = runId.startsWith('standalone_');
    const isOnboardingSession = Boolean(process.env.ONBOARDING_SESSION_ID);

    console.log(
      `[AgentRunner] Session context: isPipelineRun=${isPipelineRun}, isPulseSession=${isPulseSession}, isOnboardingSession=${isOnboardingSession}`,
    );

    const tools: AgentTool[] = [];

    // Container tools (read, write, edit, bash with Redis streaming)
    const containerTools = createContainerTools({
      workspacePath: this.options.workspacePath,
      publisher: this.options.publisher,
      requestIdRef: this.requestIdRef,
    });
    tools.push(...containerTools);

    // DjinnBot tools (complete, fail, recall, remember, project/task tools, skills, etc.)
    const djinnBotTools = createDjinnBotTools({
      publisher: this.options.publisher,
      redis: this.options.redis,
      requestIdRef: this.requestIdRef,
      agentId: this.options.agentId,
      sessionId: this.options.runId || process.env.RUN_ID || 'unknown',
      vaultPath: this.options.vaultPath,
      sharedPath: this.options.sharedPath,
      agentsDir: this.options.agentsDir || process.env.AGENTS_DIR,
      apiBaseUrl,
      pulseColumns,
      isPipelineRun,
      isPulseSession,
      isOnboardingSession,
      retrievalTracker: this.retrievalTracker,
      onComplete: (outputs, summary) => {
        this.stepCompleted = true;
        this.stepResult = {
          success: true,
          output: summary || JSON.stringify(outputs),
        };
      },
      onFail: (error, details) => {
        this.stepCompleted = true;
        this.stepResult = {
          success: false,
          error: details ? `${error}: ${details}` : error,
        };
      },
    });
    tools.push(...djinnBotTools);

    console.log(`[AgentRunner] Built ${tools.length} static tools (container + djinnbot)`);
    return tools;
  }

  /**
   * Refresh disabled-tool overrides only when the cache is dirty.
   * Fetches the list of disabled tool names from the API.
   */
  private async refreshToolOverrides(): Promise<void> {
    const apiBaseUrl = process.env.DJINNBOT_API_URL || 'http://api:8000';
    const apiToken = process.env.AGENT_API_KEY || process.env.ENGINE_INTERNAL_TOKEN;
    try {
      const url = `${apiBaseUrl}/v1/agents/${this.options.agentId}/tools/disabled`;
      const res = await authFetch(url, {
        headers: apiToken ? { Authorization: `Bearer ${apiToken}` } : {},
      });
      if (res.ok) {
        const disabled = await res.json() as string[];
        this.disabledTools = new Set(disabled);
        console.log(`[AgentRunner] Tool overrides refreshed: ${disabled.length} disabled tool(s)${disabled.length ? ` (${disabled.join(', ')})` : ''}`);
      } else {
        console.warn(`[AgentRunner] Failed to fetch tool overrides: ${res.status} — proceeding with all tools enabled`);
        this.disabledTools = new Set();
      }
    } catch (err) {
      console.warn(`[AgentRunner] Error fetching tool overrides: ${err} — proceeding with all tools enabled`);
      this.disabledTools = new Set();
    }
    this.disabledToolsDirty = false;
  }

  /**
   * Refresh MCP tools only when the cache is dirty (grant changed).
   * Returns the full tools array (static tools filtered by overrides + MCP).
   */
  private async getTools(): Promise<AgentTool[]> {
    if (!this.tools) {
      this.tools = this.buildTools();
    }

    // Refresh disabled-tools list when dirty (startup or override change)
    if (this.disabledToolsDirty) {
      await this.refreshToolOverrides();
    }

    if (this.mcpToolsDirty) {
      const apiBaseUrl = process.env.DJINNBOT_API_URL || 'http://api:8000';
      const apiToken = process.env.AGENT_API_KEY || process.env.ENGINE_INTERNAL_TOKEN;
      this.mcpTools = await createMcpTools(
        this.options.agentId,
        apiBaseUrl,
        process.env.MCPO_API_KEY || '',
        apiToken,
      );
      this.mcpToolsDirty = false;
      console.log(`[AgentRunner] MCP tools refreshed: ${this.mcpTools.length} tool(s)`);
    }

    // Apply per-agent built-in tool overrides
    const activeTools = this.disabledTools.size > 0
      ? this.tools.filter(t => !this.disabledTools.has(t.name))
      : this.tools;

    return [...activeTools, ...this.mcpTools];
  }

  // ── Persistent event subscription ───────────────────────────────────────
  // Registered once on the Agent and reads mutable instance state
  // (requestIdRef, rawOutput, turnCount, etc.) so it doesn't need to be
  // re-created each turn.

  private setupSubscription(agent: Agent): void {
    if (this.unsubscribeAgent) return; // Already subscribed

    const maxTurns = 999;

    this.unsubscribeAgent = agent.subscribe(async (event: AgentEvent) => {
      if (event.type === 'turn_start') {
        console.log(`[AgentRunner] turn_start`);
        this.turnStartTime = Date.now();
        this.turnToolCallCount = 0;
        this.turnHasThinking = false;
      }
      if (event.type === 'turn_end') {
        this.turnCount++;
        console.log(`[AgentRunner] turn_end, turn ${this.turnCount}/${maxTurns}`);
        if (this.turnCount >= maxTurns) {
          console.warn(`[AgentRunner] Max turns (${maxTurns}) reached, aborting`);
          agent.abort();
        }
      }
      if (event.type === 'tool_execution_start') {
        const toolName = (event as any).toolName ?? 'unknown';
        const toolCallId = (event as any).toolCallId ?? `tool_${Date.now()}`;
        const args = (event as any).args ?? {};
        console.log(`[AgentRunner] tool_execution_start: ${toolName}`);
        this.turnToolCallCount++;

        this.toolCallStartTimes.set(toolCallId, Date.now());

        this.options.publisher.publishEvent({
          type: 'toolStart',
          requestId: this.requestIdRef.current,
          toolName,
          args,
        } as any).catch(err => console.error('[AgentRunner] Failed to publish toolStart:', err));
      }
      if (event.type === 'tool_execution_end') {
        const toolName = (event as any).toolName ?? 'unknown';
        const toolCallId = (event as any).toolCallId ?? '';
        const isError = (event as any).isError ?? false;
        const result = (event as any).result;
        console.log(`[AgentRunner] tool_execution_end: ${toolName} (error: ${isError})`);

        const startTime = this.toolCallStartTimes.get(toolCallId);
        const durationMs = startTime ? Date.now() - startTime : 0;
        this.toolCallStartTimes.delete(toolCallId);

        this.options.publisher.publishEvent({
          type: 'toolEnd',
          requestId: this.requestIdRef.current,
          toolName,
          result: typeof result === 'string' ? result : JSON.stringify(result),
          success: !isError,
          durationMs,
        } as any).catch(err => console.error('[AgentRunner] Failed to publish toolEnd:', err));
      }
      if (event.type === 'message_update') {
        const assistantEvent = event.assistantMessageEvent;
        if (assistantEvent.type === 'text_delta') {
          const delta = assistantEvent.delta;
          this.rawOutput += delta;
          if (delta) {
            this.options.publisher.publishOutputFast({
              type: 'stdout',
              requestId: this.requestIdRef.current,
              data: delta,
            });
          }
        }
        if (assistantEvent.type === 'thinking_delta') {
          this.turnHasThinking = true;
          const thinking = (assistantEvent as any).delta ?? '';
          if (thinking) {
            this.options.publisher.publishEventFast({
              type: 'thinking',
              requestId: this.requestIdRef.current,
              thinking,
            } as any);
          }
        }
      }
      if (event.type === 'message_end') {
        const message = event.message;
        if (message.role === 'assistant') {
          const extracted = extractTextFromMessage(message);
          if (extracted && !this.rawOutput.includes(extracted)) {
            this.rawOutput = extracted;
          }

          // ── Log this LLM call to the API ────────────────────────────────
          this.logLlmCall(message as AssistantMessage);
        }
      }
    });
  }

  // ── LLM call logging ──────────────────────────────────────────────────

  /**
   * Log a completed LLM API call to the backend.
   * Called on every message_end event for assistant messages.
   * Fire-and-forget — does not block the agent loop.
   */
  private logLlmCall(message: AssistantMessage): void {
    const apiBaseUrl = process.env.DJINNBOT_API_URL || 'http://api:8000';
    const model = this.getModel();
    const usage = message.usage || { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, total: 0 } };
    const cost = usage.cost || { input: 0, output: 0, total: 0 };
    const durationMs = this.turnStartTime ? Date.now() - this.turnStartTime : undefined;

    // Determine the session/run context from env vars injected by the engine
    const sessionId = process.env.SESSION_ID || process.env.CHAT_SESSION_ID || undefined;
    const runId = process.env.RUN_ID || undefined;

    // Determine key source from env (injected by engine along with the keys)
    const keySource = process.env.KEY_SOURCE || undefined;
    const keyMasked = process.env.KEY_MASKED || undefined;
    // User attribution for per-user daily usage tracking / share limit enforcement
    const userId = process.env.DJINNBOT_USER_ID || undefined;

    const payload = {
      session_id: sessionId,
      run_id: runId,
      agent_id: this.options.agentId,
      request_id: this.requestIdRef.current || undefined,
      user_id: userId,
      provider: String(model.provider),
      model: model.id,
      key_source: keySource,
      key_masked: keyMasked,
      input_tokens: usage.input || 0,
      output_tokens: usage.output || 0,
      cache_read_tokens: usage.cacheRead || 0,
      cache_write_tokens: usage.cacheWrite || 0,
      total_tokens: usage.totalTokens || 0,
      cost_input: cost.input || undefined,
      cost_output: cost.output || undefined,
      cost_total: cost.total || undefined,
      duration_ms: durationMs,
      tool_call_count: this.turnToolCallCount,
      has_thinking: this.turnHasThinking,
      stop_reason: message.stopReason ? String(message.stopReason) : undefined,
    };

    authFetch(`${apiBaseUrl}/v1/internal/llm-calls`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    }).catch(err => {
      console.warn('[AgentRunner] Failed to log LLM call:', err);
    });
  }

  /**
   * Seed the persistent agent with historical conversation messages.
   * Call this BEFORE the first runStep() to restore prior chat history.
   * Messages should be in chronological order as plain {role, content} objects.
   * Only seeds if no persistent agent exists yet (i.e., fresh container start).
   */
  seedHistory(systemPrompt: string, history: Array<{ role: string; content: string; attachments?: AttachmentMeta[] }>): void {
    if (this.persistentAgent) {
      console.log(`[AgentRunner] seedHistory: agent already initialized, skipping`);
      return;
    }
    if (history.length === 0) return;

    const model = this.getModel();

    // Build LLM-compatible messages from history.
    // We use `any` casts here because pi-ai's AssistantMessage type requires
    // provider-specific fields (api, provider, usage, etc.) that we don't have
    // when replaying stored history. The runtime behavior is correct because the
    // Anthropic/OpenRouter providers only inspect role + content when sending
    // historical context back to the API.
    //
    // NOTE: Attachment data (images, documents) from previous turns is NOT
    // re-injected here.  Re-fetching and base64-encoding images for every
    // session restart would be extremely expensive.  Instead, the user message
    // text is replayed as-is — the model sees "[user attached photo.jpg]" in
    // the text but not the actual image bytes.  The model still has the
    // conversation continuity it needs; only the very latest turn (which
    // goes through runStep with live attachments) gets full multimodal content.
    const messages: AgentMessage[] = history
      .filter(m => m.role === 'user' || m.role === 'assistant')
      .map(m => {
        if (m.role === 'user') {
          // If the message had attachments, prepend a note so the model
          // knows files were present even though we're not re-injecting them.
          let content: string = m.content;
          if (m.attachments && m.attachments.length > 0) {
            const fileList = m.attachments
              .map(a => `${a.filename} (${a.mimeType})`)
              .join(', ');
            content = `[User attached files: ${fileList}]\n${m.content}`;
          }
          return {
            role: 'user' as const,
            content,
            timestamp: Date.now(),
          };
        }
        // Minimal assistant message structure — provider inspects content[] blocks
        return {
          role: 'assistant' as const,
          content: [{ type: 'text', text: m.content }],
          api: 'anthropic' as any,
          provider: 'anthropic' as any,
          model: this.options.model || 'anthropic/claude-sonnet-4',
          usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
          stopReason: 'stop' as any,
          timestamp: Date.now(),
        } as any;
      });

    const isCustomProvider = (model.api as string) === CUSTOM_PROVIDER_API;
    const customApiKey = isCustomProvider
      ? (() => {
          const slug = (model.provider as string).slice('custom-'.length).toUpperCase().replace(/-/g, '_');
          return process.env[`CUSTOM_${slug}_API_KEY`] || 'no-key';
        })()
      : undefined;

    const thinkingLevel = this.options.thinkingLevel;
    this.persistentAgent = new Agent({
      initialState: {
        systemPrompt,
        model,
        tools: [],   // Tools are injected via getTools() on first runStep
        messages,
        ...(thinkingLevel && thinkingLevel !== 'off' ? { thinkingLevel: thinkingLevel as any } : {}),
      },
      ...(isCustomProvider ? {
        getApiKey: async () => customApiKey,
      } : {}),
    });
    this.persistentSystemPrompt = systemPrompt;
    console.log(`[AgentRunner] Seeded persistent agent with ${messages.length} historical messages (thinkingLevel: ${thinkingLevel || 'off'})`);
  }

  // ── Structured Output ────────────────────────────────────────────────────
  // Handles constrained-decoding API calls (response_format / tool_use)
  // inside the container, replacing the old in-engine StructuredOutputRunner.

  /**
   * Resolve a model string to an API base URL, model ID, and API key.
   * Used by runStructuredOutput() to call the LLM API directly.
   */
  private resolveModelForStructuredOutput(modelString: string): { baseUrl: string; modelId: string; apiKey: string } {
    const parts = modelString.split('/');

    if (parts[0] === 'openrouter' || parts.length > 2) {
      const modelId = parts.slice(1).join('/');
      return {
        baseUrl: 'https://openrouter.ai/api/v1',
        modelId,
        apiKey: process.env.OPENROUTER_API_KEY || '',
      };
    }

    const provider = parts[0];
    const modelId = parts.slice(1).join('/');

    // Only include providers with OpenAI-compatible APIs.
    // Anthropic and Google use different API formats and route through OpenRouter.
    const providerMap: Record<string, { baseUrl: string; envKey: string }> = {
      openai: { baseUrl: 'https://api.openai.com/v1', envKey: 'OPENAI_API_KEY' },
      xai: { baseUrl: 'https://api.x.ai/v1', envKey: 'XAI_API_KEY' },
    };

    const config = providerMap[provider];
    if (!config || !process.env[config.envKey]) {
      return {
        baseUrl: 'https://openrouter.ai/api/v1',
        modelId: parts.length > 2 ? parts.slice(1).join('/') : modelString,
        apiKey: process.env.OPENROUTER_API_KEY || '',
      };
    }

    return {
      baseUrl: config.baseUrl,
      modelId,
      apiKey: process.env[config.envKey] || '',
    };
  }

  /**
   * Run a structured output request. Makes a direct HTTP call to the LLM API
   * with response_format (JSON Schema) or tool_use fallback.
   * Returns the raw JSON string on success.
   */
  async runStructuredOutput(opts: {
    requestId: string;
    systemPrompt: string;
    userPrompt: string;
    outputSchema: { name: string; schema: Record<string, unknown>; strict?: boolean };
    outputMethod?: 'response_format' | 'tool_use';
    temperature?: number;
    model?: string;
    timeout?: number;
  }): Promise<{ success: boolean; rawJson: string; error?: string }> {
    const modelString = opts.model || process.env.AGENT_MODEL || 'openrouter/moonshotai/kimi-k2.5';
    const method = opts.outputMethod || 'response_format';

    console.log(`[AgentRunner] Running structured output: model=${modelString}, method=${method}, schema=${opts.outputSchema.name}`);

    if (method === 'tool_use') {
      return this.runStructuredWithToolUse(modelString, opts);
    }

    return this.runStructuredWithResponseFormat(modelString, opts);
  }

  private async runStructuredWithResponseFormat(
    modelString: string,
    opts: {
      requestId: string;
      systemPrompt: string;
      userPrompt: string;
      outputSchema: { name: string; schema: Record<string, unknown>; strict?: boolean };
      temperature?: number;
      timeout?: number;
    },
  ): Promise<{ success: boolean; rawJson: string; error?: string }> {
    const { baseUrl, modelId, apiKey } = this.resolveModelForStructuredOutput(modelString);
    const timeoutMs = opts.timeout || 300_000;
    console.log(`[AgentRunner] Structured output POST ${baseUrl}/chat/completions model=${modelId}`);

    const requestBody: Record<string, unknown> = {
      model: modelId,
      messages: [
        { role: 'system', content: opts.systemPrompt },
        { role: 'user', content: opts.userPrompt },
      ],
      response_format: {
        type: 'json_schema',
        json_schema: {
          name: opts.outputSchema.name,
          strict: opts.outputSchema.strict !== false,
          schema: opts.outputSchema.schema,
        },
      },
      temperature: opts.temperature ?? 0.7,
      max_tokens: 16384,
    };

    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${apiKey}`,
    };

    if (baseUrl.includes('openrouter')) {
      headers['HTTP-Referer'] = 'https://djinnbot.dev';
      headers['X-Title'] = 'DjinnBot';
      (requestBody as any).provider = { require_parameters: true };
    }

    const controller = new AbortController();
    const timeoutId = setTimeout(() => {
      console.error(`[AgentRunner] Structured output TIMEOUT after ${timeoutMs}ms`);
      controller.abort();
    }, timeoutMs);

    try {
      const response = await fetch(`${baseUrl}/chat/completions`, {
        method: 'POST',
        headers,
        body: JSON.stringify(requestBody),
        signal: controller.signal,
      });

      clearTimeout(timeoutId);

      if (!response.ok) {
        const errorBody = await response.text();
        // Fall back to tool_use if response_format not supported
        if (response.status === 400 && (
          errorBody.includes('response_format') ||
          errorBody.includes('json_schema') ||
          errorBody.includes('not supported')
        )) {
          console.warn(`[AgentRunner] response_format not supported, falling back to tool_use`);
          return this.runStructuredWithToolUse(modelString, opts as any);
        }
        return { success: false, rawJson: '', error: `API error ${response.status}: ${errorBody}` };
      }

      const bodyText = await response.text();
      const result = JSON.parse(bodyText);
      const content = result.choices?.[0]?.message?.content;

      if (!content) {
        const refusal = result.choices?.[0]?.message?.refusal;
        if (refusal) return { success: false, rawJson: '', error: `Model refused: ${refusal}` };
        return { success: false, rawJson: '', error: 'No content in response' };
      }

      // Stream the content for observability
      this.options.publisher.publishOutputFast({
        type: 'stdout',
        requestId: opts.requestId,
        data: content,
      });

      // Validate JSON
      try {
        JSON.parse(content);
        return { success: true, rawJson: content };
      } catch (parseErr) {
        return { success: false, rawJson: content, error: `JSON parse failed: ${parseErr}` };
      }
    } catch (err) {
      clearTimeout(timeoutId);
      const error = err instanceof Error ? err.message : String(err);
      return { success: false, rawJson: '', error };
    }
  }

  private async runStructuredWithToolUse(
    modelString: string,
    opts: {
      requestId: string;
      systemPrompt: string;
      userPrompt: string;
      outputSchema: { name: string; schema: Record<string, unknown>; strict?: boolean };
      temperature?: number;
      timeout?: number;
    },
  ): Promise<{ success: boolean; rawJson: string; error?: string }> {
    const { baseUrl, modelId, apiKey } = this.resolveModelForStructuredOutput(modelString);
    const toolName = `submit_${opts.outputSchema.name}`;
    const timeoutMs = opts.timeout || 300_000;

    const requestBody: Record<string, unknown> = {
      model: modelId,
      messages: [
        { role: 'system', content: opts.systemPrompt },
        {
          role: 'user',
          content: `${opts.userPrompt}\n\nYou MUST call the ${toolName} tool with your response. Do not output any text — only call the tool.`,
        },
      ],
      tools: [
        {
          type: 'function',
          function: {
            name: toolName,
            description: 'Submit the structured output for this step.',
            parameters: opts.outputSchema.schema,
          },
        },
      ],
      tool_choice: { type: 'function', function: { name: toolName } },
      temperature: opts.temperature ?? 0.7,
      max_tokens: 16384,
    };

    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${apiKey}`,
    };

    if (baseUrl.includes('openrouter')) {
      headers['HTTP-Referer'] = 'https://djinnbot.dev';
      headers['X-Title'] = 'DjinnBot';
    }

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

    try {
      const response = await fetch(`${baseUrl}/chat/completions`, {
        method: 'POST',
        headers,
        body: JSON.stringify(requestBody),
        signal: controller.signal,
      });

      clearTimeout(timeoutId);

      if (!response.ok) {
        const errorBody = await response.text();
        return { success: false, rawJson: '', error: `API error ${response.status}: ${errorBody}` };
      }

      const result = await response.json() as any;
      const toolCall = result.choices?.[0]?.message?.tool_calls?.[0];

      if (!toolCall || toolCall.function?.name !== toolName) {
        const content = result.choices?.[0]?.message?.content;
        if (content) {
          try {
            JSON.parse(content);
            return { success: true, rawJson: content };
          } catch {
            return { success: false, rawJson: content || '', error: 'Model did not call tool and content is not valid JSON' };
          }
        }
        return { success: false, rawJson: '', error: 'Model did not call the expected tool' };
      }

      const args = toolCall.function.arguments;

      // Stream for observability
      this.options.publisher.publishOutputFast({
        type: 'stdout',
        requestId: opts.requestId,
        data: args,
      });

      try {
        JSON.parse(args);
        return { success: true, rawJson: args };
      } catch (parseErr) {
        return { success: false, rawJson: args, error: `Tool call JSON parse failed: ${parseErr}` };
      }
    } catch (err) {
      clearTimeout(timeoutId);
      const error = err instanceof Error ? err.message : String(err);
      return { success: false, rawJson: '', error };
    }
  }

  async runStep(requestId: string, systemPrompt: string, userPrompt: string, attachments?: AttachmentMeta[]): Promise<StepResult> {
    // Update mutable ref — all tool closures and the subscription read this
    this.requestIdRef.current = requestId;
    this.stepCompleted = false;
    this.stepResult = { success: false };
    this.rawOutput = '';
    this.turnCount = 0;
    this.toolCallStartTimes.clear();
    this.retrievalTracker.clear();

    try {
      const model = this.getModel();

      // Get tools (static tools are cached; MCP tools refresh only when dirty)
      const tools = await this.getTools();

      // Reuse the persistent Agent across turns so conversation history
      // (including tool calls and results) accumulates naturally.
      // Create a new Agent only on the very first turn or if systemPrompt changes.
      if (!this.persistentAgent || this.persistentSystemPrompt !== systemPrompt) {
        console.log(`[AgentRunner] Creating persistent agent (model: ${model.id})`);

        const isCustomProvider = (model.api as string) === CUSTOM_PROVIDER_API;
        const customApiKey = isCustomProvider
          ? (() => {
              const slug = (model.provider as string).slice('custom-'.length).toUpperCase().replace(/-/g, '_');
              return process.env[`CUSTOM_${slug}_API_KEY`] || 'no-key';
            })()
          : undefined;

        // Tear down old subscription if system prompt changed mid-session
        if (this.unsubscribeAgent) {
          this.unsubscribeAgent();
          this.unsubscribeAgent = null;
        }

        const thinkingLevel = this.options.thinkingLevel;
        this.persistentAgent = new Agent({
          initialState: {
            systemPrompt,
            model,
            tools,
            messages: [],
            ...(thinkingLevel && thinkingLevel !== 'off' ? { thinkingLevel: thinkingLevel as any } : {}),
          },
          ...(isCustomProvider ? {
            getApiKey: async () => customApiKey,
          } : {}),
        });
        this.persistentSystemPrompt = systemPrompt;
      } else {
        // Only push new/changed tools to the agent (MCP tools may have refreshed)
        this.persistentAgent.setTools(tools);
      }

      const agent = this.persistentAgent;

      // Track current agent for abort support
      this.currentAgent = agent;

      // Set up persistent subscription (no-ops if already subscribed)
      this.setupSubscription(agent);

      console.log(`[AgentRunner] Running step ${requestId}. Model: ${model.id}, Tools: ${tools.length}`);

      // Set up timeout — onboarding sessions do deep repo exploration, need more time
      const timeoutMs = process.env.ONBOARDING_SESSION_ID ? 600_000 : 180_000;
      const timeoutId = setTimeout(() => {
        console.warn(`[AgentRunner] Timeout reached, aborting`);
        agent.abort();
      }, timeoutMs);

      try {
        // Run the agent — with multimodal content if attachments are present
        if (attachments && attachments.length > 0) {
          const apiBaseUrl = process.env.DJINNBOT_API_URL || 'http://api:8000';
          console.log(`[AgentRunner] Building content blocks for ${attachments.length} attachment(s)`);
          const attachmentBlocks = await buildAttachmentBlocks(attachments, apiBaseUrl);

          // Separate images from text blocks
          const imageBlocks = attachmentBlocks.filter((b): b is ImageContent => b.type === 'image');
          const textBlocks = attachmentBlocks.filter((b): b is TextContent => b.type === 'text');

          if (imageBlocks.length > 0 && textBlocks.length === 0) {
            // Images only — use the convenience overload
            await agent.prompt(userPrompt, imageBlocks);
          } else {
            // Mixed content or text-only — build a full UserMessage
            const contentParts: (TextContent | ImageContent)[] = [
              // Images first (Anthropic recommends images before text)
              ...imageBlocks,
              // Then document text blocks
              ...textBlocks,
              // User's message text last
              { type: 'text', text: userPrompt },
            ];
            await agent.prompt({
              role: 'user' as const,
              content: contentParts,
              timestamp: Date.now(),
            });
          }
        } else {
          await agent.prompt(userPrompt);
        }
        await agent.waitForIdle();
        clearTimeout(timeoutId);
      } catch (err) {
        clearTimeout(timeoutId);
        throw err;
      } finally {
        // Clear current agent reference (subscription stays for next turn)
        this.currentAgent = null;
      }

      // Check results
      if (this.stepCompleted) {
        // Flush memory retrieval tracking (fire-and-forget)
        this.retrievalTracker.flush(this.stepResult.success).catch(() => {});
        return this.stepResult;
      }

      // Agent didn't call complete/fail — return raw output
      // Flush memory retrieval tracking (fire-and-forget)
      this.retrievalTracker.flush(true).catch(() => {});
      return {
        output: this.rawOutput,
        success: true,
      };
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      console.error(`[AgentRunner] Step failed:`, error);

      // Flush memory retrieval tracking with failure outcome (fire-and-forget)
      this.retrievalTracker.flush(false).catch(() => {});
      return {
        output: this.rawOutput,
        error,
        success: false,
      };
    }
  }
}
