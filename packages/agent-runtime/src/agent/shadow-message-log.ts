/**
 * ShadowMessageLog — Mirrors the Agent's internal message history.
 *
 * pi-agent-core's Agent is opaque — we can't inspect or modify its
 * internal message array. The shadow log tracks what the Agent has
 * seen so that:
 *
 *   1. Token usage can be estimated without querying the Agent
 *   2. Tool outputs can be pruned by modifying the shadow and rebuilding
 *   3. Compaction can read the full history to generate summaries
 *   4. The Agent can be rebuilt with a filtered message set
 *
 * The shadow log is populated from:
 *   - seedHistory() — historical messages loaded from DB
 *   - message_end events — new assistant messages
 *   - tool_execution_end events — tool call results
 *   - user prompts — each runStep() call
 *
 * The shadow is authoritative for rebuilds: when compaction or pruning
 * triggers, a new Agent is created from the (modified) shadow log.
 */

// ── Message types ───────────────────────────────────────────────────────────

export interface ShadowMessage {
  role: 'system' | 'user' | 'assistant' | 'tool_call' | 'tool_result';
  content: string;
  /** Tool name for tool_call and tool_result messages. */
  toolName?: string;
  /** Tool call ID for correlation. */
  toolCallId?: string;
  /** Timestamp when this message was added. */
  timestamp: number;
  /** Whether this is a compaction summary message. */
  isSummary?: boolean;
}

// ── Shadow message log ──────────────────────────────────────────────────────

export class ShadowMessageLog {
  private messages: ShadowMessage[] = [];
  private _compactionCount = 0;

  /** Number of compactions performed on this session. */
  get compactionCount(): number {
    return this._compactionCount;
  }

  /** Get a read-only copy of all messages. */
  getMessages(): readonly ShadowMessage[] {
    return this.messages;
  }

  /** Get the mutable messages array (for pruning in place). */
  getMutableMessages(): ShadowMessage[] {
    return this.messages;
  }

  /** Total number of messages. */
  get length(): number {
    return this.messages.length;
  }

  /** Add a message to the log. */
  push(msg: ShadowMessage): void {
    this.messages.push(msg);
  }

  /** Clear all messages and set new content (used after compaction/rebuild). */
  reset(messages: ShadowMessage[]): void {
    this.messages = messages;
  }

  /** Increment compaction counter. */
  recordCompaction(): void {
    this._compactionCount++;
  }

  /**
   * Estimate total tokens in the shadow log.
   * Uses ~4 chars/token approximation.
   */
  estimateTokens(): number {
    let totalChars = 0;
    for (const msg of this.messages) {
      totalChars += msg.content.length;
    }
    return Math.ceil(totalChars / 4);
  }

  /**
   * Seed from historical messages (loaded from DB at container start).
   */
  seedFromHistory(history: Array<{ role: string; content: string }>): void {
    for (const msg of history) {
      if (msg.role === 'user' || msg.role === 'assistant') {
        this.messages.push({
          role: msg.role,
          content: msg.content,
          timestamp: Date.now(),
        });
      }
    }
  }

  /**
   * Build the message array for Agent reconstruction after compaction/pruning.
   *
   * Returns {role, content} pairs suitable for passing to seedHistory().
   * Summary messages are marked so the consumer can handle them appropriately.
   */
  toHistoryArray(): Array<{ role: string; content: string; isSummary?: boolean }> {
    return this.messages
      .filter(m => m.role === 'user' || m.role === 'assistant')
      .map(m => ({
        role: m.role,
        content: m.content,
        ...(m.isSummary ? { isSummary: true } : {}),
      }));
  }
}
