/**
 * TelegramBridge — top-level coordinator for Telegram integration.
 *
 * Architecture: One bot per agent.
 *
 * TelegramBridgeManager (singleton, created by engine)
 *   -> TelegramAgentBridge (one per agent with Telegram enabled)
 *        -> grammy Bot instance (long-polling)
 *        -> TelegramTypingManager
 *        -> Allowlist checker
 *        -> ChatSessionManager integration
 *
 * Unlike Signal's single-number model, each agent gets its own Telegram
 * bot token from BotFather. No routing needed — messages to a bot go
 * directly to that agent.
 */

import { Redis } from 'ioredis';
import type {
  AgentRegistry,
  EventBus,
} from '@djinnbot/core';
import { authFetch } from '@djinnbot/core';
import type { ChatSessionManager } from '@djinnbot/core/chat';
import { TelegramClient } from './telegram-client.js';
import { TelegramTypingManager } from './telegram-typing-manager.js';
import { isSenderAllowed, resolveAllowlist } from './allowlist.js';
import { markdownToTelegramHtml, chunkTelegramMessage } from './telegram-format.js';
import type {
  TelegramBridgeConfig,
  TelegramAgentConfig,
  TelegramAllowlistDbEntry,
  TelegramRpcRequest,
} from './types.js';

// ── Full config for BridgeManager ────────────────────────────────────────────

export interface TelegramBridgeFullConfig extends TelegramBridgeConfig {
  eventBus: EventBus;
  agentRegistry: AgentRegistry;
  chatSessionManager?: ChatSessionManager;
}

// ── TelegramAgentBridge — one instance per Telegram-enabled agent ────────────

class TelegramAgentBridge {
  private agentId: string;
  private config: TelegramBridgeFullConfig;
  private client: TelegramClient;
  private typingManager: TelegramTypingManager;
  private agentConfig: TelegramAgentConfig;
  private stopped = false;
  /** Per-chat model override set by /model command. */
  private chatModelOverrides = new Map<number, string>();

  constructor(
    agentId: string,
    agentConfig: TelegramAgentConfig,
    config: TelegramBridgeFullConfig,
  ) {
    this.agentId = agentId;
    this.config = config;
    this.agentConfig = agentConfig;
    this.client = new TelegramClient({ botToken: agentConfig.botToken! });
    this.typingManager = new TelegramTypingManager(this.client);
  }

  async start(): Promise<void> {
    // 1. Validate token and resolve bot info
    try {
      const info = await this.client.init();
      console.log(
        `[TelegramBridge:${this.agentId}] Bot validated: @${info.username} (id=${info.id})`,
      );
    } catch (err) {
      console.error(
        `[TelegramBridge:${this.agentId}] Failed to validate bot token:`,
        err,
      );
      return;
    }

    // 2. Register message handler on the grammy bot
    const bot = this.client.getBot();

    // Handle text messages in private chats (DMs)
    bot.on('message:text', async (ctx: any) => {
      if (this.stopped) return;

      const msg = ctx.message;
      const chat = msg.chat;
      const sender = msg.from;

      // Only handle private (DM) messages for now
      if (chat.type !== 'private') return;
      if (!sender || sender.is_bot) return;

      const text = msg.text;
      if (!text?.trim()) return;

      await this.handleIncomingMessage(
        chat.id,
        sender.id,
        sender.username,
        sender.first_name,
        text,
      );
    });

    // Handle photo messages in private chats
    bot.on('message:photo', async (ctx: any) => {
      if (this.stopped) return;
      const msg = ctx.message;
      if (msg.chat.type !== 'private') return;
      if (!msg.from || msg.from.is_bot) return;

      // Get the largest photo variant
      const photo = msg.photo[msg.photo.length - 1];
      const file = await ctx.getFile();
      const fileUrl = `https://api.telegram.org/file/bot${this.client.getBot().token}/${file.file_path}`;

      await this.handleIncomingMessage(
        msg.chat.id,
        msg.from.id,
        msg.from.username,
        msg.from.first_name,
        msg.caption || '',
        [{ url: fileUrl, name: `photo_${photo.file_unique_id}.jpg`, mimeType: 'image/jpeg' }],
      );
    });

    // Handle document messages (PDFs, code files, etc.)
    bot.on('message:document', async (ctx: any) => {
      if (this.stopped) return;
      const msg = ctx.message;
      if (msg.chat.type !== 'private') return;
      if (!msg.from || msg.from.is_bot) return;

      const doc = msg.document;
      const file = await ctx.getFile();
      const fileUrl = `https://api.telegram.org/file/bot${this.client.getBot().token}/${file.file_path}`;

      await this.handleIncomingMessage(
        msg.chat.id,
        msg.from.id,
        msg.from.username,
        msg.from.first_name,
        msg.caption || '',
        [{ url: fileUrl, name: doc.file_name || 'document', mimeType: doc.mime_type || 'application/octet-stream' }],
      );
    });

    // Handle voice messages (transcribed server-side via faster-whisper)
    bot.on('message:voice', async (ctx: any) => {
      if (this.stopped) return;
      const msg = ctx.message;
      if (msg.chat.type !== 'private') return;
      if (!msg.from || msg.from.is_bot) return;

      const file = await ctx.getFile();
      const fileUrl = `https://api.telegram.org/file/bot${this.client.getBot().token}/${file.file_path}`;

      await this.handleIncomingMessage(
        msg.chat.id,
        msg.from.id,
        msg.from.username,
        msg.from.first_name,
        '',
        [{ url: fileUrl, name: `voice_${msg.voice.file_unique_id}.ogg`, mimeType: msg.voice.mime_type || 'audio/ogg' }],
      );
    });

    // Handle video notes (circular videos — treat as video attachment)
    bot.on('message:video_note', async (ctx: any) => {
      if (this.stopped) return;
      const msg = ctx.message;
      if (msg.chat.type !== 'private') return;
      if (!msg.from || msg.from.is_bot) return;

      const file = await ctx.getFile();
      const fileUrl = `https://api.telegram.org/file/bot${this.client.getBot().token}/${file.file_path}`;

      await this.handleIncomingMessage(
        msg.chat.id,
        msg.from.id,
        msg.from.username,
        msg.from.first_name,
        '[Video note]',
        [{ url: fileUrl, name: `videonote_${msg.video_note.file_unique_id}.mp4`, mimeType: 'video/mp4' }],
      );
    });

    // Handle audio messages (music files, audio recordings)
    bot.on('message:audio', async (ctx: any) => {
      if (this.stopped) return;
      const msg = ctx.message;
      if (msg.chat.type !== 'private') return;
      if (!msg.from || msg.from.is_bot) return;

      const file = await ctx.getFile();
      const fileUrl = `https://api.telegram.org/file/bot${this.client.getBot().token}/${file.file_path}`;

      await this.handleIncomingMessage(
        msg.chat.id,
        msg.from.id,
        msg.from.username,
        msg.from.first_name,
        msg.caption || '',
        [{ url: fileUrl, name: msg.audio.file_name || `audio_${msg.audio.file_unique_id}.mp3`, mimeType: msg.audio.mime_type || 'audio/mpeg' }],
      );
    });

    // Catch errors
    bot.catch((err: any) => {
      if (this.stopped) return;
      console.error(`[TelegramBridge:${this.agentId}] Bot error:`, err);
    });

    // 3. Start long-polling
    this.client.startPolling();
    console.log(`[TelegramBridge:${this.agentId}] Started polling`);
  }

  async stop(): Promise<void> {
    this.stopped = true;
    this.typingManager.stopAll();
    await this.client.stop();
    console.log(`[TelegramBridge:${this.agentId}] Stopped`);
  }

  // ── Incoming message handling ──────────────────────────────────────────

  private async handleIncomingMessage(
    chatId: number,
    userId: number,
    username: string | undefined,
    firstName: string,
    text: string,
    telegramFiles?: Array<{ url: string; name: string; mimeType: string }>,
  ): Promise<void> {
    const displayName = username ? `@${username}` : firstName;
    const displayText = text || (telegramFiles?.length ? `[${telegramFiles.length} file(s)]` : '');
    console.log(
      `[TelegramBridge:${this.agentId}] Incoming from ${displayName} (${userId}): "${displayText.slice(0, 80)}${displayText.length > 80 ? '...' : ''}"`,
    );

    // 1. Allowlist check
    const entries = await this.loadAllowlist();
    const allowed = isSenderAllowed(
      userId,
      username,
      entries,
      this.agentConfig.allowAll,
    );
    if (!allowed) {
      console.log(
        `[TelegramBridge:${this.agentId}] Sender ${displayName} (${userId}) not in allowlist — ignoring`,
      );
      return;
    }

    // 2. Check for built-in commands
    if (text) {
      const cmdResult = await this.handleCommand(chatId, text);
      if (cmdResult) return;
    }

    // 3. Start typing indicator
    this.typingManager.startTyping(chatId);

    // 3. Process with agent — raw files are passed through and uploaded
    //    AFTER the session is created (avoids FK violation on chat_attachments)
    try {
      const response = await this.processWithAgent(chatId, userId, text || '[Voice/media message — see attachments]', telegramFiles);
      this.typingManager.stopTyping(chatId);
      await this.sendFormattedMessage(chatId, response);
    } catch (err) {
      this.typingManager.stopTyping(chatId);
      console.error(
        `[TelegramBridge:${this.agentId}] Agent processing failed:`,
        err,
      );
      await this.client.sendMessage(
        chatId,
        'Sorry, something went wrong processing your message. Please try again.',
      ).catch(() => {});
    }
  }

  // ── Built-in commands ───────────────────────────────────────────────────

  /**
   * Handle built-in slash commands. Returns true if a command was handled.
   */
  private async handleCommand(chatId: number, text: string): Promise<boolean> {
    const trimmed = text.trim();
    const lower = trimmed.toLowerCase();

    if (lower === '/help' || lower === '/start') {
      await this.sendFormattedMessage(chatId, [
        `Hi! I'm **${this.agentId}**. Available commands:`,
        '  /new — Start a fresh conversation (clears history)',
        '  /model <name> — Switch the AI model',
        '  /modelfavs — Show your favorite models',
        '  /context — Show current context window usage',
        '  /compact [instructions] — Compact session context',
        '  /status — Show session status',
        '  /help — Show this help',
      ].join('\n'));
      return true;
    }

    if (lower === '/new') {
      const csm = this.config.chatSessionManager;
      const sessionId = `telegram_${chatId}_${this.agentId}`;
      console.log(`[TelegramBridge:${this.agentId}] /new: resetting session ${sessionId}`);

      // 1. Stop the container if running
      if (csm?.isSessionActive(sessionId)) {
        try { await csm.stopSession(sessionId); } catch (err) {
          console.warn(`[TelegramBridge:${this.agentId}] /new: failed to stop session ${sessionId}:`, err);
        }
      }

      // 2. Delete session + messages from DB
      const apiUrl = this.config.apiUrl ?? process.env.DJINNBOT_API_URL ?? 'http://api:8000';
      try {
        await authFetch(`${apiUrl}/v1/chat/sessions/${sessionId}`, {
          method: 'DELETE',
          signal: AbortSignal.timeout(5000),
        });
      } catch (err) {
        console.warn(`[TelegramBridge:${this.agentId}] /new: failed to delete session ${sessionId} from DB:`, err);
      }

      await this.sendFormattedMessage(chatId, 'Conversation reset. Your next message starts a fresh session.');
      return true;
    }

    if (lower.startsWith('/model')) {
      const modelArg = trimmed.slice('/model'.length).trim();
      if (!modelArg) {
        await this.sendFormattedMessage(chatId, 'Usage: /model <model-name>\nExample: /model anthropic/claude-sonnet-4');
        return true;
      }

      const csm = this.config.chatSessionManager;
      const sessionId = `telegram_${chatId}_${this.agentId}`;

      if (csm?.isSessionActive(sessionId)) {
        csm.updateModel(sessionId, modelArg);
        console.log(`[TelegramBridge:${this.agentId}] /model: changed model to ${modelArg} for session ${sessionId}`);
      }

      this.chatModelOverrides.set(chatId, modelArg);
      await this.sendFormattedMessage(chatId, `Model changed to ${modelArg}. This will apply to your next message.`);
      return true;
    }

    if (lower === '/modelfavs') {
      const apiUrl = this.config.apiUrl ?? process.env.DJINNBOT_API_URL ?? 'http://api:8000';
      try {
        const res = await authFetch(`${apiUrl}/v1/settings/favorites`, {
          signal: AbortSignal.timeout(5000),
        });
        const data = await res.json() as { favorites?: string[] };
        const favs = data.favorites ?? [];
        if (favs.length === 0) {
          await this.sendFormattedMessage(chatId, 'No favorite models set. Add favorites in the dashboard under Settings > Models.');
        } else {
          const list = favs.map((m: string, i: number) => `  ${i + 1}. ${m}`).join('\n');
          await this.sendFormattedMessage(chatId, `Your favorite models:\n${list}\n\nUse /model <name> to switch.`);
        }
      } catch (err) {
        console.warn(`[TelegramBridge:${this.agentId}] /modelfavs: failed to fetch favorites:`, err);
        await this.sendFormattedMessage(chatId, 'Failed to load favorite models. Please try again.');
      }
      return true;
    }

    if (lower === '/context') {
      const csm = this.config.chatSessionManager;
      const sessionId = `telegram_${chatId}_${this.agentId}`;

      if (!csm?.isSessionActive(sessionId)) {
        await this.sendFormattedMessage(chatId, 'No active session. Send a message first.');
        return true;
      }

      try {
        const usage = await csm.getContextUsage(sessionId);
        if (usage) {
          const usedK = Math.round(usage.usedTokens / 1000);
          const limitK = Math.round(usage.contextWindow / 1000);
          await this.sendFormattedMessage(chatId, `**Context:** ${usage.percent}% — ${usedK}k/${limitK}k tokens\n**Model:** ${usage.model || 'unknown'}`);
        } else {
          await this.sendFormattedMessage(chatId, 'Context usage not yet available. Send a message first.');
        }
      } catch (err) {
        console.warn(`[TelegramBridge:${this.agentId}] /context failed:`, err);
        await this.sendFormattedMessage(chatId, 'Failed to retrieve context usage.');
      }
      return true;
    }

    if (lower === '/compact' || lower.startsWith('/compact ')) {
      const csm = this.config.chatSessionManager;
      const sessionId = `telegram_${chatId}_${this.agentId}`;
      const instructions = trimmed.slice('/compact'.length).trim() || undefined;

      if (!csm?.isSessionActive(sessionId)) {
        await this.sendFormattedMessage(chatId, 'No active session. Send a message first.');
        return true;
      }

      await this.sendFormattedMessage(chatId, 'Compacting session context...');

      try {
        const result = await csm.compactSession(sessionId, instructions);
        if (result?.success) {
          const beforeK = Math.round(result.tokensBefore / 1000);
          const afterK = Math.round(result.tokensAfter / 1000);
          const savedPct = result.tokensBefore > 0
            ? Math.round(((result.tokensBefore - result.tokensAfter) / result.tokensBefore) * 100)
            : 0;
          await this.sendFormattedMessage(chatId, `**Compacted:** ${beforeK}k → ${afterK}k tokens (saved ${savedPct}%)`);
        } else {
          await this.sendFormattedMessage(chatId, `Compaction failed: ${result?.error || 'unknown error'}`);
        }
      } catch (err) {
        console.warn(`[TelegramBridge:${this.agentId}] /compact failed:`, err);
        await this.sendFormattedMessage(chatId, 'Failed to compact session.');
      }
      return true;
    }

    if (lower === '/status') {
      const csm = this.config.chatSessionManager;
      const sessionId = `telegram_${chatId}_${this.agentId}`;

      if (!csm?.isSessionActive(sessionId)) {
        await this.sendFormattedMessage(chatId, 'No active session.');
        return true;
      }

      try {
        const usage = await csm.getContextUsage(sessionId);
        const sessionModel = csm.getSession(sessionId)?.model;
        const model = sessionModel ?? this.chatModelOverrides.get(chatId) ?? this.config.defaultConversationModel ?? 'unknown';
        const lines = [`**Model:** ${model}`];
        if (usage) {
          const usedK = Math.round(usage.usedTokens / 1000);
          const limitK = Math.round(usage.contextWindow / 1000);
          lines.push(`**Context:** ${usage.percent}% (${usedK}k/${limitK}k)`);
        }
        await this.sendFormattedMessage(chatId, lines.join('\n'));
      } catch (err) {
        console.warn(`[TelegramBridge:${this.agentId}] /status failed:`, err);
        await this.sendFormattedMessage(chatId, 'Failed to retrieve status.');
      }
      return true;
    }

    return false;
  }

  // ── Agent processing ───────────────────────────────────────────────────

  private async processWithAgent(
    chatId: number,
    userId: number,
    text: string,
    telegramFiles?: Array<{ url: string; name: string; mimeType: string }>,
  ): Promise<string> {
    const csm = this.config.chatSessionManager;
    if (!csm) {
      return 'Telegram chat sessions are not yet configured. Please set up ChatSessionManager.';
    }

    const sessionId = `telegram_${chatId}_${this.agentId}`;

    // Collect response chunks
    const chunks: string[] = [];
    let resolveResponse!: (value: string) => void;
    let rejectResponse!: (err: Error) => void;
    const responsePromise = new Promise<string>((resolve, reject) => {
      resolveResponse = resolve;
      rejectResponse = reject;
    });

    // Register temporary hooks for this session — returns a cleanup function
    // that removes exactly these hooks without affecting other consumers.
    const cleanupHooks = csm.registerHooks({
      onOutput: (sid: string, chunk: string) => {
        if (sid === sessionId) chunks.push(chunk);
      },
      onToolStart: (sid: string, _toolName: string) => {
        if (sid === sessionId) {
          // Keep typing alive during tool execution
          this.typingManager.startTyping(chatId);
        }
      },
      onToolEnd: () => {},
      onStepEnd: (sid: string, success: boolean) => {
        if (sid !== sessionId) return;
        if (success) {
          resolveResponse(chunks.join(''));
        } else {
          rejectResponse(new Error('Agent step failed'));
        }
      },
    });

    try {
      // Use per-chat model override (set by /model) if available, else default
      const model = this.chatModelOverrides.get(chatId)
        ?? this.config.defaultConversationModel
        ?? 'openrouter/minimax/minimax-m2.5';

      // Start or resume session — creates the DB row for chat_sessions
      await csm.startSession({
        sessionId,
        agentId: this.agentId,
        model,
      });

      // Upload attachments AFTER session exists (avoids FK violation on chat_attachments)
      let attachments: Array<{ id: string; filename: string; mimeType: string; sizeBytes: number; isImage: boolean }> | undefined;
      if (telegramFiles && telegramFiles.length > 0) {
        try {
          const { processChannelAttachments } = await import('@djinnbot/core');
          attachments = await processChannelAttachments(
            telegramFiles.map(f => ({ url: f.url, name: f.name, mimeType: f.mimeType })),
            this.config.apiUrl,
            sessionId,
            `[TelegramBridge:${this.agentId}]`,
          );
          if (attachments.length === 0) attachments = undefined;
        } catch (err) {
          console.warn(`[TelegramBridge:${this.agentId}] Failed to upload attachments:`, err);
        }
      }

      // Persist user + placeholder assistant message to DB so the response
      // can be completed via currentMessageId at stepEnd.
      const messageId = await this.persistMessagePair(sessionId, text, model);

      // Send the user's message (with messageId so stepEnd persists the response)
      await csm.sendMessage(sessionId, text, model, messageId, attachments);

      // Wait for the agent to finish (with timeout)
      const response = await Promise.race([
        responsePromise,
        new Promise<string>((_, reject) =>
          setTimeout(
            () => reject(new Error('Agent response timeout (120s)')),
            120_000,
          ),
        ),
      ]);

      return response || '(No response from agent)';
    } finally {
      cleanupHooks();
    }
  }

  // ── DB persistence helpers ──────────────────────────────────────────────

  /**
   * Create a user message + placeholder assistant message in the DB.
   * Returns the assistant message ID so it can be passed to sendMessage()
   * as currentMessageId, enabling stepEnd to persist the response.
   */
  private async persistMessagePair(
    sessionId: string,
    userText: string,
    model: string,
  ): Promise<string | undefined> {
    try {
      // Create user message
      await authFetch(
        `${this.config.apiUrl}/v1/internal/chat/sessions/${sessionId}/messages`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ role: 'user', content: userText }),
          signal: AbortSignal.timeout(5000),
        },
      );

      // Create placeholder assistant message
      const res = await authFetch(
        `${this.config.apiUrl}/v1/internal/chat/sessions/${sessionId}/messages`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ role: 'assistant', content: '', model }),
          signal: AbortSignal.timeout(5000),
        },
      );

      if (res.ok) {
        const data = (await res.json()) as { message_id: string };
        return data.message_id;
      }
      console.warn(`[TelegramBridge:${this.agentId}] Failed to create assistant message: HTTP ${res.status}`);
    } catch (err) {
      console.warn(`[TelegramBridge:${this.agentId}] persistMessagePair failed:`, err);
    }
    return undefined;
  }

  // ── Outbound messaging ─────────────────────────────────────────────────

  private async sendFormattedMessage(chatId: number, text: string): Promise<void> {
    const html = markdownToTelegramHtml(text);
    const chunks = chunkTelegramMessage(html);

    for (const chunk of chunks) {
      try {
        await this.client.sendMessage(chatId, chunk, { parseMode: 'HTML' });
      } catch (err) {
        // If HTML parsing fails, fall back to plain text
        const isParseError =
          err instanceof Error && /parse entities|can't parse/i.test(err.message);
        if (isParseError) {
          const plainChunks = chunkTelegramMessage(text);
          for (const plain of plainChunks) {
            await this.client.sendMessage(chatId, plain);
          }
          return;
        }
        throw err;
      }
    }
  }

  /**
   * Send a message to a user from this agent.
   * Called via the MCP escalation tool or API endpoint.
   */
  async sendToUser(chatId: number, message: string): Promise<void> {
    const agent = this.config.agentRegistry.get(this.agentId);
    const prefix = agent
      ? `${agent.identity.emoji} ${agent.identity.name}\n`
      : '';
    await this.sendFormattedMessage(chatId, `${prefix}${message}`);
  }

  // ── Allowlist loading ──────────────────────────────────────────────────

  private async loadAllowlist(): Promise<ReturnType<typeof resolveAllowlist>> {
    try {
      const res = await authFetch(
        `${this.config.apiUrl}/v1/telegram/${this.agentId}/allowlist`,
        { signal: AbortSignal.timeout(5000) },
      );
      if (res.ok) {
        const data = (await res.json()) as { entries: TelegramAllowlistDbEntry[] };
        return resolveAllowlist(data.entries);
      }
    } catch {
      // Fall through
    }
    return [];
  }
}

// ── TelegramBridgeManager — manages all agent bridges ────────────────────────

export class TelegramBridgeManager {
  private config: TelegramBridgeFullConfig;
  private redis: Redis;
  private rpcRedis: Redis;
  private configSubRedis: Redis;
  private bridges = new Map<string, TelegramAgentBridge>();
  private abortController = new AbortController();

  constructor(config: TelegramBridgeFullConfig) {
    this.config = config;
    this.redis = new Redis(config.redisUrl);
    this.rpcRedis = new Redis(config.redisUrl);
    this.configSubRedis = new Redis(config.redisUrl);
  }

  /** Inject the ChatSessionManager after construction (same pattern as SignalBridge/SlackBridge). */
  setChatSessionManager(csm: ChatSessionManager): void {
    this.config.chatSessionManager = csm;
    console.log('[TelegramBridgeManager] ChatSessionManager injected');
  }

  /**
   * Start the Telegram bridge manager.
   * Fetches all agents with Telegram enabled and starts a bridge for each.
   */
  async start(): Promise<void> {
    // 1. Load all Telegram configs from the API
    const configs = await this.loadAllConfigs();
    const enabledConfigs = configs.filter((c) => c.enabled && c.botToken);

    if (enabledConfigs.length === 0) {
      console.log('[TelegramBridgeManager] No Telegram-enabled agents found');
    }

    // 2. Start a bridge for each enabled agent
    for (const agentConfig of enabledConfigs) {
      await this.startAgentBridge(agentConfig);
    }

    // 3. Listen for config changes (hot reload)
    this.startConfigListener();

    // 4. Start Redis RPC handler
    this.startRpcHandler();

    console.log(
      `[TelegramBridgeManager] Started — ${this.bridges.size} agent bot(s) active`,
    );
  }

  async shutdown(): Promise<void> {
    console.log('[TelegramBridgeManager] Shutting down...');
    this.abortController.abort();

    const stops = Array.from(this.bridges.values()).map((b) => b.stop());
    await Promise.allSettled(stops);
    this.bridges.clear();

    this.redis.disconnect();
    this.rpcRedis.disconnect();
    this.configSubRedis.disconnect();
    console.log('[TelegramBridgeManager] Shutdown complete');
  }

  // ── Agent bridge lifecycle ─────────────────────────────────────────────

  private async startAgentBridge(agentConfig: TelegramAgentConfig): Promise<void> {
    // Stop existing bridge for this agent if any
    await this.stopAgentBridge(agentConfig.agentId);

    const bridge = new TelegramAgentBridge(
      agentConfig.agentId,
      agentConfig,
      this.config,
    );

    try {
      await bridge.start();
      this.bridges.set(agentConfig.agentId, bridge);
    } catch (err) {
      console.error(
        `[TelegramBridgeManager] Failed to start bridge for ${agentConfig.agentId}:`,
        err,
      );
    }
  }

  private async stopAgentBridge(agentId: string): Promise<void> {
    const existing = this.bridges.get(agentId);
    if (existing) {
      await existing.stop();
      this.bridges.delete(agentId);
    }
  }

  // ── Config change listener (hot reload) ────────────────────────────────

  private startConfigListener(): void {
    const sub = this.configSubRedis.duplicate();

    // Subscribe to pattern: telegram:config:changed:*
    sub.psubscribe('telegram:config:changed:*');

    sub.on('pmessage', (_pattern: string, channel: string, _message: string) => {
      if (this.abortController.signal.aborted) return;

      const match = channel.match(/^telegram:config:changed:(.+)$/);
      if (!match) return;

      const agentId = match[1];
      console.log(`[TelegramBridgeManager] Config changed for ${agentId}, reloading...`);

      void this.reloadAgent(agentId).catch((err) => {
        console.error(
          `[TelegramBridgeManager] Failed to reload ${agentId}:`,
          err,
        );
      });
    });
  }

  private async reloadAgent(agentId: string): Promise<void> {
    const config = await this.loadAgentConfig(agentId);

    if (config && config.enabled && config.botToken) {
      await this.startAgentBridge(config);
    } else {
      await this.stopAgentBridge(agentId);
    }
  }

  // ── Redis RPC handler (API server -> Engine) ───────────────────────────

  private startRpcHandler(): void {
    const sub = this.rpcRedis.duplicate();
    sub.subscribe('telegram:rpc:request');

    sub.on('message', (_channel: string, raw: string) => {
      void (async () => {
        let req: TelegramRpcRequest;
        try {
          req = JSON.parse(raw);
        } catch {
          return;
        }

        let result: unknown;
        let error: string | undefined;

        try {
          switch (req.method) {
            case 'send': {
              const agentId = req.params.agentId as string;
              const chatId = Number(req.params.chatId);
              const message = req.params.message as string;
              const bridge = this.bridges.get(agentId);
              if (!bridge) {
                error = `No active Telegram bridge for agent ${agentId}`;
                break;
              }
              await bridge.sendToUser(chatId, message);
              result = { sent: true };
              break;
            }

            case 'status': {
              const agentId = req.params.agentId as string | undefined;
              if (agentId) {
                const active = this.bridges.has(agentId);
                result = { agentId, active };
              } else {
                const agents = Array.from(this.bridges.keys());
                result = { activeAgents: agents, count: agents.length };
              }
              break;
            }

            case 'restart': {
              const agentId = req.params.agentId as string;
              await this.reloadAgent(agentId);
              result = { restarted: true };
              break;
            }

            default:
              error = `Unknown method: ${req.method}`;
          }
        } catch (err) {
          error = err instanceof Error ? err.message : String(err);
        }

        // Publish reply
        const reply = JSON.stringify({ id: req.id, result, error });
        await this.redis.publish(`telegram:rpc:reply:${req.id}`, reply);
      })();
    });
  }

  // ── Config loading ─────────────────────────────────────────────────────

  private async loadAllConfigs(): Promise<TelegramAgentConfig[]> {
    try {
      const res = await authFetch(`${this.config.apiUrl}/v1/telegram/internal/configs`, {
        signal: AbortSignal.timeout(5000),
      });
      if (res.ok) {
        const data = (await res.json()) as { configs: TelegramAgentConfig[] };
        return data.configs;
      }
      console.warn(
        `[TelegramBridgeManager] Failed to load configs: ${res.status}`,
      );
    } catch (err) {
      console.warn('[TelegramBridgeManager] Config load failed:', err);
    }
    return [];
  }

  private async loadAgentConfig(
    agentId: string,
  ): Promise<TelegramAgentConfig | null> {
    try {
      const res = await authFetch(
        `${this.config.apiUrl}/v1/telegram/internal/${agentId}/config`,
        { signal: AbortSignal.timeout(5000) },
      );
      if (res.ok) {
        return (await res.json()) as TelegramAgentConfig;
      }
    } catch {
      // Fall through
    }
    return null;
  }
}
