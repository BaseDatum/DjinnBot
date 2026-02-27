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
  type WAVersion,
  type BaileysEventMap,
  type ConnectionState,
  type WAMessageKey,
  type AnyMessageContent,
} from '@whiskeysockets/baileys';
import { Boom } from '@hapi/boom';
import pino from 'pino';
import { readFileSync, writeFileSync, mkdirSync } from 'fs';
import { join } from 'path';

/** Silent pino logger — Baileys requires a real pino instance. */
const baileysLogger = pino({ level: 'silent' });

/**
 * Cached WA Web version. Fetched once from GitHub with a 10s timeout,
 * then reused for all subsequent connections. Falls back to undefined
 * (Baileys built-in default) if the fetch fails or times out.
 */
let cachedVersion: WAVersion | undefined;

async function getWAVersion(): Promise<WAVersion | undefined> {
  if (cachedVersion) return cachedVersion;
  try {
    const { version } = await fetchLatestBaileysVersion({
      signal: AbortSignal.timeout(10_000),
    });
    cachedVersion = version;
    console.log(`[WhatsAppSocket] Fetched WA version: ${version.join('.')}`);
    return version;
  } catch (err) {
    console.warn('[WhatsAppSocket] Failed to fetch latest WA version, using Baileys default:', err);
    return undefined;
  }
}

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
    /** Media attachment info (images, audio, documents, video) */
    media?: {
      /** Raw message object — pass to downloadMediaMessage() to get bytes */
      rawMessage: any;
      mimeType: string;
      filename?: string;
      /** Media type for logging/routing */
      type: 'image' | 'audio' | 'video' | 'document';
    };
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

  /**
   * Persistent LID → PN (phone number JID) mapping.
   *
   * WhatsApp's LID system means incoming messages often arrive with an opaque
   * LID JID (e.g. 272099079909425@lid) instead of the phone-based JID. Baileys'
   * in-memory signalRepository.lidMapping is unreliable (often empty on fresh
   * links). We build our own mapping from `contacts.upsert` events that Baileys
   * fires during initial sync and persist it to disk so it survives restarts.
   */
  private lidToPhone: Map<string, string> = new Map();
  private lidMapDirty = false;
  private lidMapFlushTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(config: WhatsAppSocketConfig, events: WhatsAppSocketEvents) {
    this.config = config;
    this.events = events;
    this.loadLidMap();
  }

  // ── LID ↔ PN mapping persistence ─────────────────────────────────────

  private get lidMapPath(): string {
    return join(this.config.authDir, 'lid-mapping.json');
  }

  private loadLidMap(): void {
    try {
      const raw = readFileSync(this.lidMapPath, 'utf-8');
      const data = JSON.parse(raw) as Record<string, string>;
      this.lidToPhone = new Map(Object.entries(data));
      console.log(`[WhatsAppSocket] Loaded ${this.lidToPhone.size} LID→PN mappings from disk`);
    } catch {
      // File doesn't exist yet — normal on first run
    }
  }

  private saveLidMap(): void {
    try {
      mkdirSync(this.config.authDir, { recursive: true });
      const data = Object.fromEntries(this.lidToPhone);
      writeFileSync(this.lidMapPath, JSON.stringify(data, null, 2));
    } catch (err) {
      console.warn('[WhatsAppSocket] Failed to save LID mapping:', err);
    }
  }

  /** Debounced flush — contacts.upsert can fire many times during sync. */
  private scheduleLidMapFlush(): void {
    this.lidMapDirty = true;
    if (this.lidMapFlushTimer) return;
    this.lidMapFlushTimer = setTimeout(() => {
      this.lidMapFlushTimer = null;
      if (this.lidMapDirty) {
        this.lidMapDirty = false;
        this.saveLidMap();
        console.log(`[WhatsAppSocket] Flushed ${this.lidToPhone.size} LID→PN mappings to disk`);
      }
    }, 5000);
  }

  /**
   * Process contacts from Baileys and extract LID → PN mappings.
   * Contacts may have: id (preferred), lid, phoneNumber, jid fields.
   */
  private updateLidMapFromContacts(contacts: any[]): void {
    let added = 0;
    for (const contact of contacts) {
      // Baileys v6/v7 contact shapes vary. Extract what we can.
      const lid: string | undefined = contact.lid || contact.id;
      const pn: string | undefined =
        contact.phoneNumber || contact.jid || contact.id;

      if (!lid || !pn) continue;

      // We need a LID JID and a phone-based JID
      const lidJid = lid.includes('@lid') ? lid : undefined;
      const pnJid = pn.includes('@s.whatsapp.net') ? pn : undefined;

      if (lidJid && pnJid && !this.lidToPhone.has(lidJid)) {
        this.lidToPhone.set(lidJid, pnJid);
        added++;
      }
    }
    if (added > 0) {
      console.log(`[WhatsAppSocket] Added ${added} new LID→PN mappings (total: ${this.lidToPhone.size})`);
      this.scheduleLidMapFlush();
    }
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
    const version = await getWAVersion();

    this.sock = makeWASocket({
      ...(version ? { version } : {}),
      auth: {
        creds: state.creds,
        keys: makeCacheableSignalKeyStore(state.keys, baileysLogger),
      },
      printQRInTerminal: false,
      // Silent pino logger to suppress Baileys internal logging
      logger: baileysLogger,
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

    // ── LID mapping from contact sync ──────────────────────────────────
    // WhatsApp sends contact data during initial sync that contains both
    // LID and PN (phone number) JIDs. We capture these to build a
    // persistent LID→PN mapping for resolving incoming message senders.
    this.sock.ev.on('contacts.upsert', (contacts) => {
      this.updateLidMapFromContacts(contacts);
    });
    this.sock.ev.on('contacts.update', (contacts) => {
      this.updateLidMapFromContacts(contacts);
    });

    // messaging-history.set also includes contacts during history sync
    this.sock.ev.on('messaging-history.set', (data: any) => {
      if (data.contacts?.length) {
        this.updateLidMapFromContacts(data.contacts);
      }
    });

    // lid-mapping.update — Baileys fires this when it learns new LID↔PN
    // mappings from the WhatsApp protocol (e.g. during message exchange).
    // This is the most reliable source for unknown senders.
    try {
      (this.sock.ev as any).on('lid-mapping.update', (mappings: any[]) => {
        let added = 0;
        for (const m of mappings) {
          const lid = m.lid || m.lidJid;
          const pn = m.pn || m.pnJid;
          if (lid && pn && !this.lidToPhone.has(lid)) {
            this.lidToPhone.set(lid, pn);
            added++;
          }
        }
        if (added > 0) {
          console.log(`[WhatsAppSocket] lid-mapping.update: added ${added} mappings (total: ${this.lidToPhone.size})`);
          this.scheduleLidMapFlush();
        }
      });
    } catch {
      // Event may not exist in all Baileys versions
    }

    // ── Incoming messages ──────────────────────────────────────────────
    this.sock.ev.on('messages.upsert', (m) => {
      for (const msg of m.messages) {
        // Skip non-notify messages (history sync, protocol messages)
        if (m.type !== 'notify') continue;

        // Skip messages from self
        if (msg.key.fromMe) continue;

        // Skip status broadcasts
        if (msg.key.remoteJid === 'status@broadcast') continue;

        // Extract text content (captions count as text)
        const text =
          msg.message?.conversation ||
          msg.message?.extendedTextMessage?.text ||
          msg.message?.imageMessage?.caption ||
          msg.message?.videoMessage?.caption ||
          msg.message?.documentMessage?.caption ||
          '';

        // Extract media info if present
        let media: { rawMessage: any; mimeType: string; filename?: string; type: 'image' | 'audio' | 'video' | 'document' } | undefined;

        if (msg.message?.imageMessage) {
          media = {
            rawMessage: msg,
            mimeType: msg.message.imageMessage.mimetype || 'image/jpeg',
            type: 'image',
          };
        } else if (msg.message?.audioMessage) {
          media = {
            rawMessage: msg,
            mimeType: msg.message.audioMessage.mimetype || 'audio/ogg',
            type: 'audio',
          };
        } else if (msg.message?.documentMessage) {
          media = {
            rawMessage: msg,
            mimeType: msg.message.documentMessage.mimetype || 'application/octet-stream',
            filename: msg.message.documentMessage.fileName || undefined,
            type: 'document',
          };
        } else if (msg.message?.videoMessage) {
          media = {
            rawMessage: msg,
            mimeType: msg.message.videoMessage.mimetype || 'video/mp4',
            type: 'video',
          };
        }

        // Skip messages with no text AND no media
        if (!text && !media) continue;

        const senderJid = msg.key.remoteJid!;
        const isGroup = senderJid.endsWith('@g.us');

        // Resolve the sender's phone number.
        // WhatsApp now uses LID (Linked Identity) JIDs (e.g. 272099079909425@lid)
        // instead of phone-based JIDs (14095193333@s.whatsapp.net). We must use
        // Baileys' LID mapping store to resolve the real phone number.
        // For groups, also check participantAlt / participant.
        let senderPhone: string | null = null;

        // First check senderPn — Baileys includes this on the message key
        // with the real phone-based JID even when remoteJid is a LID.
        const senderPn = (msg.key as any).senderPn as string | undefined;
        if (senderPn && senderPn.endsWith('@s.whatsapp.net')) {
          senderPhone = this.pnJidToPhone(senderPn);
          // Cache the LID→PN mapping for future use
          if (senderJid.endsWith('@lid') && !this.lidToPhone.has(senderJid)) {
            this.lidToPhone.set(senderJid, senderPn);
            this.scheduleLidMapFlush();
          }
        } else if (isGroup) {
          // In groups, try participantAlt (PN) first, then resolve participant (LID)
          const participantAlt = (msg.key as any).participantAlt;
          const participant = msg.key.participant;
          if (participantAlt && participantAlt.endsWith('@s.whatsapp.net')) {
            senderPhone = this.pnJidToPhone(participantAlt);
          } else if (participant) {
            senderPhone = this.resolveJidToPhone(participant);
          }
        } else {
          // DM: try remoteJidAlt first
          const remoteJidAlt = (msg.key as any).remoteJidAlt;
          if (remoteJidAlt && remoteJidAlt.endsWith('@s.whatsapp.net')) {
            senderPhone = this.pnJidToPhone(remoteJidAlt);
          } else {
            senderPhone = this.resolveJidToPhone(senderJid);
          }
        }

        if (!senderPhone) {
          // Log the raw key fields so we can diagnose what Baileys provides
          console.warn(
            `[WhatsAppSocket] Could not resolve phone for JID ${senderJid}` +
            ` — raw key: ${JSON.stringify(msg.key)}` +
            ` — pushName: ${(msg as any).pushName ?? 'none'}`
          );
          // Don't drop the message — pass the LID JID through so the bridge
          // can still process it (e.g. if allowAll is true, or for logging).
          // Strip @lid suffix and prefix with + for a recognizable-but-wrong number
          // that will fail allowlist but won't crash downstream code.
          senderPhone = senderJid;
        }

        this.events.onMessage({
          senderJid,
          senderPhone,
          text,
          messageKey: msg.key,
          timestamp: msg.messageTimestamp as number ?? Math.floor(Date.now() / 1000),
          isGroup,
          groupJid: isGroup ? senderJid : undefined,
          media,
        });
      }
    });
  }

  /**
   * Convert a PN JID (e.g. "14095193333@s.whatsapp.net" or "14095193333:0@s.whatsapp.net")
   * to an E.164 phone string like "+14095193333".
   */
  private pnJidToPhone(pnJid: string): string {
    const user = pnJid.split('@')[0].split(':')[0];
    return '+' + user.replace(/[^0-9]/g, '');
  }

  /**
   * Resolve a JID to a phone number string like "+14095193333".
   *
   * Resolution order for @lid JIDs:
   *   1. Our persistent LID→PN disk map (built from contacts.upsert events)
   *   2. Baileys in-memory signalRepository.lidMapping
   *
   * Returns null if the JID cannot be resolved.
   */
  private resolveJidToPhone(jid: string): string | null {
    // Standard phone-based JID
    if (jid.endsWith('@s.whatsapp.net')) {
      return this.pnJidToPhone(jid);
    }

    if (jid.endsWith('@lid')) {
      // 1. Check our persistent disk-backed map first
      const pnJid = this.lidToPhone.get(jid);
      if (pnJid) {
        return this.pnJidToPhone(pnJid);
      }

      // 2. Fall back to Baileys' in-memory signal repository
      if (this.sock) {
        try {
          const mapping = (this.sock as any).signalRepository?.lidMapping;
          if (mapping?.getPNForLID) {
            const resolved: string | undefined = mapping.getPNForLID(jid);
            if (resolved) {
              // Cache it in our persistent map for next time
              this.lidToPhone.set(jid, resolved);
              this.scheduleLidMapFlush();
              return this.pnJidToPhone(resolved);
            }
          }
        } catch (err) {
          console.warn(`[WhatsAppSocket] LID mapping lookup failed for ${jid}:`, err);
        }
      }

      console.warn(`[WhatsAppSocket] No PN mapping found for LID ${jid}`);
      return null;
    }

    // Unknown JID format — best-effort extraction
    const user = jid.split('@')[0].split(':')[0].replace(/[^0-9]/g, '');
    if (user.length >= 7 && user.length <= 15) {
      return '+' + user;
    }
    return null;
  }
}
