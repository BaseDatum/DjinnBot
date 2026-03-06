/**
 * SessionPruner — Lightweight tool output pruning for context management.
 *
 * Scans the shadow message log backwards and truncates old tool call
 * results to reclaim tokens without losing conversational context.
 *
 * This is the first line of defense before full compaction — it's
 * cheaper (no LLM call) and preserves the full conversation flow.
 *
 * Design based on OpenCode's pruning strategy:
 *   - Scan backwards through tool results
 *   - Protect the last PRUNE_PROTECT tokens of tool output
 *   - Require at least PRUNE_MINIMUM tokens to be prunable before acting
 *   - Never prune outputs from protected tools (memory, skills)
 *   - Soft-trim: keep head + tail, replace middle with "..."
 *   - Hard-clear: replace entire result with placeholder
 */

import type { ShadowMessage } from './shadow-message-log.js';

// ── Tuning constants ────────────────────────────────────────────────────────

/** Minimum tokens to prune before taking action. */
export const PRUNE_MINIMUM = 20_000;

/** Keep this many tokens of recent tool outputs (protection window). */
export const PRUNE_PROTECT = 40_000;

/** Tools whose outputs are never pruned (contain knowledge the agent needs). */
export const PROTECTED_TOOLS = new Set([
  'recall',
  'remember',
  'context_query',
  'graph_query',
  'rate_memories',
  'skills',
  'read_document',
]);

/** Max chars to keep per soft-trimmed tool result. */
const SOFT_TRIM_MAX_CHARS = 4000;
const SOFT_TRIM_HEAD = 1500;
const SOFT_TRIM_TAIL = 1500;

/** Placeholder for hard-cleared tool results. */
const HARD_CLEAR_PLACEHOLDER = '[Tool output cleared during context pruning]';

// ── Rough token estimation ──────────────────────────────────────────────────
// ~4 chars per token is the standard approximation.

function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

// ── Pruning result ──────────────────────────────────────────────────────────

export interface PruneResult {
  /** Whether any pruning was performed. */
  pruned: boolean;
  /** Estimated tokens recovered. */
  tokensRecovered: number;
  /** Number of tool results soft-trimmed. */
  softTrimCount: number;
  /** Number of tool results hard-cleared. */
  hardClearCount: number;
}

/**
 * Prune tool outputs from the shadow message log.
 *
 * Modifies the messages array in place — tool_result content is
 * replaced with trimmed/cleared versions.
 *
 * @param messages - The shadow message log (modified in place)
 * @param protectLastAssistants - Number of recent assistant turns to protect (default: 3)
 * @returns PruneResult describing what was done
 */
export function pruneToolOutputs(
  messages: ShadowMessage[],
  protectLastAssistants = 3,
): PruneResult {
  const result: PruneResult = {
    pruned: false,
    tokensRecovered: 0,
    softTrimCount: 0,
    hardClearCount: 0,
  };

  // Find the cutoff: skip the last N assistant messages
  let assistantCount = 0;
  let cutoffIndex = messages.length;
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role === 'assistant') {
      assistantCount++;
      if (assistantCount >= protectLastAssistants) {
        cutoffIndex = i;
        break;
      }
    }
  }

  // If we don't have enough assistant messages, skip pruning
  if (assistantCount < protectLastAssistants) {
    return result;
  }

  // Collect prunable tool results (before the cutoff)
  interface PrunableEntry {
    index: number;
    toolName: string;
    content: string;
    tokens: number;
  }
  const prunables: PrunableEntry[] = [];
  let totalPrunableTokens = 0;

  for (let i = 0; i < cutoffIndex; i++) {
    const msg = messages[i];
    if (msg.role !== 'tool_result') continue;
    if (!msg.content || msg.content.length === 0) continue;

    const toolName = msg.toolName || '';
    if (PROTECTED_TOOLS.has(toolName)) continue;

    // Skip already-pruned results
    if (msg.content === HARD_CLEAR_PLACEHOLDER) continue;
    if (msg.content.includes('[Soft-trimmed from')) continue;

    const tokens = estimateTokens(msg.content);
    prunables.push({ index: i, toolName, content: msg.content, tokens });
    totalPrunableTokens += tokens;
  }

  // Check if we have enough to prune
  if (totalPrunableTokens < PRUNE_MINIMUM) {
    return result;
  }

  // Prune from oldest to newest, protecting the last PRUNE_PROTECT tokens
  let protectedTokens = 0;
  // Count tokens from newest prunable backwards to establish protection window
  const protectedIndices = new Set<number>();
  for (let i = prunables.length - 1; i >= 0; i--) {
    protectedTokens += prunables[i].tokens;
    if (protectedTokens <= PRUNE_PROTECT) {
      protectedIndices.add(prunables[i].index);
    } else {
      break;
    }
  }

  for (const entry of prunables) {
    if (protectedIndices.has(entry.index)) continue;

    const msg = messages[entry.index];
    const originalTokens = entry.tokens;

    if (entry.content.length > SOFT_TRIM_MAX_CHARS) {
      // Soft trim: keep head + tail
      const head = entry.content.slice(0, SOFT_TRIM_HEAD);
      const tail = entry.content.slice(-SOFT_TRIM_TAIL);
      const originalLen = entry.content.length;
      msg.content = `${head}\n\n... [Soft-trimmed from ${originalLen} chars] ...\n\n${tail}`;
      const newTokens = estimateTokens(msg.content);
      result.tokensRecovered += originalTokens - newTokens;
      result.softTrimCount++;
    } else {
      // Hard clear: replace entirely
      msg.content = HARD_CLEAR_PLACEHOLDER;
      result.tokensRecovered += originalTokens - estimateTokens(HARD_CLEAR_PLACEHOLDER);
      result.hardClearCount++;
    }
  }

  result.pruned = result.softTrimCount > 0 || result.hardClearCount > 0;

  if (result.pruned) {
    console.log(
      `[SessionPruner] Pruned ${result.softTrimCount} soft + ${result.hardClearCount} hard, ` +
      `recovered ~${result.tokensRecovered} tokens`
    );
  }

  return result;
}
