/**
 * Generic messaging interface for pipeline notifications
 * Slack implements this; Discord and others can implement later
 */

export interface MessagingProvider {
  name: string;

  /**
   * Create a thread for a pipeline run
   * @returns threadId (timestamp for Slack threads)
   */
  createThread(options: {
    channelId: string;
    title: string;
    runId: string;
  }): Promise<string>;

  /**
   * Post a message to a thread
   * @returns messageId
   */
  postMessage(options: {
    threadId: string;
    agentId: string;
    content: string;
    metadata?: Record<string, string>;
  }): Promise<string>;

  /**
   * Post a status update with rich formatting (Block Kit, embeds, etc.)
   * @returns messageId
   */
  postStatus(options: {
    threadId: string;
    status: 'started' | 'completed' | 'failed' | 'step_update';
    title: string;
    details?: string;
    color?: string;
  }): Promise<string>;

  /**
   * Read messages from a thread
   */
  readThread(threadId: string, limit?: number): Promise<ThreadMessage[]>;

  /**
   * Add a reaction to a message
   */
  addReaction(messageId: string, emoji: string): Promise<void>;
}

export interface ThreadMessage {
  id: string;
  authorId: string;
  authorName: string;
  content: string;
  timestamp: number;
  threadId: string;
}

export interface SlackConfig {
  botToken: string;
  appToken?: string;      // For Socket Mode
  defaultChannelId?: string;
  agentEmojis?: Record<string, string>;  // agentId → emoji
}
