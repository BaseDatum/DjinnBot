import { Redis } from 'ioredis';
import { channels, createTimestamp } from '@djinnbot/core';
import type { OutputMessage, EventMessage, StatusMessage } from '@djinnbot/core';

export class RedisPublisher {
  private outputChannel: string;
  private eventsChannel: string;

  constructor(
    private redis: Redis,
    private runId: string
  ) {
    // Cache channel names to avoid string concatenation on every token
    this.outputChannel = channels.output(this.runId);
    this.eventsChannel = channels.events(this.runId);
  }

  async publishOutput(msg: Omit<OutputMessage, 'timestamp'>): Promise<void> {
    try {
      await this.redis.publish(this.outputChannel, JSON.stringify({ ...msg, timestamp: createTimestamp() }));
    } catch (err) {
      console.error(`[RedisPublisher] Failed to publish output to ${this.outputChannel}:`, err);
    }
  }

  /**
   * Fire-and-forget version for high-frequency token events.
   * Does NOT await the Redis publish — lets ioredis auto-pipeline
   * multiple tokens into efficient TCP writes. Errors are logged
   * but do not block the LLM stream.
   */
  publishOutputFast(msg: Omit<OutputMessage, 'timestamp'>): void {
    const json = JSON.stringify({ ...msg, timestamp: createTimestamp() });
    this.redis.publish(this.outputChannel, json).catch(err =>
      console.error(`[RedisPublisher] Failed to publish output:`, err),
    );
  }

  async publishEvent(msg: Omit<EventMessage, 'timestamp'>): Promise<void> {
    const payload = JSON.stringify({ ...msg, timestamp: createTimestamp() });
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        await this.redis.publish(this.eventsChannel, payload);
        return;
      } catch (err) {
        console.error(`[RedisPublisher] Failed to publish event (attempt ${attempt + 1}):`, err);
        if (attempt === 0) await new Promise(r => setTimeout(r, 100));
      }
    }
    console.error(`[RedisPublisher] Giving up on event publish after 2 attempts`);
  }

  /**
   * Fire-and-forget version for high-frequency thinking events.
   * Same rationale as publishOutputFast.
   */
  publishEventFast(msg: Omit<EventMessage, 'timestamp'>): void {
    const json = JSON.stringify({ ...msg, timestamp: createTimestamp() });
    this.redis.publish(this.eventsChannel, json).catch(err =>
      console.error(`[RedisPublisher] Failed to publish event:`, err),
    );
  }

  async publishStatus(msg: Omit<StatusMessage, 'timestamp'>): Promise<void> {
    const channel = channels.status(this.runId);
    const payload = JSON.stringify({ ...msg, timestamp: createTimestamp() });

    
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        await this.redis.publish(channel, payload);
        return;
      } catch (err) {
        console.error(`[RedisPublisher] Failed to publish status (attempt ${attempt + 1}):`, err);
        if (attempt === 0) await new Promise(r => setTimeout(r, 100));
      }
    }
    console.error(`[RedisPublisher] Giving up on status publish after 2 attempts`);
  }

  /**
   * Signal the engine to re-index and re-embed a vault after a memory is written.
   * Published to a well-known channel; the engine debounces and runs qmd embed.
   */
  async publishVaultUpdated(agentId: string, sharedUpdated: boolean): Promise<void> {
    const channel = 'djinnbot:vault:updated';
    const payload = JSON.stringify({
      agentId,
      sharedUpdated,
      timestamp: createTimestamp(),
    });
    try {
      await this.redis.publish(channel, payload);
    } catch (err) {
      // Non-fatal — embedding will catch up on next agent wake/initialize
      console.error(`[RedisPublisher] Failed to publish vault:updated for ${agentId}:`, err);
    }
  }
}