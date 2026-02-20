import { Redis, type Redis as RedisType } from 'ioredis';
import { EventEmitter } from 'node:events';
import {
  channels,
  outputMessageSchema,
  eventMessageSchema,
  statusMessageSchema,
  type OutputMessage,
  type EventMessage,
  type StatusMessage,
} from '../redis-protocol/index.js';

export interface RunEvents {
  output: (msg: OutputMessage) => void;
  event: (msg: EventMessage) => void;
  status: (msg: StatusMessage) => void;
  error: (err: Error) => void;
}

export class EventReceiver extends EventEmitter {
  private subscribers = new Map<string, RedisType>();

  constructor(private redisFactory: () => RedisType) {
    super();
  }

  async subscribeToRun(runId: string): Promise<void> {
    if (this.subscribers.has(runId)) {
      console.log(`[EventReceiver] Already subscribed to run ${runId}`);
      return;
    }

    const subscriber = this.redisFactory();
    this.subscribers.set(runId, subscriber);

    const outputChannel = channels.output(runId);
    const eventsChannel = channels.events(runId);
    const statusChannel = channels.status(runId);

    // Add Redis error handlers BEFORE subscribing
    subscriber.on('error', (err: Error) => {
      console.error(`[EventReceiver] Redis error for run ${runId}:`, err);
      this.emit('error', runId, err);
    });

    subscriber.on('close', () => {
      console.warn(`[EventReceiver] Redis connection closed for run ${runId}`);
    });

    subscriber.on('reconnecting', () => {
      console.log(`[EventReceiver] Redis reconnecting for run ${runId}`);
    });

    subscriber.on('ready', async () => {
      console.log(`[EventReceiver] Redis ready for run ${runId}`);
      // Resubscribe to channels after reconnect
      try {
        await subscriber.subscribe(outputChannel, eventsChannel, statusChannel);
        console.log(`[EventReceiver] Resubscribed to channels for run ${runId}`);
      } catch (err) {
        console.error(`[EventReceiver] Failed to resubscribe for run ${runId}:`, err);
        this.emit('error', runId, err as Error);
      }
    });

    subscriber.on('message', (channel: string, message: string) => {
      try {
        const parsed = JSON.parse(message);

        if (channel === outputChannel) {
          const msg = outputMessageSchema.parse(parsed);
          this.emit('output', runId, msg);
        } else if (channel === eventsChannel) {
          const msg = eventMessageSchema.parse(parsed);
          this.emit('event', runId, msg);
        } else if (channel === statusChannel) {
          const msg = statusMessageSchema.parse(parsed);
          this.emit('status', runId, msg);
        }
      } catch (err) {
        this.emit('error', runId, err as Error);
      }
    });

    // Add error handling for the initial subscribe call
    try {
      await subscriber.subscribe(outputChannel, eventsChannel, statusChannel);
      console.log(`[EventReceiver] Subscribed to run ${runId}`);
    } catch (err) {
      console.error(`[EventReceiver] Failed to subscribe to run ${runId}:`, err);
      // Clean up subscriber on error
      this.subscribers.delete(runId);
      await subscriber.quit().catch(() => {}); // Best-effort cleanup
      throw err;
    }
  }

  async unsubscribeFromRun(runId: string): Promise<void> {
    const subscriber = this.subscribers.get(runId);
    if (!subscriber) return;

    await subscriber.quit();
    this.subscribers.delete(runId);
    console.log(`[EventReceiver] Unsubscribed from run ${runId}`);
  }

  async close(): Promise<void> {
    for (const [runId, subscriber] of this.subscribers) {
      await subscriber.quit();
      console.log(`[EventReceiver] Closed subscriber for ${runId}`);
    }
    this.subscribers.clear();
  }

  // Typed event methods
  onOutput(callback: (runId: string, msg: OutputMessage) => void): this {
    return this.on('output', callback);
  }

  onEvent(callback: (runId: string, msg: EventMessage) => void): this {
    return this.on('event', callback);
  }

  onStatus(callback: (runId: string, msg: StatusMessage) => void): this {
    return this.on('status', callback);
  }

  onError(callback: (runId: string, err: Error) => void): this {
    return this.on('error', callback);
  }
}
