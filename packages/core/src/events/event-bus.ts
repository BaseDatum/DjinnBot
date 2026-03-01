import { Redis, type Redis as RedisType } from 'ioredis';
import type { PipelineEvent } from '../types/events.js';

export interface EventBusConfig {
  redisUrl: string;
  consumerGroup?: string;
  consumerId?: string;
}

interface StreamMessage {
  id: string;
  data: PipelineEvent & { _messageId?: string };
}

export class EventBus {
  private redis: RedisType;
  private subscriber: RedisType;
  private subscriptions = new Map<string, Set<(event: PipelineEvent) => void | Promise<void>>>();
  private abortControllers = new Map<string, AbortController>();
  private isRunning = false;
  private reconnectDelay = 1000;
  private maxReconnectDelay = 30000;

  constructor(config: EventBusConfig) {
    this.redis = new Redis(config.redisUrl, {
      retryStrategy: (times) => {
        const delay = Math.min(times * this.reconnectDelay, this.maxReconnectDelay);
        return delay;
      },
      maxRetriesPerRequest: 3,
    });

    this.subscriber = new Redis(config.redisUrl, {
      retryStrategy: (times) => {
        const delay = Math.min(times * this.reconnectDelay, this.maxReconnectDelay);
        return delay;
      },
      maxRetriesPerRequest: null, // Allow blocking reads
    });

    this.setupErrorHandlers();
    this.isRunning = true;
  }

  private setupErrorHandlers(): void {
    this.redis.on('error', (err) => {
      console.error('Redis connection error:', err.message);
    });

    this.redis.on('connect', () => {
      console.log('Redis connected (publisher)');
    });

    this.subscriber.on('error', (err) => {
      console.error('Redis subscriber error:', err.message);
    });

    this.subscriber.on('connect', () => {
      console.log('Redis connected (subscriber)');
    });
  }

  async publish(channel: string, event: PipelineEvent): Promise<string> {
    const data = JSON.stringify(event);
    const id = await this.redis.xadd(channel, '*', 'data', data);
    return id ?? '';
  }

  subscribe(
    channel: string,
    callback: (event: PipelineEvent) => void | Promise<void>,
    options?: { fromId?: string },
  ): () => void {
    if (!this.subscriptions.has(channel)) {
      this.subscriptions.set(channel, new Set());
      this.startListening(channel, options?.fromId);
    }

    const callbacks = this.subscriptions.get(channel)!;
    callbacks.add(callback);

    return () => {
      callbacks.delete(callback);
      if (callbacks.size === 0) {
        this.subscriptions.delete(channel);
        this.stopListening(channel);
      }
    };
  }

  /**
   * Get the latest stream ID for a channel (the ID of the most recent message).
   * Returns '$' if the stream is empty or doesn't exist.
   * Useful for subscribing from "now" without replaying history.
   */
  async getLatestStreamId(channel: string): Promise<string> {
    try {
      const result = await this.redis.xrevrange(channel, '+', '-', 'COUNT', 1);
      if (Array.isArray(result) && result.length > 0) {
        return result[0][0];
      }
    } catch {
      // Stream doesn't exist or Redis error — fall through
    }
    return '$';
  }

  private async startListening(channel: string, fromId?: string): Promise<void> {
    const abortController = new AbortController();
    this.abortControllers.set(channel, abortController);

    // Default: start from '0' to catch events published between subscribe() and
    // first xread(). For resumed runs, callers should pass fromId (e.g. the latest
    // stream ID) to avoid replaying historical events that were already processed.
    let lastId = fromId ?? '0';

    const listen = async (): Promise<void> => {
      while (!abortController.signal.aborted && this.isRunning) {
        try {
          const results = await this.subscriber.xread(
            'BLOCK',
            5000, // 5 second block
            'STREAMS',
            channel,
            lastId
          );

          if (results && Array.isArray(results)) {
            for (const [streamName, messages] of results) {
              if (!Array.isArray(messages)) continue;

              for (const [id, fields] of messages) {
                const message = this.parseMessage(fields);
                if (message) {
                  lastId = id;
                  await this.notifySubscribers(channel, message);
                }
              }
            }
          }
        } catch (error) {
          if (abortController.signal.aborted || !this.isRunning) {
            break;
          }
          console.error(`Error reading from stream ${channel}:`, error);
          await this.delay(1000);
        }
      }
    };

    listen().catch((err) => {
      console.error(`Listen loop failed for ${channel}:`, err);
    });
  }

  private stopListening(channel: string): void {
    const abortController = this.abortControllers.get(channel);
    if (abortController) {
      abortController.abort();
      this.abortControllers.delete(channel);
    }
  }

  private parseMessage(fields: (string | Buffer)[]): StreamMessage | null {
    const fieldArray = Array.isArray(fields) ? fields : [fields];
    const dataIndex = fieldArray.findIndex((f) => f.toString() === 'data');

    if (dataIndex !== -1 && dataIndex + 1 < fieldArray.length) {
      try {
        const dataStr = fieldArray[dataIndex + 1].toString();
        const data = JSON.parse(dataStr) as PipelineEvent;
        return { id: '', data };
      } catch (err) {
        console.error('Failed to parse message data:', err);
        return null;
      }
    }
    return null;
  }

  private async notifySubscribers(channel: string, message: StreamMessage): Promise<void> {
    const callbacks = this.subscriptions.get(channel);
    if (!callbacks) return;

    const promises: Promise<void>[] = [];
    for (const callback of callbacks) {
      try {
        const result = callback(message.data);
        if (result instanceof Promise) {
          promises.push(
            result.catch((err) => {
              console.error('Subscriber callback error:', err);
            })
          );
        }
      } catch (err) {
        console.error('Subscriber callback error:', err);
      }
    }

    await Promise.all(promises);
  }

  async readHistory(channel: string, options?: { count?: number; fromId?: string }): Promise<PipelineEvent[]> {
    const count = options?.count ?? 100;
    const fromId = options?.fromId ?? '0';

    const results = await this.redis.xrange(channel, fromId, '+', 'COUNT', count);

    if (!Array.isArray(results)) {
      return [];
    }

    const events: PipelineEvent[] = [];
    for (const [id, fields] of results) {
      const message = this.parseMessage(fields);
      if (message) {
        events.push(message.data);
      }
    }

    return events;
  }

  async createConsumerGroup(channel: string, groupName: string): Promise<void> {
    try {
      await this.redis.xgroup('CREATE', channel, groupName, '$', 'MKSTREAM');
    } catch (error) {
      // Ignore if group already exists
      if (error instanceof Error && error.message.includes('already exists')) {
        return;
      }
      throw error;
    }
  }

  async readAsConsumer(
    channel: string,
    groupName: string,
    consumerId: string,
    count = 10
  ): Promise<PipelineEvent[]> {
    const results = await this.redis.xreadgroup(
      'GROUP',
      groupName,
      consumerId,
      'COUNT',
      count,
      'BLOCK',
      5000,
      'STREAMS',
      channel,
      '>'
    );

    if (!Array.isArray(results)) {
      return [];
    }

    const events: Array<PipelineEvent & { _messageId?: string }> = [];
    for (const [streamName, messages] of results as Array<[string, Array<[string, string[]]>]>) {
      if (!Array.isArray(messages)) continue;

      for (const [id, fields] of messages) {
        const message = this.parseMessage(fields);
        if (message) {
          events.push({ ...message.data, _messageId: id });
        }
      }
    }

    return events;
  }

  async ack(channel: string, groupName: string, messageId: string): Promise<void> {
    await this.redis.xack(channel, groupName, messageId);
  }

  /**
   * Trim a stream to keep only the most recent N entries.
   * Useful for cleaning up stale events on run resume to prevent unbounded growth.
   */
  async trimStream(channel: string, maxLen: number = 100): Promise<number> {
    try {
      const result = await this.redis.xtrim(channel, 'MAXLEN', '~', maxLen);
      return result;
    } catch {
      return 0;
    }
  }

  async close(): Promise<void> {
    this.isRunning = false;

    // Stop all listening loops
    for (const [channel, abortController] of this.abortControllers) {
      abortController.abort();
    }
    this.abortControllers.clear();
    this.subscriptions.clear();

    // Close connections
    await this.redis.quit();
    await this.subscriber.quit();
  }

  private delay(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}
