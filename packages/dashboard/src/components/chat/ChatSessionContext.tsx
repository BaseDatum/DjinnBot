/**
 * ChatSessionContext
 *
 * Provides a global store of open chat panes so both the main ChatWorkspace
 * and the FloatingChatWidget share the same live sessions.  Any component
 * can open, close, or focus a chat pane without prop-drilling.
 */
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
} from 'react';
import { fetchAgents, listChatSessions, endChatSession, startChatSession, restartChatSession, getChatSessionStatus, type AgentListItem } from '@/lib/api';

// ── Types ─────────────────────────────────────────────────────────────────────

export type SessionStatus = 'idle' | 'starting' | 'running' | 'stopping';

export interface ChatPane {
  /** Stable UI identifier (not the backend session id) */
  paneId: string;
  agentId: string;
  agentName: string;
  agentEmoji: string | null;
  model: string;
  /** Backend session id — null while the session is being started */
  sessionId: string | null;
  sessionStatus: SessionStatus;
  /** Whether this pane is currently "visible" in the tiled layout */
  visible: boolean;
  /** Key resolution info — which API keys are powering this session */
  keyResolution?: {
    source?: string;
    userId?: string | null;
    resolvedProviders?: string[];
  } | null;
}

interface ChatSessionContextValue {
  panes: ChatPane[];
  agents: AgentListItem[];
  /** Open a new chat (starts session immediately) */
  openChat: (agentId: string, model: string, resumeSessionId?: string) => void;
  /** Close + end a pane */
  closePane: (paneId: string) => void;
  /** Bring a pane into the visible set */
  showPane: (paneId: string) => void;
  /** Hide a pane without ending the session */
  hidePane: (paneId: string) => void;
  /** Update session id once backend call resolves */
  setPaneSessionId: (paneId: string, sessionId: string) => void;
  /** Update session status */
  setPaneStatus: (paneId: string, status: SessionStatus) => void;
  /** Restart a session whose container was reaped */
  restartPane: (paneId: string) => void;
  /** Whether the floating widget is open */
  widgetOpen: boolean;
  setWidgetOpen: (open: boolean) => void;
  /** Whether initial session restore has run */
  restored: boolean;
}

const ChatSessionContext = createContext<ChatSessionContextValue | null>(null);

// ── Helpers ───────────────────────────────────────────────────────────────────

let paneCounter = 0;
function nextPaneId() {
  return `pane_${++paneCounter}`;
}

const MAX_VISIBLE = 3;

// ── localStorage persistence ─────────────────────────────────────────────────

const STORAGE_KEY = 'djinnbot:chat_panes';
const WIDGET_KEY = 'djinnbot:chat_widget_open';

/** Minimal shape we persist — everything else is re-derived on restore. */
interface PersistedPane {
  sessionId: string;
  agentId: string;
  agentName: string;
  agentEmoji: string | null;
  model: string;
  visible: boolean;
}

function savePanesToStorage(panes: ChatPane[]) {
  try {
    // Only persist panes that have a backend session id
    const serializable: PersistedPane[] = panes
      .filter(p => p.sessionId)
      .map(p => ({
        sessionId: p.sessionId!,
        agentId: p.agentId,
        agentName: p.agentName,
        agentEmoji: p.agentEmoji,
        model: p.model,
        visible: p.visible,
      }));
    localStorage.setItem(STORAGE_KEY, JSON.stringify(serializable));
  } catch {
    // localStorage may be unavailable (private browsing, quota)
  }
}

function loadPanesFromStorage(): PersistedPane[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed;
  } catch {
    return [];
  }
}

function clearPanesStorage() {
  try { localStorage.removeItem(STORAGE_KEY); } catch { /* */ }
}

function saveWidgetState(open: boolean) {
  try { localStorage.setItem(WIDGET_KEY, open ? '1' : '0'); } catch { /* */ }
}

function loadWidgetState(): boolean {
  try { return localStorage.getItem(WIDGET_KEY) === '1'; } catch { return false; }
}

// ── Provider ──────────────────────────────────────────────────────────────────

export function ChatSessionProvider({ children }: { children: React.ReactNode }) {
  const [panes, setPanes] = useState<ChatPane[]>([]);
  const [agents, setAgents] = useState<AgentListItem[]>([]);
  const [widgetOpen, setWidgetOpen] = useState(loadWidgetState);
  const [restored, setRestored] = useState(false);

  // Keep a ref so callbacks don't need panes in their dep arrays
  const panesRef = useRef(panes);
  panesRef.current = panes;

  // Persist panes to localStorage on every change (skip the initial empty state
  // before restore completes — otherwise we'd wipe the saved panes).
  const restoredRef = useRef(false);
  useEffect(() => {
    if (!restoredRef.current) return;
    savePanesToStorage(panes);
  }, [panes]);

  // Persist widget open/close state
  useEffect(() => {
    saveWidgetState(widgetOpen);
  }, [widgetOpen]);

  // Load agents once
  useEffect(() => {
    fetchAgents().then(setAgents).catch(console.error);
  }, []);

  // ── Restore: localStorage first, reconcile with backend ───────────────────
  //
  // 1. Read persisted panes from localStorage (the sessions the user had open).
  // 2. For each, check backend status — running → running, anything else → idle.
  // 3. Also discover any running sessions NOT in localStorage (e.g. started from
  //    another tab or via the API) and add them as hidden panes.
  // 4. The result: every session the user had open is restored (even if its
  //    container was reaped — it shows as idle with a Restart button), plus any
  //    new running sessions they haven't seen yet.
  useEffect(() => {
    if (agents.length === 0 || restored) return;

    const restore = async () => {
      try {
        const persisted = loadPanesFromStorage();
        const seenSessionIds = new Set<string>();

        // ── Phase 1: reconcile persisted panes with backend status ─────────
        const reconciledPanes: ChatPane[] = [];

        if (persisted.length > 0) {
          const statusResults = await Promise.allSettled(
            persisted.map(p =>
              getChatSessionStatus(p.agentId, p.sessionId)
                .then(s => ({ persisted: p, status: s })),
            ),
          );

          for (const result of statusResults) {
            if (result.status !== 'fulfilled') continue;
            const { persisted: p, status: s } = result.value;

            // Session was deleted or doesn't exist — drop it
            if (!s.exists) continue;

            seenSessionIds.add(p.sessionId);

            const backendStatus = s.status;
            let sessionStatus: SessionStatus = 'idle';
            if (backendStatus === 'running' || backendStatus === 'ready') {
              sessionStatus = 'running';
            } else if (backendStatus === 'starting') {
              sessionStatus = 'starting';
            }
            // completed, failed, idle → 'idle' (shows restart button)

            reconciledPanes.push({
              paneId: nextPaneId(),
              agentId: p.agentId,
              agentName: p.agentName,
              agentEmoji: p.agentEmoji,
              model: p.model,
              sessionId: p.sessionId,
              sessionStatus,
              visible: p.visible && reconciledPanes.filter(rp => rp.visible).length < MAX_VISIBLE,
            });
          }
        }

        // ── Phase 2: discover running sessions not in localStorage ─────────
        // (e.g. started from another tab, CLI, or API call)
        const discoveryResults = await Promise.allSettled(
          agents.map(agent =>
            listChatSessions(agent.id, { limit: 20 }).then(r => ({
              agent,
              sessions: r.sessions.filter(
                s => (s.status === 'running' || s.status === 'starting' || (s.status as string) === 'ready')
                  && !seenSessionIds.has(s.id),
              ),
            })),
          ),
        );

        for (const result of discoveryResults) {
          if (result.status !== 'fulfilled') continue;
          const { agent, sessions } = result.value;
          for (const session of sessions) {
            const visibleCount = reconciledPanes.filter(p => p.visible).length;
            reconciledPanes.push({
              paneId: nextPaneId(),
              agentId: agent.id,
              agentName: agent.name,
              agentEmoji: agent.emoji,
              model: session.model,
              sessionId: session.id,
              sessionStatus: 'running',
              visible: visibleCount < MAX_VISIBLE,
              keyResolution: session.key_resolution ?? null,
            });
          }
        }

        if (reconciledPanes.length > 0) {
          setPanes(reconciledPanes);
        } else {
          // No panes to restore — clear stale localStorage
          clearPanesStorage();
        }
      } catch (err) {
        console.error('Failed to restore chat sessions:', err);
      } finally {
        restoredRef.current = true;
        setRestored(true);
      }
    };

    restore();
  }, [agents, restored]);

  const openChat = useCallback(
    (agentId: string, model: string, _resumeSessionId?: string) => {
      // Guard: if a pane for this exact sessionId is already open, just make it
      // visible instead of opening a duplicate window.
      if (_resumeSessionId) {
        const existing = panesRef.current.find(p => p.sessionId === _resumeSessionId);
        if (existing) {
          setPanes(prev =>
            prev.map(p => (p.paneId === existing.paneId ? { ...p, visible: true } : p)),
          );
          return;
        }
      }

      // Guard: if no specific session is requested, check if an active pane for
      // this agent already exists (running or starting). If so, bring it to the
      // foreground rather than starting a duplicate chat.
      if (!_resumeSessionId) {
        const existingForAgent = panesRef.current.find(
          p => p.agentId === agentId && (p.sessionStatus === 'running' || p.sessionStatus === 'starting'),
        );
        if (existingForAgent) {
          setPanes(prev =>
            prev.map(p => (p.paneId === existingForAgent.paneId ? { ...p, visible: true } : p)),
          );
          return;
        }
      }

      const agent = agents.find(a => a.id === agentId);
      const visibleCount = panesRef.current.filter(p => p.visible).length;
      const paneId = nextPaneId();

      const newPane: ChatPane = {
        paneId,
        agentId,
        agentName: agent?.name || agentId,
        agentEmoji: agent?.emoji || null,
        model,
        sessionId: _resumeSessionId || null,
        sessionStatus: _resumeSessionId ? 'running' : 'starting',
        visible: visibleCount < MAX_VISIBLE,
      };

      setPanes(prev => [...prev, newPane]);

      // If no session id was provided, start a new one on the backend now.
      // Update the pane with the real session id once the API responds.
      if (!_resumeSessionId) {
        startChatSession(agentId, model || undefined)
          .then(result => {
            setPanes(prev =>
              prev.map(p =>
                p.paneId === paneId
                  ? { ...p, sessionId: result.sessionId, sessionStatus: 'running' }
                  : p,
              ),
            );
          })
          .catch(err => {
            console.error('Failed to start chat session:', err);
            // Mark as idle so the UI shows an error state rather than spinning forever
            setPanes(prev =>
              prev.map(p =>
                p.paneId === paneId ? { ...p, sessionStatus: 'idle' } : p,
              ),
            );
          });
      }
    },
    [agents],
  );

  const closePane = useCallback((paneId: string) => {
    // Find the pane before removing it so we can call the backend
    const pane = panesRef.current.find(p => p.paneId === paneId);
    // Remove from UI immediately — don't wait for the backend call
    setPanes(prev => prev.filter(p => p.paneId !== paneId));
    // End the backend session (kill container, mark completed) — fire and forget
    if (pane?.sessionId && pane.sessionStatus !== 'idle' && pane.sessionStatus !== 'stopping') {
      endChatSession(pane.agentId, pane.sessionId).catch(err =>
        console.error(`Failed to end session ${pane.sessionId}:`, err),
      );
    }
  }, []);

  const showPane = useCallback((paneId: string) => {
    setPanes(prev =>
      prev.map(p => (p.paneId === paneId ? { ...p, visible: true } : p)),
    );
  }, []);

  const hidePane = useCallback((paneId: string) => {
    setPanes(prev =>
      prev.map(p => (p.paneId === paneId ? { ...p, visible: false } : p)),
    );
  }, []);

  const setPaneSessionId = useCallback((paneId: string, sessionId: string) => {
    setPanes(prev =>
      prev.map(p =>
        p.paneId === paneId ? { ...p, sessionId, sessionStatus: 'running' } : p,
      ),
    );
  }, []);

  const setPaneStatus = useCallback((paneId: string, status: SessionStatus) => {
    setPanes(prev =>
      prev.map(p => (p.paneId === paneId ? { ...p, sessionStatus: status } : p)),
    );
  }, []);

  const restartPane = useCallback((paneId: string) => {
    const pane = panesRef.current.find(p => p.paneId === paneId);
    if (!pane || !pane.sessionId) return;
    if (pane.sessionStatus !== 'idle') return; // Only restart ended sessions

    // Optimistically update to starting
    setPanes(prev =>
      prev.map(p =>
        p.paneId === paneId ? { ...p, sessionStatus: 'starting' } : p,
      ),
    );

    restartChatSession(pane.agentId, pane.sessionId)
      .then(() => {
        setPanes(prev =>
          prev.map(p =>
            p.paneId === paneId ? { ...p, sessionStatus: 'starting' } : p,
          ),
        );
      })
      .catch(err => {
        console.error('Failed to restart session:', err);
        // Revert to idle on failure
        setPanes(prev =>
          prev.map(p =>
            p.paneId === paneId ? { ...p, sessionStatus: 'idle' } : p,
          ),
        );
      });
  }, []);

  return (
    <ChatSessionContext.Provider
      value={{
        panes,
        agents,
        openChat,
        closePane,
        showPane,
        hidePane,
        setPaneSessionId,
        setPaneStatus,
        restartPane,
        widgetOpen,
        setWidgetOpen,
        restored,
      }}
    >
      {children}
    </ChatSessionContext.Provider>
  );
}

export function useChatSessions() {
  const ctx = useContext(ChatSessionContext);
  if (!ctx) throw new Error('useChatSessions must be used inside ChatSessionProvider');
  return ctx;
}
