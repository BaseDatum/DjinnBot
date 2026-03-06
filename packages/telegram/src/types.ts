/**
 * Telegram integration types for DjinnBot.
 *
 * One bot per agent — each agent with Telegram enabled gets its own
 * BotFather bot token. No routing needed; messages to a bot go directly
 * to that agent.
 */

// ── Per-agent config (mirrors DB telegram_config table) ──────────────────────

export interface TelegramAgentConfig {
  agentId: string;
  enabled: boolean;
  /** BotFather bot token (e.g. 123456:ABC-DEF1234ghIkl-zyx57W2v1u123ew11). */
  botToken: string | null;
  /** Resolved via getMe() on first successful connect. */
  botUsername: string | null;
  /** When true, skip allowlist entirely — respond to all senders. */
  allowAll: boolean;
  updatedAt: number;
}

// ── Allowlist types ──────────────────────────────────────────────────────────

export type AllowlistEntryKind =
  | { kind: 'any' }
  | { kind: 'user_id'; userId: number }
  | { kind: 'username'; username: string }
  | { kind: 'prefix'; prefix: string };

export interface TelegramAllowlistDbEntry {
  id: number;
  agentId: string;
  /** User ID (numeric string), @username, @prefix*, or '*'. */
  identifier: string;
  /** Friendly label for the dashboard UI. */
  label: string | null;
  createdAt: number;
  updatedAt: number;
}

// ── Bridge config ────────────────────────────────────────────────────────────

export interface TelegramBridgeConfig {
  /** Redis instance URL for pub/sub and config change notifications. */
  redisUrl: string;
  /** API server URL for DB queries (config, allowlist). */
  apiUrl: string;
  /** Default model for Telegram conversation sessions. */
  defaultConversationModel?: string;
}

// ── Redis RPC (API server <-> Engine communication) ──────────────────────────

export interface TelegramRpcRequest {
  id: string;
  method: 'send' | 'status' | 'restart';
  params: Record<string, unknown>;
}

export interface TelegramRpcReply {
  id: string;
  result?: unknown;
  error?: string;
}

// ── Telegram Bot API subset types (grammy provides these, but we define ──────
// ── minimal versions for places where we don't want a grammy dependency) ─────

export interface TelegramUser {
  id: number;
  is_bot: boolean;
  first_name: string;
  last_name?: string;
  username?: string;
}

export interface TelegramMessage {
  message_id: number;
  from?: TelegramUser;
  chat: TelegramChat;
  date: number;
  text?: string;
  caption?: string;
}

export interface TelegramChat {
  id: number;
  type: 'private' | 'group' | 'supergroup' | 'channel';
  title?: string;
  username?: string;
}
