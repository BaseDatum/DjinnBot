import { useEffect, useRef, useCallback, useState } from 'react';
import { wsBase } from '@/lib/api';

const WS_RECONNECT_BASE_MS = 800;
const WS_RECONNECT_MAX_MS = 10_000;

interface UseMemoryWebSocketOptions {
  agentId: string;
  enabled?: boolean;
  onUpdate?: () => void;
}

export function useMemoryWebSocket({ agentId, enabled = true, onUpdate }: UseMemoryWebSocketOptions) {
  const [connected, setConnected] = useState(false);
  const wsRef = useRef<WebSocket | null>(null);
  const reconnectTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const reconnectDelayRef = useRef(WS_RECONNECT_BASE_MS);
  const enabledRef = useRef(enabled);
  const onUpdateRef = useRef(onUpdate);

  onUpdateRef.current = onUpdate;
  enabledRef.current = enabled;

  const connect = useCallback(() => {
    if (!enabledRef.current) return;
    if (wsRef.current?.readyState === WebSocket.OPEN || wsRef.current?.readyState === WebSocket.CONNECTING) return;

    const ws = new WebSocket(`${wsBase()}/v1/memory/vaults/${agentId}/ws`);
    wsRef.current = ws;

    ws.addEventListener('open', () => {
      setConnected(true);
      reconnectDelayRef.current = WS_RECONNECT_BASE_MS;
    });

    ws.addEventListener('message', (event) => {
      try {
        const msg = JSON.parse(event.data);
        if (msg.type === 'graph:update') {
          onUpdateRef.current?.();
        }
      } catch {}
    });

    ws.addEventListener('close', () => {
      setConnected(false);
      wsRef.current = null;
      if (enabledRef.current) {
        reconnectTimerRef.current = setTimeout(() => {
          reconnectTimerRef.current = null;
          connect();
        }, reconnectDelayRef.current);
        reconnectDelayRef.current = Math.min(WS_RECONNECT_MAX_MS, Math.round(reconnectDelayRef.current * 1.8));
      }
    });

    ws.addEventListener('error', () => {});
  }, [agentId]);

  useEffect(() => {
    if (enabled) connect();
    return () => {
      enabledRef.current = false;
      wsRef.current?.close();
      wsRef.current = null;
      if (reconnectTimerRef.current) {
        clearTimeout(reconnectTimerRef.current);
        reconnectTimerRef.current = null;
      }
    };
  }, [agentId, enabled, connect]);

  return { connected };
}