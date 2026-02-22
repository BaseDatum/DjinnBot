import { WebClient } from '@slack/web-api';
import type { ChatPostMessageResponse, ConversationsRepliesResponse } from '@slack/web-api';
import type { MessagingProvider, SlackConfig, ThreadMessage } from './types.js';

/**
 * Slack implementation of the MessagingProvider interface
 */
export class SlackProvider implements MessagingProvider {
  name = 'slack' as const;
  private client: WebClient;
  private config: SlackConfig;

  constructor(config: SlackConfig) {
    this.config = config;
    this.client = new WebClient(config.botToken);
  }

  private requireChannelId(): string {
    if (!this.config.defaultChannelId) {
      throw new Error('[SlackProvider] defaultChannelId is required for this operation but was not configured');
    }
    return this.config.defaultChannelId;
  }

  /**
   * Create a new thread by posting an initial message
   * Returns the thread timestamp (thread_ts) which serves as the threadId
   */
  async createThread(options: {
    channelId: string;
    title: string;
    runId: string;
  }): Promise<string> {
    try {
      const response = await this.client.chat.postMessage({
        channel: options.channelId,
        text: `🚀 *Pipeline Run: ${options.runId}*\n${options.title}`,
        blocks: [
          {
            type: 'header',
            text: {
              type: 'plain_text',
              text: `Pipeline Run: ${options.runId}`,
              emoji: true,
            },
          },
          {
            type: 'section',
            text: {
              type: 'mrkdwn',
              text: `*Task:* ${options.title}`,
            },
          },
          {
            type: 'context',
            elements: [
              {
                type: 'mrkdwn',
                text: `⏱️ Started at ${new Date().toISOString()}`,
              },
            ],
          },
        ],
      });

      if (!response.ok || !response.ts) {
        throw new Error(`Failed to create thread: ${response.error}`);
      }

      return response.ts;
    } catch (error) {
      console.error('Slack createThread error:', error);
      throw error;
    }
  }

  /**
   * Post a message to an existing thread
   */
  async postMessage(options: {
    threadId: string;
    agentId: string;
    content: string;
    metadata?: Record<string, string>;
  }): Promise<string> {
    try {
      const emoji = this.getAgentEmoji(options.agentId);
      const text = `${emoji} *${options.agentId}*\n${options.content}`;

      const response: ChatPostMessageResponse = await this.client.chat.postMessage({
        channel: this.requireChannelId(),
        thread_ts: options.threadId,
        text,
        blocks: [
          {
            type: 'section',
            text: {
              type: 'mrkdwn',
              text: `${emoji} *${options.agentId}*`,
            },
          },
          {
            type: 'section',
            text: {
              type: 'mrkdwn',
              text: options.content,
            },
          },
        ],
      });

      if (!response.ok || !response.ts) {
        throw new Error(`Failed to post message: ${response.error}`);
      }

      return response.ts;
    } catch (error) {
      console.error('Slack postMessage error:', error);
      throw error;
    }
  }

  /**
   * Post a rich status update using Block Kit
   */
  async postStatus(options: {
    threadId: string;
    status: 'started' | 'completed' | 'failed' | 'step_update';
    title: string;
    details?: string;
    color?: string;
  }): Promise<string> {
    try {
      const statusConfig = this.getStatusConfig(options.status);
      const color = options.color || statusConfig.color;

      const response: ChatPostMessageResponse = await this.client.chat.postMessage({
        channel: this.requireChannelId(),
        thread_ts: options.threadId,
        text: `${statusConfig.emoji} ${options.title}`,
        blocks: [
          {
            type: 'section',
            text: {
              type: 'mrkdwn',
              text: `${statusConfig.emoji} *${options.title}*`,
            },
          },
          ...(options.details
            ? [
                {
                  type: 'section' as const,
                  text: {
                    type: 'mrkdwn' as const,
                    text: options.details,
                  },
                },
              ]
            : []),
          {
            type: 'context',
            elements: [
              {
                type: 'mrkdwn',
                text: `Status: ${options.status} | ${new Date().toISOString()}`,
              },
            ],
          },
        ],
      });

      if (!response.ok || !response.ts) {
        throw new Error(`Failed to post status: ${response.error}`);
      }

      return response.ts;
    } catch (error) {
      console.error('Slack postStatus error:', error);
      throw error;
    }
  }

  /**
   * Read messages from a thread
   */
  async readThread(threadId: string, limit = 100): Promise<ThreadMessage[]> {
    try {
      const response: ConversationsRepliesResponse = await this.client.conversations.replies({
        channel: this.requireChannelId(),
        ts: threadId,
        limit,
      });

      if (!response.ok || !response.messages) {
        throw new Error(`Failed to read thread: ${response.error}`);
      }

      return response.messages.map((msg: any) => ({
        id: msg.ts || '',
        authorId: msg.user || 'unknown',
        authorName: msg.username || msg.user || 'unknown',
        content: msg.text || '',
        timestamp: msg.ts ? parseInt(msg.ts.split('.')[0]) * 1000 : Date.now(),
        threadId,
      }));
    } catch (error) {
      console.error('Slack readThread error:', error);
      throw error;
    }
  }

  /**
   * Send a direct message to a user
   * Opens a DM channel if needed and sends the message
   */
  async sendDm(options: {
    userId: string;
    message: string;
    agentId?: string;
  }): Promise<string> {
    try {
      // Open a DM channel with the user
      const openResponse = await this.client.conversations.open({
        users: options.userId,
      });

      if (!openResponse.ok || !openResponse.channel?.id) {
        throw new Error(`Failed to open DM channel: ${openResponse.error}`);
      }

      const channelId = openResponse.channel.id;
      const emoji = options.agentId ? this.getAgentEmoji(options.agentId) : '🤖';
      const prefix = options.agentId ? `${emoji} *${options.agentId}*\n` : '';

      const response = await this.client.chat.postMessage({
        channel: channelId,
        text: `${prefix}${options.message}`,
      });

      if (!response.ok || !response.ts) {
        throw new Error(`Failed to send DM: ${response.error}`);
      }

      return response.ts;
    } catch (error) {
      console.error('Slack sendDm error:', error);
      throw error;
    }
  }

  /**
   * Add a reaction to a message
   */
  async addReaction(messageId: string, emoji: string): Promise<void> {
    try {
      // Remove colons if present (Slack emoji names shouldn't have them)
      const cleanEmoji = emoji.replace(/:/g, '');

      const response = await this.client.reactions.add({
        channel: this.requireChannelId(),
        timestamp: messageId,
        name: cleanEmoji,
      });

      if (!response.ok) {
        throw new Error(`Failed to add reaction: ${response.error}`);
      }
    } catch (error) {
      // Handle 'already_reacted' error gracefully
      if (error instanceof Error && error.message.includes('already_reacted')) {
        return;
      }
      console.error('Slack addReaction error:', error);
      throw error;
    }
  }

  /**
   * Get emoji for an agent, with fallback
   */
  private getAgentEmoji(agentId: string): string {
    return this.config.agentEmojis?.[agentId] || '🤖';
  }

  /**
   * Get status configuration (emoji and color) for status type
   */
  private getStatusConfig(status: 'started' | 'completed' | 'failed' | 'step_update'): {
    emoji: string;
    color: string;
  } {
    switch (status) {
      case 'started':
        return { emoji: '🚀', color: '#3498db' }; // blue
      case 'completed':
        return { emoji: '✅', color: '#2ecc71' }; // green
      case 'failed':
        return { emoji: '❌', color: '#e74c3c' }; // red
      case 'step_update':
        return { emoji: '🔄', color: '#95a5a6' }; // neutral
      default:
        return { emoji: 'ℹ️', color: '#95a5a6' };
    }
  }
}
