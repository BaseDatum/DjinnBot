/**
 * SignalClient — JSON-RPC + SSE client for the local signal-cli daemon.
 *
 * Communicates with signal-cli's HTTP API on 127.0.0.1:{port}.
 * Handles sending messages, typing indicators, read receipts,
 * account linking, and receiving incoming events via SSE.
 */

import { randomUUID } from 'node:crypto';
import type {
  SignalRpcResponse,
  SignalSendResult,
  SignalAccount,
  SignalSseEvent,
  TextStyleRange,
} from './types.js';

export interface SignalClientConfig {
  baseUrl: string;
  timeoutMs?: number;
}

const DEFAULT_TIMEOUT_MS = 10_000;

export class SignalClient {
  private baseUrl: string;
  private timeoutMs: number;

  constructor(config: SignalClientConfig) {
    this.baseUrl = config.baseUrl.replace(/\/+$/, '');
    this.timeoutMs = config.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  }

  // ── JSON-RPC transport ───────────────────────────────────────────────────

  private async rpc<T = unknown>(
    method: string,
    params?: Record<string, unknown>,
  ): Promise<T> {
    const id = randomUUID();
    const body = JSON.stringify({
      jsonrpc: '2.0',
      method,
      params: params ?? {},
      id,
    });

    const res = await fetch(`${this.baseUrl}/api/v1/rpc`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body,
      signal: AbortSignal.timeout(this.timeoutMs),
    });

    if (res.status === 201) {
      return undefined as T;
    }

    const text = await res.text();
    if (!text) {
      throw new Error(`Signal RPC empty response (status ${res.status})`);
    }

    let parsed: SignalRpcResponse<T>;
    try {
      parsed = JSON.parse(text);
    } catch {
      throw new Error(`Signal RPC malformed JSON (status ${res.status})`);
    }

    if (parsed.error) {
      const code = parsed.error.code ?? 'unknown';
      const msg = parsed.error.message ?? 'Signal RPC error';
      throw new Error(`Signal RPC ${code}: ${msg}`);
    }

    return parsed.result as T;
  }

  // ── Health ─────────────────────────────────────────────────────────────

  async check(): Promise<{ ok: boolean; error?: string }> {
    try {
      const res = await fetch(`${this.baseUrl}/api/v1/check`, {
        method: 'GET',
        signal: AbortSignal.timeout(2000),
      });
      if (res.ok) return { ok: true };
      return { ok: false, error: `HTTP ${res.status}` };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  }

  // ── Linking ────────────────────────────────────────────────────────────

  /**
   * Start the device linking process.
   * Returns a tsdevice:/ URI that the dashboard renders as a QR code.
   */
  async startLink(deviceName: string): Promise<{ uri: string }> {
    const result = await this.rpc<{ deviceLinkUri?: string }>('startLink', {
      name: deviceName,
    });
    if (!result?.deviceLinkUri) {
      throw new Error('Signal link did not return a device URI');
    }
    return { uri: result.deviceLinkUri };
  }

  /**
   * Finish the linking process (called after the QR code is scanned).
   */
  async finishLink(): Promise<{ account: string }> {
    const result = await this.rpc<{ number?: string }>('finishLink');
    return { account: result?.number ?? '' };
  }

  /** List registered accounts on this signal-cli instance. */
  async listAccounts(): Promise<SignalAccount[]> {
    const result = await this.rpc<SignalAccount[]>('listAccounts');
    return result ?? [];
  }

  // ── Messaging ──────────────────────────────────────────────────────────

  /**
   * Send a text message to a recipient.
   * @param to E.164 phone number or group:ID
   * @param text Message text
   */
  async sendMessage(
    to: string,
    text: string,
    opts?: {
      account?: string;
      textStyles?: TextStyleRange[];
      attachments?: string[];
    },
  ): Promise<SignalSendResult> {
    const params: Record<string, unknown> = {
      message: text,
    };

    // Determine recipient type
    if (to.toLowerCase().startsWith('group:')) {
      params.groupId = to.slice('group:'.length).trim();
    } else {
      params.recipient = [to];
    }

    if (opts?.account) params.account = opts.account;

    if (opts?.textStyles && opts.textStyles.length > 0) {
      params['text-style'] = opts.textStyles.map(
        (s) => `${s.start}:${s.length}:${s.style}`,
      );
    }

    if (opts?.attachments && opts.attachments.length > 0) {
      params.attachments = opts.attachments;
    }

    const result = await this.rpc<{ timestamp?: number }>('send', params);
    return { timestamp: result?.timestamp ?? 0 };
  }

  // ── Typing indicators ──────────────────────────────────────────────────

  /**
   * Send typing indicator to a recipient.
   * Must be called every ~3s to keep the indicator alive.
   */
  async sendTyping(
    to: string,
    opts?: { account?: string; stop?: boolean },
  ): Promise<void> {
    const params: Record<string, unknown> = {};

    if (to.toLowerCase().startsWith('group:')) {
      params.groupId = to.slice('group:'.length).trim();
    } else {
      params.recipient = [to];
    }

    if (opts?.account) params.account = opts.account;
    if (opts?.stop) params.stop = true;

    await this.rpc('sendTyping', params);
  }

  // ── Read receipts ─────────────────────────────────────────────────────

  async sendReadReceipt(
    to: string,
    targetTimestamp: number,
    opts?: { account?: string },
  ): Promise<void> {
    if (!Number.isFinite(targetTimestamp) || targetTimestamp <= 0) return;

    const params: Record<string, unknown> = {
      recipient: [to],
      targetTimestamp,
      type: 'read',
    };

    if (opts?.account) params.account = opts.account;

    await this.rpc('sendReceipt', params);
  }

  // ── SSE event stream ──────────────────────────────────────────────────

  /**
   * Connect to the signal-cli SSE event stream.
   * Calls onEvent for each incoming message/receipt/typing event.
   * Runs until the abort signal fires or the stream ends.
   */
  async streamEvents(opts: {
    account?: string;
    signal?: AbortSignal;
    onEvent: (event: SignalSseEvent) => void;
  }): Promise<void> {
    const url = new URL(`${this.baseUrl}/api/v1/events`);
    if (opts.account) {
      url.searchParams.set('account', opts.account);
    }

    const res = await fetch(url, {
      method: 'GET',
      headers: { Accept: 'text/event-stream' },
      signal: opts.signal,
    });

    if (!res.ok || !res.body) {
      throw new Error(`Signal SSE failed (${res.status} ${res.statusText})`);
    }

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let current: SignalSseEvent = {};

    const flush = () => {
      if (!current.data && !current.event && !current.id) return;
      opts.onEvent({ ...current });
      current = {};
    };

    while (true) {
      const { value, done } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      let lineEnd = buffer.indexOf('\n');

      while (lineEnd !== -1) {
        let line = buffer.slice(0, lineEnd);
        buffer = buffer.slice(lineEnd + 1);
        if (line.endsWith('\r')) line = line.slice(0, -1);

        if (line === '') {
          flush();
          lineEnd = buffer.indexOf('\n');
          continue;
        }
        if (line.startsWith(':')) {
          lineEnd = buffer.indexOf('\n');
          continue;
        }

        const colonIdx = line.indexOf(':');
        const field = colonIdx >= 0 ? line.slice(0, colonIdx).trim() : line.trim();
        const rawValue = colonIdx >= 0 ? line.slice(colonIdx + 1) : '';
        const val = rawValue.startsWith(' ') ? rawValue.slice(1) : rawValue;

        if (field === 'event') current.event = val;
        else if (field === 'data') current.data = current.data ? `${current.data}\n${val}` : val;
        else if (field === 'id') current.id = val;

        lineEnd = buffer.indexOf('\n');
      }
    }

    flush();
  }
}
