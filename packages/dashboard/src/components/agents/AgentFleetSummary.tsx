import { AgentStatus } from '@/lib/api';
import { Card } from '@/components/ui/card';

interface AgentFleetSummaryProps {
  agents: AgentStatus[];
}

function ProgressBar({ value, className }: { value: number; className?: string }) {
  return (
    <div className={`h-2 bg-muted rounded-full overflow-hidden ${className}`}>
      <div
        className="h-full bg-primary rounded-full transition-all"
        style={{ width: `${Math.min(value, 100)}%` }}
      />
    </div>
  );
}

export function AgentFleetSummary({ agents }: AgentFleetSummaryProps) {
  const total = agents.length;
  const working = agents.filter(a => a.state === 'working').length;
  const thinking = agents.filter(a => a.state === 'thinking').length;
  const idle = agents.filter(a => a.state === 'idle').length;
  const totalQueued = agents.reduce((sum, a) => sum + a.queueLength, 0);

  const activeCount = working + thinking;
  const activePercent = total > 0 ? (activeCount / total) * 100 : 0;

  if (total === 0) {
    return null;
  }

  return (
    <Card className="p-4">
      <div className="flex items-center justify-between mb-3">
        <h3 className="font-semibold">Agent Fleet</h3>
        <div className="text-sm text-muted-foreground">
          {total} agents · {working} working · {thinking} thinking · {idle} idle · {totalQueued} queued
        </div>
      </div>
      <ProgressBar value={activePercent} />
      <div className="flex items-center justify-between text-xs text-muted-foreground mt-2">
        <span>Activity: {activePercent.toFixed(0)}%</span>
        <span>{totalQueued} items in queue</span>
      </div>
    </Card>
  );
}
