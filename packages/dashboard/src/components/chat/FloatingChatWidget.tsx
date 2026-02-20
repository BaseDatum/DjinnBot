/**
 * FloatingChatWidget
 *
 * A globally-accessible overlay that lets users chat with their agents from
 * any page in the dashboard.
 *
 * Design:
 *  • A pill FAB (Floating Action Button) anchored to the bottom-right corner.
 *  • Clicking it opens a side-drawer overlay (non-modal — page stays interactive).
 *  • The drawer has its own mini toolbar (agent + model + session picker) and
 *    renders the currently "focused" session as a full AgentChat pane.
 *  • A tab row at the top of the drawer shows all open sessions; clicking a tab
 *    switches the active pane.
 *  • Closing a tab ends its session.
 *  • Sessions opened here are the *same* sessions tracked in ChatSessionContext
 *    so they also appear in the main /chat page.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useRouterState } from '@tanstack/react-router';
import {
  MessageSquare,
  MessageSquarePlus,
  X,
  ChevronDown,
  Loader2,
  ExternalLink,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Badge } from '@/components/ui/badge';
import { ModelSelector } from './ModelSelector';
import { AgentChat } from './AgentChat';
import { useChatSessions } from './ChatSessionContext';
import { listChatSessions, startChatSession, getChatSession } from '@/lib/api';
import { DEFAULT_CHAT_MODEL } from '@/lib/constants';
import { formatModelChip } from '@/lib/format';
import { Link } from '@tanstack/react-router';

// ── Types ─────────────────────────────────────────────────────────────────────

interface ExistingSession {
  id: string;
  status: string;
  model: string;
  created_at: number;
  message_count: number;
}

// ── Constants ─────────────────────────────────────────────────────────────────

/** localStorage key used to persist the FAB's dragged position. */
const FAB_POSITION_KEY = 'chat-fab-position';
/** localStorage key used to persist the drawer's custom size. */
const DRAWER_SIZE_KEY = 'chat-drawer-size';

const DEFAULT_DRAWER_W = 420;
const DEFAULT_DRAWER_H = 600;

// ── Component ─────────────────────────────────────────────────────────────────

export function FloatingChatWidget() {
  const { location } = useRouterState();
  const isChatPage = location.pathname === '/chat';

  const {
    panes,
    agents,
    openChat,
    closePane,
    widgetOpen,
    setWidgetOpen,
  } = useChatSessions();

  const [activePaneId, setActivePaneId] = useState<string | null>(null);

  // Toolbar state
  const [spawnAgentId, setSpawnAgentId] = useState('');
  const [spawnModel, setSpawnModel] = useState(DEFAULT_CHAT_MODEL);
  const [spawnThinkingLevel, setSpawnThinkingLevel] = useState<string>('off');
  const [spawnSessionId, setSpawnSessionId] = useState<string>('__new__');
  const [existingSessions, setExistingSessions] = useState<ExistingSession[]>([]);
  const [loadingSessions, setLoadingSessions] = useState(false);
  const [spawning, setSpawning] = useState(false);
  const [showNewForm, setShowNewForm] = useState(false);

  const drawerRef = useRef<HTMLDivElement>(null);

  // ── Drawer resize (desktop only) ───────────────────────────────────────────

  const [drawerSize, setDrawerSize] = useState<{ w: number; h: number }>(() => {
    try {
      const raw = localStorage.getItem(DRAWER_SIZE_KEY);
      if (!raw) return { w: DEFAULT_DRAWER_W, h: DEFAULT_DRAWER_H };
      const parsed = JSON.parse(raw);
      if (typeof parsed.w === 'number' && typeof parsed.h === 'number') return parsed;
    } catch {}
    return { w: DEFAULT_DRAWER_W, h: DEFAULT_DRAWER_H };
  });

  const drawerSizeRef = useRef(drawerSize);
  drawerSizeRef.current = drawerSize;

  // Which edge is being resized: 'top', 'left', or 'top-left' corner, null = not resizing
  const resizeEdgeRef = useRef<'top' | 'left' | 'top-left' | null>(null);
  const resizeStartRef = useRef<{ mouseX: number; mouseY: number; w: number; h: number } | null>(null);
  const [isResizing, setIsResizing] = useState(false);

  useEffect(() => {
    const onMouseMove = (e: MouseEvent) => {
      if (!resizeEdgeRef.current || !resizeStartRef.current) return;
      const dx = e.clientX - resizeStartRef.current.mouseX;
      const dy = e.clientY - resizeStartRef.current.mouseY;
      const edge = resizeEdgeRef.current;

      let newW = resizeStartRef.current.w;
      let newH = resizeStartRef.current.h;

      if (edge === 'left' || edge === 'top-left') {
        // Dragging left handle leftward increases width
        newW = Math.max(320, Math.min(window.innerWidth - 32, resizeStartRef.current.w - dx));
      }
      if (edge === 'top' || edge === 'top-left') {
        // Dragging top handle upward increases height
        newH = Math.max(300, Math.min(window.innerHeight - 32, resizeStartRef.current.h - dy));
      }

      drawerSizeRef.current = { w: newW, h: newH };
      setDrawerSize({ w: newW, h: newH });
    };

    const onMouseUp = () => {
      if (!resizeEdgeRef.current) return;
      resizeEdgeRef.current = null;
      resizeStartRef.current = null;
      setIsResizing(false);
      try {
        localStorage.setItem(DRAWER_SIZE_KEY, JSON.stringify(drawerSizeRef.current));
      } catch {}
    };

    window.addEventListener('mousemove', onMouseMove);
    window.addEventListener('mouseup', onMouseUp);
    return () => {
      window.removeEventListener('mousemove', onMouseMove);
      window.removeEventListener('mouseup', onMouseUp);
    };
  }, []);

  const startResize = useCallback((e: React.MouseEvent, edge: 'top' | 'left' | 'top-left') => {
    e.preventDefault();
    e.stopPropagation();
    resizeEdgeRef.current = edge;
    resizeStartRef.current = {
      mouseX: e.clientX,
      mouseY: e.clientY,
      w: drawerSizeRef.current.w,
      h: drawerSizeRef.current.h,
    };
    setIsResizing(true);
  }, []);

  // ── FAB drag-to-reposition (desktop only) ─────────────────────────────────

  // Position is stored as { x, y } from the top-left of the viewport.
  // null = use default CSS position (bottom-right corner).
  const [fabPos, setFabPos] = useState<{ x: number; y: number } | null>(() => {
    // Lazy initializer — runs once on mount, reads localStorage synchronously.
    try {
      const raw = localStorage.getItem(FAB_POSITION_KEY);
      if (!raw) return null;
      const parsed = JSON.parse(raw);
      if (typeof parsed.x === 'number' && typeof parsed.y === 'number') return parsed;
    } catch {}
    return null;
  });

  // Ref mirrors fabPos so event handlers always read the latest value without stale closures
  const fabPosRef = useRef<{ x: number; y: number } | null>(fabPos);
  fabPosRef.current = fabPos;
  const [isDragging, setIsDragging] = useState(false);

  const fabRef = useRef<HTMLButtonElement>(null);
  // dragStartRef tracks the initial mouse + FAB coordinates for the current drag gesture
  const dragStartRef = useRef<{ mouseX: number; mouseY: number; fabX: number; fabY: number } | null>(null);
  // isDraggingRef lets the global mousemove/mouseup handlers know a drag is in progress
  // without depending on React state (avoids stale-closure issues)
  const isDraggingRef = useRef(false);
  const didDragRef = useRef(false);

  // Clamp a position so the FAB stays fully within the viewport.
  const clamp = useCallback((x: number, y: number): { x: number; y: number } => {
    const el = fabRef.current;
    const w = el ? el.offsetWidth : 44;
    const h = el ? el.offsetHeight : 44;
    return {
      x: Math.max(0, Math.min(window.innerWidth - w, x)),
      y: Math.max(0, Math.min(window.innerHeight - h, y)),
    };
  }, []);

  // Attach global mouse listeners once on mount so they are always active during a drag.
  // This avoids the previous bug where the useEffect only ran after isDragging became true
  // (which required a 500 ms long-press), meaning quick drags never saved their position.
  useEffect(() => {
    const onMouseMove = (e: MouseEvent) => {
      if (!isDraggingRef.current || !dragStartRef.current) return;
      const dx = e.clientX - dragStartRef.current.mouseX;
      const dy = e.clientY - dragStartRef.current.mouseY;
      // Only count as a genuine drag after > 4 px of movement
      if (Math.abs(dx) > 4 || Math.abs(dy) > 4) didDragRef.current = true;
      if (!didDragRef.current) return;
      const next = clamp(dragStartRef.current.fabX + dx, dragStartRef.current.fabY + dy);
      fabPosRef.current = next;
      setFabPos(next);
      setIsDragging(true);
    };

    const onMouseUp = () => {
      if (!isDraggingRef.current) return;
      isDraggingRef.current = false;
      dragStartRef.current = null;
      setIsDragging(false);
      // Persist the final position to localStorage whenever a drag ends.
      // Use the ref so we always have the latest value regardless of render cycle.
      const latestPos = fabPosRef.current;
      if (latestPos && didDragRef.current) {
        try { localStorage.setItem(FAB_POSITION_KEY, JSON.stringify(latestPos)); } catch {}
      }
    };

    window.addEventListener('mousemove', onMouseMove);
    window.addEventListener('mouseup', onMouseUp);
    return () => {
      window.removeEventListener('mousemove', onMouseMove);
      window.removeEventListener('mouseup', onMouseUp);
    };
  }, [clamp]);

  const handleFabMouseDown = useCallback((e: React.MouseEvent<HTMLButtonElement>) => {
    // Desktop only — ignore if touch or right-click
    if (e.button !== 0) return;
    e.preventDefault(); // prevent text selection during drag

    const fabRect = fabRef.current?.getBoundingClientRect();
    const fabX = fabRect ? fabRect.left : window.innerWidth - 120;
    const fabY = fabRect ? fabRect.top : window.innerHeight - 60;

    dragStartRef.current = { mouseX: e.clientX, mouseY: e.clientY, fabX, fabY };
    isDraggingRef.current = true;
    didDragRef.current = false;
  }, []);

  const handleFabMouseUp = useCallback(() => {
    // Handled by the global onMouseUp above; nothing extra needed here.
  }, []);

  // When panes change, default to the most recent one
  useEffect(() => {
    if (panes.length === 0) {
      setActivePaneId(null);
    } else if (!activePaneId || !panes.find(p => p.paneId === activePaneId)) {
      setActivePaneId(panes[panes.length - 1].paneId);
    }
  }, [panes, activePaneId]);

  // Show unread badge
  const activeCount = panes.length;

  // Load sessions when agent is selected
  useEffect(() => {
    if (!spawnAgentId) {
      setExistingSessions([]);
      setSpawnSessionId('__new__');
      return;
    }
    setLoadingSessions(true);
    listChatSessions(spawnAgentId, { limit: 10 })
      .then(data => {
        setExistingSessions(data.sessions);
        const active = data.sessions.find(
          s => s.status === 'running' || (s.status as string) === 'ready',
        );
        setSpawnSessionId(active ? active.id : '__new__');
      })
      .catch(() => { setExistingSessions([]); setSpawnSessionId('__new__'); })
      .finally(() => setLoadingSessions(false));
  }, [spawnAgentId]);

  const handleOpenChat = async () => {
    if (!spawnAgentId || spawning) return;
    setSpawning(true);
    try {
      let sessionId: string;
      let model = spawnModel;
      if (spawnSessionId === '__new__') {
        const result = await startChatSession(spawnAgentId, spawnModel);
        sessionId = result.sessionId;
      } else {
        const session = await getChatSession(spawnSessionId);
        sessionId = session.id;
        model = session.model || spawnModel;
      }
      openChat(spawnAgentId, model, sessionId);
      setSpawnAgentId('');
      setSpawnSessionId('__new__');
      setExistingSessions([]);
      setShowNewForm(false);
    } catch (err) {
      console.error('Failed to open chat:', err);
    } finally {
      setSpawning(false);
    }
  };

  const activePane = panes.find(p => p.paneId === activePaneId) ?? null;

  // ── Drawer position relative to FAB (desktop only) ────────────────────────

  const GAP = 8; // px gap between FAB and drawer

  /**
   * When the FAB has been dragged to a custom position, compute where the
   * drawer should open so it stays adjacent to the button and within the
   * viewport.
   *
   * Strategy:
   *  - Vertical axis: open below the FAB if there is enough room, otherwise above.
   *  - Horizontal axis: left-align the drawer with the FAB; if that would clip
   *    the right edge, right-align instead.
   */
  const drawerStyle = (): React.CSSProperties => {
    if (!fabPos) return {}; // mobile / default — CSS classes handle it

    const fabEl = fabRef.current;
    const fabH = fabEl ? fabEl.offsetHeight : 44;
    const fabW = fabEl ? fabEl.offsetWidth : 120;

    const spaceBelow = window.innerHeight - (fabPos.y + fabH);
    const spaceAbove = fabPos.y;

    let top: number | 'auto' = 'auto';
    let bottom: number | 'auto' = 'auto';

    const dW = drawerSize.w;
    const dH = drawerSize.h;

    if (spaceBelow >= dH + GAP || spaceBelow >= spaceAbove) {
      // Open below
      top = fabPos.y + fabH + GAP;
    } else {
      // Open above
      bottom = window.innerHeight - fabPos.y + GAP;
    }

    // Horizontal: try to align left edge of drawer with left edge of FAB,
    // then clamp so drawer doesn't overflow either side.
    let left = fabPos.x;
    // If FAB is in the right half, right-align instead for a cleaner look
    if (fabPos.x + fabW / 2 > window.innerWidth / 2) {
      left = fabPos.x + fabW - dW;
    }
    left = Math.max(8, Math.min(window.innerWidth - dW - 8, left));

    return {
      position: 'fixed',
      width: dW,
      top: top !== 'auto' ? top : 'auto',
      bottom: bottom !== 'auto' ? bottom : 'auto',
      left,
      right: 'auto',
      maxHeight: Math.min(dH, window.innerHeight - 16),
      height: Math.min(dH, window.innerHeight - 16),
    };
  };

  // ── Render ─────────────────────────────────────────────────────────────────

  const widget = (
    <>
      {/* FAB — hidden on /chat page where the sidebar flyout handles everything */}
      {/* On desktop, position is driven by fabPos (drag state); on mobile use fixed CSS. */}
      <button
        ref={fabRef}
        className={[
          'fixed z-50',
          'flex items-center gap-2 h-11 px-4 rounded-full shadow-lg',
          'bg-primary text-primary-foreground font-medium text-sm',
          // Only apply hover/active scale when not dragging
          isDragging ? 'cursor-grabbing shadow-2xl scale-105' : 'transition-all hover:scale-105 hover:shadow-xl active:scale-95',
          // Default position (bottom-right) — only used when fabPos is null or on mobile
          !fabPos ? 'bottom-[calc(1.25rem+env(safe-area-inset-bottom,0px))] right-5' : '',
          // Hide on /chat — the sidebar flyout + ChatMobilePill handle that page
          isChatPage ? 'hidden' : '',
          // On mobile, always snap back to default corner (ignore fabPos)
          'sm:[position:fixed]',
        ].join(' ')}
        style={fabPos ? {
          // Desktop: use explicit top/left from drag state; hide bottom/right defaults
          top: fabPos.y,
          left: fabPos.x,
          bottom: 'auto',
          right: 'auto',
        } : undefined}
        onMouseDown={handleFabMouseDown}
        onMouseUp={handleFabMouseUp}
        onClick={() => {
          // Suppress click if the interaction was a drag
          if (didDragRef.current) { didDragRef.current = false; return; }
          setWidgetOpen(!widgetOpen);
        }}
        aria-label="Open chat"
      >
        {widgetOpen ? (
          <ChevronDown className="h-4 w-4" />
        ) : (
          <MessageSquare className="h-4 w-4" />
        )}
        <span>Chat</span>
        {activeCount > 0 && (
          <span className="flex h-5 min-w-5 items-center justify-center rounded-full bg-primary-foreground/20 text-xs px-1.5 tabular-nums">
            {activeCount}
          </span>
        )}
      </button>

      {/* Drawer — full-screen bottom sheet on mobile, floating card on desktop */}
      {/* Also hidden on /chat to prevent overlap with the workspace */}
      {widgetOpen && !isChatPage && (
        <div
          className={[
            'fixed z-50 flex flex-col',
            'border border-border shadow-2xl bg-card overflow-hidden',
            // Mobile: full-width bottom sheet
            'left-0 right-0 bottom-0 rounded-t-2xl border-t border-x',
            // Desktop: floating card with rounded corners — position overridden by drawerStyle()
            fabPos
              ? 'sm:rounded-xl'
              : 'sm:left-auto sm:right-5 sm:bottom-20 sm:rounded-xl',
            // Prevent text selection while resizing
            isResizing ? 'select-none' : '',
          ].join(' ')}
          style={fabPos ? drawerStyle() : {
            // Width and height apply on desktop; on mobile left-0/right-0 override
            // width to be full-viewport, and height is overridden by maxHeight below.
            width: drawerSize.w,
            // Mobile: cap with dvh expressions; desktop: use persisted height
            height: `min(${drawerSize.h}px, calc(100dvh - 5rem))`,
            maxHeight: `min(${drawerSize.h}px, 85dvh)`,
          }}
          ref={drawerRef}
        >
          {/* Desktop-only resize handles — hidden on mobile */}
          {/* Top edge: resize height */}
          <div
            className="absolute top-0 left-4 right-4 h-1.5 cursor-ns-resize hidden sm:block z-10 group"
            onMouseDown={e => startResize(e, 'top')}
          >
            <div className="absolute inset-x-0 top-0 h-1 rounded-full opacity-0 group-hover:opacity-100 bg-primary/40 transition-opacity" />
          </div>
          {/* Left edge: resize width */}
          <div
            className="absolute top-4 bottom-4 left-0 w-1.5 cursor-ew-resize hidden sm:block z-10 group"
            onMouseDown={e => startResize(e, 'left')}
          >
            <div className="absolute inset-y-0 left-0 w-1 rounded-full opacity-0 group-hover:opacity-100 bg-primary/40 transition-opacity" />
          </div>
          {/* Top-left corner: resize both */}
          <div
            className="absolute top-0 left-0 h-4 w-4 cursor-nwse-resize hidden sm:block z-20"
            onMouseDown={e => startResize(e, 'top-left')}
          />

          {/* Drag handle — visible on mobile only */}
          <div className="flex justify-center pt-2 pb-0.5 sm:hidden shrink-0">
            <div className="h-1 w-10 rounded-full bg-muted-foreground/25" />
          </div>

          {/* Drawer header */}
          <div className="flex items-center gap-2 px-3 py-2 border-b bg-card shrink-0">
            <MessageSquare className="h-4 w-4 text-primary" />
            <span className="font-semibold text-sm flex-1">Chat Sessions</span>

            {/* Link to full chat page */}
            <Link to="/chat" className="text-muted-foreground hover:text-foreground transition-colors" title="Open full chat page">
              <ExternalLink className="h-3.5 w-3.5" />
            </Link>

            {/* New session button */}
            <button
              className="flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground transition-colors px-1.5 py-1 rounded hover:bg-accent"
              onClick={() => setShowNewForm(f => !f)}
              title="Start new chat"
            >
              <MessageSquarePlus className="h-3.5 w-3.5" />
              New
            </button>

            {/* Close widget */}
            <button
              className="text-muted-foreground hover:text-foreground transition-colors p-1 rounded hover:bg-accent"
              onClick={() => setWidgetOpen(false)}
              aria-label="Close chat widget"
            >
              <X className="h-3.5 w-3.5" />
            </button>
          </div>

          {/* New chat form (collapsible) */}
          {showNewForm && (
            <div className="flex flex-col gap-2 px-3 py-2.5 border-b bg-muted/20 shrink-0">
              <div className="flex gap-2">
                <Select value={spawnAgentId} onValueChange={setSpawnAgentId}>
                  <SelectTrigger className="h-8 text-xs flex-1">
                    <SelectValue placeholder="Agent…" />
                  </SelectTrigger>
                  <SelectContent>
                    {agents.map(a => (
                      <SelectItem key={a.id} value={a.id}>
                        {a.emoji || '🤖'} {a.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>

                <ModelSelector
                  value={spawnModel}
                  onChange={setSpawnModel}
                  thinkingLevel={spawnThinkingLevel as any}
                  onThinkingLevelChange={(l) => setSpawnThinkingLevel(l)}
                  className="h-8 text-xs w-[140px]"
                />
              </div>

              {spawnAgentId && (
                <div className="flex gap-2 items-center">
                  {loadingSessions ? (
                    <div className="flex-1 flex items-center gap-1 text-xs text-muted-foreground">
                      <Loader2 className="h-3 w-3 animate-spin" />
                      Loading…
                    </div>
                  ) : (
                    <Select value={spawnSessionId} onValueChange={setSpawnSessionId}>
                      <SelectTrigger className="h-8 text-xs flex-1">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="__new__">
                          <span className="flex items-center gap-1">
                            <MessageSquarePlus className="h-3 w-3" />
                            New session
                          </span>
                        </SelectItem>
                        {existingSessions.length > 0 && (
                          <SelectGroup>
                            {existingSessions.map(s => (
                              <SelectItem key={s.id} value={s.id}>
                                <span className="flex items-center gap-1.5 text-xs">
                                  <span className={`h-1.5 w-1.5 rounded-full shrink-0 ${s.status === 'running' || s.status === 'ready' ? 'bg-green-500' : 'bg-muted-foreground/40'}`} />
                                  {new Date(s.created_at * 1000).toLocaleDateString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })}
                                  <Badge variant="outline" className="text-[9px] h-3.5 px-1">{s.message_count}</Badge>
                                </span>
                              </SelectItem>
                            ))}
                          </SelectGroup>
                        )}
                      </SelectContent>
                    </Select>
                  )}

                  <Button
                    size="sm"
                    className="h-8 px-3 text-xs shrink-0"
                    disabled={!spawnAgentId || spawning}
                    onClick={handleOpenChat}
                  >
                    {spawning ? <Loader2 className="h-3 w-3 animate-spin" /> : 'Open'}
                  </Button>
                </div>
              )}
            </div>
          )}

          {/* Session tabs */}
          {panes.length > 0 && (
            <div className="flex gap-1 px-2 py-1.5 border-b overflow-x-auto scrollbar-hide shrink-0 bg-muted/10">
              {panes.map(pane => (
                <button
                  key={pane.paneId}
                  onClick={() => setActivePaneId(pane.paneId)}
                  className={`flex items-center gap-1.5 px-2.5 py-1 rounded-md text-xs font-medium whitespace-nowrap transition-colors shrink-0 ${
                    pane.paneId === activePaneId
                      ? 'bg-primary text-primary-foreground'
                      : 'text-muted-foreground hover:text-foreground hover:bg-accent'
                  }`}
                >
                  <span>{pane.agentEmoji || '🤖'}</span>
                  <span className="max-w-[80px] truncate">{pane.agentName}</span>
                  <StatusDot status={pane.sessionStatus} />
                  <button
                    className="ml-0.5 rounded hover:bg-black/10 p-0.5 transition-colors"
                    onClick={e => {
                      e.stopPropagation();
                      closePane(pane.paneId);
                    }}
                    title="End and close"
                    aria-label={`Close chat with ${pane.agentName}`}
                  >
                    <X className="h-2.5 w-2.5" />
                  </button>
                </button>
              ))}
            </div>
          )}

          {/* Active pane model info bar */}
          {activePane && (
            <div className="flex items-center gap-1.5 px-3 py-1 border-b bg-muted/10 shrink-0">
              <span className="text-[10px] text-muted-foreground">
                {formatModelChip(activePane.model)}
              </span>
            </div>
          )}

          {/* Chat pane body */}
          <div className="flex-1 min-h-0 overflow-hidden">
            {panes.length === 0 ? (
              <div className="flex flex-col items-center justify-center h-full gap-3 text-muted-foreground">
                <MessageSquare className="h-10 w-10 opacity-20" />
                <p className="text-sm font-medium">No open sessions</p>
                <button
                  className="text-xs text-primary hover:underline"
                  onClick={() => setShowNewForm(true)}
                >
                  Start one
                </button>
              </div>
            ) : activePane && activePane.sessionId ? (
              <AgentChat
                key={activePane.paneId}
                agentId={activePane.agentId}
                agentName={activePane.agentName}
                agentEmoji={activePane.agentEmoji}
                sessionId={activePane.sessionId}
                initialSessionStatus={activePane.sessionStatus}
              />
            ) : activePane ? (
              <div className="flex flex-col items-center justify-center h-full gap-2 text-muted-foreground">
                <Loader2 className="h-5 w-5 animate-spin" />
                <span className="text-sm">Starting session…</span>
              </div>
            ) : null}
          </div>
        </div>
      )}
    </>
  );

  // Render into a portal so it floats above all page content
  return createPortal(widget, document.body);
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function StatusDot({ status }: { status: string }) {
  const color =
    status === 'running'
      ? 'bg-green-500'
      : status === 'starting'
        ? 'bg-yellow-400 animate-pulse'
        : status === 'stopping'
          ? 'bg-red-400 animate-pulse'
          : 'bg-muted-foreground/30';

  return <span className={`h-1.5 w-1.5 rounded-full shrink-0 ${color}`} />;
}
