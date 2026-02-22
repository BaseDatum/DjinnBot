/**
 * LlmCallLog — Reusable component showing per-API-call LLM usage.
 *
 * Can be filtered by session_id or run_id to show calls for a specific
 * session/run, or unfiltered for an admin-wide view.
 */

import { useState, useEffect, useCallback } from 'react';
import {
  Zap,
  Coins,
  Hash,
  Brain,
  Wrench,
  Key,
  Share2,
  Server,
  ChevronDown,
  ChevronRight,
  Loader2,
} from 'lucide-react';
import { API_BASE } from '@/lib/api';
import { authFetch } from '@/lib/auth';
import { useSSE } from '@/hooks/useSSE';

interface LlmCall {
  id: string;
  session_id: string | null;
  run_id: string | null;
  agent_id: string;
  request_id: string | null;
  provider: string;
  model: string;
  key_source: string | null;
  key_masked: string | null;
  input_tokens: number;
  output_tokens: number;
  cache_read_tokens: number;
  cache_write_tokens: number;
  total_tokens: number;
  cost_input: number | null;
  cost_output: number | null;
  cost_total: number | null;
  duration_ms: number | null;
  tool_call_count: number;
  has_thinking: boolean;
  stop_reason: string | null;
  created_at: number;
}

interface LlmCallListResponse {
  calls: LlmCall[];
  total: number;
  hasMore: boolean;
  summary: {
    callCount: number;
    totalInputTokens: number;
    totalOutputTokens: number;
    totalCacheReadTokens: number;
    totalCacheWriteTokens: number;
    totalTokens: number;
    totalCost: number;
    totalCostInput: number;
    totalCostOutput: number;
    avgDurationMs: number;
  } | null;
}

interface LlmCallLogProps {
  sessionId?: string;
  runId?: string;
  agentId?: string;
  /** Use admin endpoint (has extra filters) */
  admin?: boolean;
  /** Max height for the container */
  maxHeight?: string;
  /** Enable auto-refresh polling (e.g. while session is running) */
  live?: boolean;
}

const KEY_SOURCE_BADGES: Record<string, { label: string; color: string; icon: typeof Key }> = {
  personal: { label: 'Personal', color: 'text-green-600 dark:text-green-400', icon: Key },
  admin_shared: { label: 'Shared', color: 'text-blue-600 dark:text-blue-400', icon: Share2 },
  instance: { label: 'Instance', color: 'text-amber-600 dark:text-amber-400', icon: Server },
};

function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return String(n);
}

function formatCost(cost: number | null): string {
  if (cost == null || cost === 0) return '-';
  if (cost < 0.001) return `$${cost.toFixed(6)}`;
  if (cost < 0.01) return `$${cost.toFixed(4)}`;
  return `$${cost.toFixed(3)}`;
}

function formatDuration(ms: number | null): string {
  if (ms == null) return '-';
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

function formatTime(ts: number): string {
  return new Date(ts).toLocaleTimeString();
}

export function LlmCallLog({ sessionId, runId, agentId, admin = false, maxHeight = '400px', live = false }: LlmCallLogProps) {
  const [data, setData] = useState<LlmCallListResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [expandedId, setExpandedId] = useState<string | null>(null);

  const fetchCalls = useCallback(async () => {
    setLoading(true);
    try {
      const params = new URLSearchParams();
      params.set('limit', '100');
      if (sessionId) params.set('session_id', sessionId);
      if (runId) params.set('run_id', runId);
      if (agentId) params.set('agent_id', agentId);

      const endpoint = admin ? 'admin/llm-calls' : 'llm-calls';
      const res = await authFetch(`${API_BASE}/${endpoint}?${params.toString()}`);
      if (res.ok) {
        setData(await res.json());
      }
    } catch {
      // Non-fatal
    } finally {
      setLoading(false);
    }
  }, [sessionId, runId, agentId, admin]);

  useEffect(() => {
    fetchCalls();
  }, [fetchCalls]);

  // Real-time SSE: append new calls as they arrive
  const handleSSE = useCallback((event: any) => {
    if (event?.type !== 'llm_call') return;

    // Filter: only append if this call belongs to our scope
    if (sessionId && event.session_id !== sessionId) return;
    if (runId && event.run_id !== runId) return;
    if (agentId && event.agent_id !== agentId) return;

    const newCall: LlmCall = {
      id: event.id,
      session_id: event.session_id,
      run_id: event.run_id,
      agent_id: event.agent_id,
      request_id: event.request_id,
      provider: event.provider,
      model: event.model,
      key_source: event.key_source,
      key_masked: event.key_masked,
      input_tokens: event.input_tokens ?? 0,
      output_tokens: event.output_tokens ?? 0,
      cache_read_tokens: event.cache_read_tokens ?? 0,
      cache_write_tokens: event.cache_write_tokens ?? 0,
      total_tokens: event.total_tokens ?? 0,
      cost_input: event.cost_input,
      cost_output: event.cost_output,
      cost_total: event.cost_total,
      duration_ms: event.duration_ms,
      tool_call_count: event.tool_call_count ?? 0,
      has_thinking: event.has_thinking ?? false,
      stop_reason: event.stop_reason,
      created_at: event.created_at,
    };

    setData(prev => {
      if (!prev) {
        return {
          calls: [newCall],
          total: 1,
          hasMore: false,
          summary: {
            callCount: 1,
            totalInputTokens: newCall.input_tokens,
            totalOutputTokens: newCall.output_tokens,
            totalCacheReadTokens: newCall.cache_read_tokens,
            totalCacheWriteTokens: newCall.cache_write_tokens,
            totalTokens: newCall.total_tokens,
            totalCost: newCall.cost_total ?? 0,
            totalCostInput: newCall.cost_input ?? 0,
            totalCostOutput: newCall.cost_output ?? 0,
            avgDurationMs: newCall.duration_ms ?? 0,
          },
        };
      }

      // Deduplicate
      if (prev.calls.some(c => c.id === newCall.id)) return prev;

      const calls = [newCall, ...prev.calls]; // newest first
      const s = prev.summary!;
      const newCount = s.callCount + 1;
      return {
        ...prev,
        calls,
        total: prev.total + 1,
        summary: {
          callCount: newCount,
          totalInputTokens: s.totalInputTokens + newCall.input_tokens,
          totalOutputTokens: s.totalOutputTokens + newCall.output_tokens,
          totalCacheReadTokens: s.totalCacheReadTokens + newCall.cache_read_tokens,
          totalCacheWriteTokens: s.totalCacheWriteTokens + newCall.cache_write_tokens,
          totalTokens: s.totalTokens + newCall.total_tokens,
          totalCost: +(s.totalCost + (newCall.cost_total ?? 0)).toFixed(6),
          totalCostInput: +(s.totalCostInput + (newCall.cost_input ?? 0)).toFixed(6),
          totalCostOutput: +(s.totalCostOutput + (newCall.cost_output ?? 0)).toFixed(6),
          avgDurationMs: Math.round(
            ((s.avgDurationMs * s.callCount) + (newCall.duration_ms ?? 0)) / newCount
          ),
        },
      };
    });
  }, [sessionId, runId, agentId]);

  useSSE({
    url: `${API_BASE}/events/llm-calls`,
    onMessage: handleSSE,
    enabled: live,
  });

  if (loading) {
    return (
      <div className="flex items-center justify-center py-6">
        <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
      </div>
    );
  }

  if (!data || data.calls.length === 0) {
    return (
      <div className="text-xs text-muted-foreground py-4 text-center">
        No LLM calls recorded yet
      </div>
    );
  }

  const { calls, summary } = data;

  return (
    <div className="space-y-3">
      {/* Summary bar */}
      {summary && summary.callCount > 0 && (
        <div className="flex flex-wrap gap-x-5 gap-y-1 text-xs text-muted-foreground bg-muted/30 rounded-md px-3 py-2">
          <span className="flex items-center gap-1">
            <Zap className="h-3 w-3" />
            {summary.callCount} call{summary.callCount !== 1 ? 's' : ''}
          </span>
          <span className="flex items-center gap-1">
            <Hash className="h-3 w-3" />
            {formatTokens(summary.totalTokens)} total
          </span>
          <span>In: {formatTokens(summary.totalInputTokens)}</span>
          <span>Out: {formatTokens(summary.totalOutputTokens)}</span>
          {(summary.totalCacheReadTokens > 0 || summary.totalCacheWriteTokens > 0) && (
            <span title={`Cache read: ${summary.totalCacheReadTokens.toLocaleString()} / Cache write: ${summary.totalCacheWriteTokens.toLocaleString()}`}>
              Cache R: {formatTokens(summary.totalCacheReadTokens)} / W: {formatTokens(summary.totalCacheWriteTokens)}
            </span>
          )}
          {summary.totalCost > 0 && (
            <span className="flex items-center gap-1" title={`Input: ${formatCost(summary.totalCostInput)} / Output: ${formatCost(summary.totalCostOutput)}`}>
              <Coins className="h-3 w-3" />
              {formatCost(summary.totalCost)}
            </span>
          )}
          {summary.avgDurationMs > 0 && (
            <span>Avg: {formatDuration(summary.avgDurationMs)}</span>
          )}
        </div>
      )}

      {/* Call list */}
      <div className="border rounded-md overflow-hidden" style={{ maxHeight, overflowY: 'auto' }}>
        <table className="w-full text-xs">
          <thead className="bg-muted/50 sticky top-0">
            <tr>
              <th className="text-left px-3 py-1.5 font-medium w-6"></th>
              <th className="text-left px-3 py-1.5 font-medium">Time</th>
              <th className="text-left px-3 py-1.5 font-medium">Model</th>
              <th className="text-left px-3 py-1.5 font-medium">Key</th>
              <th className="text-right px-3 py-1.5 font-medium">In</th>
              <th className="text-right px-3 py-1.5 font-medium">Out</th>
              <th className="text-right px-3 py-1.5 font-medium">Cache</th>
              <th className="text-right px-3 py-1.5 font-medium">Cost</th>
              <th className="text-right px-3 py-1.5 font-medium">Duration</th>
              <th className="text-center px-3 py-1.5 font-medium">Info</th>
            </tr>
          </thead>
          <tbody className="divide-y">
            {calls.map(call => {
              const isExpanded = expandedId === call.id;
              const ksInfo = call.key_source ? KEY_SOURCE_BADGES[call.key_source] : null;
              const KsIcon = ksInfo?.icon || Key;

              return (
                <>
                  <tr
                    key={call.id}
                    className="hover:bg-muted/30 cursor-pointer"
                    onClick={() => setExpandedId(isExpanded ? null : call.id)}
                  >
                    <td className="px-3 py-1.5 text-muted-foreground">
                      {isExpanded ? <ChevronDown className="h-3 w-3" /> : <ChevronRight className="h-3 w-3" />}
                    </td>
                    <td className="px-3 py-1.5 text-muted-foreground">{formatTime(call.created_at)}</td>
                    <td className="px-3 py-1.5">
                      <span className="font-mono text-[10px]">{call.provider}/{call.model}</span>
                    </td>
                    <td className="px-3 py-1.5">
                      {ksInfo ? (
                        <span className={`inline-flex items-center gap-0.5 ${ksInfo.color}`}>
                          <KsIcon className="h-2.5 w-2.5" />
                          <span className="text-[10px]">{ksInfo.label}</span>
                        </span>
                      ) : (
                        <span className="text-muted-foreground">-</span>
                      )}
                    </td>
                    <td className="px-3 py-1.5 text-right font-mono">{formatTokens(call.input_tokens)}</td>
                    <td className="px-3 py-1.5 text-right font-mono">{formatTokens(call.output_tokens)}</td>
                    <td className="px-3 py-1.5 text-right font-mono text-muted-foreground">
                      {(call.cache_read_tokens > 0 || call.cache_write_tokens > 0)
                        ? <span title={`Read: ${call.cache_read_tokens.toLocaleString()} / Write: ${call.cache_write_tokens.toLocaleString()}`}>
                            R:{formatTokens(call.cache_read_tokens)} W:{formatTokens(call.cache_write_tokens)}
                          </span>
                        : '-'}
                    </td>
                    <td className="px-3 py-1.5 text-right font-mono">{formatCost(call.cost_total)}</td>
                    <td className="px-3 py-1.5 text-right font-mono">{formatDuration(call.duration_ms)}</td>
                    <td className="px-3 py-1.5 text-center">
                      <span className="inline-flex items-center gap-1">
                        {call.has_thinking && (
                          <span title="Extended thinking"><Brain className="h-3 w-3 text-purple-500" /></span>
                        )}
                        {call.tool_call_count > 0 && (
                          <span className="inline-flex items-center gap-0.5 text-muted-foreground" title={`${call.tool_call_count} tool call(s)`}>
                            <Wrench className="h-3 w-3" />
                            <span className="text-[10px]">{call.tool_call_count}</span>
                          </span>
                        )}
                      </span>
                    </td>
                  </tr>
                  {isExpanded && (
                    <tr key={`${call.id}-detail`}>
                      <td colSpan={10} className="px-3 py-2 bg-muted/20">
                        <div className="grid grid-cols-2 gap-x-6 gap-y-1 text-[10px]">
                          <div><span className="text-muted-foreground">ID:</span> <span className="font-mono">{call.id}</span></div>
                          <div><span className="text-muted-foreground">Request:</span> <span className="font-mono">{call.request_id || '-'}</span></div>
                          <div><span className="text-muted-foreground">Input tokens:</span> {call.input_tokens.toLocaleString()}</div>
                          <div><span className="text-muted-foreground">Output tokens:</span> {call.output_tokens.toLocaleString()}</div>
                          <div><span className="text-muted-foreground">Cache read:</span> {call.cache_read_tokens.toLocaleString()}</div>
                          <div><span className="text-muted-foreground">Cache write:</span> {call.cache_write_tokens.toLocaleString()}</div>
                          <div><span className="text-muted-foreground">Input cost:</span> {formatCost(call.cost_input)}</div>
                          <div><span className="text-muted-foreground">Output cost:</span> {formatCost(call.cost_output)}</div>
                          <div><span className="text-muted-foreground">Stop reason:</span> {call.stop_reason || '-'}</div>
                          {call.key_masked && (
                            <div><span className="text-muted-foreground">Key:</span> <span className="font-mono">{call.key_masked}</span></div>
                          )}
                          {call.session_id && (
                            <div><span className="text-muted-foreground">Session:</span> <span className="font-mono">{call.session_id}</span></div>
                          )}
                          {call.run_id && (
                            <div><span className="text-muted-foreground">Run:</span> <span className="font-mono">{call.run_id}</span></div>
                          )}
                        </div>
                      </td>
                    </tr>
                  )}
                </>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}
