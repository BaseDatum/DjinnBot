import { useState, useCallback, memo } from 'react';
import { MarkdownRenderer } from '@/components/MarkdownRenderer';
import { ToolCallCard } from '@/components/ToolCallCard';
import { Badge } from '@/components/ui/badge';
import { Brain, ChevronDown, ChevronRight, User, Bot, AlertCircle, Info, Copy, Check, Paperclip } from 'lucide-react';
import { getAttachmentContentUrl } from '@/lib/api';
import { cn } from '@/lib/utils';

// ── Copy button helper ────────────────────────────────────────────────────────

function CopyButton({ getText, className }: { getText: () => string; className?: string }) {
  const [copied, setCopied] = useState(false);

  const handleCopy = useCallback(async (e: React.MouseEvent) => {
    e.stopPropagation();
    try {
      await navigator.clipboard.writeText(getText());
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      // Fallback for non-secure contexts
      const ta = document.createElement('textarea');
      ta.value = getText();
      ta.style.position = 'fixed';
      ta.style.opacity = '0';
      document.body.appendChild(ta);
      ta.select();
      document.execCommand('copy');
      document.body.removeChild(ta);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    }
  }, [getText]);

  return (
    <button
      onClick={handleCopy}
      className={cn(
        'opacity-0 group-hover:opacity-100 transition-opacity',
        'p-1 rounded hover:bg-black/10 dark:hover:bg-white/10',
        'text-muted-foreground hover:text-foreground',
        className,
      )}
      title={copied ? 'Copied!' : 'Copy message'}
      aria-label="Copy message content"
    >
      {copied ? <Check className="h-3.5 w-3.5 text-green-500" /> : <Copy className="h-3.5 w-3.5" />}
    </button>
  );
}

export interface ChatMessageData {
  id: string;
  type: 'user' | 'assistant' | 'thinking' | 'tool_call' | 'system' | 'error' | 'handoff';
  content?: string;
  toolName?: string;
  args?: Record<string, unknown>;
  result?: string;
  isError?: boolean;
  durationMs?: number;
  timestamp: number;
  model?: string;
  thinking?: string;
  toolCalls?: any[];
  /** Attachment IDs for user messages (from upload) */
  attachments?: string[];

  // ── Onboarding agent metadata (optional — only present in onboarding) ───
  /** Which agent produced this message (e.g. "stas", "jim") */
  agentId?: string;
  /** Display name of the agent */
  agentName?: string;
  /** Emoji avatar of the agent */
  agentEmoji?: string;
  /** For handoff messages: the target agent being handed off to */
  handoffTo?: string;
  /** For handoff messages: context keys that were transferred */
  handoffContextKeys?: string[];
}

interface ChatMessageProps {
  message: ChatMessageData;
  isStreaming?: boolean;
  /**
   * When provided, overrides message.content for streaming assistant messages.
   * This allows the parent to pass the mutable ref value directly without
   * needing to copy it into the messages array on every frame.
   */
  streamingContent?: string;
  /**
   * When provided, overrides message.content for streaming thinking messages.
   */
  streamingThinking?: string;
}

export const ChatMessage = memo(function ChatMessage({
  message,
  isStreaming,
  streamingContent,
  streamingThinking,
}: ChatMessageProps) {
  const [thinkingExpanded, setThinkingExpanded] = useState(false);
  
  // User message
  if (message.type === 'user') {
    const hasAttachments = message.attachments && message.attachments.length > 0;
    return (
      <div className="group flex gap-3 justify-end">
        <CopyButton getText={() => message.content || ''} className="self-start mt-1" />
        <div className="max-w-[80%] rounded-2xl rounded-tr-sm bg-primary text-primary-foreground px-4 py-2 overflow-hidden">
          {hasAttachments && (
            <div className="flex flex-wrap gap-1 mb-1.5">
              {message.attachments!.map(attId => (
                <a
                  key={attId}
                  href={getAttachmentContentUrl(attId)}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="inline-flex items-center gap-1 text-xs bg-white/15 hover:bg-white/25 rounded px-1.5 py-0.5 transition-colors"
                >
                  <Paperclip className="h-3 w-3" />
                  <span className="truncate max-w-[120px]">{attId}</span>
                </a>
              ))}
            </div>
          )}
          <p className="text-sm whitespace-pre-wrap break-words overflow-wrap-anywhere">{message.content}</p>
        </div>
        <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-muted">
          <User className="h-4 w-4" />
        </div>
      </div>
    );
  }
  
  // Assistant message
  if (message.type === 'assistant') {
    const displayContent = isStreaming && streamingContent !== undefined
      ? streamingContent
      : (message.content || '');

    const hasAgentEmoji = !!message.agentEmoji;
    const hasAgentIdentity = !!message.agentName;

    return (
      <div className={cn(
        'group flex gap-3',
        hasAgentIdentity && 'border-l-2 border-l-primary/40 pl-1 rounded-sm bg-[radial-gradient(circle_at_10%_50%,rgba(var(--primary-rgb,99,102,241),0.04)_0%,transparent_50%)]',
      )}>
        <div className={cn(
          'flex h-8 w-8 shrink-0 items-center justify-center rounded-full',
          hasAgentIdentity
            ? 'bg-primary/10 ring-2 ring-primary/20 transition-shadow'
            : hasAgentEmoji
              ? 'bg-primary/10 ring-1 ring-primary/20'
              : 'bg-primary/10',
        )}>
          {hasAgentEmoji ? (
            <span className="text-base leading-none">{message.agentEmoji}</span>
          ) : (
            <Bot className="h-4 w-4 text-primary" />
          )}
        </div>
        <div className="flex-1 min-w-0 max-w-[80%] overflow-hidden">
          {hasAgentIdentity && (
            <span className="text-[10px] font-semibold uppercase tracking-wider mb-1 block text-primary/70">
              {message.agentName}
            </span>
          )}
          <div className="rounded-2xl rounded-tl-sm bg-muted px-4 py-2 overflow-hidden">
            {message.model && (
              <div className="flex items-center gap-2 mb-2">
                <Badge variant="outline" className="text-xs">
                  {message.model.split('/').pop()}
                </Badge>
              </div>
            )}
            <div className="text-sm break-words overflow-hidden" style={{ overflowWrap: 'anywhere' }}>
              {isStreaming ? (
                // Plain text during streaming — avoids O(n^2) markdown re-parse per token
                <p className="whitespace-pre-wrap leading-relaxed break-words">
                  {displayContent}
                  <span className="text-primary animate-pulse">&#9610;</span>
                </p>
              ) : (
                <MarkdownRenderer content={displayContent} />
              )}
            </div>
          </div>
        </div>
        {!isStreaming && <CopyButton getText={() => displayContent} className="self-start mt-1" />}
      </div>
    );
  }
  
  // Thinking block
  if (message.type === 'thinking') {
    const displayContent = isStreaming && streamingThinking !== undefined
      ? streamingThinking
      : (message.content || '');

    return (
      <div className="group flex gap-3">
        <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-purple-500/10">
          <Brain className={cn("h-4 w-4 text-purple-500", isStreaming && "animate-pulse")} />
        </div>
        <div className="flex-1 min-w-0 max-w-[80%] overflow-hidden">
          <button
            onClick={() => setThinkingExpanded(!thinkingExpanded)}
            className="flex items-center gap-2 text-xs text-purple-500 hover:text-purple-400 transition-colors"
          >
            {thinkingExpanded ? (
              <ChevronDown className="h-3 w-3" />
            ) : (
              <ChevronRight className="h-3 w-3" />
            )}
            <span className="font-medium">Thinking</span>
            {isStreaming && <span className="animate-pulse">&#9679;</span>}
            {!thinkingExpanded && displayContent && (
              <span className="ml-2 truncate text-purple-500/50 max-w-[250px]">
                {displayContent.slice(0, 60)}&hellip;
              </span>
            )}
          </button>
          
          {thinkingExpanded && (
            <div className="mt-2 rounded-lg border border-purple-500/20 bg-purple-500/5 px-3 py-2">
              <p className="text-xs text-purple-300/80 whitespace-pre-wrap font-mono leading-relaxed max-h-64 overflow-auto">
                {displayContent}
                {isStreaming && <span className="animate-pulse">&#9610;</span>}
              </p>
            </div>
          )}
        </div>
        {!isStreaming && displayContent && <CopyButton getText={() => displayContent} className="self-start mt-0.5" />}
      </div>
    );
  }
  
  // Tool call
  if (message.type === 'tool_call') {
    return (
      <div className="group flex gap-3">
        <div className="w-8" /> {/* Spacer for alignment */}
        <div className="flex-1 min-w-0 max-w-[85%] overflow-hidden">
          <ToolCallCard
            toolName={message.toolName || 'unknown'}
            args={message.args ? JSON.stringify(message.args, null, 2) : undefined}
            result={message.result}
            isError={message.isError}
            durationMs={message.durationMs}
            status={isStreaming ? 'running' : (message.result ? (message.isError ? 'error' : 'complete') : 'running')}
          />
        </div>
        {!isStreaming && message.result && (
          <CopyButton
            getText={() => {
              const parts = [`Tool: ${message.toolName || 'unknown'}`];
              if (message.args) parts.push(`Args: ${JSON.stringify(message.args, null, 2)}`);
              if (message.result) parts.push(`Result: ${message.result}`);
              return parts.join('\n');
            }}
            className="self-start mt-1"
          />
        )}
      </div>
    );
  }
  
  // System message
  if (message.type === 'system') {
    return (
      <div className="flex items-center justify-center gap-2 py-2">
        <div className="h-px flex-1 bg-border" />
        <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
          <Info className="h-3 w-3" />
          <span>{message.content}</span>
        </div>
        <div className="h-px flex-1 bg-border" />
      </div>
    );
  }
  
  // Error message
  if (message.type === 'error') {
    return (
      <div className="group flex gap-3">
        <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-destructive/10">
          <AlertCircle className="h-4 w-4 text-destructive" />
        </div>
        <div className="max-w-[80%] rounded-2xl rounded-tl-sm bg-destructive/10 border border-destructive/20 px-4 py-2 overflow-hidden">
          <p className="text-sm text-destructive break-words" style={{ overflowWrap: 'anywhere' }}>{message.content}</p>
        </div>
        <CopyButton getText={() => message.content || ''} className="self-start mt-1" />
      </div>
    );
  }
  
  return null;
});
