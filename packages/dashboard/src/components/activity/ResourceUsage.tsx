import { Card } from '@/components/ui/card';
import { ResourceUsage } from '@/lib/api';

interface ResourceUsageProps {
  resourceUsage: ResourceUsage | undefined;
}

function ProgressBar({ value, color }: { value: number; color: string }) {
  return (
    <div className="h-2 bg-muted rounded-full overflow-hidden">
      <div
        className={`h-full rounded-full transition-all ${color}`}
        style={{ width: `${Math.min(value, 100)}%` }}
      />
    </div>
  );
}

export function ResourceUsageDisplay({ resourceUsage }: ResourceUsageProps) {
  if (!resourceUsage) {
    return (
      <Card className="p-4">
        <h3 className="font-semibold mb-3">Resource Usage</h3>
        <div className="text-sm text-muted-foreground">No resource data available</div>
      </Card>
    );
  }

  const memoryPercent = (resourceUsage.memory.used / resourceUsage.memory.limit) * 100;
  const cpuPercent = (resourceUsage.cpu.used / resourceUsage.cpu.cores) * 100;
  const pidsPercent = (resourceUsage.pids.count / resourceUsage.pids.limit) * 100;

  const getProgressColor = (percent: number): string => {
    if (percent >= 90) return 'bg-red-500';
    if (percent >= 70) return 'bg-orange-500';
    return 'bg-green-500';
  };

  return (
    <Card className="p-4">
      <h3 className="font-semibold mb-4">Resource Usage (Last 24h)</h3>

      <div className="space-y-4">
        {/* Memory */}
        <div>
          <div className="flex items-center justify-between mb-2">
            <span className="text-sm font-medium">Memory</span>
            <span className="text-sm text-muted-foreground">
              {resourceUsage.memory.used} {resourceUsage.memory.unit} / {resourceUsage.memory.limit} {resourceUsage.memory.unit}
            </span>
          </div>
          <ProgressBar
            value={memoryPercent}
            color={getProgressColor(memoryPercent)}
          />
        </div>

        {/* CPU */}
        <div>
          <div className="flex items-center justify-between mb-2">
            <span className="text-sm font-medium">CPU</span>
            <span className="text-sm text-muted-foreground">
              {resourceUsage.cpu.used.toFixed(1)} / {resourceUsage.cpu.cores} cores
            </span>
          </div>
          <ProgressBar
            value={cpuPercent}
            color={getProgressColor(cpuPercent)}
          />
        </div>

        {/* PIDs */}
        <div>
          <div className="flex items-center justify-between mb-2">
            <span className="text-sm font-medium">Processes</span>
            <span className="text-sm text-muted-foreground">
              {resourceUsage.pids.count} / {resourceUsage.pids.limit}
            </span>
          </div>
          <ProgressBar
            value={pidsPercent}
            color={getProgressColor(pidsPercent)}
          />
        </div>
      </div>
    </Card>
  );
}
