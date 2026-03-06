/**
 * ContainerLogs — Admin panel component for viewing container logs.
 *
 * Features:
 * - Per-container log streams (api, engine, dashboard, mcpo, agent-runtimes)
 * - Merged view combining all container logs
 * - Auto-scroll with toggle
 * - Client-side text filter
 * - Level filter (info, warn, error, debug)
 * - Pause/resume
 * - Color-coded log levels and container badges
 */

import { useState, useEffect, useRef, useMemo, useCallback } from 'react';
import {
  ScrollText,
  Pause,
  Play,
  Trash2,
  ArrowDown,
  Search,
  RefreshCw,
  Layers,
  Server,
  Wifi,
  WifiOff,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { cn } from '@/lib/utils';
import {
  useLogStream,
  fetchLogContainers,
  type LogLine,
  type ContainerInfo,
} from '@/hooks/useLogStream';

// ─── Service type colors ────────────────────────────────────────────────────

const SERVICE_BG_COLORS: Record<string, string> = {
  api: 'bg-blue-500/10 text-blue-400 border-blue-500/20',
  engine: 'bg-purple-500/10 text-purple-400 border-purple-500/20',
  dashboard: 'bg-green-500/10 text-green-400 border-green-500/20',
  mcpo: 'bg-yellow-500/10 text-yellow-400 border-yellow-500/20',
  postgres: 'bg-cyan-500/10 text-cyan-400 border-cyan-500/20',
  redis: 'bg-red-500/10 text-red-400 border-red-500/20',
  juicefs: 'bg-teal-500/10 text-teal-400 border-teal-500/20',
  rustfs: 'bg-amber-500/10 text-amber-400 border-amber-500/20',
  'agent-runtime': 'bg-orange-500/10 text-orange-400 border-orange-500/20',
  unknown: 'bg-gray-500/10 text-gray-400 border-gray-500/20',
};

const LEVEL_COLORS: Record<string, string> = {
  error: 'text-red-400',
  warn: 'text-yellow-400',
  info: 'text-foreground/80',
  debug: 'text-muted-foreground/60',
};

// ─── Container selector ─────────────────────────────────────────────────────

function ContainerSelector({
  containers,
  selected,
  onSelect,
  loading,
}: {
  containers: ContainerInfo[];
  selected: string;
  onSelect: (name: string) => void;
  loading: boolean;
}) {
  // Group by service type
  const groups = useMemo(() => {
    const map = new Map<string, ContainerInfo[]>();
    for (const c of containers) {
      const list = map.get(c.serviceType) || [];
      list.push(c);
      map.set(c.serviceType, list);
    }
    return map;
  }, [containers]);

  // Sort: infrastructure first, then agent-runtimes
  const sortedTypes = useMemo(() => {
    const order = ['api', 'engine', 'dashboard', 'mcpo', 'postgres', 'redis', 'juicefs', 'rustfs', 'agent-runtime', 'unknown'];
    return [...groups.keys()].sort((a, b) => {
      const ai = order.indexOf(a);
      const bi = order.indexOf(b);
      return (ai === -1 ? 99 : ai) - (bi === -1 ? 99 : bi);
    });
  }, [groups]);

  return (
    <div className="space-y-1">
      {/* Merged view button */}
      <button
        onClick={() => onSelect('merged')}
        className={cn(
          'w-full flex items-center gap-2 px-3 py-2 rounded-md text-sm font-medium transition-colors',
          selected === 'merged'
            ? 'bg-primary text-primary-foreground'
            : 'text-muted-foreground hover:bg-accent hover:text-accent-foreground',
        )}
      >
        <Layers className="h-4 w-4 shrink-0" />
        <span className="truncate">Merged View</span>
      </button>

      {loading && containers.length === 0 && (
        <div className="px-3 py-4 text-xs text-muted-foreground text-center">
          Loading containers...
        </div>
      )}

      {/* Container list grouped by type */}
      {sortedTypes.map((type) => {
        const items = groups.get(type) || [];
        return (
          <div key={type}>
            {items.length > 1 && (
              <div className="px-3 pt-2 pb-0.5 text-xs font-medium text-muted-foreground uppercase tracking-wider">
                {type}
              </div>
            )}
            {items.map((c) => {
              const displayName = c.name
                .replace('djinnbot-', '')
                .replace('djinn-run-', 'agent: ');
              return (
                <button
                  key={c.name}
                  onClick={() => onSelect(c.name)}
                  className={cn(
                    'w-full flex items-center gap-2 px-3 py-1.5 rounded-md text-sm transition-colors',
                    selected === c.name
                      ? 'bg-primary text-primary-foreground'
                      : 'text-muted-foreground hover:bg-accent hover:text-accent-foreground',
                  )}
                >
                  <Server className="h-3.5 w-3.5 shrink-0" />
                  <span className="truncate font-mono text-xs">{displayName}</span>
                  {c.streaming && (
                    <span className="ml-auto h-1.5 w-1.5 rounded-full bg-green-500 shrink-0" />
                  )}
                </button>
              );
            })}
          </div>
        );
      })}
    </div>
  );
}

// ─── Log line component ─────────────────────────────────────────────────────

function LogLineRow({ log, showContainer }: { log: LogLine; showContainer: boolean }) {
  // Parse timestamp for display
  const timeStr = useMemo(() => {
    if (!log.ts) return '';
    try {
      const d = new Date(log.ts);
      return d.toLocaleTimeString('en-US', { hour12: false } as Intl.DateTimeFormatOptions)
        + '.' + String(d.getMilliseconds()).padStart(3, '0');
    } catch {
      return log.ts.slice(11, 23); // fallback: extract HH:MM:SS.mmm
    }
  }, [log.ts]);

  return (
    <div className="flex items-start gap-0 font-mono text-xs leading-5 hover:bg-muted/30 px-3 py-0">
      {/* Timestamp */}
      <span className="text-muted-foreground shrink-0 w-[95px] select-all">
        {timeStr}
      </span>

      {/* Container badge (only in merged view) */}
      {showContainer && (
        <span
          className={cn(
            'shrink-0 w-[120px] truncate px-1 mr-1 rounded text-[10px] border',
            SERVICE_BG_COLORS[log.service] || SERVICE_BG_COLORS.unknown,
          )}
          title={log.container}
        >
          {log.container.replace('djinnbot-', '').replace('djinn-run-', 'run:')}
        </span>
      )}

      {/* Level indicator */}
      <span
        className={cn(
          'shrink-0 w-[45px] uppercase font-semibold',
          LEVEL_COLORS[log.level] || LEVEL_COLORS.info,
        )}
      >
        {log.level === 'error' ? 'ERR' : log.level === 'warn' ? 'WRN' : log.level === 'debug' ? 'DBG' : 'INF'}
      </span>

      {/* Log message */}
      <span
        className={cn(
          'flex-1 whitespace-pre-wrap break-all select-all',
          log.level === 'error' ? 'text-red-300' : log.level === 'warn' ? 'text-yellow-200' : '',
        )}
      >
        {log.line}
      </span>
    </div>
  );
}

// ─── Main component ─────────────────────────────────────────────────────────

export function ContainerLogs() {
  const [selected, setSelected] = useState('merged');
  const [containers, setContainers] = useState<ContainerInfo[]>([]);
  const [containersLoading, setContainersLoading] = useState(true);
  const [isPaused, setIsPaused] = useState(false);
  const [autoScroll, setAutoScroll] = useState(true);
  const [filter, setFilter] = useState('');
  const [levelFilter, setLevelFilter] = useState<string[]>([]);
  const scrollRef = useRef<HTMLDivElement>(null);

  // Fetch container list periodically
  useEffect(() => {
    let mounted = true;
    const load = async () => {
      try {
        const list = await fetchLogContainers();
        if (mounted) {
          setContainers(list);
          setContainersLoading(false);
        }
      } catch {
        if (mounted) setContainersLoading(false);
      }
    };
    load();
    const interval = setInterval(load, 15000);
    return () => {
      mounted = false;
      clearInterval(interval);
    };
  }, []);

  // Log stream
  const { lines, status, clear, reconnect } = useLogStream({
    source: selected,
    enabled: true,
    paused: isPaused,
    tail: 300,
    maxLines: 5000,
  });

  // Filter lines
  const filteredLines = useMemo(() => {
    let result = lines;
    if (filter) {
      const lower = filter.toLowerCase();
      result = result.filter(
        (l) =>
          l.line.toLowerCase().includes(lower) ||
          l.container.toLowerCase().includes(lower),
      );
    }
    if (levelFilter.length > 0) {
      result = result.filter((l) => levelFilter.includes(l.level));
    }
    return result;
  }, [lines, filter, levelFilter]);

  // Auto-scroll to bottom
  useEffect(() => {
    if (autoScroll && scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [filteredLines.length, autoScroll]);

  // Detect manual scroll-up to disable auto-scroll
  const handleScroll = useCallback(() => {
    if (!scrollRef.current) return;
    const { scrollTop, scrollHeight, clientHeight } = scrollRef.current;
    const isAtBottom = scrollHeight - scrollTop - clientHeight < 50;
    setAutoScroll(isAtBottom);
  }, []);

  const toggleLevel = (level: string) => {
    setLevelFilter((prev) =>
      prev.includes(level) ? prev.filter((l) => l !== level) : [...prev, level],
    );
  };

  const isMerged = selected === 'merged';

  return (
    <div className="flex flex-col h-full max-h-[calc(100vh-160px)]">
      {/* Header */}
      <div className="flex items-center justify-between gap-3 mb-3">
        <div>
          <h2 className="text-lg font-semibold flex items-center gap-2">
            <ScrollText className="h-5 w-5" />
            Container Logs
          </h2>
          <p className="text-sm text-muted-foreground mt-0.5">
            Live log streams from all running containers.
          </p>
        </div>
        <div className="flex items-center gap-1.5">
          {/* Connection status */}
          <span
            className={cn(
              'flex items-center gap-1 text-xs px-2 py-1 rounded-full',
              status === 'connected'
                ? 'bg-green-500/10 text-green-500'
                : status === 'connecting'
                  ? 'bg-yellow-500/10 text-yellow-500'
                  : 'bg-red-500/10 text-red-500',
            )}
          >
            {status === 'connected' ? (
              <Wifi className="h-3 w-3" />
            ) : (
              <WifiOff className="h-3 w-3" />
            )}
            {status}
          </span>
        </div>
      </div>

      <div className="flex flex-1 min-h-0 gap-3">
        {/* Container sidebar */}
        <div className="w-48 shrink-0 overflow-y-auto border rounded-lg p-2 bg-card">
          <ContainerSelector
            containers={containers}
            selected={selected}
            onSelect={(name) => {
              setSelected(name);
              setAutoScroll(true);
            }}
            loading={containersLoading}
          />
        </div>

        {/* Log viewer */}
        <div className="flex-1 flex flex-col min-w-0 border rounded-lg bg-card overflow-hidden">
          {/* Toolbar */}
          <div className="flex items-center gap-2 px-3 py-2 border-b bg-muted/30">
            {/* Search */}
            <div className="relative flex-1 max-w-xs">
              <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted-foreground" />
              <Input
                value={filter}
                onChange={(e) => setFilter(e.target.value)}
                placeholder="Filter logs..."
                className="h-7 pl-8 text-xs"
              />
            </div>

            {/* Level filters */}
            <div className="flex items-center gap-1">
              {['error', 'warn', 'info', 'debug'].map((level) => (
                <button
                  key={level}
                  onClick={() => toggleLevel(level)}
                  className={cn(
                    'px-2 py-0.5 rounded text-[10px] font-semibold uppercase border transition-colors',
                    levelFilter.length === 0 || levelFilter.includes(level)
                      ? level === 'error'
                        ? 'bg-red-500/15 text-red-400 border-red-500/30'
                        : level === 'warn'
                          ? 'bg-yellow-500/15 text-yellow-400 border-yellow-500/30'
                          : level === 'debug'
                            ? 'bg-gray-500/15 text-gray-400 border-gray-500/30'
                            : 'bg-blue-500/15 text-blue-400 border-blue-500/30'
                      : 'bg-muted/50 text-muted-foreground/40 border-transparent',
                  )}
                >
                  {level}
                </button>
              ))}
            </div>

            <div className="flex-1" />

            {/* Actions */}
            <Button
              size="sm"
              variant="ghost"
              className="h-7 px-2"
              onClick={() => setIsPaused((p) => !p)}
              title={isPaused ? 'Resume' : 'Pause'}
            >
              {isPaused ? <Play className="h-3.5 w-3.5" /> : <Pause className="h-3.5 w-3.5" />}
            </Button>
            <Button
              size="sm"
              variant="ghost"
              className="h-7 px-2"
              onClick={() => {
                setAutoScroll(true);
                if (scrollRef.current) {
                  scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
                }
              }}
              title="Scroll to bottom"
            >
              <ArrowDown className="h-3.5 w-3.5" />
            </Button>
            <Button
              size="sm"
              variant="ghost"
              className="h-7 px-2"
              onClick={clear}
              title="Clear logs"
            >
              <Trash2 className="h-3.5 w-3.5" />
            </Button>
            <Button
              size="sm"
              variant="ghost"
              className="h-7 px-2"
              onClick={reconnect}
              title="Reconnect"
            >
              <RefreshCw className="h-3.5 w-3.5" />
            </Button>

            {/* Line count */}
            <span className="text-[10px] text-muted-foreground tabular-nums shrink-0">
              {filteredLines.length.toLocaleString()} lines
              {isPaused && ' (paused)'}
            </span>
          </div>

          {/* Log content */}
          <div
            ref={scrollRef}
            onScroll={handleScroll}
            className="flex-1 overflow-auto bg-background/50"
          >
            {filteredLines.length === 0 ? (
              <div className="flex items-center justify-center h-full text-sm text-muted-foreground">
                {status === 'connecting'
                  ? 'Connecting to log stream...'
                  : status === 'error'
                    ? 'Connection error. Retrying...'
                    : filter
                      ? 'No logs match the filter.'
                      : 'Waiting for log data...'}
              </div>
            ) : (
              <div className="py-1">
                {filteredLines.map((log) => (
                  <LogLineRow key={log.id} log={log} showContainer={isMerged} />
                ))}
              </div>
            )}
          </div>

          {/* Auto-scroll indicator */}
          {!autoScroll && filteredLines.length > 0 && (
            <button
              onClick={() => {
                setAutoScroll(true);
                if (scrollRef.current) {
                  scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
                }
              }}
              className="absolute bottom-4 right-4 flex items-center gap-1.5 px-3 py-1.5 rounded-full bg-primary text-primary-foreground text-xs font-medium shadow-lg hover:bg-primary/90 transition-colors"
            >
              <ArrowDown className="h-3 w-3" />
              Auto-scroll
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
