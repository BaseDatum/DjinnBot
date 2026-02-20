/**
 * OnboardingSessionsPanel — shows in-progress and abandoned onboarding sessions.
 *
 * Completed sessions are NOT shown here — they belong on their project page.
 */
import { useState, useEffect, useCallback } from 'react';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Loader2, RefreshCw, RotateCcw, Sparkles, Trash2 } from 'lucide-react';
import {
  listOnboardingSessions,
  deleteOnboardingSession,
  type OnboardingSessionSummary,
} from '@/lib/api';
import { formatTimeAgo } from '@/lib/format';

interface OnboardingSessionsPanelProps {
  onResume: (sessionId: string) => void;
  onStartNew: () => void;
}

const PHASE_LABELS: Record<string, string> = {
  intake: 'Infrastructure & Repo',
  strategy: 'Business Strategy',
  product: 'Product Scope',
  architecture: 'Technical Architecture',
  done: 'Done',
};

const STATUS_CONFIG = {
  active:    { label: 'In progress', variant: 'default' as const },
  abandoned: { label: 'Abandoned',   variant: 'outline' as const },
};

export function OnboardingSessionsPanel({ onResume, onStartNew }: OnboardingSessionsPanelProps) {
  const [sessions, setSessions] = useState<OnboardingSessionSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [dismissing, setDismissing] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      // API defaults to active+abandoned only; completed sessions live on the project page
      const data = await listOnboardingSessions(undefined, 20);
      setSessions(data);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load sessions');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  const handleDismiss = useCallback(async (sessionId: string) => {
    setDismissing(sessionId);
    try {
      await deleteOnboardingSession(sessionId);
      setSessions(prev => prev.filter(s => s.id !== sessionId));
    } catch {
      // Optimistic — remove from list anyway; worst case a refresh will re-show
      setSessions(prev => prev.filter(s => s.id !== sessionId));
    } finally {
      setDismissing(null);
    }
  }, []);

  const activeSessions   = sessions.filter(s => s.status === 'active');
  const abandonedSessions = sessions.filter(s => s.status === 'abandoned');

  if (loading) {
    return (
      <div className="flex items-center gap-2 py-4 text-muted-foreground text-sm">
        <Loader2 className="h-4 w-4 animate-spin" />
        Loading sessions…
      </div>
    );
  }

  if (error) {
    return (
      <div className="flex items-center gap-2 py-4 text-destructive text-sm">
        <span>{error}</span>
        <Button variant="ghost" size="sm" onClick={load}>
          <RefreshCw className="h-3 w-3" />
        </Button>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      {/* In-progress sessions */}
      {activeSessions.length > 0 && (
        <div className="space-y-2">
          <p className="text-xs font-medium text-muted-foreground">In progress</p>
          {activeSessions.map(s => (
            <SessionCard
              key={s.id}
              session={s}
              onResume={onResume}
              onDismiss={handleDismiss}
              dismissing={dismissing === s.id}
            />
          ))}
        </div>
      )}

      {/* Start new */}
      <Button
        className="w-full"
        variant={activeSessions.length > 0 ? 'outline' : 'default'}
        onClick={onStartNew}
      >
        <Sparkles className="h-4 w-4 mr-2" />
        Start new onboarding
      </Button>

      {/* Abandoned sessions — resumable or dismissible */}
      {abandonedSessions.length > 0 && (
        <div className="space-y-2">
          <p className="text-xs font-medium text-muted-foreground">Abandoned — resume or dismiss</p>
          {abandonedSessions.map(s => (
            <SessionCard
              key={s.id}
              session={s}
              onResume={onResume}
              onDismiss={handleDismiss}
              dismissing={dismissing === s.id}
            />
          ))}
        </div>
      )}

      {sessions.length === 0 && (
        <p className="text-sm text-muted-foreground text-center py-2">
          No onboarding sessions yet.
        </p>
      )}
    </div>
  );
}

function SessionCard({
  session,
  onResume,
  onDismiss,
  dismissing,
}: {
  session: OnboardingSessionSummary;
  onResume: (id: string) => void;
  onDismiss: (id: string) => void;
  dismissing: boolean;
}) {
  const cfg = STATUS_CONFIG[session.status as keyof typeof STATUS_CONFIG] ?? STATUS_CONFIG.abandoned;
  const phaseLabel = PHASE_LABELS[session.phase] ?? session.phase;
  const projectName = session.context?.project_name as string | undefined;

  return (
    <div className="flex items-center justify-between rounded-lg border bg-card px-3 py-2.5 gap-3">
      <div className="flex items-center gap-2.5 min-w-0">
        <span className="text-xl shrink-0">{session.current_agent_emoji}</span>
        <div className="min-w-0">
          <p className="text-sm font-medium truncate">
            {projectName || 'Unnamed project'}
          </p>
          <p className="text-xs text-muted-foreground truncate">
            {session.current_agent_name} · {phaseLabel} · {formatTimeAgo(session.updated_at)}
          </p>
        </div>
      </div>
      <div className="flex items-center gap-1.5 shrink-0">
        <Badge variant={cfg.variant} className="text-[10px]">
          {cfg.label}
        </Badge>
        <Button
          size="sm"
          variant="ghost"
          className="h-7 px-2 text-xs"
          onClick={() => onResume(session.id)}
        >
          <RotateCcw className="h-3 w-3 mr-1" />
          Resume
        </Button>
        <Button
          size="sm"
          variant="ghost"
          className="h-7 w-7 p-0 text-muted-foreground hover:text-destructive"
          onClick={() => onDismiss(session.id)}
          disabled={dismissing}
          title="Dismiss"
        >
          {dismissing ? (
            <Loader2 className="h-3 w-3 animate-spin" />
          ) : (
            <Trash2 className="h-3 w-3" />
          )}
        </Button>
      </div>
    </div>
  );
}
