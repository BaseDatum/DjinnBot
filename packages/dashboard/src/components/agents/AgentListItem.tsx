import type { AgentStatus } from '@/lib/api';
import { STATE_CONFIG } from '@/lib/constants';
import { Card } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Layers, Mail, Wrench, Zap, CheckCircle, XCircle } from 'lucide-react';
import { formatDistanceToNow } from 'date-fns';
import { cn } from '@/lib/utils';

interface AgentListItemProps {
  agent: AgentStatus;
}

export function AgentListItem({ agent }: AgentListItemProps) {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const stateConfig = (STATE_CONFIG as any)[agent.state];
  const pulseText = agent.pulseEnabled && agent.lastPulse
    ? formatDistanceToNow(agent.lastPulse, { addSuffix: true })
    : agent.pulseEnabled
    ? 'Never'
    : '—';

  return (
    <Card className="p-4 hover:shadow-md transition-all cursor-pointer border-border/50 hover:border-border">
      <div className="flex items-center gap-4">
        {/* Emoji */}
        <span className="text-3xl flex-shrink-0">{agent.emoji}</span>

        {/* Name + Role */}
        <div className="flex-1 min-w-0">
          <h3 className="font-semibold">{agent.name}</h3>
          <p className="text-sm text-muted-foreground">{agent.role}</p>
        </div>

        {/* State */}
        <div className="flex items-center gap-2 flex-shrink-0">
          <div className={cn('w-2 h-2 rounded-full', stateConfig.color, agent.state === 'working' && 'animate-pulse')} />
          <Badge variant="secondary">
            {stateConfig.label}
          </Badge>
          {agent.currentWork && agent.state === 'working' && (
            <span className="text-sm text-muted-foreground">
              → {agent.currentWork.step}
            </span>
          )}
        </div>

        {/* Stats */}
        <div className="flex items-center gap-6 text-sm flex-shrink-0">
          <div className="flex items-center gap-1.5 min-w-[60px]">
            <Layers className="h-4 w-4 text-muted-foreground" />
            <span className="font-medium">{agent.queueLength}</span>
          </div>
          <div className="flex items-center gap-1.5 min-w-[60px]">
            <Mail className="h-4 w-4 text-muted-foreground" />
            <span className={cn(agent.unreadCount > 0 && 'text-blue-500 font-medium')}>
              {agent.unreadCount}
            </span>
          </div>
          <div className="flex items-center gap-1.5 min-w-[50px]">
            <Wrench className="h-4 w-4 text-muted-foreground" />
            <span>{agent.installedTools}</span>
          </div>
          <div className="flex items-center gap-1.5 min-w-[80px]">
            <Zap className={cn('h-4 w-4', agent.pulseEnabled ? 'text-green-500' : 'text-muted-foreground')} />
            <span className="text-xs">{pulseText}</span>
          </div>
        </div>

        {/* Slack */}
        <div className="flex items-center gap-1.5 flex-shrink-0">
          {agent.slackConnected ? (
            <CheckCircle className="h-4 w-4 text-green-500" />
          ) : (
            <XCircle className="h-4 w-4 text-muted-foreground" />
          )}
        </div>
      </div>
    </Card>
  );
}
