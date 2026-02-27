/**
 * WhatsApp integration types for DjinnBot.
 *
 * One phone number shared across the entire platform. Messages are routed
 * to agents via the ChannelRouter. Baileys runs in-process as a Node library.
 */

// ── Config types (mirrors DB whatsapp_config table) ──────────────────────────

export interface WhatsAppConfig {
  enabled: boolean;
  phoneNumber: string | null;
  linked: boolean;
  defaultAgentId: string | null;
  stickyTtlMinutes: number;
  allowAll: boolean;
  ackEmoji: string | null;
}

// ── Bridge config ────────────────────────────────────────────────────────────

export interface WhatsAppBridgeConfig {
  /** Redis instance for pub/sub, distributed lock, sticky state. */
  redisUrl: string;
  /** API server URL for DB queries (allowlist, config). */
  apiUrl: string;
  /** Directory on JuiceFS for Baileys auth state. */
  authDir: string;
  /** Default model for WhatsApp conversation sessions. */
  defaultConversationModel?: string;
}

// ── Redis RPC (API server ↔ engine communication) ────────────────────────────

export interface WhatsAppRpcRequest {
  id: string;
  method: 'link' | 'link_status' | 'unlink' | 'send' | 'health' | 'pairing_code';
  params: Record<string, unknown>;
}

export interface WhatsAppRpcReply {
  id: string;
  result?: unknown;
  error?: string;
}

// ── Allowlist types (re-exported from core for convenience) ──────────────────

export type { AllowlistDbEntry, AllowlistEntryKind } from '@djinnbot/core';
