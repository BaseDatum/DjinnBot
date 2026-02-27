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
import {
  type AgentRegistry,
  type EventBus,
  authFetch,
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
  /** Separate abort controller for the SSE loop — allows restarting SSE without full shutdown. */
  private sseAbortController: AbortController | null = null;
  private signalConfig: SignalConfig | null = null;
  private account: string | undefined;
  /** Tracks whether we're running in full mode (SSE + routing) vs receive-only. */
  private fullModeActive = false;

  constructor(config: SignalBridgeFullConfig) {
    this.config = config;
    this.redis = new Redis(config.redisUrl);
    this.rpcRedis = new Redis(config.redisUrl);
  }

  /** Inject the ChatSessionManager after construction (same pattern as SlackBridge). */
  setChatSessionManager(csm: ChatSessionManager): void {
    this.config.chatSessionManager = csm;
    console.log('[SignalBridge] ChatSessionManager injected');
  }

  // ── Lifecycle ──────────────────────────────────────────────────────────

  async start(): Promise<void> {
    // 1. Acquire distributed lock (retry up to 5 times with backoff —
    //    after a container restart the old heartbeat may take up to 30s to expire)
    let lock: { acquired: boolean; release: () => Promise<void> } | null = null;
    for (let attempt = 1; attempt <= 5; attempt++) {
      lock = await acquireSignalDaemonLock(this.redis);
      if (lock.acquired) break;
      console.log(`[SignalBridge] Lock not acquired (attempt ${attempt}/5) — retrying in ${attempt * 5}s...`);
      await new Promise((r) => setTimeout(r, attempt * 5000));
    }
    if (!lock?.acquired) {
      console.error('[SignalBridge] Could not acquire Signal lock after 5 attempts — skipping');
      return;
    }
    this.lockRelease = lock.release;

    try {
      // 2. Always start Redis RPC handler so the API can send link/status
      //    commands even before Signal is fully enabled. This avoids the
      //    chicken-and-egg problem where linking requires the RPC handler
      //    but the handler only started after linking succeeded.
      this.startRpcHandler();

      // 3. Load config from API
      await this.loadConfig();

      if (!this.signalConfig?.enabled) {
        if (this.signalConfig?.linked && this.signalConfig?.phoneNumber) {
          // Account is linked but integration is disabled.
          // Still start the daemon so signal-cli keeps receiving messages
          // (Signal may deregister inactive linked devices). We just skip
          // the SSE listener and message routing.
          console.log('[SignalBridge] Signal disabled but account linked — starting daemon for message receive only');
          await this.startDaemonReceiveOnly();
        } else {
          console.log('[SignalBridge] Signal integration is disabled — RPC handler active for linking');
        }
        return;
      }

      await this.startDaemon();
    } catch (err) {
      console.error('[SignalBridge] start() failed, releasing lock:', err);
      await this.lockRelease().catch(() => {});
      this.lockRelease = null;
      throw err;
    }
  }

  /**
   * Start the signal-cli daemon, SSE listener, and message routing.
   * Called from start() when Signal is enabled, or from the RPC handler
   * after a successful link operation enables the integration.
   */
  private async startDaemon(): Promise<void> {
    this.account = this.signalConfig?.phoneNumber ?? undefined;

    // Spawn signal-cli daemon
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

    // Wait for daemon to be ready
    try {
      await waitForDaemonReady({
        baseUrl,
        timeoutMs: 30_000,
        abortSignal: this.abortController.signal,
      });
    } catch (err) {
      console.error('[SignalBridge] signal-cli daemon failed to start:', err);
      this.daemonHandle.stop();
      this.daemonHandle = null;
      return;
    }

    // Initialize router and typing manager
    this.router = new SignalRouter({
      agentRegistry: this.config.agentRegistry,
      redis: this.redis,
      defaultAgentId: this.signalConfig?.defaultAgentId ?? this.getFirstAgentId(),
      stickyTtlMs: (this.signalConfig?.stickyTtlMinutes ?? 30) * 60 * 1000,
    });

    this.typingManager = new SignalTypingManager(this.client, this.account);

    // Start SSE listener (runs in background, uses its own abort controller)
    this.sseAbortController = new AbortController();
    this.startSseLoop();
    this.fullModeActive = true;

    console.log(
      `[SignalBridge] Daemon started — account=${this.account ?? 'not linked'} ` +
      `defaultAgent=${this.signalConfig?.defaultAgentId ?? 'none'}`
    );
  }

  /**
   * Start the daemon in receive-only mode — keeps signal-cli connected so
   * messages are drained and the account stays active, but does NOT route
   * messages to agents or start the SSE listener for processing.
   */
  private async startDaemonReceiveOnly(): Promise<void> {
    this.account = this.signalConfig?.phoneNumber ?? undefined;
    const baseUrl = `http://127.0.0.1:${this.config.httpPort ?? 8820}`;
    this.client = new SignalClient({ baseUrl });

    this.daemonHandle = spawnSignalDaemon({
      cliPath: this.config.signalCliPath ?? 'signal-cli',
      configDir: this.config.signalDataDir,
      account: this.account,
      httpPort: this.config.httpPort ?? 8820,
      sendReadReceipts: true,
    });

    void this.daemonHandle.exited.then((exit) => {
      if (!this.abortController.signal.aborted) {
        console.error(`[SignalBridge] signal-cli daemon (receive-only) exited: code=${exit.code} signal=${exit.signal}`);
      }
    });

    try {
      await waitForDaemonReady({
        baseUrl,
        timeoutMs: 30_000,
        abortSignal: this.abortController.signal,
      });
      console.log(`[SignalBridge] Daemon running in receive-only mode — account=${this.account}`);
    } catch (err) {
      console.error('[SignalBridge] signal-cli daemon (receive-only) failed to start:', err);
      this.daemonHandle.stop();
      this.daemonHandle = null;
    }
  }

  /** Whether the signal-cli daemon is running and ready for RPC. */
  private get isDaemonRunning(): boolean {
    return this.client != null && this.daemonHandle != null;
  }

  async shutdown(): Promise<void> {
    console.log('[SignalBridge] Shutting down...');
    this.stopFullMode();
    this.abortController.abort();
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
    const sse = this.sseAbortController;
    if (!sse) return;

    const run = async () => {
      while (!sse.signal.aborted && !this.abortController.signal.aborted) {
        try {
          console.log(`[SignalBridge] Connecting SSE stream for account=${this.account ?? 'all'}...`);
          await this.client.streamEvents({
            account: this.account,
            signal: sse.signal,
            onEvent: (event) => {
              if (event.data) {
                void this.handleSseEvent(event.data).catch((err) => {
                  console.error('[SignalBridge] SSE event handler error:', err);
                });
              }
            },
          });
        } catch (err) {
          if (sse.signal.aborted || this.abortController.signal.aborted) return;
          console.warn('[SignalBridge] SSE stream disconnected, reconnecting in 3s:', err);
          await new Promise((r) => setTimeout(r, 3000));
        }
      }
    };
    void run();
  }

  /** Stop the SSE loop and routing without killing the daemon. */
  private stopFullMode(): void {
    if (!this.fullModeActive) return;
    console.log('[SignalBridge] Stopping full mode (SSE + routing)...');
    this.sseAbortController?.abort();
    this.sseAbortController = null;
    this.typingManager?.stopAll();
    this.fullModeActive = false;
  }

  /**
   * Reload config from the API and transition between modes:
   *  - disabled + linked → receive-only (daemon running, no routing)
   *  - enabled + linked → full mode (daemon + SSE + routing)
   *  - disabled + not linked → daemon stopped
   */
  async reloadConfig(): Promise<void> {
    const prevEnabled = this.signalConfig?.enabled ?? false;
    await this.loadConfig();
    const nowEnabled = this.signalConfig?.enabled ?? false;
    const nowLinked = this.signalConfig?.linked && this.signalConfig?.phoneNumber;

    console.log(`[SignalBridge] Config reloaded — enabled: ${prevEnabled} → ${nowEnabled}, linked: ${!!nowLinked}`);

    if (nowEnabled && nowLinked && !this.fullModeActive) {
      // Transition to full mode
      // Stop SSE if somehow running
      this.stopFullMode();

      // Ensure daemon is running
      if (!this.isDaemonRunning) {
        await this.startDaemonReceiveOnly();
      }

      if (!this.isDaemonRunning) {
        console.error('[SignalBridge] Cannot enter full mode — daemon failed to start');
        return;
      }

      // Set account from config
      this.account = this.signalConfig?.phoneNumber ?? undefined;

      // Add router, typing, and SSE on top of the running daemon
      this.router = new SignalRouter({
        agentRegistry: this.config.agentRegistry,
        redis: this.redis,
        defaultAgentId: this.signalConfig?.defaultAgentId ?? this.getFirstAgentId(),
        stickyTtlMs: (this.signalConfig?.stickyTtlMinutes ?? 30) * 60 * 1000,
      });
      this.typingManager = new SignalTypingManager(this.client, this.account);
      this.sseAbortController = new AbortController();
      this.startSseLoop();
      this.fullModeActive = true;

      console.log('[SignalBridge] Transitioned to full mode');
    } else if (!nowEnabled && this.fullModeActive) {
      // Transition from full → receive-only (keep daemon, stop routing)
      this.stopFullMode();
      console.log('[SignalBridge] Transitioned to receive-only mode');
    } else if (nowEnabled && this.fullModeActive) {
      // Already in full mode — update router settings in case they changed
      this.router = new SignalRouter({
        agentRegistry: this.config.agentRegistry,
        redis: this.redis,
        defaultAgentId: this.signalConfig?.defaultAgentId ?? this.getFirstAgentId(),
        stickyTtlMs: (this.signalConfig?.stickyTtlMinutes ?? 30) * 60 * 1000,
      });
      console.log('[SignalBridge] Updated router settings');
    }
  }

  private async handleSseEvent(data: string): Promise<void> {
    let parsed: any;
    try {
      parsed = JSON.parse(data);
    } catch {
      return; // Malformed event
    }

    // Uncomment for envelope debugging:
    // console.log(`[SignalBridge] SSE raw: ${data.slice(0, 500)}`);

    // signal-cli SSE events may be:
    //   JSON-RPC: {"jsonrpc":"2.0","method":"receive","params":{"envelope":{...}}}
    //   Or nested: {"envelope":{...}}
    //   Or flat: {"sourceNumber":...,"dataMessage":{...}}
    const envelope: SignalEnvelope =
      parsed?.params?.envelope ??
      parsed?.envelope ??
      parsed;

    // Log all SSE events for debugging
    const eventType = envelope.dataMessage ? 'dataMessage' :
      envelope.receiptMessage ? 'receipt' :
      envelope.typingMessage ? 'typing' :
      envelope.syncMessage ? 'sync' : 'unknown';
    console.log(`[SignalBridge] SSE event: type=${eventType} from=${envelope.sourceNumber ?? envelope.source ?? '?'}`);

    // Only handle data messages (not receipts, typing, sync)
    if (!envelope.dataMessage) return;

    // Need either text or attachments — skip empty data messages
    const hasText = !!envelope.dataMessage.message;
    const hasAttachments = !!(envelope.dataMessage.attachments && envelope.dataMessage.attachments.length > 0);
    if (!hasText && !hasAttachments) return;

    const sender = envelope.sourceNumber ?? envelope.source;
    if (!sender) return;

    // Skip group messages for now (DM-only in v1)
    if (envelope.dataMessage.groupInfo) return;

    const messageText = envelope.dataMessage.message ?? '';
    const messageTimestamp = envelope.dataMessage.timestamp ?? envelope.timestamp;

    await this.handleIncomingMessage(
      sender,
      messageText,
      messageTimestamp,
      envelope.dataMessage.attachments,
    );
  }

  private async handleIncomingMessage(
    sender: string,
    text: string,
    timestamp?: number,
    signalAttachments?: Array<{ id?: string; contentType?: string; filename?: string; size?: number }>,
  ): Promise<void> {
    const normalized = normalizeE164(sender);
    const displayText = text || (signalAttachments?.length ? `[${signalAttachments.length} attachment(s)]` : '');
    console.log(`[SignalBridge] Incoming from ${normalized}: "${displayText.slice(0, 80)}${displayText.length > 80 ? '...' : ''}"`);

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

    // 3. Check for built-in commands (only if there's text)
    if (text) {
      const cmd = await this.router.handleCommand(normalized, text);
      if (cmd.handled) {
        if (cmd.response) {
          await this.sendFormattedMessage(normalized, cmd.response);
        }
        return;
      }
    }

    // 4. Route to agent
    const route = await this.router.route(normalized, text || '[attachment]', senderDefaults);
    console.log(`[SignalBridge] Routed to ${route.agentId} (reason: ${route.reason})`);

    // 5. Start typing indicator
    this.typingManager.startTyping(normalized);

    // 6. Pre-read Signal attachment files from disk (raw buffers).
    //    Actual upload to DjinnBot storage happens inside processWithAgent()
    //    AFTER the session is created (avoids FK violation on chat_attachments).
    let rawFiles: Array<{ name: string; mimeType: string; buffer: Buffer }> | undefined;
    if (signalAttachments && signalAttachments.length > 0) {
      const { readFile } = await import('node:fs/promises');
      const { join } = await import('node:path');
      const signalDataDir = this.config.signalDataDir;

      rawFiles = [];
      for (const a of signalAttachments) {
        if (!a.id) continue;
        try {
          const attachmentPath = join(signalDataDir, 'attachments', a.id);
          const buffer = await readFile(attachmentPath);
          rawFiles.push({
            name: a.filename || `attachment_${a.id}`,
            mimeType: a.contentType || 'application/octet-stream',
            buffer,
          });
        } catch (err) {
          console.warn(`[SignalBridge] Could not read attachment file ${a.id}:`, err);
        }
      }
      if (rawFiles.length === 0) rawFiles = undefined;
    }

    // 7. Process with agent (session created inside, then attachments uploaded)
    try {
      const response = await this.processWithAgent(route.agentId, normalized, text || '[Voice/media message — see attachments]', rawFiles);
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
    rawFiles?: Array<{ name: string; mimeType: string; buffer: Buffer }>,
  ): Promise<string> {
    const csm = this.config.chatSessionManager;
    if (!csm) {
      return 'Signal chat sessions are not yet configured. Please set up ChatSessionManager.';
    }

    // Strip non-alphanumeric chars from phone number for Docker-safe container names
    const safeSender = normalizeE164(sender).replace(/[^a-zA-Z0-9]/g, '');
    const sessionId = `signal_${safeSender}_${agentId}`;

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
      const model = this.config.defaultConversationModel ?? 'openrouter/minimax/minimax-m2.5';

      // Start or resume session — this creates the DB row for chat_sessions
      await csm.startSession({
        sessionId,
        agentId,
        model,
      });

      // Upload attachments AFTER session exists (avoids FK violation on chat_attachments)
      let attachments: Array<{ id: string; filename: string; mimeType: string; sizeBytes: number; isImage: boolean }> | undefined;
      if (rawFiles && rawFiles.length > 0) {
        const { processChannelAttachments } = await import('@djinnbot/core');
        const apiBaseUrl = process.env.DJINNBOT_API_URL || 'http://api:8000';
        attachments = await processChannelAttachments(
          rawFiles.map(f => ({ url: '', name: f.name, mimeType: f.mimeType, buffer: f.buffer })),
          apiBaseUrl,
          sessionId,
          `[SignalBridge:${agentId}]`,
        );
        if (attachments.length === 0) attachments = undefined;
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
      console.warn(`[SignalBridge] Failed to create assistant message: HTTP ${res.status}`);
    } catch (err) {
      console.warn('[SignalBridge] persistMessagePair failed:', err);
    }
    return undefined;
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

  /**
   * Ensure the signal-cli daemon is running. For link/link_status RPCs we
   * need the daemon even if Signal isn't "enabled" yet (the whole point of
   * linking is to enable it). This lazily starts the daemon on first need.
   */
  private async ensureDaemon(): Promise<void> {
    if (this.isDaemonRunning) return;

    console.log('[SignalBridge] Starting signal-cli daemon on demand for RPC...');
    const baseUrl = `http://127.0.0.1:${this.config.httpPort ?? 8820}`;
    this.client = new SignalClient({ baseUrl });

    this.daemonHandle = spawnSignalDaemon({
      cliPath: this.config.signalCliPath ?? 'signal-cli',
      configDir: this.config.signalDataDir,
      account: this.account,
      httpPort: this.config.httpPort ?? 8820,
      sendReadReceipts: true,
    });

    void this.daemonHandle.exited.then((exit) => {
      if (!this.abortController.signal.aborted) {
        console.error(`[SignalBridge] signal-cli daemon exited unexpectedly: code=${exit.code} signal=${exit.signal}`);
      }
    });

    await waitForDaemonReady({
      baseUrl,
      timeoutMs: 30_000,
      abortSignal: this.abortController.signal,
    });
    console.log('[SignalBridge] signal-cli daemon ready');
  }

  private startRpcHandler(): void {
    const sub = this.rpcRedis.duplicate();
    sub.on('error', (err) => {
      console.error('[SignalBridge] RPC subscriber error:', err);
    });
    sub.subscribe('signal:rpc:request');
    console.log('[SignalBridge] RPC handler listening on signal:rpc:request');

    sub.on('message', (_channel: string, raw: string) => {
      void (async () => {
        let req: SignalRpcRequest;
        try {
          req = JSON.parse(raw);
        } catch {
          return;
        }

        console.log(`[SignalBridge] RPC request: method=${req.method} id=${req.id}`);
        let result: unknown;
        let error: string | undefined;

        try {
          switch (req.method) {
            case 'link': {
              // Ensure daemon is running — linking needs it even if Signal
              // integration hasn't been enabled yet.
              await this.ensureDaemon();
              const deviceName = (req.params.deviceName as string) ?? 'DjinnBot';
              console.log('[SignalBridge] Calling startLink...');
              const linkResult = await this.client.startLink();
              console.log('[SignalBridge] startLink returned URI, calling finishLink in background...');
              result = linkResult;

              // finishLink blocks until the user scans the QR code on their
              // primary device, then completes provisioning. Fire it in the
              // background so we can return the URI to the dashboard immediately.
              // The device name (shown in Signal's linked devices list) is set here.
              this.client.finishLink(linkResult.uri, deviceName).then(
                (fin) => console.log(`[SignalBridge] finishLink completed — account: ${fin.account}`),
                (err) => console.error('[SignalBridge] finishLink failed:', err),
              );
              break;
            }
            case 'link_status': {
              await this.ensureDaemon();
              const accounts = await this.client.listAccounts();
              const linked = accounts.length > 0;
              result = {
                linked,
                phoneNumber: linked ? accounts[0].number : null,
              };
              break;
            }
            case 'unlink': {
              await this.ensureDaemon();
              const accounts = await this.client.listAccounts();
              if (accounts.length === 0) {
                throw new Error('No linked account to unlink');
              }
              const account = accounts[0].number;
              console.log(`[SignalBridge] Unlinking account ${account}...`);
              await this.client.unlink(account);
              console.log('[SignalBridge] Account unlinked successfully');
              this.account = undefined;
              result = { unlinked: true };
              break;
            }
            case 'reload_config': {
              await this.reloadConfig();
              result = { reloaded: true };
              break;
            }
            case 'send': {
              if (!this.isDaemonRunning) {
                throw new Error('Signal daemon is not running. Enable Signal integration first.');
              }
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
              if (!this.isDaemonRunning) {
                result = { status: 'not_running' };
              } else {
                result = await this.client.check();
              }
              break;
            }
            default:
              error = `Unknown method: ${req.method}`;
          }
        } catch (err) {
          error = err instanceof Error ? err.message : String(err);
          console.error(`[SignalBridge] RPC error for ${req.method}:`, error);
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
      const res = await authFetch(`${this.config.apiUrl}/v1/signal/config`, {
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
      const res = await authFetch(`${this.config.apiUrl}/v1/signal/allowlist`, {
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

  async startLinking(_deviceName?: string): Promise<{ uri: string }> {
    return this.client.startLink();
  }

  async getLinkStatus(): Promise<{ linked: boolean; phoneNumber?: string }> {
    const accounts = await this.client.listAccounts();
    return {
      linked: accounts.length > 0,
      phoneNumber: accounts[0]?.number,
    };
  }
}
