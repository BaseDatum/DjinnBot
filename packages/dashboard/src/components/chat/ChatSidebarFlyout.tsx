/**
 * ChatSidebarFlyout
 *
 * Desktop: a collapsed strip anchored at `left: 100%` of the main sidebar
 * (same pattern as ProjectSidebarFlyout / DashboardQuickActionsDesktop).
 * Hovering expands it. Contains: agent picker → model picker → session picker
 * → "Open chat" action, plus a list of open sessions to switch/close.
 *
 * Mobile: a floating pill at bottom-left that opens a bottom drawer
 * (same pattern as DashboardQuickActionsMobile / NestedSidebar mobile).
 * Rendered separately so Sidebar can place it inside the mobile drawer.
 */

import { useEffect, useRef, useState } from 'react';
import { cn } from '@/lib/utils';
import {
  MessagesSquare,
  MessageSquarePlus,
  X,
  ChevronDown,
  Loader2,
} from 'lucide-react';
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
import { useChatSessions } from './ChatSessionContext';
import { listChatSessions, startChatSession, getChatSession } from '@/lib/api';
import { DEFAULT_CHAT_MODEL } from '@/lib/constants';

// ── Types ─────────────────────────────────────────────────────────────────────

interface ExistingSession {
  id: string;
  status: string;
  model: string;
  created_at: number;
  message_count: number;
}

// ── Last-used model persistence (per agent) ─────────────────────────────────
//
// Model override localStorage persistence has been removed.
// New sessions always use the agent's configured default model.
// Mid-session hot-swap only affects the current session.

// ── Shared hook: toolbar form state ──────────────────────────────────────────

function useSpawnForm() {
  const { agents, openChat, panes, closePane } = useChatSessions();
  const [agentId, setAgentId] = useState('');
  const [model, setModel] = useState(DEFAULT_CHAT_MODEL);
  const [thinkingLevel, setThinkingLevel] = useState<string>('off');
  const [sessionChoice, setSessionChoice] = useState('__new__');
  const [existingSessions, setExistingSessions] = useState<ExistingSession[]>([]);
  const [loadingSessions, setLoadingSessions] = useState(false);
  const [spawning, setSpawning] = useState(false);

  // When agent changes, auto-populate model from agent's configured default
  useEffect(() => {
    if (!agentId) { setExistingSessions([]); setSessionChoice('__new__'); return; }
    const agent = agents.find(a => a.id === agentId);
    if (agent?.model) {
      setModel(agent.model);
    }
    setLoadingSessions(true);
    listChatSessions(agentId, { limit: 10 })
      .then(data => {
        setExistingSessions(data.sessions);
        // Always default to "New session" — never auto-select a running session.
        // The user must explicitly choose to resume an existing session from the list.
        // This prevents opening the same session ID in multiple panes.
        setSessionChoice('__new__');
      })
      .catch(() => { setExistingSessions([]); setSessionChoice('__new__'); })
      .finally(() => setLoadingSessions(false));
  }, [agentId, agents]);

  const handleOpen = async (onDone?: () => void) => {
    if (!agentId || spawning) return;
    setSpawning(true);
    try {
      let sessionId: string;
      let resolvedModel = model;
      if (sessionChoice === '__new__') {
        const result = await startChatSession(agentId, model, undefined, thinkingLevel);
        sessionId = result.sessionId;
      } else {
        const session = await getChatSession(sessionChoice);
        sessionId = session.id;
        resolvedModel = session.model || model;
      }
      openChat(agentId, resolvedModel, sessionId);
      setAgentId('');
      setSessionChoice('__new__');
      setExistingSessions([]);
      onDone?.();
    } catch (err) {
      console.error('Failed to open chat:', err);
    } finally {
      setSpawning(false);
    }
  };

  return {
    agents,
    panes,
    closePane,
    agentId, setAgentId,
    model, setModel,
    thinkingLevel, setThinkingLevel,
    sessionChoice, setSessionChoice,
    existingSessions,
    loadingSessions,
    spawning,
    handleOpen,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Desktop flyout (position: absolute, left: 100% of sidebar)
// ─────────────────────────────────────────────────────────────────────────────

const ROW_H = 32;

export function ChatSidebarFlyoutDesktop() {
  const form = useSpawnForm();
  const clearRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [expanded, setExpanded] = useState(false);
  // Track how many dropdowns are currently open. SelectContent / PopoverContent
  // render in a portal (outside this div), so mouseleave fires when the user
  // moves into a dropdown. We suppress collapse while any dropdown is open.
  const openDropdownsRef = useRef(0);
  const lockRef = useRef(false);

  const schedule = (fn: () => void, ms = 120) => {
    if (clearRef.current) clearTimeout(clearRef.current);
    clearRef.current = setTimeout(fn, ms);
  };
  const cancel = () => { if (clearRef.current) clearTimeout(clearRef.current); };

  const onDropdownOpenChange = (open: boolean) => {
    openDropdownsRef.current = open
      ? openDropdownsRef.current + 1
      : Math.max(0, openDropdownsRef.current - 1);
    lockRef.current = openDropdownsRef.current > 0;
    if (open) cancel(); // prevent any pending collapse when a dropdown opens
  };

  const collapse = () => {
    // Reset any stuck dropdown lock state and schedule collapse
    openDropdownsRef.current = 0;
    lockRef.current = false;
    schedule(() => setExpanded(false), 300);
  };

  const activePanes = form.panes.filter(p => p.sessionStatus === 'running' || p.sessionStatus === 'starting');

  return (
    <div
      className={cn(
        'flex flex-col h-full border-l overflow-hidden',
        'transition-[max-width] duration-200 ease-in-out',
        expanded ? 'max-w-xs' : 'max-w-[1.5rem]',
      )}
      onMouseEnter={() => { cancel(); setExpanded(true); }}
      onMouseLeave={() => { if (!lockRef.current) schedule(() => setExpanded(false)); }}
    >
      {/* Spacer — matches the h-16 logo header in the nav column */}
      <div className="h-16 shrink-0 border-b" />

      {/* Toolbar header */}
      <div className="flex items-center border-b px-1.5 shrink-0" style={{ minHeight: ROW_H }}>
        <MessagesSquare className={cn('h-3.5 w-3.5 shrink-0 text-muted-foreground', expanded && 'hidden')} />
        {expanded && (
          <span className="text-[10px] font-semibold text-muted-foreground whitespace-nowrap">
            Chat Sessions
          </span>
        )}
        {expanded && form.panes.length > 0 && (
          <Badge variant="secondary" className="ml-auto text-[10px] h-4 px-1">
            {form.panes.length}
          </Badge>
        )}
      </div>

      {/* Content — only rendered when expanded to avoid layout flash */}
      {expanded && (
        <div className="flex flex-col flex-1 overflow-y-auto overflow-x-hidden min-w-[220px]">
          {/* ── New chat form ── */}
          <div className="flex flex-col gap-1.5 p-2 border-b">
            <span className="text-[10px] font-semibold text-muted-foreground px-0.5">New chat</span>

            {/* Agent */}
            <Select value={form.agentId} onValueChange={form.setAgentId} onOpenChange={onDropdownOpenChange}>
              <SelectTrigger className="h-7 text-xs w-full">
                <SelectValue placeholder="Choose agent…" />
              </SelectTrigger>
              <SelectContent>
                {form.agents.map(a => (
                  <SelectItem key={a.id} value={a.id}>
                    {a.emoji || '🤖'} {a.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>

            {/* Model */}
            <ModelSelector
              value={form.model}
              onChange={form.setModel}
              thinkingLevel={form.thinkingLevel as any}
              onThinkingLevelChange={(l) => form.setThinkingLevel(l)}
              onOpenChange={onDropdownOpenChange}
              className="h-7 text-xs w-full"
            />

            {/* Session picker — only shown when agent is selected */}
            {form.agentId && (
              form.loadingSessions ? (
                <div className="flex items-center gap-1.5 text-xs text-muted-foreground px-1 h-7">
                  <Loader2 className="h-3 w-3 animate-spin" />
                  Loading sessions…
                </div>
              ) : (
                <Select value={form.sessionChoice} onValueChange={form.setSessionChoice} onOpenChange={onDropdownOpenChange}>
                  <SelectTrigger className="h-7 text-xs w-full">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="__new__">
                      <span className="flex items-center gap-1.5">
                        <MessageSquarePlus className="h-3 w-3" />
                        New session
                      </span>
                    </SelectItem>
                    {form.existingSessions.length > 0 && (
                      <SelectGroup>
                        {form.existingSessions.map(s => (
                          <SelectItem key={s.id} value={s.id}>
                            <span className="flex items-center gap-1.5 text-xs">
                              <span className={cn(
                                'h-1.5 w-1.5 rounded-full shrink-0',
                                s.status === 'running' || s.status === 'ready' ? 'bg-green-500' : 'bg-muted-foreground/40',
                              )} />
                              {new Date(s.created_at).toLocaleDateString(undefined, {
                                month: 'short', day: 'numeric',
                                hour: '2-digit', minute: '2-digit',
                              })}
                              <span className="text-muted-foreground">·{s.message_count}</span>
                            </span>
                          </SelectItem>
                        ))}
                      </SelectGroup>
                    )}
                  </SelectContent>
                </Select>
              )
            )}

            {/* Open button */}
            <button
              disabled={!form.agentId || form.spawning}
              onClick={() => form.handleOpen(collapse)}
              className={cn(
                'flex items-center justify-center gap-1.5 w-full h-7 rounded-md text-xs font-medium transition-colors',
                'bg-primary text-primary-foreground hover:bg-primary/90',
                'disabled:opacity-50 disabled:cursor-not-allowed',
              )}
            >
              {form.spawning ? (
                <Loader2 className="h-3 w-3 animate-spin" />
              ) : (
                <MessageSquarePlus className="h-3 w-3" />
              )}
              Open chat
            </button>
          </div>

          {/* ── Open sessions list ── */}
          {form.panes.length > 0 && (
            <div className="flex flex-col">
              <span className="text-[10px] font-semibold text-muted-foreground px-2.5 pt-2 pb-1">
                Open sessions
              </span>
              {form.panes.map(pane => (
                <div
                  key={pane.paneId}
                  className="flex items-center gap-1.5 px-2 py-1.5 hover:bg-accent/50 group/row"
                >
                  <span className="text-sm shrink-0">{pane.agentEmoji || '🤖'}</span>
                  <span className="flex-1 text-xs font-medium truncate min-w-0">{pane.agentName}</span>
                  <span className={cn(
                    'h-1.5 w-1.5 rounded-full shrink-0',
                    pane.sessionStatus === 'running' ? 'bg-green-500' :
                      pane.sessionStatus === 'starting' ? 'bg-yellow-400 animate-pulse' :
                        'bg-muted-foreground/30',
                  )} />
                  <button
                    onClick={() => form.closePane(pane.paneId)}
                    className="opacity-0 group-hover/row:opacity-100 transition-opacity text-muted-foreground hover:text-destructive p-0.5 rounded"
                    title="End and close"
                  >
                    <X className="h-3 w-3" />
                  </button>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {/* Collapsed state: show session count dot */}
      {!expanded && activePanes.length > 0 && (
        <div className="flex justify-center pt-1">
          <span className="h-1.5 w-1.5 rounded-full bg-green-500 animate-pulse" />
        </div>
      )}
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Mobile variant — bottom drawer triggered by floating pill (bottom-left)
// Rendered inside the mobile Sidebar drawer (like ProjectSidebarFlyoutMobile)
// ─────────────────────────────────────────────────────────────────────────────

export function ChatSidebarFlyoutMobile({ onClose }: { onClose?: () => void }) {
  const form = useSpawnForm();
  const [sectionOpen, setSectionOpen] = useState(false);

  const handleOpen = async () => {
    await form.handleOpen(onClose);
  };

  return (
    <div className="border-t">
      {/* Section toggle row */}
      <button
        onClick={() => setSectionOpen(o => !o)}
        className="flex w-full items-center gap-3 px-4 py-3 text-sm font-medium text-muted-foreground hover:bg-accent hover:text-accent-foreground transition-colors"
      >
        <MessagesSquare className="h-4 w-4 shrink-0" />
        <span className="flex-1 text-left">Chat Sessions</span>
        {form.panes.length > 0 && (
          <Badge variant="secondary" className="text-[10px] h-4 px-1.5">
            {form.panes.length}
          </Badge>
        )}
        <ChevronDown className={cn('h-3.5 w-3.5 transition-transform', sectionOpen && 'rotate-180')} />
      </button>

      {sectionOpen && (
        <div className="pb-3 flex flex-col gap-2 px-4">
          {/* Open sessions */}
          {form.panes.length > 0 && (
            <div className="flex flex-col gap-0.5 mb-1">
              <span className="text-xs text-muted-foreground font-semibold mb-1">Open sessions</span>
              {form.panes.map(pane => (
                <div key={pane.paneId} className="flex items-center gap-2 rounded-md px-2 py-1.5 bg-muted/40">
                  <span className="text-base">{pane.agentEmoji || '🤖'}</span>
                  <span className="flex-1 text-xs font-medium truncate">{pane.agentName}</span>
                  <span className={cn(
                    'h-1.5 w-1.5 rounded-full shrink-0',
                    pane.sessionStatus === 'running' ? 'bg-green-500' :
                      pane.sessionStatus === 'starting' ? 'bg-yellow-400 animate-pulse' : 'bg-muted-foreground/30',
                  )} />
                  <button
                    onClick={() => form.closePane(pane.paneId)}
                    className="text-muted-foreground hover:text-destructive p-1 rounded transition-colors"
                    title="End and close"
                  >
                    <X className="h-3.5 w-3.5" />
                  </button>
                </div>
              ))}
            </div>
          )}

          <div className="border-t pt-2 flex flex-col gap-2">
            <span className="text-xs text-muted-foreground font-semibold">Start new chat</span>

            {/* Agent */}
            <Select value={form.agentId} onValueChange={form.setAgentId}>
              <SelectTrigger className="h-9 text-sm w-full">
                <SelectValue placeholder="Choose agent…" />
              </SelectTrigger>
              <SelectContent>
                {form.agents.map(a => (
                  <SelectItem key={a.id} value={a.id}>
                    {a.emoji || '🤖'} {a.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>

            {/* Model */}
            <ModelSelector value={form.model} onChange={form.setModel} thinkingLevel={form.thinkingLevel as any} onThinkingLevelChange={(l) => form.setThinkingLevel(l)} className="h-9 text-sm w-full" />

            {/* Session choice */}
            {form.agentId && (
              form.loadingSessions ? (
                <div className="flex items-center gap-2 text-sm text-muted-foreground h-9 px-1">
                  <Loader2 className="h-4 w-4 animate-spin" />
                  Loading previous sessions…
                </div>
              ) : (
                <Select value={form.sessionChoice} onValueChange={form.setSessionChoice}>
                  <SelectTrigger className="h-9 text-sm w-full">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="__new__">
                      <span className="flex items-center gap-2">
                        <MessageSquarePlus className="h-4 w-4" />
                        New session
                      </span>
                    </SelectItem>
                    {form.existingSessions.length > 0 && (
                      <SelectGroup>
                        {form.existingSessions.map(s => (
                          <SelectItem key={s.id} value={s.id}>
                            <span className="flex items-center gap-2">
                              <span className={cn(
                                'h-2 w-2 rounded-full shrink-0',
                                s.status === 'running' || s.status === 'ready' ? 'bg-green-500' : 'bg-muted-foreground/40',
                              )} />
                              {new Date(s.created_at).toLocaleDateString(undefined, {
                                month: 'short', day: 'numeric',
                                hour: '2-digit', minute: '2-digit',
                              })}
                              <Badge variant="outline" className="text-[10px] h-4 px-1">
                                {s.message_count}
                              </Badge>
                            </span>
                          </SelectItem>
                        ))}
                      </SelectGroup>
                    )}
                  </SelectContent>
                </Select>
              )
            )}

            <button
              disabled={!form.agentId || form.spawning}
              onClick={handleOpen}
              className={cn(
                'flex items-center justify-center gap-2 w-full h-10 rounded-md text-sm font-medium transition-colors',
                'bg-primary text-primary-foreground hover:bg-primary/90',
                'disabled:opacity-50 disabled:cursor-not-allowed',
              )}
            >
              {form.spawning ? (
                <><Loader2 className="h-4 w-4 animate-spin" />Opening…</>
              ) : (
                <><MessageSquarePlus className="h-4 w-4" />Open chat</>
              )}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Mobile floating pill (rendered in __root, not inside the sidebar drawer)
// Separate from the FAB in FloatingChatWidget — this one is specifically for
// the /chat page on mobile and sits bottom-left (mirroring NestedSidebar).
// ─────────────────────────────────────────────────────────────────────────────

export function ChatMobilePill() {
  const { panes, closePane } = useChatSessions();
  const [open, setOpen] = useState(false);
  const form = useSpawnForm();

  const activeCount = panes.length;

  return (
    <>
      {/* Floating pill — bottom-left */}
      <button
        onClick={() => setOpen(true)}
        className="fixed bottom-4 left-4 z-40 flex items-center gap-2 rounded-full bg-primary px-4 py-2.5 text-sm font-medium text-primary-foreground shadow-lg md:hidden"
        aria-label="Open chat sessions"
      >
        <MessagesSquare className="h-4 w-4" />
        <span>Chat</span>
        {activeCount > 0 && (
          <span className="flex h-5 min-w-5 items-center justify-center rounded-full bg-primary-foreground/20 text-xs px-1 tabular-nums">
            {activeCount}
          </span>
        )}
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
          'fixed bottom-0 left-0 right-0 z-50 rounded-t-2xl bg-card border-t shadow-2xl md:hidden',
          'transition-transform duration-300 ease-out',
          open ? 'translate-y-0' : 'translate-y-full',
        )}
        aria-label="Chat sessions"
      >
        {/* Handle */}
        <div className="flex justify-center pt-2 pb-1">
          <div className="h-1 w-10 rounded-full bg-muted-foreground/30" />
        </div>

        <div className="flex items-center justify-between px-4 py-2 border-b">
          <span className="text-sm font-semibold flex items-center gap-2">
            <MessagesSquare className="h-4 w-4 text-primary" />
            Chat Sessions
          </span>
          <button
            onClick={() => setOpen(false)}
            className="rounded-md p-1.5 text-muted-foreground hover:bg-accent"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className="overflow-y-auto max-h-[70vh] pb-8">
          {/* Open sessions */}
          {panes.length > 0 && (
            <div className="px-4 pt-3 pb-2 flex flex-col gap-2">
              <span className="text-xs font-semibold text-muted-foreground">Open sessions</span>
              {panes.map(pane => (
                <div key={pane.paneId} className="flex items-center gap-3 rounded-lg border px-3 py-2.5 bg-background">
                  <span className="text-lg">{pane.agentEmoji || '🤖'}</span>
                  <div className="flex-1 min-w-0">
                    <p className="text-sm font-medium truncate">{pane.agentName}</p>
                    <p className="text-xs text-muted-foreground font-mono truncate">{pane.model.split('/').pop()}</p>
                  </div>
                  <span className={cn(
                    'h-2 w-2 rounded-full shrink-0',
                    pane.sessionStatus === 'running' ? 'bg-green-500' :
                      pane.sessionStatus === 'starting' ? 'bg-yellow-400 animate-pulse' : 'bg-muted-foreground/30',
                  )} />
                  <button
                    onClick={() => { closePane(pane.paneId); }}
                    className="p-1.5 text-muted-foreground hover:text-destructive rounded-md hover:bg-destructive/10 transition-colors"
                    title="End and close"
                  >
                    <X className="h-4 w-4" />
                  </button>
                </div>
              ))}
            </div>
          )}

          {/* New chat form */}
          <div className={cn('px-4 flex flex-col gap-2', panes.length > 0 ? 'pt-1 pb-3 border-t' : 'pt-3 pb-3')}>
            <span className="text-xs font-semibold text-muted-foreground">
              {panes.length > 0 ? 'Start another' : 'Start a chat'}
            </span>

            <Select value={form.agentId} onValueChange={form.setAgentId}>
              <SelectTrigger className="h-11 text-sm w-full">
                <SelectValue placeholder="Choose agent…" />
              </SelectTrigger>
              <SelectContent>
                {form.agents.map(a => (
                  <SelectItem key={a.id} value={a.id}>
                    {a.emoji || '🤖'} {a.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>

            <ModelSelector value={form.model} onChange={form.setModel} thinkingLevel={form.thinkingLevel as any} onThinkingLevelChange={(l) => form.setThinkingLevel(l)} className="h-11 text-sm w-full" />

            {form.agentId && (
              form.loadingSessions ? (
                <div className="flex items-center gap-2 text-sm text-muted-foreground h-11 px-1">
                  <Loader2 className="h-4 w-4 animate-spin" />
                  Loading previous sessions…
                </div>
              ) : (
                <Select value={form.sessionChoice} onValueChange={form.setSessionChoice}>
                  <SelectTrigger className="h-11 text-sm w-full">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="__new__">
                      <span className="flex items-center gap-2">
                        <MessageSquarePlus className="h-4 w-4" />
                        New session
                      </span>
                    </SelectItem>
                    {form.existingSessions.length > 0 && (
                      <SelectGroup>
                        {form.existingSessions.map(s => (
                          <SelectItem key={s.id} value={s.id}>
                            <span className="flex items-center gap-2">
                              <span className={cn(
                                'h-2 w-2 rounded-full shrink-0',
                                s.status === 'running' || s.status === 'ready' ? 'bg-green-500' : 'bg-muted-foreground/40',
                              )} />
                              {new Date(s.created_at).toLocaleDateString(undefined, {
                                month: 'short', day: 'numeric',
                                hour: '2-digit', minute: '2-digit',
                              })}
                              <Badge variant="outline" className="text-[10px] h-4 px-1">
                                {s.message_count}
                              </Badge>
                            </span>
                          </SelectItem>
                        ))}
                      </SelectGroup>
                    )}
                  </SelectContent>
                </Select>
              )
            )}

            <button
              disabled={!form.agentId || form.spawning}
              onClick={() => form.handleOpen(() => setOpen(false))}
              className={cn(
                'flex items-center justify-center gap-2 w-full h-12 rounded-xl text-base font-semibold transition-colors',
                'bg-primary text-primary-foreground hover:bg-primary/90',
                'disabled:opacity-50 disabled:cursor-not-allowed',
              )}
            >
              {form.spawning ? (
                <><Loader2 className="h-5 w-5 animate-spin" />Opening…</>
              ) : (
                <><MessageSquarePlus className="h-5 w-5" />Open chat</>
              )}
            </button>
          </div>
        </div>
      </div>
    </>
  );
}
