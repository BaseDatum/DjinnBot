import { Badge } from '@/components/ui/badge';
import { Activity, CheckCircle, Circle, XCircle, AlertCircle, LogOut } from 'lucide-react';
import type { ContainerStatus } from '@/types/container';

interface ContainerStatusBadgeProps {
  status: ContainerStatus;
  runId?: string;
}

export function ContainerStatusBadge({ status, runId }: ContainerStatusBadgeProps) {
  const statusConfig = {
    ready: {
      label: 'Ready',
      variant: 'default' as const,
      icon: CheckCircle,
      color: 'text-emerald-400',
    },
    busy: {
      label: 'Busy',
      variant: 'default' as const,
      icon: Activity,
      color: 'text-blue-400',
    },
    idle: {
      label: 'Idle',
      variant: 'secondary' as const,
      icon: Circle,
      color: 'text-zinc-400',
    },
    error: {
      label: 'Error',
      variant: 'destructive' as const,
      icon: XCircle,
      color: 'text-red-400',
    },
    exiting: {
      label: 'Exiting',
      variant: 'outline' as const,
      icon: LogOut,
      color: 'text-orange-400',
    },
  };

  const config = statusConfig[status];
  const Icon = config.icon;

  return (
    <div className="flex items-center gap-2">
      <Badge variant={config.variant} className="flex items-center gap-1.5">
        <Icon className={`h-3 w-3 ${config.color}`} />
        {config.label}
      </Badge>
      {runId && (
        <span className="text-xs text-muted-foreground font-mono">
          {runId.substring(0, 8)}
        </span>
      )}
    </div>
  );
}

interface ContainerStatusCardProps {
  status: ContainerStatus | null;
  runId?: string;
  lastUpdate?: number;
}

export function ContainerStatusCard({ status, runId, lastUpdate }: ContainerStatusCardProps) {
  if (!status) {
    return (
      <div className="flex items-center gap-2 px-3 py-2 rounded-md bg-muted/30 border">
        <AlertCircle className="h-4 w-4 text-muted-foreground" />
        <span className="text-sm text-muted-foreground">No container status</span>
      </div>
    );
  }

  return (
    <div className="flex items-center justify-between px-3 py-2 rounded-md bg-muted/30 border">
      <div className="flex items-center gap-3">
        <span className="text-xs font-medium text-muted-foreground">Container</span>
        <ContainerStatusBadge status={status} runId={runId} />
      </div>
      {lastUpdate && (
        <span className="text-xs text-muted-foreground">
          {new Date(lastUpdate).toLocaleTimeString()}
        </span>
      )}
    </div>
  );
}
