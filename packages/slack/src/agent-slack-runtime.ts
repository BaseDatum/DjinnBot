/**
 * AgentSlackRuntime — One instance per agent persona.
 *
 * Each agent runs its own Socket Mode connection to Slack, receives its own
 * @mentions and thread replies, maintains context about its current work,
 * and uses an LLM to decide how to respond to incoming messages.
 *
 * This is NOT a routing layer. Each agent is an autonomous operator.
 */

import { App } from '@slack/bolt';
import type { WebClient } from '@slack/web-api';
import type {
  AgentRegistryEntry,
} from '@djinnbot/core';
import { parseModelString, toSlackCredentials } from '@djinnbot/core';
import { SlackStreamer } from './slack-streamer.js';
import type { SlackSessionPool } from './slack-session-pool.js';

export interface ActiveStep {
  runId: string;
  stepId: string;
  pipelineId: string;
  status: 'working' | 'waiting_review' | 'paused';
  threadTs: string;
  channelId: string;
  startedAt: number;
  taskSummary: string;
}

export interface HumanGuidance {
  from: string;
  fromName: string;
  message: string;
  channelId: string;
  threadTs?: string;
  timestamp: number;
  applied: boolean;
}

export interface SlackDecision {
  action: 'respond' | 'apply_guidance' | 'acknowledge' | 'ignore' | 'escalate';
  response?: string;
  reaction?: string;
  guidance?: string;
}

export interface SlackMessageData {
  agentId: string;
  agentName: string;
  agentEmoji: string;
  userId?: string;
  userName?: string;
  message: string;
  isAgent: boolean;
  threadTs: string;
  messageTs: string;
}

export interface AgentSlackRuntimeConfig {
  agent: AgentRegistryEntry;
  /** Called when agent needs to make an LLM decision about a Slack event */
  onDecisionNeeded: (
    agentId: string,
    systemPrompt: string,
    userPrompt: string,
    model: string,
  ) => Promise<string>;
  /** Called when human guidance should be injected into the pipeline */
  onHumanGuidance?: (
    agentId: string,
    runId: string,
    stepId: string,
    guidance: string,
  ) => Promise<void>;
  /** Called when a Slack message is sent or received in a run thread */
  onSlackMessage?: (runId: string, message: SlackMessageData) => Promise<void>;
  /**
   * Session pool for persistent DM/channel-thread containers.
   * When provided, all interactive conversations use pooled sessions
   * (one container per conversation, reused across messages until idle timeout).
   * When absent, falls back to onRunFullSession for backward compatibility.
   */
  sessionPool?: SlackSessionPool;
  /**
   * @deprecated Use sessionPool instead.
   * Called when a full agent session with tools should be spawned for complex interactions.
   * Still used as fallback when sessionPool is not configured.
   */
  onRunFullSession?: (opts: {
    agentId: string;
    systemPrompt: string;
    userPrompt: string;
    model: string;
    workspacePath?: string;
    vaultPath?: string;
    source?: 'slack_dm' | 'slack_channel' | 'api' | 'pulse';
    sourceId?: string;
  }) => Promise<{ output: string; success: boolean }>;
  /** Called to search agent's memories for context (pre-fetch for triage) */
  onMemorySearch?: (
    agentId: string,
    query: string,
    limit?: number
  ) => Promise<Array<{ title: string; snippet: string; category: string }>>;
  /** Called to load the full agent persona with environment context */
  onLoadPersona?: (
    agentId: string,
    sessionContext: { sessionType: 'slack' | 'pulse' | 'pipeline'; channelContext?: string; installedTools?: string[] }
  ) => Promise<{ systemPrompt: string; identity: string; soul: string; agents: string; decision: string }>;
  /** Check if a thread is a pipeline work thread (shared across all agents) */
  isPipelineThread?: (channelId: string, threadTs: string) => boolean;
  /** Default channel for run threads */
  defaultChannelId: string;
  /** Default model for Slack decisions when agent config is missing */
  defaultSlackDecisionModel?: string;
  /** Called when a user gives feedback (thumbs up/down) on an agent response */
  onFeedback?: (
    agentId: string,
    feedback: 'positive' | 'negative',
    responseText: string,
    userName: string,
  ) => Promise<void>;
}

export class AgentSlackRuntime {
  readonly agentId: string;
  private app: App;
  private client: WebClient;
  private config: AgentSlackRuntimeConfig;
  private agent: AgentRegistryEntry;
  private botUserId: string | undefined;
  /** Bot ID (B-prefixed) — chatStream messages use this instead of botUserId */
  private botId: string | undefined;
  /** Slack workspace team ID — required by chatStream for non-DM channels */
  private teamId: string | undefined;

  // Work context
  private activeSteps: ActiveStep[] = [];
  private humanGuidance: HumanGuidance[] = [];
  private running = false;
  /**
   * Active streamers for pipeline steps: key = `${runId}:${stepId}`
   * Managed by SlackBridge via startStepStream / getStepStreamer.
   */
  private stepStreamers = new Map<string, SlackStreamer>();

  constructor(config: AgentSlackRuntimeConfig) {
    this.config = config;
    this.agent = config.agent;
    this.agentId = config.agent.id;
    const slackCreds = config.agent.channels.slack;
    if (!slackCreds) {
      throw new Error(`Agent ${config.agent.id} has no Slack channel credentials`);
    }
    const slack = toSlackCredentials(slackCreds);
    this.botUserId = slack.botUserId;

    this.app = new App({
      token: slack.botToken,
      appToken: slack.appToken,
      socketMode: true,
      // Don't log every event
      logLevel: 'WARN' as any,
    });

    this.client = this.app.client;

    this.setupEventHandlers();
  }

  // ─── Persona Loading ───────────────────────────────────────────────────

  /**
   * Build the full system prompt for this agent.
   * Uses the persona loader callback if available, otherwise falls back to minimal prompt.
   */
  private async buildFullSystemPrompt(channelContext?: string): Promise<string> {
    if (this.config.onLoadPersona) {
      try {
        const persona = await this.config.onLoadPersona(this.agentId, {
          sessionType: 'slack',
          channelContext,
        });
        return persona.systemPrompt;
      } catch (err) {
        console.error(`[${this.agentId}] Failed to load persona, using fallback:`, err);
      }
    }

    // Fallback: build a minimal prompt from agent config
    const sections: string[] = [];
    
    sections.push(`# IDENTITY`);
    sections.push(`You are ${this.agent.identity.name} ${this.agent.identity.emoji}, ${this.agent.identity.role}.`);
    
    if (this.agent.soul) {
      sections.push('');
      sections.push(`# SOUL`);
      sections.push(this.agent.soul);
    }
    
    if (this.agent.decision) {
      sections.push('');
      sections.push(`# DECISION FRAMEWORK`);
      sections.push(this.agent.decision);
    }
    
    if (this.agent.agents) {
      sections.push('');
      sections.push(`# OTHER AGENTS`);
      sections.push(this.agent.agents);
    }

    // Add environment info
    sections.push('');
    sections.push(`# YOUR ENVIRONMENT`);
    sections.push('');
    sections.push(`## Paths`);
    sections.push(`- **Workspace**: \`/data/workspaces/${this.agentId}\` — Your persistent working directory`);
    sections.push(`- **Memory Vault**: \`/data/vaults/${this.agentId}\` — Use \`recall\` tool to search`);
    sections.push('');
    sections.push(`## Session Context`);
    sections.push(`- **Session Type**: Slack conversation`);
    if (channelContext) {
      sections.push(`- **Channel Context**: ${channelContext}`);
    }
    sections.push('');
    sections.push('You are responding in a Slack conversation. Keep responses concise and natural.');
    sections.push('You have full access to your workspace and tools to help with complex requests.');

    return sections.join('\n');
  }

  // ─── Lifecycle ─────────────────────────────────────────────────────────

  async start(): Promise<void> {
    if (this.running) return;

    // Resolve bot user ID and team ID if not set
      if (!this.botUserId || !this.teamId) {
        try {
          const authResult = await this.client.auth.test();
          this.botUserId = authResult.user_id as string;
          this.botId = authResult.bot_id as string | undefined;
          this.teamId = authResult.team_id as string;
          console.log(
            `[${this.agentId}] Bot user ID: ${this.botUserId}, bot ID: ${this.botId ?? 'n/a'}, team ID: ${this.teamId}`
          );
        } catch (err) {
          console.error(
            `[${this.agentId}] Failed to resolve bot user ID / team ID:`,
            err
          );
        }
      }

    await this.app.start();
    this.running = true;
    console.log(
      `[${this.agentId}] Socket Mode connected — ${this.agent.identity.name} ${this.agent.identity.emoji} is online`
    );
  }

  async stop(): Promise<void> {
    if (!this.running) return;
    await this.app.stop();
    this.running = false;
    console.log(`[${this.agentId}] Socket Mode disconnected`);
  }

  isRunning(): boolean {
    return this.running;
  }

  // ─── Work Context Management ───────────────────────────────────────────

  /** Register that this agent is now working on a step */
  addActiveStep(step: Omit<ActiveStep, 'startedAt'>): void {
    // Remove existing entry for same run+step if present
    this.activeSteps = this.activeSteps.filter(
      (s) => !(s.runId === step.runId && s.stepId === step.stepId)
    );
    this.activeSteps.push({ ...step, startedAt: Date.now() });
  }

  /** Mark a step as no longer active */
  removeActiveStep(runId: string, stepId: string): void {
    this.activeSteps = this.activeSteps.filter(
      (s) => !(s.runId === runId && s.stepId === stepId)
    );
  }

  /** Get current active steps */
  getActiveSteps(): ActiveStep[] {
    return [...this.activeSteps];
  }

  /** Get unread guidance for a specific run */
  getUnappliedGuidance(runId?: string): HumanGuidance[] {
    return this.humanGuidance.filter((g) => {
      if (g.applied) return false;
      if (runId) {
        // Match guidance to run by thread
        const step = this.activeSteps.find(
          (s) => s.runId === runId && s.threadTs === g.threadTs
        );
        return !!step;
      }
      return true;
    });
  }

  // ─── Slack Posting ─────────────────────────────────────────────────────

  /** Post a message as this agent to a thread */
  async postToThread(
    channelId: string,
    threadTs: string,
    text: string,
    blocks?: any[],
    runId?: string
  ): Promise<string | undefined> {
    try {
      console.log(`[${this.agentId}] Posting to thread ${threadTs} in ${channelId}${blocks ? ` (${blocks.length} blocks)` : ''}`);
      const result = await this.client.chat.postMessage({
        channel: channelId,
        thread_ts: threadTs,
        text,
        blocks,
      });
      if (!result.ok) {
        console.error(`[${this.agentId}] Slack API error:`, result.error);
        return undefined;
      }
      
      const messageTs = result.ts as string | undefined;
      
      // Emit SLACK_MESSAGE event if we have a runId and callback
      if (messageTs && runId && this.config.onSlackMessage) {
        await this.config.onSlackMessage(runId, {
          agentId: this.agentId,
          agentName: this.agent.identity.name,
          agentEmoji: this.agent.identity.emoji,
          message: text,
          isAgent: true,
          threadTs,
          messageTs,
        });
      }
      
      return messageTs;
    } catch (err) {
      console.error(
        `[${this.agentId}] Failed to post to thread:`,
        err
      );
      return undefined;
    }
  }

  /** Post a message to a channel (creates a new top-level message) */
  async postToChannel(
    channelId: string,
    text: string,
    blocks?: any[]
  ): Promise<string | undefined> {
    try {
      const result = await this.client.chat.postMessage({
        channel: channelId,
        text,
        blocks,
      });
      return result.ts as string | undefined;
    } catch (err) {
      console.error(
        `[${this.agentId}] Failed to post to channel:`,
        err
      );
      return undefined;
    }
  }

  /** React to a message */
  async react(
    channelId: string,
    messageTs: string,
    emoji: string
  ): Promise<void> {
    try {
      await this.client.reactions.add({
        channel: channelId,
        timestamp: messageTs,
        name: emoji.replace(/:/g, ''),
      });
    } catch (err: any) {
      if (!err?.data?.error?.includes('already_reacted')) {
        console.error(`[${this.agentId}] Failed to react:`, err);
      }
    }
  }

  /** Get the Slack WebClient for direct API calls */
  getClient(): WebClient {
    return this.client;
  }

  // ─── JSON Parsing Helper ─────────────────────────────────────────────────

  /**
   * Robustly parse JSON from LLM response, handling common issues like
   * unescaped quotes, markdown fences, and malformed responses.
   */
  private parseDecisionJson(response: string): any {
    // Step 1: Remove markdown fences
    let cleaned = response
      .replace(/```json\n?/g, '')
      .replace(/```\n?/g, '')
      .trim();

    // Step 2: Try direct parse first
    try {
      return JSON.parse(cleaned);
    } catch {
      // Continue with more aggressive cleaning
    }

    // Step 3: Try to extract JSON object from response
    const jsonMatch = cleaned.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
      cleaned = jsonMatch[0];
    }

    // Step 4: Fix common JSON issues
    // Replace smart quotes with regular quotes
    cleaned = cleaned
      .replace(/[\u201C\u201D]/g, '"')
      .replace(/[\u2018\u2019]/g, "'");

    // Step 5: Try parse again
    try {
      return JSON.parse(cleaned);
    } catch {
      // Continue with regex extraction
    }

    // Step 6: Extract fields manually using regex as last resort
    const shouldRespondMatch = cleaned.match(/"shouldRespond"\s*:\s*(true|false)/i);
    const actionMatch = cleaned.match(/"action"\s*:\s*"(respond|acknowledge|ignore)"/i);
    const responseMatch = cleaned.match(/"response"\s*:\s*"([^"]*)"/);
    const reactionMatch = cleaned.match(/"reaction"\s*:\s*"([^"]*)"/);
    const reasonMatch = cleaned.match(/"reason"\s*:\s*"([^"]*)"/);

    if (shouldRespondMatch || actionMatch) {
      return {
        shouldRespond: shouldRespondMatch ? shouldRespondMatch[1] === 'true' : false,
        action: actionMatch ? actionMatch[1] : 'ignore',
        response: responseMatch ? responseMatch[1] : undefined,
        reaction: reactionMatch ? reactionMatch[1] : undefined,
        reason: reasonMatch ? reasonMatch[1] : undefined,
      };
    }

    // Step 7: If we still can't parse, return a default ignore decision.
    // LLMs occasionally return empty or purely explanatory text instead of JSON.
    // This is expected — the caller's catch block defaults to ignore/acknowledge.
    throw new Error(`Could not parse decision JSON (${cleaned.length} chars): ${cleaned.slice(0, 200)}`);
  }

  // ─── Tool Heuristic ─────────────────────────────────────────────────────

  /** Determine if a message likely requires tool access */
  private shouldUseTools(text: string): boolean {
    const toolKeywords = [
      'check', 'look at', 'read', 'find', 'search', 'show me',
      'status', 'what files', 'run', 'build', 'test', 'install',
      'code', 'implement', 'fix', 'debug', 'analyze', 'review',
      'create', 'write', 'edit', 'update', 'deploy',
    ];
    const lower = text.toLowerCase();
    return toolKeywords.some(kw => lower.includes(kw));
  }

  /**
   * Resolve the model string to use for Slack conversation sessions.
   * Tries the agent's configured models in priority order, using parseModelString
   * to validate each one (same resolution logic the container's AgentRunner uses).
   * Falls back to defaultSlackDecisionModel if all agent models fail to resolve.
   */
  private resolveSlackModel(): string {
    const candidates = [
      this.agent.config?.model,
      this.agent.config?.thinkingModel,
      this.config.defaultSlackDecisionModel,
    ].filter(Boolean) as string[];

    for (const modelString of candidates) {
      try {
        parseModelString(modelString);
        return modelString;
      } catch {
        // Provider not configured or unresolvable — try next candidate
        console.debug(`[${this.agentId}] resolveSlackModel: skipping "${modelString}" (not configured)`);
      }
    }

    // Hard fallback — OpenRouter requires no per-provider credentials
    return 'openrouter/moonshotai/kimi-k2.5';
  }

  // ─── Pipeline Step Streamers ────────────────────────────────────────────────

  /**
   * Create and start a SlackStreamer for a pipeline step.
   * Called by SlackBridge on STEP_QUEUED.
   */
  async startStepStream(
    runId: string,
    stepId: string,
    channelId: string,
    threadTs: string,
    recipientUserId?: string,
  ): Promise<SlackStreamer> {
    const key = `${runId}:${stepId}`;
    const existing = this.stepStreamers.get(key);
    if (existing && existing.currentState === 'streaming') {
      await existing.stopWithError('Interrupted by new step');
    }

    const streamer = new SlackStreamer({
      client: this.client,
      channel: channelId,
      threadTs,
      recipientUserId,
      recipientTeamId: this.teamId,
      taskDisplayMode: 'plan',
    });

    this.stepStreamers.set(key, streamer);
    return streamer;
  }

  /** Get the active streamer for a pipeline step (used by SlackBridge). */
  getStepStreamer(runId: string, stepId: string): SlackStreamer | undefined {
    return this.stepStreamers.get(`${runId}:${stepId}`);
  }

  /** Remove a step streamer after the step is complete/failed. */
  removeStepStreamer(runId: string, stepId: string): void {
    this.stepStreamers.delete(`${runId}:${stepId}`);
  }

  // ─── Conversation Streaming (DM / Channel) ──────────────────────────────────

  /**
   * Send a message through the session pool and open a live streaming response.
   * The streamer is stored keyed by channel+thread so SlackBridge can pipe
   * session output (text chunks, tool calls) into it as they arrive.
   */
  async respondViaPool(
    channelId: string,
    threadTs: string,
    message: string,
    userId: string,
    userName: string,
    source: 'dm' | 'channel_thread',
    threadTsForPool?: string,
  ): Promise<void> {
    const pool = this.config.sessionPool;
    if (!pool) {
      console.warn(`[${this.agentId}] respondViaPool called but no sessionPool configured`);
      return;
    }

    // DM channels start with 'D' — don't pass recipient fields, chatStream works differently there
    const isDm = channelId.startsWith('D');

    // Create the streamer — it will be populated by SlackBridge session hooks.
    // We start it now so Slack shows a typing indicator immediately.
    const streamer = new SlackStreamer({
      client: this.client,
      channel: channelId,
      threadTs,
      // Only set recipient fields for non-DM channels (channel threads)
      recipientUserId: isDm ? undefined : userId,
      recipientTeamId: isDm ? undefined : this.teamId,
      taskDisplayMode: 'plan',
    });

    // pool.sendMessage() now returns the sessionId synchronously (pre-registered),
    // then does the actual cold-start async. This means we can register the streamer
    // immediately — before the container even starts — so output hooks can find it
    // from the very first token.
    const sessionId = await pool.sendMessage({
      agentId: this.agentId,
      channelId,
      threadTs: threadTsForPool,
      source,
      message,
      userId,
      userName,
      client: this.client,
      botUserId: this.botUserId,
      // Use thinkingModel for Slack conversations, but only if it's not an
        // opencode-specific model (those aren't reachable inside containers).
        // Fall back to defaultSlackDecisionModel or a reliable OpenRouter default.
        model: this.resolveSlackModel(),
    });

    // Register streamer immediately by sessionId — cold-start is running in background
    const streamKey = `conv:${sessionId}`;
    this.stepStreamers.set(streamKey, streamer);

    // Start stream + typing indicator (non-blocking — falls back to plain post if unavailable)
    try {
      await streamer.start(`${this.agent.identity.name} is thinking...`);
    } catch (err) {
      console.warn(`[${this.agentId}] chatStream start failed (will use plain post fallback):`, err);
    }
  }

  /**
   * Get the active conversation streamer for a session.
   * Keyed by sessionId (not channel+thread) to avoid threadTs ambiguity.
   * Used by SlackBridge to pipe session output into the right streamer.
   */
  getConvStreamer(sessionId: string): SlackStreamer | undefined {
    return this.stepStreamers.get(`conv:${sessionId}`);
  }

  /** Remove a conversation streamer after the response is complete. */
  removeConvStreamer(sessionId: string): void {
    this.stepStreamers.delete(`conv:${sessionId}`);
  }

  /**
   * Get the channel+thread that a conv streamer was created for.
   * Used by SlackBridge to fall back to postToThread if streaming fails.
   */
  getConvStreamerTarget(sessionId: string): { channelId: string; threadTs: string } | undefined {
    const streamer = this.stepStreamers.get(`conv:${sessionId}`);
    if (!streamer) return undefined;
    return { channelId: streamer.options.channel, threadTs: streamer.options.threadTs };
  }

  // ─── Event Handlers ────────────────────────────────────────────────────

  private setupEventHandlers(): void {
    // Handle @mentions
    this.app.event('app_mention', async ({ event, say }) => {
      await this.handleMention(event as any);
    });

    // Handle messages in channels/threads where the agent is present
    this.app.event('message', async ({ event }) => {
      const msg = event as any;

      // Ignore own messages — check both msg.user (postMessage) and msg.bot_id
      // (chatStream/streaming API messages have no msg.user, only bot_id).
      if (msg.user === this.botUserId) return;
      if (!msg.user && msg.bot_id) return;
      // Ignore message subtypes (edits, deletes, etc.)
      if (msg.subtype) return;
      
      // Track if this is from another agent (bot)
      const isFromOtherAgent = !!(msg as any).bot_id;

      // Handle DMs (direct messages to this agent)
      if (msg.channel_type === 'im') {
        if (msg.thread_ts) {
          // DM thread reply - user is responding in the conversation thread
          await this.handleDMThreadReply(msg);
        } else {
          // New DM conversation
          await this.handleDirectMessage(msg);
        }
        return;
      }

      // Handle thread replies in shared channels
      if (msg.thread_ts) {
        // Check if this is a pipeline work thread (shared check across ALL agents)
        const isPipelineWorkThread = this.config.isPipelineThread?.(msg.channel, msg.thread_ts) ?? false;
        
        // For pipeline work threads, only respond if directly @mentioned in THIS message
        if (isPipelineWorkThread) {
          const mentionsMe = this.botUserId && (msg.text || '').includes(`<@${this.botUserId}>`);
          if (mentionsMe) {
            console.log(`[${this.agentId}] @mentioned in pipeline thread, handling...`);
            await this.handleThreadReply(msg);
          }
          // Otherwise ignore - pipeline threads are for work output, not conversation
          // No LLM decision needed, no token burn
          return;
        }
        
        // Check threadMode setting (default: passive)
        const threadMode = this.agent.config?.threadMode || 'passive';
        
        if (threadMode === 'active') {
          // Active mode: evaluate ALL threads in channels where agent is present
          await this.handleSharedChannelThreadReply(msg, isFromOtherAgent);
        } else {
          // Passive mode: only respond if we've participated or were @mentioned in this thread
          const hasParticipated = await this.hasParticipatedInThread(msg.channel, msg.thread_ts);
          const wasMentionedInThread = await this.wasMentionedInThread(msg.channel, msg.thread_ts);
          
          if (hasParticipated || wasMentionedInThread) {
            await this.handleSharedChannelThreadReply(msg, isFromOtherAgent);
          }
        }
      }
    });

    // ─── Feedback Buttons ──────────────────────────────────────────────────
    // Handle thumbs up/down feedback on agent responses.
    // The feedback_buttons block uses action_id: 'agent_response_feedback'.
    // Slack fires a block_actions event with the selected value ('positive'
    // or 'negative'). We resolve the parent message text to give the memory
    // callback enough context to store a useful lesson.
    this.app.action('agent_response_feedback', async ({ action, body, ack }) => {
      await ack();

      if (!this.config.onFeedback) return;

      const feedbackValue = (action as any).selected_option?.value
        ?? (action as any).value
        ?? 'unknown';
      const feedback: 'positive' | 'negative' =
        feedbackValue === 'negative' ? 'negative' : 'positive';

      // Resolve who gave the feedback
      const userId = (body as any).user?.id;
      let userName = 'User';
      if (userId) {
        try {
          const userInfo = await this.client.users.info({ user: userId });
          userName = (userInfo.user as any)?.real_name || (userInfo.user as any)?.name || 'User';
        } catch { /* use fallback */ }
      }

      // The response text lives in the message that contains the feedback buttons.
      // Slack sends it as body.message.text (plain-text fallback of the streamed message).
      const responseText = (body as any).message?.text
        ?? (body as any).message?.blocks
          ?.filter((b: any) => b.type === 'rich_text' || b.type === 'section')
          ?.map((b: any) => b.text?.text ?? '')
          ?.join('\n')
        ?? '(response not available)';

      try {
        await this.config.onFeedback(this.agentId, feedback, responseText, userName);
        // React to confirm the feedback was recorded
        const emoji = feedback === 'positive' ? 'white_check_mark' : 'pencil2';
        const channelId = (body as any).channel?.id ?? (body as any).container?.channel_id;
        const messageTs = (body as any).message?.ts;
        if (channelId && messageTs) {
          await this.react(channelId, messageTs, emoji);
        }
      } catch (err) {
        console.warn(`[${this.agentId}] Failed to process feedback:`, (err as Error).message);
      }
    });
  }

  /**
   * Handle an @mention of this agent.
   */
  private async handleMention(event: {
    user: string;
    text: string;
    channel: string;
    ts: string;
    thread_ts?: string;
  }): Promise<void> {
    console.log(
      `[${this.agentId}] @mentioned by ${event.user}: ${event.text.slice(0, 100)}`
    );

    // Resolve user name
    let userName = 'User';
    try {
      const userInfo = await this.client.users.info({ user: event.user });
      if (userInfo.ok && userInfo.user) {
        userName = (userInfo.user as any).real_name || (userInfo.user as any).name || 'User';
      }
    } catch (err) {
      // Ignore resolution errors
    }

    // Strip the mention itself from the text
    const cleanText = event.text
      .replace(/<@[A-Z0-9]+>/g, '')
      .trim();

    // The thread to reply in (existing thread or new thread rooted at this message)
    const replyThreadTs = event.thread_ts || event.ts;
    const isInThread = !!event.thread_ts;

    // Pool path: persistent container session with streaming response
    if (this.config.sessionPool) {
      // When @mentioned in a channel (not in a thread), the agent gets no
      // surrounding context — the thread is brand new (only the mention msg).
      // Fetch recent channel messages so the agent knows what's being discussed.
      let messageWithContext = `${userName}: ${cleanText}`;
      if (!isInThread) {
        const channelContext = await this.fetchRecentChannelContext(event.channel, event.ts);
        if (channelContext) {
          messageWithContext = `[Recent channel messages for context]\n${channelContext}\n\n[New message — respond to this]\n${userName}: ${cleanText}`;
        }
      }

      console.log(`[${this.agentId}] @mention — using session pool (channel_thread, inThread=${isInThread})`);
      await this.respondViaPool(
        event.channel,
        replyThreadTs,
        messageWithContext,
        event.user,
        userName,
        'channel_thread',
        replyThreadTs,
      );
      return;
    }

    // Legacy: onRunFullSession (one-shot container per message)
    if (this.config.onRunFullSession) {
      console.log(`[${this.agentId}] @mention — running full session (legacy)`);
      try {
        const systemPrompt = await this.buildFullSystemPrompt(`Mention in channel by ${userName}`);
        const result = await this.config.onRunFullSession({
          agentId: this.agentId,
          systemPrompt,
          userPrompt: `${userName} said: ${cleanText}`,
          model: this.agent.config?.thinkingModel || this.config.defaultSlackDecisionModel || 'openrouter/minimax/minimax-m2.5',
          workspacePath: `/data/workspaces/${this.agentId}`,
          vaultPath: `/data/vaults/${this.agentId}`,
          source: 'slack_channel',
          sourceId: replyThreadTs,
        });
        if (result.success && result.output) {
          await this.postToThread(event.channel, replyThreadTs, result.output);
          return;
        }
      } catch (err) {
        console.error(`[${this.agentId}] Full session failed for mention, falling back:`, err);
      }
    }

    // Lightweight fallback decision
    const decision = await this.makeDecision(event.user, cleanText, event.channel, replyThreadTs, 'mention');
    await this.executeDecision(decision, event.channel, replyThreadTs, event.ts, event.user, userName);
  }

  /**
   * Handle a direct message to this agent.
   */
  private async handleDirectMessage(msg: any): Promise<void> {
    console.log(
      `[${this.agentId}] DM from ${msg.user}: ${(msg.text || '').slice(0, 100)}`
    );

    // Resolve user name
    let userName = 'User';
    try {
      const userInfo = await this.client.users.info({ user: msg.user });
      if (userInfo.ok && userInfo.user) {
        userName = (userInfo.user as any).real_name || (userInfo.user as any).name || 'User';
      }
    } catch (err) {
      // Ignore resolution errors
    }

    const messageText = msg.text || '';

    // Pool path: persistent container with streaming response
    if (this.config.sessionPool) {
      console.log(`[${this.agentId}] DM — using session pool`);
      await this.respondViaPool(
        msg.channel,
        msg.ts,    // threadTs for streaming = message ts (root of a new DM thread)
        messageText,
        msg.user || 'unknown',
        userName,
        'dm',
        undefined, // No pool threadTs for DMs — uses channel as identity
      );
      return;
    }

    // Legacy: onRunFullSession
    if (this.config.onRunFullSession) {
      console.log(`[${this.agentId}] DM — running full session (legacy)`);
      try {
        const systemPrompt = await this.buildFullSystemPrompt(`Direct message from ${userName}`);
        const result = await this.config.onRunFullSession({
          agentId: this.agentId,
          systemPrompt,
          userPrompt: `${userName} said: ${messageText}`,
          model: this.agent.config?.model || 'openrouter/moonshotai/kimi-k2.5',
          workspacePath: `/data/workspaces/${this.agentId}`,
          vaultPath: `/data/vaults/${this.agentId}`,
          source: 'slack_dm',
          sourceId: msg.ts,
        });
        if (result.success && result.output) {
          await this.postToThread(msg.channel, msg.ts, result.output);
          return;
        }
      } catch (err) {
        console.error(`[${this.agentId}] Full session failed for DM:`, err);
      }
    }

    // Lightweight fallback
    const decision = await this.makeDecision(msg.user || 'unknown', messageText, msg.channel, msg.ts, 'mention');
    await this.executeDecision(decision, msg.channel, msg.ts, msg.ts, msg.user || 'unknown', userName);
  }

  /**
   * Handle a thread reply in a DM conversation.
   * This is when a user replies to the agent's response in a DM thread.
   */
  private async handleDMThreadReply(msg: any): Promise<void> {
    console.log(
      `[${this.agentId}] DM thread reply from ${msg.user}: ${(msg.text || '').slice(0, 100)}`
    );

    // Resolve user name
    let userName = 'User';
    try {
      const userInfo = await this.client.users.info({ user: msg.user });
      if (userInfo.ok && userInfo.user) {
        userName = (userInfo.user as any).real_name || (userInfo.user as any).name || 'User';
      }
    } catch (err) {
      // Ignore resolution errors
    }

    const messageText = msg.text || '';

    // Pool path: the DM session for this channel is already running (or will be created).
    // Thread replies in DMs continue the same session — the container has full history.
    if (this.config.sessionPool) {
      console.log(`[${this.agentId}] DM thread reply — using session pool`);
      await this.respondViaPool(
        msg.channel,
        msg.thread_ts,    // threadTs for the streaming response
        messageText,
        msg.user || 'unknown',
        userName,
        'dm',
        undefined,        // Pool key for DMs is just channel-based
      );
      return;
    }

    // Legacy: onRunFullSession with history injection
    if (this.config.onRunFullSession) {
      console.log(`[${this.agentId}] DM thread reply — running full session (legacy)`);
      const threadHistory = await this.fetchThreadHistory(msg.channel, msg.thread_ts);
      try {
        const basePrompt = await this.buildFullSystemPrompt(`DM thread reply from ${userName}`);
        const systemPrompt = [basePrompt, '', '## Conversation History', threadHistory, '', 'Continue naturally.'].join('\n');
        const result = await this.config.onRunFullSession({
          agentId: this.agentId,
          systemPrompt,
          userPrompt: `${userName} replied: ${messageText}`,
          model: this.agent.config?.model || 'openrouter/moonshotai/kimi-k2.5',
          workspacePath: `/data/workspaces/${this.agentId}`,
          vaultPath: `/data/vaults/${this.agentId}`,
          source: 'slack_dm',
          sourceId: msg.thread_ts,
        });
        if (result.success && result.output) {
          await this.postToThread(msg.channel, msg.thread_ts, result.output);
          return;
        }
      } catch (err) {
        console.error(`[${this.agentId}] Full session failed for DM thread reply:`, err);
      }
    }

    // Lightweight fallback
    const decision = await this.makeDecision(msg.user || 'unknown', messageText, msg.channel, msg.thread_ts, 'thread_reply');
    await this.executeDecision(decision, msg.channel, msg.thread_ts, msg.ts, msg.user || 'unknown', userName);
  }

  /**
   * Handle a thread reply in a thread where this agent is working.
   */
  private async handleThreadReply(msg: any): Promise<void> {
    console.log(
      `[${this.agentId}] Thread reply from ${msg.user}: ${(msg.text || '').slice(0, 100)}`
    );

    // Find which run this thread belongs to
    const relatedStep = this.activeSteps.find(
      (s) => s.threadTs === (msg.thread_ts || msg.ts) && s.channelId === msg.channel
    );

    // Resolve user name if possible
    let userName = 'User';
    try {
      const userInfo = await this.client.users.info({ user: msg.user });
      if (userInfo.ok && userInfo.user) {
        userName = (userInfo.user as any).real_name || (userInfo.user as any).name || 'User';
      }
    } catch (err) {
      // Ignore resolution errors
    }

    // Emit SLACK_MESSAGE event for the human's message
    if (relatedStep && this.config.onSlackMessage) {
      await this.config.onSlackMessage(relatedStep.runId, {
        agentId: this.agentId,
        agentName: this.agent.identity.name,
        agentEmoji: this.agent.identity.emoji,
        userId: msg.user,
        userName,
        message: msg.text || '',
        isAgent: false,
        threadTs: msg.thread_ts || msg.ts,
        messageTs: msg.ts,
      });
    }

    const decision = await this.makeDecision(
      msg.user || 'unknown',
      msg.text || '',
      msg.channel,
      msg.thread_ts || msg.ts,
      'thread_reply'
    );

    await this.executeDecision(
      decision,
      msg.channel,
      msg.thread_ts || msg.ts,
      msg.ts,
      msg.user || 'unknown',
      userName,
      relatedStep?.runId
    );
  }

  /**
   * Check if this agent has participated in a thread (posted a message).
   */
  private async hasParticipatedInThread(channelId: string, threadTs: string): Promise<boolean> {
    if (!this.botUserId) {
      return false;
    }

    try {
      const result = await this.client.conversations.replies({
        channel: channelId,
        ts: threadTs,
        limit: 50,
      });

      if (!result.ok || !result.messages) {
        return false;
      }

      // Check if any message in the thread is from THIS agent.
      // Messages sent via chat.postMessage have msg.user === botUserId.
      // Messages sent via chatStream (streaming API) have msg.bot_id but
      // NO msg.user — so we also check bot_id to detect streamed replies.
      return result.messages.some(
        (msg) => msg.user === this.botUserId ||
                 (this.botId && !msg.user && (msg as any).bot_id === this.botId)
      );
    } catch (err) {
      console.error(`[${this.agentId}] Failed to check thread participation:`, err);
      return false;
    }
  }

  /**
   * Check if this agent was @mentioned anywhere in a thread.
   */
  private async wasMentionedInThread(channelId: string, threadTs: string): Promise<boolean> {
    if (!this.botUserId) {
      return false;
    }

    try {
      const result = await this.client.conversations.replies({
        channel: channelId,
        ts: threadTs,
        limit: 50,
      });

      if (!result.ok || !result.messages) {
        return false;
      }

      // Check if any message in the thread mentions this agent
      const mentionPattern = `<@${this.botUserId}>`;
      return result.messages.some(
        (msg) => msg.text && msg.text.includes(mentionPattern)
      );
    } catch (err) {
      console.error(`[${this.agentId}] Failed to check thread mentions:`, err);
      return false;
    }
  }

  /**
   * Handle a thread reply in a shared channel where this agent has participated.
   * Evaluates whether the agent should respond based on context, mentions, and relevance.
   */
  private async handleSharedChannelThreadReply(msg: any, isFromOtherAgent: boolean = false): Promise<void> {
    console.log(
      `[${this.agentId}] Evaluating shared channel thread reply from ${isFromOtherAgent ? 'agent' : 'human'} ${msg.user}: ${(msg.text || '').slice(0, 100)}`
    );

    // Resolve user/agent name
    let userName = isFromOtherAgent ? 'Another Agent' : 'User';
    try {
      const userInfo = await this.client.users.info({ user: msg.user });
      if (userInfo.ok && userInfo.user) {
        userName = (userInfo.user as any).real_name || (userInfo.user as any).name || userName;
      }
    } catch (err) {
      // Ignore resolution errors
    }

    // Fetch thread history for context (used for both pool and legacy decision paths)
    const threadHistory = await this.fetchThreadHistory(msg.channel, msg.thread_ts);

    // Make a nuanced decision about whether to engage at all
    const decision = await this.makeSharedThreadDecision(
      msg.user || 'unknown',
      userName,
      msg.text || '',
      msg.channel,
      msg.thread_ts,
      threadHistory,
      isFromOtherAgent
    );

    if (decision.action === 'ignore') {
      console.log(`[${this.agentId}] Decided not to respond to shared thread`);
      return;
    }

    // Pool path: use session pool with streaming response
    if (this.config.sessionPool && decision.action === 'respond') {
      console.log(`[${this.agentId}] Shared channel thread — using session pool`);
      await this.respondViaPool(
        msg.channel,
        msg.thread_ts,
        msg.text || '',
        msg.user || 'unknown',
        userName,
        'channel_thread',
        msg.thread_ts,
      );
      return;
    }

    // Legacy / acknowledge path
    await this.executeDecision(decision, msg.channel, msg.thread_ts, msg.ts, msg.user || 'unknown', userName);
  }

  /**
   * Make a decision about whether to respond in a shared channel thread.
   * More selective than makeDecision - considers relevance to agent's role.
   */
  private async makeSharedThreadDecision(
    fromUserId: string,
    fromUserName: string,
    messageText: string,
    channelId: string,
    threadTs: string,
    threadHistory: string,
    isFromOtherAgent: boolean = false
  ): Promise<SlackDecision> {
    // Pre-fetch relevant memories for context
    let memoryContext = '';
    if (this.config.onMemorySearch) {
      try {
        const searchQuery = `${messageText} ${threadHistory.slice(0, 300)}`;
        const memories = await this.config.onMemorySearch(this.agentId, searchQuery, 5);
        if (memories.length > 0) {
          memoryContext = [
            `# Relevant Memories`,
            ...memories.map(m => `- **${m.title}** (${m.category}): ${m.snippet}`),
            '',
          ].join('\n');
        }
      } catch (err) {
        console.warn(`[${this.agentId}] Memory search failed:`, err);
      }
    }

    const agentCollabContext = isFromOtherAgent ? [
      '',
      `# Agent Collaboration`,
      `This message is from another agent (${fromUserName}) on your team.`,
      `You are collaborating on this thread. Consider:`,
      `- If they asked you a question or requested your expertise, respond`,
      `- If they're addressing the team or asking for input on your area, contribute`,
      `- If they're just sharing their work or thinking aloud, you can acknowledge or stay silent`,
      `- Avoid redundant responses - don't repeat what another agent said`,
      '',
    ].join('\n') : '';

    const systemPrompt = [
      `# Identity`,
      `You are ${this.agent.identity.name} ${this.agent.identity.emoji}, ${this.agent.identity.role}.`,
      '',
      `# Your Persona`,
      this.agent.soul ? this.agent.soul.slice(0, 1000) : '',
      '',
      `# Decision Framework`,
      this.agent.decision ? this.agent.decision.slice(0, 500) : '',
      '',
      memoryContext,
      `# Your Responsibilities`,
      `Based on your role as ${this.agent.identity.role}, you are responsible for topics and decisions related to your area of expertise.`,
      agentCollabContext,
      `# Conversation History (this thread)`,
      threadHistory,
      '',
      `# Decision Task`,
      `A new message was posted in a thread where you previously participated.`,
      `Decide if YOU specifically should respond. Consider:`,
      '',
      `1. **Direct mention**: Are you @mentioned or addressed by name?`,
      `2. **Role relevance**: Is this about your area (${this.agent.identity.role})?`,
      `3. **Continuity**: Were you actively discussing this topic before?`,
      `4. **Value add**: Can you contribute something meaningful?`,
      `5. **Avoid noise**: Don't respond just to agree or if others are handling it`,
      isFromOtherAgent ? `6. **Agent collaboration**: Is this agent asking for your input or expertise?` : '',
      '',
      `Respond with JSON:`,
      '```json',
      '{',
      '  "shouldRespond": true | false,',
      '  "reason": "brief explanation of why you should/shouldn\'t respond",',
      '  "action": "respond" | "acknowledge" | "ignore",',
      '  "response": "your reply text (only if action is respond)",',
      '  "reaction": "emoji_name (only if action is acknowledge)"',
      '}',
      '```',
      '',
      'IMPORTANT: Default to "ignore" unless you have a clear reason to engage.',
      'Respond ONLY with the JSON object.',
    ].join('\n');

    const userPrompt = `New message from ${isFromOtherAgent ? 'agent' : 'human'} ${fromUserName} (<@${fromUserId}>):\n${messageText}`;

    try {
      const llmResponse = await this.config.onDecisionNeeded(
        this.agentId,
        systemPrompt,
        userPrompt,
        this.agent.config?.thinkingModel || this.config.defaultSlackDecisionModel || 'openrouter/minimax/minimax-m2.5'
      );

      // Parse the JSON response with robust cleaning
      const parsed = this.parseDecisionJson(llmResponse);

      // Map to standard decision format
      if (!parsed.shouldRespond || parsed.action === 'ignore') {
        return { action: 'ignore' };
      }

      return {
        action: parsed.action || 'respond',
        response: parsed.response,
        reaction: parsed.reaction,
      };
    } catch (err) {
      // Parse failures are common with weaker/cheaper models — log as warning, not error.
      console.warn(
        `[${this.agentId}] Shared thread decision unparseable, defaulting to ignore:`,
        (err as Error).message
      );
      return { action: 'ignore' };
    }
  }

  /**
   * Fetch thread conversation history for context.
   */
  private async fetchThreadHistory(
    channelId: string,
    threadTs: string,
    limit: number = 20
  ): Promise<string> {
    try {
      const result = await this.client.conversations.replies({
        channel: channelId,
        ts: threadTs,
        limit,
      });

      if (!result.ok || !result.messages || result.messages.length === 0) {
        return '';
      }

      // Build conversation history, resolving user names where possible
      const messages: string[] = [];
      for (const msg of result.messages) {
        const isBot = msg.bot_id || msg.user === this.botUserId;
        let sender = isBot ? this.agent.identity.name : 'Human';
        
        // Try to resolve human user names
        if (!isBot && msg.user) {
          try {
            const userInfo = await this.client.users.info({ user: msg.user });
            if (userInfo.ok && userInfo.user) {
              sender = (userInfo.user as any).real_name || (userInfo.user as any).name || 'Human';
            }
          } catch {
            // Ignore resolution errors
          }
        }

        const text = msg.text || '[no text]';
        messages.push(`[${sender}]: ${text}`);
      }

      return messages.join('\n');
    } catch (err) {
      console.error(`[${this.agentId}] Failed to fetch thread history:`, err);
      return '';
    }
  }

  /**
   * Fetch recent channel messages for context when @mentioned outside a thread.
   * Returns a formatted string of the last ~15 messages, or empty if unavailable.
   * This gives the agent awareness of what was being discussed before the mention.
   */
  private async fetchRecentChannelContext(
    channelId: string,
    beforeTs: string,
    limit: number = 15,
  ): Promise<string> {
    try {
      const result = await this.client.conversations.history({
        channel: channelId,
        latest: beforeTs,
        limit,
        inclusive: false, // Don't include the mention message itself
      });

      if (!result.ok || !result.messages || result.messages.length === 0) {
        return '';
      }

      // conversations.history returns newest first — reverse to chronological
      const msgs = [...result.messages].reverse();

      const nameCache = new Map<string, string>();
      const lines: string[] = [];

      for (const msg of msgs) {
        if (!msg.text?.trim()) continue;
        // Skip message subtypes like joins, topic changes, etc.
        if ((msg as any).subtype && (msg as any).subtype !== 'bot_message') continue;

        const isBot = !!(msg as any).bot_id || msg.user === this.botUserId;
        let sender = isBot ? (msg as any).username || 'Bot' : 'User';

        if (!isBot && msg.user) {
          if (nameCache.has(msg.user)) {
            sender = nameCache.get(msg.user)!;
          } else {
            try {
              const userInfo = await this.client.users.info({ user: msg.user });
              sender = (userInfo.user as any)?.real_name || (userInfo.user as any)?.name || 'User';
              nameCache.set(msg.user, sender);
            } catch { /* use fallback */ }
          }
        }

        lines.push(`[${sender}]: ${msg.text}`);
      }

      return lines.join('\n');
    } catch (err) {
      console.warn(`[${this.agentId}] Failed to fetch channel context:`, (err as Error).message);
      return '';
    }
  }

  /**
   * Use the LLM to decide what to do with an incoming message.
   */
  private async makeDecision(
    fromUserId: string,
    messageText: string,
    channelId: string,
    threadTs: string,
    eventType: 'mention' | 'thread_reply'
  ): Promise<SlackDecision> {
    // Build work context summary
    const workContext = this.activeSteps
      .map(
        (s) =>
          `- Run ${s.runId}: Step ${s.stepId} (${s.status}) — ${s.taskSummary}`
      )
      .join('\n') || 'No active work.';

    // Find which run this thread belongs to
    const relatedStep = this.activeSteps.find(
      (s) => s.threadTs === threadTs && s.channelId === channelId
    );

    // Fetch thread conversation history for context
    let threadHistory = '';
    if (eventType === 'thread_reply') {
      threadHistory = await this.fetchThreadHistory(channelId, threadTs);
    }

    // All responses go through ContainerRunner for true isolation
    // No more lightweight decision path — every interaction spawns an isolated container
    if (this.config.onRunFullSession) {
      return this.makeFullDecision(fromUserId, messageText, channelId, threadTs, threadHistory, workContext, relatedStep);
    }

    // Fallback only if onRunFullSession not configured (shouldn't happen in production)
    console.warn(`[${this.agentId}] onRunFullSession not configured — falling back to lightweight decision`);

    // Pre-fetch relevant memories for context (if available)
    let memoryContext = '';
    console.log(`[${this.agentId}] makeDecision: fallback path, onMemorySearch=${!!this.config.onMemorySearch}`);
    if (this.config.onMemorySearch) {
      try {
        // Build search query from message + thread context
        const searchQuery = threadHistory 
          ? `${messageText} ${threadHistory.slice(0, 500)}`
          : messageText;
        
        console.log(`[${this.agentId}] Searching memories for: "${searchQuery.slice(0, 50)}..."`);
        const memories = await this.config.onMemorySearch(this.agentId, searchQuery, 5);
        console.log(`[${this.agentId}] Memory search returned ${memories.length} results`);
        if (memories.length > 0) {
          memoryContext = [
            `# Relevant Memories`,
            ...memories.map(m => `- **${m.title}** (${m.category}): ${m.snippet}`),
            '',
          ].join('\n');
        }
      } catch (err) {
        console.warn(`[${this.agentId}] Memory search failed:`, err);
      }
    }

    // Lightweight triage with memory context
    const systemPrompt = [
      `# Identity`,
      `You are ${this.agent.identity.name} ${this.agent.identity.emoji}, ${this.agent.identity.role}.`,
      '',
      `# Your Persona`,
      this.agent.soul ? this.agent.soul.slice(0, 1000) : '(No soul defined)',
      '',
      `# Decision Framework`,
      this.agent.decision ? this.agent.decision.slice(0, 500) : '',
      '',
      memoryContext,
      `# Current Work`,
      workContext,
      '',
      relatedStep
        ? `This message is in the thread for Run ${relatedStep.runId}, Step ${relatedStep.stepId} (${relatedStep.status}).`
        : 'This message is not in a thread related to your current work.',
      '',
      threadHistory ? `# Conversation History\n${threadHistory}\n` : '',
      `# Task`,
      `Decide how to respond to this Slack message. Use your memories and context above to inform your decision.`,
      `Output JSON only:`,
      '```json',
      '{',
      '  "action": "respond" | "apply_guidance" | "acknowledge" | "ignore" | "escalate",',
      '  "response": "your reply (if respond) - informed by your memories and context",',
      '  "reaction": "emoji_name (if acknowledge)",',
      '  "guidance": "extracted guidance (if apply_guidance)"',
      '}',
      '```',
    ].join('\n');

    const userPrompt = `Event: ${eventType}\nFrom: <@${fromUserId}>\nMessage: ${messageText}`;

    try {
      const llmResponse = await this.config.onDecisionNeeded(
        this.agentId,
        systemPrompt,
        userPrompt,
        this.agent.config?.thinkingModel || this.config.defaultSlackDecisionModel || 'openrouter/minimax/minimax-m2.5'
      );

      const parsed = this.parseDecisionJson(llmResponse);

      return {
        action: parsed.action || 'acknowledge',
        response: parsed.response,
        reaction: parsed.reaction,
        guidance: parsed.guidance,
      };
    } catch (err) {
      console.warn(
        `[${this.agentId}] Decision LLM failed, defaulting to acknowledge:`,
        (err as Error).message
      );
      return { action: 'acknowledge', reaction: 'eyes' };
    }
  }

  /**
   * Make a decision using full agent session with tool access (memories, etc.)
   */
  private async makeFullDecision(
    fromUserId: string,
    messageText: string,
    channelId: string,
    threadTs: string,
    threadHistory: string,
    workContext: string,
    relatedStep: ActiveStep | undefined
  ): Promise<SlackDecision> {
    console.log(`[${this.agentId}] Using full session for thoughtful response`);

    // Load full persona with environment context
    const basePrompt = await this.buildFullSystemPrompt('Slack channel message decision');

    const systemPrompt = [
      basePrompt,
      '',
      `# Current Work`,
      workContext,
      '',
      relatedStep
        ? `This message is in the thread for Run ${relatedStep.runId}, Step ${relatedStep.stepId} (${relatedStep.status}).`
        : '',
      '',
      threadHistory ? `# Conversation History\n${threadHistory}\n` : '',
      '',
      `# Your Task`,
      `You received a Slack message. Before responding:`,
      `1. Search your memories for relevant context about this topic or person`,
      `2. Consider your past interactions and lessons learned`,
      `3. Think about how your persona would respond`,
      `4. If you learn something new or make a realization, save it as a memory`,
      '',
      `After thinking, respond with JSON:`,
      '```json',
      '{',
      '  "action": "respond" | "acknowledge" | "ignore",',
      '  "response": "your thoughtful reply as your persona",',
      '  "reaction": "emoji (if acknowledge)",',
      '  "memory": "optional: something worth remembering for the future"',
      '}',
      '```',
    ].join('\n');

    const userPrompt = `New message from <@${fromUserId}>:\n${messageText}`;

    try {
      const result = await this.config.onRunFullSession!({
        agentId: this.agentId,
        systemPrompt,
        userPrompt,
        model: this.agent.config?.thinkingModel || 'openrouter/minimax/minimax-m2.5',
        workspacePath: `/data/workspaces/${this.agentId}`,
        vaultPath: `/data/vaults/${this.agentId}`,
        source: 'slack_channel',
        sourceId: threadTs,
      });

      if (result.success && result.output) {
        const parsed = this.parseDecisionJson(result.output);
        return {
          action: parsed.action || 'respond',
          response: parsed.response,
          reaction: parsed.reaction,
        };
      }
    } catch (err) {
      console.error(`[${this.agentId}] Full session decision failed:`, err);
    }

    // Fallback to acknowledge
    return { action: 'acknowledge', reaction: 'eyes' };
  }

  /**
   * Execute the decision the LLM made.
   */
  private async executeDecision(
    decision: SlackDecision,
    channelId: string,
    threadTs: string,
    messageTs: string,
    userId: string,
    userName: string,
    runId?: string
  ): Promise<void> {
    switch (decision.action) {
      case 'respond':
        if (decision.response) {
          await this.postToThread(channelId, threadTs, decision.response, undefined, runId);
        }
        break;

      case 'apply_guidance': {
        // Acknowledge receipt
        await this.react(channelId, messageTs, 'thumbsup');

        // Store the guidance
        const guidance: HumanGuidance = {
          from: userId,
          fromName: userName,
          message: decision.guidance || decision.response || '',
          channelId,
          threadTs,
          timestamp: Date.now(),
          applied: false,
        };
        this.humanGuidance.push(guidance);

        // If we have an active step in this thread, inject as HUMAN_INTERVENTION
        const relatedStep = this.activeSteps.find(
          (s) => s.threadTs === threadTs && s.channelId === channelId
        );
        if (relatedStep && this.config.onHumanGuidance) {
          await this.config.onHumanGuidance(
            this.agentId,
            relatedStep.runId,
            relatedStep.stepId,
            guidance.message
          );
          guidance.applied = true;
        }

        // Respond if the LLM provided a response
        if (decision.response) {
          await this.postToThread(channelId, threadTs, decision.response, undefined, runId);
        }
        break;
      }

      case 'acknowledge':
        await this.react(
          channelId,
          messageTs,
          decision.reaction || 'eyes'
        );
        break;

      case 'escalate':
        await this.react(channelId, messageTs, 'rotating_light');
        if (decision.response) {
          await this.postToThread(channelId, threadTs, decision.response, undefined, runId);
        }
        break;

      case 'ignore':
        // Do nothing
        break;
    }
  }
}
