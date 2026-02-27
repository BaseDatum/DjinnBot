/**
 * DiscordSessionPool — maps Discord conversation identities to persistent
 * ChatSessionManager sessions with idle-timeout container lifecycle.
 *
 * Mirrors SlackSessionPool exactly but for Discord conversations:
 *
 *   DM (1:1):           discord_dm:{agentId}:{userId}
 *   Guild thread/channel: discord_thread:{agentId}:{channelId}:{threadId}
 *
 * When a message arrives:
 *   1. If a live session exists → sendMessage() directly (fast path)
 *   2. If no session exists → assemble Discord message history, start container,
 *      inject history, then sendMessage()
 *
 * Idle timeouts:
 *   DMs:             20 minutes
 *   Guild threads:   10 minutes
 */

import type { Client, TextChannel, DMChannel, Message } from 'discord.js';
import type { ChatSessionManager } from '@djinnbot/core/chat';
import { DiscordUserResolver } from './discord-user-resolver.js';

// ─── Types ────────────────────────────────────────────────────────────────────

export type DiscordConversationSource = 'dm' | 'guild_thread';

export interface DiscordSessionEntry {
  /** ChatSessionManager session ID */
  sessionId: string;
  agentId: string;
  source: DiscordConversationSource;
  channelId: string;
  threadId?: string;
  lastActiveAt: number;
  idleTimer: NodeJS.Timeout;
}

export interface DiscordSessionPoolConfig {
  chatSessionManager: ChatSessionManager;
  /** Idle timeout for DM sessions in ms. Default: 20 minutes */
  dmIdleTimeoutMs?: number;
  /** Idle timeout for guild thread sessions in ms. Default: 10 minutes */
  threadIdleTimeoutMs?: number;
  /** Model to use when starting Discord sessions */
  defaultModel: string;
  /** Base URL of the DjinnBot API server */
  apiBaseUrl?: string;
  /**
   * Called just before a session container is torn down (idle timeout or explicit stop).
   * Use this to trigger memory consolidation.
   */
  onBeforeTeardown?: (sessionId: string, agentId: string) => Promise<void>;
}

export interface DiscordAttachmentMeta {
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
  threadId?: string;
  source: DiscordConversationSource;
  message: string;
  /** The Discord user ID of the person sending the message */
  userId?: string;
  userName?: string;
  /** Discord Client — used to fetch message history on cold start */
  client: Client;
  /** The bot's own user ID — used to distinguish agent vs human in history */
  botUserId?: string;
  /** Model override for this session */
  model?: string;
  /** File attachments (already uploaded to DjinnBot storage) */
  attachments?: DiscordAttachmentMeta[];
}

// ─── Pool ─────────────────────────────────────────────────────────────────────

export class DiscordSessionPool {
  private sessions = new Map<string, DiscordSessionEntry>();
  private config: DiscordSessionPoolConfig;

  private readonly DM_IDLE_MS: number;
  private readonly THREAD_IDLE_MS: number;

  private userResolver: DiscordUserResolver | null = null;

  constructor(config: DiscordSessionPoolConfig) {
    this.config = config;
    this.DM_IDLE_MS = config.dmIdleTimeoutMs ?? 20 * 60 * 1000;
    this.THREAD_IDLE_MS = config.threadIdleTimeoutMs ?? 10 * 60 * 1000;

    const apiBaseUrl = config.apiBaseUrl
      || process.env.DJINNBOT_API_URL
      || null;
    if (apiBaseUrl) {
      this.userResolver = new DiscordUserResolver(apiBaseUrl);
    }
  }

  // ─── Public API ─────────────────────────────────────────────────────────────

  /**
   * Send a message to a Discord conversation, creating a session if needed.
   * Returns the session ID that handled this message.
   */
  async sendMessage(opts: SendMessageOptions): Promise<string> {
    const key = this.sessionKey(opts.agentId, opts.source, opts.channelId, opts.threadId);
    const existing = this.sessions.get(key);

    if (existing && this.config.chatSessionManager.isSessionActive(existing.sessionId)) {
      // Fast path — container is alive
      this.resetIdleTimer(key, existing);
      await this.config.chatSessionManager.sendMessage(
        existing.sessionId,
        opts.message,
        opts.model ?? this.config.defaultModel,
        undefined,
        opts.attachments,
      );
      return existing.sessionId;
    }

    // Cold start
    if (existing) {
      clearTimeout(existing.idleTimer);
      this.sessions.delete(key);
    }

    // ── Discord user → DjinnBot user cross-reference ────────────────────
    let djinnbotUserId: string | undefined;
    if (this.userResolver && opts.userId) {
      const resolved = await this.userResolver.resolve(opts.userId);
      if (!resolved.userId && resolved.errorMessage) {
        // User not linked — send error message and abort
        try {
          const channel = await opts.client.channels.fetch(opts.channelId);
          if (channel && 'send' in channel) {
            await (channel as any).send(resolved.errorMessage);
          }
        } catch (err) {
          console.warn('[DiscordSessionPool] Failed to send user-not-linked message:', err);
        }
        return `discord_unlinked_${Date.now()}`;
      }
      if (resolved.userId) {
        djinnbotUserId = resolved.userId;
        const model = opts.model ?? this.config.defaultModel;
        const keyError = await this.userResolver.checkUserHasProviderKey(resolved.userId, model);
        if (keyError) {
          try {
            const channel = await opts.client.channels.fetch(opts.channelId);
            if (channel && 'send' in channel) {
              await (channel as any).send(keyError);
            }
          } catch (err) {
            console.warn('[DiscordSessionPool] Failed to send no-provider-key message:', err);
          }
          return `discord_nokey_${Date.now()}`;
        }
      }
    }

    // Pre-generate sessionId and register SYNCHRONOUSLY
    const sessionId = `discord_${opts.source}_${opts.agentId}_${Date.now()}`;
    const idleTimeoutMs = opts.source === 'dm' ? this.DM_IDLE_MS : this.THREAD_IDLE_MS;

    const entry: DiscordSessionEntry = {
      sessionId,
      agentId: opts.agentId,
      source: opts.source,
      channelId: opts.channelId,
      threadId: opts.threadId,
      lastActiveAt: Date.now(),
      idleTimer: this.createIdleTimer(key, sessionId, opts.agentId, idleTimeoutMs),
    };
    this.sessions.set(key, entry);

    // Cold start async
    this.coldStartAsync(key, sessionId, opts, djinnbotUserId).catch(err => {
      console.error(`[DiscordSessionPool] coldStartAsync failed for ${sessionId}:`, err);
      clearTimeout(entry.idleTimer);
      this.sessions.delete(key);
    });

    return sessionId;
  }

  /**
   * Explicitly stop a session.
   */
  async stopSession(
    agentId: string,
    source: DiscordConversationSource,
    channelId: string,
    threadId?: string,
  ): Promise<void> {
    const key = this.sessionKey(agentId, source, channelId, threadId);
    const entry = this.sessions.get(key);
    if (!entry) return;

    clearTimeout(entry.idleTimer);
    this.sessions.delete(key);

    if (this.config.onBeforeTeardown) {
      try {
        await this.config.onBeforeTeardown(entry.sessionId, entry.agentId);
      } catch (err) {
        console.warn(`[DiscordSessionPool] onBeforeTeardown failed for ${entry.sessionId}:`, err);
      }
    }

    try {
      await this.config.chatSessionManager.stopSession(entry.sessionId);
    } catch (err) {
      console.warn(`[DiscordSessionPool] Error stopping session ${entry.sessionId}:`, err);
    }
  }

  /**
   * Look up the Discord channel and thread for a given session ID.
   */
  getSessionLocation(sessionId: string): { agentId: string; channelId: string; threadId?: string } | undefined {
    for (const entry of this.sessions.values()) {
      if (entry.sessionId === sessionId) {
        return {
          agentId: entry.agentId,
          channelId: entry.channelId,
          threadId: entry.threadId,
        };
      }
    }
    return undefined;
  }

  /**
   * Update the model for an active session.
   */
  async updateSessionModel(
    agentId: string,
    source: DiscordConversationSource,
    channelId: string,
    model: string,
    threadId?: string,
  ): Promise<boolean> {
    const key = this.sessionKey(agentId, source, channelId, threadId);
    const entry = this.sessions.get(key);
    if (!entry) return false;
    if (!this.config.chatSessionManager.isSessionActive(entry.sessionId)) return false;

    this.config.chatSessionManager.updateModel(entry.sessionId, model);
    return true;
  }

  /**
   * Get the current model for an active session.
   */
  getActiveSessionModel(
    agentId: string,
    source: DiscordConversationSource,
    channelId: string,
    threadId?: string,
  ): string | undefined {
    const key = this.sessionKey(agentId, source, channelId, threadId);
    const entry = this.sessions.get(key);
    if (!entry) return undefined;
    const session = this.config.chatSessionManager.getSession(entry.sessionId);
    return session?.model ?? this.config.defaultModel;
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
  }

  // ─── Internal ────────────────────────────────────────────────────────────────

  private sessionKey(
    agentId: string,
    source: DiscordConversationSource,
    channelId: string,
    threadId?: string,
  ): string {
    if (source === 'dm') {
      return `discord_dm:${agentId}:${channelId}`;
    }
    return `discord_thread:${agentId}:${channelId}:${threadId ?? ''}`;
  }

  private async coldStartAsync(
    key: string,
    sessionId: string,
    opts: SendMessageOptions,
    djinnbotUserId?: string,
  ): Promise<void> {
    const idleTimeoutMs = opts.source === 'dm' ? this.DM_IDLE_MS : this.THREAD_IDLE_MS;

    console.log(
      `[DiscordSessionPool] Cold start — key=${key} sessionId=${sessionId} (timeout=${idleTimeoutMs / 1000}s)`,
    );

    // Assemble message history from Discord for context on resume
    let externalHistory: Array<{ role: string; content: string; created_at: number }> | undefined;
    try {
      externalHistory = await this.assembleMessageHistory(
        opts.client,
        opts.channelId,
        opts.threadId,
        opts.botUserId,
        opts.agentId,
        opts.source,
      );

      // Only inject history with at least one assistant turn
      const hasAssistantTurn = externalHistory.some(m => m.role === 'assistant');
      if (!hasAssistantTurn && externalHistory.length > 0) {
        console.warn(
          `[DiscordSessionPool] Discarding ${externalHistory.length}-message history for ${sessionId} — no assistant turns`,
        );
        externalHistory = undefined;
      }
    } catch (err) {
      console.warn('[DiscordSessionPool] Failed to assemble history:', err);
    }

    await this.config.chatSessionManager.startSession({
      sessionId,
      agentId: opts.agentId,
      model: opts.model ?? this.config.defaultModel,
      externalHistory: externalHistory && externalHistory.length > 0 ? externalHistory : undefined,
      userId: djinnbotUserId,
    });

    // Send the triggering message
    await this.config.chatSessionManager.sendMessage(
      sessionId,
      opts.message,
      opts.model ?? this.config.defaultModel,
      undefined,
      opts.attachments,
    );
  }

  private createIdleTimer(key: string, sessionId: string, agentId: string, idleTimeoutMs: number): NodeJS.Timeout {
    const timer = setTimeout(async () => {
      console.log(`[DiscordSessionPool] Idle timeout for key=${key} sessionId=${sessionId}`);
      this.sessions.delete(key);

      if (this.config.onBeforeTeardown) {
        try {
          await this.config.onBeforeTeardown(sessionId, agentId);
        } catch (err) {
          console.warn(`[DiscordSessionPool] onBeforeTeardown failed for ${sessionId}:`, err);
        }
      }

      try {
        await this.config.chatSessionManager.stopSession(sessionId);
      } catch (err) {
        console.warn(`[DiscordSessionPool] Error during idle stop of ${sessionId}:`, err);
      }
    }, idleTimeoutMs);

    timer.unref?.();
    return timer;
  }

  private resetIdleTimer(key: string, entry: DiscordSessionEntry): void {
    const idleTimeoutMs = entry.source === 'dm' ? this.DM_IDLE_MS : this.THREAD_IDLE_MS;
    clearTimeout(entry.idleTimer);
    entry.idleTimer = this.createIdleTimer(key, entry.sessionId, entry.agentId, idleTimeoutMs);
    entry.lastActiveAt = Date.now();
  }

  /**
   * Assemble conversation history from Discord messages.
   *
   * Fetches up to 100 recent messages from the channel/thread and maps
   * them to { role, content, created_at } format.
   *
   * Bot messages from THIS agent → role: 'assistant'
   * All other messages → role: 'user' (with speaker prefix)
   */
  private async assembleMessageHistory(
    client: Client,
    channelId: string,
    threadId: string | undefined,
    botUserId: string | undefined,
    agentId: string,
    source: DiscordConversationSource,
  ): Promise<Array<{ role: string; content: string; created_at: number }>> {
    try {
      const targetChannelId = threadId ?? channelId;
      const channel = await client.channels.fetch(targetChannelId);
      if (!channel || !('messages' in channel)) return [];

      const textChannel = channel as TextChannel;
      const messages = await textChannel.messages.fetch({ limit: 100 });

      // Messages are returned newest-first by Discord — reverse for chronological order
      const sorted = [...messages.values()].reverse();

      const history: Array<{ role: string; content: string; created_at: number }> = [];

      for (const msg of sorted) {
        if (!msg.content || !msg.content.trim()) continue;

        const isFromThisAgent = botUserId
          ? msg.author.id === botUserId
          : msg.author.bot;
        const tsNum = msg.createdTimestamp;

        if (isFromThisAgent) {
          history.push({ role: 'assistant', content: msg.content, created_at: tsNum });
        } else {
          const displayName = msg.member?.displayName ?? msg.author.displayName ?? msg.author.username;
          const content = source === 'guild_thread'
            ? `${displayName}: ${msg.content}`
            : msg.content;
          history.push({ role: 'user', content, created_at: tsNum });
        }
      }

      console.log(
        `[DiscordSessionPool] Assembled ${history.length} messages from Discord for ${agentId} in ${targetChannelId}`,
      );
      return history;
    } catch (err) {
      console.warn('[DiscordSessionPool] Failed to assemble message history:', err);
      return [];
    }
  }
}
