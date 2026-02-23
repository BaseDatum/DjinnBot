import { useEffect, useState, useCallback } from 'react';
import { Card, CardHeader, CardTitle, CardContent } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Label } from '@/components/ui/label';
import { Input } from '@/components/ui/input';
import { Skeleton } from '@/components/ui/skeleton';
import {
  GitMerge,
  Lock,
  Shield,
  Zap,
  Clock,
  AlertTriangle,
} from 'lucide-react';
import { fetchAgentWorkLedger, fetchAgentWakeStats, API_BASE } from '@/lib/api';
import type { WorkLockEntry, WakeStatsResponse } from '@/lib/api';
import type { AgentConfig, CoordinationConfig } from '@/types/config';
import { COORDINATION_DEFAULTS } from '@/types/config';
import { useSSE } from '@/hooks/useSSE';

interface AgentCoordinationTabProps {
  agentId: string;
  config: AgentConfig;
  onConfigChange: (config: AgentConfig) => void;
}

export function AgentCoordinationTab({ agentId, config, onConfigChange }: AgentCoordinationTabProps) {
  const [locks, setLocks] = useState<WorkLockEntry[]>([]);
  const [locksLoading, setLocksLoading] = useState(true);
  const [wakeStats, setWakeStats] = useState<WakeStatsResponse | null>(null);

  const coordination = config.coordination ?? COORDINATION_DEFAULTS;
  const guardrails = coordination.wakeGuardrails;

  // ── Load live data ─────────────────────────────────────────────────────

  const loadLiveData = useCallback(async () => {
    try {
      const [ledger, stats] = await Promise.all([
        fetchAgentWorkLedger(agentId),
        fetchAgentWakeStats(agentId),
      ]);
      setLocks(ledger.locks);
      setWakeStats(stats);
    } catch (err) {
      console.error('Failed to load coordination data:', err);
    } finally {
      setLocksLoading(false);
    }
  }, [agentId]);

  // Initial fetch
  useEffect(() => {
    loadLiveData();
  }, [loadLiveData]);

  // ── Real-time SSE updates for work lock changes ────────────────────────

  const handleWorkLockEvent = useCallback(() => {
    // Refetch the full ledger on any lock change event
    loadLiveData();
  }, [loadLiveData]);

  const { status: sseStatus } = useSSE<{ type: string; agentId: string }>({
    url: `${API_BASE}/events/work-locks/${agentId}`,
    onMessage: handleWorkLockEvent,
  });

  // ── Config update helpers ──────────────────────────────────────────────

  const updateCoordination = (updates: Partial<CoordinationConfig>) => {
    const newCoord = { ...coordination, ...updates };
    onConfigChange({ ...config, coordination: newCoord });
  };

  const updateGuardrail = (key: keyof typeof guardrails, value: number) => {
    updateCoordination({
      wakeGuardrails: { ...guardrails, [key]: value },
    });
  };

  // ── Render ─────────────────────────────────────────────────────────────

  return (
    <div className="space-y-6">
      {/* Section Header */}
      <div className="flex items-center gap-2">
        <GitMerge className="h-5 w-5" />
        <h2 className="text-lg font-semibold">Agent Coordination</h2>
        <Badge variant="secondary" className="text-xs">
          {locks.length} active lock{locks.length !== 1 ? 's' : ''}
        </Badge>
      </div>

      {/* ── Concurrency Settings ────────────────────────────────────────── */}
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-sm flex items-center gap-2">
            <Zap className="h-4 w-4" />
            Concurrency
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <div>
            <Label className="text-sm">Max Concurrent Pulse Sessions</Label>
            <p className="text-xs text-muted-foreground mb-2">
              How many parallel pulse sessions this agent can run simultaneously.
              Higher values allow more parallelism but increase cost.
            </p>
            <Input
              type="number"
              min={1}
              max={10}
              value={coordination.maxConcurrentPulseSessions}
              onChange={(e) =>
                updateCoordination({
                  maxConcurrentPulseSessions: parseInt(e.target.value) || 2,
                })
              }
              className="h-9 w-32"
            />
          </div>
          <p className="text-[10px] text-muted-foreground">
            Per-routine concurrency is configured in each routine's settings (Pulse tab).
          </p>
        </CardContent>
      </Card>

      {/* ── Wake Guardrails ─────────────────────────────────────────────── */}
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-sm flex items-center gap-2">
            <Shield className="h-4 w-4" />
            Wake Guardrails
            {wakeStats && wakeStats.wakesToday > 0 && (
              <Badge
                variant={
                  wakeStats.wakesToday >= guardrails.maxWakesPerDay
                    ? 'destructive'
                    : wakeStats.wakesToday >= guardrails.maxWakesPerDay * 0.75
                    ? 'warning'
                    : 'secondary'
                }
                className="text-xs"
              >
                {wakeStats.wakesToday}/{guardrails.maxWakesPerDay} wakes today
              </Badge>
            )}
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <p className="text-xs text-muted-foreground">
            Controls how other agents can wake this agent via the <code>wake_agent</code> tool.
            Each wake triggers a new pulse session (= LLM cost). These guardrails prevent runaway spending.
          </p>

          <div className="grid grid-cols-2 gap-4">
            <div>
              <Label className="text-sm">Cooldown (seconds)</Label>
              <p className="text-[10px] text-muted-foreground mb-1">
                Minimum time between wake-triggered pulses
              </p>
              <Input
                type="number"
                min={0}
                max={3600}
                step={30}
                value={guardrails.cooldownSeconds}
                onChange={(e) =>
                  updateGuardrail('cooldownSeconds', parseInt(e.target.value) || 300)
                }
                className="h-9"
              />
              <p className="text-[10px] text-muted-foreground mt-1">
                {Math.floor(guardrails.cooldownSeconds / 60)}m {guardrails.cooldownSeconds % 60}s
              </p>
            </div>

            <div>
              <Label className="text-sm">Max Wakes / Day</Label>
              <p className="text-[10px] text-muted-foreground mb-1">
                Daily cap on wake-triggered pulses
              </p>
              <Input
                type="number"
                min={0}
                max={100}
                value={guardrails.maxWakesPerDay}
                onChange={(e) =>
                  updateGuardrail('maxWakesPerDay', parseInt(e.target.value) || 12)
                }
                className="h-9"
              />
            </div>

            <div>
              <Label className="text-sm">Max Daily Session (min)</Label>
              <p className="text-[10px] text-muted-foreground mb-1">
                Max cumulative active session time per day
              </p>
              <Input
                type="number"
                min={10}
                max={1440}
                step={10}
                value={guardrails.maxDailySessionMinutes}
                onChange={(e) =>
                  updateGuardrail(
                    'maxDailySessionMinutes',
                    parseInt(e.target.value) || 120
                  )
                }
                className="h-9"
              />
              <p className="text-[10px] text-muted-foreground mt-1">
                {(guardrails.maxDailySessionMinutes / 60).toFixed(1)} hours
              </p>
            </div>

            <div>
              <Label className="text-sm">Max Wakes / Pair / Day</Label>
              <p className="text-[10px] text-muted-foreground mb-1">
                Per source-target pair limit (prevents loops)
              </p>
              <Input
                type="number"
                min={0}
                max={50}
                value={guardrails.maxWakesPerPairPerDay}
                onChange={(e) =>
                  updateGuardrail(
                    'maxWakesPerPairPerDay',
                    parseInt(e.target.value) || 5
                  )
                }
                className="h-9"
              />
            </div>
          </div>

          {guardrails.maxWakesPerDay === 0 && (
            <div className="flex items-start gap-2 p-3 rounded-lg bg-yellow-500/10 border border-yellow-500/20">
              <AlertTriangle className="h-4 w-4 text-yellow-500 mt-0.5 shrink-0" />
              <p className="text-xs text-yellow-600 dark:text-yellow-400">
                Wake-ups are disabled (max = 0). Other agents can only leave inbox messages
                that will be read on the next scheduled pulse.
              </p>
            </div>
          )}
        </CardContent>
      </Card>

      {/* ── Active Work Ledger ──────────────────────────────────────────── */}
      <Card>
        <CardHeader className="pb-3">
          <div className="flex items-center justify-between">
            <CardTitle className="text-sm flex items-center gap-2">
              <Lock className="h-4 w-4" />
              Active Work Locks
              <Badge variant="secondary" className="text-xs">
                {locks.length}
              </Badge>
            </CardTitle>
            <div className="flex items-center gap-1.5">
              <span
                className={`inline-block h-1.5 w-1.5 rounded-full ${
                  sseStatus === 'connected'
                    ? 'bg-green-500'
                    : sseStatus === 'connecting'
                    ? 'bg-yellow-500 animate-pulse'
                    : 'bg-red-500'
                }`}
              />
              <p className="text-[10px] text-muted-foreground">
                {sseStatus === 'connected' ? 'Live' : sseStatus === 'connecting' ? 'Connecting...' : 'Disconnected'}
              </p>
            </div>
          </div>
        </CardHeader>
        <CardContent>
          {locksLoading ? (
            <div className="space-y-2">
              {[...Array(2)].map((_, i) => (
                <Skeleton key={i} height={48} />
              ))}
            </div>
          ) : locks.length === 0 ? (
            <p className="text-sm text-muted-foreground text-center py-6">
              No active work locks. Agent instances are idle or haven't acquired locks.
            </p>
          ) : (
            <div className="space-y-2">
              {locks.map((lock) => {
                const ageMinutes = Math.round(
                  (Date.now() - lock.acquiredAt) / 60000
                );
                return (
                  <div
                    key={lock.key}
                    className="flex items-start justify-between p-3 rounded-lg bg-muted/50"
                  >
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2">
                        <Lock className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
                        <span className="font-mono text-sm font-medium truncate">
                          {lock.key}
                        </span>
                      </div>
                      <p className="text-xs text-muted-foreground mt-0.5 ml-5.5">
                        {lock.description}
                      </p>
                      <p className="text-[10px] text-muted-foreground mt-0.5 ml-5.5">
                        Session: {lock.sessionId}
                      </p>
                    </div>
                    <div className="text-right shrink-0 ml-3">
                      <div className="flex items-center gap-1 text-xs text-muted-foreground">
                        <Clock className="h-3 w-3" />
                        {ageMinutes}m ago
                      </div>
                      <p className="text-[10px] text-muted-foreground mt-0.5">
                        ~{Math.round(lock.remainingSeconds / 60)}m remaining
                      </p>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </CardContent>
      </Card>

      {/* ── Help Text ───────────────────────────────────────────────────── */}
      <div className="text-xs text-muted-foreground space-y-2">
        <p>
          <strong>How coordination works:</strong> When an agent instance wakes up,
          it calls <code>get_active_work()</code> to see what its parallel instances
          are doing, then <code>acquire_work_lock()</code> before starting any task.
          This prevents duplicate work across concurrent sessions.
        </p>
        <p>
          <strong>Messaging:</strong> Agents have two tools for inter-agent communication:
        </p>
        <ul className="list-disc ml-4 space-y-1">
          <li>
            <code>message_agent</code> — drops a message in the target's inbox
            (read on next scheduled pulse)
          </li>
          <li>
            <code>wake_agent</code> — immediately wakes the target agent (subject
            to guardrails above). Rate-limited to 3 per session.
          </li>
        </ul>
      </div>
    </div>
  );
}
