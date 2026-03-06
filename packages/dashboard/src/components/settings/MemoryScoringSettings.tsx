import { useState, useEffect, useCallback } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Loader2, RotateCcw, Info } from 'lucide-react';
import { toast } from 'sonner';
import { API_BASE } from '@/lib/api';
import { authFetch } from '@/lib/auth';

interface ScoringConfig {
  min_accesses_for_signal: number;
  recency_half_life_days: number;
  rehabilitation_half_life_days: number;
  adaptive_score_floor: number;
  frequency_log_cap: number;
  blend_success_weight: number;
  blend_recency_weight: number;
  blend_frequency_weight: number;
  recency_floor: number;
  blend_boost_factor: number;
  blend_base_factor: number;
}

const DEFAULTS: ScoringConfig = {
  min_accesses_for_signal: 3,
  recency_half_life_days: 30,
  rehabilitation_half_life_days: 90,
  adaptive_score_floor: 0.35,
  frequency_log_cap: 50,
  blend_success_weight: 0.60,
  blend_recency_weight: 0.25,
  blend_frequency_weight: 0.15,
  recency_floor: 0.30,
  blend_boost_factor: 0.30,
  blend_base_factor: 0.70,
};

interface ParamDef {
  key: keyof ScoringConfig;
  label: string;
  description: string;
  min: number;
  max: number;
  step: number;
  unit?: string;
  group: string;
}

const PARAMS: ParamDef[] = [
  // ── Evidence threshold ──
  {
    key: 'min_accesses_for_signal',
    label: 'Minimum Accesses for Signal',
    description:
      'How many times a memory must be retrieved before its success/failure ratio is trusted. Below this, it uses a neutral score (0.5). Higher = more conservative, needs more evidence.',
    min: 1,
    max: 50,
    step: 1,
    group: 'Evidence & Decay',
  },
  // ── Decay controls ──
  {
    key: 'recency_half_life_days',
    label: 'Recency Half-Life',
    description:
      'Days until the recency signal drops to half. Controls how fast stale memories lose ranking priority. Lower = stale memories penalized faster.',
    min: 1,
    max: 365,
    step: 1,
    unit: 'days',
    group: 'Evidence & Decay',
  },
  {
    key: 'recency_floor',
    label: 'Recency Floor',
    description:
      'Minimum recency signal, even for very old memories. Prevents ancient memories from being fully deprioritized by recency alone. 0.0 = no floor, 1.0 = recency has no effect.',
    min: 0.0,
    max: 1.0,
    step: 0.05,
    group: 'Evidence & Decay',
  },
  {
    key: 'rehabilitation_half_life_days',
    label: 'Rehabilitation Half-Life',
    description:
      'Days until old negative scores fade halfway back to neutral. This prevents "permanent punishment" — a memory that was irrelevant last year shouldn\'t be penalized today. After 4x this period, ~94% of the negative signal is erased.',
    min: 7,
    max: 730,
    step: 1,
    unit: 'days',
    group: 'Evidence & Decay',
  },
  // ── Safety ──
  {
    key: 'adaptive_score_floor',
    label: 'Adaptive Score Floor',
    description:
      'Hard minimum for any memory\'s adaptive score. This is the ultimate safety valve — even the most downvoted memory cannot score below this. At 0.35 with default blend factors, the worst penalty is ~19.5%. Set to 0.5 to completely disable adaptive scoring.',
    min: 0.0,
    max: 0.5,
    step: 0.05,
    group: 'Safety & Limits',
  },
  {
    key: 'frequency_log_cap',
    label: 'Frequency Saturation Point',
    description:
      'Number of retrievals at which the frequency signal maxes out. Uses a logarithmic scale, so early retrievals matter most. Lower = frequency signal saturates faster.',
    min: 5,
    max: 500,
    step: 5,
    unit: 'retrievals',
    group: 'Safety & Limits',
  },
  // ── Blend weights ──
  {
    key: 'blend_success_weight',
    label: 'Success Rate Weight',
    description:
      'How much the success/failure ratio influences ranking. This is the primary learning signal — memories that led to successful outcomes rank higher. The three weights (success + recency + frequency) should sum to 1.0.',
    min: 0.0,
    max: 1.0,
    step: 0.05,
    group: 'Scoring Weights',
  },
  {
    key: 'blend_recency_weight',
    label: 'Recency Weight',
    description:
      'How much recency influences ranking. Higher values favor recently-accessed memories over older ones.',
    min: 0.0,
    max: 1.0,
    step: 0.05,
    group: 'Scoring Weights',
  },
  {
    key: 'blend_frequency_weight',
    label: 'Frequency Weight',
    description:
      'How much access frequency influences ranking. Higher values favor memories that are retrieved often.',
    min: 0.0,
    max: 1.0,
    step: 0.05,
    group: 'Scoring Weights',
  },
  // ── Final blend ──
  {
    key: 'blend_base_factor',
    label: 'Blend Base Factor',
    description:
      'The baseline multiplier for raw search scores. At 0.70, even a memory with the worst adaptive score retains 70% of its raw relevance. base + boost should equal ~1.0.',
    min: 0.0,
    max: 1.0,
    step: 0.05,
    group: 'Score Blending',
  },
  {
    key: 'blend_boost_factor',
    label: 'Blend Boost Factor',
    description:
      'How much adaptive scores can boost or penalize raw search results. Final score = rawScore x (base + boost x adaptiveScore). At 0.30, a perfect adaptive score gives +30% boost; the worst gives -30% penalty. Set to 0.0 to disable blending entirely.',
    min: 0.0,
    max: 1.0,
    step: 0.05,
    group: 'Score Blending',
  },
];

function groupBy<T>(items: T[], key: (item: T) => string): Record<string, T[]> {
  const groups: Record<string, T[]> = {};
  for (const item of items) {
    const group = key(item);
    if (!groups[group]) groups[group] = [];
    groups[group].push(item);
  }
  return groups;
}

export function MemoryScoringSettings() {
  const [config, setConfig] = useState<ScoringConfig>(DEFAULTS);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [resetting, setResetting] = useState(false);
  const [dirty, setDirty] = useState(false);

  const loadConfig = useCallback(async () => {
    try {
      const res = await authFetch(`${API_BASE}/memory-scoring/config`);
      if (res.ok) {
        const data = await res.json();
        setConfig(data);
        setDirty(false);
      }
    } catch {
      // Fall back to defaults
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    loadConfig();
  }, [loadConfig]);

  const handleChange = (key: keyof ScoringConfig, value: number) => {
    setConfig((prev) => ({ ...prev, [key]: value }));
    setDirty(true);
  };

  const handleSave = async () => {
    setSaving(true);
    try {
      const res = await authFetch(`${API_BASE}/memory-scoring/config`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(config),
      });
      if (!res.ok) {
        const err = await res.json();
        throw new Error(err.detail || 'Failed to save');
      }
      setDirty(false);
      toast.success('Memory scoring configuration saved');
    } catch (err: any) {
      toast.error(err?.message || 'Failed to save scoring config');
    } finally {
      setSaving(false);
    }
  };

  const handleReset = async () => {
    setResetting(true);
    try {
      const res = await authFetch(`${API_BASE}/memory-scoring/config/reset`, {
        method: 'POST',
      });
      if (!res.ok) throw new Error('Failed to reset');
      const data = await res.json();
      setConfig(data);
      setDirty(false);
      toast.success('Scoring configuration reset to defaults');
    } catch {
      toast.error('Failed to reset scoring config');
    } finally {
      setResetting(false);
    }
  };

  // Compute some live preview values
  const weightsSum =
    config.blend_success_weight +
    config.blend_recency_weight +
    config.blend_frequency_weight;
  const weightsValid = Math.abs(weightsSum - 1.0) < 0.01;
  const blendSum = config.blend_base_factor + config.blend_boost_factor;
  const blendValid = Math.abs(blendSum - 1.0) < 0.15; // More lenient
  const worstPenalty =
    (1.0 -
      (config.blend_base_factor +
        config.blend_boost_factor * config.adaptive_score_floor)) *
    100;
  const bestBoost =
    (config.blend_base_factor + config.blend_boost_factor * 1.0 - 1.0) * 100;

  if (loading) {
    return (
      <div className="flex justify-center py-12">
        <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
      </div>
    );
  }

  const groups = groupBy(PARAMS, (p) => p.group);

  return (
    <div className="space-y-6">
      {/* Header info */}
      <div className="rounded-md border bg-muted/40 px-4 py-3 space-y-1.5">
        <div className="flex items-center gap-2">
          <Info className="h-4 w-4 text-muted-foreground shrink-0" />
          <p className="text-sm font-medium">How adaptive memory scoring works</p>
        </div>
        <p className="text-xs text-muted-foreground">
          When an agent recalls memories, each result is tracked. After the step completes, the
          outcome (success/failure) is recorded. Over time, memories that consistently lead to
          successful outcomes get a ranking boost, while unhelpful ones get gently penalized.
          The scoring formula blends three signals: <strong>success rate</strong> (did this memory
          help?), <strong>recency</strong> (how recently was it used?), and{' '}
          <strong>frequency</strong> (how often is it accessed?). Built-in safety guards prevent
          any memory from being permanently suppressed.
        </p>
      </div>

      {/* Live preview */}
      <div className="rounded-md border px-4 py-3 space-y-2">
        <p className="text-xs font-medium text-muted-foreground uppercase tracking-wide">
          Live Preview
        </p>
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 text-sm">
          <div>
            <span className="text-muted-foreground text-xs">Worst penalty</span>
            <div className="font-mono font-medium">
              {worstPenalty > 0 ? `-${worstPenalty.toFixed(1)}%` : 'none'}
            </div>
          </div>
          <div>
            <span className="text-muted-foreground text-xs">Best boost</span>
            <div className="font-mono font-medium">
              {bestBoost > 0 ? `+${bestBoost.toFixed(1)}%` : 'none'}
            </div>
          </div>
          <div>
            <span className="text-muted-foreground text-xs">Weights sum</span>
            <div className={`font-mono font-medium ${weightsValid ? '' : 'text-yellow-500'}`}>
              {weightsSum.toFixed(2)}
              {!weightsValid && ' (should be 1.0)'}
            </div>
          </div>
          <div>
            <span className="text-muted-foreground text-xs">Blend sum</span>
            <div className={`font-mono font-medium ${blendValid ? '' : 'text-yellow-500'}`}>
              {blendSum.toFixed(2)}
              {!blendValid && ' (~1.0)'}
            </div>
          </div>
        </div>
      </div>

      {/* Parameter groups */}
      {Object.entries(groups).map(([groupName, params]) => (
        <div key={groupName} className="space-y-4">
          <div className="flex items-center gap-2">
            <div className="flex-1 h-px bg-border" />
            <span className="text-xs text-muted-foreground px-2 font-medium uppercase tracking-wide">
              {groupName}
            </span>
            <div className="flex-1 h-px bg-border" />
          </div>

          {params.map((param) => {
            const value = config[param.key];
            const isDefault = value === DEFAULTS[param.key];
            const isFloat = param.step < 1;

            return (
              <div key={param.key} className="space-y-2">
                <div className="flex items-center justify-between">
                  <Label className="text-sm font-medium">{param.label}</Label>
                  <div className="flex items-center gap-2">
                    <span className="text-sm font-mono tabular-nums">
                      {isFloat ? Number(value).toFixed(2) : value}
                      {param.unit ? ` ${param.unit}` : ''}
                    </span>
                    {!isDefault && (
                      <button
                        onClick={() => handleChange(param.key, DEFAULTS[param.key])}
                        className="text-xs text-muted-foreground hover:text-foreground"
                        title={`Reset to default (${DEFAULTS[param.key]})`}
                      >
                        <RotateCcw className="h-3 w-3" />
                      </button>
                    )}
                  </div>
                </div>
                <p className="text-xs text-muted-foreground">{param.description}</p>
                <div className="flex items-center gap-3">
                  <span className="text-xs text-muted-foreground tabular-nums w-8 text-right shrink-0">
                    {param.min}
                  </span>
                  <input
                    type="range"
                    min={param.min}
                    max={param.max}
                    step={param.step}
                    value={value}
                    onChange={(e) =>
                      handleChange(param.key, parseFloat(e.target.value))
                    }
                    className="flex-1 h-2 rounded-full appearance-none bg-muted cursor-pointer accent-primary [&::-webkit-slider-thumb]:h-4 [&::-webkit-slider-thumb]:w-4 [&::-webkit-slider-thumb]:rounded-full [&::-webkit-slider-thumb]:bg-primary [&::-webkit-slider-thumb]:appearance-none"
                  />
                  <span className="text-xs text-muted-foreground tabular-nums w-8 shrink-0">
                    {param.max}
                  </span>
                </div>
              </div>
            );
          })}
        </div>
      ))}

      {/* Actions */}
      <div className="flex gap-3 pt-2">
        <Button onClick={handleSave} disabled={saving || !dirty} className="flex-1">
          {saving ? (
            <>
              <Loader2 className="h-4 w-4 mr-2 animate-spin" />
              Saving...
            </>
          ) : dirty ? (
            'Save Changes'
          ) : (
            'No Changes'
          )}
        </Button>
        <Button
          variant="outline"
          onClick={handleReset}
          disabled={resetting}
          title="Reset all values to factory defaults"
        >
          {resetting ? (
            <Loader2 className="h-4 w-4 animate-spin" />
          ) : (
            <RotateCcw className="h-4 w-4" />
          )}
        </Button>
      </div>

      <p className="text-xs text-muted-foreground">
        Changes take effect immediately on the next memory retrieval. Existing scores are not
        recomputed — they update naturally as memories are retrieved in future steps.
      </p>
    </div>
  );
}
