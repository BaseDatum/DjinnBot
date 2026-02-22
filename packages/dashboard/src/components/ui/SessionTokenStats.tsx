/**
 * SessionTokenStats — compact, live-updating token/cost display.
 *
 * Shows running totals of tokens (in/out) and cost for a session or run.
 * Subscribes to the /events/llm-calls SSE stream for real-time updates.
 * Falls back to fetching summary from the REST API on mount.
 *
 * Designed to fit inline in pane headers, session rows, etc.
 */

import { useState, useEffect, useCallback } from 'react';
import { API_BASE } from '@/lib/api';
import { authFetch } from '@/lib/auth';
import { useSSE } from '@/hooks/useSSE';

interface TokenSummary {
  callCount: number;
  totalInputTokens: number;
  totalOutputTokens: number;
  totalCacheReadTokens: number;
  totalCacheWriteTokens: number;
  totalTokens: number;
  totalCost: number;
}

interface SessionTokenStatsProps {
  sessionId?: string;
  runId?: string;
  /** Compact mode: just tokens + cost. Default true. */
  compact?: boolean;
  className?: string;
}

function fmt(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return String(n);
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
};

export function SessionTokenStats({ sessionId, runId, compact = true, className }: SessionTokenStatsProps) {
  const [stats, setStats] = useState<TokenSummary>(EMPTY);

  // Fetch initial summary from REST API
  useEffect(() => {
    if (!sessionId && !runId) return;
    const params = new URLSearchParams();
    if (sessionId) params.set('session_id', sessionId);
    if (runId) params.set('run_id', runId);
    params.set('limit', '0'); // We only need the summary

    authFetch(`${API_BASE}/llm-calls?${params.toString()}`)
      .then(res => res.ok ? res.json() : null)
      .then(data => {
        if (data?.summary) {
          setStats({
            callCount: data.summary.callCount ?? 0,
            totalInputTokens: data.summary.totalInputTokens ?? 0,
            totalOutputTokens: data.summary.totalOutputTokens ?? 0,
            totalCacheReadTokens: data.summary.totalCacheReadTokens ?? 0,
            totalCacheWriteTokens: data.summary.totalCacheWriteTokens ?? 0,
            totalTokens: data.summary.totalTokens ?? 0,
            totalCost: data.summary.totalCost ?? 0,
          });
        }
      })
      .catch(() => {});
  }, [sessionId, runId]);

  // Real-time SSE updates
  const handleSSE = useCallback((event: any) => {
    if (event?.type !== 'llm_call') return;
    if (sessionId && event.session_id !== sessionId) return;
    if (runId && event.run_id !== runId) return;

    setStats(prev => ({
      callCount: prev.callCount + 1,
      totalInputTokens: prev.totalInputTokens + (event.input_tokens ?? 0),
      totalOutputTokens: prev.totalOutputTokens + (event.output_tokens ?? 0),
      totalCacheReadTokens: prev.totalCacheReadTokens + (event.cache_read_tokens ?? 0),
      totalCacheWriteTokens: prev.totalCacheWriteTokens + (event.cache_write_tokens ?? 0),
      totalTokens: prev.totalTokens + (event.total_tokens ?? 0),
      totalCost: +(prev.totalCost + (event.cost_total ?? 0)).toFixed(6),
    }));
  }, [sessionId, runId]);

  useSSE({
    url: `${API_BASE}/events/llm-calls`,
    onMessage: handleSSE,
  });

  // Don't render if no data yet
  if (stats.callCount === 0) return null;

  const costStr = fmtCost(stats.totalCost);

  if (compact) {
    return (
      <span
        className={`inline-flex items-center gap-1.5 text-[10px] text-muted-foreground font-mono whitespace-nowrap ${className ?? ''}`}
        title={`${stats.callCount} calls · In: ${stats.totalInputTokens.toLocaleString()} · Out: ${stats.totalOutputTokens.toLocaleString()} · Cache R: ${stats.totalCacheReadTokens.toLocaleString()} W: ${stats.totalCacheWriteTokens.toLocaleString()}${costStr ? ` · ${costStr}` : ''}`}
      >
        <span className="opacity-60">↑</span>{fmt(stats.totalInputTokens)}
        <span className="opacity-60">↓</span>{fmt(stats.totalOutputTokens)}
        {costStr && <span className="text-amber-600 dark:text-amber-400">{costStr}</span>}
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
      {costStr && <span className="text-amber-600 dark:text-amber-400">{costStr}</span>}
    </span>
  );
}
