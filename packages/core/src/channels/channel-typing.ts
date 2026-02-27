/**
 * ChannelTypingManager — shared typing indicator management for messaging channels.
 *
 * Messaging apps' typing indicators expire after a few seconds, so we send
 * a keepalive at a configurable interval while the agent is processing.
 * A safety TTL auto-stops the indicator if something goes wrong.
 *
 * Used by both Signal and WhatsApp integrations.
 */

export interface ChannelTypingConfig {
  /** Interval in ms between keepalive pings. Signal: 3000, WhatsApp: 10000 */
  keepaliveIntervalMs: number;
  /** Maximum duration before auto-stop. Default: 60000 */
  maxDurationMs: number;
  /** Called to send a "start typing" indicator */
  sendTypingStart: (recipient: string) => Promise<void>;
  /** Called to send a "stop typing" indicator */
  sendTypingStop: (recipient: string) => Promise<void>;
}

interface ActiveTyping {
  keepaliveTimer: ReturnType<typeof setInterval>;
  ttlTimer: ReturnType<typeof setTimeout>;
  stopped: boolean;
}

export class ChannelTypingManager {
  private config: ChannelTypingConfig;
  private active = new Map<string, ActiveTyping>();

  constructor(config: ChannelTypingConfig) {
    this.config = config;
  }

  /**
   * Start typing indicator for a recipient.
   * Sends immediately, then keepalive at configured interval.
   * Auto-stops after maxDuration as safety.
   */
  startTyping(recipient: string): void {
    // Stop any existing typing for this recipient first
    this.stopTyping(recipient);

    const entry: ActiveTyping = {
      stopped: false,
      keepaliveTimer: setInterval(() => {
        if (entry.stopped) return;
        this.config.sendTypingStart(recipient).catch((err) => {
          console.warn(`[ChannelTyping] keepalive failed for ${recipient}:`, err);
        });
      }, this.config.keepaliveIntervalMs),
      ttlTimer: setTimeout(() => {
        console.warn(`[ChannelTyping] TTL exceeded for ${recipient}, auto-stopping`);
        this.stopTyping(recipient);
      }, this.config.maxDurationMs),
    };

    this.active.set(recipient, entry);

    // Send immediately
    this.config.sendTypingStart(recipient).catch((err) => {
      console.warn(`[ChannelTyping] initial send failed for ${recipient}:`, err);
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
    this.config.sendTypingStop(recipient).catch((err) => {
      console.warn(`[ChannelTyping] stop failed for ${recipient}:`, err);
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
}
