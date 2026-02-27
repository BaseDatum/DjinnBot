/**
 * TelegramTypingManager — manages typing indicators for Telegram conversations.
 *
 * Telegram's sendChatAction('typing') expires after ~5s, so we send
 * a keepalive every 4s while the agent is processing. A 120s TTL safety
 * net auto-stops the indicator if something goes wrong.
 *
 * Mirrors SignalTypingManager from @djinnbot/signal.
 */

import type { TelegramClient } from './telegram-client.js';

interface ActiveTyping {
  keepaliveTimer: ReturnType<typeof setInterval>;
  ttlTimer: ReturnType<typeof setTimeout>;
  stopped: boolean;
}

const KEEPALIVE_INTERVAL_MS = 4_000;
const MAX_TYPING_DURATION_MS = 120_000;

export class TelegramTypingManager {
  private client: TelegramClient;
  private active = new Map<number, ActiveTyping>();

  constructor(client: TelegramClient) {
    this.client = client;
  }

  /**
   * Start typing indicator for a chat.
   * Sends immediately, then keepalive every 4s.
   * Auto-stops after 120s as safety.
   */
  startTyping(chatId: number): void {
    // Stop any existing typing for this chat first
    this.stopTyping(chatId);

    const entry: ActiveTyping = {
      stopped: false,
      keepaliveTimer: setInterval(() => {
        if (entry.stopped) return;
        this.sendTypingAction(chatId).catch((err) => {
          console.warn(`[TelegramTyping] keepalive failed for ${chatId}:`, err);
        });
      }, KEEPALIVE_INTERVAL_MS),
      ttlTimer: setTimeout(() => {
        console.warn(`[TelegramTyping] TTL exceeded for ${chatId}, auto-stopping`);
        this.stopTyping(chatId);
      }, MAX_TYPING_DURATION_MS),
    };

    this.active.set(chatId, entry);

    // Send immediately
    this.sendTypingAction(chatId).catch((err) => {
      console.warn(`[TelegramTyping] initial send failed for ${chatId}:`, err);
    });
  }

  /**
   * Stop typing indicator for a chat.
   * Telegram doesn't have an explicit "stop typing" API — the indicator
   * simply expires after ~5s. We just stop sending keepalives.
   */
  stopTyping(chatId: number): void {
    const entry = this.active.get(chatId);
    if (!entry) return;

    entry.stopped = true;
    clearInterval(entry.keepaliveTimer);
    clearTimeout(entry.ttlTimer);
    this.active.delete(chatId);
  }

  /**
   * Stop all active typing indicators. Called during shutdown.
   */
  stopAll(): void {
    for (const chatId of this.active.keys()) {
      this.stopTyping(chatId);
    }
  }

  private async sendTypingAction(chatId: number): Promise<void> {
    await this.client.sendChatAction(chatId, 'typing');
  }
}
