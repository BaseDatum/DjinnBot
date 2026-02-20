import { useEffect, useRef, useState } from 'react';
import { Card, CardHeader, CardTitle, CardContent } from '@/components/ui/card';
import { PulseScheduleEditor } from '@/components/pulse';
import { PulseControls } from '@/components/settings/PulseControls';
import { updateAgentConfig } from '@/lib/api';
import { toast } from 'sonner';
import type { AgentConfig } from '@/types/config';

const PULSE_COLUMNS = ['Backlog', 'Planning', 'Ready', 'In Progress', 'Review', 'Blocked', 'Done', 'Failed'] as const;

interface AgentPulseTabProps {
  agentId: string;
  config: AgentConfig;
  onConfigChange: (config: AgentConfig) => void;
}

export function AgentPulseTab({ agentId, config, onConfigChange }: AgentPulseTabProps) {
  const [saveState, setSaveState] = useState<'idle' | 'saving' | 'saved' | 'error'>('idle');
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const feedbackTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Track whether this is the initial mount so we don't auto-save on first render.
  const isFirstRender = useRef(true);

  useEffect(() => {
    if (isFirstRender.current) {
      isFirstRender.current = false;
      return;
    }

    // Debounce: wait 800ms after the last change before saving.
    if (saveTimer.current) clearTimeout(saveTimer.current);
    setSaveState('saving');

    saveTimer.current = setTimeout(async () => {
      try {
        await updateAgentConfig(agentId, config);
        setSaveState('saved');
        if (feedbackTimer.current) clearTimeout(feedbackTimer.current);
        feedbackTimer.current = setTimeout(() => setSaveState('idle'), 2000);
      } catch {
        toast.error('Failed to save pulse configuration');
        setSaveState('error');
        if (feedbackTimer.current) clearTimeout(feedbackTimer.current);
        feedbackTimer.current = setTimeout(() => setSaveState('idle'), 3000);
      }
    }, 800);

    return () => {
      if (saveTimer.current) clearTimeout(saveTimer.current);
    };
  }, [config.pulseContainerTimeoutMs, config.pulseColumns]);

  const timeoutSeconds = Math.round((config.pulseContainerTimeoutMs ?? 120000) / 1000);

  return (
    <div className="space-y-6">
      {/* Status & Controls */}
      <PulseControls agentId={agentId} />

      {/* Container Timeout */}
      <Card>
        <CardHeader>
          <div className="flex items-center justify-between">
            <CardTitle>Container Timeout</CardTitle>
            {saveState === 'saving' && (
              <span className="text-xs text-muted-foreground animate-pulse">Saving…</span>
            )}
            {saveState === 'saved' && (
              <span className="text-xs text-green-500">&#x2713; Saved</span>
            )}
            {saveState === 'error' && (
              <span className="text-xs text-destructive">Failed to save</span>
            )}
          </div>
        </CardHeader>
        <CardContent className="space-y-4">
          <div>
            <label className="block text-sm font-medium mb-1">Execution Timeout (seconds)</label>
            <p className="text-xs text-muted-foreground mb-2">
              Maximum time the agent container is allowed to run during a pulse session.
              Increase this for agents that need to perform long-running tasks.
              Default: 120s (2 minutes).
            </p>
            <input
              type="number"
              min={30}
              step={30}
              value={timeoutSeconds}
              onChange={(e) => {
                const ms = (parseInt(e.target.value) || 120) * 1000;
                onConfigChange({ ...config, pulseContainerTimeoutMs: ms });
              }}
              className="h-10 w-40 rounded-md border border-input bg-background px-3 text-sm font-mono"
            />
            <p className="text-xs text-muted-foreground mt-1">
              {timeoutSeconds}s &mdash; {(timeoutSeconds / 60).toFixed(1)} minutes
            </p>
          </div>
        </CardContent>
      </Card>

      {/* Pulse Schedule */}
      <div className="pt-2 border-t">
        <h3 className="text-lg font-semibold mb-4">Pulse Schedule</h3>
        <PulseScheduleEditor agentId={agentId} />
      </div>

      {/* Pulse Columns */}
      <div className="pt-2 border-t">
        <div className="flex items-center justify-between mb-4">
          <h3 className="text-lg font-semibold">Pulse Columns</h3>
          {saveState === 'saving' && (
            <span className="text-xs text-muted-foreground animate-pulse">Saving…</span>
          )}
          {saveState === 'saved' && (
            <span className="text-xs text-green-500">&#x2713; Saved</span>
          )}
          {saveState === 'error' && (
            <span className="text-xs text-destructive">Failed to save</span>
          )}
        </div>
        <Card>
          <CardContent className="space-y-3 pt-4">
            <p className="text-xs text-muted-foreground">
              Kanban columns this agent scans for work during each pulse.
              Only tasks in these columns will appear via <code className="font-mono">get_ready_tasks</code>.
            </p>
            {PULSE_COLUMNS.map((col) => {
              const checked = (config.pulseColumns ?? []).includes(col);
              return (
                <label key={col} className="flex items-center gap-3 cursor-pointer select-none">
                  <input
                    type="checkbox"
                    checked={checked}
                    onChange={() => {
                      const current = config.pulseColumns ?? [];
                      onConfigChange({
                        ...config,
                        pulseColumns: checked
                          ? current.filter((c) => c !== col)
                          : [...current, col],
                      });
                    }}
                    className="h-4 w-4 rounded border"
                  />
                  <span className="text-sm">{col}</span>
                </label>
              );
            })}
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
