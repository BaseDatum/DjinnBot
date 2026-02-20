import { Card } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Clock, Layers, Zap } from 'lucide-react';
import { formatDistanceToNow } from 'date-fns';
import { AgentState } from '@/types/lifecycle';
import { STATE_CONFIG } from '@/lib/constants';
import { cn } from '@/lib/utils';

interface LifecycleData {
  state: AgentState;
  lastActive: number | null;
  queueDepth: number;
  currentWork: {
    runId: string;
    step: string;
    startedAt: number;
  } | null;
  pulse: {
    enabled: boolean;
    lastPulse: number | null;
    nextPulse: number | null;
    intervalMs: number;
  };
}

interface CurrentStateCardProps {
  lifecycle: LifecycleData | undefined;
}

export function CurrentStateCard({ lifecycle }: CurrentStateCardProps) {
  if (!lifecycle) {
    return (
      <Card className="p-4">
        <div className="text-sm text-muted-foreground">Loading state...</div>
      </Card>
    );
  }

  const stateConfig = STATE_CONFIG[lifecycle.state];
  const lastActiveText = lifecycle.lastActive
    ? formatDistanceToNow(lifecycle.lastActive, { addSuffix: true })
    : 'Never';

  const nextPulseText = lifecycle.pulse.enabled && lifecycle.pulse.nextPulse
    ? formatDistanceToNow(lifecycle.pulse.nextPulse, { addSuffix: true })
    : lifecycle.pulse.enabled
    ? 'Soon'
    : 'Disabled';

  return (
    <Card className="p-4">
      <div className="space-y-3">
        {/* State */}
        <div className="flex items-center gap-3">
          <div className={cn('w-3 h-3 rounded-full', stateConfig.color, 'animate-pulse')} />
          <Badge variant="secondary" className="text-base px-3 py-1">
            {stateConfig.emoji} {stateConfig.label}
          </Badge>
          {lifecycle.currentWork && (
            <span className="text-sm text-muted-foreground">
              → {lifecycle.currentWork.step} ({lifecycle.currentWork.runId})
            </span>
          )}
        </div>

        {/* Stats */}
        <div className="grid grid-cols-1 md:grid-cols-3 gap-4 pt-2">
          <div className="flex items-center gap-2">
            <Clock className="h-4 w-4 text-muted-foreground" />
            <div>
              <div className="text-xs text-muted-foreground">Last Active</div>
              <div className="text-sm font-medium">{lastActiveText}</div>
            </div>
          </div>

          <div className="flex items-center gap-2">
            <Layers className="h-4 w-4 text-muted-foreground" />
            <div>
              <div className="text-xs text-muted-foreground">Queue Depth</div>
              <div className="text-sm font-medium">
                {lifecycle.queueDepth} {lifecycle.queueDepth === 1 ? 'item' : 'items'}
              </div>
            </div>
          </div>

          <div className="flex items-center gap-2">
            <Zap className={cn('h-4 w-4', lifecycle.pulse.enabled ? 'text-green-500' : 'text-muted-foreground')} />
            <div>
              <div className="text-xs text-muted-foreground">Pulse Status</div>
              <div className="text-sm font-medium">
                {lifecycle.pulse.enabled ? `Next ${nextPulseText}` : 'Disabled'}
              </div>
            </div>
          </div>
        </div>
      </div>
    </Card>
  );
}
