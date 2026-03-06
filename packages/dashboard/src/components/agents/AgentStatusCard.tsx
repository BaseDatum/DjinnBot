import type { AgentStatus } from '@/lib/api';
import { STATE_CONFIG } from '@/lib/constants';
import { Card } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Layers, Mail, Wrench, Zap, CheckCircle, XCircle } from 'lucide-react';
import { formatDistanceToNow } from 'date-fns';
import { cn } from '@/lib/utils';

interface AgentStatusCardProps {
  agent: AgentStatus;
}

export function AgentStatusCard({ agent }: AgentStatusCardProps) {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const stateConfig = (STATE_CONFIG as any)[agent.state];
  const pulseText = agent.pulseEnabled && agent.lastPulse
    ? formatDistanceToNow(agent.lastPulse, { addSuffix: true })
    : agent.pulseEnabled
    ? 'Never'
    : '—';

  return (
    <Card className="p-4 hover:shadow-lg transition-all cursor-pointer h-full border-border/50 hover:border-border">
      <div className="space-y-3">
        {/* Header: Emoji + Name + Role */}
        <div>
          <div className="flex items-center gap-2 mb-1">
            <span className="text-2xl">{agent.emoji}</span>
            <div className="flex-1 min-w-0">
              <h3 className="font-semibold truncate">{agent.name}</h3>
              <p className="text-xs text-muted-foreground truncate">{agent.role}</p>
            </div>
          </div>
        </div>

        {/* State badge */}
        <div className="flex items-center gap-2">
          <div className={cn('w-2 h-2 rounded-full', stateConfig.color, agent.state === 'working' && 'animate-pulse')} />
          <Badge variant="secondary" className="text-xs">
            {stateConfig.label}
          </Badge>
          {agent.currentWork && agent.state === 'working' && (
            <span className="text-xs text-muted-foreground truncate">
              → {agent.currentWork.step}
            </span>
          )}
        </div>

        {/* Stats */}
        <div className="space-y-2 text-sm">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-1.5 text-muted-foreground">
              <Layers className="h-3.5 w-3.5" />
              <span>Queue:</span>
            </div>
            <span className="font-medium">{agent.queueLength}</span>
          </div>

          <div className="flex items-center justify-between">
            <div className="flex items-center gap-1.5 text-muted-foreground">
              <Mail className="h-3.5 w-3.5" />
              <span>Unread:</span>
            </div>
            <span className={cn('font-medium', agent.unreadCount > 0 && 'text-blue-500')}>
              {agent.unreadCount}
            </span>
          </div>

          <div className="flex items-center justify-between">
            <div className="flex items-center gap-1.5 text-muted-foreground">
              <Wrench className="h-3.5 w-3.5" />
              <span>Tools:</span>
            </div>
            <span className="font-medium">{agent.installedTools}</span>
          </div>

          <div className="flex items-center justify-between">
            <div className="flex items-center gap-1.5 text-muted-foreground">
              <Zap className={cn('h-3.5 w-3.5', agent.pulseEnabled && 'text-green-500')} />
              <span>Pulse:</span>
            </div>
            <span className="text-xs">{pulseText}</span>
          </div>
        </div>

        {/* Slack status */}
        <div className="pt-2 border-t flex items-center justify-between text-xs">
          <span className="text-muted-foreground">Slack</span>
          <div className="flex items-center gap-1">
            {agent.slackConnected ? (
              <>
                <CheckCircle className="h-3.5 w-3.5 text-green-500" />
                <span className="text-green-600 dark:text-green-400">Connected</span>
              </>
            ) : (
              <>
                <XCircle className="h-3.5 w-3.5 text-muted-foreground" />
                <span className="text-muted-foreground">Offline</span>
              </>
            )}
          </div>
        </div>
      </div>
    </Card>
  );
}
