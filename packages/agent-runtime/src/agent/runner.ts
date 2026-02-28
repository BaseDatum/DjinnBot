import { Agent } from '@mariozechner/pi-agent-core';
import { registerBuiltInApiProviders, registerApiProvider, streamOpenAICompletions } from '@mariozechner/pi-ai';
import type { AssistantMessage, ImageContent, TextContent } from '@mariozechner/pi-ai';
import type { AgentEvent, AgentTool, AgentMessage } from '@mariozechner/pi-agent-core';
import type { RedisPublisher } from '../redis/publisher.js';
import { createDjinnBotTools } from './djinnbot-tools.js';
import { createContainerTools } from './tools.js';
import { createMcpTools } from './mcp-tools.js';
import { createCamofoxTools } from '../tools/camofox.js';
import { parseModelString, CUSTOM_PROVIDER_API } from '@djinnbot/core';
import type { ResolvedModel } from '@djinnbot/core';
import { buildAttachmentBlocks, type AttachmentMeta } from './attachments.js';
import { authFetch } from '../api/auth-fetch.js';
import { MemoryRetrievalTracker } from './djinnbot-tools/memory-scoring.js';
import { computeOpenRouterCost } from './openrouter-pricing.js';
import { initPtc, type PtcInstance } from './ptc/index.js';
import { ShadowMessageLog } from './shadow-message-log.js';
import { getModelContextWindow } from './model-context-windows.js';
import { pruneToolOutputs } from './session-pruner.js';
import { compactSession, type CompactionResult } from './session-compactor.js';

// ── PTC system prompt supplement ──────────────────────────────────────────
// Appended to the agent's system prompt when Programmatic Tool Calling is enabled.
// Tells the model about exec_code and when to prefer it over direct tool calls.

const CAMOFOX_SYSTEM_PROMPT_SUPPLEMENT = `

## Web Browsing (Camofox)

You have a built-in anti-detection web browser (Camofox) for browsing the real web.
Use the camofox_* tools for any web browsing — researching, reading documentation,
checking websites, filling forms, authenticated browsing, etc.

**Playwright/Chromium is for automated testing only.** For all other browsing, use Camofox —
it bypasses bot detection on Google, Cloudflare, Amazon, LinkedIn, and most sites.

**Workflow:** camofox_create_tab → camofox_snapshot (read page with element refs) → camofox_click/camofox_type (interact)

**Search macros:** Use camofox_navigate with macro param — @google_search, @youtube_search,
@amazon_search, @reddit_search, @wikipedia_search, @twitter_search, @linkedin_search, and more.

**Authenticated browsing:** If cookie files are available in /home/agent/cookies/, use
camofox_import_cookies to load them before browsing authenticated sites.
`;

const PTC_SYSTEM_PROMPT_SUPPLEMENT = `

## Programmatic Tool Calling (exec_code)

You have access to an \`exec_code\` tool that runs Python code with tool functions.
Use \`exec_code\` whenever you need to:
- Read or edit multiple files (loop instead of N separate calls)
- Search and filter results (recall/research then process in code)
- Perform any workflow with 3+ tool calls where intermediate data can be filtered
- Set up credentials then use them (get_secret → use token in subsequent calls)
- Create multiple tasks, subtasks, or dependencies in a batch

**How it works:** Tool functions are plain synchronous Python functions (no async/await).
Call them directly: \`result = read(path="src/main.ts")\`.
Tool results go to your code, NOT your context window. Only \`print()\` output enters
your context. This dramatically reduces context usage.

**Important rules:**
- All tool functions are **synchronous** — call them directly, no \`await\`, no \`asyncio\`.
- \`print()\` is the ONLY way to return data to your context. Slice large output: \`print(result[:500])\`
- Always use try/except: \`except Exception as e: print(f"Error: {e}")\`
- Some params are renamed to avoid Python reserved words: \`type\` → \`type_\`, \`class\` → \`class_\`, \`from\` → \`from_\`
- Bash results: check for errors by inspecting the returned string.
- Workspace is \`/home/agent/run-workspace\` (also available as \`/home/agent/project-workspace\` for project repos). Files persist across exec_code calls within a session.

**When NOT to use exec_code:** For lifecycle tools (\`complete\`, \`fail\`, \`onboarding_handoff\`) —
call these directly as normal tool calls. They control the agent loop and must not be called from code.

**Full development environment:** Your container has a complete Linux toolbox. You can install
any packages you need and run any development tools:
- **Python packages:** \`uv pip install pytest\` or \`pip install <anything>\` (uv is pre-installed and fast)
- **Running tests:** \`uv run pytest\`, \`npm test\`, \`go test ./...\`, etc.
- **Node.js/Go/Rust:** Full toolchains are available (node 22, go 1.23, cargo)
- **System tools:** git, gh, ripgrep, fd, jq, curl, sqlite3, psql, redis-cli, imagemagick, etc.

Use \`bash\` tool (or \`bash()\` in exec_code) to install packages and run test suites.
For Python projects, prefer \`uv\` over raw pip — it's much faster for installs and venv creation.

**Example — installing deps and running tests:**
\`\`\`python
# Install project deps and run tests
result = bash(command="cd /home/agent/run-workspace && uv pip install -e '.[test]' && uv run pytest -x --tb=short 2>&1")
print(result[-3000:])  # print last 3000 chars of output
\`\`\`

**Example — reading and filtering files:**
\`\`\`python
# Read multiple files, only print relevant ones
try:
    files = ["src/main.ts", "src/config.ts", "src/utils.ts"]
    for f in files:
        content = read(path=f)
        if "TODO" in content:
            print(f"## {f}")
            print(content[:500])
except Exception as e:
    print(f"Error: {e}")
\`\`\`
`;

export interface StepResult {
  output?: string;
  error?: string;
  success: boolean;
  /** True when the agent explicitly called complete() or fail(). False when
   *  the model simply stopped producing output (chat-style). The engine uses
   *  this to decide whether auto-continuation is appropriate. */
  explicitCompletion?: boolean;
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
  /** DjinnBot API base URL — used for shared vault operations. */
  apiBaseUrl: string;
  model?: string;
  runId?: string;
  /** Path to agents directory — used by skill tools. Defaults to AGENTS_DIR env var. */
  agentsDir?: string;
  /** Extended thinking level. When set (and not 'off'), the Agent requests reasoning tokens. */
  thinkingLevel?: string;
  /** Enable Programmatic Tool Calling (PTC). When true, most tools are callable
   *  only via the exec_code tool, reducing context usage by 30-40%+. */
  ptcEnabled?: boolean;
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

  // ── Programmatic Tool Calling (PTC) ────────────────────────────────────
  private ptcInstance: PtcInstance | null = null;

  // ── Per-step mutable state read by the persistent subscription ──────────
  private rawOutput = '';
  private turnCount = 0;
  private toolCallStartTimes = new Map<string, number>();

  // ── Autonomous continuation (chat sessions) ────────────────────────────
  /** Number of tool calls the model made in the current pi-agent-core run. */
  private runToolCallCount = 0;
  /** Number of auto-continuations we've issued via followUp() in this step. */
  private autoContinuations = 0;
  /** Max follow-up continuations per runStep (safety cap).
   *  Overridden at runtime by MAX_AUTO_CONTINUATIONS env var (set by admin panel). */
  private maxAutoContinuations = parseInt(process.env.MAX_AUTO_CONTINUATIONS || '50', 10);
  /** True when this is a plain chat session (no pipeline, pulse, or onboarding).
   *  Chat sessions have no explicit complete/fail tools, so the model's text
   *  response IS the step completion.  Set once in buildTools(). */
  private isChatSession = false;

  // ── Inactivity timeout ─────────────────────────────────────────────────
  /** Timestamp of last meaningful activity (tool execution, turn start, etc.).
   *  Reset by the subscription handler on every sign of progress. */
  private lastActivityAt = Date.now();
  /** Handle for the repeating inactivity check interval. */
  private inactivityIntervalId: ReturnType<typeof setInterval> | null = null;

  // ── LLM call logging ──────────────────────────────────────────────────
  private turnStartTime = 0;
  private turnToolCallCount = 0;
  private turnHasThinking = false;

  // ── Memory retrieval tracking ──────────────────────────────────────────
  /** Tracks which memories were recalled during this step for adaptive scoring. */
  readonly retrievalTracker: MemoryRetrievalTracker;

  // ── Context management ────────────────────────────────────────────────
  /** Shadow copy of Agent's message history for pruning/compaction. */
  private shadowLog = new ShadowMessageLog();
  /** Last known context token usage (from most recent LLM response usage.input). */
  private lastContextTokens = 0;
  /** Context window size for the current model (in tokens). */
  private contextWindowTokens = 0;
  /** Auto-compaction threshold (fraction of context window). */
  private autoCompactThreshold = 0.85;
  /** Whether auto-compaction is enabled. */
  private autoCompactEnabled = true;
  /** Lock to prevent concurrent compaction. */
  private compacting = false;

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
    // PTC cleanup
    if (this.ptcInstance) {
      this.ptcInstance.close().catch(err => console.warn('[AgentRunner] PTC cleanup error:', err));
      this.ptcInstance = null;
    }
    // Reset context management
    this.shadowLog = new ShadowMessageLog();
    this.lastContextTokens = 0;
    this.contextWindowTokens = 0;
    console.log(`[AgentRunner] Session reset — conversation history cleared`);
  }

  /**
   * Hot-swap the model for this runner.
   *
   * Uses pi-agent-core's `agent.setModel()` which preserves full conversation
   * context (all messages, tool calls, and results) seamlessly — no Agent
   * recreation needed.  The new model takes effect on the very next turn.
   *
   * Called from the entrypoint when:
   *  - A `changeModel` command arrives between turns (from /model slash command)
   *  - An `agentStep` command carries a `model` override field
   */
  setModel(modelString: string): void {
    // Skip redundant swap when the model string hasn't changed (e.g. onChangeModel
    // already applied the same model that onAgentStep carries as an override).
    if (this.options.model === modelString) {
      console.log(`[AgentRunner] Model already set to ${modelString}, skipping swap`);
      return;
    }

    const previousModel = this.options.model;
    this.options.model = modelString;
    // Invalidate the cached resolved model so getModel() re-resolves on next turn
    this.resolvedModel = null;

    // If the persistent agent is already running, hot-swap immediately via
    // pi-agent-core's setModel() — this preserves the full conversation
    // history without recreating the Agent.
    if (this.persistentAgent) {
      try {
        const newModel = this.getModel();
        this.persistentAgent.setModel(newModel);
        console.log(`[AgentRunner] Model hot-swapped: ${previousModel} → ${modelString} (resolved: ${newModel.id})`);
      } catch (err) {
        console.error(`[AgentRunner] Failed to resolve new model "${modelString}", reverting:`, err);
        // Revert on failure so the agent doesn't break
        this.options.model = previousModel;
        this.resolvedModel = null;
      }
    } else {
      console.log(`[AgentRunner] Model set to ${modelString} (will take effect on next turn)`);
    }
  }

  /**
   * Get the current model string (for reporting in slash commands etc.).
   */
  getModelString(): string {
    return this.options.model || 'anthropic/claude-sonnet-4';
  }

  // ── Context usage ────────────────────────────────────────────────────────

  /**
   * Get current context usage for this session.
   * Returns tokens used, context window size, and percentage.
   */
  getContextUsage(): { usedTokens: number; contextWindow: number; percent: number; model: string } {
    // Ensure context window is resolved
    if (this.contextWindowTokens === 0) {
      const modelStr = this.options.model || 'anthropic/claude-sonnet-4';
      this.contextWindowTokens = getModelContextWindow(modelStr);
    }

    const used = this.lastContextTokens || this.shadowLog.estimateTokens();
    const limit = this.contextWindowTokens;
    const percent = limit > 0 ? Math.round((used / limit) * 100) : 0;

    return {
      usedTokens: used,
      contextWindow: limit,
      percent,
      model: this.getModelString(),
    };
  }

  /**
   * Perform session compaction (LLM-driven summarization).
   *
   * Rebuilds the Agent with a compaction summary + tail messages.
   * Can be triggered manually (/compact) or automatically when
   * the context window is nearly full.
   */
  async compactSessionContext(instructions?: string): Promise<CompactionResult> {
    if (this.compacting) {
      return {
        success: false,
        summary: '',
        tokensBefore: 0,
        tokensAfter: 0,
        tailMessageCount: 0,
        error: 'Compaction already in progress',
      };
    }

    this.compacting = true;
    try {
      const result = await compactSession(
        this.shadowLog,
        {
          publisher: this.options.publisher,
          summarize: async (systemPrompt: string, userPrompt: string) => {
            return this.runCompactionLlmCall(systemPrompt, userPrompt);
          },
        },
        instructions,
      );

      if (result.success) {
        // Rebuild the Agent with compacted messages
        await this.rebuildAgentFromShadow();

        // Update context tracking
        this.lastContextTokens = this.shadowLog.estimateTokens();
        this.contextWindowTokens = getModelContextWindow(this.getModelString());
      }

      return result;
    } finally {
      this.compacting = false;
    }
  }

  /**
   * Make an LLM call for compaction summarization.
   * Uses the same model resolution as the main agent.
   */
  private async runCompactionLlmCall(systemPrompt: string, userPrompt: string): Promise<string> {
    const { baseUrl, modelId, apiKey } = this.resolveModelForStructuredOutput(
      this.getModelString()
    );

    const response = await fetch(`${baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`,
        ...(baseUrl.includes('openrouter') ? {
          'HTTP-Referer': 'https://djinnbot.dev',
          'X-Title': 'DjinnBot Compaction',
        } : {}),
      },
      body: JSON.stringify({
        model: modelId,
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userPrompt },
        ],
        max_tokens: 8192,
        temperature: 0.3,
      }),
      signal: AbortSignal.timeout(120_000),
    });

    if (!response.ok) {
      const errorBody = await response.text();
      throw new Error(`Compaction LLM call failed: ${response.status} ${errorBody}`);
    }

    const data = await response.json() as any;
    return data.choices?.[0]?.message?.content || '';
  }

  /**
   * Rebuild the persistent Agent from the shadow message log.
   * Used after compaction or pruning modifies the shadow.
   */
  private async rebuildAgentFromShadow(): Promise<void> {
    console.log(`[AgentRunner] Rebuilding Agent from shadow log (${this.shadowLog.length} messages)`);

    // Tear down old agent + subscription
    if (this.unsubscribeAgent) {
      this.unsubscribeAgent();
      this.unsubscribeAgent = null;
    }
    this.persistentAgent = null;

    // Rebuild by seeding history from the shadow log
    const history = this.shadowLog.toHistoryArray();
    if (history.length > 0 && this.persistentSystemPrompt) {
      this.seedHistory(
        this.persistentSystemPrompt,
        history.map(m => ({ role: m.role, content: m.content })),
      );
    }

    console.log(`[AgentRunner] Agent rebuilt with ${history.length} messages from shadow`);
  }

  /**
   * Check if auto-compaction should trigger and perform it if needed.
   * Called after each turn completes.
   */
  private async checkAutoCompaction(): Promise<void> {
    if (!this.autoCompactEnabled || this.compacting) return;

    const usage = this.getContextUsage();
    if (usage.percent < this.autoCompactThreshold * 100) return;

    console.log(
      `[AgentRunner] Context at ${usage.percent}% (${usage.usedTokens}/${usage.contextWindow}), ` +
      `threshold ${this.autoCompactThreshold * 100}% — attempting auto-prune first`
    );

    // Try pruning first
    const pruneResult = pruneToolOutputs(this.shadowLog.getMutableMessages());
    if (pruneResult.pruned) {
      // Re-check after pruning
      const postPruneEstimate = this.shadowLog.estimateTokens();
      const postPrunePercent = usage.contextWindow > 0
        ? Math.round((postPruneEstimate / usage.contextWindow) * 100)
        : 0;

      if (postPrunePercent < this.autoCompactThreshold * 100) {
        console.log(`[AgentRunner] Pruning sufficient: ${usage.percent}% -> ${postPrunePercent}%`);
        // Rebuild agent with pruned messages
        await this.rebuildAgentFromShadow();
        this.lastContextTokens = postPruneEstimate;
        return;
      }
    }

    // Pruning wasn't enough — full compaction
    console.log(`[AgentRunner] Pruning insufficient, triggering auto-compaction`);
    const result = await this.compactSessionContext();

    if (result.success) {
      // Publish notification so bridges can inform the user
      this.options.publisher.publishEvent({
        type: 'compactionComplete',
        requestId: this.requestIdRef.current || 'auto',
        summary: result.summary,
        tokensBefore: result.tokensBefore,
        tokensAfter: result.tokensAfter,
        tailMessageCount: result.tailMessageCount,
        compactionNumber: this.shadowLog.compactionCount,
      } as any).catch(err => console.error('[AgentRunner] Failed to publish compaction event:', err));
    }
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

    const isChatSession = !isPipelineRun && !isPulseSession && !isOnboardingSession;
    this.isChatSession = isChatSession;

    console.log(
      `[AgentRunner] Session context: isPipelineRun=${isPipelineRun}, isPulseSession=${isPulseSession}, isOnboardingSession=${isOnboardingSession}, isChatSession=${isChatSession}`,
    );

    const tools: AgentTool[] = [];

    // Container tools (read, write, edit, bash with Redis streaming)
    const containerTools = createContainerTools({
      workspacePath: this.options.workspacePath,
      publisher: this.options.publisher,
      requestIdRef: this.requestIdRef,
    });
    tools.push(...containerTools);

    // Camofox browser tools (anti-detection web browsing)
    // Only available when CAMOFOX_URL is set (i.e., camofox server is running in the container)
    if (process.env.CAMOFOX_URL) {
      const camofoxTools = createCamofoxTools({ agentId: this.options.agentId });
      tools.push(...camofoxTools);
    }

    // DjinnBot tools (complete, fail, recall, remember, project/task tools, skills, etc.)
    const djinnBotTools = createDjinnBotTools({
      publisher: this.options.publisher,
      redis: this.options.redis,
      requestIdRef: this.requestIdRef,
      agentId: this.options.agentId,
      sessionId: this.options.runId || process.env.RUN_ID || 'unknown',
      vaultPath: this.options.vaultPath,
      apiBaseUrl: this.options.apiBaseUrl,
      agentsDir: this.options.agentsDir || process.env.AGENTS_DIR,
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
   *
   * When PTC is enabled, this returns only direct tools + exec_code.
   * PTC-eligible tools are callable only via exec_code (their schemas are
   * not sent to the LLM, reducing context usage by 30-40%+).
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

    const allTools = [...activeTools, ...this.mcpTools];

    // ── PTC path: split tools into direct + exec_code ─────────────────────
    if (this.options.ptcEnabled) {
      if (!this.ptcInstance) {
        // First time: initialize PTC (starts IPC server, generates exec_code tool)
        this.ptcInstance = await initPtc({
          tools: allTools,
          publisher: this.options.publisher,
          requestIdRef: this.requestIdRef,
        });
        return this.ptcInstance.agentTools;
      }

      // Subsequent turns: refresh PTC with current tools (handles MCP changes)
      return this.ptcInstance.refresh(allTools);
    }

    // ── Non-PTC path: return all tools with full schemas ──────────────────
    return allTools;
  }

  // ── Persistent event subscription ───────────────────────────────────────
  // Registered once on the Agent and reads mutable instance state
  // (requestIdRef, rawOutput, turnCount, etc.) so it doesn't need to be
  // re-created each turn.

  private setupSubscription(agent: Agent): void {
    if (this.unsubscribeAgent) return; // Already subscribed

    const maxTurns = 999;

    this.unsubscribeAgent = agent.subscribe(async (event: AgentEvent) => {
      // Reset inactivity timer on any sign of progress
      if (event.type === 'turn_start' || event.type === 'turn_end' ||
          event.type === 'tool_execution_start' || event.type === 'tool_execution_end' ||
          event.type === 'message_start' || event.type === 'message_update') {
        this.lastActivityAt = Date.now();
      }

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

        // ── Autonomous continuation ──────────────────────────────────
        //
        // pi-agent-core's inner loop (agent-loop.js) already continues
        // while the model produces tool calls (hasMoreToolCalls = true).
        // The followUp mechanism is consumed AFTER the inner loop exits
        // — i.e., when the model produces a text-only turn with no tool
        // calls.  Queuing followUp on every tool-call turn is therefore
        // redundant and harmful: the messages accumulate in a FIFO queue
        // and fire one-at-a-time after the model's natural text response,
        // causing N unnecessary LLM round-trips (where N = number of
        // previous tool-call turns).
        //
        // Correct strategy:
        //  • Tool-call turn → do nothing (inner loop handles continuation)
        //  • Text-only turn in a chat session → do nothing (text IS the
        //    completion; chat sessions have no complete/fail tools)
        //  • Text-only turn in a pipeline/pulse/onboarding run → queue
        //    ONE followUp, because the model should have called
        //    complete()/fail() and may have stopped prematurely.
        //
        // Every ~50 tool calls we ask for a progress update so the user
        // isn't left staring at a spinner with no feedback.
        if (
          !this.stepCompleted &&
          this.turnToolCallCount === 0 &&
          this.runToolCallCount > 0 &&
          !this.isChatSession &&
          this.autoContinuations < this.maxAutoContinuations
        ) {
          // Model produced text but didn't call complete/fail in a
          // pipeline/pulse/onboarding run.  Nudge it to keep working.
          this.autoContinuations++;

          const prompt = 'Continue — you produced a response but didn\'t call complete() or fail(). ' +
            'Keep working. If you are done, call complete() with your results.';

          console.log(
            `[AgentRunner] Auto-continuation ${this.autoContinuations}/${this.maxAutoContinuations}: ` +
            `text-only turn after ${this.runToolCallCount} tool call(s), ` +
            `agent didn't call complete/fail — queuing followUp`
          );
          agent.followUp({
            role: 'user' as const,
            content: prompt,
            timestamp: Date.now(),
          });
        } else if (
          !this.stepCompleted &&
          this.turnToolCallCount > 0 &&
          this.runToolCallCount > 0 &&
          this.runToolCallCount % 50 === 0
        ) {
          // Progress update checkpoint — fires every 50 tool calls
          // regardless of session type, so the user gets feedback.
          agent.followUp({
            role: 'user' as const,
            content: 'You\'ve made a lot of tool calls. Give the user a brief progress update — ' +
              'a sentence or two on what you\'ve done so far and what\'s next — then continue working.',
            timestamp: Date.now(),
          });
          console.log(
            `[AgentRunner] Progress update requested at ${this.runToolCallCount} tool calls`
          );
        }
      }
      if (event.type === 'tool_execution_start') {
        const toolName = (event as any).toolName ?? 'unknown';
        const toolCallId = (event as any).toolCallId ?? `tool_${Date.now()}`;
        const args = (event as any).args ?? {};
        console.log(`[AgentRunner] tool_execution_start: ${toolName}`);
        this.turnToolCallCount++;
        this.runToolCallCount++;

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

        // Track tool result in shadow log
        const resultStr = typeof result === 'string' ? result : JSON.stringify(result);
        this.shadowLog.push({
          role: 'tool_result',
          content: resultStr,
          toolName,
          toolCallId,
          timestamp: Date.now(),
        });

        this.options.publisher.publishEvent({
          type: 'toolEnd',
          requestId: this.requestIdRef.current,
          toolName,
          result: resultStr,
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

          // Track assistant message in shadow log
          if (extracted) {
            this.shadowLog.push({
              role: 'assistant',
              content: extracted,
              timestamp: Date.now(),
            });
          }

          // Track token usage from the LLM response — usage.input is the
          // total tokens the model received (full context window usage).
          const usage = (message as any).usage;
          if (usage) {
            const inputTokens = (usage.input || 0) + (usage.cacheRead || 0);
            if (inputTokens > 0) {
              this.lastContextTokens = inputTokens;
            }
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
   *
   * For OpenRouter calls where pi-ai's calculateCost returned 0 (model not
   * in registry or registry has zero rates), we attempt to compute cost from
   * OpenRouter's live pricing API and flag the result as approximate.
   */
  private logLlmCall(message: AssistantMessage): void {
    const apiBaseUrl = process.env.DJINNBOT_API_URL || 'http://api:8000';
    const model = this.getModel() as ResolvedModel;
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

    // If model was inferred with sibling cost rates, flag as approximate
    const isApproximateFromModel = !!(model as any).costApproximate;

    // Snapshot context usage — runs after lastContextTokens is updated from
    // the LLM response so the numbers reflect this turn's actual usage.
    const ctx = this.getContextUsage();

    const sendPayload = (
      finalCost: { input: number; output: number; total: number },
      costApproximate: boolean,
    ) => {
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
        cost_input: finalCost.input || undefined,
        cost_output: finalCost.output || undefined,
        cost_total: finalCost.total || undefined,
        cost_approximate: costApproximate || undefined,
        duration_ms: durationMs,
        tool_call_count: this.turnToolCallCount,
        has_thinking: this.turnHasThinking,
        stop_reason: message.stopReason ? String(message.stopReason) : undefined,
        // Context window usage snapshot (tokens used / limit / %)
        context_used_tokens: ctx.usedTokens || undefined,
        context_window_tokens: ctx.contextWindow || undefined,
        context_percent: ctx.percent ?? undefined,
      };

      authFetch(`${apiBaseUrl}/v1/internal/llm-calls`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      }).catch(err => {
        console.warn('[AgentRunner] Failed to log LLM call:', err);
      });
    };

    // If pi-ai already computed a non-zero cost, use it directly
    if (cost.total > 0) {
      sendPayload(cost, isApproximateFromModel);
      return;
    }

    // For OpenRouter calls with 0 cost: try fetching real pricing from
    // OpenRouter's API and compute cost from actual token counts.
    const providerStr = String(model.provider);
    if (providerStr === 'openrouter' && (usage.input > 0 || usage.output > 0)) {
      computeOpenRouterCost(model.id, usage.input || 0, usage.output || 0, usage.cacheRead || 0)
        .then(enrichedCost => {
          if (enrichedCost) {
            console.info(
              `[AgentRunner] Enriched OpenRouter cost for ${model.id}: $${enrichedCost.total.toFixed(6)} (from live pricing)`
            );
            sendPayload(enrichedCost, true); // always approximate from live API
          } else {
            sendPayload(cost, isApproximateFromModel);
          }
        })
        .catch(() => {
          sendPayload(cost, isApproximateFromModel);
        });
      return;
    }

    // All other providers: send what we have
    sendPayload(cost, isApproximateFromModel);
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

    // Apply the same system prompt supplements that runStep() applies.
    // Without this, the prompt comparison in runStep() would fail on the
    // first turn (effectiveSystemPrompt !== persistentSystemPrompt) and
    // recreate the agent with empty messages, wiping all seeded history.
    let effectiveSystemPrompt = systemPrompt;
    if (process.env.CAMOFOX_URL) {
      effectiveSystemPrompt += CAMOFOX_SYSTEM_PROMPT_SUPPLEMENT;
    }
    if (this.options.ptcEnabled) {
      effectiveSystemPrompt += PTC_SYSTEM_PROMPT_SUPPLEMENT;
    }

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
        systemPrompt: effectiveSystemPrompt,
        model,
        tools: [],   // Tools are injected via getTools() on first runStep
        messages,
        ...(thinkingLevel && thinkingLevel !== 'off' ? { thinkingLevel: thinkingLevel as any } : {}),
      },
      ...(isCustomProvider ? {
        getApiKey: async () => customApiKey,
      } : {}),
    });
    this.persistentSystemPrompt = effectiveSystemPrompt;

    // Populate shadow log from historical messages
    this.shadowLog.seedFromHistory(history);
    // Resolve context window for the model
    this.contextWindowTokens = getModelContextWindow(this.options.model || 'anthropic/claude-sonnet-4');

    console.log(`[AgentRunner] Seeded persistent agent with ${messages.length} historical messages (thinkingLevel: ${thinkingLevel || 'off'}), shadow log: ${this.shadowLog.length} messages`);
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
    maxOutputTokens?: number;
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
      maxOutputTokens?: number;
      timeout?: number;
    },
  ): Promise<{ success: boolean; rawJson: string; error?: string }> {
    const { baseUrl, modelId, apiKey } = this.resolveModelForStructuredOutput(modelString);
    const maxTokens = opts.maxOutputTokens ?? 32768;
    const timeoutMs = opts.timeout || 300_000;
    console.log(`[AgentRunner] Structured output POST ${baseUrl}/chat/completions model=${modelId} max_tokens=${maxTokens}`);

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
      max_tokens: maxTokens,
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
      const finishReason = result.choices?.[0]?.finish_reason;
      const content = result.choices?.[0]?.message?.content;

      console.log(`[AgentRunner] Structured output response: model=${result.model}, finish_reason=${finishReason}, content_length=${content?.length ?? 0}`);

      // Check finish_reason — 'length' means output was truncated due to max_tokens
      if (finishReason === 'length') {
        console.error(`[AgentRunner] TRUNCATED: finish_reason=length (max_tokens=${maxTokens}). Output was cut off.`);
        return { success: false, rawJson: content || '', error: `Output truncated (finish_reason=length). Increase maxOutputTokens (currently ${maxTokens}).` };
      }

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

      // Validate JSON and check for empty output
      try {
        const parsed = JSON.parse(content);
        // Check for trivially empty output (all array fields empty)
        const arrayFields: string[] = [];
        let allEmpty = true;
        let hasOther = false;
        for (const [k, v] of Object.entries(parsed)) {
          if (Array.isArray(v)) { arrayFields.push(k); if ((v as any[]).length > 0) allEmpty = false; }
          else if (v !== null && v !== undefined && v !== '') hasOther = true;
        }
        if (arrayFields.length > 0 && allEmpty && !hasOther) {
          const msg = `Empty structured output (${arrayFields.join(', ')} are all empty). Model may need higher maxOutputTokens (currently ${maxTokens}).`;
          console.error(`[AgentRunner] ${msg}`);
          return { success: false, rawJson: content, error: msg };
        }
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
      maxOutputTokens?: number;
      timeout?: number;
    },
  ): Promise<{ success: boolean; rawJson: string; error?: string }> {
    const { baseUrl, modelId, apiKey } = this.resolveModelForStructuredOutput(modelString);
    const toolName = `submit_${opts.outputSchema.name}`;
    const maxTokens = opts.maxOutputTokens ?? 32768;
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
      max_tokens: maxTokens,
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
    this.runToolCallCount = 0;
    this.autoContinuations = 0;
    this.toolCallStartTimes.clear();
    this.retrievalTracker.clear();

    // Track user message in shadow log
    this.shadowLog.push({
      role: 'user',
      content: userPrompt,
      timestamp: Date.now(),
    });

    // Ensure context window is resolved
    if (this.contextWindowTokens === 0) {
      this.contextWindowTokens = getModelContextWindow(this.options.model || 'anthropic/claude-sonnet-4');
    }

    try {
      const model = this.getModel();

      // Get tools (static tools are cached; MCP tools refresh only when dirty)
      const tools = await this.getTools();

      // Append guidance supplements to the system prompt
      let effectiveSystemPrompt = systemPrompt;
      // Camofox browsing guidance — when the anti-detection browser is available
      if (process.env.CAMOFOX_URL) {
        effectiveSystemPrompt += CAMOFOX_SYSTEM_PROMPT_SUPPLEMENT;
      }
      // PTC guidance — when exec_code is available for multi-step workflows
      if (this.options.ptcEnabled) {
        effectiveSystemPrompt += PTC_SYSTEM_PROMPT_SUPPLEMENT;
      }

      // Reuse the persistent Agent across turns so conversation history
      // (including tool calls and results) accumulates naturally.
      // Create a new Agent only on the very first turn or if systemPrompt changes.
      if (!this.persistentAgent || this.persistentSystemPrompt !== effectiveSystemPrompt) {
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
            systemPrompt: effectiveSystemPrompt,
            model,
            tools,
            messages: [],
            ...(thinkingLevel && thinkingLevel !== 'off' ? { thinkingLevel: thinkingLevel as any } : {}),
          },
          ...(isCustomProvider ? {
            getApiKey: async () => customApiKey,
          } : {}),
        });
        this.persistentSystemPrompt = effectiveSystemPrompt;
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

      // Set up inactivity timeout — fires only when the agent hasn't made
      // progress (tool calls, turns, streaming) within the window.  For
      // pipeline runs, STEP_TIMEOUT_MS acts as a hard wall-clock cap.
      //
      // Chat sessions use CHAT_INACTIVITY_TIMEOUT_MS / CHAT_HARD_TIMEOUT_MS
      // (configurable via admin panel). Pipeline runs use STEP_TIMEOUT_MS.
      // Onboarding sessions get longer defaults.
      const inactivityMs = process.env.CHAT_INACTIVITY_TIMEOUT_MS
        ? parseInt(process.env.CHAT_INACTIVITY_TIMEOUT_MS, 10)
        : process.env.STEP_TIMEOUT_MS
          ? parseInt(process.env.STEP_TIMEOUT_MS, 10)
          : process.env.ONBOARDING_SESSION_ID ? 600_000 : 180_000;
      // Hard wall-clock cap: absolute maximum regardless of activity.
      // Prevents runaway agents from consuming resources indefinitely.
      const hardCapMs = process.env.CHAT_HARD_TIMEOUT_MS
        ? parseInt(process.env.CHAT_HARD_TIMEOUT_MS, 10)
        : process.env.STEP_TIMEOUT_MS
          ? parseInt(process.env.STEP_TIMEOUT_MS, 10) * 3
          : process.env.ONBOARDING_SESSION_ID ? 1_800_000 : 900_000;

      this.lastActivityAt = Date.now();
      const stepStartTime = Date.now();

      // Check for inactivity every 10 seconds
      this.inactivityIntervalId = setInterval(() => {
        const now = Date.now();
        const idleFor = now - this.lastActivityAt;
        const elapsed = now - stepStartTime;

        if (elapsed >= hardCapMs) {
          console.warn(`[AgentRunner] Hard wall-clock cap reached (${Math.round(elapsed / 1000)}s), aborting`);
          agent.abort();
          return;
        }
        if (idleFor >= inactivityMs) {
          console.warn(`[AgentRunner] Inactivity timeout (${Math.round(idleFor / 1000)}s idle, threshold ${Math.round(inactivityMs / 1000)}s), aborting`);
          agent.abort();
        }
      }, 10_000);

      try {
        // Run the agent — with multimodal content if attachments are present
        if (attachments && attachments.length > 0) {
          const apiBaseUrl = process.env.DJINNBOT_API_URL || 'http://api:8000';
          console.log(`[AgentRunner] Building content blocks for ${attachments.length} attachment(s)`);
          const attachmentBlocks = await buildAttachmentBlocks(attachments, apiBaseUrl, model.id ? `${model.provider}/${model.id}` : undefined);

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
        if (this.inactivityIntervalId) { clearInterval(this.inactivityIntervalId); this.inactivityIntervalId = null; }
      } catch (err) {
        if (this.inactivityIntervalId) { clearInterval(this.inactivityIntervalId); this.inactivityIntervalId = null; }
        throw err;
      } finally {
        // Clear current agent reference (subscription stays for next turn)
        this.currentAgent = null;
      }

      // Check results
      if (this.stepCompleted) {
        // Flush memory retrieval tracking for analytics (no outcome — scoring is agent-driven)
        this.retrievalTracker.flush().catch(() => {});
        // Check if auto-compaction is needed (fire-and-forget)
        this.checkAutoCompaction().catch(err =>
          console.error('[AgentRunner] Auto-compaction check failed:', err)
        );
        if (this.autoContinuations > 0) {
          console.log(`[AgentRunner] Step completed after ${this.autoContinuations} auto-continuation(s), ${this.runToolCallCount} total tool call(s)`);
        }
        return { ...this.stepResult, explicitCompletion: true };
      }

      // Agent didn't call complete/fail — return raw output (chat-style)
      // Flush memory retrieval tracking for analytics (no outcome — scoring is agent-driven)
      this.retrievalTracker.flush().catch(() => {});
      // Check if auto-compaction is needed (fire-and-forget)
      this.checkAutoCompaction().catch(err =>
        console.error('[AgentRunner] Auto-compaction check failed:', err)
      );
      if (this.autoContinuations > 0) {
        console.log(`[AgentRunner] Step finished (no explicit completion) after ${this.autoContinuations} auto-continuation(s), ${this.runToolCallCount} total tool call(s)`);
      }
      return {
        output: this.rawOutput,
        success: true,
        explicitCompletion: false,
      };
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      console.error(`[AgentRunner] Step failed:`, error);

      // Flush memory retrieval tracking for analytics (no outcome — scoring is agent-driven)
      this.retrievalTracker.flush().catch(() => {});
      return {
        output: this.rawOutput,
        error,
        success: false,
      };
    }
  }
}
