/**
 * Signal integration types for DjinnBot.
 *
 * One phone number shared across the entire platform. Messages are routed
 * to agents via the SignalRouter. signal-cli runs as a child process
 * inside the engine container with data on JuiceFS.
 */

// ── Signal-cli JSON-RPC types ────────────────────────────────────────────────

export interface SignalRpcResponse<T = unknown> {
  jsonrpc?: string;
  result?: T;
  error?: SignalRpcError;
  id?: string | number | null;
}

export interface SignalRpcError {
  code?: number;
  message?: string;
  data?: unknown;
}

export interface SignalSendResult {
  timestamp: number;
}

export interface SignalAccount {
  number: string;
  uuid: string;
}

// ── SSE event types from signal-cli daemon ───────────────────────────────────

export interface SignalSseEvent {
  event?: string;
  data?: string;
  id?: string;
}

/** Parsed envelope from signal-cli SSE data message. */
export interface SignalEnvelope {
  source?: string;
  sourceNumber?: string;
  sourceUuid?: string;
  sourceName?: string;
  timestamp?: number;
  dataMessage?: SignalDataMessage;
  typingMessage?: SignalTypingMessage;
  receiptMessage?: SignalReceiptMessage;
  syncMessage?: SignalSyncMessage;
}

export interface SignalDataMessage {
  timestamp?: number;
  message?: string;
  groupInfo?: SignalGroupInfo;
  attachments?: SignalAttachment[];
  reaction?: SignalReaction;
  quote?: SignalQuote;
}

export interface SignalGroupInfo {
  groupId: string;
  type?: string;
}

export interface SignalAttachment {
  id?: string;
  contentType?: string;
  filename?: string;
  size?: number;
}

export interface SignalReaction {
  emoji?: string;
  targetAuthor?: string;
  targetAuthorUuid?: string;
  targetSentTimestamp?: number;
  isRemove?: boolean;
}

export interface SignalQuote {
  id?: number;
  author?: string;
  authorUuid?: string;
  text?: string;
}

export interface SignalTypingMessage {
  action?: 'STARTED' | 'STOPPED';
  timestamp?: number;
  groupId?: string;
}

export interface SignalReceiptMessage {
  type?: 'DELIVERY' | 'READ' | 'VIEWED';
  timestamps?: number[];
}

export interface SignalSyncMessage {
  sentMessage?: SignalDataMessage & { destination?: string };
}

// ── Signal text formatting (markdown → Signal styles) ────────────────────────

export interface TextStyleRange {
  start: number;
  length: number;
  style: 'BOLD' | 'ITALIC' | 'MONOSPACE' | 'STRIKETHROUGH' | 'SPOILER';
}

// ── Routing types ────────────────────────────────────────────────────────────

export type RouteReason =
  | 'explicit_prefix'
  | 'sticky_conversation'
  | 'sender_default'
  | 'fallback';

export interface RouteResult {
  agentId: string;
  reason: RouteReason;
}

// ── Allowlist types ──────────────────────────────────────────────────────────

export type AllowlistEntryKind =
  | { kind: 'any' }
  | { kind: 'prefix'; prefix: string }
  | { kind: 'phone'; e164: string };

export interface AllowlistDbEntry {
  id: number;
  phoneNumber: string;
  label: string | null;
  defaultAgentId: string | null;
}

// ── Bridge config ────────────────────────────────────────────────────────────

export interface SignalBridgeConfig {
  /** Redis instance for pub/sub, distributed lock, sticky state. */
  redisUrl: string;
  /** API server URL for DB queries (allowlist, config). */
  apiUrl: string;
  /** Path to signal-cli binary. Default: 'signal-cli'. */
  signalCliPath?: string;
  /** signal-cli config directory on JuiceFS. */
  signalDataDir: string;
  /** HTTP port for signal-cli daemon. Default: 8820. */
  httpPort?: number;
  /** Default model for Signal conversation sessions. */
  defaultConversationModel?: string;
}

// ── Signal config (mirrors DB signal_config table) ───────────────────────────

export interface SignalConfig {
  enabled: boolean;
  phoneNumber: string | null;
  linked: boolean;
  defaultAgentId: string | null;
  stickyTtlMinutes: number;
  allowAll: boolean;
}

// ── Redis RPC (API server ↔ engine communication) ────────────────────────────

export interface SignalRpcRequest {
  id: string;
  method: 'link' | 'link_status' | 'send' | 'health';
  params: Record<string, unknown>;
}

export interface SignalRpcReply {
  id: string;
  result?: unknown;
  error?: string;
}
