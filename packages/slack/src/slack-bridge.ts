/**
 * SlackBridge — connects the pipeline event bus to Slack via agent runtimes.
 *
 * Subscribes to pipeline events and routes them to the appropriate agent's
 * Slack runtime for posting. Also manages the orchestrator's thread lifecycle.
 *
 * This is the top-level coordinator, NOT a routing layer for Slack events.
 * Each agent handles its own incoming Slack events independently.
 */

import { WebClient } from '@slack/web-api';
import {
  EventBus,
  runChannel,
  AgentRegistry,
  type AgentRegistryEntry,
  type PipelineEvent,
} from '@djinnbot/core';
import type { ChatSessionManager } from '@djinnbot/core/chat';
import { AgentSlackRuntime, type SlackMessageData } from './agent-slack-runtime.js';
import { ThreadManager } from './thread-manager.js';
import { SlackSessionPool } from './slack-session-pool.js';

/** Session context for persona loading */
export interface SessionContext {
  sessionType: 'slack' | 'pulse' | 'pipeline';
  runId?: string;
  channelContext?: string;
  installedTools?: string[];
}

export interface SlackBridgeConfig {
  eventBus: EventBus;
  agentRegistry: AgentRegistry;
  defaultChannelId?: string;
  /** Called when an agent needs to make an LLM decision about a Slack event */
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
  /**
   * ChatSessionManager for persistent Slack conversation sessions.
   * When provided, all DM and channel-thread conversations use pooled containers
   * with streaming responses. Replaces the old onRunFullSession approach.
   */
  chatSessionManager?: ChatSessionManager;
  /**
   * Default model for Slack conversation sessions.
   * Used by SlackSessionPool when starting new containers.
   */
  defaultConversationModel?: string;
  /**
   * @deprecated Use chatSessionManager instead.
   */
  onRunFullSession?: (opts: {
    agentId: string;
    systemPrompt: string;
    userPrompt: string;
    model: string;
    workspacePath?: string;
    vaultPath?: string;
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
    sessionContext: SessionContext
  ) => Promise<{ systemPrompt: string; identity: string; soul: string; agents: string; decision: string }>;
  /** Default model for Slack decisions when agent config is missing */
  defaultSlackDecisionModel?: string;
  /** User's Slack member ID for DMs from agents */
  userSlackId?: string;
  /**
   * Called when a user gives feedback (thumbs up/down) on an agent response.
   * The agent stores a lesson in its memory vault based on the feedback.
   */
  onFeedback?: (
    agentId: string,
    feedback: 'positive' | 'negative',
    responseText: string,
    userName: string,
  ) => Promise<void>;
  /**
   * Called just before a Slack conversation session container is torn down.
   * Typically wired to ChatSessionManager.triggerConsolidation() so the agent
   * can save meaningful memories from the conversation before the container exits.
   */
  onBeforeTeardown?: (sessionId: string, agentId: string) => Promise<void>;
}

/**
 * Extract readable plain text from a tool result string.
 * Container tools return JSON like {"content":[{"type":"text","text":"..."}]}.
 * We unwrap that to get the actual text; if it's not that shape we just truncate.
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
        return text.slice(0, maxLen) + (text.length > maxLen ? '…' : '');
      }
    }
  } catch {
    // Not JSON — fall through to raw truncation
  }
  return result.slice(0, maxLen) + (result.length > maxLen ? '…' : '');
}

export class SlackBridge {
  private config: SlackBridgeConfig;
  private agentRuntimes = new Map<string, AgentSlackRuntime>();
  private threadManager: ThreadManager;
  private sessionPool: SlackSessionPool | undefined;
  private eventSubscriptions = new Map<string, () => void>();
  private outputBuffers = new Map<string, { content: string; timer: NodeJS.Timeout }>();
  private thinkingBuffers = new Map<string, string>();
  private stepStartTimes = new Map<string, number>();
  private pendingEvents = new Map<string, PipelineEvent[]>();
  private threadReady = new Map<string, boolean>();
  /** Per-run Slack user ID for chatStream recipient (from project settings). */
  private runNotifyUserIds = new Map<string, string>();

  constructor(config: SlackBridgeConfig) {
    this.config = config;

    // Build per-agent WebClient map for thread creation
    const agentClients = new Map<string, WebClient>();
    for (const agent of config.agentRegistry.getAgentsByChannel('slack')) {
      const slackCreds = agent.channels.slack;
      if (slackCreds) {
        agentClients.set(agent.id, new WebClient(slackCreds.primaryToken));
      }
    }

    this.threadManager = new ThreadManager({
      defaultChannelId: config.defaultChannelId,
      agentClients,
    });

    // Build session pool if ChatSessionManager is available
    if (config.chatSessionManager) {
      this.sessionPool = new SlackSessionPool({
        chatSessionManager: config.chatSessionManager,
        defaultModel: config.defaultConversationModel ?? config.defaultSlackDecisionModel ?? 'openrouter/minimax/minimax-m2.5',
        onBeforeTeardown: config.onBeforeTeardown,
      });
    }
  }

  /**
   * Start all agent Slack runtimes (Socket Mode connections).
   */
  async start(): Promise<void> {
    const slackAgents = this.config.agentRegistry.getAgentsByChannel('slack');

    if (slackAgents.length === 0) {
      console.log('[SlackBridge] No agents with Slack credentials — bridge inactive');
      return;
    }

    console.log(
      `[SlackBridge] Starting ${slackAgents.length} agent Slack runtimes...`
    );

    for (const agent of slackAgents) {
      const creds = agent.channels.slack;
      const hasBotToken = !!creds?.primaryToken;
      const hasAppToken = !!creds?.secondaryToken;
      console.log(
        `[SlackBridge] Agent ${agent.id}: botToken=${hasBotToken ? 'present' : 'MISSING'}, appToken=${hasAppToken ? 'present' : 'MISSING'}`
      );
      if (!hasBotToken || !hasAppToken) {
        console.error(
          `[SlackBridge] Agent ${agent.id} is missing required Slack credentials — Socket Mode requires both botToken (primaryToken) and appToken (secondaryToken)`
        );
      }
    }

    // Start each agent's Socket Mode connection
    const startPromises = slackAgents.map(async (agent: any) => {
      try {
        const runtime = new AgentSlackRuntime({
          agent,
          defaultChannelId: this.config.defaultChannelId,
          onDecisionNeeded: this.config.onDecisionNeeded,
          onHumanGuidance: this.config.onHumanGuidance,
          onRunFullSession: this.config.onRunFullSession,
          onMemorySearch: this.config.onMemorySearch,
          onLoadPersona: this.config.onLoadPersona,
          onFeedback: this.config.onFeedback,
          defaultSlackDecisionModel: this.config.defaultSlackDecisionModel,
          sessionPool: this.sessionPool,
          // Check if a thread is a pipeline work thread (shared across all agents)
          isPipelineThread: (channelId: string, threadTs: string) => 
            this.threadManager.isPipelineThread(channelId, threadTs),
          onSlackMessage: async (runId: string, message: SlackMessageData) => {
            // Publish SLACK_MESSAGE event to the run channel
            const slackMessageEvent: PipelineEvent = {
              type: 'SLACK_MESSAGE',
              runId,
              agentId: message.agentId,
              agentName: message.agentName,
              agentEmoji: message.agentEmoji,
              userId: message.userId,
              userName: message.userName,
              message: message.message,
              isAgent: message.isAgent,
              threadTs: message.threadTs,
              messageTs: message.messageTs,
              timestamp: Date.now(),
            };
            await this.config.eventBus.publish(runChannel(runId), slackMessageEvent);
          },
        });

        await runtime.start();
        this.agentRuntimes.set(agent.id, runtime);
      } catch (err) {
        console.error(
          `[SlackBridge] Failed to start runtime for ${agent.id}:`,
          err
        );
      }
    });

    const results = await Promise.allSettled(startPromises);

    // Log any failures with details
    const failures = results.filter((r): r is PromiseRejectedResult => r.status === 'rejected');
    if (failures.length > 0) {
      console.error(
        `[SlackBridge] ${failures.length}/${slackAgents.length} agent runtimes FAILED to start:`
      );
      failures.forEach((f, i) => {
        console.error(`[SlackBridge]   ${i + 1}. ${f.reason?.message || f.reason}`);
      });
    }

    console.log(
      `[SlackBridge] ${this.agentRuntimes.size}/${slackAgents.length} agent runtimes started successfully`
    );

    // Register output hooks for conversation sessions if ChatSessionManager is available
    if (this.config.chatSessionManager && this.sessionPool) {
      this.registerSessionOutputHooks();
    }
  }

  /**
   * Register event hooks with ChatSessionManager so conversation session output
   * (text chunks, tool calls, step completion) flows into the active SlackStreamer
   * for the corresponding channel/thread.
   *
   * ChatSessionManager publishes events to Redis pub/sub. We hook into those
   * events here and route them to the correct AgentSlackRuntime's active streamer.
   */
  private registerSessionOutputHooks(): void {
    const csm = this.config.chatSessionManager!;

    csm.registerHooks({
      onOutput: (sessionId: string, chunk: string) => this.routeSessionChunk(sessionId, chunk),
      onToolStart: (sessionId: string, toolName: string, args: Record<string, unknown>) => this.routeSessionToolStart(sessionId, toolName, args),
      onToolEnd: (sessionId: string, toolName: string, result: string, isError: boolean, durationMs: number) =>
        this.routeSessionToolEnd(sessionId, toolName, result, isError, durationMs),
      onStepEnd: (sessionId: string, success: boolean) => { void this.routeSessionStepEnd(sessionId, success); },
    });
  }

  /**
   * Route a text chunk from a conversation session into the active streamer.
   * Finds the runtime that owns the session and pipes the chunk in.
   *
   * If findRuntimeForSession returns undefined it almost certainly means the
   * sessionId emitted by ChatSessionManager does not match the one we
   * pre-registered in SlackSessionPool. This would happen if startSession()
   * ignores the provided sessionId and generates its own. The warning below
   * makes that failure loud rather than silently dropping all output.
   */
  private routeSessionChunk(sessionId: string, chunk: string): void {
    // Only Slack-originated sessions (slack_*) are routed through Slack.
    // All other sessions (onb_*, chat_*, etc.) are silently ignored.
    if (!sessionId.startsWith('slack_')) return;

    const location = this.findRuntimeForSession(sessionId);
    if (!location) {
      console.warn(
        `[SlackBridge] routeSessionChunk: no runtime found for sessionId="${sessionId}". ` +
        `This likely means ChatSessionManager is not using the sessionId provided to startSession(). ` +
        `Registered pool sessions: ${this.sessionPool ? [...(this.sessionPool as any).sessions?.keys?.() ?? []].join(', ') : 'none'}`
      );
      return;
    }
    const streamer = location.runtime.getConvStreamer(sessionId);
    if (!streamer) {
      console.warn(`[SlackBridge] routeSessionChunk: runtime found for "${sessionId}" but no active streamer`);
      return;
    }
    streamer.appendText(chunk).catch(err =>
      console.warn(`[SlackBridge] appendText failed for ${sessionId}:`, err)
    );

    // Accumulate text for TTS generation on voice sessions
    if (this.sessionPool?._voiceSessions?.has(sessionId)) {
      const existing = this.sessionAccumulatedText.get(sessionId) || '';
      this.sessionAccumulatedText.set(sessionId, existing + chunk);
    }
  }

  // Per-session counter for unique tool call task card IDs.
  // Keyed by sessionId, value is a monotonic counter per turn.
  private toolCallCounters = new Map<string, number>();
  // Maps sessionId -> stack of in-progress tool card IDs (LIFO — tools don't nest but stack covers rapid sequential calls).
  private activeToolCardIds = new Map<string, string[]>();

  private routeSessionToolStart(sessionId: string, toolName: string, args: Record<string, unknown>): void {
    const runtime = this.findRuntimeForSession(sessionId)?.runtime;
    if (!runtime) return;
    const streamer = runtime.getConvStreamer(sessionId);
    if (!streamer) return;

    // Generate a unique card ID per call so two bash calls don't share an ID.
    const count = (this.toolCallCounters.get(sessionId) ?? 0) + 1;
    this.toolCallCounters.set(sessionId, count);
    const cardId = `${sessionId}:${toolName}:${count}`;

    // Push onto the active stack so toolEnd can pop it
    const stack = this.activeToolCardIds.get(sessionId) ?? [];
    stack.push(cardId);
    this.activeToolCardIds.set(sessionId, stack);

    const argSummary = Object.entries(args)
      .slice(0, 3)
      .map(([k, v]) => `${k}: ${String(v).slice(0, 60)}`)
      .join(', ');
    streamer.updateTask(cardId, toolName, 'in_progress', argSummary || undefined).catch(() => {});
  }

  private routeSessionToolEnd(sessionId: string, toolName: string, result: string, isError: boolean, _durationMs: number): void {
    const runtime = this.findRuntimeForSession(sessionId)?.runtime;
    if (!runtime) return;
    const streamer = runtime.getConvStreamer(sessionId);
    if (!streamer) return;

    // Pop the most recent card ID for this session (matches the last toolStart)
    const stack = this.activeToolCardIds.get(sessionId) ?? [];
    const cardId = stack.pop() ?? `${sessionId}:${toolName}:0`;
    if (stack.length === 0) {
      this.activeToolCardIds.delete(sessionId);
    } else {
      this.activeToolCardIds.set(sessionId, stack);
    }

    const status = isError ? 'error' : 'complete';
    // Extract plain text from tool result JSON if possible, otherwise truncate raw string.
    const output = extractToolResultText(result, 200);
    streamer.updateTask(cardId, toolName, status, undefined, output).catch(() => {});
  }

  // Accumulated text per session for TTS generation
  private sessionAccumulatedText = new Map<string, string>();

  private async routeSessionStepEnd(sessionId: string, success: boolean): Promise<void> {
    const location = this.findRuntimeForSession(sessionId);
    if (!location) return;
    const { runtime, channelId, threadTs } = location;
    const streamer = runtime.getConvStreamer(sessionId);

    if (!streamer) {
      // No streamer found — this shouldn't happen normally but handle gracefully
      console.warn(`[SlackBridge] routeSessionStepEnd: no streamer for ${sessionId}`);
      return;
    }

    if (streamer.currentState === 'streaming') {
      // Normal path: stream is active, finalise it
      if (success) {
        await streamer.stop({ includeFeedback: true });
      } else {
        await streamer.stopWithError('Something went wrong. Please try again.');
      }
    } else {
      // chatStream never started (e.g. DM surface, API unavailable, or error on start).
      // The streamer's stop()/stopWithError() method handles posting the accumulated
      // plainTextBuffer via chat.postMessage as a fallback.
      if (success) {
        await streamer.stop({ includeFeedback: false });
      } else {
        await streamer.stopWithError('Something went wrong with my response. Please try again.');
      }
    }

    // Generate TTS follow-up for voice message sessions
    const isVoiceSession = this.sessionPool?._voiceSessions?.has(sessionId);
    if (success && isVoiceSession) {
      this.sessionPool!._voiceSessions.delete(sessionId);
      const responseText = this.sessionAccumulatedText.get(sessionId) || '';
      this.sessionAccumulatedText.delete(sessionId);

      if (responseText.length > 0) {
        void this.sendTtsFollowUp(sessionId, responseText, runtime, channelId, threadTs);
      }
    } else {
      this.sessionAccumulatedText.delete(sessionId);
    }

    runtime.removeConvStreamer(sessionId);

    // Clean up per-session tool call tracking state
    this.toolCallCounters.delete(sessionId);
    this.activeToolCardIds.delete(sessionId);
  }

  /**
   * Generate TTS audio and post as a Slack file in the thread.
   * Fire-and-forget — errors are logged but don't break the response flow.
   */
  private async sendTtsFollowUp(
    sessionId: string,
    text: string,
    runtime: AgentSlackRuntime,
    channelId: string,
    threadTs: string,
  ): Promise<void> {
    try {
      const apiBaseUrl = (this.sessionPool as any)?.config?.apiBaseUrl
        || process.env.DJINNBOT_API_URL
        || 'http://api:8000';
      const agentId = sessionId.split('_')[1] || 'unknown';

      const { authFetch } = await import('@djinnbot/core');
      const res = await authFetch(`${apiBaseUrl}/v1/internal/tts/synthesize`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          text,
          agent_id: agentId,
          session_id: sessionId,
          channel: 'slack',
        }),
      });

      if (!res.ok) return;
      const data = await res.json() as { ok: boolean; attachmentId?: string; filename?: string };
      if (!data.ok || !data.attachmentId) return;

      // Download the audio
      const audioRes = await authFetch(
        `${apiBaseUrl}/v1/chat/attachments/${data.attachmentId}/content`,
        { signal: AbortSignal.timeout(10000) },
      );
      if (!audioRes.ok) return;

      const audioBuffer = Buffer.from(await audioRes.arrayBuffer());

      // Upload to Slack and post in thread
      const client = runtime.getClient();
      if (client) {
        await client.filesUploadV2({
          channel_id: channelId,
          thread_ts: threadTs,
          file: audioBuffer,
          filename: data.filename || 'voice_response.mp3',
          title: 'Voice Response',
        });
        console.log(`[SlackBridge] TTS audio posted to thread ${threadTs}`);
      }
    } catch (err) {
      console.warn(`[SlackBridge] TTS follow-up failed (non-fatal):`, err);
    }
  }

  /**
   * Find the AgentSlackRuntime that owns a specific pipeline step.
   * Searches all runtimes for one that has this runId+stepId as an active step.
   */
  private findRuntimeForStep(runId: string, stepId: string): AgentSlackRuntime | undefined {
    for (const [, runtime] of this.agentRuntimes) {
      const steps = runtime.getActiveSteps();
      if (steps.some(s => s.runId === runId && s.stepId === stepId)) {
        return runtime;
      }
    }
    return undefined;
  }

  /**
   * Map a ChatSessionManager session ID back to its runtime + channel/thread.
   * Uses the session pool to look up the Slack location, then finds the
   * matching AgentSlackRuntime by agentId.
   */
  private findRuntimeForSession(sessionId: string): { runtime: AgentSlackRuntime; channelId: string; threadTs: string } | undefined {
    if (!this.sessionPool) return undefined;

    const location = this.sessionPool.getSessionLocation(sessionId);
    if (!location) return undefined;

    const runtime = this.agentRuntimes.get(location.agentId);
    if (!runtime) return undefined;

    return { runtime, channelId: location.channelId, threadTs: location.threadTs };
  }

  /**
   * Subscribe to pipeline events for a specific run.
   * Routes events to the appropriate agent's Slack runtime.
   *
   * @param slackChannelId  Optional project-level Slack channel override.
   *   When provided, the run thread is created in this channel instead of
   *   the global defaultChannelId.
   * @param slackNotifyUserId  Optional Slack user ID set as recipient_user_id
   *   for chatStream streaming in channel threads.
   */
  subscribeToRun(
    runId: string,
    pipelineId: string,
    taskDescription: string,
    assignedAgentIds: string[],
    slackChannelId?: string,
    slackNotifyUserId?: string,
  ): void {
    if (this.eventSubscriptions.has(runId)) return;

    // ── Guard: require project-level Slack config ────────────────────────
    // Both channel and user must be explicitly set on the project.
    // Without them we skip Slack entirely rather than falling back to the
    // global defaultChannelId — that channel is for interactive DMs, not
    // pipeline run output.
    if (!slackChannelId || !slackNotifyUserId) {
      const missing = [
        !slackChannelId && 'slack_channel_id',
        !slackNotifyUserId && 'slack_notify_user_id',
      ].filter(Boolean).join(', ');
      console.warn(
        `[SlackBridge] Skipping Slack thread for run ${runId}: ` +
        `project is missing ${missing}. ` +
        `Configure Slack settings in Project Settings > Slack Notifications.`
      );
      return;
    }

    // Store the notify user ID so handlePipelineEvent can pass it to startStepStream
    this.runNotifyUserIds.set(runId, slackNotifyUserId);

    // Initialize pending queue — events arrive before thread is ready
    this.pendingEvents.set(runId, []);
    this.threadReady.set(runId, false);

    const channel = runChannel(runId);
    const unsub = this.config.eventBus.subscribe(channel, async (event: any) => {
      if (!this.threadReady.get(event.runId)) {
        // Queue until thread is created
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
        channelId: slackChannelId,
      })
      .then(async () => {
        this.threadReady.set(runId, true);
        // Flush queued events
        const queued = this.pendingEvents.get(runId) || [];
        this.pendingEvents.delete(runId);
        console.log(`[SlackBridge] Thread ready for ${runId}, flushing ${queued.length} queued events`);
        for (const event of queued) {
          await this.handlePipelineEvent(event);
        }
      })
      .catch((err) =>
        console.error(
          `[SlackBridge] Failed to create run thread for ${runId}:`,
          err
        )
      );
  }

  /**
   * Handle a pipeline event by routing to the appropriate agent.
   */
  private async handlePipelineEvent(event: PipelineEvent): Promise<void> {
    // Skip events that don't have a runId (system-level events)
    if (!('runId' in event)) return;
    
    const thread = this.threadManager.getThread(event.runId);
    if (!thread) return; // No Slack thread for this run

    switch (event.type) {
      case 'STEP_QUEUED': {
        const runtime = this.agentRuntimes.get(event.agentId);
        if (!runtime) break;

        const agentEntry = this.config.agentRegistry.get(event.agentId);
        const agentName = agentEntry
          ? `${agentEntry.identity.emoji} ${agentEntry.identity.name}`
          : event.agentId;

        // Register this step in the agent's work context
        runtime.addActiveStep({
          runId: event.runId,
          stepId: event.stepId,
          pipelineId: thread.pipelineId,
          status: 'working',
          threadTs: thread.threadTs,
          channelId: thread.channelId,
          taskSummary: thread.taskDescription,
        });

        // Track step start time
        this.stepStartTimes.set(`${event.runId}:${event.stepId}`, Date.now());

        // Start a live streaming message for this step
        try {
          const recipientUserId = this.runNotifyUserIds.get(event.runId);
          const streamer = await runtime.startStepStream(
            event.runId,
            event.stepId,
            thread.channelId,
            thread.threadTs,
            recipientUserId,
          );
          // Set the typing indicator
          await streamer.setStatus(`${agentName} is working on ${event.stepId}...`);
          // Open the stream with the initial plan title
          await streamer.start();
          await streamer.updatePlanTitle(`${agentName}: ${event.stepId}`);
          await streamer.updateTask(event.stepId, event.stepId, 'in_progress');
        } catch (err) {
          console.warn(`[SlackBridge] Failed to start step stream for ${event.stepId}:`, err);
          // Fall back to plain message
          await runtime.postToThread(
            thread.channelId, thread.threadTs,
            `⏳ *${agentName}* picking up *${event.stepId}*`,
            undefined, event.runId
          );
        }
        break;
      }

      case 'STEP_OUTPUT': {
        // Pipe text output into the active streamer for this step
        const runtime = this.findRuntimeForStep(event.runId, event.stepId);
        const streamer = runtime?.getStepStreamer(event.runId, event.stepId);
        if (streamer) {
          await streamer.appendText(event.chunk);
        } else {
          // Fallback: buffer for eventual plain-text post
          const bufferKey = `${event.runId}:${event.stepId}`;
          const existing = this.outputBuffers.get(bufferKey);
          if (existing) {
            existing.content += event.chunk;
          } else {
            this.outputBuffers.set(bufferKey, {
              content: event.chunk,
              timer: setTimeout(() => {
                this.flushOutputBuffer(bufferKey, event.runId, event.stepId);
              }, 2000),
            });
          }
        }
        break;
      }

      case 'TOOL_CALL_START': {
        // Show the tool call as an in-progress task card
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
          await streamer.updateTask(
            event.toolCallId,
            event.toolName,
            'in_progress',
            argSummary || undefined,
          );
        }
        break;
      }

      case 'TOOL_CALL_END': {
        // Mark the tool call task card as complete or error
        const runtime = this.findRuntimeForStep(event.runId, event.stepId);
        const streamer = runtime?.getStepStreamer(event.runId, event.stepId);
        if (streamer) {
          const status = event.isError ? 'error' : 'complete';
          const output = event.result.slice(0, 200) + (event.result.length > 200 ? '…' : '');
          await streamer.updateTask(event.toolCallId, event.toolName, status, undefined, output);
        }
        break;
      }

      case 'STEP_THINKING': {
        // Buffer thinking silently — don't expose raw thinking in the stream
        const thinkingKey = `${event.runId}:${event.stepId}:thinking`;
        const existing = this.thinkingBuffers.get(thinkingKey) || '';
        this.thinkingBuffers.set(thinkingKey, existing + event.chunk);
        break;
      }

      case 'STEP_COMPLETE': {
        const completingRuntime = this.findRuntimeForStep(event.runId, event.stepId);
        if (completingRuntime) {
          const agentEntry = this.config.agentRegistry.get(completingRuntime.agentId);
          const agentName = agentEntry
            ? `${agentEntry.identity.emoji} ${agentEntry.identity.name}`
            : completingRuntime.agentId;

          const startKey = `${event.runId}:${event.stepId}`;
          const startTime = this.stepStartTimes.get(startKey);
          const duration = startTime ? Math.round((Date.now() - startTime) / 1000) : 0;
          this.stepStartTimes.delete(startKey);

          const outputEntries = Object.entries(event.outputs).filter(([k, v]) => k !== 'status' && v);
          const outputSummary = outputEntries.map(([k, v]) => `**${k}:** ${String(v).slice(0, 200)}`).join('\n');

          const streamer = completingRuntime.getStepStreamer(event.runId, event.stepId);
          if (streamer) {
            // Mark the step task card as complete
            await streamer.updateTask(event.stepId, event.stepId, 'complete', undefined,
              duration ? `Completed in ${duration}s` : undefined);
            // Append output summary as final text
            if (outputSummary) await streamer.appendText(`\n\n${outputSummary}`);
            // Stop with feedback buttons
            await streamer.stop({ includeFeedback: true });
            completingRuntime.removeStepStreamer(event.runId, event.stepId);
          } else {
            // Fallback: flush buffer + post Block Kit message
            const bufferKey = `${event.runId}:${event.stepId}`;
            this.flushOutputBuffer(bufferKey, event.runId, event.stepId);
            const fallbackText = `✅ ${agentName} completed ${event.stepId}${duration ? ` in ${duration}s` : ''}`;
            await completingRuntime.postToThread(thread.channelId, thread.threadTs, fallbackText, undefined, event.runId);
          }

          // Clean up thinking buffer
          this.thinkingBuffers.delete(`${event.runId}:${event.stepId}:thinking`);
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
          const retryNote = event.retryCount > 0 ? ` (attempt ${event.retryCount + 1})` : '';

          const streamer = failedRuntime.getStepStreamer(event.runId, event.stepId);
          if (streamer) {
            await streamer.stopWithError(
              `${agentName} failed on ${event.stepId}${retryNote}${duration ? ` after ${duration}s` : ''}: ${event.error.slice(0, 300)}`
            );
            failedRuntime.removeStepStreamer(event.runId, event.stepId);
          } else {
            await failedRuntime.postToThread(
              thread.channelId, thread.threadTs,
              `❌ ${agentName} failed on ${event.stepId}${retryNote}`,
              [
                { type: 'section', text: { type: 'mrkdwn', text: `❌ *${agentName}* failed on *${event.stepId}*${retryNote}${duration ? ` after ${duration}s` : ''}` } },
                { type: 'section', text: { type: 'mrkdwn', text: `\`\`\`${event.error.slice(0, 2900)}\`\`\`` } },
                { type: 'context', elements: [{ type: 'mrkdwn', text: 'Reply in this thread to provide guidance' }] },
              ],
              event.runId
            );
          }

          this.thinkingBuffers.delete(`${event.runId}:${event.stepId}:thinking`);
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
        await this.threadManager.updateRunStatus(
          event.runId,
          'failed',
          event.error
        );
        this.cleanupRun(event.runId);
        break;
      }

      // Ignore other events
      default:
        break;
    }
  }

  /**
   * Flush buffered output to Slack.
   */
  private async flushOutputBuffer(
    bufferKey: string,
    runId: string,
    stepId: string
  ): Promise<void> {
    const buffer = this.outputBuffers.get(bufferKey);
    if (!buffer) return;

    clearTimeout(buffer.timer);
    this.outputBuffers.delete(bufferKey);

    if (!buffer.content.trim()) return;

    const thread = this.threadManager.getThread(runId);
    if (!thread) return;

    // Find the agent working on this step
    for (const [, runtime] of this.agentRuntimes) {
      const steps = runtime.getActiveSteps();
      if (steps.some((s) => s.runId === runId && s.stepId === stepId)) {
        // Truncate if too long for Slack
        const content =
          buffer.content.length > 3000
            ? buffer.content.slice(0, 3000) + '\n... (truncated)'
            : buffer.content;

        await runtime.postToThread(
          thread.channelId,
          thread.threadTs,
          `\`\`\`${content}\`\`\``,
          undefined,
          runId
        );
        break;
      }
    }
  }

  /**
   * Cleanup after a run finishes.
   */
  private cleanupRun(runId: string): void {
    const unsub = this.eventSubscriptions.get(runId);
    if (unsub) {
      unsub();
      this.eventSubscriptions.delete(runId);
    }

    // Clean up any remaining output buffers for this run
    for (const [key, buffer] of this.outputBuffers) {
      if (key.startsWith(runId + ':')) {
        clearTimeout(buffer.timer);
        this.outputBuffers.delete(key);
      }
    }

    // Clean up tracking state
    this.pendingEvents.delete(runId);
    this.threadReady.delete(runId);
    this.runNotifyUserIds.delete(runId);
    for (const key of this.thinkingBuffers.keys()) {
      if (key.startsWith(runId + ':')) this.thinkingBuffers.delete(key);
    }
    for (const key of this.stepStartTimes.keys()) {
      if (key.startsWith(runId + ':')) this.stepStartTimes.delete(key);
    }
  }

  /** Get a specific agent's runtime */
  getAgentRuntime(agentId: string): AgentSlackRuntime | undefined {
    return this.agentRuntimes.get(agentId);
  }

  /**
   * Send a direct message to the user from an agent.
   * Uses the agent's Slack client (bot token) to send the DM.
   */
  async sendDmToUser(agentId: string, message: string, urgent: boolean = false): Promise<string> {
    if (!this.config.userSlackId) {
      console.warn(`[SlackBridge] Agent ${agentId} tried to DM user but userSlackId is not configured`);
      throw new Error('User Slack ID not configured — set it in Settings → Slack in the dashboard');
    }

    const runtime = this.agentRuntimes.get(agentId);
    if (!runtime) {
      // Fall back to first available agent's client
      const firstRuntime = this.agentRuntimes.values().next().value;
      if (!firstRuntime) {
        throw new Error('No agent runtimes available - cannot send DM');
      }
    }

    // Get agent config for emoji (from identity, not slack credentials)
    const agent = this.config.agentRegistry.get(agentId);
    const emoji = agent?.identity?.emoji || '🤖';
    const prefix = urgent ? '🚨 *URGENT*\n' : '';
    const agentLine = `${emoji} *${agentId}*\n`;

    // Use the agent's bot token to send the DM
    const slackCreds = agent?.channels.slack;
    if (!slackCreds?.primaryToken) {
      throw new Error(`Agent ${agentId} has no Slack bot token configured`);
    }

    const client = new WebClient(slackCreds.primaryToken);

    // Open DM channel with user
    const openResponse = await client.conversations.open({
      users: this.config.userSlackId,
    });

    if (!openResponse.ok || !openResponse.channel?.id) {
      throw new Error(`Failed to open DM channel with user: ${openResponse.error}`);
    }

    const channelId = openResponse.channel.id;

    // Send the message
    const response = await client.chat.postMessage({
      channel: channelId,
      text: `${prefix}${agentLine}${message}`,
    });

    if (!response.ok || !response.ts) {
      throw new Error(`Failed to send DM to user: ${response.error}`);
    }

    console.log(`[SlackBridge] Agent ${agentId} sent DM to user: "${message.slice(0, 50)}..."`);
    return response.ts;
  }

  /** Get the thread manager */
  getThreadManager(): ThreadManager {
    return this.threadManager;
  }

  /**
   * Inject a ChatSessionManager after the bridge has started.
   * Called from main.ts after chat sessions are initialized (which happens
   * after the Slack bridge starts). Creates the session pool and registers
   * output hooks for conversation streaming.
   */
  /**
   * Set the onBeforeTeardown callback after construction.
   * Called from the engine after ChatSessionManager is injected and the pool
   * has been created. Updates both the config (for future pool recreations) and
   * the live session pool instance.
   */
  setOnBeforeTeardown(callback: (sessionId: string, agentId: string) => Promise<void>): void {
    this.config.onBeforeTeardown = callback;
    if (this.sessionPool) {
      // Patch the live pool's config directly — the pool reads it on each teardown
      (this.sessionPool as any).config.onBeforeTeardown = callback;
    }
    console.log('[SlackBridge] onBeforeTeardown callback registered for memory consolidation');
  }

  setChatSessionManager(csm: ChatSessionManager, defaultModel?: string): void {
    this.config.chatSessionManager = csm;
    if (defaultModel) this.config.defaultConversationModel = defaultModel;

    this.sessionPool = new SlackSessionPool({
      chatSessionManager: csm,
      defaultModel: defaultModel ?? this.config.defaultSlackDecisionModel ?? 'openrouter/minimax/minimax-m2.5',
      onBeforeTeardown: this.config.onBeforeTeardown,
    });

    // Inject pool into all running agent runtimes
    for (const runtime of this.agentRuntimes.values()) {
      (runtime as any).config.sessionPool = this.sessionPool;
    }

    // Register output hooks
    this.registerSessionOutputHooks();

    console.log('[SlackBridge] ChatSessionManager injected — conversation streaming enabled');
  }

  /**
   * Stop all agent runtimes and clean up.
   */
  async shutdown(): Promise<void> {
    // Unsubscribe from all events
    for (const [, unsub] of this.eventSubscriptions) {
      unsub();
    }
    this.eventSubscriptions.clear();

    // Clear output buffers
    for (const [, buffer] of this.outputBuffers) {
      clearTimeout(buffer.timer);
    }
    this.outputBuffers.clear();

    // Stop all agent runtimes
    const stopPromises = Array.from(this.agentRuntimes.values()).map((r) =>
      r.stop()
    );
    await Promise.allSettled(stopPromises);
    this.agentRuntimes.clear();

    console.log('[SlackBridge] Shutdown complete');
  }
}
