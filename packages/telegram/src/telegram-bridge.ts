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
  ): Promise<void> {
    const displayName = username ? `@${username}` : firstName;
    console.log(
      `[TelegramBridge:${this.agentId}] Incoming from ${displayName} (${userId}): "${text.slice(0, 80)}${text.length > 80 ? '...' : ''}"`,
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

    // 2. Start typing indicator
    this.typingManager.startTyping(chatId);

    // 3. Process with agent
    try {
      const response = await this.processWithAgent(chatId, userId, text);
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

  // ── Agent processing ───────────────────────────────────────────────────

  private async processWithAgent(
    chatId: number,
    userId: number,
    text: string,
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
      // Start or resume session
      await csm.startSession({
        sessionId,
        agentId: this.agentId,
        model: this.config.defaultConversationModel ?? 'openrouter/minimax/minimax-m2.5',
      });

      // Send the user's message
      await csm.sendMessage(sessionId, text);

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
      const res = await fetch(
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
      const res = await fetch(`${this.config.apiUrl}/v1/telegram/configs`, {
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
      const res = await fetch(
        `${this.config.apiUrl}/v1/telegram/${agentId}/config`,
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
