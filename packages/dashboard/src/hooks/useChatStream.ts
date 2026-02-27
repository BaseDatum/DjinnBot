/**
 * useChatStream — shared streaming hook for chat UIs.
 *
 * Extracts all common streaming logic previously duplicated between
 * AgentChat and OnboardingChat:
 *   - SSE connection (via useSSE) with reconnect-replay cursor
 *   - Token buffering via requestAnimationFrame (rAF)
 *   - O(1) streaming text accumulation (mutable ref, not array spread)
 *   - Structural event handling (tool_start/end, step_end, turn_end, etc.)
 *   - Auto-scroll with cached viewport ref + bottom-sentinel IntersectionObserver
 *   - DB message expansion (expandDbMessages)
 *
 * Key design decisions to prevent duplication:
 *   1. SSE events are QUEUED until the caller signals history is loaded
 *      (`markHistoryLoaded`). This prevents the race between DB fetch and
 *      SSE events that caused duplicate/overlapping messages.
 *   2. `commitStreaming` finalises ALL streaming placeholders, not just the
 *      last one, preventing orphaned empty messages in multi-step flows.
 *   3. Tool calls are tracked by `toolCallId` so `tool_end` always finds
 *      its matching `tool_start`, even if messages are replaced by a DB refresh.
 *   4. `setMessagesFromDb` merges DB messages with any active streaming state
 *      using ID-based deduplication, so a mid-stream DB refresh never creates
 *      duplicate entries.
 */

import {
  useState,
  useRef,
  useCallback,
  useEffect,
  type RefObject,
} from 'react';
import { useSSE } from './useSSE';
import { API_BASE } from '@/lib/api';
import type { ChatMessageData } from '@/components/chat/ChatMessage';

// ── Types ─────────────────────────────────────────────────────────────────────

export interface StreamingSSEEvent {
  type: string;
  timestamp?: number;
  stream_id?: string;
  data?: {
    thinking?: string;
    toolName?: string;
    toolCallId?: string;
    args?: Record<string, unknown>;
    result?: unknown;
    success?: boolean;
    durationMs?: number;
    content?: string;
    stream?: string;
    /** Status/error message from session_status or session_error events. */
    message?: string;
  };
}

/** Agent identity metadata — attached to streaming placeholder messages so
 *  the UI can render the agent's emoji/name even before the DB refresh. */
export interface AgentMeta {
  agentId?: string;
  agentName?: string;
  agentEmoji?: string;
}

export interface UseChatStreamOptions {
  /** The backend session id to stream from. Empty string disables. */
  sessionId: string;
  /** Whether SSE should be connected. */
  enabled?: boolean;
  /** Called when a turn_end or session_complete event arrives. */
  onTurnEnd?: (success: boolean) => void;
  /** Called when session_complete arrives. */
  onSessionComplete?: () => void;
  /** Called when response_aborted arrives. */
  onResponseAborted?: () => void;
  /** Called when container_ready arrives. */
  onContainerReady?: () => void;
  /** Called when session_error arrives (e.g. image pull failure). */
  onSessionError?: (message: string) => void;
  /** When true, suppress the "Agent is ready" system message on container_ready.
   *  Useful for onboarding where a composing indicator is shown instead. */
  suppressReadyMessage?: boolean;
  /** Current agent identity — stamped onto streaming placeholder messages so
   *  the renderer can show the agent's emoji/name during live streaming. The
   *  value is read from a ref on each event so it can change mid-session
   *  (e.g. onboarding agent handoffs) without recreating the SSE handler. */
  agentMeta?: AgentMeta;
}

export interface UseChatStreamReturn {
  /** The current messages array (updated on structural events only during streaming). */
  messages: ChatMessageData[];
  /** Replace the messages array (e.g. after loading history from DB). */
  setMessages: React.Dispatch<React.SetStateAction<ChatMessageData[]>>;
  /**
   * Replace messages from a DB fetch, intelligently merging with any active
   * streaming state. Preferred over raw `setMessages` after a DB load.
   */
  setMessagesFromDb: (dbMsgs: ChatMessageData[]) => void;
  /** Whether tokens are currently streaming. */
  isStreaming: boolean;
  /** SSE connection status. */
  connectionStatus: 'connecting' | 'connected' | 'error' | 'closed';
  /** Ref to attach to a ScrollArea — auto-scroll is managed automatically. */
  scrollAreaRef: RefObject<HTMLDivElement | null>;
  /** Ref to place as the last child inside the scroll area for auto-scroll sentinel. */
  scrollSentinelRef: RefObject<HTMLDivElement | null>;
  /** The content of the currently-streaming assistant message (updated every rAF). */
  streamingTextRef: RefObject<string>;
  /** The content of the currently-streaming thinking block. */
  streamingThinkingRef: RefObject<string>;
  /** Key that increments on each rAF flush — use to trigger lightweight re-renders. */
  streamingTick: number;
  /** Reset the stream cursor (e.g. after agent handoff). */
  resetStreamCursor: () => void;
  /** Expand DB messages into ChatMessageData[]. */
  expandDbMessages: (dbMessages: DbMessage[]) => ChatMessageData[];
  /**
   * Signal that initial history has been loaded from the DB. Any SSE events
   * that arrived before this call are replayed in order.
   * @param dbMessageIds  Optional set of DB message IDs — replayed structural
   *   events already represented in these IDs will be skipped to prevent
   *   duplicate/reordered messages on page refresh.
   */
  markHistoryLoaded: (dbMessageIds?: Set<string>) => void;
}

export interface DbMessage {
  id: string;
  role: string;
  content: string;
  model?: string | null;
  thinking?: string | null;
  tool_calls?: any[] | null;
  attachments?: string[] | null;
  created_at: number;
  completed_at?: number | null;

  // ── Onboarding-specific fields (present on OnboardingMessage responses) ──
  agent_id?: string | null;
  agent_name?: string | null;
  agent_emoji?: string | null;
  handoff_to_agent?: string | null;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

/**
 * Extract context keys from a handoff system message.
 * The backend appends `[context: key1, key2, ...]` to handoff messages.
 */
function parseContextKeys(content: string): string[] {
  const match = content.match(/\[context:\s*(.+?)\]/);
  if (!match) return [];
  return match[1].split(',').map(k => k.trim()).filter(Boolean);
}

// ── Hook ──────────────────────────────────────────────────────────────────────

let globalMsgIdCounter = 0;
function nextMsgId(prefix: string): string {
  return `${prefix}_${++globalMsgIdCounter}`;
}

export function useChatStream({
  sessionId,
  enabled = true,
  onTurnEnd,
  onSessionComplete,
  onResponseAborted,
  onContainerReady,
  onSessionError,
  suppressReadyMessage = false,
  agentMeta,
}: UseChatStreamOptions): UseChatStreamReturn {
  const [messages, setMessages] = useState<ChatMessageData[]>([]);
  const [isStreaming, setIsStreaming] = useState(false);
  // Lightweight tick counter — incremented every rAF flush so consumers can
  // re-read streamingTextRef / streamingThinkingRef without a heavy state update.
  const [streamingTick, setStreamingTick] = useState(0);

  // ── History-load gate ─────────────────────────────────────────────────────
  // SSE events that arrive before history is loaded are queued and replayed
  // once `markHistoryLoaded()` is called. This eliminates the race between
  // the DB fetch in AgentChat/OnboardingChat and the SSE stream.
  const historyLoadedRef = useRef(false);
  const eventQueueRef = useRef<StreamingSSEEvent[]>([]);

  // ── Mutable streaming accumulators (O(1) per token) ───────────────────────
  // During streaming, text is accumulated in these refs. React state (messages)
  // is only updated for structural events (new message, tool_start, turn_end).
  // The component reads streamingTextRef.current for the live text.
  const streamingTextRef = useRef('');
  const streamingThinkingRef = useRef('');
  // Whether we are currently inside a thinking block vs output block
  const activeBlockRef = useRef<'none' | 'thinking' | 'output'>('none');

  // Track in-flight tool calls by toolCallId → message id for reliable pairing
  const inflightToolsRef = useRef<Map<string, string>>(new Map());

  // Set true when response_aborted is processed. The subsequent turn_end
  // (which the engine often fires after an abort) must NOT trigger onTurnEnd
  // — that would call refreshSession() which replaces local state with DB
  // messages. Since the aborted streaming content was never persisted to the
  // DB, the refresh would wipe the locally-committed partial response.
  const abortedRef = useRef(false);

  // ── rAF batching ──────────────────────────────────────────────────────────
  const rafRef = useRef<number | null>(null);
  const pendingRef = useRef(false);

  const flushTick = useCallback(() => {
    rafRef.current = null;
    pendingRef.current = false;
    // Bump tick so React re-reads the refs (lightweight — no array copying)
    setStreamingTick(t => t + 1);
  }, []);

  const scheduleFlush = useCallback(() => {
    if (!pendingRef.current) {
      pendingRef.current = true;
      rafRef.current = requestAnimationFrame(flushTick);
    }
  }, [flushTick]);

  // Cancel pending rAF on unmount
  useEffect(() => {
    return () => {
      if (rafRef.current !== null) cancelAnimationFrame(rafRef.current);
    };
  }, []);

  // ── Auto-scroll ──────────────────────────────────────────────────────────
  const scrollAreaRef = useRef<HTMLDivElement | null>(null);
  const scrollSentinelRef = useRef<HTMLDivElement | null>(null);
  const viewportRef = useRef<HTMLElement | null>(null);
  const isAtBottomRef = useRef(true);

  // Cache the Radix ScrollArea viewport element once
  useEffect(() => {
    if (scrollAreaRef.current) {
      viewportRef.current =
        scrollAreaRef.current.querySelector<HTMLElement>(
          '[data-radix-scroll-area-viewport]',
        ) ?? null;
    }
  }, [sessionId]); // re-query if session changes (re-mount)

  // IntersectionObserver on the sentinel — tracks whether user is at the bottom
  useEffect(() => {
    const sentinel = scrollSentinelRef.current;
    const viewport = viewportRef.current;
    if (!sentinel || !viewport) return;

    const observer = new IntersectionObserver(
      ([entry]) => {
        isAtBottomRef.current = entry.isIntersecting;
      },
      { root: viewport, threshold: 0.1 },
    );
    observer.observe(sentinel);
    return () => observer.disconnect();
  }, [sessionId]);

  // Scroll-to-bottom helper — called on structural events and tick updates
  const scrollToBottom = useCallback(() => {
    if (!isAtBottomRef.current) return;
    const vp = viewportRef.current;
    if (vp) vp.scrollTop = vp.scrollHeight;
  }, []);

  // Scroll on tick (during streaming) and on messages change (structural)
  useEffect(() => {
    scrollToBottom();
  }, [streamingTick, messages, scrollToBottom]);

  // ── Reconnect cursor ──────────────────────────────────────────────────────
  const lastStreamIdRef = useRef('0-0');
  const resetStreamCursor = useCallback(() => {
    lastStreamIdRef.current = '0-0';
    // Also reset the history gate and event queue so that replayed XRANGE
    // events are properly queued and deduplicated against DB messages when
    // markHistoryLoaded is called again (e.g. after a session restart where
    // the sessionId stays the same).
    historyLoadedRef.current = false;
    eventQueueRef.current = [];
  }, []);

  // ── Stable callback refs for options ──────────────────────────────────────
  const onTurnEndRef = useRef(onTurnEnd);
  const onSessionCompleteRef = useRef(onSessionComplete);
  const onResponseAbortedRef = useRef(onResponseAborted);
  const onContainerReadyRef = useRef(onContainerReady);
  const onSessionErrorRef = useRef(onSessionError);
  const agentMetaRef = useRef(agentMeta);
  useEffect(() => { onTurnEndRef.current = onTurnEnd; }, [onTurnEnd]);
  useEffect(() => { onSessionCompleteRef.current = onSessionComplete; }, [onSessionComplete]);
  useEffect(() => { onResponseAbortedRef.current = onResponseAborted; }, [onResponseAborted]);
  useEffect(() => { onContainerReadyRef.current = onContainerReady; }, [onContainerReady]);
  useEffect(() => { onSessionErrorRef.current = onSessionError; }, [onSessionError]);
  useEffect(() => { agentMetaRef.current = agentMeta; }, [agentMeta]);

  // ── Commit streaming content into messages (called on turn_end, abort, etc.) ──
  const commitStreaming = useCallback(() => {
    // Cancel pending rAF
    if (rafRef.current !== null) {
      cancelAnimationFrame(rafRef.current);
      rafRef.current = null;
      pendingRef.current = false;
    }

    const thinkingText = streamingThinkingRef.current;
    const outputText = streamingTextRef.current;

    // Agent fields for fallback message creation (when no placeholder exists)
    const m = agentMetaRef.current;
    const af = m?.agentId ? { agentId: m.agentId, agentName: m.agentName, agentEmoji: m.agentEmoji } : {};

    setMessages(prev => {
      let next = [...prev];

      // Commit ALL streaming_thinking_ placeholders with accumulated text.
      // In multi-step flows there may be more than one.
      if (thinkingText) {
        let found = false;
        next = next.map(m => {
          if (m.id.startsWith('streaming_thinking_')) {
            found = true;
            return { ...m, id: m.id.replace('streaming_', 'done_'), content: thinkingText };
          }
          return m;
        });
        if (!found) {
          next.push({
            id: `done_thinking_${nextMsgId('t')}`,
            type: 'thinking' as const,
            content: thinkingText,
            timestamp: Date.now(),
            ...af,
          });
        }
      }

      // Commit ALL streaming_output_ placeholders with accumulated text.
      if (outputText) {
        let found = false;
        next = next.map(m => {
          if (m.id.startsWith('streaming_output_')) {
            found = true;
            return { ...m, id: m.id.replace('streaming_', 'done_'), content: outputText };
          }
          return m;
        });
        if (!found) {
          next.push({
            id: `done_output_${nextMsgId('o')}`,
            type: 'assistant' as const,
            content: outputText,
            timestamp: Date.now(),
            ...af,
          });
        }
      }

      // Finalize any remaining streaming_ prefixed messages (e.g. tool_call placeholders)
      return next.map(m =>
        m.id.startsWith('streaming_')
          ? { ...m, id: m.id.replace('streaming_', 'done_') }
          : m,
      );
    });

    // Reset accumulators
    streamingTextRef.current = '';
    streamingThinkingRef.current = '';
    activeBlockRef.current = 'none';
    inflightToolsRef.current.clear();
  }, []);

  // ── Core SSE event handler ────────────────────────────────────────────────
  const processEvent = useCallback(
    (event: StreamingSSEEvent) => {
      if (!event || event.type === 'heartbeat' || event.type === 'connected') return;

      // Track stream cursor for reconnect replay
      if (event.stream_id) {
        lastStreamIdRef.current = event.stream_id;
      }

      const eventData = event.data || {};

      // Helper: current agent identity fields to stamp onto placeholder messages.
      // Read from the ref so callers always get the latest value even after
      // handoffs, without forcing the entire processEvent to be recreated.
      const meta = agentMetaRef.current;
      const agentFields = meta?.agentId ? {
        agentId: meta.agentId,
        agentName: meta.agentName,
        agentEmoji: meta.agentEmoji,
      } : {};

      switch (event.type) {
        // ── High-frequency token events → mutable refs, rAF flush ──────
        case 'thinking': {
          const chunk = eventData.thinking;
          if (!chunk) break;
          setIsStreaming(true);

          // If we were accumulating output, commit it as a done message before
          // switching to thinking. (Rare but possible in multi-step.)
          if (activeBlockRef.current === 'output' && streamingTextRef.current) {
            const text = streamingTextRef.current;
            streamingTextRef.current = '';
            setMessages(prev => {
              // Find and finalize the current streaming output placeholder
              let found = false;
              const next = prev.map(m => {
                if (!found && m.id.startsWith('streaming_output_')) {
                  found = true;
                  return { ...m, id: m.id.replace('streaming_', 'done_'), content: text };
                }
                return m;
              });
              if (!found) {
                next.push({
                  id: `done_output_${nextMsgId('o')}`,
                  type: 'assistant' as const,
                  content: text,
                  timestamp: Date.now(),
                  ...agentFields,
                });
              }
              return next;
            });
          }

          if (activeBlockRef.current !== 'thinking') {
            activeBlockRef.current = 'thinking';
            // Reset thinking accumulator for this new block
            streamingThinkingRef.current = '';
            // Add a placeholder thinking message
            setMessages(prev => [...prev, {
              id: `streaming_thinking_${nextMsgId('t')}`,
              type: 'thinking' as const,
              content: '',
              timestamp: Date.now(),
              ...agentFields,
            }]);
          }

          streamingThinkingRef.current += chunk;
          scheduleFlush();
          break;
        }

        case 'output': {
          const chunk = eventData.content || (eventData as any).stream;
          if (!chunk) break;
          setIsStreaming(true);

          // If we were accumulating thinking, commit it before switching to output
          if (activeBlockRef.current === 'thinking' && streamingThinkingRef.current) {
            const thinkText = streamingThinkingRef.current;
            streamingThinkingRef.current = '';
            setMessages(prev => {
              let found = false;
              const next = prev.map(m => {
                if (!found && m.id.startsWith('streaming_thinking_')) {
                  found = true;
                  return { ...m, id: m.id.replace('streaming_', 'done_'), content: thinkText };
                }
                return m;
              });
              if (!found) {
                next.push({
                  id: `done_thinking_${nextMsgId('t')}`,
                  type: 'thinking' as const,
                  content: thinkText,
                  timestamp: Date.now(),
                  ...agentFields,
                });
              }
              return next;
            });
          }

          if (activeBlockRef.current !== 'output') {
            activeBlockRef.current = 'output';
            // Reset output accumulator for this new block
            streamingTextRef.current = '';
            // Add a placeholder assistant message
            setMessages(prev => [...prev, {
              id: `streaming_output_${nextMsgId('o')}`,
              type: 'assistant' as const,
              content: '',
              timestamp: Date.now(),
              ...agentFields,
            }]);
          }

          streamingTextRef.current += chunk;
          scheduleFlush();
          break;
        }

        // ── Structural events → update messages state directly ──────────
        case 'tool_start': {
          // Commit any in-progress streaming text before the tool call
          if (activeBlockRef.current === 'output' && streamingTextRef.current) {
            const text = streamingTextRef.current;
            streamingTextRef.current = '';
            setMessages(prev => {
              let found = false;
              const next = prev.map(m => {
                if (!found && m.id.startsWith('streaming_output_')) {
                  found = true;
                  return { ...m, id: m.id.replace('streaming_', 'done_'), content: text };
                }
                return m;
              });
              if (!found && text) {
                next.push({
                  id: `done_output_${nextMsgId('o')}`,
                  type: 'assistant' as const,
                  content: text,
                  timestamp: Date.now(),
                  ...agentFields,
                });
              }
              return next;
            });
            activeBlockRef.current = 'none';
          } else if (activeBlockRef.current === 'thinking' && streamingThinkingRef.current) {
            const thinkText = streamingThinkingRef.current;
            streamingThinkingRef.current = '';
            setMessages(prev => {
              let found = false;
              const next = prev.map(m => {
                if (!found && m.id.startsWith('streaming_thinking_')) {
                  found = true;
                  return { ...m, id: m.id.replace('streaming_', 'done_'), content: thinkText };
                }
                return m;
              });
              if (!found && thinkText) {
                next.push({
                  id: `done_thinking_${nextMsgId('t')}`,
                  type: 'thinking' as const,
                  content: thinkText,
                  timestamp: Date.now(),
                  ...agentFields,
                });
              }
              return next;
            });
            activeBlockRef.current = 'none';
          }

          setIsStreaming(true);
          const toolMsgId = `streaming_tool_${nextMsgId('tc')}`;
          const toolCallId = eventData.toolCallId;

          // Track this tool call for reliable tool_end matching
          if (toolCallId) {
            inflightToolsRef.current.set(toolCallId, toolMsgId);
          }

          setMessages(prev => [
            ...prev,
            {
              id: toolMsgId,
              type: 'tool_call' as const,
              toolName: eventData.toolName || 'unknown',
              args: eventData.args,
              timestamp: Date.now(),
              ...agentFields,
            },
          ]);
          break;
        }

        case 'tool_end': {
          const toolCallId = eventData.toolCallId;
          const resultStr =
            typeof eventData.result === 'string'
              ? eventData.result
              : JSON.stringify(eventData.result);

          setMessages(prev => {
            // Strategy 1: Find by tracked toolCallId (most reliable)
            if (toolCallId && inflightToolsRef.current.has(toolCallId)) {
              const targetId = inflightToolsRef.current.get(toolCallId)!;
              inflightToolsRef.current.delete(toolCallId);
              return prev.map(m =>
                m.id === targetId || m.id === targetId.replace('streaming_', 'done_')
                  ? { ...m, result: resultStr, isError: !eventData.success, durationMs: eventData.durationMs }
                  : m,
              );
            }

            // Strategy 2: Fallback — find last tool_call without a result
            for (let i = prev.length - 1; i >= 0; i--) {
              if (prev[i].type === 'tool_call' && !prev[i].result) {
                const updated = [...prev];
                updated[i] = {
                  ...prev[i],
                  result: resultStr,
                  isError: !eventData.success,
                  durationMs: eventData.durationMs,
                };
                return updated;
              }
            }

            // Strategy 3: Tool wasn't found (e.g. DB refresh removed it) — no-op
            return prev;
          });
          break;
        }

        case 'step_end': {
          const stepSuccess = (eventData as any).success;
          const stepResult = (eventData as any).result;
          if (stepSuccess === false && stepResult) {
            // Commit any streaming content, then add error
            commitStreaming();
            setMessages(prev => [
              ...prev,
              {
                id: nextMsgId('error'),
                type: 'error' as const,
                content: stepResult,
                timestamp: Date.now(),
              },
            ]);
          }
          break;
        }

        case 'turn_end': {
          const turnSuccess = event.data?.success;
          commitStreaming();
          setIsStreaming(false);

          // If this turn_end follows a response_aborted, skip calling
          // onTurnEnd. The abort handler already committed the partial
          // streaming content to local state; calling onTurnEnd would
          // trigger refreshSession() which replaces local state with DB
          // messages — and the DB still has the empty assistant placeholder
          // (partial content was never persisted), so the agent's response
          // would vanish.
          if (abortedRef.current) {
            abortedRef.current = false;
            break;
          }

          // If turn failed with no error already shown, add generic error
          if (turnSuccess === false) {
            setMessages(prev => {
              const hasRecentError = prev.slice(-3).some(m => m.type === 'error');
              if (hasRecentError) return prev;
              return [
                ...prev,
                {
                  id: nextMsgId('error'),
                  type: 'error' as const,
                  content:
                    'The agent failed to respond. Check that your model provider is configured correctly in Settings \u2192 Model Providers.',
                  timestamp: Date.now(),
                },
              ];
            });
          }

          onTurnEndRef.current?.(turnSuccess !== false);
          break;
        }

        case 'tts_audio': {
          // TTS audio generated — add a system message with the audio attachment
          const ttsData = event.data as {
            attachmentId: string;
            filename: string;
            mimeType: string;
            sizeBytes: number;
            format: string;
          };
          if (ttsData?.attachmentId) {
            setMessages(prev => [
              ...prev,
              {
                id: nextMsgId('tts'),
                type: 'assistant' as const,
                content: '',
                timestamp: Date.now(),
                ttsAudio: {
                  attachmentId: ttsData.attachmentId,
                  filename: ttsData.filename,
                  mimeType: ttsData.mimeType,
                  sizeBytes: ttsData.sizeBytes,
                  format: ttsData.format,
                },
              },
            ]);
          }
          break;
        }

        case 'session_complete':
          commitStreaming();
          setIsStreaming(false);
          onSessionCompleteRef.current?.();
          break;

        case 'response_aborted': {
          abortedRef.current = true;
          commitStreaming();
          // Append [stopped] to the last assistant message
          setMessages(prev => {
            let lastAssistantId: string | null = null;
            for (let i = prev.length - 1; i >= 0; i--) {
              if (prev[i].type === 'assistant') { lastAssistantId = prev[i].id; break; }
            }
            if (lastAssistantId) {
              const lid = lastAssistantId;
              return [
                ...prev.map(m =>
                  m.id === lid
                    ? { ...m, content: (m.content || '') + ' [stopped]' }
                    : m,
                ),
                {
                  id: nextMsgId('system'),
                  type: 'system' as const,
                  content: 'Response stopped.',
                  timestamp: Date.now(),
                },
              ];
            }
            return [
              ...prev,
              {
                id: nextMsgId('system'),
                type: 'system' as const,
                content: 'Response stopped.',
                timestamp: Date.now(),
              },
            ];
          });
          setIsStreaming(false);
          onResponseAbortedRef.current?.();
          break;
        }

        case 'container_ready':
          onContainerReadyRef.current?.();
          if (!suppressReadyMessage) {
            setMessages(prev => [...prev, {
              id: `system_container_ready_${nextMsgId('cr')}`,
              type: 'system' as const,
              content: 'Agent is ready',
              timestamp: Date.now(),
            }]);
          }
          break;

        case 'session_status':
          // Informational status from the engine (e.g. "Pulling the latest agent runtime...")
          setMessages(prev => [...prev, {
            id: nextMsgId('status'),
            type: 'system' as const,
            content: event.data?.message || 'Session status update',
            timestamp: Date.now(),
          }]);
          break;

        case 'session_error': {
          // Error from the engine (e.g. image pull failure)
          const errorMsg = (event.data?.message as string) || 'An error occurred.';
          setMessages(prev => [...prev, {
            id: nextMsgId('error'),
            type: 'error' as const,
            content: errorMsg,
            timestamp: Date.now(),
          }]);
          setIsStreaming(false);
          onSessionErrorRef.current?.(errorMsg);
          break;
        }

        case 'user_message_update': {
          // Real-time update from the CSM — replaces a user message's content
          // (e.g. voice placeholder → transcript). Matches by messageId from
          // the DB, or falls back to the most recent user message.
          const updateContent = (eventData as any).content;
          const updateMsgId = (eventData as any).messageId;
          if (updateContent) {
            setMessages(prev => {
              // Try to find by DB message ID first
              if (updateMsgId) {
                const idx = prev.findIndex(m => m.id === updateMsgId);
                if (idx >= 0) {
                  const next = [...prev];
                  next[idx] = { ...next[idx], content: updateContent };
                  return next;
                }
              }
              // Fallback: update the most recent user message
              for (let i = prev.length - 1; i >= 0; i--) {
                if (prev[i].type === 'user') {
                  const next = [...prev];
                  next[i] = { ...next[i], content: updateContent };
                  return next;
                }
              }
              return prev;
            });
          }
          break;
        }
      }
    },
    [scheduleFlush, commitStreaming],
  );

  // ── SSE event handler with queue gate ─────────────────────────────────────
  const handleSSEEvent = useCallback(
    (event: StreamingSSEEvent) => {
      if (!historyLoadedRef.current) {
        // Queue the event for replay after history is loaded
        eventQueueRef.current.push(event);
        return;
      }
      processEvent(event);
    },
    [processEvent],
  );

  // ── markHistoryLoaded: replay queued events ───────────────────────────────
  /**
   * @param dbMessageIds  Optional set of message IDs loaded from the DB.
   *   When provided, queued SSE events whose content is already represented
   *   in these messages are skipped — preventing the duplicate/reordered
   *   messages that previously appeared on page refresh.
   */
  const markHistoryLoaded = useCallback((dbMessageIds?: Set<string>) => {
    if (historyLoadedRef.current) return;
    historyLoadedRef.current = true;

    // Replay any events that arrived while we were loading history.
    // Filter out structural replay events (from XRANGE) that the DB already
    // has — these are the events that cause duplication on refresh.
    const queued = eventQueueRef.current;
    eventQueueRef.current = [];

    for (const event of queued) {
      // Always process live events (no stream_id means it came from pub/sub, not XRANGE)
      if (!event.stream_id) {
        processEvent(event);
        continue;
      }

      // When DB messages were loaded, skip ALL XRANGE replay events — the DB
      // is the source of truth for committed content. Previously only structural
      // events were skipped, but output/thinking token replays would duplicate
      // content already in the DB and cause reordering on refresh.
      if (dbMessageIds && dbMessageIds.size > 0) {
        // Update the cursor so subsequent reconnects start from here
        lastStreamIdRef.current = event.stream_id;
        continue;
      }

      processEvent(event);
    }
  }, [processEvent]);

  // ── setMessagesFromDb: merge DB messages with in-flight streaming ─────────
  const setMessagesFromDb = useCallback(
    (dbMsgs: ChatMessageData[]) => {
      setMessages(prev => {
        // Collect any active streaming messages (not yet committed)
        const streamingMsgs = prev.filter(
          m => m.id.startsWith('streaming_') || m.id.startsWith('placeholder_'),
        );

        if (streamingMsgs.length === 0) {
          return dbMsgs;
        }

        // Deduplicate: build a set of DB message IDs; only append streaming
        // messages whose IDs don't collide with anything from the DB.
        const dbIds = new Set(dbMsgs.map(m => m.id));
        const uniqueStreaming = streamingMsgs.filter(m => !dbIds.has(m.id));

        return [...dbMsgs, ...uniqueStreaming];
      });
    },
    [],
  );

  // ── SSE connection ────────────────────────────────────────────────────────
  const sseUrl = sessionId
    ? `${API_BASE}/events/sessions/${sessionId}/events`
    : '';

  const { status: sseStatus } = useSSE<StreamingSSEEvent>({
    url: sseUrl,
    enabled: enabled && !!sessionId,
    onMessage: handleSSEEvent,
    getSinceParam: () => lastStreamIdRef.current,
  });

  const connectionStatus = sseStatus;

  // Reset streaming state when session changes
  useEffect(() => {
    streamingTextRef.current = '';
    streamingThinkingRef.current = '';
    activeBlockRef.current = 'none';
    inflightToolsRef.current.clear();
    abortedRef.current = false;
    historyLoadedRef.current = false;
    eventQueueRef.current = [];
    setIsStreaming(false);
    setStreamingTick(0);
  }, [sessionId]);

  // ── expandDbMessages ──────────────────────────────────────────────────────
  const expandDbMessages = useCallback(
    (dbMessages: DbMessage[]): ChatMessageData[] => {
      const result: ChatMessageData[] = [];
      for (const msg of dbMessages) {
        if (!msg.content && msg.role === 'assistant') continue; // skip empty placeholders

        // ── Handoff messages get their own type ────────────────────────────
        // System messages with handoff_to_agent set are rendered as cinematic
        // transition cards rather than plain system dividers.
        if (msg.role === 'system' && msg.handoff_to_agent) {
          result.push({
            id: msg.id,
            type: 'handoff',
            content: msg.content,
            timestamp: msg.created_at,
            agentId: msg.agent_id || undefined,
            agentName: msg.agent_name || undefined,
            agentEmoji: msg.agent_emoji || undefined,
            handoffTo: msg.handoff_to_agent,
            handoffContextKeys: parseContextKeys(msg.content),
          });
          continue;
        }

        // Use monotonic sub-offsets so expanded sub-messages from the same DB
        // row maintain their logical order when the messages array is sorted
        // by timestamp. Each offset is +1ms which is invisible to the user
        // but keeps thinking → tool_calls → assistant text in the right order.
        let subOffset = 0;

        if (msg.role === 'assistant' && msg.thinking) {
          result.push({
            id: `${msg.id}_thinking`,
            type: 'thinking',
            content: msg.thinking,
            timestamp: msg.created_at + (subOffset++),
            agentId: msg.agent_id || undefined,
            agentName: msg.agent_name || undefined,
            agentEmoji: msg.agent_emoji || undefined,
          });
        }

        if (msg.role === 'assistant' && msg.tool_calls?.length) {
          for (let i = 0; i < msg.tool_calls.length; i++) {
            const tc = msg.tool_calls[i];
            result.push({
              id: `${msg.id}_tool_${i}`,
              type: 'tool_call',
              toolName: tc.toolName || tc.tool_name || 'unknown',
              args: tc.args,
              result: tc.result
                ? typeof tc.result === 'string'
                  ? tc.result
                  : JSON.stringify(tc.result)
                : undefined,
              isError: tc.isError || tc.is_error,
              durationMs: tc.durationMs || tc.duration_ms,
              timestamp: msg.created_at + (subOffset++),
            });
          }
        }

        result.push({
          id: msg.id,
          type:
            msg.role === 'user'
              ? 'user'
              : msg.role === 'assistant'
                ? 'assistant'
                : 'system',
          content: msg.content,
          timestamp: msg.created_at + (subOffset++),
          model: msg.model || undefined,
          attachments: msg.attachments || undefined,
          // Pipe onboarding agent metadata through (no-op for regular chat)
          agentId: msg.agent_id || undefined,
          agentName: msg.agent_name || undefined,
          agentEmoji: msg.agent_emoji || undefined,
        });
      }
      return result;
    },
    [],
  );

  return {
    messages,
    setMessages,
    setMessagesFromDb,
    isStreaming,
    connectionStatus,
    scrollAreaRef,
    scrollSentinelRef,
    streamingTextRef,
    streamingThinkingRef,
    streamingTick,
    resetStreamCursor,
    expandDbMessages,
    markHistoryLoaded,
  };
}
