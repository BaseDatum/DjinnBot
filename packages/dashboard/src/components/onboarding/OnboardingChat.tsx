/**
 * OnboardingChat — Agent-Guided Project Creation
 *
 * A multi-agent conversational interface that walks the user through
 * creating a new project. Stas starts, hands off to Jim (strategy),
 * then Eric (product), etc. The "Project Profile" sidebar populates
 * live as the agents extract context.
 *
 * Architecture:
 * - SSE from /api/events/stream for global events (ONBOARDING_*)
 * - Per-session streaming via useChatStream hook (SSE + rAF token buffering)
 * - Refreshes from DB on structural events (handoffs, turn_end)
 */
import { useState, useRef, useCallback, useEffect, useMemo } from 'react';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import { Badge } from '@/components/ui/badge';
import { ScrollArea } from '@/components/ui/scroll-area';
import { useSSE } from '@/hooks/useSSE';
import { useChatStream } from '@/hooks/useChatStream';
import {
  createOnboardingSession,
  resumeOnboardingSession,
  stopOnboardingSession,
  sendOnboardingMessage,
  getOnboardingSession,
  finalizeOnboardingSession,
  abandonOnboardingSession,
  type OnboardingSession,
  API_BASE,
} from '@/lib/api';
import {
  X,
  Send,
  Loader2,
  CheckCircle2,
  Sparkles,
  User,
  GitBranch,
  Target,
  DollarSign,
  Layers,
  Cpu,
  Clock,
  StopCircle,
  RotateCcw,
} from 'lucide-react';
import { ProviderModelSelector } from '@/components/ui/ProviderModelSelector';
import { DEFAULT_CHAT_MODEL } from '@/lib/constants';
import { ChatMessage } from '@/components/chat/ChatMessage';

// ============================================================================
// Types
// ============================================================================

interface OnboardingChatProps {
  onClose: () => void;
  onProjectCreated: (projectId: string) => void;
  /** When set, skips the model picker and resumes this existing session. */
  resumeSessionId?: string;
}

interface GlobalSSEEvent {
  type: string;
  sessionId?: string;
  fromAgent?: string;
  toAgent?: string;
  newChatSessionId?: string;
  context?: Record<string, unknown>;
  phase?: string;
  projectId?: string;
  projectName?: string;
  planningRunId?: string;
  timestamp?: number;
}

// Profile field definitions — what we try to extract and display in sidebar
interface ProfileField {
  key: string;
  label: string;
  icon: React.ElementType;
  format?: (val: unknown) => string;
}

const PROFILE_FIELDS: ProfileField[] = [
  { key: 'project_name', label: 'Name', icon: Sparkles },
  { key: 'goal', label: 'Goal', icon: Target },
  { key: 'repo', label: 'Repository', icon: GitBranch },
  { key: 'open_source', label: 'Open Source', icon: Layers, format: (v) => (v ? 'Yes' : 'No') },
  { key: 'revenue_goal', label: 'Revenue Goal', icon: DollarSign },
  { key: 'target_customer', label: 'Target Customer', icon: User },
  { key: 'monetization', label: 'Monetization', icon: DollarSign },
  { key: 'timeline', label: 'Timeline', icon: Clock },
  { key: 'v1_scope', label: 'V1 Scope', icon: Layers },
  { key: 'tech_preferences', label: 'Tech Stack', icon: Cpu },
];

const PHASE_LABELS: Record<string, string> = {
  intake: 'Infrastructure Setup',
  strategy: 'Business Strategy',
  product: 'Product Scope',
  architecture: 'Architecture',
  done: 'Complete',
};

// ============================================================================
// Sub-components
// ============================================================================

function AgentHeader({
  agentEmoji,
  agentName,
  phase,
  isTransitioning,
}: {
  agentEmoji: string;
  agentName: string;
  phase: string;
  isTransitioning: boolean;
}) {
  return (
    <div
      className={`flex items-center gap-3 px-4 py-3 border-b bg-card transition-all duration-300 ${
        isTransitioning ? 'opacity-50 scale-95' : 'opacity-100 scale-100'
      }`}
    >
      <div className="flex h-10 w-10 items-center justify-center rounded-full bg-primary/10 text-xl shrink-0">
        {agentEmoji}
      </div>
      <div className="min-w-0">
        <div className="flex items-center gap-2">
          <span className="font-semibold text-sm">{agentName}</span>
          <Badge variant="outline" className="text-[10px] px-1.5 py-0">
            {PHASE_LABELS[phase] || phase}
          </Badge>
        </div>
        <p className="text-xs text-muted-foreground">
          {isTransitioning ? 'Handing off\u2026' : 'Agent Guided Setup'}
        </p>
      </div>
      {isTransitioning && (
        <Loader2 className="h-4 w-4 animate-spin ml-auto text-muted-foreground" />
      )}
    </div>
  );
}


function ProjectProfileSidebar({
  context,
  phase,
  onFinalize,
  isFinalizeable,
  isLoading,
}: {
  context: Record<string, unknown>;
  phase: string;
  onFinalize: () => void;
  isFinalizeable: boolean;
  isLoading: boolean;
}) {
  const filledFields = PROFILE_FIELDS.filter(
    (f) => context[f.key] !== undefined && context[f.key] !== null && context[f.key] !== ''
  );
  const progress = Math.round((filledFields.length / PROFILE_FIELDS.length) * 100);

  return (
    <div className="flex flex-col h-full border-l bg-card/50 w-72 shrink-0">
      <div className="px-4 py-3 border-b">
        <h3 className="text-sm font-semibold">Project Profile</h3>
        <div className="mt-2">
          <div className="flex items-center justify-between text-xs text-muted-foreground mb-1">
            <span>{filledFields.length} / {PROFILE_FIELDS.length} fields</span>
            <span>{progress}%</span>
          </div>
          <div className="h-1.5 rounded-full bg-muted overflow-hidden">
            <div
              className="h-full rounded-full bg-primary transition-all duration-500"
              style={{ width: `${progress}%` }}
            />
          </div>
        </div>
      </div>

      <ScrollArea className="flex-1">
        <div className="px-4 py-3 space-y-3">
          {PROFILE_FIELDS.map((field) => {
            const val = context[field.key];
            const Icon = field.icon;
            const hasValue = val !== undefined && val !== null && val !== '';
            return (
              <div key={field.key} className={`flex gap-2.5 ${hasValue ? '' : 'opacity-40'}`}>
                <div className="mt-0.5 shrink-0">
                  <Icon className="h-3.5 w-3.5 text-muted-foreground" />
                </div>
                <div className="min-w-0">
                  <p className="text-[10px] font-medium uppercase tracking-wide text-muted-foreground leading-none mb-0.5">
                    {field.label}
                  </p>
                  {hasValue ? (
                    <p className="text-xs text-foreground break-words leading-snug">
                      {field.format ? field.format(val) : String(val)}
                    </p>
                  ) : (
                    <p className="text-xs text-muted-foreground italic">Not yet captured</p>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      </ScrollArea>

      {/* Finalize button area */}
      <div className="px-4 py-3 border-t space-y-2">
        {phase === 'done' || isFinalizeable ? (
          <Button
            className="w-full"
            onClick={onFinalize}
            disabled={isLoading || !context.project_name}
          >
            {isLoading ? (
              <Loader2 className="h-4 w-4 animate-spin mr-2" />
            ) : (
              <CheckCircle2 className="h-4 w-4 mr-2" />
            )}
            Create Project
          </Button>
        ) : (
          <p className="text-xs text-muted-foreground text-center">
            Keep chatting — the profile fills in automatically
          </p>
        )}
      </div>
    </div>
  );
}

// ============================================================================
// Main component
// ============================================================================

export function OnboardingChat({ onClose, onProjectCreated, resumeSessionId }: OnboardingChatProps) {
  // Pre-start: let user pick a model before creating the session.
  // Skipped when resuming an existing session.
  const [selectedModel, setSelectedModel] = useState<string>(DEFAULT_CHAT_MODEL);
  const [started, setStarted] = useState(!!resumeSessionId);

  const [session, setSession] = useState<OnboardingSession | null>(null);
  const [input, setInput] = useState('');
  const [isLoading, setIsLoading] = useState(false);
  const [isSending, setIsSending] = useState(false);
  const [isTransitioning, setIsTransitioning] = useState(false);
  // True from session creation until the first streaming token arrives —
  // drives the "composing" indicator so the user knows the agent is active.
  const [isAgentStarting, setIsAgentStarting] = useState(false);
  // True from when the user sends a message until streaming begins or
  // turn_end arrives. Drives the composing indicator for user-initiated turns.
  const [isWaitingForAgent, setIsWaitingForAgent] = useState(false);

  const [error, setError] = useState<string | null>(null);
  // Completion state — set when ONBOARDING_COMPLETED fires
  const [completionInfo, setCompletionInfo] = useState<{
    projectId?: string;
    projectName?: string;
    planningRunId?: string;
  } | null>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);

  // ── Streaming via shared hook ──────────────────────────────────────────────

  const chatSessionId = session?.chat_session_id || '';

  // refreshSession is defined below but referenced here — forward-declare a
  // stable ref so the SSE callbacks can call it without circular deps.
  const refreshSessionRef = useRef<() => Promise<void>>(undefined);

  const chatStream = useChatStream({
    sessionId: chatSessionId,
    enabled: !!chatSessionId,
    onTurnEnd: useCallback(() => {
      setIsAgentStarting(false);
      setIsWaitingForAgent(false);
      // Refresh from DB so the committed message content is rendered even
      // when the model doesn't produce streaming text_delta events (e.g.
      // reasoning models where all output arrives in message_end only).
      // The complete_onboarding_message endpoint publishes a second
      // turn_end AFTER the DB write, so content is guaranteed to exist.
      refreshSessionRef.current?.();
    }, []),
    // NOTE: container_ready should NOT clear isAgentStarting. The proactive
    // greeting hasn't started yet when container_ready fires — the 1500ms
    // delay in the engine means the agent starts writing ~1.5s AFTER ready.
    // Clearing the composing indicator here would leave the user staring at
    // "Agent is ready" with no activity indicator until streaming begins.
    //
    // Also suppress the "Agent is ready" system message — the composing
    // dots are the appropriate UX for onboarding's proactive greeting flow.
    suppressReadyMessage: true,
  });

  const {
    messages,
    setMessages,
    setMessagesFromDb,
    isStreaming,
    scrollAreaRef,
    scrollSentinelRef,
    streamingTextRef,
    streamingThinkingRef,
    streamingTick,
    resetStreamCursor,
    expandDbMessages,
    markHistoryLoaded,
  } = chatStream;

  // Clear composing indicators when streaming begins
  useEffect(() => {
    if (isStreaming) {
      setIsAgentStarting(false);
      setIsWaitingForAgent(false);
    }
  }, [isStreaming]);

  // ── Initialize session ─────────────────────────────────────────────────────

  useEffect(() => {
    if (!started) return;
    let cancelled = false;
    (async () => {
      setIsLoading(true);
      try {
        const s = resumeSessionId
          ? await resumeOnboardingSession(resumeSessionId)
          : await createOnboardingSession(selectedModel || undefined);
        if (!cancelled) {
          setSession(s);
          setMessagesFromDb(expandDbMessages(s.messages));
          // NOTE: markHistoryLoaded() is NOT called here. It must run AFTER
          // useChatStream's reset effect (which fires when sessionId changes
          // from '' to the new chat_session_id and resets historyLoadedRef
          // to false). Calling it here — before React re-renders — would be
          // undone by the reset effect, leaving SSE events queued forever.
          // A dedicated useEffect below handles the correct timing.

          // For a fresh session the agent hasn't spoken yet — show composing indicator
          if (!resumeSessionId) setIsAgentStarting(true);
        }
      } catch {
        if (!cancelled) {
          setError(resumeSessionId ? 'Failed to resume onboarding session' : 'Failed to start onboarding session');
        }
      } finally {
        if (!cancelled) setIsLoading(false);
      }
    })();
    return () => { cancelled = true; };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [started]);

  // Release the SSE event gate AFTER useChatStream's session-change reset
  // effect has run. useChatStream resets historyLoadedRef=false whenever
  // sessionId changes; this effect fires later in the same commit (effects
  // run in registration order — useChatStream's effects are registered
  // first, then this component's). Without this, markHistoryLoaded() in
  // the async callback above would be undone by the reset, and all SSE
  // events (container_ready, output tokens, turn_end) would be queued
  // indefinitely — causing the "three dots forever" bug.
  useEffect(() => {
    if (session && !isLoading) {
      markHistoryLoaded();
    }
  }, [session, isLoading, markHistoryLoaded]);

  // ── Refresh from DB (structural events only) ──────────────────────────────

  const refreshSession = useCallback(async () => {
    if (!session?.id) return;
    try {
      const s = await getOnboardingSession(session.id);
      setSession(s);
      // Merge DB messages with any active streaming state using deduplication.
      // setMessagesFromDb preserves in-flight streaming_ prefixed messages
      // while replacing all committed messages with the DB source of truth.
      setMessagesFromDb(expandDbMessages(s.messages));
    } catch {
      // Non-fatal
    }
  }, [session?.id, expandDbMessages, setMessagesFromDb]);

  // Keep the ref in sync so SSE callbacks can call refreshSession without
  // being recreated when the callback identity changes.
  useEffect(() => {
    refreshSessionRef.current = refreshSession;
  }, [refreshSession]);

  // ── Global SSE — handoffs and context updates ─────────────────────────────

  useSSE<GlobalSSEEvent>({
    url: `${API_BASE}/events/stream`,
    enabled: !!session?.id,
    onMessage: useCallback(
      (event: GlobalSSEEvent) => {
        if (!session?.id || event.sessionId !== session.id) return;

        if (event.type === 'ONBOARDING_HANDOFF') {
          setIsTransitioning(true);
          // Optimistically patch chat_session_id + phase so SSE reconnects
          // to the new agent's stream immediately.
          if (event.newChatSessionId) {
            setSession(prev => prev ? {
              ...prev,
              chat_session_id: event.newChatSessionId!,
              current_agent_id: event.toAgent ?? prev.current_agent_id,
              phase: (event.phase as OnboardingSession['phase']) ?? prev.phase,
            } : prev);
            resetStreamCursor();
          }
          // Show composing indicator for the new agent's proactive greeting.
          // The new container will fire container_ready, then the engine sends
          // the proactive greeting after 1500ms — isAgentStarting keeps the
          // bouncing dots visible until streaming begins or turn_end arrives.
          setIsAgentStarting(true);
          // Refresh from DB to pick up the handoff system message and all
          // prior conversation history. We do NOT clear messages first —
          // setMessagesFromDb handles deduplication, so the user sees the
          // conversation scroll smoothly rather than a blank-then-reload flash.
          // Short delay so the server has committed the handoff message.
          setTimeout(() => {
            refreshSession().then(() => setIsTransitioning(false));
          }, 600);
        }

        if (event.type === 'ONBOARDING_CONTEXT_UPDATED' && event.context) {
          setSession((prev) =>
            prev ? { ...prev, context: { ...prev.context, ...event.context } } : prev
          );
        }

        if (event.type === 'ONBOARDING_COMPLETED') {
          // Clear all activity indicators — the session is finished.
          setIsAgentStarting(false);
          setIsWaitingForAgent(false);

          // Store completion info for the banner
          setCompletionInfo({
            projectId: event.projectId,
            projectName: event.projectName,
            planningRunId: event.planningRunId,
          });

          refreshSession();
        }
      },
      [session?.id, refreshSession, setMessages, resetStreamCursor]
    ),
  });

  // ── Send message ───────────────────────────────────────────────────────────

  const handleSend = useCallback(async () => {
    if (!input.trim() || !session?.id || isSending) return;
    const text = input.trim();
    setInput('');
    setIsSending(true);

    const tempId = `user_${Date.now()}`;
    setMessages((prev) => [
      ...prev,
      { id: tempId, type: 'user', content: text, timestamp: Date.now() },
    ]);

    try {
      await sendOnboardingMessage(session.id, text);
      // Message queued — show composing indicator until streaming begins
      // or turn_end arrives.
      setIsWaitingForAgent(true);
    } catch {
      setError('Failed to send message');
      setMessages((prev) => prev.filter((m) => m.id !== tempId));
    } finally {
      setIsSending(false);
      inputRef.current?.focus();
    }
  }, [input, session, isSending, setMessages]);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        handleSend();
      }
    },
    [handleSend]
  );

  // ── Finalize (create project) ─────────────────────────────────────────────

  const handleFinalize = useCallback(async () => {
    if (!session?.id) return;
    const ctx = session.context;
    const projectName = String(ctx.project_name || 'Untitled Project');
    setIsLoading(true);
    try {
      const result = await finalizeOnboardingSession(session.id, {
        projectName,
        description: ctx.summary ? String(ctx.summary) : undefined,
        repository: ctx.repo ? String(ctx.repo) : undefined,
        context: ctx,
      });
      onProjectCreated(result.projectId);
    } catch {
      setError('Failed to create project');
      setIsLoading(false);
    }
  }, [session, onProjectCreated]);

  // ── Stop / Resume / Close ─────────────────────────────────────────────────

  const [isStopping, setIsStopping] = useState(false);
  const [isResuming, setIsResuming] = useState(false);

  const handleStop = useCallback(async () => {
    if (!session?.id || isStopping) return;
    setIsStopping(true);
    try {
      await stopOnboardingSession(session.id);
      setIsAgentStarting(false);
    } catch {
      setError('Failed to stop agent');
    } finally {
      setIsStopping(false);
    }
  }, [session, isStopping]);

  const handleResume = useCallback(async () => {
    if (!session?.id || isResuming) return;
    setIsResuming(true);
    try {
      const s = await resumeOnboardingSession(session.id);
      setSession(s);
      resetStreamCursor();
      setIsAgentStarting(false);
    } catch {
      setError('Failed to resume session');
    } finally {
      setIsResuming(false);
    }
  }, [session, isResuming, resetStreamCursor]);

  const handleClose = useCallback(async () => {
    if (session?.id && session.status === 'active') {
      try {
        await abandonOnboardingSession(session.id);
      } catch {
        // Best-effort cleanup
      }
    }
    onClose();
  }, [session, onClose]);

  // ── Page-refresh / navigation resilience ──────────────────────────────────
  // Use a ref so the beforeunload handler always sees the latest session state
  // without needing to re-register the listener on every session change.
  const sessionRef = useRef(session);
  useEffect(() => { sessionRef.current = session; }, [session]);

  // On unmount (navigation away, React re-mount) — abandon if active.
  useEffect(() => {
    return () => {
      const s = sessionRef.current;
      if (s?.id && s.status === 'active') {
        // Fire-and-forget — can't await in a cleanup function.
        abandonOnboardingSession(s.id).catch(() => {});
      }
    };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // On hard refresh / tab close — use sendBeacon for reliability.
  // fetch() is often cancelled by the browser during beforeunload, but
  // navigator.sendBeacon survives page teardown.
  useEffect(() => {
    const handleBeforeUnload = () => {
      const s = sessionRef.current;
      if (s?.id && s.status === 'active') {
        const url = `${API_BASE}/onboarding/sessions/${s.id}/abandon`;
        // sendBeacon can only send POST-like payloads; the endpoint is PATCH
        // but we also try fetch with keepalive as a fallback.
        try {
          navigator.sendBeacon(url, '');
        } catch {
          // Fallback: keepalive fetch survives page teardown in most browsers
          fetch(url, { method: 'PATCH', keepalive: true }).catch(() => {});
        }
      }
    };
    window.addEventListener('beforeunload', handleBeforeUnload);
    return () => window.removeEventListener('beforeunload', handleBeforeUnload);
  }, []);

  // ── Render ─────────────────────────────────────────────────────────────────

  // Read streaming refs (streamingTick ensures re-render)
  void streamingTick;
  const liveText = streamingTextRef.current;
  const liveThinking = streamingThinkingRef.current;

  const isFinalizeable =
    !!session?.context.project_name && (session.phase === 'product' || session.phase === 'done');

  // Unified "agent is working" flag — drives composing dots and input state.
  const isAgentWorking = isAgentStarting || isWaitingForAgent;

  // Pre-start screen — pick a model before creating the session
  if (!started) {
    return (
      <div className="fixed inset-0 z-50 flex flex-col bg-background">
        <div className="flex items-center justify-between px-4 h-12 border-b bg-card shrink-0">
          <div className="flex items-center gap-2">
            <Sparkles className="h-4 w-4 text-primary" />
            <span className="text-sm font-semibold">Agent Guided Setup</span>
          </div>
          <button
            onClick={onClose}
            className="rounded-md p-1.5 hover:bg-muted transition-colors"
            aria-label="Close"
          >
            <X className="h-4 w-4" />
          </button>
        </div>
        <div className="flex flex-1 items-center justify-center">
          <div className="flex flex-col items-center gap-6 max-w-sm w-full px-6">
            <div className="text-center">
              <div className="flex h-14 w-14 items-center justify-center rounded-full bg-primary/10 text-3xl mx-auto mb-4">
                &#x1F680;
              </div>
              <h2 className="text-lg font-semibold">Start your project</h2>
              <p className="text-sm text-muted-foreground mt-1">
                Choose a model for your onboarding session, then meet Stas.
              </p>
            </div>
            <div className="w-full space-y-2">
              <label className="text-xs font-medium text-muted-foreground uppercase tracking-wide">
                Model
              </label>
              <ProviderModelSelector
                value={selectedModel}
                onChange={setSelectedModel}
                placeholder="Select a model…"
                className="w-full"
              />
            </div>
            <Button
              className="w-full"
              onClick={() => setStarted(true)}
              disabled={!selectedModel}
            >
              <Sparkles className="h-4 w-4 mr-2" />
              Start Onboarding
            </Button>
          </div>
        </div>
      </div>
    );
  }

  if (isLoading && !session) {
    return (
      <div className="fixed inset-0 z-50 flex items-center justify-center bg-background/80 backdrop-blur-sm">
        <div className="flex flex-col items-center gap-3">
          <Loader2 className="h-8 w-8 animate-spin text-primary" />
          <p className="text-sm text-muted-foreground">Starting onboarding&hellip;</p>
        </div>
      </div>
    );
  }

  return (
    <div className="fixed inset-0 z-50 flex flex-col bg-background">
      {/* Top bar */}
      <div className="flex items-center justify-between px-4 h-12 border-b bg-card shrink-0">
        <div className="flex items-center gap-2">
          <Sparkles className="h-4 w-4 text-primary" />
          <span className="text-sm font-semibold">Agent Guided Setup</span>
          {session && (
            <Badge variant="outline" className="text-[10px] ml-1">
              {session.status === 'active' ? 'In Progress' : session.status}
            </Badge>
          )}
        </div>

        <div className="flex items-center gap-1">
          {/* Stop button */}
          {session?.status === 'active' && (isStreaming || isAgentWorking) && (
            <Button
              size="sm"
              variant="destructive"
              onClick={handleStop}
              disabled={isStopping}
              className="h-7 px-2 text-xs gap-1"
              title="Stop the agent mid-generation (session stays alive)"
            >
              {isStopping ? (
                <Loader2 className="h-3 w-3 animate-spin" />
              ) : (
                <StopCircle className="h-3 w-3" />
              )}
              Stop
            </Button>
          )}

          {/* Resume button */}
          {session && session.status !== 'active' && (
            <Button
              size="sm"
              variant="outline"
              onClick={handleResume}
              disabled={isResuming}
              className="h-7 px-2 text-xs gap-1"
              title="Restart the agent container and continue"
            >
              {isResuming ? (
                <Loader2 className="h-3 w-3 animate-spin" />
              ) : (
                <RotateCcw className="h-3 w-3" />
              )}
              Resume
            </Button>
          )}

          {/* Close button */}
          <button
            onClick={handleClose}
            className="rounded-md p-1.5 hover:bg-muted transition-colors ml-1"
            aria-label="Close (session will be resumable)"
            title="Close \u2014 session is saved and can be resumed later"
          >
            <X className="h-4 w-4" />
          </button>
        </div>
      </div>

      {/* Main body */}
      <div className="flex flex-1 min-h-0">
        {/* Chat area */}
        <div className="flex flex-col flex-1 min-w-0">
          {/* Agent header */}
          {session && (
            <AgentHeader
              agentEmoji={session.current_agent_emoji}
              agentName={session.current_agent_name}
              phase={session.phase}
              isTransitioning={isTransitioning}
            />
          )}

          {/* Message list */}
          <ScrollArea className="flex-1" ref={scrollAreaRef as any}>
            <div className="px-4 py-4 space-y-4 max-w-2xl mx-auto w-full">
              {[...messages].sort((a, b) => a.timestamp - b.timestamp).map((msg) => {
                const msgIsStreaming = isStreaming && msg.id.startsWith('streaming_');
                return (
                  <ChatMessage
                    key={msg.id}
                    message={msg}
                    isStreaming={msgIsStreaming}
                    streamingContent={msgIsStreaming && msg.type === 'assistant' ? liveText : undefined}
                    streamingThinking={msgIsStreaming && msg.type === 'thinking' ? liveThinking : undefined}
                  />
                );
              })}
              {/* Animated "composing" bubble */}
              {isAgentWorking && !isStreaming && (
                <div className="flex gap-3 my-3">
                  <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-primary/10 text-base">
                    {session?.current_agent_emoji || '\uD83D\uDE80'}
                  </div>
                  <div className="max-w-[80%] rounded-2xl rounded-bl-sm bg-muted px-4 py-3">
                    <div className="flex items-center gap-1.5">
                      <span className="h-2 w-2 rounded-full bg-muted-foreground/50 animate-bounce [animation-delay:0ms]" />
                      <span className="h-2 w-2 rounded-full bg-muted-foreground/50 animate-bounce [animation-delay:150ms]" />
                      <span className="h-2 w-2 rounded-full bg-muted-foreground/50 animate-bounce [animation-delay:300ms]" />
                    </div>
                  </div>
                </div>
              )}
              {/* Auto-scroll sentinel */}
              <div ref={scrollSentinelRef} className="h-px" />
            </div>
          </ScrollArea>

          {/* Error banner */}
          {error && (
            <div className="mx-4 mb-2 rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-xs text-destructive flex items-center justify-between">
              <span>{error}</span>
              <button onClick={() => setError(null)} className="ml-2 opacity-70 hover:opacity-100">
                <X className="h-3 w-3" />
              </button>
            </div>
          )}

          {/* Completion banner — shown when onboarding finishes */}
          {completionInfo && (
            <div className="mx-4 mb-2 rounded-lg border border-primary/30 bg-primary/5 px-4 py-3 shrink-0">
              <div className="flex items-start gap-3">
                <CheckCircle2 className="h-5 w-5 text-primary mt-0.5 shrink-0" />
                <div className="flex-1 min-w-0">
                  <p className="text-sm font-medium">
                    Project &ldquo;{completionInfo.projectName || 'Untitled'}&rdquo; created
                  </p>
                  <p className="text-xs text-muted-foreground mt-0.5">
                    {completionInfo.planningRunId
                      ? 'The planning pipeline is now running — Finn is breaking down your project into tasks.'
                      : 'Onboarding complete.'}
                  </p>
                  <div className="flex items-center gap-2 mt-2">
                    {completionInfo.projectId && (
                      <Button
                        size="sm"
                        variant="default"
                        className="h-7 text-xs"
                        onClick={() => onProjectCreated(completionInfo.projectId!)}
                      >
                        View Project
                      </Button>
                    )}
                    {completionInfo.planningRunId && (
                      <Button
                        size="sm"
                        variant="outline"
                        className="h-7 text-xs"
                        onClick={() => {
                          window.location.href = `/runs/${completionInfo.planningRunId}`;
                        }}
                      >
                        View Planning Run
                      </Button>
                    )}
                  </div>
                </div>
              </div>
            </div>
          )}

          {/* Input — hidden when session is completed */}
          {session?.status === 'active' ? (
            <div className="px-4 py-3 border-t bg-card shrink-0">
              <div className="flex gap-2 items-end max-w-2xl mx-auto">
                <Textarea
                  ref={inputRef}
                  value={input}
                  onChange={(e) => setInput(e.target.value)}
                  onKeyDown={handleKeyDown}
                  placeholder={
                    isAgentWorking
                      ? `${session?.current_agent_name || 'Stas'} is composing\u2026`
                      : 'Type a message\u2026 (Enter to send)'
                  }
                  className="resize-none min-h-[40px] max-h-32 text-sm"
                  rows={1}
                  disabled={isSending || isAgentWorking}
                />
                <Button
                  size="icon"
                  onClick={handleSend}
                  disabled={!input.trim() || isSending || isAgentWorking}
                  className="shrink-0 h-10 w-10"
                >
                  {isSending ? (
                    <Loader2 className="h-4 w-4 animate-spin" />
                  ) : (
                    <Send className="h-4 w-4" />
                  )}
                </Button>
              </div>
            </div>
          ) : !completionInfo ? (
            <div className="px-4 py-3 border-t bg-card shrink-0">
              <p className="text-xs text-muted-foreground text-center">Session ended</p>
            </div>
          ) : null}
        </div>

        {/* Profile sidebar */}
        {session && (
          <ProjectProfileSidebar
            context={session.context}
            phase={session.phase}
            onFinalize={handleFinalize}
            isFinalizeable={isFinalizeable}
            isLoading={isLoading}
          />
        )}
      </div>
    </div>
  );
}
