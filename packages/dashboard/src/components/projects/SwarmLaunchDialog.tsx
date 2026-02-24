import { useState, useEffect } from 'react';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Zap, AlertTriangle, GitBranch, Loader2, X, ChevronRight,
} from 'lucide-react';
import { toast } from 'sonner';
import {
  previewProjectSwarm,
  launchProjectSwarm,
  type SwarmPreview,
  type BoardSwarmResult,
} from '@/lib/api';

interface SwarmLaunchDialogProps {
  projectId: string;
  selectedTaskIds: string[];
  agents: Array<{ agent_id: string; role: string }>;
  onClose: () => void;
  onLaunched: (result: BoardSwarmResult) => void;
}

export function SwarmLaunchDialog({
  projectId,
  selectedTaskIds,
  agents,
  onClose,
  onLaunched,
}: SwarmLaunchDialogProps) {
  const [preview, setPreview] = useState<SwarmPreview | null>(null);
  const [loading, setLoading] = useState(true);
  const [launching, setLaunching] = useState(false);
  const [agentId, setAgentId] = useState(agents[0]?.agent_id || '');
  const [maxConcurrent, setMaxConcurrent] = useState(3);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (selectedTaskIds.length === 0) return;
    setLoading(true);
    setError(null);
    previewProjectSwarm(projectId, { taskIds: selectedTaskIds, agentId: agentId || agents[0]?.agent_id })
      .then(setPreview)
      .catch((err) => setError(err.message || 'Failed to preview swarm'))
      .finally(() => setLoading(false));
  }, [projectId, selectedTaskIds, agentId]);

  const handleLaunch = async () => {
    if (!agentId) {
      toast.error('Select an agent');
      return;
    }
    setLaunching(true);
    try {
      const result = await launchProjectSwarm(projectId, {
        taskIds: selectedTaskIds,
        agentId,
        maxConcurrent,
      });
      toast.success(`Swarm launched: ${result.total_tasks} tasks`);
      onLaunched(result);
    } catch (err: any) {
      toast.error(err.message || 'Failed to launch swarm');
    } finally {
      setLaunching(false);
    }
  };

  return (
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4">
      <Card className="w-full max-w-lg max-h-[80vh] overflow-y-auto">
        <CardHeader className="pb-3">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              <Zap className="h-5 w-5 text-amber-500" />
              <CardTitle className="text-base">Launch Swarm Execution</CardTitle>
            </div>
            <Button variant="ghost" size="sm" className="h-7 w-7 p-0" onClick={onClose}>
              <X className="h-4 w-4" />
            </Button>
          </div>
        </CardHeader>
        <CardContent className="space-y-4">
          {loading ? (
            <div className="flex items-center justify-center py-8 gap-2 text-muted-foreground">
              <Loader2 className="h-4 w-4 animate-spin" />
              <span className="text-sm">Building dependency graph...</span>
            </div>
          ) : error ? (
            <div className="text-sm text-destructive">{error}</div>
          ) : preview ? (
            <>
              {/* DAG summary */}
              <div className="grid grid-cols-3 gap-3 text-center">
                <div className="rounded-lg border p-2">
                  <div className="text-lg font-bold">{preview.total_tasks}</div>
                  <div className="text-[10px] text-muted-foreground">Tasks</div>
                </div>
                <div className="rounded-lg border p-2">
                  <div className="text-lg font-bold">{preview.dag_depth}</div>
                  <div className="text-[10px] text-muted-foreground">DAG Depth</div>
                </div>
                <div className="rounded-lg border p-2">
                  <div className="text-lg font-bold">{preview.root_tasks.length}</div>
                  <div className="text-[10px] text-muted-foreground">Parallel Roots</div>
                </div>
              </div>

              {/* Task list */}
              <div>
                <Label className="text-xs">Tasks in swarm</Label>
                <div className="space-y-1 mt-1 max-h-40 overflow-y-auto">
                  {preview.tasks.map((t) => (
                    <div key={t.key} className="flex items-center gap-2 text-xs p-1.5 rounded bg-muted/30">
                      <Badge variant="outline" className="text-[9px] shrink-0">{t.priority}</Badge>
                      <span className="truncate flex-1">{t.title}</span>
                      {t.dependencies.length > 0 && (
                        <span className="text-[10px] text-muted-foreground shrink-0 flex items-center gap-0.5">
                          <GitBranch className="h-2.5 w-2.5" />
                          {t.dependencies.length} dep{t.dependencies.length > 1 ? 's' : ''}
                        </span>
                      )}
                    </div>
                  ))}
                </div>
              </div>

              {/* Warnings */}
              {preview.warnings.length > 0 && (
                <div className="rounded-lg border border-amber-500/30 bg-amber-500/5 p-3">
                  <div className="flex items-center gap-1.5 text-amber-600 text-xs font-medium mb-1">
                    <AlertTriangle className="h-3.5 w-3.5" />
                    Warnings
                  </div>
                  <ul className="text-[11px] text-amber-700 space-y-0.5">
                    {preview.warnings.map((w, i) => (
                      <li key={i}>{w}</li>
                    ))}
                  </ul>
                </div>
              )}

              {/* Settings */}
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <Label className="text-xs">Agent</Label>
                  <select
                    value={agentId}
                    onChange={(e) => setAgentId(e.target.value)}
                    className="w-full h-9 rounded-md border bg-background px-3 text-sm mt-1"
                  >
                    {agents.map((a) => (
                      <option key={a.agent_id} value={a.agent_id}>
                        {a.agent_id} ({a.role})
                      </option>
                    ))}
                  </select>
                </div>
                <div>
                  <Label className="text-xs">Max Concurrent</Label>
                  <Input
                    type="number"
                    min={1}
                    max={8}
                    value={maxConcurrent}
                    onChange={(e) => setMaxConcurrent(parseInt(e.target.value) || 3)}
                    className="h-9 mt-1"
                  />
                </div>
              </div>

              {/* Launch */}
              <div className="flex gap-2 pt-2">
                <Button
                  onClick={handleLaunch}
                  disabled={launching || preview.total_tasks === 0}
                  className="flex-1"
                >
                  {launching ? (
                    <>
                      <Loader2 className="h-4 w-4 animate-spin mr-2" />
                      Launching...
                    </>
                  ) : (
                    <>
                      <Zap className="h-4 w-4 mr-2" />
                      Launch {preview.total_tasks} Tasks
                    </>
                  )}
                </Button>
                <Button variant="outline" onClick={onClose}>
                  Cancel
                </Button>
              </div>
            </>
          ) : null}
        </CardContent>
      </Card>
    </div>
  );
}
