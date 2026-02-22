import { Redis, type Redis as RedisType } from 'ioredis';

export interface InboxMessage {
  id: string;
  from: string;
  to: string;
  message: string;
  priority: 'normal' | 'high' | 'urgent';
  type: 'info' | 'review_request' | 'help_request' | 'unblock';
  timestamp: number;
  metadata?: Record<string, string>;
}

interface InboxMessageInput {
  from: string;
  to: string;
  message: string;
  priority: 'normal' | 'high' | 'urgent';
  type: 'info' | 'review_request' | 'help_request' | 'unblock';
  timestamp: number;
  metadata?: Record<string, string>;
}

const DEFAULT_CLEANUP_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

export class AgentInbox {
  private redis: RedisType;
  private isConnected = false;

  constructor(private redisUrl: string) {
    this.redis = new Redis(redisUrl, {
      retryStrategy: (times) => {
        const delay = Math.min(times * 1000, 30000);
        return delay;
      },
      maxRetriesPerRequest: 3,
    });

    this.setupErrorHandlers();
  }

  private setupErrorHandlers(): void {
    this.redis.on('error', (err) => {
      console.error('AgentInbox Redis error:', err.message);
    });

    this.redis.on('connect', () => {
      this.isConnected = true;
    });

    this.redis.on('close', () => {
      this.isConnected = false;
    });
  }

  async connect(): Promise<void> {
    await this.redis.ping();
  }

  async close(): Promise<void> {
    await this.redis.quit();
    this.isConnected = false;
  }

  private getInboxKey(agentId: string): string {
    return `djinnbot:agent:${agentId}:inbox`;
  }

  private getLastReadKey(agentId: string): string {
    return `djinnbot:agent:${agentId}:inbox:last_read`;
  }

  async send(message: Omit<InboxMessage, 'id'>): Promise<string> {
    const fields: string[] = [
      'from',
      message.from,
      'to',
      message.to,
      'message',
      message.message,
      'priority',
      message.priority,
      'type',
      message.type,
      'timestamp',
      String(message.timestamp),
    ];

    if (message.metadata) {
      for (const [key, value] of Object.entries(message.metadata)) {
        fields.push(`metadata_${key}`, value);
      }
    }

    const inboxKey = this.getInboxKey(message.to);
    const id = await this.redis.xadd(inboxKey, '*', ...fields);
    return id ?? '';
  }

  /**
   * Publish a wake notification to trigger an immediate pulse for the target agent.
   * Used when a high/urgent priority message is sent.
   */
  async publishWake(agentId: string, from: string, priority: string, messageType: string, messageId: string): Promise<void> {
    const channel = `djinnbot:agent:${agentId}:wake`;
    const payload = JSON.stringify({ from, priority, messageType, messageId, timestamp: Date.now() });
    try {
      await this.redis.publish(channel, payload);
    } catch (err) {
      console.error(`[AgentInbox] Failed to publish wake for ${agentId}:`, err);
    }
  }

  async getUnread(agentId: string): Promise<InboxMessage[]> {
    const lastReadId = await this.redis.get(this.getLastReadKey(agentId));
    const startId = lastReadId ? this.incrementMessageId(lastReadId) : '0';

    const inboxKey = this.getInboxKey(agentId);
    const results = await this.redis.xrange(inboxKey, startId, '+');

    return this.parseMessages(results);
  }

  async getUnreadCount(agentId: string): Promise<number> {
    const messages = await this.getUnread(agentId);
    return messages.length;
  }

  async markRead(agentId: string, messageId: string): Promise<void> {
    const lastReadKey = this.getLastReadKey(agentId);
    const currentLastRead = await this.redis.get(lastReadKey);

    // Only update if the new message ID is greater
    if (!currentLastRead || this.compareMessageIds(messageId, currentLastRead) > 0) {
      await this.redis.set(lastReadKey, messageId);
    }
  }

  async getHistory(agentId: string, limit = 100): Promise<InboxMessage[]> {
    const inboxKey = this.getInboxKey(agentId);
    const results = await this.redis.xrevrange(inboxKey, '+', '0', 'COUNT', limit);
    return this.parseMessages(results);
  }

  async cleanup(agentId: string, olderThanMs = DEFAULT_CLEANUP_MS): Promise<number> {
    const cutoffTime = Date.now() - olderThanMs;
    const inboxKey = this.getInboxKey(agentId);

    // Get all messages to find which ones are older than cutoff
    const results = await this.redis.xrange(inboxKey, '0', '+');
    if (!Array.isArray(results) || results.length === 0) {
      return 0;
    }

    const toDelete: string[] = [];
    for (const [id, fields] of results) {
      const timestampField = this.findField(fields, 'timestamp');
      if (timestampField) {
        const msgTime = parseInt(timestampField, 10);
        if (msgTime < cutoffTime) {
          toDelete.push(id);
        }
      }
    }

    if (toDelete.length === 0) {
      return 0;
    }

    // Delete each message
    for (const id of toDelete) {
      await this.redis.xdel(inboxKey, id);
    }

    return toDelete.length;
  }

  private parseMessages(results: Array<[string, string[]]> | null): InboxMessage[] {
    if (!Array.isArray(results)) {
      return [];
    }

    const messages: InboxMessage[] = [];
    for (const [id, fields] of results) {
      const message = this.parseMessageFields(id, fields);
      if (message) {
        messages.push(message);
      }
    }

    return messages;
  }

  private parseMessageFields(id: string, fields: string[]): InboxMessage | null {
    try {
      const from = this.findField(fields, 'from');
      const to = this.findField(fields, 'to');
      const message = this.findField(fields, 'message');
      const priority = this.findField(fields, 'priority');
      const type = this.findField(fields, 'type');
      const timestamp = this.findField(fields, 'timestamp');

      if (!from || !to || !message || !priority || !type || !timestamp) {
        return null;
      }

      // Parse metadata fields
      const metadata: Record<string, string> = {};
      for (let i = 0; i < fields.length; i++) {
        if (fields[i].startsWith('metadata_')) {
          const key = fields[i].slice(9);
          const value = fields[i + 1];
          if (key && value) {
            metadata[key] = value;
          }
        }
      }

      return {
        id,
        from,
        to,
        message,
        priority: priority as InboxMessage['priority'],
        type: type as InboxMessage['type'],
        timestamp: parseInt(timestamp, 10),
        metadata: Object.keys(metadata).length > 0 ? metadata : undefined,
      };
    } catch (err) {
      console.error('Failed to parse inbox message:', err);
      return null;
    }
  }

  private findField(fields: string[], key: string): string | null {
    for (let i = 0; i < fields.length - 1; i++) {
      if (fields[i] === key) {
        return fields[i + 1];
      }
    }
    return null;
  }

  private incrementMessageId(id: string): string {
    // Redis stream IDs are in format "timestamp-sequence"
    // To get the next message after a given ID, we increment the sequence
    const parts = id.split('-');
    if (parts.length === 2) {
      const seq = parseInt(parts[1], 10);
      return `${parts[0]}-${seq + 1}`;
    }
    return id;
  }

  private compareMessageIds(id1: string, id2: string): number {
    const parts1 = id1.split('-');
    const parts2 = id2.split('-');

    if (parts1.length !== 2 || parts2.length !== 2) {
      return 0;
    }

    const time1 = parseInt(parts1[0], 10);
    const time2 = parseInt(parts2[0], 10);

    if (time1 !== time2) {
      return time1 - time2;
    }

    const seq1 = parseInt(parts1[1], 10);
    const seq2 = parseInt(parts2[1], 10);

    return seq1 - seq2;
  }
}
