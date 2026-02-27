/**
 * SignalBridge — top-level coordinator for Signal integration.
 *
 * Manages the full lifecycle:
 *   1. Acquire Redis distributed lock (single-writer)
 *   2. Spawn signal-cli daemon as a child process
 *   3. Connect to SSE event stream for incoming messages
 *   4. Route messages to agents via SignalRouter
 *   5. Manage typing indicators during agent processing
 *   6. Send responses back through signal-cli
 *   7. Handle Redis RPC requests from the API server (link, send, etc.)
 *
 * Mirrors the SlackBridge pattern but with a shared phone number model.
 */

import { Redis } from 'ioredis';
import type {
  AgentRegistry,
  EventBus,
} from '@djinnbot/core';
import type { ChatSessionManager } from '@djinnbot/core/chat';
import { SignalClient } from './signal-client.js';
import {
  spawnSignalDaemon,
  acquireSignalDaemonLock,
  waitForDaemonReady,
  type SignalDaemonHandle,
} from './signal-daemon.js';
import { SignalRouter } from './signal-router.js';
import { SignalTypingManager } from './signal-typing-manager.js';
import { isSenderAllowed, resolveAllowlist, normalizeE164 } from './allowlist.js';
import { markdownToSignalText } from './signal-format.js';
import type {
  SignalBridgeConfig,
  SignalConfig,
  SignalEnvelope,
  SignalRpcRequest,
  AllowlistDbEntry,
} from './types.js';

export interface SignalBridgeFullConfig extends SignalBridgeConfig {
  eventBus: EventBus;
  agentRegistry: AgentRegistry;
  chatSessionManager?: ChatSessionManager;
}

export class SignalBridge {
  private config: SignalBridgeFullConfig;
  private redis: Redis;
  private rpcRedis: Redis;
  private client!: SignalClient;
  private router!: SignalRouter;
  private typingManager!: SignalTypingManager;
  private daemonHandle: SignalDaemonHandle | null = null;
  private lockRelease: (() => Promise<void>) | null = null;
  private abortController = new AbortController();
  private signalConfig: SignalConfig | null = null;
  private account: string | undefined;

  constructor(config: SignalBridgeFullConfig) {
    this.config = config;
    this.redis = new Redis(config.redisUrl);
    this.rpcRedis = new Redis(config.redisUrl);
  }

  // ── Lifecycle ──────────────────────────────────────────────────────────

  async start(): Promise<void> {
    // 1. Acquire distributed lock
    const lock = await acquireSignalDaemonLock(this.redis);
    if (!lock.acquired) {
      console.log('[SignalBridge] Another engine instance holds the Signal lock — skipping');
      return;
    }
    this.lockRelease = lock.release;

    // 2. Load config from API
    await this.loadConfig();
    if (!this.signalConfig?.enabled) {
      console.log('[SignalBridge] Signal integration is disabled');
      return;
    }

    this.account = this.signalConfig.phoneNumber ?? undefined;

    // 3. Spawn signal-cli daemon
    const baseUrl = `http://127.0.0.1:${this.config.httpPort ?? 8820}`;
    this.client = new SignalClient({ baseUrl });

    this.daemonHandle = spawnSignalDaemon({
      cliPath: this.config.signalCliPath ?? 'signal-cli',
      configDir: this.config.signalDataDir,
      account: this.account,
      httpPort: this.config.httpPort ?? 8820,
      sendReadReceipts: true,
    });

    // Watch for unexpected daemon exit
    void this.daemonHandle.exited.then((exit) => {
      if (!this.abortController.signal.aborted) {
        console.error(`[SignalBridge] signal-cli daemon exited unexpectedly: code=${exit.code} signal=${exit.signal}`);
      }
    });

    // 4. Wait for daemon to be ready
    try {
      await waitForDaemonReady({
        baseUrl,
        timeoutMs: 30_000,
        abortSignal: this.abortController.signal,
      });
    } catch (err) {
      console.error('[SignalBridge] signal-cli daemon failed to start:', err);
      this.daemonHandle.stop();
      await this.lockRelease();
      return;
    }

    // 5. Initialize router and typing manager
    this.router = new SignalRouter({
      agentRegistry: this.config.agentRegistry,
      redis: this.redis,
      defaultAgentId: this.signalConfig.defaultAgentId ?? this.getFirstAgentId(),
      stickyTtlMs: (this.signalConfig.stickyTtlMinutes ?? 30) * 60 * 1000,
    });

    this.typingManager = new SignalTypingManager(this.client, this.account);

    // 6. Start SSE listener (runs in background)
    this.startSseLoop();

    // 7. Start Redis RPC handler (API→Engine commands)
    this.startRpcHandler();

    console.log(
      `[SignalBridge] Started — account=${this.account ?? 'not linked'} ` +
      `defaultAgent=${this.signalConfig.defaultAgentId ?? 'none'}`
    );
  }

  async shutdown(): Promise<void> {
    console.log('[SignalBridge] Shutting down...');
    this.abortController.abort();
    this.typingManager?.stopAll();
    this.daemonHandle?.stop();

    if (this.lockRelease) {
      await this.lockRelease();
    }

    this.redis.disconnect();
    this.rpcRedis.disconnect();
    console.log('[SignalBridge] Shutdown complete');
  }

  // ── SSE message loop ───────────────────────────────────────────────────

  private startSseLoop(): void {
    const run = async () => {
      while (!this.abortController.signal.aborted) {
        try {
          await this.client.streamEvents({
            account: this.account,
            signal: this.abortController.signal,
            onEvent: (event) => {
              if (event.data) {
                void this.handleSseEvent(event.data).catch((err) => {
                  console.error('[SignalBridge] SSE event handler error:', err);
                });
              }
            },
          });
        } catch (err) {
          if (this.abortController.signal.aborted) return;
          console.warn('[SignalBridge] SSE stream disconnected, reconnecting in 3s:', err);
          await new Promise((r) => setTimeout(r, 3000));
        }
      }
    };
    void run();
  }

  private async handleSseEvent(data: string): Promise<void> {
    let envelope: SignalEnvelope;
    try {
      envelope = JSON.parse(data);
    } catch {
      return; // Malformed event
    }

    // Only handle data messages (not receipts, typing, sync)
    if (!envelope.dataMessage?.message) return;

    const sender = envelope.sourceNumber ?? envelope.source;
    if (!sender) return;

    // Skip group messages for now (DM-only in v1)
    if (envelope.dataMessage.groupInfo) return;

    const messageText = envelope.dataMessage.message;
    const messageTimestamp = envelope.dataMessage.timestamp ?? envelope.timestamp;

    await this.handleIncomingMessage(sender, messageText, messageTimestamp);
  }

  private async handleIncomingMessage(
    sender: string,
    text: string,
    timestamp?: number,
  ): Promise<void> {
    const normalized = normalizeE164(sender);
    console.log(`[SignalBridge] Incoming from ${normalized}: "${text.slice(0, 80)}${text.length > 80 ? '...' : ''}"`);

    // 1. Allowlist check
    const { entries, senderDefaults } = await this.loadAllowlist();
    const allowed = isSenderAllowed(normalized, entries, this.signalConfig?.allowAll ?? false);
    if (!allowed) {
      console.log(`[SignalBridge] Sender ${normalized} not in allowlist — ignoring`);
      return;
    }

    // 2. Send read receipt
    if (timestamp) {
      this.client.sendReadReceipt(normalized, timestamp, { account: this.account }).catch(() => {});
    }

    // 3. Check for built-in commands
    const cmd = await this.router.handleCommand(normalized, text);
    if (cmd.handled) {
      if (cmd.response) {
        await this.sendFormattedMessage(normalized, cmd.response);
      }
      return;
    }

    // 4. Route to agent
    const route = await this.router.route(normalized, text, senderDefaults);
    console.log(`[SignalBridge] Routed to ${route.agentId} (reason: ${route.reason})`);

    // 5. Start typing indicator
    this.typingManager.startTyping(normalized);

    // 6. Process with agent
    try {
      const response = await this.processWithAgent(route.agentId, normalized, text);
      this.typingManager.stopTyping(normalized);
      await this.sendFormattedMessage(normalized, response);
    } catch (err) {
      this.typingManager.stopTyping(normalized);
      console.error(`[SignalBridge] Agent ${route.agentId} processing failed:`, err);
      await this.client.sendMessage(
        normalized,
        'Sorry, something went wrong processing your message. Please try again.',
        { account: this.account },
      );
    }
  }

  // ── Agent processing ───────────────────────────────────────────────────

  /**
   * Process a message with an agent's ChatSessionManager.
   * Returns the agent's text response.
   */
  private async processWithAgent(
    agentId: string,
    sender: string,
    text: string,
  ): Promise<string> {
    const csm = this.config.chatSessionManager;
    if (!csm) {
      return 'Signal chat sessions are not yet configured. Please set up ChatSessionManager.';
    }

    const sessionId = `signal_${normalizeE164(sender)}_${agentId}`;

    // Collect response chunks
    const chunks: string[] = [];
    let resolveResponse!: (value: string) => void;
    let rejectResponse!: (err: Error) => void;
    const responsePromise = new Promise<string>((resolve, reject) => {
      resolveResponse = resolve;
      rejectResponse = reject;
    });

    // Register temporary hooks for this session
    const hookCleanup = csm.registerHooks({
      onOutput: (sid: string, chunk: string) => {
        if (sid === sessionId) chunks.push(chunk);
      },
      onToolStart: (sid: string, toolName: string) => {
        if (sid === sessionId) {
          // Keep typing alive during tool execution
          this.typingManager.startTyping(sender);
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
        agentId,
        model: this.config.defaultConversationModel ?? 'openrouter/minimax/minimax-m2.5',
      });

      // Send the user's message
      await csm.sendMessage(sessionId, text);

      // Wait for the agent to finish
      const response = await Promise.race([
        responsePromise,
        new Promise<string>((_, reject) =>
          setTimeout(() => reject(new Error('Agent response timeout (120s)')), 120_000)
        ),
      ]);

      return response || '(No response from agent)';
    } finally {
      // Hook cleanup is handled by ChatSessionManager's session lifecycle
    }
  }

  // ── Outbound messaging ─────────────────────────────────────────────────

  /**
   * Send a message with markdown converted to Signal text styles.
   */
  private async sendFormattedMessage(to: string, text: string): Promise<void> {
    const { text: formatted, styles } = markdownToSignalText(text);
    await this.client.sendMessage(to, formatted, {
      account: this.account,
      textStyles: styles.length > 0 ? styles : undefined,
    });
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
    await this.sendFormattedMessage(normalizeE164(phoneNumber), `${prefix}${message}`);
  }

  // ── Redis RPC handler (API server → Engine) ────────────────────────────

  private startRpcHandler(): void {
    const sub = this.rpcRedis.duplicate();
    sub.subscribe('signal:rpc:request');

    sub.on('message', (_channel: string, raw: string) => {
      void (async () => {
        let req: SignalRpcRequest;
        try {
          req = JSON.parse(raw);
        } catch {
          return;
        }

        let result: unknown;
        let error: string | undefined;

        try {
          switch (req.method) {
            case 'link': {
              const deviceName = (req.params.deviceName as string) ?? 'DjinnBot';
              const linkResult = await this.client.startLink(deviceName);
              result = linkResult;
              break;
            }
            case 'link_status': {
              const accounts = await this.client.listAccounts();
              const linked = accounts.length > 0;
              result = {
                linked,
                phoneNumber: linked ? accounts[0].number : null,
              };
              break;
            }
            case 'send': {
              const to = req.params.to as string;
              const message = req.params.message as string;
              const agentId = req.params.agentId as string | undefined;
              if (agentId) {
                await this.sendToUser(agentId, to, message);
              } else {
                await this.sendFormattedMessage(normalizeE164(to), message);
              }
              result = { sent: true };
              break;
            }
            case 'health': {
              result = await this.client.check();
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
        await this.redis.publish(`signal:rpc:reply:${req.id}`, reply);
      })();
    });
  }

  // ── Config/allowlist loading ───────────────────────────────────────────

  private async loadConfig(): Promise<void> {
    try {
      const res = await fetch(`${this.config.apiUrl}/v1/signal/config`, {
        signal: AbortSignal.timeout(5000),
      });
      if (res.ok) {
        this.signalConfig = (await res.json()) as SignalConfig;
      } else {
        console.warn(`[SignalBridge] Failed to load config: ${res.status}`);
        this.signalConfig = {
          enabled: false,
          phoneNumber: null,
          linked: false,
          defaultAgentId: null,
          stickyTtlMinutes: 30,
          allowAll: false,
        };
      }
    } catch (err) {
      console.warn('[SignalBridge] Config load failed:', err);
      this.signalConfig = {
        enabled: false,
        phoneNumber: null,
        linked: false,
        defaultAgentId: null,
        stickyTtlMinutes: 30,
        allowAll: false,
      };
    }
  }

  private async loadAllowlist(): Promise<ReturnType<typeof resolveAllowlist>> {
    try {
      const res = await fetch(`${this.config.apiUrl}/v1/signal/allowlist`, {
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

  private getFirstAgentId(): string {
    const all = this.config.agentRegistry.getAll();
    return all.length > 0 ? all[0].id : 'unknown';
  }

  // ── Linking (proxied from API) ─────────────────────────────────────────

  async startLinking(deviceName: string): Promise<{ uri: string }> {
    return this.client.startLink(deviceName);
  }

  async getLinkStatus(): Promise<{ linked: boolean; phoneNumber?: string }> {
    const accounts = await this.client.listAccounts();
    return {
      linked: accounts.length > 0,
      phoneNumber: accounts[0]?.number,
    };
  }
}
