import { useEffect, useRef, useState, useCallback } from 'react';
import { Card, CardHeader, CardTitle, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Badge } from '@/components/ui/badge';
import { PulseControls } from '@/components/settings/PulseControls';
import { PulseRoutineCard } from '@/components/pulse/PulseRoutineCard';
import { PulseRoutineEditor } from '@/components/pulse/PulseRoutineEditor';
import {
  fetchPulseRoutines,
  seedPulseRoutines,
  createPulseRoutine,
  togglePulseRoutine,
  triggerPulseRoutine,
  duplicatePulseRoutine,
  deletePulseRoutine,
  updateAgentConfig,
} from '@/lib/api';
import { toast } from 'sonner';
import {
  Plus,
  Loader2,
  Radio,
  Zap,
  FileText,
} from 'lucide-react';
import type { PulseRoutine } from '@/lib/api';
import type { AgentConfig } from '@/types/config';

const PULSE_COLUMNS = ['Backlog', 'Planning', 'Ready', 'In Progress', 'Review', 'Blocked', 'Done', 'Failed'] as const;

interface AgentPulseTabProps {
  agentId: string;
  config: AgentConfig;
  onConfigChange: (config: AgentConfig) => void;
}

export function AgentPulseTab({ agentId, config, onConfigChange }: AgentPulseTabProps) {
  const [routines, setRoutines] = useState<PulseRoutine[]>([]);
  const [loading, setLoading] = useState(true);
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [showNewForm, setShowNewForm] = useState(false);
  const [newName, setNewName] = useState('');
  const [creating, setCreating] = useState(false);

  // Config auto-save state
  const [configSaveState, setConfigSaveState] = useState<'idle' | 'saving' | 'saved' | 'error'>('idle');
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const feedbackTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const isFirstRender = useRef(true);

  // ── Load routines ──────────────────────────────────────────────────────

  const loadRoutines = useCallback(async () => {
    try {
      const data = await fetchPulseRoutines(agentId);
      if (data.routines.length > 0) {
        setRoutines(data.routines);
      } else {
        // No routines yet — seed from PULSE.md
        const seeded = await seedPulseRoutines(agentId);
        setRoutines(seeded.routines);
      }
    } catch (err) {
      console.error('Failed to load routines:', err);
      toast.error('Failed to load pulse routines');
    } finally {
      setLoading(false);
    }
  }, [agentId]);

  useEffect(() => {
    loadRoutines();
  }, [loadRoutines]);

  // ── Config auto-save (container timeout + pulse columns) ───────────────

  useEffect(() => {
    if (isFirstRender.current) {
      isFirstRender.current = false;
      return;
    }

    if (saveTimer.current) clearTimeout(saveTimer.current);
    setConfigSaveState('saving');

    saveTimer.current = setTimeout(async () => {
      try {
        await updateAgentConfig(agentId, config);
        setConfigSaveState('saved');
        if (feedbackTimer.current) clearTimeout(feedbackTimer.current);
        feedbackTimer.current = setTimeout(() => setConfigSaveState('idle'), 2000);
      } catch {
        toast.error('Failed to save configuration');
        setConfigSaveState('error');
        if (feedbackTimer.current) clearTimeout(feedbackTimer.current);
        feedbackTimer.current = setTimeout(() => setConfigSaveState('idle'), 3000);
      }
    }, 800);

    return () => {
      if (saveTimer.current) clearTimeout(saveTimer.current);
    };
  }, [config.pulseContainerTimeoutMs, config.pulseColumns]);

  // ── Routine CRUD handlers ──────────────────────────────────────────────

  const handleCreate = async () => {
    if (!newName.trim()) {
      toast.error('Please enter a routine name');
      return;
    }
    setCreating(true);
    try {
      const routine = await createPulseRoutine(agentId, {
        name: newName.trim(),
        instructions: `# ${newName.trim()} Routine\n\nYou are {{AGENT_NAME}}. This is your "${newName.trim()}" pulse routine.\n\n## Steps\n\n1. \n2. \n3. \n`,
      });
      setRoutines(prev => [...prev, routine]);
      setNewName('');
      setShowNewForm(false);
      setExpandedId(routine.id);
      toast.success(`Routine "${routine.name}" created`);
    } catch {
      toast.error('Failed to create routine');
    } finally {
      setCreating(false);
    }
  };

  const handleToggle = async (routine: PulseRoutine) => {
    try {
      const result = await togglePulseRoutine(agentId, routine.id);
      setRoutines(prev =>
        prev.map(r => r.id === routine.id ? { ...r, enabled: result.enabled } : r)
      );
    } catch {
      toast.error('Failed to toggle routine');
    }
  };

  const handleTrigger = async (routine: PulseRoutine) => {
    try {
      await triggerPulseRoutine(agentId, routine.id);
      toast.success(`Triggered "${routine.name}"`);
    } catch {
      toast.error('Failed to trigger routine');
    }
  };

  const handleDuplicate = async (routine: PulseRoutine) => {
    try {
      const clone = await duplicatePulseRoutine(agentId, routine.id);
      setRoutines(prev => [...prev, clone]);
      toast.success(`Duplicated as "${clone.name}"`);
    } catch {
      toast.error('Failed to duplicate routine');
    }
  };

  const handleDelete = async (routine: PulseRoutine) => {
    if (!confirm(`Delete routine "${routine.name}"? This cannot be undone.`)) return;
    try {
      await deletePulseRoutine(agentId, routine.id);
      setRoutines(prev => prev.filter(r => r.id !== routine.id));
      if (expandedId === routine.id) setExpandedId(null);
      toast.success(`Deleted "${routine.name}"`);
    } catch {
      toast.error('Failed to delete routine');
    }
  };

  const handleRoutineUpdated = (updated: PulseRoutine) => {
    setRoutines(prev => prev.map(r => r.id === updated.id ? updated : r));
  };

  // ── Derived values ─────────────────────────────────────────────────────

  const timeoutSeconds = Math.round((config.pulseContainerTimeoutMs ?? 120000) / 1000);
  const enabledCount = routines.filter(r => r.enabled).length;
  const totalRuns = routines.reduce((sum, r) => sum + r.totalRuns, 0);

  // ── Loading state ──────────────────────────────────────────────────────

  if (loading) {
    return (
      <div className="flex items-center justify-center py-12">
        <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
      </div>
    );
  }

  // ── Render ─────────────────────────────────────────────────────────────

  return (
    <div className="space-y-6">
      {/* Global Pulse Controls (trigger, status) */}
      <PulseControls agentId={agentId} />

      {/* ── Routines Section ────────────────────────────────────────────── */}
      <div>
        <div className="flex items-center justify-between mb-4">
          <div className="flex items-center gap-2">
            <Radio className="h-5 w-5" />
            <h3 className="text-lg font-semibold">Pulse Routines</h3>
            <Badge variant="secondary" className="text-xs">
              {enabledCount} active
            </Badge>
          </div>
          <Button
            size="sm"
            onClick={() => setShowNewForm(!showNewForm)}
            className="h-8"
          >
            <Plus className="h-4 w-4 mr-1" />
            New Routine
          </Button>
        </div>

        {/* New routine form */}
        {showNewForm && (
          <Card className="mb-4">
            <CardContent className="pt-4">
              <div className="flex gap-2">
                <Input
                  value={newName}
                  onChange={(e) => setNewName(e.target.value)}
                  placeholder="Routine name (e.g., Code Review, Bug Triage, Research)"
                  className="h-9 flex-1"
                  onKeyDown={(e) => e.key === 'Enter' && handleCreate()}
                  autoFocus
                />
                <Button
                  size="sm"
                  onClick={handleCreate}
                  disabled={creating || !newName.trim()}
                  className="h-9"
                >
                  {creating ? <Loader2 className="h-4 w-4 animate-spin" /> : 'Create'}
                </Button>
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => { setShowNewForm(false); setNewName(''); }}
                  className="h-9"
                >
                  Cancel
                </Button>
              </div>
              <p className="text-xs text-muted-foreground mt-2">
                Each routine gets its own schedule, instructions, and configuration.
                The agent runs them independently and in parallel.
              </p>
            </CardContent>
          </Card>
        )}

        {/* Routine cards */}
        <div className="space-y-3">
          {routines.map((routine) => (
            <div key={routine.id}>
              <PulseRoutineCard
                routine={routine}
                isExpanded={expandedId === routine.id}
                onToggle={() => handleToggle(routine)}
                onExpand={() => setExpandedId(expandedId === routine.id ? null : routine.id)}
                onTrigger={() => handleTrigger(routine)}
                onDuplicate={() => handleDuplicate(routine)}
                onDelete={() => handleDelete(routine)}
              />
              {expandedId === routine.id && (
                <div className="ml-4 mt-1">
                  <PulseRoutineEditor
                    routine={routine}
                    agentId={agentId}
                    onUpdated={handleRoutineUpdated}
                  />
                </div>
              )}
            </div>
          ))}

          {routines.length === 0 && (
            <Card>
              <CardContent className="py-8 text-center text-muted-foreground">
                <FileText className="h-8 w-8 mx-auto mb-2 opacity-50" />
                <p className="text-sm">No pulse routines configured</p>
                <p className="text-xs mt-1">
                  Create your first routine to give this agent autonomous work patterns.
                </p>
              </CardContent>
            </Card>
          )}
        </div>
      </div>

      {/* ── Activity Summary ────────────────────────────────────────────── */}
      {routines.length > 0 && (
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm flex items-center gap-2">
              <Zap className="h-4 w-4" />
              Activity Summary
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="space-y-2">
              {routines.map((routine) => (
                <div key={routine.id} className="flex items-center gap-2 text-xs">
                  <div
                    className="w-2 h-2 rounded-full shrink-0"
                    style={{ backgroundColor: routine.color || '#6366f1' }}
                  />
                  <span className="truncate flex-1">{routine.name}</span>
                  {routine.enabled ? (
                    <div className="flex items-center gap-2 shrink-0">
                      <div className="w-20 h-2 bg-muted rounded-full overflow-hidden">
                        <div
                          className="h-full rounded-full"
                          style={{
                            backgroundColor: routine.color || '#6366f1',
                            width: `${Math.min(100, totalRuns > 0 ? (routine.totalRuns / totalRuns) * 100 : 0)}%`,
                          }}
                        />
                      </div>
                      <span className="text-muted-foreground w-12 text-right">
                        {routine.totalRuns} runs
                      </span>
                    </div>
                  ) : (
                    <span className="text-muted-foreground shrink-0">paused</span>
                  )}
                </div>
              ))}
            </div>
            <div className="flex items-center gap-4 mt-3 pt-2 border-t text-xs text-muted-foreground">
              <span>Total: {totalRuns} runs</span>
              <span>{enabledCount} of {routines.length} routines active</span>
            </div>
          </CardContent>
        </Card>
      )}

      {/* ── Default Agent Config ────────────────────────────────────────── */}
      <Card>
        <CardHeader>
          <div className="flex items-center justify-between">
            <CardTitle className="text-sm">Default Container Timeout</CardTitle>
            {configSaveState === 'saving' && (
              <span className="text-xs text-muted-foreground animate-pulse">Saving...</span>
            )}
            {configSaveState === 'saved' && (
              <span className="text-xs text-green-500">Saved</span>
            )}
            {configSaveState === 'error' && (
              <span className="text-xs text-destructive">Failed</span>
            )}
          </div>
        </CardHeader>
        <CardContent>
          <p className="text-xs text-muted-foreground mb-2">
            Default timeout for pulse sessions. Individual routines can override this.
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
            className="h-9 w-40 rounded-md border border-input bg-background px-3 text-sm font-mono"
          />
          <p className="text-xs text-muted-foreground mt-1">
            {timeoutSeconds}s &mdash; {(timeoutSeconds / 60).toFixed(1)} minutes
          </p>
        </CardContent>
      </Card>

      {/* ── Default Pulse Columns ───────────────────────────────────────── */}
      <Card>
        <CardHeader>
          <div className="flex items-center justify-between">
            <CardTitle className="text-sm">Default Pulse Columns</CardTitle>
            {configSaveState === 'saving' && (
              <span className="text-xs text-muted-foreground animate-pulse">Saving...</span>
            )}
            {configSaveState === 'saved' && (
              <span className="text-xs text-green-500">Saved</span>
            )}
            {configSaveState === 'error' && (
              <span className="text-xs text-destructive">Failed</span>
            )}
          </div>
        </CardHeader>
        <CardContent className="space-y-3">
          <p className="text-xs text-muted-foreground">
            Default kanban columns scanned during pulses. Individual routines can override these.
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
  );
}
