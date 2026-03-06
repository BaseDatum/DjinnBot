/**
 * SignalTypingManager — manages typing indicators for Signal conversations.
 *
 * Now wraps the shared ChannelTypingManager from @djinnbot/core.
 * Signal typing indicators expire after ~5s, so we send a keepalive
 * every 3s while the agent is processing. A 60s TTL safety net
 * auto-stops the indicator if something goes wrong.
 */

import { ChannelTypingManager } from '@djinnbot/core';
import type { SignalClient } from './signal-client.js';

const KEEPALIVE_INTERVAL_MS = 3_000;
const MAX_TYPING_DURATION_MS = 60_000;

export class SignalTypingManager {
  private inner: ChannelTypingManager;

  constructor(client: SignalClient, account?: string) {
    this.inner = new ChannelTypingManager({
      keepaliveIntervalMs: KEEPALIVE_INTERVAL_MS,
      maxDurationMs: MAX_TYPING_DURATION_MS,
      sendTypingStart: async (recipient: string) => {
        await client.sendTyping(recipient, { account });
      },
      sendTypingStop: async (recipient: string) => {
        await client.sendTyping(recipient, { account, stop: true });
      },
    });
  }

  startTyping(recipient: string): void {
    this.inner.startTyping(recipient);
  }

  stopTyping(recipient: string): void {
    this.inner.stopTyping(recipient);
  }

  stopAll(): void {
    this.inner.stopAll();
  }
}
