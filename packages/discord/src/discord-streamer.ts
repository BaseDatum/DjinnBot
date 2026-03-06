/**
 * DiscordStreamer — provides LLM-style streaming UX on Discord using
 * message editing, typing indicators, and embed-based task cards.
 *
 * Discord doesn't have a native streaming API like Slack's chatStream.
 * Instead, we:
 *   1. Post an initial placeholder message with a "Thinking..." embed
 *   2. Fire typing indicators on a 7-second keepalive loop
 *   3. Edit the message with accumulated text chunks (debounced ~500ms)
 *   4. Show tool calls as embed fields
 *   5. On completion: final edit with full response + reaction buttons
 *
 * Rate limit safety:
 *   Discord allows ~5 message edits per 5 seconds per message.
 *   The 500ms debounce stays safely within this limit.
 *
 * Message length handling:
 *   Discord message content limit: 2000 chars
 *   Embed description limit: 4096 chars
 *   We use embeds for the main response body. For responses exceeding
 *   4096 chars, we post continuation messages.
 */

import type {
  Client,
  Message,
  TextChannel,
  DMChannel,
  NewsChannel,
  ThreadChannel,
  APIEmbed,
} from 'discord.js';

// ─── Types ────────────────────────────────────────────────────────────────────

export type TaskStatus = 'pending' | 'in_progress' | 'complete' | 'error';

export interface TaskCard {
  id: string;
  title: string;
  status: TaskStatus;
  details?: string;
  output?: string;
}

export type StreamState = 'idle' | 'streaming' | 'stopped' | 'error';

type SendableChannel = TextChannel | DMChannel | NewsChannel | ThreadChannel;

export interface DiscordStreamerOptions {
  /** The channel to post in */
  channel: SendableChannel;
  /** If replying in a thread, the thread channel */
  threadChannel?: ThreadChannel;
  /** Message to reply to (for threading) */
  replyToMessageId?: string;
}

// ─── Constants ────────────────────────────────────────────────────────────────

/** Debounce interval for message edits (ms) */
const EDIT_DEBOUNCE_MS = 500;

/** Maximum embed description length (Discord limit) */
const MAX_EMBED_DESC = 4096;

/** Maximum content length for a single message (Discord limit) */
const MAX_CONTENT_LEN = 2000;

/** Typing keepalive interval — Discord typing expires after ~8s */
const TYPING_KEEPALIVE_MS = 7_000;

/** Maximum typing duration (safety TTL) */
const TYPING_MAX_DURATION_MS = 120_000;

/** Status emoji mapping */
const STATUS_EMOJI: Record<TaskStatus, string> = {
  pending: '⏳',
  in_progress: '🔄',
  complete: '✅',
  error: '❌',
};

/** Embed color for different states */
const EMBED_COLORS = {
  thinking: 0x5865F2,  // Discord blurple
  streaming: 0x57F287,  // Green
  error: 0xED4245,      // Red
  complete: 0x5865F2,   // Blurple
} as const;

// ─── DiscordStreamer ──────────────────────────────────────────────────────────

export class DiscordStreamer {
  readonly options: DiscordStreamerOptions;
  private message: Message | null = null;
  private state: StreamState = 'idle';
  private textBuffer = '';
  private tasks = new Map<string, TaskCard>();
  private editTimer: NodeJS.Timeout | null = null;
  private typingInterval: NodeJS.Timeout | null = null;
  private typingStartedAt = 0;
  private consecutiveTypingFailures = 0;
  /** Serialization queue for edits — prevents overlapping Discord API calls */
  private editQueue: Promise<void> = Promise.resolve();
  /** Continuation messages for very long responses */
  private continuationMessages: Message[] = [];
  /** Text already committed to previous messages (for overflow tracking) */
  private committedLength = 0;

  constructor(options: DiscordStreamerOptions) {
    this.options = options;
  }

  // ─── Lifecycle ──────────────────────────────────────────────────────────────

  /**
   * Start the stream. Posts an initial "Thinking..." embed and begins typing.
   */
  async start(initialStatus?: string): Promise<void> {
    if (this.state !== 'idle') {
      console.warn('[DiscordStreamer] start() called on non-idle streamer, ignoring');
      return;
    }

    const channel = this.options.threadChannel ?? this.options.channel;

    // Start typing indicator
    this.startTyping(channel);

    try {
      const embed: APIEmbed = {
        description: initialStatus ?? '_Thinking..._',
        color: EMBED_COLORS.thinking,
      };

      this.message = await channel.send({
        embeds: [embed],
        ...(this.options.replyToMessageId
          ? { reply: { messageReference: this.options.replyToMessageId } }
          : {}),
      });

      this.state = 'streaming';
    } catch (err) {
      this.state = 'error';
      this.stopTyping();
      console.error('[DiscordStreamer] Failed to start stream:', err);
      throw err;
    }
  }

  /**
   * Append text to the streamed response.
   * Safe to call in a tight loop — edits are debounced internally.
   */
  async appendText(text: string): Promise<void> {
    if (this.state !== 'streaming') {
      // Buffer for fallback post on stop()
      this.textBuffer += text;
      return;
    }

    this.textBuffer += text;
    this.scheduleFlush();
  }

  /**
   * Add or update a task card in the embed.
   */
  async updateTask(
    id: string,
    title: string,
    status: TaskStatus,
    details?: string,
    output?: string,
  ): Promise<void> {
    this.tasks.set(id, { id, title, status, details, output });

    if (this.state === 'streaming') {
      this.scheduleFlush();
    }
  }

  /**
   * Stop the stream with a successful completion.
   */
  async stop(opts?: { finalText?: string; includeFeedback?: boolean }): Promise<void> {
    // Drain any pending edits
    if (this.editTimer) {
      clearTimeout(this.editTimer);
      this.editTimer = null;
    }
    try { await this.editQueue; } catch { /* swallow */ }

    this.stopTyping();

    if (opts?.finalText) {
      this.textBuffer += opts.finalText;
    }

    // Fallback: stream never started
    if (!this.message || this.state === 'idle') {
      const text = this.textBuffer.trim();
      if (text) {
        const channel = this.options.threadChannel ?? this.options.channel;
        try {
          const msg = await channel.send({
            content: text.slice(0, MAX_CONTENT_LEN),
          });
          if (opts?.includeFeedback !== false) {
            await this.addFeedbackReactions(msg);
          }
        } catch (err) {
          console.warn('[DiscordStreamer] plain fallback send failed:', err);
        }
      }
      this.state = 'stopped';
      return;
    }

    if (this.state !== 'streaming') return;

    // Final flush
    await this.flush(true);

    // Add feedback reactions
    if (opts?.includeFeedback !== false && this.message) {
      await this.addFeedbackReactions(this.message);
    }

    this.state = 'stopped';
  }

  /**
   * Stop the stream with an error state.
   */
  async stopWithError(errorMessage: string): Promise<void> {
    if (this.editTimer) {
      clearTimeout(this.editTimer);
      this.editTimer = null;
    }
    try { await this.editQueue; } catch { /* swallow */ }

    this.stopTyping();

    if (!this.message || this.state === 'idle') {
      const channel = this.options.threadChannel ?? this.options.channel;
      try {
        await channel.send({
          embeds: [{
            description: `⚠️ ${errorMessage}`,
            color: EMBED_COLORS.error,
          }],
        });
      } catch { /* ignore */ }
      this.state = 'error';
      return;
    }

    // Mark in-progress tasks as errored
    for (const [, task] of this.tasks) {
      if (task.status === 'in_progress' || task.status === 'pending') {
        task.status = 'error';
        task.details = 'Interrupted';
      }
    }

    // Final edit with error message
    try {
      await this.message.edit({
        content: '',
        embeds: [this.buildEmbed(
          this.textBuffer + `\n\n⚠️ ${errorMessage}`,
          EMBED_COLORS.error,
        )],
      });
    } catch (err) {
      console.warn('[DiscordStreamer] stopWithError edit failed:', err);
    }

    this.state = 'error';
  }

  get currentState(): StreamState {
    return this.state;
  }

  /** Get the message that's being streamed to */
  getMessage(): Message | null {
    return this.message;
  }

  // ─── Typing Management ──────────────────────────────────────────────────────

  private startTyping(channel: SendableChannel): void {
    this.typingStartedAt = Date.now();
    this.consecutiveTypingFailures = 0;

    // Fire immediately
    channel.sendTyping().catch(() => {
      this.consecutiveTypingFailures++;
    });

    // Keepalive loop
    this.typingInterval = setInterval(() => {
      // Safety TTL
      if (Date.now() - this.typingStartedAt > TYPING_MAX_DURATION_MS) {
        console.warn('[DiscordStreamer] Typing TTL exceeded, stopping');
        this.stopTyping();
        return;
      }

      channel.sendTyping().catch(() => {
        this.consecutiveTypingFailures++;
        if (this.consecutiveTypingFailures >= 2) {
          console.warn('[DiscordStreamer] Typing circuit breaker tripped');
          this.stopTyping();
        }
      });
    }, TYPING_KEEPALIVE_MS);

    this.typingInterval.unref?.();
  }

  private stopTyping(): void {
    if (this.typingInterval) {
      clearInterval(this.typingInterval);
      this.typingInterval = null;
    }
  }

  // ─── Message Editing ────────────────────────────────────────────────────────

  private scheduleFlush(): void {
    if (this.editTimer) return;
    this.editTimer = setTimeout(() => {
      this.editTimer = null;
      this.editQueue = this.editQueue.then(() => this.flush(false)).catch(() => {});
    }, EDIT_DEBOUNCE_MS);
  }

  private async flush(isFinal: boolean): Promise<void> {
    if (!this.message || (this.state !== 'streaming' && !isFinal)) return;

    const currentText = this.textBuffer;

    // Check if we need to overflow to a continuation message.
    // The text that hasn't been committed yet starts at `committedLength`.
    const uncommittedText = currentText.slice(this.committedLength);

    // If the total text for the current message exceeds the embed limit,
    // commit what we have and start a new continuation message.
    if (uncommittedText.length > MAX_EMBED_DESC - 200 && !isFinal) {
      // Commit current text to the existing message
      try {
        const embed = this.buildEmbed(
          currentText.slice(this.committedLength, this.committedLength + MAX_EMBED_DESC - 200),
          EMBED_COLORS.streaming,
        );
        await this.message.edit({ content: '', embeds: [embed] });
      } catch (err) {
        console.warn('[DiscordStreamer] overflow edit failed:', err);
      }

      this.committedLength = currentText.length;

      // Create continuation message
      const channel = this.options.threadChannel ?? this.options.channel;
      try {
        this.message = await channel.send({
          embeds: [{ description: '_Continuing..._', color: EMBED_COLORS.streaming }],
        });
        this.continuationMessages.push(this.message);
      } catch (err) {
        console.warn('[DiscordStreamer] continuation send failed:', err);
      }
      return;
    }

    // Normal edit — update the current message with accumulated text + task cards
    const displayText = currentText.slice(this.committedLength);
    const color = isFinal ? EMBED_COLORS.complete : EMBED_COLORS.streaming;

    try {
      await this.message.edit({
        content: '',
        embeds: [this.buildEmbed(displayText, color)],
      });
    } catch (err) {
      console.warn('[DiscordStreamer] flush edit failed:', err);
    }
  }

  /**
   * Build a Discord embed with the response text and task cards.
   */
  private buildEmbed(text: string, color: number): APIEmbed {
    const embed: APIEmbed = {
      color,
    };

    // Truncate text to embed description limit
    const truncatedText = text.length > MAX_EMBED_DESC
      ? text.slice(0, MAX_EMBED_DESC - 20) + '\n\n_...truncated_'
      : text;

    if (truncatedText.trim()) {
      embed.description = truncatedText;
    }

    // Add task cards as embed fields
    if (this.tasks.size > 0) {
      embed.fields = [];
      for (const [, task] of this.tasks) {
        const emoji = STATUS_EMOJI[task.status];
        let value = task.details ?? '';
        if (task.output) {
          value += value ? '\n' : '';
          value += `\`\`\`\n${task.output.slice(0, 200)}\n\`\`\``;
        }
        embed.fields.push({
          name: `${emoji} ${task.title}`,
          value: value || '\u200b', // Zero-width space for empty fields
          inline: false,
        });

        // Discord limits: max 25 fields per embed
        if (embed.fields.length >= 25) break;
      }
    }

    return embed;
  }

  /**
   * Add thumbs up/down reactions for feedback.
   */
  private async addFeedbackReactions(message: Message): Promise<void> {
    try {
      await message.react('👍');
      await message.react('👎');
    } catch (err) {
      // Non-critical — reactions may fail in some channels
      console.warn('[DiscordStreamer] Failed to add feedback reactions:', err);
    }
  }
}
