/**
 * useLogStream — SSE hook specialized for container log streaming.
 *
 * Connects to the admin log SSE endpoints and accumulates log lines
 * in a circular buffer. Handles reconnection, backfill, and named
 * SSE events (event: log, event: connected, event: error).
 */

import { useEffect, useRef, useState, useCallback } from 'react';
import { getAccessToken } from '@/lib/auth';
import { API_BASE } from '@/lib/api';

export interface LogLine {
  /** Unique ID from Redis stream (used as React key) */
  id: string;
  /** Raw log line text */
  line: string;
  /** Log level: info, warn, error, debug */
  level: string;
  /** ISO timestamp */
  ts: string;
  /** Container name */
  container: string;
  /** Service type: api, engine, dashboard, mcpo, agent-runtime, etc. */
  service: string;
}

export interface ContainerInfo {
  name: string;
  serviceType: string;
  streaming: boolean;
  startedAt: number;
}

interface UseLogStreamOptions {
  /** 'merged' or a specific container name */
  source: string;
  /** Maximum lines to keep in buffer */
  maxLines?: number;
  /** Number of recent lines to backfill on connect */
  tail?: number;
  /** Whether the stream is enabled */
  enabled?: boolean;
  /** Whether the stream is paused (keeps connection, stops adding to buffer) */
  paused?: boolean;
}

interface UseLogStreamReturn {
  lines: LogLine[];
  status: 'connecting' | 'connected' | 'error' | 'closed';
  clear: () => void;
  reconnect: () => void;
}

const MAX_LINES_DEFAULT = 5000;

export function useLogStream({
  source,
  maxLines = MAX_LINES_DEFAULT,
  tail = 200,
  enabled = true,
  paused = false,
}: UseLogStreamOptions): UseLogStreamReturn {
  const [lines, setLines] = useState<LogLine[]>([]);
  const [status, setStatus] = useState<UseLogStreamReturn['status']>('closed');
  const eventSourceRef = useRef<EventSource | null>(null);
  const reconnectTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const reconnectCountRef = useRef(0);
  const pausedRef = useRef(paused);
  const idCounterRef = useRef(0);

  // Keep paused ref current without reconnecting
  useEffect(() => {
    pausedRef.current = paused;
  }, [paused]);

  const clear = useCallback(() => {
    setLines([]);
  }, []);

  const connect = useCallback(() => {
    if (!enabled) return;

    // Close existing connection
    if (eventSourceRef.current) {
      eventSourceRef.current.close();
      eventSourceRef.current = null;
    }

    setStatus('connecting');

    try {
      // Build URL
      const streamPath = source === 'merged'
        ? `${API_BASE}/admin/logs/stream/merged`
        : `${API_BASE}/admin/logs/stream/${encodeURIComponent(source)}`;

      let url = `${streamPath}?tail=${tail}`;

      // Add auth token (EventSource doesn't support custom headers)
      const token = getAccessToken();
      if (token) {
        url += `&token=${encodeURIComponent(token)}`;
      }

      const es = new EventSource(url);
      eventSourceRef.current = es;

      // Handle named 'connected' event
      es.addEventListener('connected', () => {
        setStatus('connected');
        reconnectCountRef.current = 0;
      });

      // Handle named 'log' events
      es.addEventListener('log', (event: MessageEvent) => {
        if (pausedRef.current) return;

        try {
          const data = JSON.parse(event.data) as {
            line: string;
            level: string;
            ts: string;
            container: string;
            service: string;
          };

          const logLine: LogLine = {
            id: `${Date.now()}-${idCounterRef.current++}`,
            line: data.line,
            level: data.level || 'info',
            ts: data.ts || '',
            container: data.container || '',
            service: data.service || '',
          };

          setLines((prev) => {
            const next = [...prev, logLine];
            // Trim to max buffer size
            if (next.length > maxLines) {
              return next.slice(next.length - maxLines);
            }
            return next;
          });
        } catch {
          // Ignore malformed events
        }
      });

      // Handle named 'error' events from the server
      es.addEventListener('error', (event: MessageEvent) => {
        // This is a server-sent error event, not an EventSource error
        console.warn('[useLogStream] Server error event:', event.data);
      });

      // EventSource connection errors (different from server-sent 'error' events)
      es.onerror = () => {
        setStatus('error');
        es.close();
        eventSourceRef.current = null;

        // Reconnect with backoff
        if (reconnectCountRef.current < 10) {
          reconnectCountRef.current += 1;
          const delay = Math.min(1000 * reconnectCountRef.current, 15000);
          reconnectTimerRef.current = setTimeout(connect, delay);
        } else {
          setStatus('closed');
        }
      };
    } catch {
      setStatus('error');
    }
  }, [source, enabled, tail, maxLines]);

  const reconnect = useCallback(() => {
    reconnectCountRef.current = 0;
    setLines([]);
    connect();
  }, [connect]);

  // Connect on mount or when source/enabled changes
  useEffect(() => {
    connect();
    return () => {
      if (reconnectTimerRef.current) {
        clearTimeout(reconnectTimerRef.current);
        reconnectTimerRef.current = null;
      }
      if (eventSourceRef.current) {
        eventSourceRef.current.close();
        eventSourceRef.current = null;
      }
    };
  }, [connect]);

  return { lines, status, clear, reconnect };
}

/**
 * Fetch the list of containers being tracked by the log streamer.
 */
export async function fetchLogContainers(): Promise<ContainerInfo[]> {
  const { authFetch } = await import('@/lib/auth');
  const res = await authFetch(`${API_BASE}/admin/logs/containers`);
  if (!res.ok) return [];
  const data = await res.json();
  return data.containers ?? [];
}
