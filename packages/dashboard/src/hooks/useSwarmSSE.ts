import { useEffect, useRef, useState, useCallback } from 'react';
import { API_BASE } from '@/lib/api';
import { getAccessToken } from '@/lib/auth';

// ── Types ──────────────────────────────────────────────────────────────────

export interface SwarmTask {
  key: string;
  title: string;
  task_id: string;
  project_id: string;
  status: 'pending' | 'ready' | 'running' | 'completed' | 'failed' | 'cancelled' | 'skipped';
  run_id?: string;
  dependencies: string[];
  outputs?: Record<string, string>;
  error?: string;
  started_at?: number;
  completed_at?: number;
}

export interface SwarmState {
  swarm_id: string;
  agent_id: string;
  status: 'running' | 'completed' | 'failed' | 'cancelled' | 'pending';
  tasks: SwarmTask[];
  max_concurrent: number;
  active_count: number;
  completed_count: number;
  failed_count: number;
  total_count: number;
  created_at: number;
  updated_at: number;
}

export interface SwarmProgressEvent {
  type: string;
  swarmId: string;
  taskKey?: string;
  taskTitle?: string;
  runId?: string;
  outputs?: Record<string, string>;
  error?: string;
  reason?: string;
  durationMs?: number;
  summary?: any;
  timestamp: number;
}

// ── Hook ───────────────────────────────────────────────────────────────────

interface UseSwarmSSEOptions {
  swarmId: string;
  enabled?: boolean;
}

interface UseSwarmSSEReturn {
  state: SwarmState | null;
  events: SwarmProgressEvent[];
  connectionStatus: 'connecting' | 'connected' | 'error' | 'closed';
  cancel: () => Promise<void>;
}

export function useSwarmSSE({ swarmId, enabled = true }: UseSwarmSSEOptions): UseSwarmSSEReturn {
  const [state, setState] = useState<SwarmState | null>(null);
  const [events, setEvents] = useState<SwarmProgressEvent[]>([]);
  const [connectionStatus, setConnectionStatus] = useState<UseSwarmSSEReturn['connectionStatus']>('closed');
  const eventSourceRef = useRef<EventSource | null>(null);
  const reconnectTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const reconnectCountRef = useRef(0);

  const connect = useCallback(() => {
    if (!enabled || !swarmId) return;

    if (eventSourceRef.current) {
      eventSourceRef.current.close();
    }

    setConnectionStatus('connecting');

    let url = `${API_BASE}/internal/swarm/${swarmId}/stream`;
    const token = getAccessToken();
    if (token) {
      url += `?token=${encodeURIComponent(token)}`;
    }

    const es = new EventSource(url);
    eventSourceRef.current = es;

    es.onopen = () => {
      setConnectionStatus('connected');
      reconnectCountRef.current = 0;
    };

    // 'state' events carry the full snapshot
    es.addEventListener('state', (event) => {
      try {
        const data = JSON.parse(event.data) as SwarmState;
        setState(data);
      } catch { /* ignore parse errors */ }
    });

    // Default 'message' events carry progress events
    es.onmessage = (event) => {
      try {
        const data = JSON.parse(event.data) as SwarmProgressEvent;
        setEvents(prev => [...prev, data]);

        // Optimistically update local state from progress events
        setState(prev => {
          if (!prev) return prev;
          return applyProgressEvent(prev, data);
        });
      } catch { /* ignore */ }
    };

    es.onerror = () => {
      setConnectionStatus('error');
      es.close();

      // Only reconnect if the swarm is still running
      if (reconnectCountRef.current < 5) {
        reconnectCountRef.current += 1;
        reconnectTimerRef.current = setTimeout(connect, 3000);
      } else {
        setConnectionStatus('closed');
      }
    };
  }, [swarmId, enabled]);

  useEffect(() => {
    connect();
    return () => {
      if (reconnectTimerRef.current) clearTimeout(reconnectTimerRef.current);
      if (eventSourceRef.current) eventSourceRef.current.close();
    };
  }, [connect]);

  // Stop reconnecting once the swarm is terminal
  useEffect(() => {
    if (state && (state.status === 'completed' || state.status === 'failed' || state.status === 'cancelled')) {
      if (reconnectTimerRef.current) {
        clearTimeout(reconnectTimerRef.current);
        reconnectTimerRef.current = null;
      }
      if (eventSourceRef.current) {
        eventSourceRef.current.close();
        eventSourceRef.current = null;
      }
      setConnectionStatus('closed');
    }
  }, [state?.status]);

  const cancel = useCallback(async () => {
    try {
      const token = getAccessToken();
      await fetch(`${API_BASE}/internal/swarm/${swarmId}/cancel`, {
        method: 'POST',
        headers: token ? { Authorization: `Bearer ${token}` } : {},
      });
    } catch (err) {
      console.error('Failed to cancel swarm:', err);
    }
  }, [swarmId]);

  return { state, events, connectionStatus, cancel };
}

// ── Optimistic state updates from progress events ─────────────────────────

function applyProgressEvent(state: SwarmState, event: SwarmProgressEvent): SwarmState {
  const tasks = state.tasks.map(t => {
    if (t.key !== event.taskKey) return t;

    switch (event.type) {
      case 'swarm:task_started':
        return { ...t, status: 'running' as const, run_id: event.runId, started_at: event.timestamp };
      case 'swarm:task_completed':
        return { ...t, status: 'completed' as const, outputs: event.outputs, completed_at: event.timestamp };
      case 'swarm:task_failed':
        return { ...t, status: 'failed' as const, error: event.error, outputs: event.outputs, completed_at: event.timestamp };
      case 'swarm:task_skipped':
        return { ...t, status: 'skipped' as const, error: event.reason, completed_at: event.timestamp };
      default:
        return t;
    }
  });

  const completed_count = tasks.filter(t => t.status === 'completed').length;
  const failed_count = tasks.filter(t => t.status === 'failed').length;
  const active_count = tasks.filter(t => t.status === 'running').length;

  let status = state.status;
  if (event.type === 'swarm:completed') status = 'completed';
  if (event.type === 'swarm:failed') status = 'failed';

  return {
    ...state,
    tasks,
    completed_count,
    failed_count,
    active_count,
    status,
    updated_at: event.timestamp,
  };
}
