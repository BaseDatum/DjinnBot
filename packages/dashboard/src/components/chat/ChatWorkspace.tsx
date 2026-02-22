/**
 * ChatWorkspace — the full-page chat experience.
 *
 * The toolbar/session-picker has moved to ChatSidebarFlyout (desktop) and
 * ChatMobilePill (mobile). This component only renders the open panes.
 *
 * Desktop: up to MAX_VISIBLE panes tiled side-by-side with a resizable layout.
 * Overflow (> MAX_VISIBLE) lands in a collapsible tray at the bottom.
 *
 * Mobile: a single-pane stack — the visible pane fills the screen, with a
 * horizontal scroll row of session tabs at the top to switch between sessions.
 */

import { Fragment, useState } from 'react';
import {
  Group as PanelGroup,
  Panel,
  Separator as PanelResizeHandle,
} from 'react-resizable-panels';
import {
  ChevronDown,
  ChevronUp,
  MessagesSquare,
  Loader2,
  X,
} from 'lucide-react';
import { AgentChat } from './AgentChat';
import { useChatSessions, type ChatPane } from './ChatSessionContext';
import { formatModelChip } from '@/lib/format';
import { KeySourceBadge } from '@/components/ui/KeySourceBadge';
import { SessionTokenStats } from '@/components/ui/SessionTokenStats';
import styles from './ChatWorkspace.module.css';

const MAX_VISIBLE = 3;

interface ChatWorkspaceProps {
  initialAgentId?: string;
}

export function ChatWorkspace({ initialAgentId: _initialAgentId }: ChatWorkspaceProps = {}) {
  const {
    panes,
    closePane,
    showPane,
    hidePane,
    setPaneStatus,
    restored,
  } = useChatSessions();

  const [trayOpen, setTrayOpen] = useState(false);
  // Mobile: which pane is focused
  const [mobileFocusId, setMobileFocusId] = useState<string | null>(null);

  const visiblePanes = panes.filter(p => p.visible);
  const hiddenPanes = panes.filter(p => !p.visible);

  // Mobile focused pane — default to last visible pane
  const mobilePane =
    panes.find(p => p.paneId === mobileFocusId) ??
    panes[panes.length - 1] ??
    null;

  const handleTrayShow = (paneId: string) => {
    if (visiblePanes.length >= MAX_VISIBLE) hidePane(visiblePanes[0].paneId);
    showPane(paneId);
  };

  if (!restored) {
    return (
      <div className={styles.root}>
        <div className={styles.empty}>
          <Loader2 className="h-8 w-8 animate-spin text-muted-foreground/40" />
          <span className={styles.emptyHint}>Restoring sessions…</span>
        </div>
      </div>
    );
  }

  return (
    <div className={styles.root}>
      {/* ── Desktop layout ─────────────────────────────────────────────── */}
      <div className="hidden md:flex flex-col flex-1 min-h-0">
        {panes.length === 0 ? (
          <EmptyState />
        ) : (
          <div className={styles.panesArea}>
            <PanelGroup orientation="horizontal" id="chat-workspace">
              {visiblePanes.map((pane, idx) => (
                <Fragment key={pane.paneId}>
                  {idx > 0 && (
                    <PanelResizeHandle
                      className={styles.resizeHandle}
                    />
                  )}
                  <Panel
                    minSize={18}
                    defaultSize={100 / visiblePanes.length}
                  >
                    <ChatPaneWrapper
                      pane={pane}
                      onClose={() => closePane(pane.paneId)}
                      onHide={() => hidePane(pane.paneId)}
                      onSessionEnd={() => setPaneStatus(pane.paneId, 'idle')}
                    />
                  </Panel>
                </Fragment>
              ))}
            </PanelGroup>
          </div>
        )}

        {/* Sessions tray — shown when any pane is hidden OR there are many panes */}
        {(hiddenPanes.length > 0 || panes.length > MAX_VISIBLE) && (
          <div className={styles.tray}>
            <button
              className={styles.trayToggle}
              onClick={() => setTrayOpen(o => !o)}
              aria-expanded={trayOpen}
            >
              {trayOpen ? <ChevronDown className="h-3.5 w-3.5" /> : <ChevronUp className="h-3.5 w-3.5" />}
              <span>
                {hiddenPanes.length > 0
                  ? `${hiddenPanes.length} hidden session${hiddenPanes.length !== 1 ? 's' : ''}`
                  : 'All sessions visible'}
              </span>
              {hiddenPanes.some(p => p.sessionStatus === 'running') && (
                <span className="h-1.5 w-1.5 rounded-full bg-green-500 animate-pulse" />
              )}
            </button>

            {trayOpen && (
              <div className={styles.trayCards}>
                {panes.map(pane => (
                  <TrayCard
                    key={pane.paneId}
                    pane={pane}
                    isVisible={pane.visible}
                    onShow={() => handleTrayShow(pane.paneId)}
                    onHide={() => hidePane(pane.paneId)}
                    onClose={() => closePane(pane.paneId)}
                  />
                ))}
              </div>
            )}
          </div>
        )}
      </div>

      {/* ── Mobile layout ──────────────────────────────────────────────── */}
      <div className="flex flex-col flex-1 min-h-0 md:hidden">
        {panes.length === 0 ? (
          <EmptyState />
        ) : (
          <>
            {/* Session tab strip */}
            <div className={styles.mobileTabStrip}>
              {panes.map(pane => {
                const isActive = pane.paneId === mobilePane?.paneId;
                const statusColor =
                  pane.sessionStatus === 'running' ? 'bg-green-500' :
                    pane.sessionStatus === 'starting' ? 'bg-yellow-400 animate-pulse' :
                      'bg-muted-foreground/30';
                return (
                  <button
                    key={pane.paneId}
                    onClick={() => setMobileFocusId(pane.paneId)}
                    className={`${styles.mobileTab} ${isActive ? styles.mobileTabActive : ''}`}
                  >
                    <span>{pane.agentEmoji || '🤖'}</span>
                    <span className="truncate max-w-[80px]">{pane.agentName}</span>
                    <span className={`h-1.5 w-1.5 rounded-full shrink-0 ${statusColor}`} />
                    <button
                      className={styles.mobileTabClose}
                      onClick={e => { e.stopPropagation(); closePane(pane.paneId); }}
                      aria-label={`Close ${pane.agentName}`}
                    >
                      <X className="h-3 w-3" />
                    </button>
                  </button>
                );
              })}
            </div>

            {/* Active pane */}
            {mobilePane && mobilePane.sessionId ? (
              <div className="flex-1 min-h-0 overflow-hidden">
                <AgentChat
                  key={mobilePane.paneId}
                  agentId={mobilePane.agentId}
                  agentName={mobilePane.agentName}
                  agentEmoji={mobilePane.agentEmoji}
                  sessionId={mobilePane.sessionId}
                  initialSessionStatus={mobilePane.sessionStatus}
                  onSessionEnd={() => setPaneStatus(mobilePane.paneId, 'idle')}
                />
              </div>
            ) : mobilePane ? (
              <div className="flex-1 flex items-center justify-center gap-2 text-muted-foreground">
                <Loader2 className="h-5 w-5 animate-spin" />
                <span className="text-sm">Starting session…</span>
              </div>
            ) : null}
          </>
        )}
      </div>
    </div>
  );
}

// ── Empty state ───────────────────────────────────────────────────────────────

function EmptyState() {
  return (
    <div className={styles.empty}>
      <MessagesSquare className="h-12 w-12 text-muted-foreground/25" />
      <span className={styles.emptyTitle}>No open chats</span>
      <span className={styles.emptyHint}>
        Use the <strong>Chat</strong> panel on the left to pick an agent and open a session.
        <span className="md:hidden"> Tap the <strong>Chat</strong> pill at the bottom-left.</span>
      </span>
    </div>
  );
}

// ── Desktop pane wrapper ──────────────────────────────────────────────────────

interface ChatPaneWrapperProps {
  pane: ChatPane;
  onClose: () => void;
  onHide: () => void;
  onSessionEnd: () => void;
}

function ChatPaneWrapper({ pane, onClose, onHide, onSessionEnd }: ChatPaneWrapperProps) {
  const statusDot =
    pane.sessionStatus === 'running' ? 'bg-green-500' :
      pane.sessionStatus === 'starting' ? 'bg-yellow-400 animate-pulse' :
        pane.sessionStatus === 'stopping' ? 'bg-red-400 animate-pulse' :
          'bg-muted-foreground/30';

  return (
    <div className={styles.paneWrapper}>
      <div className={styles.paneHeader}>
        <div className={styles.paneHeaderLeft}>
          <span className={styles.paneEmoji}>{pane.agentEmoji || '🤖'}</span>
          <span className={styles.paneAgentName}>{pane.agentName}</span>
          <span className={`h-1.5 w-1.5 rounded-full shrink-0 ${statusDot}`} />
          <span className={styles.paneModelChip}>{formatModelChip(pane.model)}</span>
          {pane.keyResolution && <KeySourceBadge keyResolution={pane.keyResolution} />}
          {pane.sessionId && <SessionTokenStats sessionId={pane.sessionId} />}
        </div>
        <div className={styles.paneHeaderActions}>
          <button
            className={styles.paneActionBtn}
            onClick={onHide}
            title="Minimise to tray"
          >
            <ChevronDown className="h-3.5 w-3.5" />
          </button>
          <button
            className={`${styles.paneActionBtn} ${styles.paneCloseBtn}`}
            onClick={onClose}
            title="End session and close"
            aria-label={`Close chat with ${pane.agentName}`}
          >
            ×
          </button>
        </div>
      </div>

      <div className={styles.paneBody}>
        {pane.sessionId ? (
          <AgentChat
            agentId={pane.agentId}
            agentName={pane.agentName}
            agentEmoji={pane.agentEmoji}
            sessionId={pane.sessionId}
            initialSessionStatus={pane.sessionStatus}
            onSessionEnd={onSessionEnd}
          />
        ) : (
          <div className={styles.paneStarting}>
            <Loader2 className="h-5 w-5 animate-spin text-primary" />
            <span>Starting session…</span>
          </div>
        )}
      </div>
    </div>
  );
}

// ── Overflow tray card ────────────────────────────────────────────────────────

interface TrayCardProps {
  pane: ChatPane;
  isVisible: boolean;
  onShow: () => void;
  onHide: () => void;
  onClose: () => void;
}

function TrayCard({ pane, isVisible, onShow, onHide, onClose }: TrayCardProps) {
  const statusColor =
    pane.sessionStatus === 'running' ? 'text-green-500' :
      pane.sessionStatus === 'starting' ? 'text-yellow-400' : 'text-muted-foreground/50';

  return (
    <div className={`${styles.trayCard} ${isVisible ? styles.trayCardVisible : ''}`}>
      <span className={styles.trayCardEmoji}>{pane.agentEmoji || '🤖'}</span>
      <div className={styles.trayCardInfo}>
        <span className={styles.trayCardName}>{pane.agentName}</span>
        <span className={`${styles.trayCardStatus} ${statusColor}`}>{pane.sessionStatus}</span>
      </div>
      <div className={styles.trayCardActions}>
        {isVisible ? (
          <button className={styles.trayCardBtn} onClick={onHide} title="Hide">
            <ChevronDown className="h-3 w-3" />
          </button>
        ) : (
          <button className={styles.trayCardBtn} onClick={onShow} title="Show">
            <ChevronUp className="h-3 w-3" />
          </button>
        )}
        <button
          className={`${styles.trayCardBtn} ${styles.trayCardClose}`}
          onClick={onClose}
          title="End and close"
        >
          ×
        </button>
      </div>
    </div>
  );
}
