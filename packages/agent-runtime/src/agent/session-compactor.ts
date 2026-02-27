/**
 * SessionCompactor — LLM-driven context compaction.
 *
 * When the session approaches its context window limit and pruning
 * isn't sufficient, the compactor performs full summarization:
 *
 *   Phase 1: Memory Flush — ask the agent to persist important context
 *   Phase 2: LLM Summarization — generate a continuation prompt
 *   Phase 3: Session Rebuild — create new Agent with summary + tail
 *   Phase 4: Confirmation — report results
 *
 * The compaction summary is designed as a "handoff" — it contains
 * everything a fresh instance would need to continue the conversation
 * without losing context.
 */

import type { ShadowMessage, ShadowMessageLog } from './shadow-message-log.js';
import type { RedisPublisher } from '../redis/publisher.js';

// ── Configuration ───────────────────────────────────────────────────────────

/** Number of recent user+assistant message pairs to preserve verbatim. */
const TAIL_PAIRS_TO_KEEP = 3;

/** Max output tokens for the compaction summary. */
const COMPACTION_MAX_TOKENS = 8192;

// ── Compaction prompt ───────────────────────────────────────────────────────

const COMPACTION_SYSTEM_PROMPT = `You are a context compaction agent. Your job is to create a detailed continuation prompt from a conversation history. This prompt will be used to resume the conversation in a fresh context window — the new session will NOT have access to the original messages.

Your summary MUST:
1. Describe what has been accomplished so far
2. List ALL files that were created, modified, or discussed (with their full paths)
3. Capture key decisions, constraints, and rules established by the user
4. Note any errors encountered and how they were resolved
5. Describe the current state of the work (what's done, what's in progress)
6. List what needs to happen next
7. Preserve ALL identifiers verbatim: file paths, function names, variable names, URLs, error messages, model names
8. Include any user preferences or constraints mentioned (e.g. "don't push to git", "use TypeScript")

Format as a clear, structured prompt that reads naturally as context for a continuing conversation.
Do NOT include conversational pleasantries or meta-commentary about the compaction process.`;

// ── Types ───────────────────────────────────────────────────────────────────

export interface CompactionResult {
  success: boolean;
  summary: string;
  tokensBefore: number;
  tokensAfter: number;
  tailMessageCount: number;
  error?: string;
}

export interface CompactorConfig {
  publisher: RedisPublisher;
  /** Function that makes an LLM call for summarization. */
  summarize: (systemPrompt: string, userPrompt: string) => Promise<string>;
}

// ── Compactor ───────────────────────────────────────────────────────────────

/**
 * Build the conversation text from shadow messages for the compaction LLM.
 */
function buildConversationText(messages: readonly ShadowMessage[]): string {
  const lines: string[] = [];

  for (const msg of messages) {
    switch (msg.role) {
      case 'system':
        // Skip system prompts — they'll be re-injected on rebuild
        break;
      case 'user':
        lines.push(`## User\n${msg.content}\n`);
        break;
      case 'assistant':
        if (msg.isSummary) {
          lines.push(`## Previous Compaction Summary\n${msg.content}\n`);
        } else {
          lines.push(`## Assistant\n${msg.content}\n`);
        }
        break;
      case 'tool_call':
        lines.push(`## Tool Call: ${msg.toolName || 'unknown'}\n${msg.content}\n`);
        break;
      case 'tool_result':
        // Include tool results but truncate very long ones
        const truncated = msg.content.length > 2000
          ? msg.content.slice(0, 1000) + '\n...[truncated]...\n' + msg.content.slice(-500)
          : msg.content;
        lines.push(`## Tool Result (${msg.toolName || 'unknown'})\n${truncated}\n`);
        break;
    }
  }

  return lines.join('\n');
}

/**
 * Extract the tail messages to preserve verbatim after compaction.
 * Returns the last N user+assistant pairs plus any trailing tool calls.
 */
function extractTail(messages: readonly ShadowMessage[]): ShadowMessage[] {
  const tail: ShadowMessage[] = [];
  let pairsFound = 0;

  // Walk backwards finding user+assistant pairs
  for (let i = messages.length - 1; i >= 0 && pairsFound < TAIL_PAIRS_TO_KEEP; i--) {
    const msg = messages[i];
    tail.unshift(msg);

    if (msg.role === 'user') {
      pairsFound++;
    }
  }

  return tail;
}

/**
 * Perform context compaction on a shadow message log.
 *
 * @param shadowLog - The session's shadow message log
 * @param config - Compaction configuration
 * @param instructions - Optional user instructions for the summary
 * @returns CompactionResult
 */
export async function compactSession(
  shadowLog: ShadowMessageLog,
  config: CompactorConfig,
  instructions?: string,
): Promise<CompactionResult> {
  const messages = shadowLog.getMessages();
  const tokensBefore = shadowLog.estimateTokens();

  console.log(`[SessionCompactor] Starting compaction: ${messages.length} messages, ~${tokensBefore} tokens`);

  if (messages.length < 6) {
    return {
      success: false,
      summary: '',
      tokensBefore,
      tokensAfter: tokensBefore,
      tailMessageCount: 0,
      error: 'Too few messages to compact (need at least 6)',
    };
  }

  try {
    // Build the conversation text for summarization
    const conversationText = buildConversationText(messages);

    // Build the compaction prompt
    let userPrompt = `Here is the conversation to summarize:\n\n${conversationText}\n\n---\n\nProvide a detailed continuation prompt for resuming this conversation.`;

    if (instructions) {
      userPrompt += `\n\nAdditional instructions from the user: ${instructions}`;
    }

    // Phase 2: LLM Summarization
    console.log(`[SessionCompactor] Phase 2: Generating summary (conversation text: ${conversationText.length} chars)`);
    const summary = await config.summarize(COMPACTION_SYSTEM_PROMPT, userPrompt);

    if (!summary || summary.trim().length === 0) {
      return {
        success: false,
        summary: '',
        tokensBefore,
        tokensAfter: tokensBefore,
        tailMessageCount: 0,
        error: 'Compaction LLM returned empty summary',
      };
    }

    // Phase 3: Build new message set (summary + tail)
    const tail = extractTail(messages);
    const newMessages: ShadowMessage[] = [
      {
        role: 'assistant',
        content: summary,
        timestamp: Date.now(),
        isSummary: true,
      },
      ...tail,
    ];

    // Replace the shadow log
    shadowLog.reset(newMessages);
    shadowLog.recordCompaction();

    const tokensAfter = shadowLog.estimateTokens();
    const savings = tokensBefore - tokensAfter;
    const pct = tokensBefore > 0 ? Math.round((savings / tokensBefore) * 100) : 0;

    console.log(
      `[SessionCompactor] Compaction complete: ${tokensBefore} -> ${tokensAfter} tokens ` +
      `(saved ${savings} tokens, ${pct}%), tail=${tail.length} messages, ` +
      `compaction #${shadowLog.compactionCount}`
    );

    return {
      success: true,
      summary,
      tokensBefore,
      tokensAfter,
      tailMessageCount: tail.length,
    };
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    console.error('[SessionCompactor] Compaction failed:', error);
    return {
      success: false,
      summary: '',
      tokensBefore,
      tokensAfter: tokensBefore,
      tailMessageCount: 0,
      error,
    };
  }
}
