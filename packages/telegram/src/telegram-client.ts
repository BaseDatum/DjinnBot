/**
 * TelegramClient — typed wrapper around grammy Bot for Telegram operations.
 *
 * Provides a clean interface for the TelegramAgentBridge to send messages,
 * manage typing indicators, and validate bot tokens. Each agent gets its
 * own TelegramClient instance with its own bot token.
 */

import { Bot } from 'grammy';
import type { UserFromGetMe } from 'grammy/types';

export interface TelegramClientConfig {
  botToken: string;
}

export class TelegramClient {
  private bot: Bot;
  private botInfo: UserFromGetMe | null = null;

  constructor(config: TelegramClientConfig) {
    this.bot = new Bot(config.botToken);
  }

  /**
   * Get the underlying grammy Bot instance.
   * Used by TelegramAgentBridge for registering handlers and starting polling.
   */
  getBot(): Bot {
    return this.bot;
  }

  /**
   * Validate the bot token and resolve bot info via getMe().
   * Must be called before starting polling.
   */
  async init(): Promise<{ username: string; id: number; firstName: string }> {
    await this.bot.init();
    this.botInfo = this.bot.botInfo;
    return {
      username: this.botInfo.username,
      id: this.botInfo.id,
      firstName: this.botInfo.first_name,
    };
  }

  /**
   * Get the resolved bot username (available after init()).
   */
  getBotUsername(): string | undefined {
    return this.botInfo?.username;
  }

  // -- Messaging ----------------------------------------------------------------

  /**
   * Send a text message to a chat.
   * @param chatId Numeric Telegram chat ID
   * @param text Message text (plain or HTML)
   * @param opts Optional: parse_mode, reply_to_message_id
   */
  async sendMessage(
    chatId: number,
    text: string,
    opts?: {
      parseMode?: 'HTML' | 'MarkdownV2';
      replyToMessageId?: number;
      disableNotification?: boolean;
    },
  ): Promise<{ messageId: number; chatId: number }> {
    const result = await this.bot.api.sendMessage(chatId, text, {
      parse_mode: opts?.parseMode,
      reply_to_message_id: opts?.replyToMessageId,
      disable_notification: opts?.disableNotification,
    } as Parameters<typeof this.bot.api.sendMessage>[2]);

    return {
      messageId: result.message_id,
      chatId: result.chat.id,
    };
  }

  // -- Chat actions -------------------------------------------------------------

  /**
   * Send a chat action (e.g. 'typing') to a chat.
   * Must be resent every ~5s to keep the indicator alive.
   */
  async sendChatAction(
    chatId: number,
    action: 'typing' | 'upload_photo' | 'upload_document' | 'upload_video',
  ): Promise<void> {
    await this.bot.api.sendChatAction(chatId, action);
  }

  // -- Lifecycle ----------------------------------------------------------------

  /**
   * Start long-polling for updates.
   * The bot processes updates via registered handlers.
   */
  startPolling(): void {
    this.bot.start({
      onStart: () => {
        console.log(`[TelegramClient] Polling started for @${this.botInfo?.username ?? 'unknown'}`);
      },
    });
  }

  /**
   * Stop polling gracefully.
   */
  async stop(): Promise<void> {
    await this.bot.stop();
  }
}
