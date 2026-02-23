import { useState, useRef } from 'react';
import { cn } from '@/lib/utils';
import { MessagesSquare, Activity, Bot, ChevronRight, X, Loader2 } from 'lucide-react';
import { fetchAgentConfig, fetchPulseRoutines, triggerPulseRoutine } from '@/lib/api';
import type { PulseRoutine } from '@/lib/api';
import { useChatSessions } from '@/components/chat/ChatSessionContext';
import { toast } from 'sonner';

interface Agent {
  id: string;
  name: string;
  emoji: string | null;
  role: string | null;
}

interface DashboardQuickActionsProps {
  agents: Agent[];
}

// Header height inside the strip (32px = min-h-[32px])
const HEADER_H = 32;
// Each agent row height (py-1.5 top+bottom = 12px, text ~20px ≈ 32px)
const ROW_H = 32;

// ─────────────────────────────────────────────────────────────────────────────
// Desktop variant
// ─────────────────────────────────────────────────────────────────────────────
export function DashboardQuickActionsDesktop({ agents }: DashboardQuickActionsProps) {
  const { openChat, setWidgetOpen } = useChatSessions();
  const [chatting, setChatting] = useState<Record<string, boolean>>({});
  const [hoveredIdx, setHoveredIdx] = useState<number | null>(null);
  const [pulseHover, setPulseHover] = useState(false);
  const [routinesCache, setRoutinesCache] = useState<Record<string, PulseRoutine[]>>({});
  const [routinesLoading, setRoutinesLoading] = useState<Record<string, boolean>>({});
  const [triggeringRoutine, setTriggeringRoutine] = useState<Record<string, boolean>>({});
  const clearRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  if (agents.length === 0) return null;

  const schedule = (fn: () => void, ms = 150) => {
    if (clearRef.current) clearTimeout(clearRef.current);
    clearRef.current = setTimeout(fn, ms);
  };
  const cancel = () => {
    if (clearRef.current) clearTimeout(clearRef.current);
  };

  const loadRoutines = async (agentId: string) => {
    if (routinesCache[agentId] || routinesLoading[agentId]) return;
    setRoutinesLoading((l) => ({ ...l, [agentId]: true }));
    try {
      const data = await fetchPulseRoutines(agentId);
      setRoutinesCache((c) => ({ ...c, [agentId]: data.routines }));
    } catch {
      // Silently fail — show empty list
      setRoutinesCache((c) => ({ ...c, [agentId]: [] }));
    } finally {
      setRoutinesLoading((l) => ({ ...l, [agentId]: false }));
    }
  };

  const handleTriggerRoutine = async (agentId: string, routineId: string, routineName: string) => {
    const key = `${agentId}:${routineId}`;
    if (triggeringRoutine[key]) return;
    setTriggeringRoutine((t) => ({ ...t, [key]: true }));
    try {
      await triggerPulseRoutine(agentId, routineId);
      toast.info(`Triggered "${routineName}"`);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : `Failed to trigger "${routineName}"`);
    } finally {
      setTriggeringRoutine((t) => ({ ...t, [key]: false }));
    }
  };

  const handleChat = async (agentId: string) => {
    if (chatting[agentId]) return;
    setChatting((c) => ({ ...c, [agentId]: true }));
    try {
      const config = await fetchAgentConfig(agentId).catch(() => ({ model: '' }));
      const chatModel = (config as { model?: string }).model || '';
      openChat(agentId, chatModel);
      setWidgetOpen(true);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Failed to open chat');
    } finally {
      setChatting((c) => ({ ...c, [agentId]: false }));
    }
  };

  const hoveredAgent = hoveredIdx !== null ? agents[hoveredIdx] : null;

  // top offset for the sub-flyout: skip h-16 logo spacer + HEADER_H toolbar header
  const SUB_FLYOUT_OFFSET = 64 + HEADER_H;

  return (
    /*
     * Outer wrapper: inline flex-col sibling of the nav column, separated by
     * border-l. Expands rightward on hover — never overlaps page content.
     * `relative` is kept so the sub-flyout can use `position: absolute; left: 100%`.
     * `overflow-visible` lets the sub-flyout escape the clipping boundary.
     */
    <div
      className="group relative flex flex-col h-full border-l overflow-visible transition-[max-width] duration-200 ease-in-out max-w-[1.5rem] hover:max-w-xs"
      onMouseLeave={() => { schedule(() => { setHoveredIdx(null); setPulseHover(false); }); }}
    >
      {/* Clipping wrapper — needed so the expanding width clips the content
          without clipping the sub-flyout (which is a sibling below) */}
      <div className="flex flex-col h-full overflow-hidden">
        {/* Spacer — matches the h-16 logo header in the nav column */}
        <div className="h-16 shrink-0 border-b" />

        {/* Toolbar header */}
        <div className="flex items-center border-b px-1.5 shrink-0" style={{ minHeight: HEADER_H }}>
          <Bot className="h-3.5 w-3.5 shrink-0 text-muted-foreground group-hover:hidden" />
          <span className="hidden group-hover:block text-[10px] font-semibold text-muted-foreground whitespace-nowrap">
            Quick Actions
          </span>
        </div>

        {/* Agent rows */}
        <ul className="flex flex-col py-0 overflow-y-auto flex-1">
          {agents.map((agent, i) => (
            <li key={agent.id} style={{ minHeight: ROW_H }}>
              <button
                onMouseEnter={() => { cancel(); setHoveredIdx(i); setPulseHover(false); loadRoutines(agent.id); }}
                onMouseLeave={() => schedule(() => { setHoveredIdx(null); setPulseHover(false); })}
                className={cn(
                  'flex w-full items-center gap-1.5 px-1.5 py-2 transition-colors h-full',
                  hoveredIdx === i
                    ? 'bg-accent text-accent-foreground'
                    : 'hover:bg-accent/50 text-foreground',
                )}
              >
                <span className="text-sm shrink-0 w-4 text-center leading-none">
                  {agent.emoji || '🤖'}
                </span>
                {/* name + chevron rendered always — clipped by overflow-hidden when collapsed */}
                <span className="flex items-center gap-1 whitespace-nowrap">
                  <span className="text-[11px] font-medium">{agent.name}</span>
                  <ChevronRight className="h-2.5 w-2.5 shrink-0 text-muted-foreground" />
                </span>
              </button>
            </li>
          ))}
        </ul>
      </div>

      {/* ── Sub-flyout — outside the overflow:hidden wrapper so it can escape ── */}
      {hoveredAgent && hoveredIdx !== null && (
        <div
          onMouseEnter={() => cancel()}
          onMouseLeave={() => schedule(() => { setHoveredIdx(null); setPulseHover(false); })}
          style={{ top: SUB_FLYOUT_OFFSET + hoveredIdx * ROW_H }}
          className={cn(
            'absolute left-full z-50 ml-1',
            'flex flex-col gap-0.5 p-1.5',
            'rounded-md border bg-popover shadow-lg min-w-[140px]',
          )}
        >
          <div className="px-2 py-1 text-[11px] font-semibold text-muted-foreground border-b mb-0.5 whitespace-nowrap">
            {hoveredAgent.emoji || '🤖'} {hoveredAgent.name}
          </div>
          <button
            onClick={() => handleChat(hoveredAgent.id)}
            disabled={!!chatting[hoveredAgent.id]}
            className="flex items-center gap-2 rounded-sm px-2 py-1.5 text-xs hover:bg-accent hover:text-accent-foreground transition-colors text-left w-full disabled:opacity-50 disabled:cursor-not-allowed"
          >
            <MessagesSquare className={cn('h-3.5 w-3.5 shrink-0', chatting[hoveredAgent.id] && 'animate-pulse')} />
            {chatting[hoveredAgent.id] ? 'Opening…' : 'Chat'}
          </button>
          {/* Pulse Routines — hover to expand sub-flyout */}
          <div
            className="relative"
            onMouseEnter={() => { cancel(); setPulseHover(true); loadRoutines(hoveredAgent.id); }}
            onMouseLeave={() => schedule(() => setPulseHover(false))}
          >
            <button
              className="flex items-center gap-2 rounded-sm px-2 py-1.5 text-xs hover:bg-accent hover:text-accent-foreground transition-colors text-left w-full"
            >
              <Activity className="h-3.5 w-3.5 shrink-0" />
              <span className="flex-1">Pulse</span>
              <ChevronRight className="h-3 w-3 shrink-0 text-muted-foreground" />
            </button>
            {/* Routine sub-flyout */}
            {pulseHover && (
              <div
                onMouseEnter={() => cancel()}
                onMouseLeave={() => schedule(() => setPulseHover(false))}
                className={cn(
                  'absolute left-full top-0 z-50 ml-1',
                  'flex flex-col gap-0.5 p-1.5',
                  'rounded-md border bg-popover shadow-lg min-w-[160px]',
                )}
              >
                <div className="px-2 py-1 text-[10px] font-semibold text-muted-foreground border-b mb-0.5 whitespace-nowrap">
                  Pulse Routines
                </div>
                {routinesLoading[hoveredAgent.id] && (
                  <div className="flex items-center gap-2 px-2 py-1.5 text-xs text-muted-foreground">
                    <Loader2 className="h-3 w-3 animate-spin" />
                    Loading...
                  </div>
                )}
                {!routinesLoading[hoveredAgent.id] && (routinesCache[hoveredAgent.id] || []).length === 0 && (
                  <div className="px-2 py-1.5 text-xs text-muted-foreground">
                    No routines configured
                  </div>
                )}
                {!routinesLoading[hoveredAgent.id] && (routinesCache[hoveredAgent.id] || []).map((routine) => {
                  const key = `${hoveredAgent.id}:${routine.id}`;
                  const triggering = !!triggeringRoutine[key];
                  return (
                    <button
                      key={routine.id}
                      onClick={() => handleTriggerRoutine(hoveredAgent.id, routine.id, routine.name)}
                      disabled={triggering || !routine.enabled}
                      className="flex items-center gap-2 rounded-sm px-2 py-1.5 text-xs hover:bg-accent hover:text-accent-foreground transition-colors text-left w-full disabled:opacity-50 disabled:cursor-not-allowed"
                    >
                      <div
                        className="w-2 h-2 rounded-full shrink-0"
                        style={{ backgroundColor: routine.color || '#6366f1' }}
                      />
                      <span className="flex-1 truncate">{routine.name}</span>
                      {triggering && <Loader2 className="h-3 w-3 animate-spin shrink-0" />}
                      {!routine.enabled && (
                        <span className="text-[10px] text-muted-foreground shrink-0">off</span>
                      )}
                    </button>
                  );
                })}
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Mobile variant — floating button + bottom drawer (rendered directly on the
// dashboard page, not inside the nav drawer)
// ─────────────────────────────────────────────────────────────────────────────
export function DashboardQuickActionsMobile({
  agents,
}: DashboardQuickActionsProps) {
  const { openChat, setWidgetOpen } = useChatSessions();
  const [open, setOpen] = useState(false);
  const [chatting, setChatting] = useState<Record<string, boolean>>({});
  const [expandedPulse, setExpandedPulse] = useState<string | null>(null);
  const [routinesCache, setRoutinesCache] = useState<Record<string, PulseRoutine[]>>({});
  const [routinesLoading, setRoutinesLoading] = useState<Record<string, boolean>>({});
  const [triggeringRoutine, setTriggeringRoutine] = useState<Record<string, boolean>>({});

  if (agents.length === 0) return null;

  const loadRoutines = async (agentId: string) => {
    if (routinesCache[agentId] || routinesLoading[agentId]) return;
    setRoutinesLoading((l) => ({ ...l, [agentId]: true }));
    try {
      const data = await fetchPulseRoutines(agentId);
      setRoutinesCache((c) => ({ ...c, [agentId]: data.routines }));
    } catch {
      setRoutinesCache((c) => ({ ...c, [agentId]: [] }));
    } finally {
      setRoutinesLoading((l) => ({ ...l, [agentId]: false }));
    }
  };

  const handleTriggerRoutine = async (agentId: string, routineId: string, routineName: string) => {
    const key = `${agentId}:${routineId}`;
    if (triggeringRoutine[key]) return;
    setTriggeringRoutine((t) => ({ ...t, [key]: true }));
    try {
      await triggerPulseRoutine(agentId, routineId);
      toast.info(`Triggered "${routineName}"`);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : `Failed to trigger "${routineName}"`);
    } finally {
      setTriggeringRoutine((t) => ({ ...t, [key]: false }));
    }
  };

  const handleChat = async (agentId: string) => {
    if (chatting[agentId]) return;
    setChatting((c) => ({ ...c, [agentId]: true }));
    try {
      const config = await fetchAgentConfig(agentId).catch(() => ({ model: '' }));
      const chatModel = (config as { model?: string }).model || '';
      openChat(agentId, chatModel);
      setWidgetOpen(true);
      setOpen(false);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Failed to open chat');
    } finally {
      setChatting((c) => ({ ...c, [agentId]: false }));
    }
  };

  const togglePulseExpand = (agentId: string) => {
    if (expandedPulse === agentId) {
      setExpandedPulse(null);
    } else {
      setExpandedPulse(agentId);
      loadRoutines(agentId);
    }
  };

  return (
    <>
      {/* Floating trigger button */}
      <button
        onClick={() => setOpen(true)}
        className="fixed bottom-4 left-4 z-40 flex items-center gap-2 rounded-full bg-primary px-4 py-2.5 text-sm font-medium text-primary-foreground shadow-lg md:hidden"
        aria-label="Open agent quick actions"
      >
        <Bot className="h-4 w-4" />
        Agents
      </button>

      {/* Overlay */}
      {open && (
        <div
          className="fixed inset-0 z-40 bg-black/50 md:hidden"
          onClick={() => setOpen(false)}
          aria-hidden
        />
      )}

      {/* Bottom drawer */}
      <div
        className={cn(
          'fixed bottom-0 left-0 right-0 z-50 rounded-t-xl bg-card border-t shadow-xl md:hidden',
          'transition-transform duration-300 ease-in-out',
          open ? 'translate-y-0' : 'translate-y-full',
        )}
        aria-label="Agent quick actions"
      >
        <div className="flex items-center justify-between px-4 py-3 border-b">
          <span className="text-sm font-semibold">Agent Quick Actions</span>
          <button
            onClick={() => setOpen(false)}
            className="rounded-md p-1.5 text-muted-foreground hover:bg-accent"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        <ul className="max-h-72 overflow-y-auto pb-safe pb-4">
          {agents.map((agent) => (
            <li key={agent.id} className="border-b last:border-b-0">
              <div className="flex items-center gap-2 px-4 py-2 text-xs font-semibold text-muted-foreground bg-muted/40">
                <span>{agent.emoji || '🤖'}</span>
                <span className="truncate">{agent.name}</span>
              </div>
              <div className="flex gap-2 px-4 py-2">
                <button
                  onClick={() => handleChat(agent.id)}
                  disabled={!!chatting[agent.id]}
                  className="flex flex-1 items-center justify-center gap-2 rounded-md border px-3 py-2 text-xs font-medium hover:bg-accent hover:text-accent-foreground transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
                >
                  <MessagesSquare className={cn('h-3.5 w-3.5 shrink-0', chatting[agent.id] && 'animate-pulse')} />
                  {chatting[agent.id] ? 'Opening…' : 'Chat'}
                </button>
                <button
                  onClick={() => togglePulseExpand(agent.id)}
                  className={cn(
                    'flex flex-1 items-center justify-center gap-2 rounded-md border px-3 py-2 text-xs font-medium hover:bg-accent hover:text-accent-foreground transition-colors',
                    expandedPulse === agent.id && 'bg-accent text-accent-foreground',
                  )}
                >
                  <Activity className="h-3.5 w-3.5 shrink-0" />
                  Pulse
                  <ChevronRight className={cn('h-3 w-3 transition-transform', expandedPulse === agent.id && 'rotate-90')} />
                </button>
              </div>
              {/* Expanded pulse routines list */}
              {expandedPulse === agent.id && (
                <div className="px-4 pb-2 space-y-1">
                  {routinesLoading[agent.id] && (
                    <div className="flex items-center gap-2 px-3 py-2 text-xs text-muted-foreground">
                      <Loader2 className="h-3 w-3 animate-spin" />
                      Loading routines...
                    </div>
                  )}
                  {!routinesLoading[agent.id] && (routinesCache[agent.id] || []).length === 0 && (
                    <div className="px-3 py-2 text-xs text-muted-foreground">
                      No routines configured
                    </div>
                  )}
                  {!routinesLoading[agent.id] && (routinesCache[agent.id] || []).map((routine) => {
                    const key = `${agent.id}:${routine.id}`;
                    const triggering = !!triggeringRoutine[key];
                    return (
                      <button
                        key={routine.id}
                        onClick={() => handleTriggerRoutine(agent.id, routine.id, routine.name)}
                        disabled={triggering || !routine.enabled}
                        className="flex w-full items-center gap-2 rounded-md border px-3 py-2 text-xs font-medium hover:bg-accent hover:text-accent-foreground transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
                      >
                        <div
                          className="w-2 h-2 rounded-full shrink-0"
                          style={{ backgroundColor: routine.color || '#6366f1' }}
                        />
                        <span className="flex-1 truncate text-left">{routine.name}</span>
                        {triggering && <Loader2 className="h-3 w-3 animate-spin shrink-0" />}
                        {!routine.enabled && (
                          <span className="text-[10px] text-muted-foreground shrink-0">off</span>
                        )}
                      </button>
                    );
                  })}
                </div>
              )}
            </li>
          ))}
        </ul>
      </div>
    </>
  );
}
