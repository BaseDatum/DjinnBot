/**
 * User Usage page — personal view of API usage, tokens, and costs.
 */

import { createFileRoute } from '@tanstack/react-router';
import { useState, useEffect, useCallback } from 'react';
import {
  Activity,
  MessageSquare,
  Play,
  Hash,
  Coins,
  ChevronDown,
  ChevronRight,
  Loader2,
  Filter,
} from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { KeySourceBadge } from '@/components/ui/KeySourceBadge';
import { SessionTokenStats } from '@/components/ui/SessionTokenStats';
import { LlmCallLog } from '@/components/admin/LlmCallLog';
import { API_BASE } from '@/lib/api';
import { authFetch } from '@/lib/auth';

export const Route = createFileRoute('/usage')({
  component: UsagePage,
});

// ── Types ───────────────────────────────────────────────────────────────────

interface UsageItem {
  id: string;
  type: 'chat' | 'run';
  agentId: string;
  model: string | null;
  status: string;
  keyResolution: any | null;
  createdAt: number;
  completedAt: number | null;
}

interface UsageSummary {
  totalSessions: number;
  totalRuns: number;
  totalLlmCalls: number;
  totalTokens: number;
  totalInputTokens: number;
  totalOutputTokens: number;
  totalCacheReadTokens: number;
  totalCacheWriteTokens: number;
  totalCost: number;
}

interface UsageResponse {
  items: UsageItem[];
  total: number;
  hasMore: boolean;
  summary: UsageSummary;
}

// ── Helpers ─────────────────────────────────────────────────────────────────

function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return String(n);
}

function formatCost(cost: number): string {
  if (cost === 0) return '$0.00';
  if (cost < 0.01) return `$${cost.toFixed(4)}`;
  return `$${cost.toFixed(2)}`;
}

function formatRelativeTime(ts: number): string {
  const diff = Date.now() - ts;
  if (diff < 60_000) return 'just now';
  if (diff < 3600_000) return `${Math.floor(diff / 60_000)}m ago`;
  if (diff < 86400_000) return `${Math.floor(diff / 3600_000)}h ago`;
  return new Date(ts).toLocaleDateString();
}

function formatDuration(start: number, end: number | null): string {
  if (!end) return '-';
  const sec = Math.round((end - start) / 1000);
  if (sec < 60) return `${sec}s`;
  if (sec < 3600) return `${Math.floor(sec / 60)}m ${sec % 60}s`;
  return `${Math.floor(sec / 3600)}h ${Math.floor((sec % 3600) / 60)}m`;
}

const STATUS_COLORS: Record<string, string> = {
  running: 'bg-blue-500/10 text-blue-600',
  starting: 'bg-blue-500/10 text-blue-500',
  completed: 'bg-green-500/10 text-green-600',
  failed: 'bg-red-500/10 text-red-600',
  pending: 'bg-yellow-500/10 text-yellow-600',
};

// ── Component ───────────────────────────────────────────────────────────────

function UsagePage() {
  const [data, setData] = useState<UsageResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [offset, setOffset] = useState(0);
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const limit = 50;

  // Filters
  const [typeFilter, setTypeFilter] = useState<string>('');
  const [statusFilter, setStatusFilter] = useState<string>('');

  const fetchUsage = useCallback(async (currentOffset: number) => {
    setLoading(true);
    try {
      const params = new URLSearchParams();
      params.set('limit', String(limit));
      params.set('offset', String(currentOffset));
      if (typeFilter) params.set('type', typeFilter);
      if (statusFilter) params.set('status', statusFilter);

      const res = await authFetch(`${API_BASE}/usage/me?${params.toString()}`);
      if (res.ok) {
        setData(await res.json());
      }
    } catch {
      // Non-fatal
    } finally {
      setLoading(false);
    }
  }, [typeFilter, statusFilter]);

  useEffect(() => {
    setOffset(0);
    fetchUsage(0);
  }, [fetchUsage]);

  const summary = data?.summary;

  return (
    <div className="max-w-5xl mx-auto p-6 space-y-6">
      {/* Header */}
      <div>
        <h1 className="text-xl font-semibold flex items-center gap-2">
          <Activity className="h-5 w-5" />
          My Usage
        </h1>
        <p className="text-sm text-muted-foreground mt-1">
          Your API calls, token usage, and costs across all sessions and runs.
        </p>
      </div>

      {/* Summary cards */}
      {summary && summary.totalLlmCalls > 0 && (
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
          <div className="border rounded-lg p-3">
            <div className="text-xs text-muted-foreground">Sessions / Runs</div>
            <div className="text-lg font-semibold mt-1">
              {summary.totalSessions + summary.totalRuns}
            </div>
            <div className="text-[10px] text-muted-foreground">
              {summary.totalSessions} chats, {summary.totalRuns} runs
            </div>
          </div>
          <div className="border rounded-lg p-3">
            <div className="text-xs text-muted-foreground flex items-center gap-1">
              <Hash className="h-3 w-3" /> Total Tokens
            </div>
            <div className="text-lg font-semibold mt-1">{formatTokens(summary.totalTokens)}</div>
            <div className="text-[10px] text-muted-foreground">
              In: {formatTokens(summary.totalInputTokens)} / Out: {formatTokens(summary.totalOutputTokens)}
            </div>
          </div>
          <div className="border rounded-lg p-3">
            <div className="text-xs text-muted-foreground">Cache Tokens</div>
            <div className="text-lg font-semibold mt-1">
              {formatTokens(summary.totalCacheReadTokens + summary.totalCacheWriteTokens)}
            </div>
            <div className="text-[10px] text-muted-foreground">
              Read: {formatTokens(summary.totalCacheReadTokens)} / Write: {formatTokens(summary.totalCacheWriteTokens)}
            </div>
          </div>
          <div className="border rounded-lg p-3">
            <div className="text-xs text-muted-foreground flex items-center gap-1">
              <Coins className="h-3 w-3" /> Total Cost
            </div>
            <div className="text-lg font-semibold mt-1">{formatCost(summary.totalCost)}</div>
            <div className="text-[10px] text-muted-foreground">
              {summary.totalLlmCalls} API calls
            </div>
          </div>
        </div>
      )}

      {/* Filters */}
      <div className="flex flex-wrap gap-2 items-center">
        <Filter className="h-4 w-4 text-muted-foreground" />
        <select
          value={typeFilter}
          onChange={(e) => setTypeFilter(e.target.value)}
          className="h-8 rounded-md border bg-background px-2 text-xs"
        >
          <option value="">All types</option>
          <option value="chat">Chat sessions</option>
          <option value="run">Pipeline runs</option>
        </select>
        <select
          value={statusFilter}
          onChange={(e) => setStatusFilter(e.target.value)}
          className="h-8 rounded-md border bg-background px-2 text-xs"
        >
          <option value="">All statuses</option>
          <option value="running">Running</option>
          <option value="completed">Completed</option>
          <option value="failed">Failed</option>
        </select>
        {data && (
          <span className="text-xs text-muted-foreground ml-auto">{data.total} total</span>
        )}
      </div>

      {/* Items list */}
      {loading ? (
        <div className="flex justify-center py-12">
          <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
        </div>
      ) : !data || data.items.length === 0 ? (
        <div className="text-center py-12 text-muted-foreground">
          No usage data yet. Start a chat or run a pipeline to see your usage here.
        </div>
      ) : (
        <div className="border rounded-lg overflow-hidden">
          <table className="w-full text-sm">
            <thead className="bg-muted/50">
              <tr>
                <th className="text-left px-4 py-3 font-medium w-8"></th>
                <th className="text-left px-4 py-3 font-medium">Type</th>
                <th className="text-left px-4 py-3 font-medium">Agent</th>
                <th className="text-left px-4 py-3 font-medium">Model</th>
                <th className="text-left px-4 py-3 font-medium">Keys</th>
                <th className="text-left px-4 py-3 font-medium">Tokens</th>
                <th className="text-left px-4 py-3 font-medium">Status</th>
                <th className="text-right px-4 py-3 font-medium">Time</th>
              </tr>
            </thead>
            <tbody className="divide-y">
              {data.items.map((item) => {
                const isExpanded = expandedId === item.id;
                const isLive = item.status === 'running' || item.status === 'starting' || item.status === 'pending';
                return (
                  <>
                    <tr
                      key={item.id}
                      className="hover:bg-muted/30 cursor-pointer"
                      onClick={() => setExpandedId(isExpanded ? null : item.id)}
                    >
                      <td className="px-4 py-3 text-muted-foreground">
                        {isExpanded ? <ChevronDown className="h-3.5 w-3.5" /> : <ChevronRight className="h-3.5 w-3.5" />}
                      </td>
                      <td className="px-4 py-3">
                        <Badge variant="outline" className="text-[10px] font-medium">
                          {item.type === 'chat' ? (
                            <><MessageSquare className="h-2.5 w-2.5 mr-1" />Chat</>
                          ) : (
                            <><Play className="h-2.5 w-2.5 mr-1" />Run</>
                          )}
                        </Badge>
                      </td>
                      <td className="px-4 py-3">
                        <span className="text-xs font-mono">{item.agentId}</span>
                      </td>
                      <td className="px-4 py-3">
                        <span className="text-xs font-mono text-muted-foreground">{item.model || '-'}</span>
                      </td>
                      <td className="px-4 py-3">
                        {item.keyResolution ? (
                          <KeySourceBadge keyResolution={item.keyResolution} />
                        ) : (
                          <span className="text-xs text-muted-foreground">-</span>
                        )}
                      </td>
                      <td className="px-4 py-3">
                        <SessionTokenStats
                          sessionId={item.type === 'chat' ? item.id : undefined}
                          runId={item.type === 'run' ? item.id : undefined}
                        />
                      </td>
                      <td className="px-4 py-3">
                        <span className={`text-xs px-2 py-0.5 rounded-full ${STATUS_COLORS[item.status] || 'bg-muted text-muted-foreground'}`}>
                          {item.status}
                        </span>
                      </td>
                      <td className="px-4 py-3 text-right">
                        <div className="text-xs text-muted-foreground">{formatRelativeTime(item.createdAt)}</div>
                        {item.completedAt && (
                          <div className="text-[10px] text-muted-foreground">
                            {formatDuration(item.createdAt, item.completedAt)}
                          </div>
                        )}
                      </td>
                    </tr>
                    {isExpanded && (
                      <tr key={`${item.id}-detail`}>
                        <td colSpan={8} className="px-4 py-3 bg-muted/20">
                          <div className="space-y-3 text-xs">
                            <div className="grid grid-cols-2 gap-x-8 gap-y-1">
                              <div><span className="text-muted-foreground">ID:</span> <span className="font-mono">{item.id}</span></div>
                              <div><span className="text-muted-foreground">Agent:</span> <span className="font-mono">{item.agentId}</span></div>
                              <div><span className="text-muted-foreground">Started:</span> {new Date(item.createdAt).toLocaleString()}</div>
                              <div><span className="text-muted-foreground">Duration:</span> {formatDuration(item.createdAt, item.completedAt)}</div>
                            </div>
                            <div>
                              <div className="text-muted-foreground font-medium mb-1.5">LLM API Calls</div>
                              <LlmCallLog
                                sessionId={item.type === 'chat' ? item.id : undefined}
                                runId={item.type === 'run' ? item.id : undefined}
                                maxHeight="300px"
                                live={isLive}
                              />
                            </div>
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
      )}

      {/* Pagination */}
      {data && data.total > limit && (
        <div className="flex items-center justify-between text-xs text-muted-foreground">
          <span>
            Showing {offset + 1}-{Math.min(offset + data.items.length, data.total)} of {data.total}
          </span>
          <div className="flex gap-2">
            <Button
              variant="outline"
              size="sm"
              disabled={offset === 0}
              onClick={() => { const o = Math.max(0, offset - limit); setOffset(o); fetchUsage(o); }}
            >
              Previous
            </Button>
            <Button
              variant="outline"
              size="sm"
              disabled={!data.hasMore}
              onClick={() => { const o = offset + limit; setOffset(o); fetchUsage(o); }}
            >
              Next
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}
