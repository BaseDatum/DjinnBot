import { useEffect, useRef, useState, useCallback } from 'react';

interface UseSSEOptions<T> {
  url: string;
  onMessage?: (data: T) => void;
  enabled?: boolean;
  reconnectAttempts?: number;
  reconnectInterval?: number;
  /**
   * Called on each (re)connect to get the ?since= query param value.
   * Used to replay missed events from the Redis Stream buffer after a disconnect.
   * Return '0-0' or omit to start from the current live position.
   */
  getSinceParam?: () => string;
}

interface UseSSEReturn<T> {
  status: 'connecting' | 'connected' | 'error' | 'closed';
  lastMessage: T | null;
  lastEventTime: Date | null;
  reconnect: () => void;
}

export function useSSE<T>({
  url,
  onMessage,
  enabled = true,
  reconnectAttempts = 5,
  reconnectInterval = 3000,
  getSinceParam,
}: UseSSEOptions<T>): UseSSEReturn<T> {
  const [status, setStatus] = useState<UseSSEReturn<T>['status']>('closed');
  const [lastMessage, setLastMessage] = useState<T | null>(null);
  const [lastEventTime, setLastEventTime] = useState<Date | null>(null);
  const eventSourceRef = useRef<EventSource | null>(null);
  const reconnectCountRef = useRef(0);
  const reconnectTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const onMessageRef = useRef(onMessage);

  // Keep the callback ref updated without triggering reconnects
  useEffect(() => {
    onMessageRef.current = onMessage;
  }, [onMessage]);

  // Keep getSinceParam stable in a ref so it doesn't retrigger connect
  const getSinceParamRef = useRef(getSinceParam);
  useEffect(() => {
    getSinceParamRef.current = getSinceParam;
  }, [getSinceParam]);

  const connect = useCallback(() => {
    if (!enabled) return;

    if (eventSourceRef.current) {
      eventSourceRef.current.close();
    }

    setStatus('connecting');

    try {
      const since = getSinceParamRef.current?.() ?? '0-0';
      const fullUrl = since && since !== '0-0'
        ? `${url}${url.includes('?') ? '&' : '?'}since=${encodeURIComponent(since)}`
        : url;
      const es = new EventSource(fullUrl);
      eventSourceRef.current = es;

      es.onopen = () => {
        setStatus('connected');
        reconnectCountRef.current = 0;
      };

      es.onmessage = (event) => {
        try {
          const data = JSON.parse(event.data) as T;
          // Only update lastMessage/lastEventTime for non-token events to avoid
          // triggering a React re-render on every streaming token.
          const type = (data as any)?.type;
          if (type !== 'output' && type !== 'thinking') {
            setLastMessage(data);
            setLastEventTime(new Date());
          }
          onMessageRef.current?.(data);
        } catch {
          onMessageRef.current?.(event.data as unknown as T);
        }
      };

      es.onerror = () => {
        setStatus('error');
        es.close();

        if (reconnectCountRef.current < reconnectAttempts) {
          reconnectCountRef.current += 1;
          reconnectTimerRef.current = setTimeout(() => {
            connect();
          }, reconnectInterval);
        } else {
          setStatus('closed');
        }
      };
    } catch {
      setStatus('error');
    }
  }, [url, enabled, reconnectAttempts, reconnectInterval]);

  const reconnect = useCallback(() => {
    reconnectCountRef.current = 0;
    connect();
  }, [connect]);

  useEffect(() => {
    connect();
    return () => {
      if (reconnectTimerRef.current) {
        clearTimeout(reconnectTimerRef.current);
      }
      if (eventSourceRef.current) {
        eventSourceRef.current.close();
      }
    };
  }, [connect]);

  return { status, lastMessage, lastEventTime, reconnect };
}
