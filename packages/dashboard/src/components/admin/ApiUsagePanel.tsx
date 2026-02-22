/**
 * ApiUsagePanel — Admin panel component for viewing API usage across all users.
 *
 * Shows a unified view of all chat sessions and pipeline runs with:
 * - Who initiated each session/run
 * - Which API keys were used (personal / admin-shared / instance)
 * - Masked key hints per provider
 * - Model, status, and timing info
 * - Filterable by user, key source, type, and status
 */

import { useState, useEffect, useCallback, useRef } from 'react';
import {
  Activity,
  Key,
  Share2,
  Server,
  User,
  MessageSquare,
  Play,
  Filter,
  ChevronDown,
  ChevronRight,
  Loader2,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { API_BASE } from '@/lib/api';
import { authFetch } from '@/lib/auth';
import { useSSE } from '@/hooks/useSSE';
import { toast } from 'sonner';

interface ProviderSource {
  source: string; // "personal" | "admin_shared" | "instance"
  masked_key: string;
}

interface KeyResolution {
  source?: string;
  userId?: string | null;
  resolvedProviders?: string[];
  providerSources?: Record<string, ProviderSource>;
}

interface UsageItem {
  id: string;
  type: 'chat' | 'run';
  agentId: string;
  userId: string | null;
  userEmail: string | null;
  userDisplayName: string | null;
  source: string | null;
  model: string | null;
  status: string;
  keyResolution: KeyResolution | null;
  createdAt: number;
  completedAt: number | null;
}

interface UsageListResponse {
  items: UsageItem[];
  total: number;
  hasMore: boolean;
}

const KEY_SOURCE_LABELS: Record<string, { label: string; color: string; icon: typeof Key }> = {
  personal: {
    label: 'Personal',
    color: 'border-green-500/40 text-green-600 dark:text-green-400 bg-green-500/5',
    icon: Key,
  },
  admin_shared: {
    label: 'Admin Shared',
    color: 'border-blue-500/40 text-blue-600 dark:text-blue-400 bg-blue-500/5',
    icon: Share2,
  },
  instance: {
    label: 'Instance',
    color: 'border-amber-500/40 text-amber-600 dark:text-amber-400 bg-amber-500/5',
    icon: Server,
  },
};

const STATUS_COLORS: Record<string, string> = {
  running: 'bg-blue-500/10 text-blue-600',
  starting: 'bg-blue-500/10 text-blue-500',
  completed: 'bg-green-500/10 text-green-600',
  failed: 'bg-red-500/10 text-red-600',
  ready: 'bg-muted text-muted-foreground',
  pending: 'bg-yellow-500/10 text-yellow-600',
};

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

function ProviderKeyBadges({ keyResolution }: { keyResolution: KeyResolution | null }) {
  if (!keyResolution) return <span className="text-xs text-muted-foreground">-</span>;

  const providerSources = keyResolution.providerSources;

  // New enriched format: show per-provider source + masked key
  if (providerSources && Object.keys(providerSources).length > 0) {
    return (
      <div className="flex flex-wrap gap-1">
        {Object.entries(providerSources).map(([providerId, ps]) => {
          const meta = KEY_SOURCE_LABELS[ps.source] || KEY_SOURCE_LABELS.instance;
          const Icon = meta.icon;
          return (
            <span
              key={providerId}
              className={`inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[10px] font-medium whitespace-nowrap ${meta.color}`}
              title={`${providerId}: ${ps.source} key (${ps.masked_key})`}
            >
              <Icon className="h-2.5 w-2.5 shrink-0" />
              {providerId}
              <span className="text-muted-foreground font-mono ml-0.5">{ps.masked_key}</span>
            </span>
          );
        })}
      </div>
    );
  }

  // Legacy format: just show the top-level source badge
  const source = keyResolution.source;
  let label = 'Unknown';
  let colorClass = 'border-muted-foreground/30 text-muted-foreground';
  let Icon = Key;

  if (source === 'executing_user') {
    label = 'User keys';
    colorClass = 'border-green-500/40 text-green-600 dark:text-green-400';
    Icon = Key;
  } else if (source === 'system') {
    label = 'Instance keys';
    colorClass = 'border-amber-500/40 text-amber-600 dark:text-amber-400';
    Icon = Server;
  }

  return (
    <span
      className={`inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[10px] font-medium ${colorClass}`}
    >
      <Icon className="h-2.5 w-2.5" />
      {label}
      {keyResolution.resolvedProviders?.length ? (
        <span className="text-muted-foreground ml-0.5">
          ({keyResolution.resolvedProviders.join(', ')})
        </span>
      ) : null}
    </span>
  );
}

export function ApiUsagePanel() {
  const [items, setItems] = useState<UsageItem[]>([]);
  const [total, setTotal] = useState(0);
  const [hasMore, setHasMore] = useState(false);
  const [loading, setLoading] = useState(true);
  const [offset, setOffset] = useState(0);
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const limit = 50;

  // Filters
  const [typeFilter, setTypeFilter] = useState<string>('');
  const [statusFilter, setStatusFilter] = useState<string>('');
  const [keySourceFilter, setKeySourceFilter] = useState<string>('');

  const fetchUsage = useCallback(async (currentOffset: number) => {
    setLoading(true);
    try {
      const params = new URLSearchParams();
      params.set('limit', String(limit));
      params.set('offset', String(currentOffset));
      if (typeFilter) params.set('type', typeFilter);
      if (statusFilter) params.set('status', statusFilter);
      if (keySourceFilter) params.set('key_source', keySourceFilter);

      const res = await authFetch(`${API_BASE}/admin/usage?${params.toString()}`);
      if (!res.ok) throw new Error('Failed to fetch');
      const data: UsageListResponse = await res.json();
      setItems(data.items);
      setTotal(data.total);
      setHasMore(data.hasMore);
    } catch {
      toast.error('Failed to load API usage data');
    } finally {
      setLoading(false);
    }
  }, [typeFilter, statusFilter, keySourceFilter]);

  useEffect(() => {
    setOffset(0);
    fetchUsage(0);
  }, [fetchUsage]);

  // Debounced refetch on SSE events (sessions starting/completing/failing)
  const refreshTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const debouncedRefresh = useCallback(() => {
    if (refreshTimerRef.current) clearTimeout(refreshTimerRef.current);
    refreshTimerRef.current = setTimeout(() => {
      fetchUsage(offset);
    }, 800); // Debounce to avoid rapid re-fetches
  }, [fetchUsage, offset]);

  // Live-updating event types that should trigger a refetch
  const handleSSE = useCallback((event: any) => {
    const type = event?.type || event?.event;
    if (
      type === 'created' ||
      type === 'completed' ||
      type === 'status_changed' ||
      type === 'status' ||
      type === 'failed' ||
      type === 'deleted'
    ) {
      debouncedRefresh();
    }
  }, [debouncedRefresh]);

  // Subscribe to pipeline session SSE stream for live updates
  useSSE({ url: `${API_BASE}/events/sessions`, onMessage: handleSSE });

  // Subscribe to chat session SSE stream for live updates
  useSSE({ url: `${API_BASE}/events/chat-sessions`, onMessage: handleSSE });

  // Cleanup debounce timer
  useEffect(() => {
    return () => {
      if (refreshTimerRef.current) clearTimeout(refreshTimerRef.current);
    };
  }, []);

  const handleNextPage = () => {
    const newOffset = offset + limit;
    setOffset(newOffset);
    fetchUsage(newOffset);
  };

  const handlePrevPage = () => {
    const newOffset = Math.max(0, offset - limit);
    setOffset(newOffset);
    fetchUsage(newOffset);
  };

  return (
    <div className="max-w-6xl mx-auto space-y-4">
      <div>
        <h2 className="text-lg font-semibold flex items-center gap-2">
          <Activity className="h-5 w-5" />
          API Usage
        </h2>
        <p className="text-sm text-muted-foreground mt-1">
          All chat sessions and pipeline runs across all users, showing which API keys were used.
        </p>
      </div>

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
          <option value="starting">Starting</option>
          <option value="pending">Pending</option>
        </select>
        <select
          value={keySourceFilter}
          onChange={(e) => setKeySourceFilter(e.target.value)}
          className="h-8 rounded-md border bg-background px-2 text-xs"
        >
          <option value="">All key sources</option>
          <option value="personal">Personal keys</option>
          <option value="admin_shared">Admin shared keys</option>
          <option value="instance">Instance keys</option>
        </select>
        <span className="text-xs text-muted-foreground ml-auto">
          {total} total
        </span>
      </div>

      {/* Table */}
      {loading ? (
        <div className="flex justify-center py-12">
          <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
        </div>
      ) : items.length === 0 ? (
        <div className="text-center py-12 text-muted-foreground">
          No usage data found
        </div>
      ) : (
        <div className="border rounded-lg overflow-hidden">
          <table className="w-full text-sm">
            <thead className="bg-muted/50">
              <tr>
                <th className="text-left px-4 py-3 font-medium w-8"></th>
                <th className="text-left px-4 py-3 font-medium">Type</th>
                <th className="text-left px-4 py-3 font-medium">User</th>
                <th className="text-left px-4 py-3 font-medium">Agent</th>
                <th className="text-left px-4 py-3 font-medium">Model</th>
                <th className="text-left px-4 py-3 font-medium">Keys Used</th>
                <th className="text-left px-4 py-3 font-medium">Status</th>
                <th className="text-right px-4 py-3 font-medium">Time</th>
              </tr>
            </thead>
            <tbody className="divide-y">
              {items.map((item) => {
                const isExpanded = expandedId === item.id;
                return (
                  <>
                    <tr
                      key={item.id}
                      className="hover:bg-muted/30 cursor-pointer"
                      onClick={() => setExpandedId(isExpanded ? null : item.id)}
                    >
                      <td className="px-4 py-3 text-muted-foreground">
                        {isExpanded ? (
                          <ChevronDown className="h-3.5 w-3.5" />
                        ) : (
                          <ChevronRight className="h-3.5 w-3.5" />
                        )}
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
                        {item.userDisplayName || item.userEmail ? (
                          <div>
                            <div className="text-xs font-medium flex items-center gap-1">
                              <User className="h-3 w-3 text-muted-foreground" />
                              {item.userDisplayName || item.userEmail}
                            </div>
                            {item.userDisplayName && item.userEmail && (
                              <div className="text-[10px] text-muted-foreground">{item.userEmail}</div>
                            )}
                          </div>
                        ) : (
                          <span className="text-xs text-muted-foreground flex items-center gap-1">
                            <Server className="h-3 w-3" />
                            System
                          </span>
                        )}
                      </td>
                      <td className="px-4 py-3">
                        <span className="text-xs font-mono">{item.agentId}</span>
                      </td>
                      <td className="px-4 py-3">
                        <span className="text-xs font-mono text-muted-foreground">
                          {item.model || '-'}
                        </span>
                      </td>
                      <td className="px-4 py-3">
                        <ProviderKeyBadges keyResolution={item.keyResolution} />
                      </td>
                      <td className="px-4 py-3">
                        <span className={`text-xs px-2 py-0.5 rounded-full ${STATUS_COLORS[item.status] || 'bg-muted text-muted-foreground'}`}>
                          {item.status}
                        </span>
                      </td>
                      <td className="px-4 py-3 text-right">
                        <div className="text-xs text-muted-foreground">
                          {formatRelativeTime(item.createdAt)}
                        </div>
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
                          <UsageItemDetail item={item} />
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
      {total > limit && (
        <div className="flex items-center justify-between text-xs text-muted-foreground">
          <span>
            Showing {offset + 1}-{Math.min(offset + items.length, total)} of {total}
          </span>
          <div className="flex gap-2">
            <Button
              variant="outline"
              size="sm"
              disabled={offset === 0}
              onClick={handlePrevPage}
            >
              Previous
            </Button>
            <Button
              variant="outline"
              size="sm"
              disabled={!hasMore}
              onClick={handleNextPage}
            >
              Next
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}


function UsageItemDetail({ item }: { item: UsageItem }) {
  const kr = item.keyResolution;
  const providerSources = kr?.providerSources;

  return (
    <div className="space-y-3 text-xs">
      <div className="grid grid-cols-2 gap-x-8 gap-y-2">
        <div>
          <span className="text-muted-foreground">ID:</span>{' '}
          <span className="font-mono">{item.id}</span>
        </div>
        <div>
          <span className="text-muted-foreground">Agent:</span>{' '}
          <span className="font-mono">{item.agentId}</span>
        </div>
        <div>
          <span className="text-muted-foreground">Source:</span>{' '}
          {item.source || '-'}
        </div>
        <div>
          <span className="text-muted-foreground">Model:</span>{' '}
          <span className="font-mono">{item.model || '-'}</span>
        </div>
        <div>
          <span className="text-muted-foreground">Started:</span>{' '}
          {new Date(item.createdAt).toLocaleString()}
        </div>
        <div>
          <span className="text-muted-foreground">Duration:</span>{' '}
          {formatDuration(item.createdAt, item.completedAt)}
        </div>
      </div>

      {/* Per-provider key details */}
      {providerSources && Object.keys(providerSources).length > 0 && (
        <div>
          <div className="text-muted-foreground font-medium mb-1.5">Provider Keys</div>
          <div className="border rounded-md overflow-hidden">
            <table className="w-full text-xs">
              <thead className="bg-muted/30">
                <tr>
                  <th className="text-left px-3 py-1.5 font-medium">Provider</th>
                  <th className="text-left px-3 py-1.5 font-medium">Key Type</th>
                  <th className="text-left px-3 py-1.5 font-medium">Masked Key</th>
                </tr>
              </thead>
              <tbody className="divide-y">
                {Object.entries(providerSources).map(([providerId, ps]) => {
                  const meta = KEY_SOURCE_LABELS[ps.source] || KEY_SOURCE_LABELS.instance;
                  const Icon = meta.icon;
                  return (
                    <tr key={providerId}>
                      <td className="px-3 py-1.5 font-mono">{providerId}</td>
                      <td className="px-3 py-1.5">
                        <span className={`inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[10px] font-medium ${meta.color}`}>
                          <Icon className="h-2.5 w-2.5" />
                          {meta.label}
                        </span>
                      </td>
                      <td className="px-3 py-1.5 font-mono text-muted-foreground">{ps.masked_key}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* Legacy key info when no per-provider data */}
      {(!providerSources || Object.keys(providerSources).length === 0) && kr && (
        <div>
          <div className="text-muted-foreground font-medium mb-1">Key Resolution (legacy)</div>
          <div className="text-xs">
            <span className="text-muted-foreground">Source:</span>{' '}
            {kr.source === 'executing_user' ? 'User keys' : kr.source === 'system' ? 'Instance keys' : kr.source || '-'}
            {kr.resolvedProviders?.length ? (
              <span className="ml-2 text-muted-foreground">
                Providers: {kr.resolvedProviders.join(', ')}
              </span>
            ) : null}
          </div>
        </div>
      )}
    </div>
  );
}
