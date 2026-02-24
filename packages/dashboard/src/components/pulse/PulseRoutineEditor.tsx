import { useState, useEffect, useRef, useCallback } from 'react';
import { Card, CardHeader, CardTitle, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Badge } from '@/components/ui/badge';
import { ProviderModelSelector } from '@/components/ui/ProviderModelSelector';
import {
  Moon,
  Plus,
  Trash2,
  Save,
} from 'lucide-react';
import { toast } from 'sonner';
import { updatePulseRoutine } from '@/lib/api';
import type { PulseRoutine, PulseBlackout, UpdatePulseRoutineRequest } from '@/lib/api';

interface PulseRoutineEditorProps {
  routine: PulseRoutine;
  agentId: string;
  onUpdated: (routine: PulseRoutine) => void;
}

// Legacy fallback columns — used only when the agent has no projects to read columns from.
// In the modular workflow system, columns come from each project's template.
const FALLBACK_COLUMNS = ['Backlog', 'Planning', 'Ready', 'In Progress', 'Review', 'Blocked', 'Done', 'Failed'] as const;

const CORE_TOOLS = ['get_my_projects', 'get_ready_tasks', 'execute_task', 'get_task_context', 'transition_task'] as const;
const GIT_TOOLS = ['claim_task', 'get_task_branch', 'open_pull_request', 'get_task_pr_status'] as const;
const ALL_TOOLS = [...CORE_TOOLS, ...GIT_TOOLS];

export function PulseRoutineEditor({ routine, agentId, onUpdated }: PulseRoutineEditorProps) {
  const [name, setName] = useState(routine.name);
  const [description, setDescription] = useState(routine.description || '');
  const [instructions, setInstructions] = useState(routine.instructions);
  const [intervalMinutes, setIntervalMinutes] = useState(routine.intervalMinutes);
  const [offsetMinutes, setOffsetMinutes] = useState(routine.offsetMinutes);
  const [timeoutMs, setTimeoutMs] = useState(routine.timeoutMs);
  const [maxConcurrent, setMaxConcurrent] = useState(routine.maxConcurrent);
  const [blackouts, setBlackouts] = useState<PulseBlackout[]>(routine.blackouts);
  const [pulseColumns, setPulseColumns] = useState<string[] | null>(routine.pulseColumns);
  const [useCustomColumns, setUseCustomColumns] = useState(!!routine.pulseColumns);
  const [tools, setTools] = useState<string[] | null>(routine.tools ?? null);
  const [useCustomTools, setUseCustomTools] = useState(!!routine.tools);
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
      pulseColumns: useCustomColumns ? (pulseColumns ?? []) : undefined,
      tools: useCustomTools ? (tools ?? []) : undefined,
      planningModel: planningModel || undefined,
      executorModel: executorModel || undefined,
    });
  }, [name, description, instructions, intervalMinutes, offsetMinutes, blackouts, timeoutMs, maxConcurrent, pulseColumns, useCustomColumns, tools, useCustomTools, planningModel, executorModel, save]);

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
          The prompt sent to the agent for this pulse routine. Replaces the default PULSE.md.
        </p>
        <textarea
          value={instructions}
          onChange={(e) => { setInstructions(e.target.value); markDirty(); }}
          className="w-full h-64 rounded-md border bg-background px-3 py-2 text-sm font-mono placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-ring resize-y"
          spellCheck={false}
          placeholder="# Pulse Routine&#10;&#10;Write instructions for what this agent should do during this pulse..."
        />
        {routine.sourceFile && instructions === routine.instructions && (
          <p className="text-[10px] text-muted-foreground mt-1">
            Linked to file: <code>{routine.sourceFile}</code> — editing here will unlink from the file.
          </p>
        )}
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

      {/* Model overrides */}
      <div>
        <Label className="text-sm mb-2 block">Model Overrides</Label>
        <p className="text-[10px] text-muted-foreground mb-3">
          Override the agent-level planning and executor models for this routine. Leave empty to use agent defaults.
        </p>
        <div className="space-y-3">
          <div>
            <Label className="text-xs text-muted-foreground">Planning Model</Label>
            <ProviderModelSelector
              value={planningModel}
              onChange={(v) => { setPlanningModel(v); markDirty(); }}
              className="w-full mt-1"
              placeholder="Inherit from agent config..."
            />
          </div>
          <div>
            <Label className="text-xs text-muted-foreground">Executor Model</Label>
            <ProviderModelSelector
              value={executorModel}
              onChange={(v) => { setExecutorModel(v); markDirty(); }}
              className="w-full mt-1"
              placeholder="Inherit from agent config..."
            />
          </div>
        </div>
      </div>

      {/* Pulse Columns override */}
      <div>
        <div className="flex items-center gap-2 mb-2">
          <Label className="text-sm">Pulse Columns</Label>
          <label className="flex items-center gap-1.5 text-xs text-muted-foreground cursor-pointer">
            <input
              type="checkbox"
              checked={useCustomColumns}
              onChange={(e) => {
                setUseCustomColumns(e.target.checked);
                if (!e.target.checked) setPulseColumns(null);
                markDirty();
              }}
              className="h-3.5 w-3.5"
            />
            Override agent defaults
          </label>
        </div>
        {useCustomColumns && (
          <>
            <p className="text-[10px] text-muted-foreground mb-2">
              These are column names. For project-specific column mappings, use the routine mapping on the agent's Projects tab.
            </p>
            <div className="flex flex-wrap gap-2">
              {FALLBACK_COLUMNS.map((col) => {
                const checked = (pulseColumns ?? []).includes(col);
                return (
                  <label key={col} className="flex items-center gap-1.5 text-xs cursor-pointer">
                    <input
                      type="checkbox"
                      checked={checked}
                      onChange={() => {
                        const current = pulseColumns ?? [];
                        setPulseColumns(
                          checked
                            ? current.filter(c => c !== col)
                            : [...current, col],
                        );
                        markDirty();
                      }}
                      className="h-3.5 w-3.5"
                    />
                    {col}
                  </label>
                );
              })}
            </div>
          </>
        )}
      </div>

      {/* Tool Selection */}
      <div>
        <div className="flex items-center gap-2 mb-2">
          <Label className="text-sm">Tool Selection</Label>
          <label className="flex items-center gap-1.5 text-xs text-muted-foreground cursor-pointer">
            <input
              type="checkbox"
              checked={useCustomTools}
              onChange={(e) => {
                setUseCustomTools(e.target.checked);
                if (!e.target.checked) setTools(null);
                else if (!tools) setTools([...CORE_TOOLS]);
                markDirty();
              }}
              className="h-3.5 w-3.5"
            />
            Override agent defaults
          </label>
        </div>
        {useCustomTools && (
          <div className="space-y-2">
            <p className="text-[10px] text-muted-foreground">
              Select which tools this routine can use. Different routines can have different tool sets.
            </p>
            <div>
              <span className="text-[10px] font-medium text-muted-foreground uppercase tracking-wider">Core Tools</span>
              <div className="flex flex-wrap gap-2 mt-1">
                {CORE_TOOLS.map((tool) => {
                  const checked = (tools ?? []).includes(tool);
                  return (
                    <label key={tool} className="flex items-center gap-1.5 text-xs cursor-pointer">
                      <input
                        type="checkbox"
                        checked={checked}
                        onChange={() => {
                          const current = tools ?? [];
                          setTools(checked ? current.filter(t => t !== tool) : [...current, tool]);
                          markDirty();
                        }}
                        className="h-3.5 w-3.5"
                      />
                      <span className="font-mono text-[11px]">{tool}</span>
                    </label>
                  );
                })}
              </div>
            </div>
            <div>
              <span className="text-[10px] font-medium text-muted-foreground uppercase tracking-wider">Git Tools</span>
              <div className="flex flex-wrap gap-2 mt-1">
                {GIT_TOOLS.map((tool) => {
                  const checked = (tools ?? []).includes(tool);
                  return (
                    <label key={tool} className="flex items-center gap-1.5 text-xs cursor-pointer">
                      <input
                        type="checkbox"
                        checked={checked}
                        onChange={() => {
                          const current = tools ?? [];
                          setTools(checked ? current.filter(t => t !== tool) : [...current, tool]);
                          markDirty();
                        }}
                        className="h-3.5 w-3.5"
                      />
                      <span className="font-mono text-[11px]">{tool}</span>
                    </label>
                  );
                })}
              </div>
            </div>
            <div className="flex gap-2 pt-1">
              <Button variant="ghost" size="sm" className="h-6 text-[10px]" onClick={() => { setTools([...ALL_TOOLS]); markDirty(); }}>
                Select All
              </Button>
              <Button variant="ghost" size="sm" className="h-6 text-[10px]" onClick={() => { setTools([...CORE_TOOLS]); markDirty(); }}>
                Core Only
              </Button>
              <Button variant="ghost" size="sm" className="h-6 text-[10px]" onClick={() => { setTools([]); markDirty(); }}>
                Clear All
              </Button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
