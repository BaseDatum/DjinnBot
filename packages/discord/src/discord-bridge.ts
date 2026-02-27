/**
 * DiscordBridge — connects the pipeline event bus to Discord via agent runtimes.
 *
 * Subscribes to pipeline events and routes them to the appropriate agent's
 * Discord runtime for posting. Also manages the orchestrator's thread lifecycle.
 *
 * Mirrors SlackBridge for the Discord platform.
 */

import type { Client } from 'discord.js';
import {
  EventBus,
  runChannel,
  AgentRegistry,
  authFetch,
  type AgentRegistryEntry,
  type ChannelCredentials,
  type PipelineEvent,
} from '@djinnbot/core';
import type { ChatSessionManager } from '@djinnbot/core/chat';
import { Redis } from 'ioredis';
import { AgentDiscordRuntime, type DiscordMessageData } from './agent-discord-runtime.js';
import { ThreadManager } from './thread-manager.js';
import { DiscordSessionPool } from './discord-session-pool.js';

/** Session context for persona loading */
export interface SessionContext {
  sessionType: 'discord' | 'pulse' | 'pipeline';
  runId?: string;
  channelContext?: string;
  installedTools?: string[];
}

export interface DiscordBridgeConfig {
  eventBus: EventBus;
  agentRegistry: AgentRegistry;
  defaultChannelId?: string;
  /** Redis URL for config change subscription (hot-reload) */
  redisUrl?: string;
  /** Base URL of the DjinnBot API server */
  apiBaseUrl?: string;
  /** Called when an agent needs to make an LLM decision */
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
  /** ChatSessionManager for persistent Discord conversation sessions */
  chatSessionManager?: ChatSessionManager;
  /** Default model for Discord conversation sessions */
  defaultConversationModel?: string;
  /** Called to search agent's memories for context */
  onMemorySearch?: (
    agentId: string,
    query: string,
    limit?: number,
  ) => Promise<Array<{ title: string; snippet: string; category: string }>>;
  /** Called to load the full agent persona with environment context */
  onLoadPersona?: (
    agentId: string,
    sessionContext: SessionContext,
  ) => Promise<{ systemPrompt: string; identity: string; soul: string; agents: string; decision: string }>;
  /** Default model for Discord decisions when agent config is missing */
  defaultDiscordDecisionModel?: string;
  /** Called when a user gives feedback on an agent response */
  onFeedback?: (
    agentId: string,
    feedback: 'positive' | 'negative',
    responseText: string,
    userName: string,
  ) => Promise<void>;
  /** Called before a session container is torn down */
  onBeforeTeardown?: (sessionId: string, agentId: string) => Promise<void>;
}

/**
 * Extract readable plain text from a tool result string.
 */
function extractToolResultText(result: string, maxLen: number): string {
  try {
    const parsed = JSON.parse(result);
    if (Array.isArray(parsed?.content)) {
      const text = parsed.content
        .filter((c: any) => c.type === 'text' && c.text)
        .map((c: any) => c.text as string)
        .join('\n')
        .trim();
      if (text) {
        return text.slice(0, maxLen) + (text.length > maxLen ? '...' : '');
      }
    }
  } catch {
    // Not JSON
  }
  return result.slice(0, maxLen) + (result.length > maxLen ? '...' : '');
}

export class DiscordBridge {
  private config: DiscordBridgeConfig;
  private agentRuntimes = new Map<string, AgentDiscordRuntime>();
  private threadManager: ThreadManager;
  private sessionPool: DiscordSessionPool | undefined;
  private eventSubscriptions = new Map<string, () => void>();
  private outputBuffers = new Map<string, { content: string; timer: NodeJS.Timeout }>();
  private stepStartTimes = new Map<string, number>();
  private pendingEvents = new Map<string, PipelineEvent[]>();
  private threadReady = new Map<string, boolean>();
  private toolCallCounters = new Map<string, number>();
  private activeToolCardIds = new Map<string, string[]>();
  /** Dedicated Redis connection for config change subscription */
  private configSubRedis: Redis | undefined;

  constructor(config: DiscordBridgeConfig) {
    this.config = config;

    // Build per-agent Client map for thread creation
    const agentClients = new Map<string, Client>();
    for (const agent of config.agentRegistry.getAgentsByChannel('discord')) {
      // Clients will be populated after start()
    }

    this.threadManager = new ThreadManager({
      defaultChannelId: config.defaultChannelId,
      agentClients,
    });

    // Build session pool if ChatSessionManager is available
    if (config.chatSessionManager) {
      this.sessionPool = new DiscordSessionPool({
        chatSessionManager: config.chatSessionManager,
        defaultModel: config.defaultConversationModel ?? config.defaultDiscordDecisionModel ?? 'openrouter/minimax/minimax-m2.5',
        onBeforeTeardown: config.onBeforeTeardown,
      });
    }
  }

  /**
   * Start all agent Discord runtimes (bot login + gateway connections).
   */
  async start(): Promise<void> {
    // Always start the config listener so dashboard-added credentials trigger a hot-reload,
    // even when no agents have Discord credentials at startup.
    this.startConfigListener();

    const discordAgents = this.config.agentRegistry.getAgentsByChannel('discord');

    if (discordAgents.length === 0) {
      console.log('[DiscordBridge] No agents with Discord credentials — bridge inactive (listening for config changes)');
      return;
    }

    console.log(
      `[DiscordBridge] Starting ${discordAgents.length} agent Discord runtimes...`,
    );

    for (const agent of discordAgents) {
      const creds = agent.channels.discord;
      const hasBotToken = !!creds?.primaryToken;
      console.log(
        `[DiscordBridge] Agent ${agent.id}: botToken=${hasBotToken ? 'present' : 'MISSING'}`,
      );
    }

    // Start each agent's Discord bot
    const startPromises = discordAgents.map(async (agent: AgentRegistryEntry) => {
      try {
        const runtime = new AgentDiscordRuntime({
          agent,
          defaultChannelId: this.config.defaultChannelId,
          onDecisionNeeded: this.config.onDecisionNeeded,
          onHumanGuidance: this.config.onHumanGuidance,
          onLoadPersona: this.config.onLoadPersona,
          onFeedback: this.config.onFeedback,
          defaultDiscordDecisionModel: this.config.defaultDiscordDecisionModel,
          sessionPool: this.sessionPool,
          isPipelineThread: (channelId: string, threadId: string) =>
            this.threadManager.isPipelineThread(channelId, threadId),
          onDiscordMessage: async (runId: string, message: DiscordMessageData) => {
            const discordMessageEvent: PipelineEvent = {
              type: 'DISCORD_MESSAGE',
              runId,
              agentId: message.agentId,
              agentName: message.agentName,
              agentEmoji: message.agentEmoji,
              userId: message.userId,
              userName: message.userName,
              message: message.message,
              isAgent: message.isAgent,
              channelId: message.channelId,
              messageId: message.messageId,
              timestamp: Date.now(),
            } as any;
            await this.config.eventBus.publish(runChannel(runId), discordMessageEvent);
          },
        });

        await runtime.start();
        this.agentRuntimes.set(agent.id, runtime);

        // Register client in thread manager
        (this.threadManager as any).config.agentClients.set(agent.id, runtime.getClient());
      } catch (err) {
        console.error(
          `[DiscordBridge] Failed to start runtime for ${agent.id}:`,
          err,
        );
      }
    });

    const results = await Promise.allSettled(startPromises);

    const failures = results.filter((r): r is PromiseRejectedResult => r.status === 'rejected');
    if (failures.length > 0) {
      console.error(
        `[DiscordBridge] ${failures.length}/${discordAgents.length} agent runtimes FAILED to start:`,
      );
      failures.forEach((f, i) => {
        console.error(`[DiscordBridge]   ${i + 1}. ${f.reason?.message || f.reason}`);
      });
    }

    console.log(
      `[DiscordBridge] ${this.agentRuntimes.size}/${discordAgents.length} agent runtimes started successfully`,
    );

    // Register output hooks for conversation sessions
    if (this.config.chatSessionManager && this.sessionPool) {
      this.registerSessionOutputHooks();
    }
  }

  /**
   * Register event hooks with ChatSessionManager so conversation session output
   * flows into the active DiscordStreamer.
   */
  private registerSessionOutputHooks(): void {
    const csm = this.config.chatSessionManager!;

    csm.registerHooks({
      onOutput: (sessionId: string, chunk: string) => this.routeSessionChunk(sessionId, chunk),
      onToolStart: (sessionId: string, toolName: string, args: Record<string, unknown>) =>
        this.routeSessionToolStart(sessionId, toolName, args),
      onToolEnd: (sessionId: string, toolName: string, result: string, isError: boolean, durationMs: number) =>
        this.routeSessionToolEnd(sessionId, toolName, result, isError, durationMs),
      onStepEnd: (sessionId: string, success: boolean) => {
        void this.routeSessionStepEnd(sessionId, success);
      },
    });
  }

  private routeSessionChunk(sessionId: string, chunk: string): void {
    // Only Discord-originated sessions
    if (!sessionId.startsWith('discord_')) return;

    const location = this.findRuntimeForSession(sessionId);
    if (!location) return;

    const streamer = location.runtime.getConvStreamer(sessionId);
    if (!streamer) return;

    streamer.appendText(chunk).catch(err =>
      console.warn(`[DiscordBridge] appendText failed for ${sessionId}:`, err),
    );
  }

  private routeSessionToolStart(sessionId: string, toolName: string, args: Record<string, unknown>): void {
    const runtime = this.findRuntimeForSession(sessionId)?.runtime;
    if (!runtime) return;
    const streamer = runtime.getConvStreamer(sessionId);
    if (!streamer) return;

    const count = (this.toolCallCounters.get(sessionId) ?? 0) + 1;
    this.toolCallCounters.set(sessionId, count);
    const cardId = `${sessionId}:${toolName}:${count}`;

    const stack = this.activeToolCardIds.get(sessionId) ?? [];
    stack.push(cardId);
    this.activeToolCardIds.set(sessionId, stack);

    const argSummary = Object.entries(args)
      .slice(0, 3)
      .map(([k, v]) => `${k}: ${String(v).slice(0, 60)}`)
      .join(', ');
    streamer.updateTask(cardId, toolName, 'in_progress', argSummary || undefined).catch(() => {});
  }

  private routeSessionToolEnd(
    sessionId: string,
    toolName: string,
    result: string,
    isError: boolean,
    _durationMs: number,
  ): void {
    const runtime = this.findRuntimeForSession(sessionId)?.runtime;
    if (!runtime) return;
    const streamer = runtime.getConvStreamer(sessionId);
    if (!streamer) return;

    const stack = this.activeToolCardIds.get(sessionId) ?? [];
    const cardId = stack.pop() ?? `${sessionId}:${toolName}:0`;
    if (stack.length === 0) {
      this.activeToolCardIds.delete(sessionId);
    } else {
      this.activeToolCardIds.set(sessionId, stack);
    }

    const status = isError ? 'error' : 'complete';
    const output = extractToolResultText(result, 200);
    streamer.updateTask(cardId, toolName, status, undefined, output).catch(() => {});
  }

  private async routeSessionStepEnd(sessionId: string, success: boolean): Promise<void> {
    const location = this.findRuntimeForSession(sessionId);
    if (!location) return;
    const { runtime } = location;
    const streamer = runtime.getConvStreamer(sessionId);

    if (!streamer) {
      console.warn(`[DiscordBridge] routeSessionStepEnd: no streamer for ${sessionId}`);
      return;
    }

    if (success) {
      await streamer.stop({ includeFeedback: true });
    } else {
      await streamer.stopWithError('Something went wrong. Please try again.');
    }

    runtime.removeConvStreamer(sessionId);
    this.toolCallCounters.delete(sessionId);
    this.activeToolCardIds.delete(sessionId);
  }

  private findRuntimeForStep(runId: string, stepId: string): AgentDiscordRuntime | undefined {
    for (const [, runtime] of this.agentRuntimes) {
      const steps = runtime.getActiveSteps();
      if (steps.some(s => s.runId === runId && s.stepId === stepId)) {
        return runtime;
      }
    }
    return undefined;
  }

  private findRuntimeForSession(sessionId: string): { runtime: AgentDiscordRuntime; channelId: string; threadId?: string } | undefined {
    if (!this.sessionPool) return undefined;

    const location = this.sessionPool.getSessionLocation(sessionId);
    if (!location) return undefined;

    const runtime = this.agentRuntimes.get(location.agentId);
    if (!runtime) return undefined;

    return { runtime, channelId: location.channelId, threadId: location.threadId };
  }

  /**
   * Subscribe to pipeline events for a specific run.
   */
  subscribeToRun(
    runId: string,
    pipelineId: string,
    taskDescription: string,
    assignedAgentIds: string[],
    discordChannelId?: string,
  ): void {
    if (this.eventSubscriptions.has(runId)) return;

    if (!discordChannelId) {
      console.warn(
        `[DiscordBridge] Skipping Discord thread for run ${runId}: no channel configured`,
      );
      return;
    }

    this.pendingEvents.set(runId, []);
    this.threadReady.set(runId, false);

    const channel = runChannel(runId);
    const unsub = this.config.eventBus.subscribe(channel, async (event: any) => {
      if (!this.threadReady.get(event.runId)) {
        const queue = this.pendingEvents.get(event.runId);
        if (queue) queue.push(event);
        return;
      }
      await this.handlePipelineEvent(event);
    });
    this.eventSubscriptions.set(runId, unsub);

    // Create run thread, then flush queued events
    const assignedAgents = assignedAgentIds
      .map((id) => this.config.agentRegistry.get(id))
      .filter((a): a is AgentRegistryEntry => a !== undefined);

    this.threadManager
      .createRunThread({
        runId,
        pipelineId,
        taskDescription,
        assignedAgents,
        channelId: discordChannelId,
      })
      .then(async () => {
        this.threadReady.set(runId, true);
        const queued = this.pendingEvents.get(runId) || [];
        this.pendingEvents.delete(runId);
        console.log(`[DiscordBridge] Thread ready for ${runId}, flushing ${queued.length} queued events`);
        for (const event of queued) {
          await this.handlePipelineEvent(event);
        }
      })
      .catch((err) =>
        console.error(`[DiscordBridge] Failed to create run thread for ${runId}:`, err),
      );
  }

  /**
   * Handle a pipeline event by routing to the appropriate agent.
   */
  private async handlePipelineEvent(event: PipelineEvent): Promise<void> {
    if (!('runId' in event)) return;

    const thread = this.threadManager.getThread(event.runId);
    if (!thread) return;

    switch (event.type) {
      case 'STEP_QUEUED': {
        const runtime = this.agentRuntimes.get(event.agentId);
        if (!runtime) break;

        const agentEntry = this.config.agentRegistry.get(event.agentId);
        const agentName = agentEntry
          ? `${agentEntry.identity.emoji} ${agentEntry.identity.name}`
          : event.agentId;

        runtime.addActiveStep({
          runId: event.runId,
          stepId: event.stepId,
          pipelineId: thread.pipelineId,
          status: 'working',
          threadId: thread.threadId,
          channelId: thread.channelId,
          taskSummary: thread.taskDescription,
        });

        this.stepStartTimes.set(`${event.runId}:${event.stepId}`, Date.now());

        try {
          const streamer = await runtime.startStepStream(
            event.runId,
            event.stepId,
            thread.channelId,
            thread.threadId,
          );
          await streamer.start(`${agentName} is working on ${event.stepId}...`);
          await streamer.updateTask(event.stepId, event.stepId, 'in_progress');
        } catch (err) {
          console.warn(`[DiscordBridge] Failed to start step stream for ${event.stepId}:`, err);
          await runtime.postToChannel(
            thread.threadId,
            `⏳ **${agentName}** picking up **${event.stepId}**`,
            event.runId,
          );
        }
        break;
      }

      case 'STEP_OUTPUT': {
        const runtime = this.findRuntimeForStep(event.runId, event.stepId);
        const streamer = runtime?.getStepStreamer(event.runId, event.stepId);
        if (streamer) {
          await streamer.appendText(event.chunk);
        }
        break;
      }

      case 'TOOL_CALL_START': {
        const runtime = this.findRuntimeForStep(event.runId, event.stepId);
        const streamer = runtime?.getStepStreamer(event.runId, event.stepId);
        if (streamer) {
          let argSummary = '';
          try {
            const args = JSON.parse(event.args);
            argSummary = Object.entries(args)
              .slice(0, 2)
              .map(([k, v]) => `${k}: ${String(v).slice(0, 80)}`)
              .join(', ');
          } catch { /* ignore */ }
          await streamer.updateTask(event.toolCallId, event.toolName, 'in_progress', argSummary || undefined);
        }
        break;
      }

      case 'TOOL_CALL_END': {
        const runtime = this.findRuntimeForStep(event.runId, event.stepId);
        const streamer = runtime?.getStepStreamer(event.runId, event.stepId);
        if (streamer) {
          const status = event.isError ? 'error' : 'complete';
          const output = event.result.slice(0, 200) + (event.result.length > 200 ? '...' : '');
          await streamer.updateTask(event.toolCallId, event.toolName, status, undefined, output);
        }
        break;
      }

      case 'STEP_COMPLETE': {
        const completingRuntime = this.findRuntimeForStep(event.runId, event.stepId);
        if (completingRuntime) {
          const startKey = `${event.runId}:${event.stepId}`;
          const startTime = this.stepStartTimes.get(startKey);
          const duration = startTime ? Math.round((Date.now() - startTime) / 1000) : 0;
          this.stepStartTimes.delete(startKey);

          const streamer = completingRuntime.getStepStreamer(event.runId, event.stepId);
          if (streamer) {
            await streamer.updateTask(event.stepId, event.stepId, 'complete', undefined,
              duration ? `Completed in ${duration}s` : undefined);
            await streamer.stop({ includeFeedback: true });
            completingRuntime.removeStepStreamer(event.runId, event.stepId);
          }

          completingRuntime.removeActiveStep(event.runId, event.stepId);
        }
        break;
      }

      case 'STEP_FAILED': {
        const failedRuntime = this.findRuntimeForStep(event.runId, event.stepId);
        if (failedRuntime) {
          const agentEntry = this.config.agentRegistry.get(failedRuntime.agentId);
          const agentName = agentEntry
            ? `${agentEntry.identity.emoji} ${agentEntry.identity.name}`
            : failedRuntime.agentId;

          const startKey = `${event.runId}:${event.stepId}`;
          const startTime = this.stepStartTimes.get(startKey);
          const duration = startTime ? Math.round((Date.now() - startTime) / 1000) : 0;
          this.stepStartTimes.delete(startKey);

          const streamer = failedRuntime.getStepStreamer(event.runId, event.stepId);
          if (streamer) {
            await streamer.stopWithError(
              `${agentName} failed on ${event.stepId}${duration ? ` after ${duration}s` : ''}: ${event.error.slice(0, 300)}`,
            );
            failedRuntime.removeStepStreamer(event.runId, event.stepId);
          }

          failedRuntime.removeActiveStep(event.runId, event.stepId);
        }
        break;
      }

      case 'RUN_COMPLETE': {
        await this.threadManager.updateRunStatus(event.runId, 'completed');
        this.cleanupRun(event.runId);
        break;
      }

      case 'RUN_FAILED': {
        await this.threadManager.updateRunStatus(event.runId, 'failed', event.error);
        this.cleanupRun(event.runId);
        break;
      }

      default:
        break;
    }
  }

  private cleanupRun(runId: string): void {
    const unsub = this.eventSubscriptions.get(runId);
    if (unsub) {
      unsub();
      this.eventSubscriptions.delete(runId);
    }

    for (const [key, buffer] of this.outputBuffers) {
      if (key.startsWith(runId + ':')) {
        clearTimeout(buffer.timer);
        this.outputBuffers.delete(key);
      }
    }

    this.pendingEvents.delete(runId);
    this.threadReady.delete(runId);
    for (const key of this.stepStartTimes.keys()) {
      if (key.startsWith(runId + ':')) this.stepStartTimes.delete(key);
    }
  }

  /** Get a specific agent's runtime */
  getAgentRuntime(agentId: string): AgentDiscordRuntime | undefined {
    return this.agentRuntimes.get(agentId);
  }

  /**
   * Send a direct message to a Discord user from an agent.
   */
  async sendDmToUser(agentId: string, userId: string, message: string, urgent: boolean = false): Promise<string> {
    const runtime = this.agentRuntimes.get(agentId);
    if (!runtime) {
      throw new Error(`No Discord runtime for agent ${agentId}`);
    }

    const client = runtime.getClient();
    const agent = this.config.agentRegistry.get(agentId);
    const emoji = agent?.identity?.emoji || '🤖';
    const prefix = urgent ? '🚨 **URGENT**\n' : '';
    const agentLine = `${emoji} **${agentId}**\n`;

    try {
      const user = await client.users.fetch(userId);
      const dmChannel = await user.createDM();
      const result = await dmChannel.send({
        content: `${prefix}${agentLine}${message}`.slice(0, 2000),
      });

      console.log(`[DiscordBridge] Agent ${agentId} sent DM to user ${userId}: "${message.slice(0, 50)}..."`);
      return result.id;
    } catch (err) {
      throw new Error(`Failed to send DM to user ${userId}: ${(err as Error).message}`);
    }
  }

  /** Get the thread manager */
  getThreadManager(): ThreadManager {
    return this.threadManager;
  }

  /**
   * Set the onBeforeTeardown callback after construction.
   */
  setOnBeforeTeardown(callback: (sessionId: string, agentId: string) => Promise<void>): void {
    this.config.onBeforeTeardown = callback;
    if (this.sessionPool) {
      (this.sessionPool as any).config.onBeforeTeardown = callback;
    }
    console.log('[DiscordBridge] onBeforeTeardown callback registered');
  }

  /**
   * Inject a ChatSessionManager after the bridge has started.
   */
  setChatSessionManager(csm: ChatSessionManager, defaultModel?: string): void {
    this.config.chatSessionManager = csm;
    if (defaultModel) this.config.defaultConversationModel = defaultModel;

    this.sessionPool = new DiscordSessionPool({
      chatSessionManager: csm,
      defaultModel: defaultModel ?? this.config.defaultDiscordDecisionModel ?? 'openrouter/minimax/minimax-m2.5',
      onBeforeTeardown: this.config.onBeforeTeardown,
    });

    // Inject pool into all running agent runtimes
    for (const runtime of this.agentRuntimes.values()) {
      (runtime as any).config.sessionPool = this.sessionPool;
    }

    this.registerSessionOutputHooks();
    console.log('[DiscordBridge] ChatSessionManager injected — conversation streaming enabled');
  }

  // ─── Config hot-reload ─────────────────────────────────────────────────

  /**
   * Subscribe to Redis for credential changes published by the API server.
   * When the dashboard updates Discord credentials for an agent, the API
   * publishes to `djinnbot:channel:credentials-changed` and we reload
   * the affected agent runtime (stop old → fetch new creds → start new).
   */
  private startConfigListener(): void {
    const redisUrl = this.config.redisUrl
      || process.env.REDIS_URL;
    if (!redisUrl) {
      console.warn('[DiscordBridge] No redisUrl configured — config hot-reload disabled');
      return;
    }

    this.configSubRedis = new Redis(redisUrl);
    this.configSubRedis.on('error', (err) => {
      console.error('[DiscordBridge] Config subscriber Redis error:', err.message);
    });

    this.configSubRedis.subscribe('djinnbot:channel:credentials-changed');
    console.log('[DiscordBridge] Listening for channel credential changes');

    this.configSubRedis.on('message', (_channel: string, raw: string) => {
      void (async () => {
        try {
          const data = JSON.parse(raw) as {
            agentId: string;
            channel: string;
            removed?: boolean;
          };

          // Only handle Discord credential changes
          if (data.channel !== 'discord') return;

          console.log(
            `[DiscordBridge] Credential change for ${data.agentId}/discord` +
              (data.removed ? ' (removed)' : ' (updated)'),
          );

          await this.reloadAgent(data.agentId, !!data.removed);
        } catch (err) {
          console.error('[DiscordBridge] Failed to process credential change event:', err);
        }
      })();
    });
  }

  /**
   * Reload a single agent's Discord runtime.
   *
   * 1. Stop the existing runtime (if any)
   * 2. Fetch fresh credentials from the DB via API
   * 3. Merge into registry
   * 4. Start a new runtime
   */
  private async reloadAgent(agentId: string, removed: boolean): Promise<void> {
    // Stop existing runtime
    const existing = this.agentRuntimes.get(agentId);
    if (existing) {
      console.log(`[DiscordBridge] Stopping existing runtime for ${agentId}...`);
      await existing.stop();
      this.agentRuntimes.delete(agentId);
      (this.threadManager as any).config.agentClients.delete(agentId);
    }

    if (removed) {
      console.log(`[DiscordBridge] Credentials removed for ${agentId} — runtime stopped`);
      return;
    }

    // Fetch fresh credentials from DB
    const apiBaseUrl = this.config.apiBaseUrl
      || process.env.DJINNBOT_API_URL
      || 'http://api:8000';

    try {
      const res = await authFetch(
        `${apiBaseUrl}/v1/agents/${agentId}/channels/keys/all`,
        { signal: AbortSignal.timeout(5000) },
      );
      if (!res.ok) {
        console.warn(`[DiscordBridge] Failed to fetch credentials for ${agentId}: HTTP ${res.status}`);
        return;
      }

      const data = await res.json() as {
        channels: Record<string, { primaryToken?: string; secondaryToken?: string; extra?: Record<string, string> }>;
      };

      const discordCreds = data.channels?.discord;
      if (!discordCreds?.primaryToken) {
        console.log(`[DiscordBridge] No Discord credentials for ${agentId} after reload — skipping`);
        return;
      }

      // Merge into registry
      const creds: ChannelCredentials = {
        primaryToken: discordCreds.primaryToken,
        ...(discordCreds.secondaryToken ? { secondaryToken: discordCreds.secondaryToken } : {}),
        ...(discordCreds.extra && Object.keys(discordCreds.extra).length > 0 ? { extra: discordCreds.extra } : {}),
      };
      this.config.agentRegistry.mergeChannelCredentials({
        [agentId]: { discord: creds },
      });

      // Start new runtime
      const agent = this.config.agentRegistry.get(agentId);
      if (!agent) {
        console.warn(`[DiscordBridge] Agent ${agentId} not found in registry`);
        return;
      }

      const runtime = new AgentDiscordRuntime({
        agent,
        defaultChannelId: this.config.defaultChannelId,
        onDecisionNeeded: this.config.onDecisionNeeded,
        onHumanGuidance: this.config.onHumanGuidance,
        onLoadPersona: this.config.onLoadPersona,
        onFeedback: this.config.onFeedback,
        defaultDiscordDecisionModel: this.config.defaultDiscordDecisionModel,
        sessionPool: this.sessionPool,
        isPipelineThread: (channelId: string, threadId: string) =>
          this.threadManager.isPipelineThread(channelId, threadId),
        onDiscordMessage: async (runId: string, message: DiscordMessageData) => {
          const discordMessageEvent: PipelineEvent = {
            type: 'DISCORD_MESSAGE',
            runId,
            agentId: message.agentId,
            agentName: message.agentName,
            agentEmoji: message.agentEmoji,
            userId: message.userId,
            userName: message.userName,
            message: message.message,
            isAgent: message.isAgent,
            channelId: message.channelId,
            messageId: message.messageId,
            timestamp: Date.now(),
          } as any;
          await this.config.eventBus.publish(runChannel(runId), discordMessageEvent);
        },
      });

      await runtime.start();
      this.agentRuntimes.set(agentId, runtime);
      (this.threadManager as any).config.agentClients.set(agentId, runtime.getClient());

      // Inject session pool if available
      if (this.sessionPool) {
        (runtime as any).config.sessionPool = this.sessionPool;
      }

      console.log(`[DiscordBridge] Agent ${agentId} reloaded successfully`);
    } catch (err) {
      console.error(`[DiscordBridge] Failed to reload agent ${agentId}:`, err);
    }
  }

  /**
   * Stop all agent runtimes and clean up.
   */
  async shutdown(): Promise<void> {
    for (const [, unsub] of this.eventSubscriptions) {
      unsub();
    }
    this.eventSubscriptions.clear();

    for (const [, buffer] of this.outputBuffers) {
      clearTimeout(buffer.timer);
    }
    this.outputBuffers.clear();

    this.configSubRedis?.disconnect();

    const stopPromises = Array.from(this.agentRuntimes.values()).map((r) => r.stop());
    await Promise.allSettled(stopPromises);
    this.agentRuntimes.clear();

    console.log('[DiscordBridge] Shutdown complete');
  }
}
