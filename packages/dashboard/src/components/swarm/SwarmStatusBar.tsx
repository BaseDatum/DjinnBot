import { Check, Loader2, Circle, X, SkipForward, Ban, Wifi, WifiOff } from 'lucide-react';
import type { SwarmState } from '@/hooks/useSwarmSSE';

interface SwarmStatusBarProps {
  state: SwarmState;
  connectionStatus: 'connecting' | 'connected' | 'error' | 'closed';
  onCancel: () => void;
}

export function SwarmStatusBar({ state, connectionStatus, onCancel }: SwarmStatusBarProps) {
  const completed = state.tasks.filter(t => t.status === 'completed').length;
  const running = state.tasks.filter(t => t.status === 'running').length;
  const pending = state.tasks.filter(t => t.status === 'pending' || t.status === 'ready').length;
  const failed = state.tasks.filter(t => t.status === 'failed').length;
  const skipped = state.tasks.filter(t => t.status === 'skipped').length;
  const cancelled = state.tasks.filter(t => t.status === 'cancelled').length;
  const isTerminal = state.status === 'completed' || state.status === 'failed' || state.status === 'cancelled';

  return (
    <div className="flex items-center gap-4 px-4 py-2 bg-zinc-900 border-t border-zinc-800 text-xs">
      {/* Status counts */}
      {completed > 0 && (
        <span className="flex items-center gap-1 text-green-400">
          <Check className="w-3 h-3" /> {completed} completed
        </span>
      )}
      {running > 0 && (
        <span className="flex items-center gap-1 text-blue-400">
          <Loader2 className="w-3 h-3 animate-spin" /> {running} running
        </span>
      )}
      {pending > 0 && (
        <span className="flex items-center gap-1 text-zinc-400">
          <Circle className="w-3 h-3" /> {pending} pending
        </span>
      )}
      {failed > 0 && (
        <span className="flex items-center gap-1 text-red-400">
          <X className="w-3 h-3" /> {failed} failed
        </span>
      )}
      {skipped > 0 && (
        <span className="flex items-center gap-1 text-zinc-500">
          <SkipForward className="w-3 h-3" /> {skipped} skipped
        </span>
      )}
      {cancelled > 0 && (
        <span className="flex items-center gap-1 text-zinc-500">
          <Ban className="w-3 h-3" /> {cancelled} cancelled
        </span>
      )}

      {/* Spacer */}
      <div className="flex-1" />

      {/* Connection indicator */}
      <span className="flex items-center gap-1 text-[10px] text-zinc-500">
        {connectionStatus === 'connected' ? (
          <><Wifi className="w-3 h-3 text-green-500" /> live</>
        ) : connectionStatus === 'connecting' ? (
          <><Loader2 className="w-3 h-3 animate-spin text-yellow-500" /> connecting</>
        ) : (
          <><WifiOff className="w-3 h-3 text-zinc-600" /> disconnected</>
        )}
      </span>

      {/* Cancel button — only when swarm is still running */}
      {!isTerminal && (
        <button
          onClick={onCancel}
          className="px-3 py-1 rounded text-[10px] font-medium bg-red-900/50 text-red-300 hover:bg-red-900 border border-red-800 transition-colors"
        >
          Cancel Swarm
        </button>
      )}
    </div>
  );
}
