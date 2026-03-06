import { useState, useCallback } from 'react';
import { useSwarmSSE } from '@/hooks/useSwarmSSE';
import { SwarmDAG } from './SwarmDAG';
import { SwarmTimeline } from './SwarmTimeline';
import { SwarmTaskDetail } from './SwarmTaskDetail';
import { SwarmStatusBar } from './SwarmStatusBar';
import { Loader2 } from 'lucide-react';

interface SwarmViewProps {
  swarmId: string;
}

export function SwarmView({ swarmId }: SwarmViewProps) {
  const { state, connectionStatus, cancel } = useSwarmSSE({ swarmId });
  const [selectedTaskKey, setSelectedTaskKey] = useState<string | null>(null);

  const handleTaskClick = useCallback((key: string) => {
    setSelectedTaskKey(prev => prev === key ? null : key);
  }, []);

  const selectedTask = state?.tasks.find(t => t.key === selectedTaskKey) ?? null;

  // Loading state
  if (!state) {
    return (
      <div className="flex items-center justify-center h-full bg-zinc-950">
        <div className="flex flex-col items-center gap-3">
          <Loader2 className="w-8 h-8 animate-spin text-blue-500" />
          <span className="text-sm text-zinc-400">Connecting to swarm {swarmId}...</span>
        </div>
      </div>
    );
  }

  // Empty state (no tasks yet — swarm just dispatched)
  if (state.tasks.length === 0) {
    return (
      <div className="flex items-center justify-center h-full bg-zinc-950">
        <div className="flex flex-col items-center gap-3">
          <Loader2 className="w-6 h-6 animate-spin text-zinc-500" />
          <span className="text-sm text-zinc-400">Swarm initializing...</span>
        </div>
      </div>
    );
  }

  return (
    <div className="flex flex-col h-full bg-zinc-950">
      {/* Main content area */}
      <div className="flex-1 flex min-h-0">
        {/* Left: DAG view (takes available space) */}
        <div className="flex-1 min-w-0">
          <SwarmDAG tasks={state.tasks} onTaskClick={handleTaskClick} />
        </div>

        {/* Right: Timeline + Detail panels */}
        <div className="w-80 border-l border-zinc-800 flex flex-col min-h-0">
          {/* Top: Timeline */}
          <div className="h-1/2 border-b border-zinc-800 overflow-hidden">
            <SwarmTimeline state={state} />
          </div>

          {/* Bottom: Task detail or placeholder */}
          <div className="h-1/2 overflow-hidden">
            {selectedTask ? (
              <SwarmTaskDetail task={selectedTask} />
            ) : (
              <div className="flex items-center justify-center h-full text-zinc-600 text-xs">
                Click a task node to view details
              </div>
            )}
          </div>
        </div>
      </div>

      {/* Bottom: Status bar */}
      <SwarmStatusBar
        state={state}
        connectionStatus={connectionStatus}
        onCancel={cancel}
      />
    </div>
  );
}
