/**
 * SlackSessionPool — maps Slack conversation identities to persistent
 * ChatSessionManager sessions with idle-timeout container lifecycle.
 *
 * Instead of spinning up a fresh container for every Slack message
 * (the old onRunFullSession approach), this pool maintains long-lived
 * containers keyed by conversation identity:
 *
 *   DM (1:1):        slack_dm:{agentId}:{channelId}
 *   Channel thread:  slack_thread:{agentId}:{channelId}:{threadTs}
 *
 * When a message arrives:
 *   1. If a live session exists → sendMessage() directly (fast path, <1ms)
 *   2. If no session exists → assemble Slack thread history, start container,
 *      inject history, then sendMessage()
 *
 * Idle timeouts:
 *   DMs:             20 minutes (conversations feel persistent)
 *   Channel threads: 10 minutes (more bursty, lower priority)
 *
 * The pool does NOT manage pipeline run containers — those remain under
 * ContainerRunner's control via SlackBridge.
 */

import type { WebClient } from '@slack/web-api';
import type { ChatSessionManager } from '@djinnbot/core/chat';
import { SlackUserResolver } from './slack-user-resolver.js';

// ─── Types ────────────────────────────────────────────────────────────────────

export type SlackConversationSource = 'dm' | 'channel_thread';

export interface SlackSessionEntry {
  /** ChatSessionManager session ID */
  sessionId: string;
  agentId: string;
  source: SlackConversationSource;
  channelId: string;
  threadTs?: string;
  lastActiveAt: number;
  idleTimer: NodeJS.Timeout;
}

export interface SlackSessionPoolConfig {
  chatSessionManager: ChatSessionManager;
  /** Idle timeout for DM sessions in ms. Default: 20 minutes */
  dmIdleTimeoutMs?: number;
  /** Idle timeout for channel thread sessions in ms. Default: 10 minutes */
  threadIdleTimeoutMs?: number;
  /** Model to use when starting Slack sessions */
  defaultModel: string;
  /**
   * Base URL of the DjinnBot API server. Used by the Slack user resolver
   * to cross-reference Slack user IDs with DjinnBot user accounts.
   */
  apiBaseUrl?: string;
}

export interface SlackAttachmentMeta {
  id: string;
  filename: string;
  mimeType: string;
  sizeBytes: number;
  isImage: boolean;
  estimatedTokens?: number;
}

export interface SendMessageOptions {
  agentId: string;
  channelId: string;
  threadTs?: string;
  source: SlackConversationSource;
  message: string;
  /** The Slack user ID of the person sending the message (for context only) */
  userId?: string;
  userName?: string;
  /** Slack WebClient — used to fetch thread history on cold start */
  client: WebClient;
  /** The bot's own user ID — used to distinguish agent vs human in history */
  botUserId?: string;
  /** Message ID for DB persistence (optional) */
  messageId?: string;
  /** Model override for this session */
  model?: string;
  /** File attachments (already uploaded to DjinnBot storage) */
  attachments?: SlackAttachmentMeta[];
}

// ─── Pool ─────────────────────────────────────────────────────────────────────

export class SlackSessionPool {
  private sessions = new Map<string, SlackSessionEntry>();
  private config: SlackSessionPoolConfig;

  private readonly DM_IDLE_MS: number;
  private readonly THREAD_IDLE_MS: number;

  private userResolver: SlackUserResolver | null = null;

  constructor(config: SlackSessionPoolConfig) {
    this.config = config;
    this.DM_IDLE_MS = config.dmIdleTimeoutMs ?? 20 * 60 * 1000;
    this.THREAD_IDLE_MS = config.threadIdleTimeoutMs ?? 10 * 60 * 1000;
    // Create user resolver if API base URL is available
    const apiBaseUrl = config.apiBaseUrl
      || process.env.DJINNBOT_API_URL
      || null;
    if (apiBaseUrl) {
      this.userResolver = new SlackUserResolver(apiBaseUrl);
    }
  }

  // ─── Public API ─────────────────────────────────────────────────────────────

  /**
   * Send a message to a Slack conversation, creating a session if needed.
   * Returns the session ID that handled this message.
   */
  async sendMessage(opts: SendMessageOptions): Promise<string> {
    const key = this.sessionKey(opts.agentId, opts.source, opts.channelId, opts.threadTs);
    const existing = this.sessions.get(key);

    if (existing && this.config.chatSessionManager.isSessionActive(existing.sessionId)) {
      // Fast path — container is alive, just send the message
      this.resetIdleTimer(key, existing);
      await this.config.chatSessionManager.sendMessage(
        existing.sessionId,
        opts.message,
        opts.model ?? this.config.defaultModel,
        opts.messageId,
        opts.attachments,
      );
      return existing.sessionId;
    }

    // Cold start — need to create a new session
    if (existing) {
      // Stale entry — container was stopped by idle reaper or crashed
      clearTimeout(existing.idleTimer);
      this.sessions.delete(key);
    }

    // ── Slack user → DjinnBot user cross-reference ────────────────────────
    // Resolve the Slack user to a DjinnBot user ID for per-user key resolution.
    // If the Slack user isn't linked, send them an error message via Slack
    // and abort the session creation.
    let djinnbotUserId: string | undefined;
    if (this.userResolver && opts.userId) {
      const resolved = await this.userResolver.resolve(opts.userId);
      if (!resolved.userId && resolved.errorMessage) {
        // User not linked — send error message in thread and abort
        try {
          await opts.client.chat.postMessage({
            channel: opts.channelId,
            text: resolved.errorMessage,
            thread_ts: opts.threadTs,
          });
        } catch (err) {
          console.warn(`[SlackSessionPool] Failed to send user-not-linked message:`, err);
        }
        // Return a dummy session ID — no container started
        return `slack_unlinked_${Date.now()}`;
      }
      if (resolved.userId) {
        djinnbotUserId = resolved.userId;
        // Check if user has a provider key for the model
        const model = opts.model ?? this.config.defaultModel;
        const keyError = await this.userResolver.checkUserHasProviderKey(resolved.userId, model);
        if (keyError) {
          try {
            await opts.client.chat.postMessage({
              channel: opts.channelId,
              text: keyError,
              thread_ts: opts.threadTs,
            });
          } catch (err) {
            console.warn(`[SlackSessionPool] Failed to send no-provider-key message:`, err);
          }
          return `slack_nokey_${Date.now()}`;
        }
      }
    }

    // Pre-generate sessionId and register the entry SYNCHRONOUSLY before any
    // async work. This ensures getSessionLocation() can resolve the sessionId
    // immediately — critical for the SlackStreamer timing (the streamer is keyed
    // by sessionId and must be registered before the first output hook fires).
    const sessionId = `slack_${opts.source}_${opts.agentId}_${Date.now()}`;
    const idleTimeoutMs = opts.source === 'dm' ? this.DM_IDLE_MS : this.THREAD_IDLE_MS;

    const entry: SlackSessionEntry = {
      sessionId,
      agentId: opts.agentId,
      source: opts.source,
      channelId: opts.channelId,
      threadTs: opts.threadTs,
      lastActiveAt: Date.now(),
      idleTimer: this.createIdleTimer(key, sessionId, idleTimeoutMs),
    };
    this.sessions.set(key, entry);

    // Return sessionId immediately so the caller can register the streamer
    // before the async cold-start completes.
    this.coldStartAsync(key, sessionId, opts, djinnbotUserId).catch(err => {
      console.error(`[SlackSessionPool] coldStartAsync failed for ${sessionId}:`, err);
      clearTimeout(entry.idleTimer);
      this.sessions.delete(key);
    });

    return sessionId;
  }

  /**
   * Explicitly stop a session (e.g. user typed /stop or conversation is done).
   */
  async stopSession(agentId: string, source: SlackConversationSource, channelId: string, threadTs?: string): Promise<void> {
    const key = this.sessionKey(agentId, source, channelId, threadTs);
    const entry = this.sessions.get(key);
    if (!entry) return;

    clearTimeout(entry.idleTimer);
    this.sessions.delete(key);

    try {
      await this.config.chatSessionManager.stopSession(entry.sessionId);
    } catch (err) {
      console.warn(`[SlackSessionPool] Error stopping session ${entry.sessionId}:`, err);
    }
  }

  /**
   * Look up the Slack channel and thread for a given session ID.
   * Used by SlackBridge to route session output back to the right streamer.
   */
  getSessionLocation(sessionId: string): { agentId: string; channelId: string; threadTs: string } | undefined {
    for (const entry of this.sessions.values()) {
      if (entry.sessionId === sessionId) {
        return {
          agentId: entry.agentId,
          channelId: entry.channelId,
          // For DMs, use channelId as threadTs (Slack DM has no fixed thread root)
          threadTs: entry.threadTs ?? entry.channelId,
        };
      }
    }
    return undefined;
  }

  /**
   * Check if a session is currently alive and processing (container running).
   */
  isActive(agentId: string, source: SlackConversationSource, channelId: string, threadTs?: string): boolean {
    const key = this.sessionKey(agentId, source, channelId, threadTs);
    const entry = this.sessions.get(key);
    if (!entry) return false;
    return this.config.chatSessionManager.isSessionActive(entry.sessionId);
  }

  /**
   * Stop all active sessions (called on shutdown).
   */
  async shutdown(): Promise<void> {
    const entries = Array.from(this.sessions.values());
    for (const entry of entries) {
      clearTimeout(entry.idleTimer);
    }
    this.sessions.clear();
    // ChatSessionManager's own shutdown handles the underlying containers
  }

  // ─── Internal ────────────────────────────────────────────────────────────────

  private sessionKey(
    agentId: string,
    source: SlackConversationSource,
    channelId: string,
    threadTs?: string,
  ): string {
    if (source === 'dm') {
      return `slack_dm:${agentId}:${channelId}`;
    }
    return `slack_thread:${agentId}:${channelId}:${threadTs ?? ''}`;
  }

  /**
   * Async cold-start: assembles history, starts the ChatSessionManager session,
   * and sends the triggering message. Called fire-and-forget from sendMessage()
   * after the sessionId has already been pre-registered synchronously.
   */
  private async coldStartAsync(key: string, sessionId: string, opts: SendMessageOptions, djinnbotUserId?: string): Promise<void> {
    const idleTimeoutMs = opts.source === 'dm' ? this.DM_IDLE_MS : this.THREAD_IDLE_MS;

    console.log(
      `[SlackSessionPool] Cold start — key=${key} sessionId=${sessionId} (timeout=${idleTimeoutMs / 1000}s)`,
    );

    // Assemble thread history from Slack for context on resume
    let externalHistory: Array<{ role: string; content: string; created_at: number }> | undefined;
    if (opts.threadTs || opts.source === 'dm') {
      const assembled = await this.assembleThreadHistory(
        opts.client,
        opts.channelId,
        opts.threadTs ?? opts.channelId, // DM: use channelId as the "thread" root
        opts.botUserId,
        opts.agentId,
        opts.source,
      );

      // Sanity-check: only inject history that contains at least one assistant turn.
      // An all-user-message history (e.g. from a channel where the bot never
      // successfully responded) is degenerate — feeding it to the model causes it to
      // produce an empty completion immediately (it interprets the history as a
      // completed conversation). Better to start fresh than to poison the context.
      const hasAssistantTurn = assembled.some(m => m.role === 'assistant');
      if (hasAssistantTurn) {
        externalHistory = assembled;
      } else if (assembled.length > 0) {
        console.warn(
          `[SlackSessionPool] Discarding ${assembled.length}-message history for ${sessionId} — ` +
          `contains no assistant turns (bot may never have responded successfully in this channel). ` +
          `Starting fresh so the model is not poisoned by a degenerate context.`
        );
      }
    }

    await this.config.chatSessionManager.startSession({
      sessionId,
      agentId: opts.agentId,
      model: opts.model ?? this.config.defaultModel,
      externalHistory: externalHistory && externalHistory.length > 0 ? externalHistory : undefined,
      // Pass the DjinnBot user ID for per-user provider key resolution.
      // When set, the engine fetches API keys scoped to this user.
      userId: djinnbotUserId,
    });

    // Send the triggering message now that the container is ready
    await this.config.chatSessionManager.sendMessage(
      sessionId,
      opts.message,
      opts.model ?? this.config.defaultModel,
      opts.messageId,
      opts.attachments,
    );
  }

  private createIdleTimer(key: string, sessionId: string, idleTimeoutMs: number): NodeJS.Timeout {
    const timer = setTimeout(async () => {
      console.log(`[SlackSessionPool] Idle timeout for key=${key} sessionId=${sessionId}`);
      this.sessions.delete(key);
      try {
        await this.config.chatSessionManager.stopSession(sessionId);
      } catch (err) {
        console.warn(`[SlackSessionPool] Error during idle stop of ${sessionId}:`, err);
      }
    }, idleTimeoutMs);

    // Don't prevent Node from exiting if this is the only thing running
    timer.unref?.();
    return timer;
  }

  private resetIdleTimer(key: string, entry: SlackSessionEntry): void {
    const idleTimeoutMs = entry.source === 'dm' ? this.DM_IDLE_MS : this.THREAD_IDLE_MS;
    clearTimeout(entry.idleTimer);
    entry.idleTimer = this.createIdleTimer(key, entry.sessionId, idleTimeoutMs);
    entry.lastActiveAt = Date.now();
  }

  /**
   * Assemble conversation history from Slack thread messages.
   *
   * Fetches up to 50 recent messages from the thread via conversations.replies
   * (or conversations.history for DM channel roots) and maps them to the
   * { role, content, created_at } format expected by ChatSessionManager.
   *
   * Bot messages from THIS agent → role: 'assistant'
   * All other messages → role: 'user' (with speaker prefix for multi-user threads)
   */
  private async assembleThreadHistory(
    client: WebClient,
    channelId: string,
    threadTs: string,
    botUserId: string | undefined,
    agentId: string,
    source: SlackConversationSource,
  ): Promise<Array<{ role: string; content: string; created_at: number }>> {
    try {
      let messages: any[] = [];

      if (source === 'dm') {
        // For DMs, fetch the channel's recent message history (no thread_ts needed).
        // 100 messages gives good DM context; the 64 KB env var cap trims if needed.
        const result = await client.conversations.history({
          channel: channelId,
          limit: 100,
        });
        messages = result.messages ?? [];
        // conversations.history returns newest first — reverse for chronological order
        messages = [...messages].reverse();
      } else {
        // For channel threads, fetch the full thread history.
        // 200 covers most threads; truly enormous threads get trimmed by the
        // 64 KB env var cap in ChatSessionManager.startSession().
        const result = await client.conversations.replies({
          channel: channelId,
          ts: threadTs,
          limit: 200,
        });
        messages = result.messages ?? [];
      }

      if (messages.length === 0) return [];

      const history: Array<{ role: string; content: string; created_at: number }> = [];

      // Cache of user IDs → display names to avoid redundant API calls
      const nameCache = new Map<string, string>();

      for (const msg of messages) {
        if (!msg.text || !msg.text.trim()) continue;

        // Bot messages sent via chatStream (streaming API) have bot_id set but
        // msg.user is undefined — they never match a user-ID comparison.
        // Check both: if we know our botUserId, match on that; also treat any
        // message with bot_id and no human user field as an assistant message
        // (in a DM the only bot present is this agent, so this is safe).
        const isFromThisAgent = botUserId
          ? msg.user === botUserId || (!msg.user && !!msg.bot_id)
          : !!msg.bot_id;
        const tsNum = Math.floor(parseFloat(msg.ts ?? '0') * 1000);

        if (isFromThisAgent) {
          history.push({ role: 'assistant', content: msg.text, created_at: tsNum });
        } else {
          // Resolve human display name (best-effort, cached)
          let displayName = 'User';
          if (msg.user) {
            if (nameCache.has(msg.user)) {
              displayName = nameCache.get(msg.user)!;
            } else {
              try {
                const userInfo = await client.users.info({ user: msg.user });
                const u = userInfo.user as any;
                displayName = u?.real_name || u?.name || 'User';
                nameCache.set(msg.user, displayName);
              } catch {
                // Ignore — use 'User' fallback
              }
            }
          } else if (msg.bot_id) {
            // Message from a different bot in the thread
            displayName = msg.username || 'Agent';
          }

          // In multi-agent threads, prefix with speaker name for context
          const content = source === 'channel_thread' && displayName !== 'User'
            ? `${displayName}: ${msg.text}`
            : msg.text;

          history.push({ role: 'user', content, created_at: tsNum });
        }
      }

      console.log(
        `[SlackSessionPool] Assembled ${history.length} messages from Slack for ${agentId} in ${channelId}`,
      );
      return history;
    } catch (err) {
      console.warn(`[SlackSessionPool] Failed to assemble thread history:`, err);
      return [];
    }
  }
}
