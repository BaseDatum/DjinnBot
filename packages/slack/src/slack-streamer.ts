/**
 * SlackStreamer — wraps the Slack chatStream API to provide LLM-style
 * streaming UX with task cards, thinking indicators, and feedback buttons.
 *
 * Used for all agent responses: DMs, channel thread replies, and
 * pipeline run step updates.
 *
 * Slack streaming API flow:
 *   client.chatStream()  → starts stream, returns ChatStreamer
 *   streamer.append()    → appends text chunks or task_update chunks
 *   streamer.stop()      → finalises with optional blocks (e.g. feedback)
 *
 * Task display modes:
 *   'plan'     — groups all task cards into a collapsible plan view
 *   'timeline' — shows each task card inline as it appears
 *
 * Concurrency note: Slack rate-limits appendStream. The SDK's ChatStreamer
 * buffers internally (default 256 chars) so we don't need to throttle
 * individual token appends — the SDK batches them for us.
 */

import type { WebClient } from '@slack/web-api';
import type { ChatStreamer } from '@slack/web-api';
import type {
  AnyChunk,
  MarkdownTextChunk,
  PlanUpdateChunk,
  TaskUpdateChunk,
} from '@slack/types';

// ─── Types ────────────────────────────────────────────────────────────────────

export type TaskStatus = 'pending' | 'in_progress' | 'complete' | 'error';

export interface TaskCard {
  id: string;
  title: string;
  status: TaskStatus;
  details?: string;
  output?: string;
}

export interface SlackStreamerOptions {
  client: WebClient;
  channel: string;
  threadTs: string;
  /** Required for streams outside of DMs (channel threads, pipeline runs) */
  recipientUserId?: string;
  recipientTeamId?: string;
  /** How to display task cards. Default: 'plan' */
  taskDisplayMode?: 'plan' | 'timeline';
  /** Initial plan/section title shown above task cards */
  planTitle?: string;
  /** Buffer size passed to ChatStreamer (default: 256 chars) */
  bufferSize?: number;
}

export type StreamState = 'idle' | 'streaming' | 'stopped' | 'error';

// ─── Feedback block builder ───────────────────────────────────────────────────

function buildFeedbackBlock() {
  return {
    type: 'context_actions',
    elements: [
      {
        type: 'feedback_buttons',
        action_id: 'agent_response_feedback',
        positive_button: {
          text: { type: 'plain_text', text: '👍' },
          accessibility_label: 'This response was helpful',
          value: 'positive',
        },
        negative_button: {
          text: { type: 'plain_text', text: '👎' },
          accessibility_label: 'This response was not helpful',
          value: 'negative',
        },
      },
    ],
  };
}

// ─── SlackStreamer ────────────────────────────────────────────────────────────

export class SlackStreamer {
  readonly options: SlackStreamerOptions;
  private streamer: ChatStreamer | null = null;
  private state: StreamState = 'idle';
  private tasks = new Map<string, TaskCard>();
  /** Accumulates output when chatStream is unavailable (state stays 'idle') */
  private plainTextBuffer = '';
  /**
   * Serialization queue for append operations.
   *
   * The Slack SDK's ChatStreamer has a race condition: `append()` accumulates
   * text into an internal buffer (sync), then flushes via `chat.appendStream`
   * (async). The buffer is only cleared AFTER the API call returns. If a second
   * `append()` runs while the flush is in-flight, it sees the un-cleared buffer,
   * exceeds the threshold, and triggers another flush with overlapping content.
   * Slack then appends the same text twice, producing the "repeated content"
   * artefact visible in long streaming responses.
   *
   * By chaining every append/updateTask through this promise, we guarantee
   * each SDK `append()` (and its potential flush) completes before the next
   * one starts, eliminating the overlap.
   */
  private appendQueue: Promise<void> = Promise.resolve();

  constructor(options: SlackStreamerOptions) {
    this.options = options;
  }

  // ─── Lifecycle ──────────────────────────────────────────────────────────────

  /**
   * Start the stream. Must be called before any append/updateTask calls.
   * Optionally sets an initial status indicator via assistant.threads.setStatus.
   */
  async start(initialStatus?: string): Promise<void> {
    if (this.state !== 'idle') {
      console.warn('[SlackStreamer] start() called on non-idle streamer, ignoring');
      return;
    }

    // Set the typing/loading indicator in the assistant thread if requested
    if (initialStatus) {
      await this.setStatus(initialStatus);
    }

    try {
      this.streamer = this.options.client.chatStream({
        channel: this.options.channel,
        thread_ts: this.options.threadTs,
        ...(this.options.recipientUserId ? { recipient_user_id: this.options.recipientUserId } : {}),
        ...(this.options.recipientTeamId ? { recipient_team_id: this.options.recipientTeamId } : {}),
        task_display_mode: this.options.taskDisplayMode ?? 'plan',
        buffer_size: this.options.bufferSize ?? 256,
      });
      this.state = 'streaming';

      // Eagerly open the stream by sending an empty markdown_text append.
      // The SDK defers chat.startStream until the first flushBuffer call, so
      // without this the stream isn't actually opened until the first real token
      // arrives. Flushing immediately ensures the Slack message placeholder
      // exists before any async work begins, and confirms the stream is live
      // (throws here rather than silently failing mid-response).
      await this.streamer.append({ markdown_text: '' });
    } catch (err) {
      this.state = 'error';
      console.error('[SlackStreamer] Failed to start stream:', err);
      throw err;
    }
  }

  /**
   * Append markdown text to the stream (streaming LLM output token by token).
   * Safe to call in a tight loop — calls are serialized internally to prevent
   * the Slack SDK's buffer from being flushed with overlapping content.
   */
  async appendText(text: string): Promise<void> {
    if (this.state !== 'streaming') {
      // Stream not active — buffer for plain-text fallback post on stop()
      this.plainTextBuffer += text;
      return;
    }
    // Chain onto the serialization queue so each SDK append (and its potential
    // internal buffer flush) completes before the next one begins.
    this.appendQueue = this.appendQueue.then(async () => {
      if (this.state !== 'streaming') return;
      try {
        await this.streamer!.append({ markdown_text: text });
      } catch (err) {
        console.warn('[SlackStreamer] appendText failed:', err);
      }
    });
    return this.appendQueue;
  }

  /**
   * Add or update a task card in the plan view.
   * Call this when a tool starts (status: 'in_progress') and when it completes.
   */
  async updateTask(
    id: string,
    title: string,
    status: TaskStatus,
    details?: string,
    output?: string,
  ): Promise<void> {
    if (!this.streamer || this.state !== 'streaming') return;

    // Track task state locally
    this.tasks.set(id, { id, title, status, details, output });

    // Serialize with text appends to avoid overlapping SDK buffer flushes.
    this.appendQueue = this.appendQueue.then(async () => {
      if (this.state !== 'streaming') return;
      try {
        const taskChunk: TaskUpdateChunk = {
          type: 'task_update',
          id,
          title,
          status,
          ...(details ? { details } : {}),
          ...(output ? { output } : {}),
        };
        await this.streamer!.append({ chunks: [taskChunk] });
      } catch (err) {
        console.warn('[SlackStreamer] updateTask failed:', err);
      }
    });
    return this.appendQueue;
  }

  /**
   * Update the plan title (shown above the task card group).
   */
  async updatePlanTitle(title: string): Promise<void> {
    if (!this.streamer || this.state !== 'streaming') return;
    this.appendQueue = this.appendQueue.then(async () => {
      if (this.state !== 'streaming') return;
      try {
        const planChunk: PlanUpdateChunk = { type: 'plan_update', title };
        await this.streamer!.append({ chunks: [planChunk] });
      } catch (err) {
        console.warn('[SlackStreamer] updatePlanTitle failed:', err);
      }
    });
    return this.appendQueue;
  }

  /**
   * Stop the stream and finalize with feedback buttons.
   * Optionally appends a final text chunk before stopping.
   */
  async stop(opts?: { finalText?: string; includeFeedback?: boolean }): Promise<void> {
    // Drain any in-flight appends before stopping so we don't race with the SDK.
    try { await this.appendQueue; } catch { /* swallow — individual errors already logged */ }

    // Fallback path: chatStream was never started — post accumulated buffer as plain message
    if (!this.streamer || this.state === 'idle') {
      const text = (this.plainTextBuffer + (opts?.finalText ?? '')).trim();
      if (text) {
        try {
          await this.options.client.chat.postMessage({
            channel: this.options.channel,
            thread_ts: this.options.threadTs,
            text,
          });
        } catch (err) {
          console.warn('[SlackStreamer] plain fallback postMessage failed:', err);
        }
      }
      this.state = 'stopped';
      await this.clearStatus();
      return;
    }

    if (this.state !== 'streaming') return;

    const chunks: AnyChunk[] = [];
    if (opts?.finalText) {
      chunks.push({ type: 'markdown_text', text: opts.finalText } as MarkdownTextChunk);
    }

    const blocks = opts?.includeFeedback !== false ? [buildFeedbackBlock()] : [];

    try {
      await this.streamer.stop({
        ...(chunks.length > 0 ? { chunks } : {}),
        ...(blocks.length > 0 ? { blocks } : {}),
      });
    } catch (err) {
      console.warn('[SlackStreamer] stop failed:', err);
    } finally {
      this.state = 'stopped';
      await this.clearStatus();
    }
  }

  /**
   * Stop the stream with an error state — marks all in-progress tasks as errored.
   */
  async stopWithError(errorMessage: string): Promise<void> {
    // Drain any in-flight appends before stopping.
    try { await this.appendQueue; } catch { /* swallow — individual errors already logged */ }

    if (!this.streamer || this.state === 'idle') {
      // Post as plain message
      try {
        await this.options.client.chat.postMessage({
          channel: this.options.channel,
          thread_ts: this.options.threadTs,
          text: `⚠️ ${errorMessage}`,
        });
      } catch { /* ignore */ }
      this.state = 'error';
      await this.clearStatus();
      return;
    }

    // Mark any in-progress tasks as errored
    const errorChunks: AnyChunk[] = [];
    for (const [id, task] of this.tasks) {
      if (task.status === 'in_progress' || task.status === 'pending') {
        errorChunks.push({
          type: 'task_update',
          id,
          title: task.title,
          status: 'error',
          details: 'Interrupted',
        } as TaskUpdateChunk);
      }
    }

    try {
      if (this.state === 'streaming') {
        await this.streamer.stop({
          chunks: [
            ...errorChunks,
            { type: 'markdown_text', text: `\n\n⚠️ ${errorMessage}` } as MarkdownTextChunk,
          ],
        });
      }
    } catch (err) {
      console.warn('[SlackStreamer] stopWithError failed:', err);
    } finally {
      this.state = 'error';
      await this.clearStatus();
    }
  }

  get currentState(): StreamState {
    return this.state;
  }

  // ─── Assistant thread status ─────────────────────────────────────────────────

  /**
   * Set the assistant thread loading status (typing indicator with custom text).
   * Requires assistant:write scope (enabled with Agents & AI Apps toggle).
   * Silently no-ops if the scope is unavailable.
   */
  async setStatus(status: string): Promise<void> {
    try {
      await (this.options.client as any).assistant.threads.setStatus({
        channel_id: this.options.channel,
        thread_ts: this.options.threadTs,
        status,
      });
    } catch (err: any) {
      // Silently ignore — not all surfaces have assistant:write scope
      if (!err?.data?.error?.includes('not_allowed')) {
        console.warn('[SlackStreamer] setStatus failed:', err?.data?.error ?? err);
      }
    }
  }

  /**
   * Clear the assistant thread status indicator (called after stop).
   */
  async clearStatus(): Promise<void> {
    try {
      await (this.options.client as any).assistant.threads.setStatus({
        channel_id: this.options.channel,
        thread_ts: this.options.threadTs,
        status: '',
      });
    } catch {
      // Ignore — not critical
    }
  }
}
