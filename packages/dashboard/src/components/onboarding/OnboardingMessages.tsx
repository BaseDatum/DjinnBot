/**
 * OnboardingMessages — Agent-specific message rendering for onboarding chat.
 *
 * Provides:
 * - `OnboardingAgentMessage`: wraps standard ChatMessage with per-agent visual
 *   identity (colored border, background pattern, emoji avatar ring)
 * - `HandoffCard`: cinematic transition card rendered between agent phases
 * - `CompletionOverlay`: "project is born" celebration moment
 * - `AGENT_VISUAL_CONFIG`: static config for all onboarding agent visual styles
 */

import { memo, type ReactNode } from 'react';
import { ChatMessage, type ChatMessageData } from '@/components/chat/ChatMessage';
import { MarkdownRenderer } from '@/components/MarkdownRenderer';
import { cn } from '@/lib/utils';
import { ChevronRight, Loader2, CheckCircle2, ArrowRight } from 'lucide-react';
import { Button } from '@/components/ui/button';

// ============================================================================
// Agent Visual Configuration
// ============================================================================

export interface AgentVisualStyle {
  /** CSS class for the left accent border on message bubbles */
  borderColor: string;
  /** Tailwind ring color for the avatar circle */
  avatarRing: string;
  /** Optional subtle background pattern on the message bubble */
  bgPattern: string;
  /** Agent accent color — used for composing dots, glows, etc. */
  accentText: string;
  accentBg: string;
}

/**
 * Per-agent visual signatures. Each agent gets a distinct color identity
 * so the user can feel the personality shift viscerally.
 *
 * Stas (SRE):       Terminal green — infrastructure, reliability
 * Jim (Finance):    Warm amber — business, strategy, warmth
 * Eric (Product):   Clean blue — clarity, focus, editorial
 * Finn (Architect): Deep teal — blueprints, structure, precision
 */
export const AGENT_VISUAL_CONFIG: Record<string, AgentVisualStyle> = {
  stas: {
    borderColor: 'border-l-emerald-500/50',
    avatarRing: 'ring-emerald-500/30',
    bgPattern: 'bg-[radial-gradient(circle_at_10%_50%,rgba(16,185,129,0.04)_0%,transparent_50%)]',
    accentText: 'text-emerald-500',
    accentBg: 'bg-emerald-500/10',
  },
  jim: {
    borderColor: 'border-l-amber-500/50',
    avatarRing: 'ring-amber-500/30',
    bgPattern: 'bg-[repeating-linear-gradient(135deg,transparent,transparent_8px,rgba(245,158,11,0.015)_8px,rgba(245,158,11,0.015)_9px)]',
    accentText: 'text-amber-500',
    accentBg: 'bg-amber-500/10',
  },
  eric: {
    borderColor: 'border-l-blue-500/50',
    avatarRing: 'ring-blue-500/30',
    bgPattern: '', // Clean, no pattern — editorial minimalism
    accentText: 'text-blue-500',
    accentBg: 'bg-blue-500/10',
  },
  finn: {
    borderColor: 'border-l-teal-500/50',
    avatarRing: 'ring-teal-500/30',
    bgPattern: 'bg-[linear-gradient(rgba(20,184,166,0.02)_1px,transparent_1px),linear-gradient(90deg,rgba(20,184,166,0.02)_1px,transparent_1px)] bg-[size:24px_24px]',
    accentText: 'text-teal-500',
    accentBg: 'bg-teal-500/10',
  },
};

/** Fallback style for unknown agents — neutral gray */
const DEFAULT_STYLE: AgentVisualStyle = {
  borderColor: 'border-l-primary/30',
  avatarRing: 'ring-primary/20',
  bgPattern: '',
  accentText: 'text-primary',
  accentBg: 'bg-primary/10',
};

export function getAgentStyle(agentId?: string): AgentVisualStyle {
  if (!agentId) return DEFAULT_STYLE;
  return AGENT_VISUAL_CONFIG[agentId] ?? DEFAULT_STYLE;
}

/** Agent metadata lookup — needed for handoff cards to show the target agent */
export const AGENT_META: Record<string, { name: string; emoji: string; role: string }> = {
  stas: { name: 'Stas', emoji: '🚀', role: 'SRE' },
  jim: { name: 'Jim', emoji: '💰', role: 'Strategy' },
  eric: { name: 'Eric', emoji: '📋', role: 'Product' },
  finn: { name: 'Finn', emoji: '🏗️', role: 'Architect' },
  done: { name: 'Complete', emoji: '✅', role: '' },
};

/** The canonical agent ordering in the onboarding relay */
export const AGENT_CHAIN = ['stas', 'jim', 'eric', 'finn'] as const;

// ============================================================================
// OnboardingAgentMessage — wraps ChatMessage with agent visual identity
// ============================================================================

interface OnboardingAgentMessageProps {
  message: ChatMessageData;
  isStreaming?: boolean;
  streamingContent?: string;
  streamingThinking?: string;
}

/**
 * Wraps the standard ChatMessage with per-agent visual personality:
 * - Colored left border
 * - Agent emoji avatar in a styled ring
 * - Agent name tag above the message
 * - Optional subtle background pattern
 */
export const OnboardingAgentMessage = memo(function OnboardingAgentMessage({
  message,
  isStreaming,
  streamingContent,
  streamingThinking,
}: OnboardingAgentMessageProps) {
  const style = getAgentStyle(message.agentId);
  const agentEmoji = message.agentEmoji || AGENT_META[message.agentId || '']?.emoji || '🤖';
  const agentName = message.agentName || AGENT_META[message.agentId || '']?.name || 'Assistant';

  // For thinking and tool_call types, delegate to ChatMessage unchanged
  // — the personality only wraps assistant text messages.
  if (message.type !== 'assistant') {
    return (
      <ChatMessage
        message={message}
        isStreaming={isStreaming}
        streamingContent={streamingContent}
        streamingThinking={streamingThinking}
      />
    );
  }

  const displayContent =
    isStreaming && streamingContent !== undefined
      ? streamingContent
      : message.content || '';

  return (
    <div className={cn('group flex gap-3 border-l-2 pl-1 rounded-sm', style.borderColor, style.bgPattern)}>
      {/* Agent avatar */}
      <div
        className={cn(
          'flex h-8 w-8 shrink-0 items-center justify-center rounded-full ring-2 transition-shadow',
          style.avatarRing,
          style.accentBg,
        )}
      >
        <span className="text-base leading-none">{agentEmoji}</span>
      </div>

      {/* Message body */}
      <div className="flex-1 min-w-0 max-w-[80%]">
        {/* Agent name tag */}
        <span className={cn('text-[10px] font-semibold uppercase tracking-wider mb-1 block', style.accentText)}>
          {agentName}
        </span>
        <div className="rounded-2xl rounded-tl-sm bg-muted px-4 py-2 overflow-hidden">
          <div className="text-sm break-words overflow-hidden" style={{ overflowWrap: 'anywhere' }}>
            {isStreaming ? (
              <p className="whitespace-pre-wrap leading-relaxed break-words">
                {displayContent}
                <span className={cn('animate-pulse', style.accentText)}>&#9610;</span>
              </p>
            ) : (
              <MarkdownRenderer content={displayContent} />
            )}
          </div>
        </div>
      </div>
    </div>
  );
});

// ============================================================================
// Composing Indicator — agent-styled typing dots
// ============================================================================

export function AgentComposingIndicator({
  agentId,
  agentEmoji,
}: {
  agentId?: string;
  agentEmoji?: string;
}) {
  const style = getAgentStyle(agentId);
  const emoji = agentEmoji || AGENT_META[agentId || '']?.emoji || '🚀';

  return (
    <div className={cn('flex gap-3 my-3 border-l-2 pl-1 rounded-sm', style.borderColor)}>
      <div
        className={cn(
          'flex h-8 w-8 shrink-0 items-center justify-center rounded-full ring-2',
          style.avatarRing,
          style.accentBg,
        )}
      >
        <span className="text-base leading-none">{emoji}</span>
      </div>
      <div className="max-w-[80%] rounded-2xl rounded-tl-sm bg-muted px-4 py-3">
        <div className="flex items-center gap-1.5">
          <span className={cn('h-2 w-2 rounded-full animate-bounce [animation-delay:0ms]', style.accentBg)} />
          <span className={cn('h-2 w-2 rounded-full animate-bounce [animation-delay:150ms]', style.accentBg)} />
          <span className={cn('h-2 w-2 rounded-full animate-bounce [animation-delay:300ms]', style.accentBg)} />
        </div>
      </div>
    </div>
  );
}

// ============================================================================
// HandoffCard — cinematic agent transition
// ============================================================================

/**
 * Extract the human-readable summary from a handoff message.
 * The content format is: "<emoji> <name> is handing off to <emoji> <name>. <summary>\n[context: ...]"
 * We want just the summary part — strip the leading announcement and trailing context tag.
 */
function extractSummary(content?: string): string {
  if (!content) return '';
  // Remove the [context: ...] line
  let text = content.replace(/\n?\[context:\s*.+?\]$/, '').trim();
  // Remove everything up to and including the first period after "handing off"
  const handoffIdx = text.indexOf('handing off');
  if (handoffIdx !== -1) {
    const periodIdx = text.indexOf('.', handoffIdx);
    if (periodIdx !== -1) {
      text = text.slice(periodIdx + 1).trim();
    }
  }
  // Also handle "has completed" phrasing for done handoffs
  const completedIdx = text.indexOf('has completed');
  if (completedIdx !== -1) {
    const periodIdx = text.indexOf('.', completedIdx);
    if (periodIdx !== -1) {
      text = text.slice(periodIdx + 1).trim();
    }
  }
  return text || 'Passing the conversation along.';
}

interface HandoffCardProps {
  message: ChatMessageData;
}

export const HandoffCard = memo(function HandoffCard({ message }: HandoffCardProps) {
  const fromMeta = AGENT_META[message.agentId || ''] ?? { name: 'Agent', emoji: '🤖', role: '' };
  const toMeta = AGENT_META[message.handoffTo || ''] ?? { name: 'Agent', emoji: '🤖', role: '' };
  const fromStyle = getAgentStyle(message.agentId);
  const toStyle = getAgentStyle(message.handoffTo);

  const isDone = message.handoffTo === 'done';
  const summary = extractSummary(message.content);
  const contextKeys = message.handoffContextKeys ?? [];

  if (isDone) {
    return <RelayCompleteCard fromAgent={message.agentId} summary={summary} />;
  }

  return (
    <div className="relative my-6 mx-auto max-w-md select-none">
      <div className="relative flex items-center justify-between bg-card border rounded-xl px-5 py-4 gap-3 shadow-sm animate-in fade-in slide-in-from-bottom-2 duration-500">
        {/* From agent */}
        <div className="flex flex-col items-center gap-1.5 z-10 animate-in fade-in slide-in-from-left-3 duration-500">
          <div
            className={cn(
              'h-11 w-11 rounded-full flex items-center justify-center text-xl ring-2 transition-all',
              fromStyle.avatarRing,
              fromStyle.accentBg,
            )}
          >
            {fromMeta.emoji}
          </div>
          <span className="text-[10px] font-semibold text-muted-foreground">{fromMeta.name}</span>
        </div>

        {/* Center — arrow + summary */}
        <div className="flex-1 px-3 z-10 animate-in fade-in duration-700 delay-150 min-w-0">
          <div className="flex items-center justify-center gap-1.5 mb-2">
            <div className="h-px flex-1 bg-gradient-to-r from-border to-transparent" />
            <ArrowRight className="h-4 w-4 text-primary shrink-0" />
            <div className="h-px flex-1 bg-gradient-to-l from-border to-transparent" />
          </div>
          <p className="text-[11px] text-center text-muted-foreground leading-snug line-clamp-3">
            {summary}
          </p>
        </div>

        {/* To agent */}
        <div className="flex flex-col items-center gap-1.5 z-10 animate-in fade-in slide-in-from-right-3 duration-500 delay-200">
          <div
            className={cn(
              'h-11 w-11 rounded-full flex items-center justify-center text-xl ring-2 transition-all',
              toStyle.avatarRing,
              toStyle.accentBg,
            )}
          >
            {toMeta.emoji}
          </div>
          <span className="text-[10px] font-semibold text-muted-foreground">{toMeta.name}</span>
        </div>
      </div>

      {/* Context pills — show what knowledge was transferred */}
      {contextKeys.length > 0 && (
        <div className="flex flex-wrap justify-center gap-1 mt-2 animate-in fade-in duration-500 delay-400">
          {contextKeys.map((key) => (
            <span
              key={key}
              className="text-[9px] px-1.5 py-0.5 rounded-full bg-primary/5 text-primary/70 border border-primary/10 font-medium"
            >
              {key.replace(/_/g, ' ')}
            </span>
          ))}
        </div>
      )}
    </div>
  );
});

// ── Relay complete variant — final handoff to "done" ──────────────────────

function RelayCompleteCard({ fromAgent, summary }: { fromAgent?: string; summary: string }) {
  return (
    <div className="relative my-6 mx-auto max-w-md select-none">
      <div className="bg-card border rounded-xl px-5 py-5 shadow-sm animate-in fade-in zoom-in-95 duration-500">
        {/* All agent avatars in a connected row */}
        <div className="flex items-center justify-center gap-2 mb-3">
          {AGENT_CHAIN.map((agentId, i) => {
            const meta = AGENT_META[agentId];
            const style = getAgentStyle(agentId);
            return (
              <div key={agentId} className="flex items-center gap-2">
                <div
                  className={cn(
                    'h-9 w-9 rounded-full flex items-center justify-center text-lg ring-2 animate-in fade-in duration-300',
                    style.avatarRing,
                    style.accentBg,
                  )}
                  style={{ animationDelay: `${i * 100}ms` }}
                >
                  {meta.emoji}
                </div>
                {i < AGENT_CHAIN.length - 1 && (
                  <CheckCircle2 className="h-3 w-3 text-primary/50 shrink-0" />
                )}
              </div>
            );
          })}
        </div>

        <p className="text-xs text-center text-muted-foreground leading-snug">
          {summary || 'All agents have completed the onboarding relay.'}
        </p>
      </div>
    </div>
  );
}

// ============================================================================
// CompletionOverlay — "Project is Born" celebration
// ============================================================================

interface CompletionOverlayProps {
  projectName?: string;
  projectId?: string;
  planningRunId?: string;
  onEnterProject: (projectId: string) => void;
}

export function CompletionOverlay({
  projectName,
  projectId,
  planningRunId,
  onEnterProject,
}: CompletionOverlayProps) {
  return (
    <div className="absolute inset-0 z-10 flex items-center justify-center bg-background/80 backdrop-blur-sm animate-in fade-in duration-500">
      <div className="max-w-lg w-full mx-4 animate-in zoom-in-95 slide-in-from-bottom-3 duration-500 delay-100">
        <div className="bg-card border rounded-2xl shadow-2xl overflow-hidden">
          {/* Accent gradient bar */}
          <div className="h-1.5 bg-gradient-to-r from-emerald-500 via-primary to-amber-500" />

          <div className="px-8 py-8 text-center">
            {/* Agent relay visualization */}
            <div className="flex items-center justify-center gap-2.5 mb-6">
              {AGENT_CHAIN.map((agentId, i) => {
                const meta = AGENT_META[agentId];
                const style = getAgentStyle(agentId);
                return (
                  <div key={agentId} className="flex items-center gap-2.5">
                    <div
                      className={cn(
                        'flex flex-col items-center gap-1 animate-in fade-in duration-300',
                      )}
                      style={{ animationDelay: `${200 + i * 150}ms` }}
                    >
                      <div
                        className={cn(
                          'h-10 w-10 rounded-full flex items-center justify-center text-lg ring-2',
                          style.avatarRing,
                          style.accentBg,
                        )}
                      >
                        {meta.emoji}
                      </div>
                      <span className="text-[9px] font-medium text-muted-foreground">{meta.name}</span>
                    </div>
                    {i < AGENT_CHAIN.length - 1 && (
                      <CheckCircle2
                        className="h-3.5 w-3.5 text-primary/40 shrink-0 animate-in fade-in duration-300"
                        style={{ animationDelay: `${350 + i * 150}ms` }}
                      />
                    )}
                  </div>
                );
              })}
            </div>

            {/* Project name */}
            <h2 className="text-2xl font-bold tracking-tight mb-2 animate-in slide-in-from-bottom-2 fade-in duration-500 delay-500">
              {projectName || 'Your Project'}
            </h2>

            <p className="text-sm text-muted-foreground mb-6 animate-in fade-in duration-500 delay-700">
              {planningRunId
                ? 'The planning pipeline is running — your team is already breaking this down into tasks.'
                : 'Onboarding complete. Your project is ready.'}
            </p>

            {/* Live planning indicator */}
            {planningRunId && (
              <div className="flex items-center justify-center gap-2 mb-6 text-xs text-muted-foreground animate-in fade-in duration-500 delay-[800ms]">
                <Loader2 className="h-3.5 w-3.5 animate-spin text-primary" />
                <span>Finn is generating your task breakdown&hellip;</span>
              </div>
            )}

            {/* Action button */}
            {projectId && (
              <div className="animate-in slide-in-from-bottom-3 fade-in duration-500 delay-[900ms]">
                <Button
                  size="lg"
                  onClick={() => onEnterProject(projectId)}
                  className="px-8"
                >
                  Enter Your Project
                  <ChevronRight className="h-4 w-4 ml-1" />
                </Button>
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
