import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useSSE } from '@/hooks/useSSE';
import { fetchSession, API_BASE } from '@/lib/api';
import { MarkdownRenderer } from '@/components/MarkdownRenderer';
import { ToolCallCard } from '@/components/ToolCallCard';
import { Loader2, Brain, ChevronDown, ChevronRight, AlertCircle, CheckCircle, Key } from 'lucide-react';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Badge } from '@/components/ui/badge';
import { KeySourceBadge } from '@/components/ui/KeySourceBadge';
import { LlmCallLog } from '@/components/admin/LlmCallLog';
import { useState, useEffect, useRef, useCallback } from 'react';
import type { SessionEvent } from '@/types/session';

interface SessionDetailProps {
  sessionId: string;
}

interface StreamingSSEEvent {
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
  };
}

// ── Consolidated event types ────────────────────────────────────────────────

/**
 * ConsolidatedEvent uses the same timestamp type as SessionEvent (number)
 * to avoid type mismatches when mixing DB events with live events.
 */
interface ConsolidatedEvent {
  id: string;
  event_type: string;
  timestamp: number;
  data: Record<string, unknown>;
}

function consolidateEvents(events: SessionEvent[]): ConsolidatedEvent[] {
  const consolidated: ConsolidatedEvent[] = [];
  let currentThinking: string[] = [];
  let thinkingStartTime: number = 0;
  let currentOutput: string[] = [];
  let outputStartTime: number = 0;

  const flushThinking = () => {
    if (currentThinking.length > 0) {
      consolidated.push({
        id: `thinking_${thinkingStartTime}`,
        event_type: 'thinking',
        timestamp: thinkingStartTime,
        data: { thinking: currentThinking.join('') },
      });
      currentThinking = [];
      thinkingStartTime = 0;
    }
  };

  const flushOutput = () => {
    if (currentOutput.length > 0) {
      consolidated.push({
        id: `output_${outputStartTime}`,
        event_type: 'output_stream',
        timestamp: outputStartTime,
        data: { content: currentOutput.join('') },
      });
      currentOutput = [];
      outputStartTime = 0;
    }
  };

  for (const event of events) {
    if (event.event_type === 'thinking' && event.data.thinking) {
      flushOutput();
      if (currentThinking.length === 0) {
        thinkingStartTime = event.timestamp;
      }
      currentThinking.push(event.data.thinking as string);
    } else if (event.event_type === 'output' && event.data.content) {
      flushThinking();
      if (currentOutput.length === 0) {
        outputStartTime = event.timestamp;
      }
      currentOutput.push(event.data.content as string);
    } else {
      flushThinking();
      flushOutput();
      consolidated.push({
        ...event,
        // Ensure timestamp is always a number
        timestamp: typeof event.timestamp === 'number' ? event.timestamp : Date.now(),
      });
    }
  }

  flushThinking();
  flushOutput();

  return consolidated;
}

// ── Sub-components ──────────────────────────────────────────────────────────

function ThinkingBlock({ content, isStreaming }: { content: string; isStreaming?: boolean }) {
  const [expanded, setExpanded] = useState(false);

  return (
    <div className={`my-2 rounded-md border ${isStreaming ? 'border-purple-400/50 bg-purple-500/10' : 'border-purple-500/30 bg-purple-500/5'}`}>
      <button
        onClick={() => setExpanded(!expanded)}
        className="flex w-full items-center gap-2 px-3 py-2 text-xs text-purple-400 hover:text-purple-300 transition-colors"
      >
        {expanded ? <ChevronDown className="h-3 w-3" /> : <ChevronRight className="h-3 w-3" />}
        <Brain className={`h-3 w-3 ${isStreaming ? 'animate-pulse' : ''}`} />
        <span className="font-medium">Agent Thinking</span>
        {isStreaming && <span className="text-purple-300 animate-pulse">&#9679;</span>}
        {!expanded && (
          <span className="ml-2 truncate text-purple-500/50 max-w-[300px]">
            {content.slice(0, 80)}&hellip;
          </span>
        )}
      </button>
      {expanded && (
        <div className="border-t border-purple-500/20 px-3 py-2 text-xs text-purple-300/80 whitespace-pre-wrap font-mono leading-relaxed max-h-96 overflow-auto break-words">
          {content}
          {isStreaming && <span className="animate-pulse">&#9612;</span>}
        </div>
      )}
    </div>
  );
}

function OutputBlock({ content, isStreaming }: { content: string; isStreaming?: boolean }) {
  return (
    <div className={`my-2 rounded-md border overflow-hidden ${isStreaming ? 'border-green-400/50 bg-green-500/10' : 'border-green-500/30 bg-green-500/5'}`}>
      <div className="px-3 py-2 text-sm text-foreground whitespace-pre-wrap leading-relaxed break-words overflow-x-auto max-w-full">
        {content}
        {isStreaming && <span className="text-green-400 animate-pulse">&#9612;</span>}
      </div>
    </div>
  );
}

function EventItem({ event, isStreaming }: { event: ConsolidatedEvent; isStreaming?: boolean }) {
  if (event.event_type === 'thinking' && event.data.thinking) {
    return <ThinkingBlock content={event.data.thinking as string} isStreaming={isStreaming} />;
  }

  if ((event.event_type === 'output_stream' || event.event_type === 'output') && event.data.content) {
    return <OutputBlock content={event.data.content as string} isStreaming={isStreaming} />;
  }

  if (event.event_type === 'tool_start') {
    return (
      <ToolCallCard
        toolName={event.data.toolName as string}
        args={event.data.args ? JSON.stringify(event.data.args) : undefined}
        status="running"
      />
    );
  }

  if (event.event_type === 'tool_end') {
    const result = event.data.result;
    return (
      <ToolCallCard
        toolName={event.data.toolName as string}
        result={typeof result === 'string' ? result : JSON.stringify(result)}
        isError={!event.data.success}
        durationMs={event.data.durationMs as number | undefined}
        status={event.data.success !== false ? 'complete' : 'error'}
      />
    );
  }

  if (event.event_type === 'tool_call') {
    return (
      <ToolCallCard
        toolName={event.data.tool_name as string}
        args={event.data.args ? JSON.stringify(event.data.args) : undefined}
        result={event.data.result as string | undefined}
        isError={event.data.is_error as boolean | undefined}
        durationMs={event.data.duration_ms as number | undefined}
        status={(event.data.status as 'running' | 'complete' | 'error') || 'complete'}
      />
    );
  }

  return (
    <div className="my-2 px-3 py-2 rounded-md bg-muted/30 border border-border/50 overflow-hidden">
      <div className="flex items-center gap-2 text-xs text-muted-foreground">
        <Badge variant="outline" className="text-xs flex-shrink-0">{event.event_type}</Badge>
        <span className="flex-shrink-0">{new Date(event.timestamp).toLocaleTimeString()}</span>
      </div>
      {event.data && Object.keys(event.data).length > 0 && (
        <pre className="mt-2 text-xs text-muted-foreground overflow-x-auto break-words whitespace-pre-wrap max-w-full">
          {JSON.stringify(event.data, null, 2)}
        </pre>
      )}
    </div>
  );
}

// ── Main component ──────────────────────────────────────────────────────────

export function SessionDetail({ sessionId }: SessionDetailProps) {
  const queryClient = useQueryClient();
  const [isStreaming, setIsStreaming] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);

  // Track whether user has scrolled up so we don't force them to the bottom
  const isAtBottomRef = useRef(true);
  const sentinelRef = useRef<HTMLDivElement>(null);

  // Determine if session is likely still live
  const [assumeLive, setAssumeLive] = useState(true);

  const { data: session, isLoading } = useQuery({
    queryKey: ['session', sessionId],
    queryFn: () => fetchSession(sessionId),
    // Poll slowly as a fallback; SSE handles real-time updates.
    // Disable polling entirely when SSE is connected and streaming.
    refetchInterval: assumeLive && !isStreaming ? 10000 : false,
  });

  // Update assumeLive based on session status
  useEffect(() => {
    if (session) {
      const isStillLive = session.status === 'running' || session.status === 'starting';
      const isRecent = new Date(session.created_at).getTime() > Date.now() - 60000;
      setAssumeLive(isStillLive || isRecent);
    }
  }, [session]);

  // IntersectionObserver — track if user is at the bottom
  useEffect(() => {
    const sentinel = sentinelRef.current;
    const container = scrollRef.current;
    if (!sentinel || !container) return;

    // Try to find the Radix viewport, fall back to the ref itself
    const viewport =
      container.querySelector<HTMLElement>('[data-radix-scroll-area-viewport]') ?? container;

    const observer = new IntersectionObserver(
      ([entry]) => { isAtBottomRef.current = entry.isIntersecting; },
      { root: viewport, threshold: 0.1 },
    );
    observer.observe(sentinel);
    return () => observer.disconnect();
  }, [sessionId]);

  // Auto-scroll to bottom when new events arrive — but only if the user
  // hasn't scrolled up to read earlier content.
  const scrollToBottom = useCallback(() => {
    if (!isAtBottomRef.current) return;
    const container = scrollRef.current;
    if (!container) return;
    const viewport =
      container.querySelector<HTMLElement>('[data-radix-scroll-area-viewport]') ?? container;
    viewport.scrollTop = viewport.scrollHeight;
  }, []);

  // Handle incoming SSE events — consolidate tokens in the queryClient cache
  // directly. No separate `liveEvents` state needed; the cache IS the source
  // of truth for rendering.
  const handleSSEEvent = useCallback((event: StreamingSSEEvent) => {
    if (!event || event.type === 'heartbeat' || event.type === 'connected') return;

    setIsStreaming(true);

    const eventData = event.data || {};

    // Build a SessionEvent-shaped object for the cache
    const sessionEvent: SessionEvent = {
      id: `live_${Date.now()}_${Math.random().toString(36).slice(2)}`,
      event_type: event.type,
      timestamp: event.timestamp || Date.now(),
      data: eventData,
    };

    queryClient.setQueryData(['session', sessionId], (old: any) => {
      if (!old) return old;
      const events: SessionEvent[] = old.events || [];

      // Consolidate consecutive output tokens into a single event
      if (event.type === 'output' && eventData.content && events.length > 0) {
        const lastEvent = events[events.length - 1];
        if (lastEvent.event_type === 'output') {
          const updatedLast = {
            ...lastEvent,
            data: {
              ...lastEvent.data,
              content: ((lastEvent.data.content as string) || '') + eventData.content,
            },
          };
          return { ...old, events: [...events.slice(0, -1), updatedLast] };
        }
      }

      // Consolidate consecutive thinking tokens
      if (event.type === 'thinking' && eventData.thinking && events.length > 0) {
        const lastEvent = events[events.length - 1];
        if (lastEvent.event_type === 'thinking') {
          const updatedLast = {
            ...lastEvent,
            data: {
              ...lastEvent.data,
              thinking: ((lastEvent.data.thinking as string) || '') + eventData.thinking,
            },
          };
          return { ...old, events: [...events.slice(0, -1), updatedLast] };
        }
      }

      // On turn_end / session_complete, stop streaming and trigger a full DB refresh
      if (event.type === 'turn_end' || event.type === 'session_complete') {
        setIsStreaming(false);
        // Invalidate so the next render picks up the full DB state
        queryClient.invalidateQueries({ queryKey: ['session', sessionId] });
      }

      return { ...old, events: [...events, sessionEvent] };
    });

    // Scroll after React processes the cache update
    requestAnimationFrame(scrollToBottom);
  }, [sessionId, queryClient, scrollToBottom]);

  // Subscribe to live event updates for this session
  const { status: sseStatus } = useSSE<StreamingSSEEvent>({
    url: `${API_BASE}/events/sessions/${sessionId}/events`,
    enabled: assumeLive,
    onMessage: handleSSEEvent,
  });

  // Reset streaming state when session completes
  useEffect(() => {
    if (session?.status === 'completed' || session?.status === 'failed') {
      setIsStreaming(false);
    }
  }, [session?.status]);

  if (isLoading) {
    return (
      <div className="flex items-center justify-center py-12">
        <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
      </div>
    );
  }

  if (!session) {
    return (
      <div className="flex items-center justify-center py-12 text-muted-foreground">
        Session not found
      </div>
    );
  }

  // Sort events by timestamp for stable ordering (mirroring the chat's approach),
  // then consolidate consecutive tokens into single blocks for display.
  const allEvents: SessionEvent[] = [...(session.events || [])].sort(
    (a, b) => a.timestamp - b.timestamp,
  );
  const consolidatedEvents = consolidateEvents(allEvents);
  const lastEventType = consolidatedEvents.length > 0
    ? consolidatedEvents[consolidatedEvents.length - 1].event_type
    : null;
  const lastEventIsStreamable = lastEventType === 'thinking' || lastEventType === 'output_stream' || lastEventType === 'output';

  return (
    <div className="border-t border-border/50 bg-muted/20">
      {/* SSE Status indicator */}
      {(session.status === 'running' || session.status === 'starting') && (
        <div className="px-4 py-1 border-b border-border/30 bg-muted/30 flex items-center gap-2 text-xs">
          <span className={`w-2 h-2 rounded-full ${sseStatus === 'connected' ? 'bg-green-400 animate-pulse' : 'bg-yellow-400'}`} />
          <span className="text-muted-foreground">
            {sseStatus === 'connected' ? 'Live streaming' : 'Connecting...'}
          </span>
        </div>
      )}

      <ScrollArea className="h-[400px]" ref={scrollRef}>
        <div className="p-4 space-y-4">
          {/* Key Resolution */}
          {session.key_resolution && (
            <div className="flex items-center gap-2">
              <Key className="h-3.5 w-3.5 text-muted-foreground" />
              <span className="text-xs text-muted-foreground font-medium">Keys:</span>
              <KeySourceBadge keyResolution={session.key_resolution} showProviders showKeyDetails />
            </div>
          )}

          {/* LLM API Calls */}
          <div>
            <h4 className="text-sm font-semibold mb-2 flex items-center gap-2">
              <Key className="h-4 w-4" />
              LLM API Calls
            </h4>
            <LlmCallLog sessionId={sessionId} maxHeight="250px" live={session.status === 'running' || session.status === 'starting'} />
          </div>

          {/* User Prompt */}
          {session.user_prompt && (
            <div>
              <h4 className="text-sm font-semibold mb-2 flex items-center gap-2">
                <Brain className="h-4 w-4" />
                User Prompt
              </h4>
              <div className="p-3 rounded-md bg-background border border-border">
                <p className="text-sm whitespace-pre-wrap">{session.user_prompt}</p>
              </div>
            </div>
          )}

          {/* Events Timeline */}
          {consolidatedEvents.length > 0 && (
            <div>
              <h4 className="text-sm font-semibold mb-2">Events Timeline</h4>
              <div className="space-y-1">
                {consolidatedEvents.map((event, idx) => (
                  <EventItem
                    key={event.id}
                    event={event}
                    isStreaming={isStreaming && idx === consolidatedEvents.length - 1 && lastEventIsStreamable}
                  />
                ))}
              </div>
            </div>
          )}

          {/* Final Output */}
          {session.output && (
            <div>
              <h4 className="text-sm font-semibold mb-2 flex items-center gap-2">
                <CheckCircle className="h-4 w-4 text-green-400" />
                Output
              </h4>
              <div className="p-3 rounded-md bg-background border border-border">
                <MarkdownRenderer content={session.output} />
              </div>
            </div>
          )}

          {/* Error */}
          {session.error && (
            <div>
              <h4 className="text-sm font-semibold mb-2 flex items-center gap-2 text-red-400">
                <AlertCircle className="h-4 w-4" />
                Error
              </h4>
              <div className="p-3 rounded-md bg-red-500/10 border border-red-500/30">
                <pre className="text-sm text-red-300 whitespace-pre-wrap">{session.error}</pre>
              </div>
            </div>
          )}

          {/* Auto-scroll sentinel */}
          <div ref={sentinelRef} className="h-px" />
        </div>
      </ScrollArea>
    </div>
  );
}
