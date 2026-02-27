/**
 * WhatsAppSocket — Baileys wrapper for WhatsApp Web multi-device protocol.
 *
 * Handles connection, QR linking, pairing codes, messaging, presence
 * updates (typing indicators), read receipts, and reactions.
 *
 * Auth state is persisted to disk (JuiceFS) via Baileys' useMultiFileAuthState.
 */

import makeWASocket, {
  useMultiFileAuthState,
  DisconnectReason,
  fetchLatestBaileysVersion,
  makeCacheableSignalKeyStore,
  type WASocket,
  type BaileysEventMap,
  type ConnectionState,
  type WAMessageKey,
  type AnyMessageContent,
} from '@whiskeysockets/baileys';
import { Boom } from '@hapi/boom';

export interface WhatsAppSocketConfig {
  /** Directory path for persistent auth state (creds.json + keys) */
  authDir: string;
}

export type ConnectionStatus = 'disconnected' | 'connecting' | 'open';

export interface WhatsAppSocketEvents {
  onQrCode: (qr: string) => void;
  onConnectionUpdate: (status: ConnectionStatus, phoneNumber?: string) => void;
  onMessage: (message: {
    senderJid: string;
    senderPhone: string;
    text: string;
    messageKey: WAMessageKey;
    timestamp: number;
    isGroup: boolean;
    groupJid?: string;
  }) => void;
}

export class WhatsAppSocket {
  private sock: WASocket | null = null;
  private config: WhatsAppSocketConfig;
  private events: WhatsAppSocketEvents;
  private connectionStatus: ConnectionStatus = 'disconnected';
  private latestQr: string | null = null;
  private phoneNumber: string | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private shouldReconnect = true;

  constructor(config: WhatsAppSocketConfig, events: WhatsAppSocketEvents) {
    this.config = config;
    this.events = events;
  }

  // ── Connection ─────────────────────────────────────────────────────────

  async connect(): Promise<void> {
    this.shouldReconnect = true;
    await this.createSocket();
  }

  async disconnect(): Promise<void> {
    this.shouldReconnect = false;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.sock) {
      this.sock.end(undefined);
      this.sock = null;
    }
    this.connectionStatus = 'disconnected';
  }

  getConnectionStatus(): ConnectionStatus {
    return this.connectionStatus;
  }

  getPhoneNumber(): string | null {
    return this.phoneNumber;
  }

  getLatestQr(): string | null {
    return this.latestQr;
  }

  isConnected(): boolean {
    return this.connectionStatus === 'open';
  }

  // ── Linking ────────────────────────────────────────────────────────────

  /**
   * Request a pairing code for phone-number-based linking.
   * The socket must be in a connecting state (after connect() is called).
   */
  async requestPairingCode(phoneNumber: string): Promise<string> {
    if (!this.sock) {
      throw new Error('WhatsApp socket not initialized. Call connect() first.');
    }
    // Strip non-digits and leading +
    const cleaned = phoneNumber.replace(/[^0-9]/g, '');
    const code = await this.sock.requestPairingCode(cleaned);
    return code;
  }

  // ── Messaging ──────────────────────────────────────────────────────────

  async sendMessage(jid: string, content: AnyMessageContent): Promise<void> {
    if (!this.sock) {
      throw new Error('WhatsApp socket not connected');
    }
    await this.sock.sendMessage(jid, content);
  }

  async sendTextMessage(jid: string, text: string): Promise<void> {
    await this.sendMessage(jid, { text });
  }

  // ── Presence (typing indicators) ───────────────────────────────────────

  async sendPresenceUpdate(jid: string, type: 'composing' | 'paused' | 'available'): Promise<void> {
    if (!this.sock) return;
    await this.sock.sendPresenceUpdate(type, jid);
  }

  async subscribePresence(jid: string): Promise<void> {
    if (!this.sock) return;
    await this.sock.presenceSubscribe(jid);
  }

  // ── Read receipts ─────────────────────────────────────────────────────

  async markRead(keys: WAMessageKey[]): Promise<void> {
    if (!this.sock || keys.length === 0) return;
    await this.sock.readMessages(keys);
  }

  // ── Reactions ─────────────────────────────────────────────────────────

  async sendReaction(jid: string, messageKey: WAMessageKey, emoji: string): Promise<void> {
    if (!this.sock) return;
    await this.sock.sendMessage(jid, {
      react: {
        text: emoji,
        key: messageKey,
      },
    });
  }

  // ── Validation ────────────────────────────────────────────────────────

  async isOnWhatsApp(phone: string): Promise<boolean> {
    if (!this.sock) return false;
    try {
      const results = await this.sock.onWhatsApp(phone);
      return results?.[0]?.exists === true;
    } catch {
      return false;
    }
  }

  // ── Logout ────────────────────────────────────────────────────────────

  async logout(): Promise<void> {
    if (!this.sock) {
      throw new Error('WhatsApp socket not connected');
    }
    await this.sock.logout();
    this.sock = null;
    this.connectionStatus = 'disconnected';
    this.phoneNumber = null;
    this.latestQr = null;
  }

  // ── Internal: socket creation and event handling ───────────────────────

  private async createSocket(): Promise<void> {
    const { state, saveCreds } = await useMultiFileAuthState(this.config.authDir);
    const { version } = await fetchLatestBaileysVersion();

    this.sock = makeWASocket({
      version,
      auth: {
        creds: state.creds,
        keys: makeCacheableSignalKeyStore(state.keys, undefined as any),
      },
      printQRInTerminal: false,
      // Reduce log noise in production
      logger: undefined as any,
      generateHighQualityLinkPreview: false,
    });

    // ── Connection updates ─────────────────────────────────────────────
    this.sock.ev.on('connection.update', (update: Partial<ConnectionState>) => {
      const { connection, lastDisconnect, qr } = update;

      // QR code for linking
      if (qr) {
        this.latestQr = qr;
        this.events.onQrCode(qr);
        console.log('[WhatsAppSocket] New QR code generated');
      }

      if (connection === 'close') {
        this.connectionStatus = 'disconnected';
        this.events.onConnectionUpdate('disconnected');

        const statusCode = (lastDisconnect?.error as Boom)?.output?.statusCode;
        const shouldReconnect = statusCode !== DisconnectReason.loggedOut;

        if (shouldReconnect && this.shouldReconnect) {
          console.log(`[WhatsAppSocket] Connection closed (${statusCode}), reconnecting in 5s...`);
          this.reconnectTimer = setTimeout(() => {
            this.createSocket().catch((err) => {
              console.error('[WhatsAppSocket] Reconnect failed:', err);
            });
          }, 5000);
        } else {
          console.log(`[WhatsAppSocket] Connection closed permanently (loggedOut=${!shouldReconnect})`);
        }
      } else if (connection === 'open') {
        this.connectionStatus = 'open';
        this.latestQr = null; // Clear QR once connected

        // Extract phone number from credentials
        const me = this.sock?.user;
        if (me?.id) {
          // Baileys JID format: +15551234567:0@s.whatsapp.net → extract phone
          this.phoneNumber = '+' + me.id.split(':')[0].split('@')[0];
        }

        this.events.onConnectionUpdate('open', this.phoneNumber ?? undefined);
        console.log(`[WhatsAppSocket] Connected as ${this.phoneNumber ?? 'unknown'}`);
      } else if (connection === 'connecting') {
        this.connectionStatus = 'connecting';
        this.events.onConnectionUpdate('connecting');
      }
    });

    // ── Credential updates (save auth state) ───────────────────────────
    this.sock.ev.on('creds.update', saveCreds);

    // ── Incoming messages ──────────────────────────────────────────────
    this.sock.ev.on('messages.upsert', (m) => {
      for (const msg of m.messages) {
        // Skip non-notify messages (history sync, protocol messages)
        if (m.type !== 'notify') continue;

        // Skip messages from self
        if (msg.key.fromMe) continue;

        // Skip status broadcasts
        if (msg.key.remoteJid === 'status@broadcast') continue;

        // Extract text content
        const text =
          msg.message?.conversation ||
          msg.message?.extendedTextMessage?.text ||
          msg.message?.imageMessage?.caption ||
          msg.message?.videoMessage?.caption ||
          msg.message?.documentMessage?.caption;

        if (!text) continue; // Skip media-only messages for now

        const senderJid = msg.key.remoteJid!;
        const isGroup = senderJid.endsWith('@g.us');

        // For groups, the sender is the participant; for DMs, it's the remoteJid
        const senderPhone = isGroup
          ? (msg.key.participant?.split('@')[0] ?? '')
          : senderJid.split('@')[0];

        this.events.onMessage({
          senderJid,
          senderPhone: '+' + senderPhone.replace(/[^0-9]/g, ''),
          text,
          messageKey: msg.key,
          timestamp: msg.messageTimestamp as number ?? Math.floor(Date.now() / 1000),
          isGroup,
          groupJid: isGroup ? senderJid : undefined,
        });
      }
    });
  }
}
