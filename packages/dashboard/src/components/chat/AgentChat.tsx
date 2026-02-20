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
} from '@/lib/api';
import {
  Send,
  Loader2,
  Wifi,
  WifiOff,
  AlertCircle,
  StopCircle,
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

  const inputRef = useRef<HTMLTextAreaElement>(null);
  const abortControllerRef = useRef<AbortController | null>(null);
  const historyLoadedRef = useRef(false);

  // ── Streaming via shared hook ──────────────────────────────────────────────

  const chatStream = useChatStream({
    sessionId,
    enabled: sessionStatus !== 'idle' && sessionStatus !== 'stopping',
    onTurnEnd: useCallback(() => {
      setIsResponding(false);
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
        // Now release any queued SSE events
        markHistoryLoaded();

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

  const sendMessage = async () => {
    if (!inputValue.trim() || isResponding || sessionStatus !== 'running') return;
    const userMessage = inputValue.trim();
    setInputValue('');
    setIsResponding(true);

    setMessages(prev => [...prev, {
      id: `user_${Date.now()}`,
      type: 'user',
      content: userMessage,
      timestamp: Date.now(),
    }]);

    abortControllerRef.current = new AbortController();

    try {
      await sendChatMessage(agentId, sessionId, userMessage, abortControllerRef.current.signal);
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

  const handleStopResponse = () => {
    abortControllerRef.current?.abort();
    abortControllerRef.current = null;
    stopChatResponse(agentId, sessionId).catch(console.error);
    setIsResponding(false);
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      sendMessage();
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
          <span className="text-xs text-muted-foreground ml-auto">Session ended</span>
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
      <div className="border-t p-3 pb-[calc(0.75rem+env(safe-area-inset-bottom,0px))] bg-background shrink-0">
        <div className="flex gap-2 items-end">
          <Textarea
            ref={inputRef}
            value={inputValue}
            onChange={e => setInputValue(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder={
              isReady
                ? `Message ${agentName}\u2026`
                : sessionStatus === 'starting'
                  ? 'Waiting for session to start\u2026'
                  : 'Session ended'
            }
            disabled={!isReady || isResponding}
            className="min-h-[44px] max-h-[160px] resize-none text-base sm:text-sm"
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
            ? 'Click the red button to stop generation'
            : 'Enter to send \u00B7 Shift+Enter for new line'}
        </p>
      </div>
    </div>
  );
}
