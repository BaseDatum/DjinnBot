/**
 * AgentActivity — Live unified activity feed for an agent.
 *
 * Replaces the old polling-based activity page with a true SSE-streamed
 * live feed. Shows: status bar, quick stats, and a chronological event feed.
 */

import { useEffect, useRef, useCallback, useMemo } from 'react';
import { useActivityStream } from '@/hooks/useActivityStream';
import type { ActivityEvent } from '@/hooks/useActivityStream';
import { LiveStatusBar } from './LiveStatusBar';
import { QuickStats } from './QuickStats';
import { FeedItem } from './FeedItem';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Button } from '@/components/ui/button';
import { MessageSquare, Radio, Send, Inbox } from 'lucide-react';

interface AgentActivityProps {
  agentId: string;
}

/** Filter out low-noise state_change events when surrounded by higher-value events */
function filterNoise(events: ActivityEvent[]): ActivityEvent[] {
  return events.filter((event, i) => {
    // Always show non-state-change events
    if (event.type !== 'state_change') return true;

    // Show state_change if it's the only event type
    const hasOtherTypes = events.some((e) => e.type !== 'state_change');
    if (!hasOtherTypes) return true;

    // Show state_change only if it's not immediately followed/preceded by
    // a work_started or work_complete (which already implies the state change)
    const prev = events[i - 1];
    const next = events[i + 1];
    const isRedundant =
      prev?.type === 'work_started' ||
      prev?.type === 'work_complete' ||
      prev?.type === 'work_failed' ||
      prev?.type === 'pulse_started' ||
      prev?.type === 'pulse_complete' ||
      next?.type === 'work_started' ||
      next?.type === 'work_complete' ||
      next?.type === 'work_failed' ||
      next?.type === 'pulse_started' ||
      next?.type === 'pulse_complete';
    return !isRedundant;
  });
}

export function AgentActivity({ agentId }: AgentActivityProps) {
  const { events, status, currentState, reconnect } = useActivityStream({
    agentId,
    enabled: true,
    maxEvents: 500,
  });

  const scrollRef = useRef<HTMLDivElement>(null);
  const sentinelRef = useRef<HTMLDivElement>(null);
  const isAtBottomRef = useRef(true);
  const prevEventCountRef = useRef(0);

  // Track live event IDs for entrance animation
  const liveEventIds = useRef(new Set<string>());

  // Filter noise from timeline
  const filteredEvents = useMemo(() => filterNoise(events), [events]);

  // IntersectionObserver — track if user is at the bottom
  useEffect(() => {
    const sentinel = sentinelRef.current;
    const container = scrollRef.current;
    if (!sentinel || !container) return;

    const viewport =
      container.querySelector<HTMLElement>('[data-radix-scroll-area-viewport]') ?? container;

    const observer = new IntersectionObserver(
      ([entry]) => {
        isAtBottomRef.current = entry.isIntersecting;
      },
      { root: viewport, threshold: 0.1 },
    );
    observer.observe(sentinel);
    return () => observer.disconnect();
  }, []);

  // Auto-scroll to bottom when new events arrive
  const scrollToBottom = useCallback(() => {
    if (!isAtBottomRef.current) return;
    const container = scrollRef.current;
    if (!container) return;
    const viewport =
      container.querySelector<HTMLElement>('[data-radix-scroll-area-viewport]') ?? container;
    viewport.scrollTop = viewport.scrollHeight;
  }, []);

  useEffect(() => {
    if (filteredEvents.length > prevEventCountRef.current) {
      // Mark new live events for animation
      for (let i = prevEventCountRef.current; i < filteredEvents.length; i++) {
        const evt = filteredEvents[i];
        if (evt.phase === 'live' && evt.id) {
          liveEventIds.current.add(evt.id);
        }
      }
      requestAnimationFrame(scrollToBottom);
    }
    prevEventCountRef.current = filteredEvents.length;
  }, [filteredEvents, scrollToBottom]);

  const isEmpty = filteredEvents.length === 0 && status === 'connected';

  return (
    <div className="h-[calc(100vh-220px)] flex flex-col overflow-hidden rounded-lg border border-border/50 bg-card/30">
      {/* Sticky status bar */}
      <LiveStatusBar
        currentState={currentState}
        sseStatus={status}
      />

      {/* Quick stats row */}
      <QuickStats agentId={agentId} />

      {/* Main feed */}
      {isEmpty ? (
        <EmptyState />
      ) : (
        <ScrollArea className="flex-1 min-h-0" ref={scrollRef}>
          <div className="divide-y divide-border/30">
            {filteredEvents.map((event) => (
              <FeedItem
                key={event.id || `${event.type}_${event.timestamp}`}
                event={event}
                isNew={!!event.id && liveEventIds.current.has(event.id)}
              />
            ))}
          </div>

          {/* Reconnect banner */}
          {status === 'error' && (
            <div className="flex items-center justify-center py-3 px-4 bg-red-500/10 border-t border-red-500/20">
              <span className="text-xs text-red-400 mr-2">Connection lost</span>
              <Button size="sm" variant="outline" onClick={reconnect} className="text-xs h-6">
                Reconnect
              </Button>
            </div>
          )}

          {/* Auto-scroll sentinel */}
          <div ref={sentinelRef} className="h-px" />
        </ScrollArea>
      )}
    </div>
  );
}

// ── Empty State ──────────────────────────────────────────────────────────────

function EmptyState() {
  return (
    <div className="flex-1 flex flex-col items-center justify-center px-6 py-12 text-center">
      <div className="flex h-16 w-16 items-center justify-center rounded-2xl bg-muted/50 mb-4">
        <Inbox className="h-8 w-8 text-muted-foreground/50" />
      </div>

      <h3 className="text-lg font-medium text-foreground mb-1">
        No activity yet
      </h3>
      <p className="text-sm text-muted-foreground max-w-sm mb-6">
        Activity will appear here in real-time as this agent processes messages,
        runs tasks, and interacts with the world.
      </p>

      <div className="flex flex-wrap items-center justify-center gap-2">
        <Button variant="outline" size="sm" className="gap-1.5">
          <MessageSquare className="h-3.5 w-3.5" />
          Start a Chat
        </Button>
        <Button variant="outline" size="sm" className="gap-1.5">
          <Send className="h-3.5 w-3.5" />
          Send a Message
        </Button>
        <Button variant="outline" size="sm" className="gap-1.5">
          <Radio className="h-3.5 w-3.5" />
          Trigger Pulse
        </Button>
      </div>
    </div>
  );
}
