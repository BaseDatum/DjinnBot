/**
 * SessionTokenStats — compact, live-updating token/cost display.
 *
 * Shows running totals of tokens (in/out) and cost for a session or run.
 * Subscribes to the /events/llm-calls SSE stream for real-time updates.
 * Falls back to fetching summary from the REST API on mount.
 *
 * Designed to fit inline in pane headers, session rows, etc.
 */

import { useState, useEffect, useCallback, useRef } from 'react';
import { API_BASE } from '@/lib/api';
import { authFetch } from '@/lib/auth';
import { useLlmCalls } from '@/hooks/useLlmCalls';
import { useChatSessions } from '@/components/chat/ChatSessionContext';

interface TokenSummary {
  callCount: number;
  totalInputTokens: number;
  totalOutputTokens: number;
  totalCacheReadTokens: number;
  totalCacheWriteTokens: number;
  totalTokens: number;
  totalCost: number;
  hasApproximateCosts: boolean;
  // Context window usage snapshot (from most recent LLM call)
  contextUsedTokens: number;
  contextWindowTokens: number;
  contextPercent: number;
}

interface SessionTokenStatsProps {
  sessionId?: string;
  runId?: string;
  /** Compact mode: just tokens + cost. Default true. */
  compact?: boolean;
  className?: string;
}

function fmt(n: number): string {
  const v = Math.max(0, n);
  if (v >= 1_000_000) return `${(v / 1_000_000).toFixed(1)}M`;
  if (v >= 1_000) return `${(v / 1_000).toFixed(1)}K`;
  return String(v);
}

function fmtCost(cost: number): string {
  if (cost === 0) return '';
  if (cost < 0.001) return `$${cost.toFixed(5)}`;
  if (cost < 0.01) return `$${cost.toFixed(4)}`;
  if (cost < 1) return `$${cost.toFixed(3)}`;
  return `$${cost.toFixed(2)}`;
}

const EMPTY: TokenSummary = {
  callCount: 0,
  totalInputTokens: 0,
  totalOutputTokens: 0,
  totalCacheReadTokens: 0,
  totalCacheWriteTokens: 0,
  totalTokens: 0,
  totalCost: 0,
  hasApproximateCosts: false,
  contextUsedTokens: 0,
  contextWindowTokens: 0,
  contextPercent: 0,
};

/** Format token count as compact "122k" style. */
function fmtK(n: number): string {
  const v = Math.max(0, n);
  if (v >= 1_000_000) return `${(v / 1_000_000).toFixed(0)}M`;
  if (v >= 1_000) return `${Math.round(v / 1_000)}k`;
  return String(v);
}

/** Color class for context percentage: muted < 60%, amber 60-80%, red > 80%. */
function contextColorClass(percent: number): string {
  if (percent > 80) return 'text-red-500 dark:text-red-400';
  if (percent > 60) return 'text-amber-600 dark:text-amber-400';
  return 'text-muted-foreground/70';
}

export function SessionTokenStats({ sessionId, runId, compact = true, className }: SessionTokenStatsProps) {
  // ── Cross-mount persistence ──────────────────────────────────────────────
  // Read cached stats from the ChatSessionContext so that navigating between
  // the floating widget and /chat page doesn't reset the running totals.
  // The cache is optional (useChatSessions may not exist outside chat).
  let cachedInitial: TokenSummary | undefined;
  let persistToCache: ((s: TokenSummary) => void) | undefined;
  try {
    const ctx = useChatSessions();
    if (sessionId) {
      cachedInitial = ctx.getTokenStats(sessionId) as TokenSummary | undefined;
      persistToCache = (s: TokenSummary) => ctx.setTokenStats(sessionId!, s);
    }
  } catch {
    // Outside of ChatSessionProvider — no caching, that's fine.
  }

  const [stats, setStats] = useState<TokenSummary>(() => cachedInitial ?? EMPTY);

  // Gate SSE processing: don't accumulate until REST has loaded the baseline,
  // and deduplicate by call ID to prevent double-counting on reconnection.
  // If we restored from cache, mark REST as already loaded since the cache
  // already includes all accumulated data — a fresh REST fetch would reset
  // to a potentially lower baseline.
  const restLoaded = useRef(!!cachedInitial);
  const seenCallIds = useRef(new Set<string>());

  // Track whether this is the first mount so the reset effect doesn't fire
  // on mount and defeat the cache-skip optimization.
  const isFirstMountRef = useRef(true);

  // Track previous sessionId to detect transitions in the persist effect,
  // preventing stale stats from one session being written to another's cache.
  const prevSessionIdRef = useRef(sessionId);

  // Reset refs when session/run changes — but NOT on the initial mount,
  // because restLoaded was already correctly set from the cache above.
  useEffect(() => {
    if (isFirstMountRef.current) {
      isFirstMountRef.current = false;
      return;
    }
    restLoaded.current = false;
    seenCallIds.current = new Set();
  }, [sessionId, runId]);

  // Persist stats to the cross-mount cache whenever they change.
  // Guard: skip the write when sessionId just changed — stats still holds the
  // PREVIOUS session's data and would pollute the new session's cache slot.
  useEffect(() => {
    if (sessionId !== prevSessionIdRef.current) {
      prevSessionIdRef.current = sessionId;
      return;
    }
    if (stats.callCount > 0 && persistToCache) {
      persistToCache(stats);
    }
  // persistToCache is stable (useCallback in the provider)
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [stats, sessionId]);

  // Fetch initial summary from REST API
  useEffect(() => {
    if (!sessionId && !runId) return;
    // Skip REST fetch if we already have cached data — the cache is more
    // up-to-date because it includes SSE-accumulated calls that may not
    // yet be in the DB when the REST endpoint is hit.
    if (restLoaded.current) return;

    const params = new URLSearchParams();
    if (sessionId) params.set('session_id', sessionId);
    if (runId) params.set('run_id', runId);
    params.set('limit', '0'); // We only need the summary

    authFetch(`${API_BASE}/llm-calls?${params.toString()}`)
      .then(res => res.ok ? res.json() : null)
      .then(data => {
        if (data?.summary) {
          // Check if any calls in this batch have approximate costs
          const anyApprox = (data.calls ?? []).some(
            (c: any) => c.cost_approximate && c.cost_total != null && c.cost_total > 0
          );
          setStats({
            callCount: data.summary.callCount ?? 0,
            totalInputTokens: data.summary.totalInputTokens ?? 0,
            totalOutputTokens: data.summary.totalOutputTokens ?? 0,
            totalCacheReadTokens: data.summary.totalCacheReadTokens ?? 0,
            totalCacheWriteTokens: data.summary.totalCacheWriteTokens ?? 0,
            totalTokens: data.summary.totalTokens ?? 0,
            totalCost: data.summary.totalCost ?? 0,
            hasApproximateCosts: anyApprox,
            contextUsedTokens: data.summary.contextUsedTokens ?? 0,
            contextWindowTokens: data.summary.contextWindowTokens ?? 0,
            contextPercent: data.summary.contextPercent ?? 0,
          });
        }
        restLoaded.current = true;
      })
      .catch(() => {
        // Even on error, allow SSE to proceed so live calls still show up
        restLoaded.current = true;
      });
  }, [sessionId, runId]);

  // Real-time SSE updates — only process after REST baseline is loaded,
  // and skip any call IDs we've already counted.
  const handleSSE = useCallback((event: any) => {
    if (event?.type !== 'llm_call') return;
    if (sessionId && event.session_id !== sessionId) return;
    if (runId && event.run_id !== runId) return;

    // Don't accumulate until REST has established the baseline totals
    if (!restLoaded.current) return;

    // Deduplicate by call ID (handles SSE reconnections / replays)
    const callId = event.id;
    if (callId) {
      if (seenCallIds.current.has(callId)) return;
      seenCallIds.current.add(callId);
    }

    setStats(prev => ({
      callCount: prev.callCount + 1,
      totalInputTokens: prev.totalInputTokens + (event.input_tokens ?? 0),
      totalOutputTokens: prev.totalOutputTokens + (event.output_tokens ?? 0),
      totalCacheReadTokens: prev.totalCacheReadTokens + (event.cache_read_tokens ?? 0),
      totalCacheWriteTokens: prev.totalCacheWriteTokens + (event.cache_write_tokens ?? 0),
      totalTokens: prev.totalTokens + (event.total_tokens ?? 0),
      totalCost: +(prev.totalCost + (event.cost_total ?? 0)).toFixed(6),
      hasApproximateCosts: prev.hasApproximateCosts || !!(event.cost_approximate && event.cost_total > 0),
      // Context is a snapshot — always overwrite with the latest values
      contextUsedTokens: event.context_used_tokens ?? prev.contextUsedTokens,
      contextWindowTokens: event.context_window_tokens ?? prev.contextWindowTokens,
      contextPercent: event.context_percent ?? prev.contextPercent,
    }));
  }, [sessionId, runId]);

  useLlmCalls(handleSSE);

  // Don't render if no data yet
  if (stats.callCount === 0) return null;

  const costStr = fmtCost(stats.totalCost);
  const approxPrefix = stats.hasApproximateCosts ? '~' : '';
  const approxTitle = stats.hasApproximateCosts ? ' (includes approximate costs)' : '';

  // Context gauge: "122k/200k 61%"
  const hasContext = stats.contextWindowTokens > 0;
  const ctxColor = hasContext ? contextColorClass(stats.contextPercent) : '';
  const ctxLabel = hasContext
    ? `${fmtK(stats.contextUsedTokens)}/${fmtK(stats.contextWindowTokens)} ${stats.contextPercent}%`
    : '';
  const ctxTooltip = hasContext
    ? `Context: ${stats.contextUsedTokens.toLocaleString()} / ${stats.contextWindowTokens.toLocaleString()} tokens (${stats.contextPercent}%)`
    : '';

  if (compact) {
    return (
      <span
        className={`inline-flex items-center gap-1.5 text-[10px] text-muted-foreground font-mono whitespace-nowrap ${className ?? ''}`}
        title={`${stats.callCount} calls · In: ${stats.totalInputTokens.toLocaleString()} · Out: ${stats.totalOutputTokens.toLocaleString()} · Cache R: ${stats.totalCacheReadTokens.toLocaleString()} W: ${stats.totalCacheWriteTokens.toLocaleString()}${costStr ? ` · ${approxPrefix}${costStr}${approxTitle}` : ''}${ctxTooltip ? ` · ${ctxTooltip}` : ''}`}
      >
        <span className="opacity-60">↑</span>{fmt(stats.totalInputTokens)}
        <span className="opacity-60">↓</span>{fmt(stats.totalOutputTokens)}
        {costStr && <span className="text-amber-600 dark:text-amber-400">{approxPrefix}{costStr}</span>}
        {hasContext && <span className={ctxColor} title={ctxTooltip}>{ctxLabel}</span>}
      </span>
    );
  }

  // Expanded mode
  return (
    <span
      className={`inline-flex items-center gap-2 text-[10px] text-muted-foreground font-mono whitespace-nowrap ${className ?? ''}`}
    >
      <span>{stats.callCount} calls</span>
      <span>↑{fmt(stats.totalInputTokens)}</span>
      <span>↓{fmt(stats.totalOutputTokens)}</span>
      {(stats.totalCacheReadTokens > 0 || stats.totalCacheWriteTokens > 0) && (
        <span className="opacity-70">⚡R:{fmt(stats.totalCacheReadTokens)} W:{fmt(stats.totalCacheWriteTokens)}</span>
      )}
      {costStr && <span className="text-amber-600 dark:text-amber-400" title={approxTitle || undefined}>{approxPrefix}{costStr}</span>}
      {hasContext && <span className={ctxColor} title={ctxTooltip}>{ctxLabel}</span>}
    </span>
  );
}
