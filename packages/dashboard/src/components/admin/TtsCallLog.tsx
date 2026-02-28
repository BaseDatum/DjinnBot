/**
 * TtsCallLog — Reusable component showing per-API-call TTS (Fish Audio) usage.
 *
 * Mirrors LlmCallLog but for text-to-speech calls, showing:
 * - Provider, model, voice used
 * - Input text size (chars + UTF-8 bytes) and output audio size
 * - Cost ($15/1M UTF-8 bytes for Fish Audio)
 * - Latency
 * - Channel (telegram, signal, whatsapp, discord, slack, dashboard)
 * - Key source (personal / admin_shared / instance)
 */

import { useState, useEffect, useCallback } from 'react';
import {
  Volume2,
  Coins,
  Key,
  Share2,
  Server,
  ChevronDown,
  ChevronRight,
  Loader2,
} from 'lucide-react';
import { API_BASE } from '@/lib/api';
import { authFetch } from '@/lib/auth';

interface TtsCall {
  id: string;
  session_id: string | null;
  agent_id: string;
  user_id: string | null;
  provider: string;
  model: string;
  key_source: string | null;
  input_text_bytes: number;
  input_characters: number;
  output_audio_bytes: number;
  output_format: string;
  voice_id: string | null;
  voice_name: string | null;
  cost_total: number | null;
  duration_ms: number | null;
  channel: string | null;
  created_at: number;
}

interface TtsCallListResponse {
  calls: TtsCall[];
  total: number;
  hasMore: boolean;
  summary: {
    callCount: number;
    totalInputBytes: number;
    totalInputChars?: number;
    totalOutputBytes: number;
    totalCost: number;
    avgDurationMs: number;
  } | null;
}

interface TtsCallLogProps {
  sessionId?: string;
  agentId?: string;
  admin?: boolean;
  maxHeight?: string;
  live?: boolean;
}

const KEY_SOURCE_BADGES: Record<string, { label: string; color: string; icon: typeof Key }> = {
  personal: { label: 'Personal', color: 'text-green-600 dark:text-green-400', icon: Key },
  admin_shared: { label: 'Shared', color: 'text-blue-600 dark:text-blue-400', icon: Share2 },
  instance: { label: 'Instance', color: 'text-amber-600 dark:text-amber-400', icon: Server },
  local: { label: 'Local', color: 'text-muted-foreground', icon: Server },
};

function formatBytes(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}MB`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}KB`;
  return `${n}B`;
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

export function TtsCallLog({ sessionId, agentId, admin = false, maxHeight = '300px', live = false }: TtsCallLogProps) {
  const [data, setData] = useState<TtsCallListResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [expandedId, setExpandedId] = useState<string | null>(null);

  const fetchCalls = useCallback(async () => {
    setLoading(true);
    try {
      const params = new URLSearchParams();
      params.set('limit', '100');
      if (sessionId) params.set('session_id', sessionId);
      if (agentId) params.set('agent_id', agentId);

      const endpoint = admin ? 'admin/tts-calls' : 'tts-calls';
      const res = await authFetch(`${API_BASE}/${endpoint}?${params.toString()}`);
      if (res.ok) {
        setData(await res.json());
      }
    } catch {
      // Non-fatal
    } finally {
      setLoading(false);
    }
  }, [sessionId, agentId, admin]);

  useEffect(() => {
    fetchCalls();
  }, [fetchCalls]);

  // Auto-refresh when live
  useEffect(() => {
    if (!live) return;
    const interval = setInterval(fetchCalls, 5000);
    return () => clearInterval(interval);
  }, [live, fetchCalls]);

  if (loading) {
    return (
      <div className="flex items-center justify-center py-4">
        <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
      </div>
    );
  }

  if (!data || data.calls.length === 0) {
    return (
      <div className="text-xs text-muted-foreground py-3 text-center">
        No TTS calls recorded
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
            <Volume2 className="h-3 w-3" />
            {summary.callCount} call{summary.callCount !== 1 ? 's' : ''}
          </span>
          <span>Input: {formatBytes(summary.totalInputBytes)}</span>
          <span>Audio: {formatBytes(summary.totalOutputBytes)}</span>
          {summary.totalCost > 0 && (
            <span className="flex items-center gap-1">
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
              <th className="text-left px-3 py-1.5 font-medium">Provider</th>
              <th className="text-left px-3 py-1.5 font-medium">Voice</th>
              <th className="text-left px-3 py-1.5 font-medium">Key</th>
              <th className="text-right px-3 py-1.5 font-medium">Chars</th>
              <th className="text-right px-3 py-1.5 font-medium">Audio</th>
              <th className="text-right px-3 py-1.5 font-medium">Cost</th>
              <th className="text-right px-3 py-1.5 font-medium">Duration</th>
              <th className="text-left px-3 py-1.5 font-medium">Channel</th>
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
                      <span className="text-[10px] truncate max-w-[100px] inline-block" title={call.voice_id || 'default'}>
                        {call.voice_name || 'default'}
                      </span>
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
                    <td className="px-3 py-1.5 text-right font-mono">{call.input_characters.toLocaleString()}</td>
                    <td className="px-3 py-1.5 text-right font-mono">{formatBytes(call.output_audio_bytes)}</td>
                    <td className="px-3 py-1.5 text-right font-mono">{formatCost(call.cost_total)}</td>
                    <td className="px-3 py-1.5 text-right font-mono">{formatDuration(call.duration_ms)}</td>
                    <td className="px-3 py-1.5">
                      <span className="text-[10px] text-muted-foreground">{call.channel || '-'}</span>
                    </td>
                  </tr>
                  {isExpanded && (
                    <tr key={`${call.id}-detail`}>
                      <td colSpan={10} className="px-3 py-2 bg-muted/20">
                        <div className="grid grid-cols-2 gap-x-6 gap-y-1 text-[10px]">
                          <div><span className="text-muted-foreground">ID:</span> <span className="font-mono">{call.id}</span></div>
                          <div><span className="text-muted-foreground">Agent:</span> <span className="font-mono">{call.agent_id}</span></div>
                          <div><span className="text-muted-foreground">Input chars:</span> {call.input_characters.toLocaleString()}</div>
                          <div><span className="text-muted-foreground">Input bytes (UTF-8):</span> {call.input_text_bytes.toLocaleString()}</div>
                          <div><span className="text-muted-foreground">Output audio:</span> {formatBytes(call.output_audio_bytes)} ({call.output_format})</div>
                          <div><span className="text-muted-foreground">Cost:</span> {formatCost(call.cost_total)}</div>
                          <div><span className="text-muted-foreground">Voice:</span> {call.voice_name || 'default'} {call.voice_id ? <span className="font-mono text-muted-foreground">({call.voice_id})</span> : null}</div>
                          <div><span className="text-muted-foreground">Channel:</span> {call.channel || '-'}</div>
                          {call.session_id && (
                            <div><span className="text-muted-foreground">Session:</span> <span className="font-mono">{call.session_id}</span></div>
                          )}
                          {call.user_id && (
                            <div><span className="text-muted-foreground">User:</span> <span className="font-mono">{call.user_id}</span></div>
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
