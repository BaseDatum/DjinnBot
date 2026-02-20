import { useState, memo } from 'react';
import { MarkdownRenderer } from '@/components/MarkdownRenderer';
import { ToolCallCard } from '@/components/ToolCallCard';
import { Badge } from '@/components/ui/badge';
import { Brain, ChevronDown, ChevronRight, User, Bot, AlertCircle, Info } from 'lucide-react';
import { cn } from '@/lib/utils';

export interface ChatMessageData {
  id: string;
  type: 'user' | 'assistant' | 'thinking' | 'tool_call' | 'system' | 'error';
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
    return (
      <div className="flex gap-3 justify-end">
        <div className="max-w-[80%] rounded-2xl rounded-tr-sm bg-primary text-primary-foreground px-4 py-2">
          <p className="text-sm whitespace-pre-wrap">{message.content}</p>
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

    return (
      <div className="flex gap-3">
        <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-primary/10">
          <Bot className="h-4 w-4 text-primary" />
        </div>
        <div className="max-w-[80%] rounded-2xl rounded-tl-sm bg-muted px-4 py-2">
          {message.model && (
            <div className="flex items-center gap-2 mb-2">
              <span className="font-medium text-xs text-muted-foreground">Assistant</span>
              <Badge variant="outline" className="text-xs">
                {message.model.split('/').pop()}
              </Badge>
            </div>
          )}
          <div className="text-sm">
            {isStreaming ? (
              // Plain text during streaming — avoids O(n^2) markdown re-parse per token
              <p className="whitespace-pre-wrap leading-relaxed">
                {displayContent}
                <span className="text-primary animate-pulse">&#9610;</span>
              </p>
            ) : (
              <MarkdownRenderer content={displayContent} />
            )}
          </div>
        </div>
      </div>
    );
  }
  
  // Thinking block
  if (message.type === 'thinking') {
    const displayContent = isStreaming && streamingThinking !== undefined
      ? streamingThinking
      : (message.content || '');

    return (
      <div className="flex gap-3">
        <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-purple-500/10">
          <Brain className={cn("h-4 w-4 text-purple-500", isStreaming && "animate-pulse")} />
        </div>
        <div className="flex-1 max-w-[80%]">
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
      </div>
    );
  }
  
  // Tool call
  if (message.type === 'tool_call') {
    return (
      <div className="flex gap-3">
        <div className="w-8" /> {/* Spacer for alignment */}
        <div className="flex-1 max-w-[85%]">
          <ToolCallCard
            toolName={message.toolName || 'unknown'}
            args={message.args ? JSON.stringify(message.args, null, 2) : undefined}
            result={message.result}
            isError={message.isError}
            durationMs={message.durationMs}
            status={isStreaming ? 'running' : (message.result ? (message.isError ? 'error' : 'complete') : 'running')}
          />
        </div>
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
      <div className="flex gap-3">
        <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-destructive/10">
          <AlertCircle className="h-4 w-4 text-destructive" />
        </div>
        <div className="max-w-[80%] rounded-2xl rounded-tl-sm bg-destructive/10 border border-destructive/20 px-4 py-2">
          <p className="text-sm text-destructive">{message.content}</p>
        </div>
      </div>
    );
  }
  
  return null;
});
