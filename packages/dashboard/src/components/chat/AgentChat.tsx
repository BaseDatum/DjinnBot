/**
 * AgentChat — the message-thread pane for a single chat session.
 *
 * Session lifecycle is now owned by the parent (ChatWorkspace / FloatingChatWidget).
 * This component receives a `sessionId` that is already started or resumed,
 * connects to its SSE stream via the shared useChatStream hook, and handles messaging.
 *
 * Streaming logic (SSE, token buffering, auto-scroll) lives entirely in useChatStream.
 */

import { useState, useRef, useCallback, useEffect } from 'react';
import { useChatStream } from '@/hooks/useChatStream';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Textarea } from '@/components/ui/textarea';
import { ChatMessage } from './ChatMessage';
import {
  sendChatMessage,
  stopChatResponse,
  getChatSession,
  restartChatSession,
  uploadChatAttachment,
} from '@/lib/api';
import { FileUploadZone, AttachmentChip, type PendingAttachment } from './FileUploadZone';
import {
  Send,
  Loader2,
  Wifi,
  WifiOff,
  AlertCircle,
  StopCircle,
  RotateCcw,
  Paperclip,
} from 'lucide-react';

// ── Types ─────────────────────────────────────────────────────────────────────

export interface AgentChatProps {
  agentId: string;
  agentName: string;
  agentEmoji?: string | null;
  /** The backend session id — must already be started/resumed */
  sessionId: string;
  /** The session status at the time of mount */
  initialSessionStatus?: 'idle' | 'starting' | 'running' | 'stopping';
  /** Called when the session ends (e.g. timeout / remote close) */
  onSessionEnd?: () => void;
}

type ConnectionStatus = 'disconnected' | 'connecting' | 'connected' | 'error';
type SessionStatus = 'starting' | 'running' | 'stopping' | 'idle';

// ── Component ─────────────────────────────────────────────────────────────────

export function AgentChat({
  agentId,
  agentName,
  agentEmoji,
  sessionId,
  initialSessionStatus = 'running',
  onSessionEnd,
}: AgentChatProps) {
  const [sessionStatus, setSessionStatus] = useState<SessionStatus>(initialSessionStatus);
  const [isResponding, setIsResponding] = useState(false);
  const [inputValue, setInputValue] = useState('');
  const [pendingAttachments, setPendingAttachments] = useState<PendingAttachment[]>([]);
  const fileInputRef2 = useRef<HTMLInputElement>(null);

  const inputRef = useRef<HTMLTextAreaElement>(null);
  const abortControllerRef = useRef<AbortController | null>(null);
  const historyLoadedRef = useRef(false);

  // ── Custom top-edge resize for textarea ────────────────────────────────────
  const [inputHeight, setInputHeight] = useState(44);
  const inputResizeRef = useRef<{ startY: number; startH: number } | null>(null);

  useEffect(() => {
    const onMouseMove = (e: MouseEvent) => {
      if (!inputResizeRef.current) return;
      // Dragging upward (negative dy) should increase height
      const dy = inputResizeRef.current.startY - e.clientY;
      const newH = Math.max(44, Math.min(window.innerHeight * 0.5, inputResizeRef.current.startH + dy));
      setInputHeight(newH);
    };
    const onMouseUp = () => {
      if (!inputResizeRef.current) return;
      inputResizeRef.current = null;
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
    };
    window.addEventListener('mousemove', onMouseMove);
    window.addEventListener('mouseup', onMouseUp);
    return () => {
      window.removeEventListener('mousemove', onMouseMove);
      window.removeEventListener('mouseup', onMouseUp);
    };
  }, []);

  // Message queue state — declared before useChatStream so callbacks can reference them.
  const queuedMessageRef = useRef<string | null>(null);
  const [hasQueuedMessage, setHasQueuedMessage] = useState(false);
  // Ref to sendMessageDirect so the onTurnEnd callback can call it without stale closure.
  const sendMessageDirectRef = useRef<((msg: string) => Promise<void>) | null>(null);

  const chatStream = useChatStream({
    sessionId,
    enabled: sessionStatus !== 'idle' && sessionStatus !== 'stopping',
    onTurnEnd: useCallback(() => {
      setIsResponding(false);

      // Auto-send any queued message
      if (queuedMessageRef.current) {
        const queued = queuedMessageRef.current;
        queuedMessageRef.current = null;
        setHasQueuedMessage(false);

        // Send after a brief delay to let the turn_end settle
        setTimeout(() => {
          sendMessageDirectRef.current?.(queued);
        }, 50);
      }
    }, []),
    onSessionComplete: useCallback(() => {
      setIsResponding(false);
      setSessionStatus('idle');
      onSessionEnd?.();
    }, [onSessionEnd]),
    onResponseAborted: useCallback(() => {
      setIsResponding(false);
    }, []),
    onContainerReady: useCallback(() => {
      setSessionStatus('running');
      setTimeout(() => inputRef.current?.focus(), 50);
    }, []),
  });

  const {
    messages,
    setMessages,
    setMessagesFromDb,
    isStreaming,
    connectionStatus: sseConnectionStatus,
    scrollAreaRef,
    scrollSentinelRef,
    streamingTextRef,
    streamingThinkingRef,
    streamingTick,
    expandDbMessages,
    markHistoryLoaded,
  } = chatStream;



  const connectionStatus: ConnectionStatus =
    sseConnectionStatus === 'connected' ? 'connected' :
    sseConnectionStatus === 'connecting' ? 'connecting' :
    sseConnectionStatus === 'error' ? 'error' : 'disconnected';

  // Load message history on mount.
  // markHistoryLoaded() gates the SSE handler: events arriving before this
  // call are queued and replayed after the DB messages are set, preventing
  // the race that previously caused duplicate / overlapping messages.
  useEffect(() => {
    if (historyLoadedRef.current) return;
    historyLoadedRef.current = true;

    getChatSession(sessionId)
      .then(data => {
        const loaded = expandDbMessages(data.messages);
        setMessagesFromDb(loaded);
        // Build a set of DB message IDs so markHistoryLoaded can skip
        // replayed structural SSE events that duplicate DB content.
        const dbIds = new Set(data.messages.map((m: { id: string }) => m.id));
        markHistoryLoaded(dbIds);

        const status = data.status as string;
        if (status === 'running' || status === 'ready') {
          setSessionStatus('running');
        } else if (status === 'starting') {
          setSessionStatus('starting');
        } else {
          setSessionStatus('idle');
          onSessionEnd?.();
        }
        if (status === 'running' || status === 'ready') {
          setTimeout(() => inputRef.current?.focus(), 100);
        }
      })
      .catch(err => {
        console.error('Failed to load session history:', err);
        setMessages([{
          id: `error_load_${Date.now()}`,
          type: 'error',
          content: `Failed to load session history: ${err instanceof Error ? err.message : 'Unknown error'}`,
          timestamp: Date.now(),
        }]);
        // Still release the gate so SSE events can flow
        markHistoryLoaded();
      });
  }, [sessionId, expandDbMessages, setMessages, setMessagesFromDb, markHistoryLoaded, onSessionEnd]);

  // ── Messaging ──────────────────────────────────────────────────────────────

  /** Send a message to the agent immediately (not queued). */
  const sendMessageDirect = async (userMessage: string) => {
    // Collect and clear pending attachments
    const attachmentIds = pendingAttachments
      .filter(a => !a.uploading && !a.error)
      .map(a => a.id);
    setPendingAttachments([]);

    // Remove queued bubble if this was auto-sent from queue
    setMessages(prev => prev.filter(m => !m.id.startsWith('queued_')));
    setIsResponding(true);

    setMessages(prev => [...prev, {
      id: `user_${Date.now()}`,
      type: 'user',
      content: userMessage,
      timestamp: Date.now(),
      attachments: attachmentIds.length > 0 ? attachmentIds : undefined,
    }]);

    abortControllerRef.current = new AbortController();

    try {
      await sendChatMessage(
        agentId,
        sessionId,
        userMessage,
        abortControllerRef.current.signal,
        undefined,
        attachmentIds.length > 0 ? attachmentIds : undefined,
      );
    } catch (error) {
      if (error instanceof Error && error.name === 'AbortError') {
        setIsResponding(false);
      } else {
        console.error('Failed to send message:', error);
        setMessages(prev => [...prev, {
          id: `error_send_${Date.now()}`,
          type: 'error',
          content: `Failed to send: ${error instanceof Error ? error.message : 'Unknown error'}`,
          timestamp: Date.now(),
        }]);
        setIsResponding(false);
      }
    }
  };

  // Keep the ref current so the onTurnEnd callback can call it
  sendMessageDirectRef.current = sendMessageDirect;

  /** Queue a message to be sent when the current turn ends. */
  const queueMessage = (userMessage: string) => {
    queuedMessageRef.current = userMessage;
    setHasQueuedMessage(true);

    // Show the queued message as a user bubble immediately
    setMessages(prev => {
      // Remove any previous queued bubble
      const filtered = prev.filter(m => !m.id.startsWith('queued_'));
      return [...filtered, {
        id: `queued_${Date.now()}`,
        type: 'user' as const,
        content: userMessage,
        timestamp: Date.now(),
      }];
    });
  };

  /** Interrupt current generation and send the new message. */
  const interruptAndSend = async (userMessage: string) => {
    // Clear any queued message
    queuedMessageRef.current = null;
    setHasQueuedMessage(false);
    // Remove queued bubble if present
    setMessages(prev => prev.filter(m => !m.id.startsWith('queued_')));

    // Stop current generation
    abortControllerRef.current?.abort();
    abortControllerRef.current = null;
    stopChatResponse(agentId, sessionId).catch(console.error);
    setIsResponding(false);

    // Brief delay to let the abort propagate
    await new Promise(resolve => setTimeout(resolve, 100));

    // Send the new message
    await sendMessageDirect(userMessage);
  };

  /** Primary send handler — routes to direct send, queue, or no-op based on state. */
  const sendMessage = async () => {
    if (!inputValue.trim() || sessionStatus !== 'running') return;
    const userMessage = inputValue.trim();
    setInputValue('');

    if (!isResponding) {
      await sendMessageDirect(userMessage);
    } else {
      // Queue the message — it will be sent when the current turn ends
      queueMessage(userMessage);
    }
  };

  const handleStopResponse = () => {
    abortControllerRef.current?.abort();
    abortControllerRef.current = null;
    stopChatResponse(agentId, sessionId).catch(console.error);
    setIsResponding(false);
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();

      if (e.metaKey || e.ctrlKey) {
        // Cmd/Ctrl+Enter — interrupt generation and send immediately
        if (inputValue.trim() && sessionStatus === 'running') {
          const msg = inputValue.trim();
          setInputValue('');
          if (isResponding) {
            interruptAndSend(msg);
          } else {
            sendMessageDirect(msg);
          }
        }
      } else {
        // Enter — normal send or queue
        sendMessage();
      }
    }
  };

  // ── Session restart ───────────────────────────────────────────────────────

  const [isRestarting, setIsRestarting] = useState(false);

  const handleRestart = async () => {
    if (isRestarting) return;
    setIsRestarting(true);
    try {
      await restartChatSession(agentId, sessionId);
      setSessionStatus('starting');
      // Reset history gate so the session reloads when the new container is ready
      historyLoadedRef.current = false;
      chatStream.resetStreamCursor();
    } catch (err) {
      console.error('Failed to restart session:', err);
      setMessages(prev => [...prev, {
        id: `error_restart_${Date.now()}`,
        type: 'error',
        content: `Failed to restart session: ${err instanceof Error ? err.message : 'Unknown error'}`,
        timestamp: Date.now(),
      }]);
    } finally {
      setIsRestarting(false);
    }
  };

  // ── Connection badge ───────────────────────────────────────────────────────

  const ConnectionBadge = () => {
    if (connectionStatus === 'connected') {
      return (
        <Badge variant="outline" className="text-[10px] h-5 px-1.5 text-green-500 border-green-500/30 gap-1">
          <Wifi className="h-2.5 w-2.5" />
          Live
        </Badge>
      );
    }
    if (connectionStatus === 'connecting') {
      return (
        <Badge variant="outline" className="text-[10px] h-5 px-1.5 text-yellow-500 border-yellow-500/30 gap-1">
          <Loader2 className="h-2.5 w-2.5 animate-spin" />
          Connecting
        </Badge>
      );
    }
    if (connectionStatus === 'error') {
      return (
        <Badge variant="outline" className="text-[10px] h-5 px-1.5 text-red-500 border-red-500/30 gap-1">
          <AlertCircle className="h-2.5 w-2.5" />
          Error
        </Badge>
      );
    }
    return (
      <Badge variant="outline" className="text-[10px] h-5 px-1.5 text-muted-foreground gap-1">
        <WifiOff className="h-2.5 w-2.5" />
        Off
      </Badge>
    );
  };

  // ── Render ─────────────────────────────────────────────────────────────────

  // Read streaming refs (the streamingTick dependency ensures re-render on each rAF flush)
  // Read streamingTick so React re-renders when the ref values change
  void streamingTick;
  const liveText = streamingTextRef.current;
  const liveThinking = streamingThinkingRef.current;
  const isReady = sessionStatus === 'running';

  return (
    <div className="flex flex-col h-full min-h-0 overflow-hidden">
      {/* Connection status strip */}
      <div className="flex items-center gap-2 px-3 py-1.5 border-b bg-muted/10 shrink-0">
        <ConnectionBadge />
        {sessionStatus === 'starting' && (
          <span className="text-xs text-muted-foreground flex items-center gap-1 ml-auto">
            <Loader2 className="h-3 w-3 animate-spin" />
            Starting&hellip;
          </span>
        )}
        {sessionStatus === 'idle' && (
          <div className="flex items-center gap-2 ml-auto">
            <span className="text-xs text-muted-foreground">Session ended</span>
            <button
              onClick={handleRestart}
              disabled={isRestarting}
              className="flex items-center gap-1 text-xs text-primary hover:text-primary/80 transition-colors px-2 py-0.5 rounded hover:bg-accent disabled:opacity-50"
              title="Restart session with a new container"
            >
              {isRestarting ? (
                <Loader2 className="h-3 w-3 animate-spin" />
              ) : (
                <RotateCcw className="h-3 w-3" />
              )}
              Restart
            </button>
          </div>
        )}
        {isResponding && (
          <span className="text-xs text-muted-foreground ml-auto flex items-center gap-1">
            <Loader2 className="h-3 w-3 animate-spin text-primary" />
            Generating&hellip;
          </span>
        )}
      </div>

      {/* Messages */}
      <ScrollArea className="flex-1 px-4 py-3" ref={scrollAreaRef}>
        <div className="space-y-4">
          {messages.length === 0 && sessionStatus === 'starting' && (
            <div className="flex flex-col items-center justify-center h-40 text-muted-foreground gap-3">
              <span className="text-3xl">{agentEmoji || '\uD83E\uDD16'}</span>
              <div className="flex items-center gap-2 text-sm">
                <Loader2 className="h-4 w-4 animate-spin" />
                <span>Starting {agentName}&hellip;</span>
              </div>
            </div>
          )}
          {messages.length === 0 && sessionStatus === 'running' && (
            <div className="flex flex-col items-center justify-center h-40 text-muted-foreground gap-2">
              <span className="text-3xl">{agentEmoji || '\uD83E\uDD16'}</span>
              <span className="text-sm font-medium">{agentName} is ready</span>
              <span className="text-xs">Send a message to begin</span>
            </div>
          )}
          {messages.map(msg => {
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
          {isResponding && !isStreaming && (
            <div className="flex items-center gap-2 text-muted-foreground text-sm pl-1">
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
              <span>{agentName} is thinking&hellip;</span>
            </div>
          )}
          {/* Auto-scroll sentinel */}
          <div ref={scrollSentinelRef} className="h-px" />
        </div>
      </ScrollArea>

      {/* Input */}
      <FileUploadZone
        agentId={agentId}
        sessionId={sessionId}
        disabled={!isReady}
        attachments={pendingAttachments}
        onAttachmentsChange={setPendingAttachments}
      >
      <div className="border-t bg-background shrink-0">
        {/* Top-edge resize handle — drag upward to grow the input */}
        <div
          className="h-1.5 cursor-ns-resize group flex items-center justify-center hover:bg-accent/40 transition-colors"
          onMouseDown={e => {
            e.preventDefault();
            inputResizeRef.current = { startY: e.clientY, startH: inputHeight };
            document.body.style.cursor = 'ns-resize';
            document.body.style.userSelect = 'none';
          }}
        >
          <div className="w-8 h-0.5 rounded-full bg-muted-foreground/25 group-hover:bg-muted-foreground/50 transition-colors" />
        </div>
        <div className="px-3 pb-[calc(0.75rem+env(safe-area-inset-bottom,0px))]">
        {/* Pending attachment chips */}
        {pendingAttachments.length > 0 && (
          <div className="flex flex-wrap gap-1.5 pt-2 pb-1.5">
            {pendingAttachments.map(att => (
              <AttachmentChip
                key={att.id}
                attachment={att}
                onRemove={(id) => setPendingAttachments(prev => prev.filter(a => a.id !== id))}
              />
            ))}
          </div>
        )}
        <div className="flex gap-2 items-end">
          <button
            onClick={() => fileInputRef2.current?.click()}
            disabled={!isReady}
            className="p-2 rounded hover:bg-accent text-muted-foreground hover:text-foreground transition-colors disabled:opacity-50 self-end mb-[5px]"
            title="Attach file"
            type="button"
          >
            <Paperclip className="h-4 w-4" />
          </button>
          <input
            ref={fileInputRef2}
            type="file"
            multiple
            className="hidden"
            accept=".jpg,.jpeg,.png,.gif,.webp,.pdf,.txt,.md,.csv,.json,.py,.js,.ts,.html,.css,.xml,.yaml,.yml"
            onChange={async e => {
              if (!e.target.files?.length) return;
              const files = Array.from(e.target.files);
              e.target.value = ''; // Reset immediately so same file can be re-selected

              for (const file of files) {
                const placeholderId = `uploading_${Date.now()}_${file.name}`;
                setPendingAttachments(prev => [...prev, {
                  id: placeholderId,
                  filename: file.name,
                  mimeType: file.type || 'application/octet-stream',
                  sizeBytes: file.size,
                  isImage: file.type.startsWith('image/'),
                  estimatedTokens: null,
                  uploading: true,
                }]);
                try {
                  const result = await uploadChatAttachment(agentId, sessionId, file);
                  setPendingAttachments(prev =>
                    prev.map(a => a.id === placeholderId ? {
                      id: result.id,
                      filename: result.filename,
                      mimeType: result.mimeType,
                      sizeBytes: result.sizeBytes,
                      isImage: result.isImage,
                      estimatedTokens: result.estimatedTokens,
                    } : a)
                  );
                } catch (err) {
                  setPendingAttachments(prev =>
                    prev.map(a => a.id === placeholderId ? {
                      ...a,
                      uploading: false,
                      error: err instanceof Error ? err.message : 'Upload failed',
                    } : a)
                  );
                }
              }
            }}
          />
          <Textarea
            ref={inputRef}
            value={inputValue}
            onChange={e => setInputValue(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder={
              isReady
                ? (isResponding
                  ? `Type to queue or \u2318Enter to interrupt\u2026`
                  : `Message ${agentName}\u2026`)
                : sessionStatus === 'starting'
                  ? 'Waiting for session to start\u2026'
                  : 'Session ended'
            }
            disabled={!isReady}
            className="resize-none text-base sm:text-sm"
            style={{ height: inputHeight, minHeight: 44, maxHeight: '50vh' }}
            rows={1}
          />
          {isResponding ? (
            <Button
              onClick={handleStopResponse}
              variant="destructive"
              size="sm"
              className="h-[44px] w-[44px] shrink-0"
              title="Stop generation"
            >
              <StopCircle className="h-4 w-4" />
            </Button>
          ) : (
            <Button
              onClick={sendMessage}
              disabled={!isReady || !inputValue.trim()}
              size="sm"
              className="h-[44px] w-[44px] shrink-0"
            >
              <Send className="h-4 w-4" />
            </Button>
          )}
        </div>
        <p className="text-[10px] text-muted-foreground mt-1.5">
          {isResponding
            ? (hasQueuedMessage
              ? 'Message queued \u2014 will send when agent finishes'
              : 'Enter to queue \u00B7 \u2318Enter to interrupt \u00B7 Shift+Enter for new line')
            : 'Enter to send \u00B7 Shift+Enter for new line'}
        </p>
        </div>
      </div>
      </FileUploadZone>
    </div>
  );
}
