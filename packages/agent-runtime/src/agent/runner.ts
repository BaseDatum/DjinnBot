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
  private unsubscribeAgent: (() => void) | null = null;

  // ── Per-step mutable state read by the persistent subscription ──────────
  private rawOutput = '';
  private turnCount = 0;
  private toolCallStartTimes = new Map<string, number>();

  constructor(private options: ContainerAgentRunnerOptions) {
    ensureInitialized();
    ensureCustomProviderRegistered();
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
      requestIdRef: this.requestIdRef,
      agentId: this.options.agentId,
      vaultPath: this.options.vaultPath,
      sharedPath: this.options.sharedPath,
      agentsDir: this.options.agentsDir || process.env.AGENTS_DIR,
      apiBaseUrl,
      pulseColumns,
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
   * Refresh MCP tools only when the cache is dirty (grant changed).
   * Returns the full tools array (static + MCP).
   */
  private async getTools(): Promise<AgentTool[]> {
    if (!this.tools) {
      this.tools = this.buildTools();
    }

    if (this.mcpToolsDirty) {
      const apiBaseUrl = process.env.DJINNBOT_API_URL || 'http://api:8000';
      this.mcpTools = await createMcpTools(
        this.options.agentId,
        apiBaseUrl,
        process.env.MCPO_API_KEY || '',
      );
      this.mcpToolsDirty = false;
      console.log(`[AgentRunner] MCP tools refreshed: ${this.mcpTools.length} tool(s)`);
    }

    return [...this.tools, ...this.mcpTools];
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
        }
      }
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

  async runStep(requestId: string, systemPrompt: string, userPrompt: string, attachments?: AttachmentMeta[]): Promise<StepResult> {
    // Update mutable ref — all tool closures and the subscription read this
    this.requestIdRef.current = requestId;
    this.stepCompleted = false;
    this.stepResult = { success: false };
    this.rawOutput = '';
    this.turnCount = 0;
    this.toolCallStartTimes.clear();

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
        return this.stepResult;
      }

      // Agent didn't call complete/fail — return raw output
      return {
        output: this.rawOutput,
        success: true,
      };
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      console.error(`[AgentRunner] Step failed:`, error);

      return {
        output: this.rawOutput,
        error,
        success: false,
      };
    }
  }
}
