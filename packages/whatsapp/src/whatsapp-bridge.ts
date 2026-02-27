/**
 * WhatsAppBridge — top-level coordinator for WhatsApp integration.
 *
 * Manages the full lifecycle:
 *   1. Acquire Redis distributed lock (single-writer)
 *   2. Initialize Baileys socket via WhatsAppSocket
 *   3. Listen for incoming messages via Baileys event handlers
 *   4. Route messages to agents via ChannelRouter
 *   5. Manage typing indicators during agent processing
 *   6. Send responses back through Baileys
 *   7. Handle Redis RPC requests from the API server (link, send, etc.)
 *
 * Mirrors the SignalBridge pattern but uses Baileys in-process instead
 * of a child process daemon.
 */

import { Redis } from 'ioredis';
import {
  type AgentRegistry,
  type EventBus,
  type CommandAction,
  ChannelRouter,
  ChannelTypingManager,
  normalizeE164,
  isSenderAllowed,
  resolveAllowlist,
  type AllowlistDbEntry,
  authFetch,
} from '@djinnbot/core';
import type { ChatSessionManager } from '@djinnbot/core/chat';
import { WhatsAppSocket, type ConnectionStatus } from './whatsapp-socket.js';
import { markdownToWhatsApp, chunkMessage } from './whatsapp-format.js';
import type {
  WhatsAppBridgeConfig,
  WhatsAppConfig,
  WhatsAppRpcRequest,
} from './types.js';

// ── Distributed lock ─────────────────────────────────────────────────────────

const LOCK_KEY = 'djinnbot:whatsapp:daemon-lock';
const LOCK_TTL_MS = 30_000;
const LOCK_RENEW_INTERVAL_MS = 10_000;

// Typing indicator settings for WhatsApp
// WhatsApp typing expires after ~25s, so keepalive every 10s is sufficient
const TYPING_KEEPALIVE_MS = 10_000;
const TYPING_MAX_DURATION_MS = 120_000;

export interface WhatsAppBridgeFullConfig extends WhatsAppBridgeConfig {
  eventBus: EventBus;
  agentRegistry: AgentRegistry;
  chatSessionManager?: ChatSessionManager;
}

export class WhatsAppBridge {
  private config: WhatsAppBridgeFullConfig;
  private redis: Redis;
  private rpcRedis: Redis;
  private socket: WhatsAppSocket | null = null;
  private router!: ChannelRouter;
  private typingManager!: ChannelTypingManager;
  private lockRelease: (() => Promise<void>) | null = null;
  private whatsappConfig: WhatsAppConfig | null = null;
  private latestQrForRpc: string | null = null;
  /** Per-sender model override set by /model command. */
  private senderModelOverrides = new Map<string, string>();

  constructor(config: WhatsAppBridgeFullConfig) {
    this.config = config;
    this.redis = new Redis(config.redisUrl);
    this.rpcRedis = new Redis(config.redisUrl);
  }

  /** Inject the ChatSessionManager after construction (same pattern as SignalBridge/SlackBridge). */
  setChatSessionManager(csm: ChatSessionManager): void {
    this.config.chatSessionManager = csm;
    console.log('[WhatsAppBridge] ChatSessionManager injected');
  }

  // ── Lifecycle ──────────────────────────────────────────────────────────

  async start(): Promise<void> {
    // 1. Acquire distributed lock (retry up to 5 times with backoff —
    //    after a container restart the old heartbeat may take up to 30s to expire)
    let lock: { acquired: boolean; release: () => Promise<void> } | null = null;
    for (let attempt = 1; attempt <= 5; attempt++) {
      lock = await this.acquireLock();
      if (lock.acquired) break;
      console.log(`[WhatsAppBridge] Lock not acquired (attempt ${attempt}/5) — retrying in ${attempt * 5}s...`);
      await new Promise((r) => setTimeout(r, attempt * 5000));
    }
    if (!lock?.acquired) {
      console.error('[WhatsAppBridge] Could not acquire WhatsApp lock after 5 attempts — skipping');
      return;
    }
    this.lockRelease = lock.release;

    try {
      // 2. Start Redis RPC handler immediately (for link commands before connected)
      this.startRpcHandler();

      // 3. Load config from API
      await this.loadConfig();
      if (!this.whatsappConfig?.enabled) {
        console.log('[WhatsAppBridge] WhatsApp integration is disabled — RPC handler active for linking');
        return;
      }

      await this.startSocket();
    } catch (err) {
      console.error('[WhatsAppBridge] start() failed, releasing lock:', err);
      await this.lockRelease().catch(() => {});
      this.lockRelease = null;
      throw err;
    }
  }

  /**
   * Start the Baileys socket, router, and typing manager.
   * Called from start() when WhatsApp is enabled, or from RPC handler
   * after a successful link operation.
   */
  private async startSocket(): Promise<void> {
    // Initialize router
    this.router = new ChannelRouter({
      agentRegistry: this.config.agentRegistry,
      redis: this.redis,
      defaultAgentId: this.whatsappConfig?.defaultAgentId ?? this.getFirstAgentId(),
      stickyTtlMs: (this.whatsappConfig?.stickyTtlMinutes ?? 30) * 60 * 1000,
      channelName: 'whatsapp',
    });

    // Create socket with event handlers
    this.socket = new WhatsAppSocket(
      { authDir: this.config.authDir },
      {
        onQrCode: (qr) => {
          this.latestQrForRpc = qr;
          // Store in Redis for dashboard polling
          this.redis.setex('whatsapp:qr:latest', 30, qr).catch(() => {});
        },
        onConnectionUpdate: (status, phoneNumber) => {
          console.log(`[WhatsAppBridge] Connection: ${status}${phoneNumber ? ` (${phoneNumber})` : ''}`);
          if (status === 'open' && phoneNumber) {
            // Update config with phone number
            this.redis.setex('whatsapp:connected:phone', 3600, phoneNumber).catch(() => {});
          }
        },
        onMessage: (msg) => {
          void this.handleIncomingMessage(msg).catch((err) => {
            console.error('[WhatsAppBridge] Message handler error:', err);
          });
        },
      },
    );

    // Initialize typing manager
    this.typingManager = new ChannelTypingManager({
      keepaliveIntervalMs: TYPING_KEEPALIVE_MS,
      maxDurationMs: TYPING_MAX_DURATION_MS,
      sendTypingStart: async (recipient: string) => {
        if (this.socket) {
          await this.socket.sendPresenceUpdate(recipient, 'composing');
        }
      },
      sendTypingStop: async (recipient: string) => {
        if (this.socket) {
          await this.socket.sendPresenceUpdate(recipient, 'paused');
        }
      },
    });

    // Connect
    await this.socket.connect();

    console.log(
      `[WhatsAppBridge] Socket started — ` +
      `defaultAgent=${this.whatsappConfig?.defaultAgentId ?? 'none'}`
    );
  }

  async shutdown(): Promise<void> {
    console.log('[WhatsAppBridge] Shutting down...');
    this.typingManager?.stopAll();

    if (this.socket) {
      await this.socket.disconnect();
    }

    if (this.lockRelease) {
      await this.lockRelease();
    }

    this.redis.disconnect();
    this.rpcRedis.disconnect();
    console.log('[WhatsAppBridge] Shutdown complete');
  }

  // ── Message handling ───────────────────────────────────────────────────

  private async handleIncomingMessage(msg: {
    senderJid: string;
    senderPhone: string;
    text: string;
    messageKey: any;
    timestamp: number;
    isGroup: boolean;
    groupJid?: string;
    media?: { rawMessage: any; mimeType: string; filename?: string; type: 'image' | 'audio' | 'video' | 'document' };
  }): Promise<void> {
    // Skip group messages for now (DM-only in v1)
    if (msg.isGroup) return;

    const normalized = normalizeE164(msg.senderPhone);
    const displayText = msg.text || (msg.media ? `[${msg.media.type}]` : '');
    console.log(
      `[WhatsAppBridge] Incoming from ${normalized}: "${displayText.slice(0, 80)}${displayText.length > 80 ? '...' : ''}"`
    );

    // 1. Allowlist check
    const { entries, senderDefaults } = await this.loadAllowlist();
    const allowed = isSenderAllowed(normalized, entries, this.whatsappConfig?.allowAll ?? false);
    if (!allowed) {
      console.log(`[WhatsAppBridge] Sender ${normalized} not in allowlist — ignoring`);
      return;
    }

    // 2. Send read receipt
    if (this.socket && msg.messageKey) {
      this.socket.markRead([msg.messageKey]).catch(() => {});
    }

    // 3. Send ack reaction if configured
    const ackEmoji = this.whatsappConfig?.ackEmoji;
    if (ackEmoji && this.socket) {
      this.socket.sendReaction(msg.senderJid, msg.messageKey, ackEmoji).catch(() => {});
    }

    // 4. Check for built-in commands
    const cmd = await this.router.handleCommand(normalized, msg.text);
    if (cmd.handled) {
      if (cmd.action) {
        await this.handleCommandAction(normalized, msg.senderJid, cmd.action);
      } else if (cmd.response) {
        await this.sendFormattedMessage(msg.senderJid, cmd.response);
      }
      return;
    }

    // 5. Route to agent
    const route = await this.router.route(normalized, msg.text, senderDefaults);
    console.log(`[WhatsAppBridge] Routed to ${route.agentId} (reason: ${route.reason})`);

    // 6. Subscribe to presence + start typing indicator
    this.socket?.subscribePresence(msg.senderJid).catch(() => {});
    this.typingManager.startTyping(msg.senderJid);

    // 7. Pre-download WhatsApp media (raw buffer).
    //    Actual upload to DjinnBot storage happens inside processWithAgent()
    //    AFTER the session is created (avoids FK violation on chat_attachments).
    let rawMedia: { name: string; mimeType: string; buffer: Buffer } | undefined;
    if (msg.media && this.socket) {
      try {
        const { downloadMediaMessage } = await import('@whiskeysockets/baileys');
        const buffer = await downloadMediaMessage(
          msg.media.rawMessage,
          'buffer',
          {},
        ) as Buffer;

        const filename = msg.media.filename ||
          `${msg.media.type}_${Date.now()}.${msg.media.mimeType.split('/')[1] || 'bin'}`;

        rawMedia = { name: filename, mimeType: msg.media.mimeType, buffer };
      } catch (err) {
        console.warn('[WhatsAppBridge] Failed to download media:', err);
      }
    }

    // 8. Process with agent (session created inside, then media uploaded)
    const messageText = msg.text || (msg.media ? `[${msg.media.type} message — see attachments]` : '');
    try {
      const response = await this.processWithAgent(route.agentId, normalized, messageText, rawMedia);
      this.typingManager.stopTyping(msg.senderJid);
      await this.sendFormattedMessage(msg.senderJid, response);
    } catch (err) {
      this.typingManager.stopTyping(msg.senderJid);
      console.error(`[WhatsAppBridge] Agent ${route.agentId} processing failed:`, err);
      await this.socket?.sendTextMessage(
        msg.senderJid,
        'Sorry, something went wrong processing your message. Please try again.',
      );
    }
  }

  // ── Command action handling ─────────────────────────────────────────────

  /**
   * Handle an action returned by the ChannelRouter (e.g. /new, /model).
   */
  private async handleCommandAction(sender: string, senderJid: string, action: CommandAction): Promise<void> {
    const csm = this.config.chatSessionManager;
    const safeSender = normalizeE164(sender).replace(/[^a-zA-Z0-9]/g, '');

    if (action.type === 'reset') {
      const agentId = action.agentId ?? this.whatsappConfig?.defaultAgentId ?? this.getFirstAgentId();
      if (!agentId) {
        await this.sendFormattedMessage(senderJid, 'No active conversation to reset.');
        return;
      }

      const sessionId = `whatsapp_${safeSender}_${agentId}`;
      console.log(`[WhatsAppBridge] /new: resetting session ${sessionId} for ${sender}`);

      // 1. Stop the container if running
      if (csm?.isSessionActive(sessionId)) {
        try { await csm.stopSession(sessionId); } catch (err) {
          console.warn(`[WhatsAppBridge] /new: failed to stop session ${sessionId}:`, err);
        }
      }

      // 2. Delete session + messages from DB
      try {
        await authFetch(`${this.config.apiUrl}/v1/chat/sessions/${sessionId}`, {
          method: 'DELETE',
          signal: AbortSignal.timeout(5000),
        });
      } catch (err) {
        console.warn(`[WhatsAppBridge] /new: failed to delete session ${sessionId} from DB:`, err);
      }

      await this.sendFormattedMessage(senderJid, 'Conversation reset. Your next message starts a fresh session.');
      return;
    }

    if (action.type === 'model') {
      const agentId = action.agentId ?? this.whatsappConfig?.defaultAgentId ?? this.getFirstAgentId();
      if (!agentId) {
        await this.sendFormattedMessage(senderJid, 'No active conversation. Send a message first, then use /model.');
        return;
      }

      const sessionId = `whatsapp_${safeSender}_${agentId}`;

      if (csm?.isSessionActive(sessionId)) {
        csm.updateModel(sessionId, action.model);
        console.log(`[WhatsAppBridge] /model: changed model to ${action.model} for session ${sessionId}`);
      } else {
        console.log(`[WhatsAppBridge] /model: session ${sessionId} not active — model will apply on next message`);
      }

      this.senderModelOverrides.set(normalizeE164(sender), action.model);
      await this.sendFormattedMessage(senderJid, `Model changed to ${action.model}. This will apply to your next message.`);
      return;
    }

    if (action.type === 'modelfavs') {
      try {
        const res = await authFetch(`${this.config.apiUrl}/v1/settings/favorites`, {
          signal: AbortSignal.timeout(5000),
        });
        const data = await res.json() as { favorites?: string[] };
        const favs = data.favorites ?? [];
        if (favs.length === 0) {
          await this.sendFormattedMessage(senderJid, 'No favorite models set. Add favorites in the dashboard under Settings > Models.');
        } else {
          const list = favs.map((m: string, i: number) => `  ${i + 1}. ${m}`).join('\n');
          await this.sendFormattedMessage(senderJid, `Your favorite models:\n${list}\n\nUse /model <name> to switch.`);
        }
      } catch (err) {
        console.warn('[WhatsAppBridge] /modelfavs: failed to fetch favorites:', err);
        await this.sendFormattedMessage(senderJid, 'Failed to load favorite models. Please try again.');
      }
      return;
    }
  }

  // ── Agent processing ───────────────────────────────────────────────────

  private async processWithAgent(
    agentId: string,
    sender: string,
    text: string,
    rawMedia?: { name: string; mimeType: string; buffer: Buffer },
  ): Promise<string> {
    const csm = this.config.chatSessionManager;
    if (!csm) {
      return 'WhatsApp chat sessions are not yet configured. Please set up ChatSessionManager.';
    }

    // Strip non-alphanumeric chars from phone number for Docker-safe container names
    const safeSender = normalizeE164(sender).replace(/[^a-zA-Z0-9]/g, '');
    const sessionId = `whatsapp_${safeSender}_${agentId}`;

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
          const jid = this.phoneToJid(sender);
          if (jid) this.typingManager.startTyping(jid);
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
      // Use per-sender model override (set by /model) if available, else default
      const model = this.senderModelOverrides.get(normalizeE164(sender))
        ?? this.config.defaultConversationModel
        ?? 'openrouter/minimax/minimax-m2.5';

      // Start or resume session — creates the DB row for chat_sessions
      await csm.startSession({
        sessionId,
        agentId,
        model,
      });

      // Upload media AFTER session exists (avoids FK violation on chat_attachments)
      let attachments: Array<{ id: string; filename: string; mimeType: string; sizeBytes: number; isImage: boolean }> | undefined;
      if (rawMedia) {
        try {
          const { processChannelAttachments } = await import('@djinnbot/core');
          const apiBaseUrl = process.env.DJINNBOT_API_URL || 'http://api:8000';
          attachments = await processChannelAttachments(
            [{ url: '', name: rawMedia.name, mimeType: rawMedia.mimeType, buffer: rawMedia.buffer }],
            apiBaseUrl,
            sessionId,
            '[WhatsAppBridge]',
          );
          if (attachments.length === 0) attachments = undefined;
        } catch (err) {
          console.warn('[WhatsAppBridge] Failed to upload media:', err);
        }
      }

      // Persist user + placeholder assistant message to DB so the response
      // can be completed via currentMessageId at stepEnd.
      const messageId = await this.persistMessagePair(sessionId, text, model);

      // Send the user's message (with messageId so stepEnd persists the response)
      await csm.sendMessage(sessionId, text, model, messageId, attachments);

      // Wait for the agent to finish
      const response = await Promise.race([
        responsePromise,
        new Promise<string>((_, reject) =>
          setTimeout(() => reject(new Error('Agent response timeout (120s)')), 120_000)
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
      console.warn(`[WhatsAppBridge] Failed to create assistant message: HTTP ${res.status}`);
    } catch (err) {
      console.warn('[WhatsAppBridge] persistMessagePair failed:', err);
    }
    return undefined;
  }

  // ── Outbound messaging ─────────────────────────────────────────────────

  private async sendFormattedMessage(jid: string, text: string): Promise<void> {
    if (!this.socket) return;

    const formatted = markdownToWhatsApp(text);
    const messageChunks = chunkMessage(formatted);

    for (const chunk of messageChunks) {
      await this.socket.sendTextMessage(jid, chunk);
    }
  }

  /**
   * Send a message to a user from a specific agent.
   * Called via the agent MCP tool or pipeline notifications.
   */
  async sendToUser(agentId: string, phoneNumber: string, message: string): Promise<void> {
    const agent = this.config.agentRegistry.get(agentId);
    const prefix = agent
      ? `${agent.identity.emoji} ${agent.identity.name}\n`
      : '';
    const jid = this.phoneToJid(phoneNumber);
    if (jid) {
      // Set sticky routing so replies go back to this agent
      await this.router.setActiveConversation(normalizeE164(phoneNumber), agentId);
      await this.sendFormattedMessage(jid, `${prefix}${message}`);
    }
  }

  // ── Redis RPC handler (API server → Engine) ────────────────────────────

  private startRpcHandler(): void {
    const sub = this.rpcRedis.duplicate();
    sub.on('error', (err) => {
      console.error('[WhatsAppBridge] RPC subscriber error:', err);
    });
    sub.subscribe('whatsapp:rpc:request');
    console.log('[WhatsAppBridge] RPC handler listening on whatsapp:rpc:request');

    sub.on('message', (_channel: string, raw: string) => {
      void (async () => {
        let req: WhatsAppRpcRequest;
        try {
          req = JSON.parse(raw);
        } catch {
          return;
        }

        console.log(`[WhatsAppBridge] RPC request: method=${req.method} id=${req.id}`);
        let result: unknown;
        let error: string | undefined;

        try {
          switch (req.method) {
            case 'link': {
              // Ensure socket is running for linking
              if (!this.socket) {
                await this.ensureSocket();
              }
              // Return the latest QR code
              const qr = this.latestQrForRpc || await this.redis.get('whatsapp:qr:latest');
              if (!qr) {
                // Socket may still be generating QR — wait briefly
                await new Promise((r) => setTimeout(r, 3000));
                const retryQr = this.latestQrForRpc || await this.redis.get('whatsapp:qr:latest');
                result = { qr: retryQr || '' };
              } else {
                result = { qr };
              }
              break;
            }
            case 'pairing_code': {
              if (!this.socket) {
                await this.ensureSocket();
              }
              const phoneNumber = req.params.phoneNumber as string;
              if (!phoneNumber) {
                throw new Error('phoneNumber is required for pairing_code');
              }
              const code = await this.socket!.requestPairingCode(phoneNumber);
              result = { code };
              break;
            }
            case 'link_status': {
              if (this.socket?.isConnected()) {
                result = {
                  linked: true,
                  phoneNumber: this.socket.getPhoneNumber(),
                };
              } else {
                result = { linked: false, phoneNumber: null };
              }
              break;
            }
            case 'unlink': {
              if (this.socket) {
                await this.socket.logout();
                this.socket = null;
              }
              result = { unlinked: true };
              break;
            }
            case 'send': {
              if (!this.socket?.isConnected()) {
                throw new Error('WhatsApp is not connected. Enable WhatsApp integration first.');
              }
              const to = req.params.to as string;
              const message = req.params.message as string;
              const sendAgentId = req.params.agentId as string | undefined;
              if (sendAgentId) {
                await this.sendToUser(sendAgentId, to, message);
              } else {
                const jid = this.phoneToJid(to);
                if (jid) await this.sendFormattedMessage(jid, message);
              }
              result = { sent: true };
              break;
            }
            case 'health': {
              if (!this.socket) {
                result = { status: 'not_running' };
              } else {
                result = {
                  status: this.socket.getConnectionStatus(),
                  phoneNumber: this.socket.getPhoneNumber(),
                };
              }
              break;
            }
            default:
              error = `Unknown method: ${req.method}`;
          }
        } catch (err) {
          error = err instanceof Error ? err.message : String(err);
          console.error(`[WhatsAppBridge] RPC error for ${req.method}:`, error);
        }

        // Publish reply
        const reply = JSON.stringify({ id: req.id, result, error });
        await this.redis.publish(`whatsapp:rpc:reply:${req.id}`, reply);
      })();
    });
  }

  /**
   * Ensure the Baileys socket is running. For link RPCs we need the socket
   * even if WhatsApp isn't "enabled" yet (the point of linking is to enable it).
   */
  private async ensureSocket(): Promise<void> {
    if (this.socket) return;

    console.log('[WhatsAppBridge] Starting Baileys socket on demand for RPC...');

    // Initialize router if not done
    if (!this.router) {
      this.router = new ChannelRouter({
        agentRegistry: this.config.agentRegistry,
        redis: this.redis,
        defaultAgentId: this.whatsappConfig?.defaultAgentId ?? this.getFirstAgentId(),
        stickyTtlMs: (this.whatsappConfig?.stickyTtlMinutes ?? 30) * 60 * 1000,
        channelName: 'whatsapp',
      });
    }

    this.socket = new WhatsAppSocket(
      { authDir: this.config.authDir },
      {
        onQrCode: (qr) => {
          this.latestQrForRpc = qr;
          this.redis.setex('whatsapp:qr:latest', 30, qr).catch(() => {});
        },
        onConnectionUpdate: (status, phoneNumber) => {
          console.log(`[WhatsAppBridge] Connection: ${status}${phoneNumber ? ` (${phoneNumber})` : ''}`);
        },
        onMessage: (msg) => {
          void this.handleIncomingMessage(msg).catch((err) => {
            console.error('[WhatsAppBridge] Message handler error:', err);
          });
        },
      },
    );

    // Initialize typing manager if not done
    if (!this.typingManager) {
      this.typingManager = new ChannelTypingManager({
        keepaliveIntervalMs: TYPING_KEEPALIVE_MS,
        maxDurationMs: TYPING_MAX_DURATION_MS,
        sendTypingStart: async (recipient: string) => {
          if (this.socket) {
            await this.socket.sendPresenceUpdate(recipient, 'composing');
          }
        },
        sendTypingStop: async (recipient: string) => {
          if (this.socket) {
            await this.socket.sendPresenceUpdate(recipient, 'paused');
          }
        },
      });
    }

    await this.socket.connect();
    console.log('[WhatsAppBridge] Baileys socket ready');
  }

  // ── Config/allowlist loading ───────────────────────────────────────────

  private async loadConfig(): Promise<void> {
    try {
      const res = await authFetch(`${this.config.apiUrl}/v1/whatsapp/config`, {
        signal: AbortSignal.timeout(5000),
      });
      if (res.ok) {
        this.whatsappConfig = (await res.json()) as WhatsAppConfig;
      } else {
        console.warn(`[WhatsAppBridge] Failed to load config: ${res.status}`);
        this.whatsappConfig = {
          enabled: false,
          phoneNumber: null,
          linked: false,
          defaultAgentId: null,
          stickyTtlMinutes: 30,
          allowAll: false,
          ackEmoji: null,
        };
      }
    } catch (err) {
      console.warn('[WhatsAppBridge] Config load failed:', err);
      this.whatsappConfig = {
        enabled: false,
        phoneNumber: null,
        linked: false,
        defaultAgentId: null,
        stickyTtlMinutes: 30,
        allowAll: false,
        ackEmoji: null,
      };
    }
  }

  private async loadAllowlist(): Promise<ReturnType<typeof resolveAllowlist>> {
    try {
      const res = await authFetch(`${this.config.apiUrl}/v1/whatsapp/allowlist`, {
        signal: AbortSignal.timeout(5000),
      });
      if (res.ok) {
        const data = (await res.json()) as { entries: AllowlistDbEntry[] };
        return resolveAllowlist(data.entries);
      }
    } catch {
      // Fall through
    }
    return { entries: [], senderDefaults: new Map() };
  }

  // ── Helpers ────────────────────────────────────────────────────────────

  private getFirstAgentId(): string {
    const all = this.config.agentRegistry.getAll();
    return all.length > 0 ? all[0].id : 'unknown';
  }

  /**
   * Convert an E.164 phone number to a WhatsApp JID.
   * +15551234567 → 15551234567@s.whatsapp.net
   */
  private phoneToJid(phone: string): string | null {
    const normalized = normalizeE164(phone);
    if (!normalized) return null;
    // Strip leading +
    const digits = normalized.replace(/^\+/, '');
    return `${digits}@s.whatsapp.net`;
  }

  // ── Distributed lock ───────────────────────────────────────────────────

  private async acquireLock(): Promise<{
    acquired: boolean;
    release: () => Promise<void>;
  }> {
    const lockValue = `${process.pid}-${Date.now()}`;

    const result = await this.redis.set(LOCK_KEY, lockValue, 'PX', LOCK_TTL_MS, 'NX');

    if (result !== 'OK') {
      const holder = await this.redis.get(LOCK_KEY);
      console.warn(`[WhatsAppBridge] Lock held by ${holder ?? 'unknown'} — skipping WhatsApp startup`);
      return { acquired: false, release: async () => {} };
    }

    console.log(`[WhatsAppBridge] Acquired daemon lock: ${lockValue}`);

    // Renew TTL periodically
    const renewTimer = setInterval(async () => {
      try {
        const current = await this.redis.get(LOCK_KEY);
        if (current === lockValue) {
          await this.redis.pexpire(LOCK_KEY, LOCK_TTL_MS);
        }
      } catch (err) {
        console.warn('[WhatsAppBridge] Lock renewal failed:', err);
      }
    }, LOCK_RENEW_INTERVAL_MS);

    const release = async () => {
      clearInterval(renewTimer);
      try {
        const script = `
          if redis.call("get", KEYS[1]) == ARGV[1] then
            return redis.call("del", KEYS[1])
          else
            return 0
          end
        `;
        await this.redis.eval(script, 1, LOCK_KEY, lockValue);
        console.log('[WhatsAppBridge] Released daemon lock');
      } catch (err) {
        console.warn('[WhatsAppBridge] Lock release failed:', err);
      }
    };

    return { acquired: true, release };
  }
}
