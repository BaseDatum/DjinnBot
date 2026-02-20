import { useEffect, useState } from 'react';
import { Skeleton } from '@/components/ui/skeleton';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { 
  Activity, 
  ChevronDown, 
  ChevronUp,
  Clock, 
  CheckCircle2, 
  XCircle,
  Loader2 
} from 'lucide-react';
import { toast } from 'sonner';
import { useSSE } from '@/hooks/useSSE';
import { fetchAgentPulseStatus, triggerAgentPulse, API_BASE } from '@/lib/api';

interface PulseCheck {
  name: string;
  status: 'success' | 'failed' | 'skipped';
  duration: number;
  details?: string;
}

interface PulseStatusData {
  enabled: boolean;
  intervalMinutes: number;
  timeoutMs: number;
  lastPulse: {
    timestamp: number;
    duration: number;
    summary: string;
    checksCompleted: number;
    checksFailed: number;
    checks: PulseCheck[];
  } | null;
  nextPulse: number | null;
  checks: {
    inbox: boolean;
    consolidateMemories: boolean;
    updateWorkspaceDocs: boolean;
    cleanupStaleFiles: boolean;
    postStatusSlack: boolean;
  };
}

function formatRelativeTime(timestamp: number): string {
  const now = Date.now();
  const diff = now - timestamp * 1000;
  const seconds = Math.floor(diff / 1000);
  const minutes = Math.floor(seconds / 60);
  const hours = Math.floor(minutes / 60);
  const days = Math.floor(hours / 24);

  if (days > 0) return `${days} day${days > 1 ? 's' : ''} ago`;
  if (hours > 0) return `${hours} hour${hours > 1 ? 's' : ''} ago`;
  if (minutes > 0) return `${minutes} minute${minutes > 1 ? 's' : ''} ago`;
  if (seconds > 0) return `${seconds} second${seconds > 1 ? 's' : ''} ago`;
  return 'just now';
}

function formatTimestamp(timestamp: number): string {
  return new Date(timestamp * 1000).toLocaleString();
}

interface PulseControlsProps {
  agentId: string;
}

export function PulseControls({ agentId }: PulseControlsProps) {
  const [status, setStatus] = useState<PulseStatusData | null>(null);
  const [loading, setLoading] = useState(true);
  const [pulsing, setPulsing] = useState(false);
  const [resultsOpen, setResultsOpen] = useState(false);

  useEffect(() => {
    loadStatus();
  }, [agentId]);

  // Subscribe to pulse events
  useSSE<{ type: string; agentId: string }>({
    url: `${API_BASE}/agents/events`,
    onMessage: (event) => {
      if (event.type === 'AGENT_PULSE_COMPLETED' && event.agentId === agentId) {
        loadStatus(); // Refresh status after pulse
        setPulsing(false);
        toast.success('Pulse completed');
      }
    },
  });

  const loadStatus = async () => {
    try {
      const data = await fetchAgentPulseStatus(agentId);
      setStatus(data);
    } catch (error) {
      console.error('Failed to load pulse status:', error);
      toast.error('Failed to load pulse status');
    } finally {
      setLoading(false);
    }
  };

  const handleForcePulse = async () => {
    setPulsing(true);
    try {
      await triggerAgentPulse(agentId);
      toast.info('Pulse triggered');
      // Status will update via SSE when pulse completes
    } catch (error) {
      console.error('Failed to trigger pulse:', error);
      toast.error(
        error instanceof Error ? error.message : 'Failed to trigger pulse'
      );
      setPulsing(false);
    }
  };

  const getCheckIcon = (checkStatus: 'success' | 'failed' | 'skipped') => {
    switch (checkStatus) {
      case 'success':
        return <CheckCircle2 className="h-4 w-4 text-green-500" />;
      case 'failed':
        return <XCircle className="h-4 w-4 text-red-500" />;
      case 'skipped':
        return <span className="h-4 w-4 text-muted-foreground">—</span>;
    }
  };

  if (loading) {
    return (
      <div className="space-y-4">
        <div className="rounded-lg border p-4 space-y-4">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              <Skeleton width={20} height={20} />
              <Skeleton width={120} height={18} />
              <Skeleton width={60} height={22} />
            </div>
            <Skeleton width={100} height={32} />
          </div>
          <div className="grid grid-cols-3 gap-4">
            {[...Array(3)].map((_, i) => (
              <div key={i} className="space-y-1">
                <Skeleton width="60%" height={12} />
                <Skeleton width="80%" height={16} />
              </div>
            ))}
          </div>
        </div>
      </div>
    );
  }

  if (!status) {
    return (
      <Alert variant="destructive">
        <AlertDescription>Pulse status not available</AlertDescription>
      </Alert>
    );
  }

  return (
    <div className="space-y-4">
      {/* Pulse Status Card */}
      <Card>
        <CardHeader className="pb-3">
          <div className="flex items-start justify-between">
            <div className="flex items-center gap-2">
              <Activity className="h-5 w-5" />
              <CardTitle className="text-lg">Pulse System</CardTitle>
              <Badge variant={status.enabled ? 'success' : 'secondary'}>
                {status.enabled ? 'Enabled' : 'Disabled'}
              </Badge>
            </div>
            <Button
              size="sm"
              onClick={handleForcePulse}
              disabled={pulsing || !status.enabled}
            >
              {pulsing ? (
                <>
                  <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                  Running...
                </>
              ) : (
                <>
                  <Activity className="h-4 w-4 mr-2" />
                  Force Pulse
                </>
              )}
            </Button>
          </div>
        </CardHeader>
        <CardContent>
          {/* Status Grid */}
          <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
            {/* Interval */}
            <div>
              <p className="text-xs text-muted-foreground mb-1">Interval</p>
              <p className="font-medium">
                {status.intervalMinutes} minutes
              </p>
            </div>

            {/* Last Pulse */}
            <div>
              <p className="text-xs text-muted-foreground mb-1">Last Pulse</p>
              <p className="font-medium">
                {status.lastPulse ? (
                  <span className="flex items-center gap-1">
                    <Clock className="h-3 w-3" />
                    {formatRelativeTime(status.lastPulse.timestamp)}
                  </span>
                ) : (
                  <span className="text-muted-foreground">Never</span>
                )}
              </p>
            </div>

            {/* Next Pulse */}
            <div>
              <p className="text-xs text-muted-foreground mb-1">Next Pulse</p>
              <p className="font-medium">
                {status.nextPulse ? (
                  <span className="flex items-center gap-1">
                    <Clock className="h-3 w-3" />
                    {formatRelativeTime(status.nextPulse)}
                  </span>
                ) : (
                  <span className="text-muted-foreground">N/A</span>
                )}
              </p>
            </div>
          </div>
        </CardContent>
      </Card>

      {/* Last Pulse Results */}
      {status.lastPulse && status.lastPulse.checks && status.lastPulse.checks.length > 0 && (
        <div className="border rounded-lg">
          <button
            onClick={() => setResultsOpen(!resultsOpen)}
            className="w-full flex items-center justify-between p-4 hover:bg-muted/50 transition-colors"
          >
            <span className="flex items-center gap-2">
              Last Pulse Results
              <Badge variant="secondary">
                {status.lastPulse.checks.length} checks
              </Badge>
            </span>
            {resultsOpen ? (
              <ChevronUp className="h-4 w-4" />
            ) : (
              <ChevronDown className="h-4 w-4" />
            )}
          </button>

          {resultsOpen && (
            <div className="p-4 pt-0 border-t space-y-3">
              {/* Results Header */}
              <div className="flex items-center justify-between text-sm text-muted-foreground pt-3">
                <span>
                  Ran {formatTimestamp(status.lastPulse.timestamp)}
                </span>
                <span>
                  Duration: {(status.lastPulse.duration / 1000).toFixed(2)}s
                </span>
              </div>

              <div className="space-y-2">
                {/* Check Results */}
                {status.lastPulse.checks.map((check, index) => (
                  <div
                    key={index}
                    className="flex items-start gap-3 p-3 rounded-lg bg-muted/50"
                  >
                    {getCheckIcon(check.status)}
                    <div className="flex-1 min-w-0">
                      <p className="font-medium text-sm">{check.name}</p>
                      {check.details && (
                        <p className="text-xs text-muted-foreground mt-1">
                          {check.details}
                        </p>
                      )}
                    </div>
                    <Badge
                      variant={
                        check.status === 'success'
                          ? 'success'
                          : check.status === 'failed'
                          ? 'destructive'
                          : 'secondary'
                      }
                    >
                      {check.status}
                    </Badge>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      )}

      {/* Help Text */}
      <p className="text-xs text-muted-foreground">
        The pulse system runs periodic health checks like inbox monitoring, memory
        consolidation, and cleanup tasks. Use &quot;Force Pulse&quot; to run immediately.
      </p>
    </div>
  );
}
