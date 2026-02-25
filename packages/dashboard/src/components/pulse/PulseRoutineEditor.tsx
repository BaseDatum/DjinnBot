import { useState, useEffect, useRef, useCallback } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { ProviderModelSelector } from '@/components/ui/ProviderModelSelector';
import {
  Moon,
  Plus,
  Trash2,
} from 'lucide-react';
import { toast } from 'sonner';
import { updatePulseRoutine } from '@/lib/api';
import type { PulseRoutine, PulseBlackout, UpdatePulseRoutineRequest } from '@/lib/api';

interface PulseRoutineEditorProps {
  routine: PulseRoutine;
  agentId: string;
  onUpdated: (routine: PulseRoutine) => void;
}



export function PulseRoutineEditor({ routine, agentId, onUpdated }: PulseRoutineEditorProps) {
  const [name, setName] = useState(routine.name);
  const [description, setDescription] = useState(routine.description || '');
  const [instructions, setInstructions] = useState(routine.instructions);
  const [intervalMinutes, setIntervalMinutes] = useState(routine.intervalMinutes);
  const [offsetMinutes, setOffsetMinutes] = useState(routine.offsetMinutes);
  const [timeoutMs, setTimeoutMs] = useState(routine.timeoutMs);
  const [maxConcurrent, setMaxConcurrent] = useState(routine.maxConcurrent);
  const [blackouts, setBlackouts] = useState<PulseBlackout[]>(routine.blackouts);
  const [planningModel, setPlanningModel] = useState(routine.planningModel || '');
  const [executorModel, setExecutorModel] = useState(routine.executorModel || '');

  const [saveState, setSaveState] = useState<'idle' | 'saving' | 'saved' | 'error'>('idle');
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const feedbackTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const dirty = useRef(false);

  // Blackout form state
  const [showAddBlackout, setShowAddBlackout] = useState(false);
  const [newBlackoutStart, setNewBlackoutStart] = useState('22:00');
  const [newBlackoutEnd, setNewBlackoutEnd] = useState('07:00');
  const [newBlackoutLabel, setNewBlackoutLabel] = useState('');

  // Debounced save
  const save = useCallback(async (updates: UpdatePulseRoutineRequest) => {
    if (saveTimer.current) clearTimeout(saveTimer.current);
    setSaveState('saving');

    saveTimer.current = setTimeout(async () => {
      try {
        const updated = await updatePulseRoutine(agentId, routine.id, updates);
        onUpdated(updated);
        setSaveState('saved');
        if (feedbackTimer.current) clearTimeout(feedbackTimer.current);
        feedbackTimer.current = setTimeout(() => setSaveState('idle'), 2000);
      } catch {
        toast.error('Failed to save routine');
        setSaveState('error');
        if (feedbackTimer.current) clearTimeout(feedbackTimer.current);
        feedbackTimer.current = setTimeout(() => setSaveState('idle'), 3000);
      }
    }, 800);
  }, [agentId, routine.id, onUpdated]);

  // Auto-save on changes (skip initial)
  const isFirstRender = useRef(true);
  useEffect(() => {
    if (isFirstRender.current) {
      isFirstRender.current = false;
      return;
    }
    if (!dirty.current) return;
    dirty.current = false;

    save({
      name,
      description: description || undefined,
      instructions,
      intervalMinutes,
      offsetMinutes,
      blackouts,
      timeoutMs: timeoutMs ?? undefined,
      maxConcurrent,
      planningModel: planningModel || undefined,
      executorModel: executorModel || undefined,
    });
  }, [name, description, instructions, intervalMinutes, offsetMinutes, blackouts, timeoutMs, maxConcurrent, planningModel, executorModel, save]);

  const markDirty = () => { dirty.current = true; };

  const timeoutSeconds = Math.round((timeoutMs ?? 120000) / 1000);

  return (
    <div className="space-y-4 border-t pt-4">
      {/* Save status */}
      <div className="flex items-center justify-between">
        <h4 className="text-sm font-medium text-muted-foreground">Edit Routine</h4>
        <div className="flex items-center gap-2">
          {saveState === 'saving' && (
            <span className="text-xs text-muted-foreground animate-pulse">Saving...</span>
          )}
          {saveState === 'saved' && (
            <span className="text-xs text-green-500">Saved</span>
          )}
          {saveState === 'error' && (
            <span className="text-xs text-destructive">Failed to save</span>
          )}
        </div>
      </div>

      {/* Name + Description */}
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
        <div>
          <Label className="text-sm">Name</Label>
          <Input
            value={name}
            onChange={(e) => { setName(e.target.value); markDirty(); }}
            className="h-9 mt-1"
            placeholder="Routine name"
          />
        </div>
        <div>
          <Label className="text-sm">Description</Label>
          <Input
            value={description}
            onChange={(e) => { setDescription(e.target.value); markDirty(); }}
            className="h-9 mt-1"
            placeholder="Optional description"
          />
        </div>
      </div>

      {/* Instructions (markdown editor) */}
      <div>
        <Label className="text-sm">Instructions (Markdown)</Label>
        <p className="text-[10px] text-muted-foreground mb-1">
          The prompt sent to the agent for this pulse routine.
        </p>
        <textarea
          value={instructions}
          onChange={(e) => { setInstructions(e.target.value); markDirty(); }}
          className="w-full h-64 rounded-md border bg-background px-3 py-2 text-sm font-mono placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-ring resize-y"
          spellCheck={false}
          placeholder="# Pulse Routine&#10;&#10;Write instructions for what this agent should do during this pulse..."
        />
      </div>

      {/* Schedule */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
        <div>
          <Label className="text-sm">Interval (min)</Label>
          <Input
            type="number"
            min={1}
            max={10080}
            value={intervalMinutes}
            onChange={(e) => { setIntervalMinutes(parseInt(e.target.value) || 30); markDirty(); }}
            className="h-9 mt-1"
          />
        </div>
        <div>
          <Label className="text-sm">Offset (min)</Label>
          <Input
            type="number"
            min={0}
            max={59}
            value={offsetMinutes}
            onChange={(e) => { setOffsetMinutes(parseInt(e.target.value) || 0); markDirty(); }}
            className="h-9 mt-1"
          />
        </div>
        <div>
          <Label className="text-sm">Timeout (sec)</Label>
          <Input
            type="number"
            min={30}
            step={30}
            value={timeoutSeconds}
            onChange={(e) => { setTimeoutMs((parseInt(e.target.value) || 120) * 1000); markDirty(); }}
            className="h-9 mt-1"
          />
        </div>
        <div>
          <Label className="text-sm">Max Concurrent</Label>
          <Input
            type="number"
            min={1}
            max={10}
            value={maxConcurrent}
            onChange={(e) => { setMaxConcurrent(parseInt(e.target.value) || 1); markDirty(); }}
            className="h-9 mt-1"
          />
        </div>
      </div>

      {/* Blackouts */}
      <div>
        <div className="flex items-center justify-between mb-2">
          <Label className="text-sm flex items-center gap-1">
            <Moon className="h-3.5 w-3.5" /> Blackout Windows
          </Label>
          <Button
            variant="outline"
            size="sm"
            className="h-7 text-xs"
            onClick={() => setShowAddBlackout(!showAddBlackout)}
          >
            <Plus className="h-3 w-3 mr-1" /> Add
          </Button>
        </div>

        {showAddBlackout && (
          <div className="p-3 rounded-lg border bg-muted/30 space-y-2 mb-2">
            <Input
              placeholder="Label (e.g., Nighttime)"
              value={newBlackoutLabel}
              onChange={(e) => setNewBlackoutLabel(e.target.value)}
              className="h-8"
            />
            <div className="grid grid-cols-2 gap-2">
              <Input type="time" value={newBlackoutStart} onChange={(e) => setNewBlackoutStart(e.target.value)} className="h-8" />
              <Input type="time" value={newBlackoutEnd} onChange={(e) => setNewBlackoutEnd(e.target.value)} className="h-8" />
            </div>
            <div className="flex gap-2">
              <Button size="sm" className="h-7 text-xs" onClick={() => {
                setBlackouts([...blackouts, {
                  type: 'recurring',
                  label: newBlackoutLabel || 'Blackout',
                  startTime: newBlackoutStart,
                  endTime: newBlackoutEnd,
                }]);
                markDirty();
                setShowAddBlackout(false);
                setNewBlackoutLabel('');
              }}>
                Add
              </Button>
              <Button variant="ghost" size="sm" className="h-7 text-xs" onClick={() => setShowAddBlackout(false)}>
                Cancel
              </Button>
            </div>
          </div>
        )}

        {blackouts.length > 0 ? (
          <div className="space-y-1">
            {blackouts.map((b, idx) => (
              <div key={idx} className="flex items-center justify-between p-2 rounded bg-muted/50 text-xs">
                <span>
                  <Moon className="h-3 w-3 inline mr-1 text-muted-foreground" />
                  {b.label || 'Blackout'}: {b.startTime}–{b.endTime}
                </span>
                <Button
                  variant="ghost"
                  size="sm"
                  className="h-6 w-6 p-0"
                  onClick={() => {
                    setBlackouts(blackouts.filter((_, i) => i !== idx));
                    markDirty();
                  }}
                >
                  <Trash2 className="h-3 w-3 text-muted-foreground hover:text-destructive" />
                </Button>
              </div>
            ))}
          </div>
        ) : (
          <p className="text-[10px] text-muted-foreground">No blackouts configured</p>
        )}
      </div>

      {/* Planning / Execution model explanation */}
      <div className="rounded-lg border bg-muted/30 p-3 space-y-2">
        <Label className="text-sm font-medium">How Pulse Routines Work</Label>
        <p className="text-xs text-muted-foreground leading-relaxed">
          Each pulse routine uses a <strong>dual-model system</strong>: a <strong>Planning Model</strong> reads
          the routine instructions, reviews project state, and decides which tasks to pick up or what actions
          to take. It then writes an execution prompt for the <strong>Executor Model</strong>, which carries
          out the actual work (coding, writing, analysis, etc.) inside a sandboxed session. This separation
          keeps planning lightweight and cost-effective while giving execution full tool access and context.
        </p>
        <p className="text-xs text-muted-foreground leading-relaxed">
          Columns and tools are configured per-project via <strong>Routine Mappings</strong> on the
          agent's Projects tab or the project's Team page. This lets the same routine behave differently
          across projects &mdash; scanning different columns and using different tool sets depending on the
          project's workflow.
        </p>
      </div>

      {/* Model overrides */}
      <div>
        <Label className="text-sm mb-2 block">Model Overrides</Label>
        <p className="text-[10px] text-muted-foreground mb-3">
          Override the agent-level planning and executor models for this routine. Leave empty to use agent defaults.
        </p>
        <div className="space-y-3">
          <div>
            <Label className="text-xs text-muted-foreground">Planning Model</Label>
            <p className="text-[10px] text-muted-foreground mb-1">
              Reads context and decides what work to do. Lightweight and strategic.
            </p>
            <ProviderModelSelector
              value={planningModel}
              onChange={(v) => { setPlanningModel(v); markDirty(); }}
              className="w-full mt-1"
              placeholder="Inherit from agent config..."
            />
          </div>
          <div>
            <Label className="text-xs text-muted-foreground">Executor Model</Label>
            <p className="text-[10px] text-muted-foreground mb-1">
              Carries out the actual work with full tool access in a sandboxed session.
            </p>
            <ProviderModelSelector
              value={executorModel}
              onChange={(v) => { setExecutorModel(v); markDirty(); }}
              className="w-full mt-1"
              placeholder="Inherit from agent config..."
            />
          </div>
        </div>
      </div>
    </div>
  );
}
