/**
 * useActivityStream — True SSE-based activity feed for an agent.
 *
 * Connects to GET /api/events/activity/{agentId} which:
 *   1. Backfills recent events from the Redis timeline sorted set
 *   2. Streams live events from pub/sub channels
 *
 * No polling. Events are accumulated in an in-memory array capped at maxEvents.
 */

import { useEffect, useRef, useState, useCallback } from 'react';
import { getAccessToken } from '@/lib/auth';
import { API_BASE } from '@/lib/api';

// ── Types ────────────────────────────────────────────────────────────────────

export type ActivityEventType =
  | 'state_change'
  | 'work_started'
  | 'work_complete'
  | 'work_failed'
  | 'slack_message'
  | 'slack_reply_sent'
  | 'pulse_started'
  | 'pulse_complete'
  | 'tool_install'
  | 'sandbox_reset'
  | 'message_sent'
  | 'message_received'
  | 'session_started'
  | 'session_completed'
  | 'session_failed'
  | 'inbox_received'
  | 'task_claimed'
  | 'task_completed'
  | 'executor_spawned'
  // Meta events from the SSE endpoint
  | 'connected'
  | 'current_state'
  // Lifecycle bridge events
  | 'AGENT_STATE_CHANGED'
  | 'AGENT_WORK_QUEUED'
  | 'AGENT_MESSAGE_RECEIVED'
  | 'AGENT_PULSE_COMPLETED';

export interface ActivityEvent {
  id?: string;
  type: ActivityEventType;
  timestamp: number;
  phase?: 'backfill' | 'live';
  data?: Record<string, any>;
  // Lifecycle event fields
  agentId?: string;
  [key: string]: any;
}

export interface AgentCurrentState {
  state: 'idle' | 'working' | 'thinking';
  lastActive: number | null;
  currentWork: {
    runId: string;
    stepId: string;
    stepType: string;
    startedAt: number;
  } | null;
}

interface UseActivityStreamOptions {
  agentId: string;
  enabled?: boolean;
  maxEvents?: number;
}

interface UseActivityStreamReturn {
  /** Chronological events (oldest first) */
  events: ActivityEvent[];
  /** SSE connection status */
  status: 'connecting' | 'connected' | 'error' | 'closed';
  /** Latest known agent state (backfilled + live updates) */
  currentState: AgentCurrentState | null;
  /** Force reconnect */
  reconnect: () => void;
}

const MAX_EVENTS_DEFAULT = 500;

export function useActivityStream({
  agentId,
  enabled = true,
  maxEvents = MAX_EVENTS_DEFAULT,
}: UseActivityStreamOptions): UseActivityStreamReturn {
  const [events, setEvents] = useState<ActivityEvent[]>([]);
  const [status, setStatus] = useState<UseActivityStreamReturn['status']>('closed');
  const [currentState, setCurrentState] = useState<AgentCurrentState | null>(null);

  const eventSourceRef = useRef<EventSource | null>(null);
  const reconnectCountRef = useRef(0);
  const reconnectTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const connect = useCallback(() => {
    if (!enabled || !agentId) return;

    // Close existing
    if (eventSourceRef.current) {
      eventSourceRef.current.close();
      eventSourceRef.current = null;
    }

    setStatus('connecting');

    try {
      let url = `${API_BASE}/events/activity/${encodeURIComponent(agentId)}`;

      // EventSource doesn't support custom headers — pass token as query param
      const token = getAccessToken();
      if (token) {
        url += `?token=${encodeURIComponent(token)}`;
      }

      const es = new EventSource(url);
      eventSourceRef.current = es;

      es.onopen = () => {
        setStatus('connected');
        reconnectCountRef.current = 0;
      };

      es.onmessage = (event) => {
        try {
          const data: ActivityEvent = JSON.parse(event.data);

          // Handle meta events
          if (data.type === 'connected') {
            setStatus('connected');
            return;
          }

          // Handle current_state backfill
          if (data.type === 'current_state' && data.data) {
            setCurrentState({
              state: data.data.state || 'idle',
              lastActive: data.data.lastActive || null,
              currentWork: data.data.currentWork || null,
            });
            return;
          }

          // Handle lifecycle state change events (live)
          if (data.type === 'AGENT_STATE_CHANGED') {
            setCurrentState((prev) => ({
              state: data.toState || data.data?.toState || prev?.state || 'idle',
              lastActive: data.timestamp || Date.now(),
              currentWork: data.currentWork || data.data?.currentWork || null,
            }));
            // Also add to feed as a normalized event
            const normalized: ActivityEvent = {
              id: `state_${data.timestamp}`,
              type: 'state_change',
              timestamp: data.timestamp || Date.now(),
              phase: 'live',
              data: {
                newState: data.toState || data.data?.toState,
                fromState: data.fromState || data.data?.fromState,
                work: data.currentWork || data.data?.currentWork,
              },
            };
            appendEvent(normalized);
            return;
          }

          // Skip non-content lifecycle bridge events (they just update state)
          if (data.type === 'AGENT_WORK_QUEUED' || data.type === 'AGENT_MESSAGE_RECEIVED' || data.type === 'AGENT_PULSE_COMPLETED') {
            // Refresh current state from the event data if available
            if (data.data?.state) {
              setCurrentState((prev) => ({
                ...(prev || { state: 'idle', lastActive: null, currentWork: null }),
                state: data.data!.state,
                lastActive: data.timestamp || Date.now(),
              }));
            }
            return;
          }

          // Update current state from work events
          if (data.type === 'work_started') {
            setCurrentState({
              state: 'working',
              lastActive: data.timestamp,
              currentWork: data.data ? {
                runId: data.data.runId,
                stepId: data.data.stepId,
                stepType: data.data.stepType,
                startedAt: data.timestamp,
              } : null,
            });
          } else if (data.type === 'work_complete' || data.type === 'work_failed') {
            setCurrentState(() => ({
              state: 'idle',
              lastActive: data.timestamp,
              currentWork: null,
            }));
          } else if (data.type === 'pulse_started') {
            setCurrentState({
              state: 'working',
              lastActive: data.timestamp,
              currentWork: { runId: 'pulse', stepId: 'pulse', stepType: 'pulse', startedAt: data.timestamp },
            });
          } else if (data.type === 'pulse_complete') {
            setCurrentState(() => ({
              state: 'idle',
              lastActive: data.timestamp,
              currentWork: null,
            }));
          }

          // Append to feed
          appendEvent(data);
        } catch {
          // Ignore malformed events
        }
      };

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
  }, [agentId, enabled]);

  const appendEvent = useCallback((event: ActivityEvent) => {
    setEvents((prev) => {
      // Deduplicate by id if present
      if (event.id && prev.some((e) => e.id === event.id)) {
        return prev;
      }
      const next = [...prev, event];
      // Cap at maxEvents
      if (next.length > maxEvents) {
        return next.slice(next.length - maxEvents);
      }
      return next;
    });
  }, [maxEvents]);

  const reconnect = useCallback(() => {
    reconnectCountRef.current = 0;
    setEvents([]);
    setCurrentState(null);
    connect();
  }, [connect]);

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

  // Reset on agent change
  useEffect(() => {
    setEvents([]);
    setCurrentState(null);
  }, [agentId]);

  return { events, status, currentState, reconnect };
}
