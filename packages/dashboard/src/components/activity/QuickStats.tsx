/**
 * QuickStats — compact row of agent activity metrics.
 *
 * Shows: sessions today/week, tokens used (24h), cost (24h), errors.
 * Fetched once on mount via REST (not streamed).
 */

import { useQuery } from '@tanstack/react-query';
import { fetchAgentActivityStats } from '@/lib/api';
import { Activity, Zap, DollarSign, AlertTriangle, Calendar } from 'lucide-react';
import { cn } from '@/lib/utils';

interface QuickStatsProps {
  agentId: string;
}

function formatTokens(n: number): string {
  if (n === 0) return '0';
  if (n < 1000) return String(n);
  if (n < 1_000_000) return `${(n / 1000).toFixed(1)}k`;
  return `${(n / 1_000_000).toFixed(1)}M`;
}

function formatCost(n: number): string {
  if (n === 0) return '$0';
  if (n < 0.01) return `$${n.toFixed(4)}`;
  return `$${n.toFixed(2)}`;
}

export function QuickStats({ agentId }: QuickStatsProps) {
  const { data: stats } = useQuery({
    queryKey: ['activity-stats', agentId],
    queryFn: () => fetchAgentActivityStats(agentId),
    refetchInterval: 60_000, // Refresh stats every minute
    staleTime: 30_000,
  });

  if (!stats) return null;

  const items = [
    {
      icon: Activity,
      label: 'Today',
      value: String(stats.sessionsToday),
      color: 'text-blue-400',
    },
    {
      icon: Calendar,
      label: 'This Week',
      value: String(stats.sessionsThisWeek),
      color: 'text-indigo-400',
    },
    {
      icon: Zap,
      label: 'Tokens (24h)',
      value: formatTokens(stats.totalTokens),
      color: 'text-amber-400',
    },
    {
      icon: DollarSign,
      label: 'Cost (24h)',
      value: formatCost(stats.totalCost),
      color: 'text-emerald-400',
    },
    ...(stats.errorCount > 0
      ? [{
          icon: AlertTriangle,
          label: 'Errors (24h)',
          value: String(stats.errorCount),
          color: 'text-red-400',
        }]
      : []),
  ];

  return (
    <div className="flex items-center gap-4 px-4 py-2 border-b border-border/30 overflow-x-auto">
      {items.map((item) => {
        const Icon = item.icon;
        return (
          <div key={item.label} className="flex items-center gap-1.5 shrink-0">
            <Icon className={cn('h-3.5 w-3.5', item.color)} />
            <span className="text-xs text-muted-foreground">{item.label}</span>
            <span className="text-xs font-medium text-foreground">{item.value}</span>
          </div>
        );
      })}
    </div>
  );
}
