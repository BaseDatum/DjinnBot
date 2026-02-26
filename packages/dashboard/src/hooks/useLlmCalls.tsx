/**
 * LlmCallsProvider — single SSE connection for /events/llm-calls.
 *
 * Previously every `SessionTokenStats` and `LlmCallLog` instance opened its
 * own EventSource to the same endpoint.  With N session rows visible, that
 * consumed N+1 browser connections, easily exceeding the HTTP/1.1 per-domain
 * limit of 6.  This starved other SSE connections (e.g. the floating chat
 * widget) causing them to hang in "connecting" state.
 *
 * This provider opens **one** EventSource and fans events out to subscribers
 * via a lightweight pub/sub pattern (callback set, no extra React state).
 */

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
} from 'react';
import { useSSE } from './useSSE';
import { API_BASE } from '@/lib/api';

// ── Types ─────────────────────────────────────────────────────────────────────

/** The shape of an llm_call SSE event (same payload the backend publishes). */
export interface LlmCallEvent {
  type: string;
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
  cost_approximate: boolean;
  duration_ms: number | null;
  tool_call_count: number;
  has_thinking: boolean;
  stop_reason: string | null;
  created_at: number;
}

export type LlmCallListener = (event: LlmCallEvent) => void;

interface LlmCallsContextValue {
  /** Register a listener. Returns an unsubscribe function. */
  subscribe: (listener: LlmCallListener) => () => void;
}

const LlmCallsContext = createContext<LlmCallsContextValue | null>(null);

// ── Provider ──────────────────────────────────────────────────────────────────

export function LlmCallsProvider({ children }: { children: React.ReactNode }) {
  const listenersRef = useRef<Set<LlmCallListener>>(new Set());

  const handleEvent = useCallback((event: any) => {
    if (event?.type !== 'llm_call') return;
    for (const listener of listenersRef.current) {
      try {
        listener(event as LlmCallEvent);
      } catch {
        // Never let a subscriber error break the loop.
      }
    }
  }, []);

  useSSE({
    url: `${API_BASE}/events/llm-calls`,
    onMessage: handleEvent,
  });

  const subscribe = useCallback((listener: LlmCallListener) => {
    listenersRef.current.add(listener);
    return () => {
      listenersRef.current.delete(listener);
    };
  }, []);

  return (
    <LlmCallsContext.Provider value={{ subscribe }}>
      {children}
    </LlmCallsContext.Provider>
  );
}

// ── Hook ──────────────────────────────────────────────────────────────────────

/**
 * Subscribe to LLM call events from the shared SSE connection.
 *
 * @param onEvent  Callback invoked for every `llm_call` event.
 * @param enabled  When false the subscription is paused (default true).
 */
export function useLlmCalls(onEvent: LlmCallListener, enabled = true) {
  const ctx = useContext(LlmCallsContext);
  if (!ctx) throw new Error('useLlmCalls must be used inside LlmCallsProvider');

  // Keep callback ref current without re-subscribing.
  const callbackRef = useRef(onEvent);
  useEffect(() => {
    callbackRef.current = onEvent;
  }, [onEvent]);

  useEffect(() => {
    if (!enabled) return;
    const listener: LlmCallListener = (event) => callbackRef.current(event);
    return ctx.subscribe(listener);
  }, [ctx, enabled]);
}
