/**
 * LiveStatusBar — sticky status header showing the agent's current state.
 *
 * Displays: state pill (with animation), current work description,
 * queue depth, pulse countdown, and SSE connection indicator.
 */

import { Badge } from '@/components/ui/badge';
import { Layers, Wifi, WifiOff } from 'lucide-react';
import { cn } from '@/lib/utils';
import { formatDistanceToNow } from 'date-fns';
import type { AgentCurrentState } from '@/hooks/useActivityStream';

interface LiveStatusBarProps {
  currentState: AgentCurrentState | null;
  sseStatus: 'connecting' | 'connected' | 'error' | 'closed';
  queueDepth?: number;
}

const STATE_STYLES: Record<string, { dot: string; bg: string; text: string; label: string }> = {
  idle: {
    dot: 'bg-emerald-400',
    bg: 'bg-emerald-500/10 border-emerald-500/20',
    text: 'text-emerald-400',
    label: 'Idle',
  },
  working: {
    dot: 'bg-blue-400',
    bg: 'bg-blue-500/10 border-blue-500/20',
    text: 'text-blue-400',
    label: 'Working',
  },
  thinking: {
    dot: 'bg-purple-400',
    bg: 'bg-purple-500/10 border-purple-500/20',
    text: 'text-purple-400',
    label: 'Thinking',
  },
};

export function LiveStatusBar({ currentState, sseStatus, queueDepth }: LiveStatusBarProps) {
  const state = currentState?.state || 'idle';
  const styles = STATE_STYLES[state] || STATE_STYLES.idle;
  const isActive = state !== 'idle';
  const lastActive = currentState?.lastActive;

  return (
    <div className="flex items-center justify-between px-4 py-2.5 border-b border-border/50 bg-card/50 backdrop-blur-sm">
      {/* Left: State pill */}
      <div className="flex items-center gap-3">
        <div className={cn('flex items-center gap-2 rounded-full border px-3 py-1', styles.bg)}>
          <span className={cn(
            'h-2 w-2 rounded-full',
            styles.dot,
            isActive && 'animate-pulse',
          )} />
          <span className={cn('text-sm font-medium', styles.text)}>
            {styles.label}
          </span>
        </div>

        {/* Current work description */}
        {currentState?.currentWork && (
          <span className="text-sm text-muted-foreground">
            <span className="text-foreground/70">
              {currentState.currentWork.stepType}
            </span>
            {currentState.currentWork.runId && currentState.currentWork.runId !== 'pulse' && (
              <span className="text-muted-foreground/60 ml-1.5 font-mono text-xs">
                {currentState.currentWork.runId.slice(0, 8)}
              </span>
            )}
          </span>
        )}

        {/* Last active */}
        {!isActive && lastActive && (
          <span className="text-xs text-muted-foreground">
            Last active {formatDistanceToNow(lastActive, { addSuffix: true })}
          </span>
        )}
      </div>

      {/* Right: Badges */}
      <div className="flex items-center gap-2">
        {/* Queue depth */}
        {queueDepth != null && queueDepth > 0 && (
          <Badge variant="outline" className="text-xs gap-1">
            <Layers className="h-3 w-3" />
            {queueDepth} queued
          </Badge>
        )}

        {/* SSE status */}
        <div className={cn(
          'flex items-center gap-1 text-[11px]',
          sseStatus === 'connected' ? 'text-emerald-500' : 'text-muted-foreground',
        )}>
          {sseStatus === 'connected' ? (
            <Wifi className="h-3 w-3" />
          ) : (
            <WifiOff className="h-3 w-3" />
          )}
          <span className="hidden sm:inline">
            {sseStatus === 'connected' ? 'Live' : sseStatus === 'connecting' ? 'Connecting...' : 'Disconnected'}
          </span>
        </div>
      </div>
    </div>
  );
}
