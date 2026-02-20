import { useState, useEffect } from 'react';
import { Link } from '@tanstack/react-router';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  X,
  Lock,
  ChevronRight,
  Play,
  CheckCircle2,
  Zap,
} from 'lucide-react';
import {
  fetchTask,
  fetchProject,
  updateTask,
  deleteTask,
  addDependency,
  removeDependency,
  executeTask,
  fetchPipelines,
} from '@/lib/api';
import { PRIORITY_COLORS } from './constants';
import type { Task, TaskDetail, Pipeline } from './types';
import { ConfirmDialog } from '@/components/ConfirmDialog';

interface TaskDetailPanelProps {
  task: Task;
  projectId: string;
  onClose: () => void;
  onUpdated: () => void;
}

export function TaskDetailPanel({
  task,
  projectId,
  onClose,
  onUpdated,
}: TaskDetailPanelProps) {
  const [detail, setDetail] = useState<TaskDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [editing, setEditing] = useState(false);
  const [editTitle, setEditTitle] = useState('');
  const [editDesc, setEditDesc] = useState('');
  const [saving, setSaving] = useState(false);
  const [showAddDep, setShowAddDep] = useState(false);
  const [depSearch, setDepSearch] = useState('');
  const [allTasks, setAllTasks] = useState<Task[]>([]);
  const [addingDep, setAddingDep] = useState(false);
  const [executing, setExecuting] = useState(false);
  const [pipelines, setPipelines] = useState<Pipeline[]>([]);
  const [selectedPipeline, setSelectedPipeline] = useState<string>('');
  const [projectDefaultPipeline, setProjectDefaultPipeline] = useState<string>('');
  const [confirmAction, setConfirmAction] = useState<{ title: string; desc: string; action: () => void } | null>(null);

  useEffect(() => {
    setLoading(true);
    fetchTask(projectId, task.id)
      .then((data) => {
        setDetail(data);
        setEditTitle(data.title);
        setEditDesc(data.description || '');
      })
      .catch(() => {})
      .finally(() => setLoading(false));
  }, [task.id, projectId]);

  useEffect(() => {
    if (showAddDep && allTasks.length === 0) {
      fetchProject(projectId).then(p => {
        setAllTasks(p.tasks?.filter((t: Task) => t.id !== task.id) || []);
      }).catch(() => {});
    }
  }, [showAddDep, projectId, task.id, allTasks.length]);

  useEffect(() => {
    // Fetch pipelines and project default
    fetchPipelines().then((data) => {
      const pls = Array.isArray(data) ? data : data.pipelines || [];
      setPipelines(pls);
    }).catch(() => {});
    
    fetchProject(projectId).then((p) => {
      setProjectDefaultPipeline(p.default_pipeline_id || '');
    }).catch(() => {});
  }, [projectId]);

  const handleSave = async () => {
    setSaving(true);
    try {
      await updateTask(projectId, task.id, { title: editTitle, description: editDesc });
      setEditing(false);
      onUpdated();
      // Refresh detail
      const updated = await fetchTask(projectId, task.id);
      setDetail(updated);
    } catch (err) {
      console.error('Failed to save:', err);
    } finally {
      setSaving(false);
    }
  };

  const handleDelete = () => {
    setConfirmAction({
      title: 'Delete Task',
      desc: 'Are you sure you want to delete this task? This action cannot be undone.',
      action: async () => {
        try {
          await deleteTask(projectId, task.id);
          onClose();
          onUpdated();
        } catch (err) {
          console.error('Failed to delete:', err);
        }
      }
    });
  };

  const handleAddDep = async (fromTaskId: string) => {
    setAddingDep(true);
    try {
      await addDependency(projectId, task.id, fromTaskId, 'blocks');
      setShowAddDep(false);
      setDepSearch('');
      onUpdated();
      // Refresh detail
      const updated = await fetchTask(projectId, task.id);
      setDetail(updated);
    } catch (err: unknown) {
      alert((err instanceof Error ? err.message : String(err)) || 'Failed to add dependency');
    } finally {
      setAddingDep(false);
    }
  };

  const handleRemoveDep = async (depId: string) => {
    try {
      await removeDependency(projectId, task.id, depId);
      onUpdated();
      const updated = await fetchTask(projectId, task.id);
      setDetail(updated);
    } catch (err) {
      console.error('Failed to remove dependency:', err);
    }
  };

  const handleExecute = async () => {
    setExecuting(true);
    try {
      await executeTask(projectId, task.id, selectedPipeline ? { pipelineId: selectedPipeline } : undefined);
      onUpdated();
      // Refresh detail
      const updated = await fetchTask(projectId, task.id);
      setDetail(updated);
    } catch (err: unknown) {
      alert((err instanceof Error ? err.message : String(err)) || 'Failed to execute task');
    } finally {
      setExecuting(false);
    }
  };

  const priorityClass = PRIORITY_COLORS[task.priority] || PRIORITY_COLORS.P2;

  return (
    <div className="fixed inset-y-0 right-0 z-50 w-full sm:w-[480px] bg-card border-l shadow-xl flex flex-col">
      {/* Header */}
      <div className="flex items-center justify-between px-4 py-3 border-b shrink-0">
        <div className="flex items-center gap-2">
          <Badge variant="outline" className={`${priorityClass}`}>{task.priority}</Badge>
          <span className="text-xs text-muted-foreground font-mono">{task.id.substring(0, 12)}</span>
        </div>
        <div className="flex items-center gap-1">
          <Button variant="ghost" size="sm" onClick={handleDelete} className="text-destructive hover:text-destructive">
            Delete
          </Button>
          <Button variant="ghost" size="sm" onClick={onClose}>
            <X className="h-4 w-4" />
          </Button>
        </div>
      </div>

      {/* Content */}
      <div className="flex-1 overflow-y-auto p-4 space-y-6">
        {loading ? (
          <p className="text-muted-foreground">Loading...</p>
        ) : detail ? (
          <>
            {/* Title & Description */}
            {editing ? (
              <div className="space-y-3">
                <input
                  type="text"
                  value={editTitle}
                  onChange={(e) => setEditTitle(e.target.value)}
                  className="text-lg font-semibold w-full bg-transparent border-b border-input pb-1 focus:outline-none focus:border-primary"
                />
                <textarea
                  value={editDesc}
                  onChange={(e) => setEditDesc(e.target.value)}
                  className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm resize-y h-32 font-mono"
                  placeholder="Task description (markdown supported)"
                />
                <div className="flex gap-2">
                  <Button size="sm" onClick={handleSave} disabled={saving}>
                    {saving ? 'Saving...' : 'Save'}
                  </Button>
                  <Button size="sm" variant="outline" onClick={() => setEditing(false)}>Cancel</Button>
                </div>
              </div>
            ) : (
              <div>
                <h2
                  className="text-lg font-semibold cursor-pointer hover:text-primary transition-colors"
                  onClick={() => setEditing(true)}
                >
                  {detail.title}
                </h2>
                {detail.description ? (
                  <p
                    className="text-sm text-muted-foreground mt-2 whitespace-pre-wrap cursor-pointer hover:text-foreground transition-colors"
                    onClick={() => setEditing(true)}
                  >
                    {detail.description}
                  </p>
                ) : (
                  <p
                    className="text-sm text-muted-foreground mt-2 italic cursor-pointer hover:text-foreground"
                    onClick={() => setEditing(true)}
                  >
                    Click to add description...
                  </p>
                )}
              </div>
            )}

            {/* Metadata */}
            <div className="grid grid-cols-2 gap-3 text-sm">
              <div>
                <label className="text-xs text-muted-foreground block mb-1">Status</label>
                <Badge variant="outline">{detail.status}</Badge>
              </div>
              <div>
                <label className="text-xs text-muted-foreground block mb-1">Priority</label>
                <Badge variant="outline" className={priorityClass}>{detail.priority}</Badge>
              </div>
              <div>
                <label className="text-xs text-muted-foreground block mb-1">Agent</label>
                <span>{detail.assigned_agent || '—'}</span>
              </div>
              <div>
                <label className="text-xs text-muted-foreground block mb-1">Estimate</label>
                <span>{detail.estimated_hours ? `${detail.estimated_hours}h` : '—'}</span>
              </div>
            </div>

            {/* Tags */}
            {detail.tags?.length > 0 && (
              <div>
                <label className="text-xs text-muted-foreground block mb-1.5">Tags</label>
                <div className="flex flex-wrap gap-1">
                  {detail.tags.map((tag: string) => (
                    <Badge key={tag} variant="secondary" className="text-xs">{tag}</Badge>
                  ))}
                </div>
              </div>
            )}

            {/* Execute */}
            {detail && ['ready', 'backlog', 'planning'].includes(detail.status) && (
              <div className="border rounded-lg p-3 bg-muted/30">
                <label className="text-xs text-muted-foreground block mb-2">Execute Task</label>
                <select
                  value={selectedPipeline}
                  onChange={(e) => setSelectedPipeline(e.target.value)}
                  className="h-8 w-full rounded-md border border-input bg-background px-2 text-xs mb-2"
                >
                  <option value="">
                    Use project default{projectDefaultPipeline ? ` (${pipelines.find(p => p.id === projectDefaultPipeline)?.name || projectDefaultPipeline})` : ''}
                  </option>
                  {pipelines.map((p: Pipeline) => (
                    <option key={p.id} value={p.id}>
                      {p.name || p.id}{p.id === projectDefaultPipeline ? ' ⭐' : ''}
                    </option>
                  ))}
                </select>
                <Button
                  size="sm"
                  onClick={handleExecute}
                  disabled={executing}
                  className="w-full gap-1.5"
                >
                  <Zap className="h-3.5 w-3.5" />
                  {executing ? 'Starting...' : 'Execute with Pipeline'}
                </Button>
              </div>
            )}

            {/* Active Run Link */}
            {detail?.run_id && detail.status === 'in_progress' && (
              <div className="border rounded-lg p-3 bg-blue-500/5 border-blue-500/20">
                <label className="text-xs text-muted-foreground block mb-1.5">Active Run</label>
                <Link
                  to="/runs/$runId"
                  params={{ runId: detail.run_id }}
                  className="flex items-center gap-2 text-sm text-primary hover:underline"
                >
                  <Play className="h-4 w-4" />
                  <span className="font-mono text-xs">{detail.run_id.substring(0, 12)}…</span>
                  <Badge variant="outline" className="text-[10px]">running</Badge>
                </Link>
              </div>
            )}

            {/* Dependencies - Blocked by */}
            <div>
              <div className="flex items-center justify-between mb-1.5">
                <label className="text-xs text-muted-foreground">Blocked by</label>
                <button
                  onClick={() => setShowAddDep(!showAddDep)}
                  className="text-xs text-primary hover:underline"
                >
                  {showAddDep ? 'Cancel' : '+ Add dependency'}
                </button>
              </div>
              
              {detail?.blocking_dependencies?.length > 0 && (
                <div className="space-y-1 mb-2">
                  {detail.blocking_dependencies.map((dep: TaskDetail['blocking_dependencies'][0]) => (
                    <div key={dep.id} className="flex items-center gap-2 text-sm group">
                      <Lock className="h-3 w-3 text-muted-foreground shrink-0" />
                      <span className={`flex-1 ${dep.from_task_status === 'done' ? 'line-through text-muted-foreground' : ''}`}>
                        {dep.from_task_title}
                      </span>
                      <Badge variant="outline" className="text-[10px] shrink-0">{dep.from_task_status}</Badge>
                      <button
                        onClick={() => handleRemoveDep(dep.id)}
                        className="opacity-0 group-hover:opacity-100 text-destructive hover:text-destructive/80 transition-opacity"
                      >
                        <X className="h-3 w-3" />
                      </button>
                    </div>
                  ))}
                </div>
              )}
              
              {showAddDep && (
                <div className="border rounded-md p-2 space-y-2 bg-muted/30">
                  <input
                    type="text"
                    value={depSearch}
                    onChange={(e) => setDepSearch(e.target.value)}
                    placeholder="Search tasks..."
                    className="h-7 w-full rounded border border-input bg-background px-2 text-xs"
                    autoFocus
                  />
                  <div className="max-h-32 overflow-y-auto space-y-1">
                    {allTasks
                      .filter(t => {
                        const existingDepIds = (detail?.blocking_dependencies || []).map((d: TaskDetail['blocking_dependencies'][0]) => d.from_task_id);
                        return !existingDepIds.includes(t.id) && 
                          (depSearch === '' || t.title.toLowerCase().includes(depSearch.toLowerCase()));
                      })
                      .slice(0, 8)
                      .map((t: Task) => (
                        <button
                          key={t.id}
                          onClick={() => handleAddDep(t.id)}
                          disabled={addingDep}
                          className="w-full text-left px-2 py-1 text-xs rounded hover:bg-accent flex items-center gap-2"
                        >
                          <Badge variant="outline" className="text-[9px] px-1 py-0">{t.priority}</Badge>
                          <span className="truncate">{t.title}</span>
                          <Badge variant="outline" className="text-[9px] px-1 py-0 ml-auto shrink-0">{t.status}</Badge>
                        </button>
                      ))}
                    {allTasks.filter(t => depSearch === '' || t.title.toLowerCase().includes(depSearch.toLowerCase())).length === 0 && (
                      <p className="text-xs text-muted-foreground text-center py-2">No tasks found</p>
                    )}
                  </div>
                </div>
              )}
            </div>

            {/* Dependencies - Blocking */}
            {detail?.dependents?.length > 0 && (
              <div>
                <label className="text-xs text-muted-foreground block mb-1.5">Blocking</label>
                <div className="space-y-1">
                  {detail.dependents.map((dep: TaskDetail['dependents'][0]) => (
                    <div key={dep.id} className="flex items-center gap-2 text-sm group">
                      <ChevronRight className="h-3 w-3 text-muted-foreground shrink-0" />
                      <span className="flex-1">{dep.to_task_title}</span>
                      <Badge variant="outline" className="text-[10px] shrink-0">{dep.to_task_status}</Badge>
                      <button
                        onClick={() => handleRemoveDep(dep.id)}
                        className="opacity-0 group-hover:opacity-100 text-destructive hover:text-destructive/80 transition-opacity"
                      >
                        <X className="h-3 w-3" />
                      </button>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {/* Subtasks */}
            {detail.subtasks?.length > 0 && (
              <div>
                <label className="text-xs text-muted-foreground block mb-1.5">Subtasks</label>
                <div className="space-y-1">
                  {detail.subtasks.map((sub: TaskDetail['subtasks'][0]) => (
                    <div key={sub.id} className="flex items-center gap-2 text-sm">
                      <CheckCircle2 className={`h-3 w-3 ${sub.status === 'done' ? 'text-green-500' : 'text-muted-foreground'}`} />
                      <span className={sub.status === 'done' ? 'line-through text-muted-foreground' : ''}>
                        {sub.title}
                      </span>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {/* Run History */}
            {detail.run_history?.length > 0 && (
              <div>
                <label className="text-xs text-muted-foreground block mb-1.5">Run History</label>
                <div className="space-y-1">
                  {detail.run_history.map((run: TaskDetail['run_history'][0]) => (
                    <Link
                      key={run.run_id}
                      to="/runs/$runId"
                      params={{ runId: run.run_id }}
                      className="flex items-center gap-2 text-sm hover:text-primary transition-colors"
                    >
                      <Play className="h-3 w-3" />
                      <span className="font-mono text-xs">{run.run_id.substring(0, 8)}</span>
                      <Badge variant="outline" className="text-[10px]">{run.status}</Badge>
                      {run.started_at && (
                        <span className="text-xs text-muted-foreground">
                          {new Date(run.started_at).toLocaleDateString()}
                        </span>
                      )}
                    </Link>
                  ))}
                </div>
              </div>
            )}
          </>
        ) : (
          <p className="text-destructive">Failed to load task details</p>
        )}
      </div>

      {/* Confirm Dialog */}
      {confirmAction && (
        <ConfirmDialog
          open={!!confirmAction}
          onOpenChange={(open) => !open && setConfirmAction(null)}
          title={confirmAction.title}
          description={confirmAction.desc}
          confirmLabel={confirmAction.title}
          variant="destructive"
          onConfirm={() => {
            confirmAction.action();
            setConfirmAction(null);
          }}
        />
      )}
    </div>
  );
}
