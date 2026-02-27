/**
 * SignalTypingManager — manages typing indicators for Signal conversations.
 *
 * Signal typing indicators expire after ~5s, so we send a keepalive
 * every 3s while the agent is processing. A 60s TTL safety net
 * auto-stops the indicator if something goes wrong.
 */

import type { SignalClient } from './signal-client.js';

interface ActiveTyping {
  keepaliveTimer: ReturnType<typeof setInterval>;
  ttlTimer: ReturnType<typeof setTimeout>;
  stopped: boolean;
}

const KEEPALIVE_INTERVAL_MS = 3_000;
const MAX_TYPING_DURATION_MS = 60_000;

export class SignalTypingManager {
  private client: SignalClient;
  private account?: string;
  private active = new Map<string, ActiveTyping>();

  constructor(client: SignalClient, account?: string) {
    this.client = client;
    this.account = account;
  }

  /**
   * Start typing indicator for a recipient.
   * Sends immediately, then keepalive every 3s.
   * Auto-stops after 60s as safety.
   */
  startTyping(recipient: string): void {
    // Stop any existing typing for this recipient first
    this.stopTyping(recipient);

    const entry: ActiveTyping = {
      stopped: false,
      keepaliveTimer: setInterval(() => {
        if (entry.stopped) return;
        this.sendTypingStart(recipient).catch((err) => {
          console.warn(`[SignalTyping] keepalive failed for ${recipient}:`, err);
        });
      }, KEEPALIVE_INTERVAL_MS),
      ttlTimer: setTimeout(() => {
        console.warn(`[SignalTyping] TTL exceeded for ${recipient}, auto-stopping`);
        this.stopTyping(recipient);
      }, MAX_TYPING_DURATION_MS),
    };

    this.active.set(recipient, entry);

    // Send immediately
    this.sendTypingStart(recipient).catch((err) => {
      console.warn(`[SignalTyping] initial send failed for ${recipient}:`, err);
    });
  }

  /**
   * Stop typing indicator for a recipient.
   */
  stopTyping(recipient: string): void {
    const entry = this.active.get(recipient);
    if (!entry) return;

    entry.stopped = true;
    clearInterval(entry.keepaliveTimer);
    clearTimeout(entry.ttlTimer);
    this.active.delete(recipient);

    // Send stop indicator (fire-and-forget)
    this.sendTypingStop(recipient).catch((err) => {
      console.warn(`[SignalTyping] stop failed for ${recipient}:`, err);
    });
  }

  /**
   * Stop all active typing indicators. Called during shutdown.
   */
  stopAll(): void {
    for (const recipient of this.active.keys()) {
      this.stopTyping(recipient);
    }
  }

  private async sendTypingStart(recipient: string): Promise<void> {
    await this.client.sendTyping(recipient, { account: this.account });
  }

  private async sendTypingStop(recipient: string): Promise<void> {
    await this.client.sendTyping(recipient, { account: this.account, stop: true });
  }
}
