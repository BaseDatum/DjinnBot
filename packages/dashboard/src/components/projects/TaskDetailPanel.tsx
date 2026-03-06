import { useState, useEffect } from 'react';
import { Link } from '@tanstack/react-router';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  X,
  Lock,
  ChevronRight,
  ChevronDown,
  Play,
  CheckCircle2,
  Zap,
  Key,
} from 'lucide-react';
import {
  fetchTask,
  fetchProject,
  updateTask,
  deleteTask,
  addDependency,
  removeDependency,
  executeTask,
  executeTaskWithAgent,
  fetchPipelines,
  moveTask,
  fetchAgents,
} from '@/lib/api';
import type { AgentListItem } from '@/lib/api';
import { ProviderModelSelector } from '@/components/ui/ProviderModelSelector';
import { PRIORITY_COLORS } from './constants';
import type { Task, TaskDetail, Pipeline, Column, StatusSemantics } from './types';
import { ConfirmDialog } from '@/components/ConfirmDialog';
import { useAuth } from '@/hooks/useAuth';
import { API_BASE } from '@/lib/api';
import { authFetch } from '@/lib/auth';

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
  const [keyUserOverride, setKeyUserOverride] = useState<string>('');
  const [modelOverride, setModelOverride] = useState<string>('');
  const [userOptions, setUserOptions] = useState<Array<{ value: string; label: string }>>([]);
  const [projectColumns, setProjectColumns] = useState<Column[]>([]);
  const [movingToColumn, setMovingToColumn] = useState(false);
  const [statusSemantics, setStatusSemantics] = useState<StatusSemantics | null>(null);
  const [pipelineExecCollapsed, setPipelineExecCollapsed] = useState(true);
  const [agentExecCollapsed, setAgentExecCollapsed] = useState(true);
  const [agents, setAgents] = useState<AgentListItem[]>([]);
  const [selectedAgent, setSelectedAgent] = useState<string>('');
  const [agentModelOverride, setAgentModelOverride] = useState<string>('');
  const [executingAgent, setExecutingAgent] = useState(false);
  const { user } = useAuth();

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
      setProjectColumns(p.columns || []);
      setStatusSemantics(p.status_semantics || null);
    }).catch(() => {});
  }, [projectId]);

  // Load agents for agent executor
  useEffect(() => {
    fetchAgents().then(setAgents).catch(() => {});
  }, []);

  // Load user options for key user selector
  useEffect(() => {
    if (!user) return;
    const options: Array<{ value: string; label: string }> = [
      { value: '', label: 'Project default' },
      { value: user.id, label: `Use my keys (${user.displayName || user.email || 'me'})` },
    ];
    if (user.isAdmin) {
      authFetch(`${API_BASE}/admin/users`).then(r => r.json()).then((users: any[]) => {
        const extra = users
          .filter(u => u.id !== user.id)
          .map(u => ({ value: u.id, label: u.displayName || u.email }));
        setUserOptions([...options, ...extra]);
      }).catch(() => setUserOptions(options));
    } else {
      setUserOptions(options);
    }
  }, [user]);

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
      const execData: Record<string, string> = {};
      if (selectedPipeline) execData.pipelineId = selectedPipeline;
      if (modelOverride) execData.modelOverride = modelOverride;
      if (keyUserOverride) execData.keyUserId = keyUserOverride;
      await executeTask(projectId, task.id, Object.keys(execData).length > 0 ? execData : undefined);
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

  const handleAgentExecute = async () => {
    if (!selectedAgent) return;
    setExecutingAgent(true);
    try {
      await executeTaskWithAgent(projectId, task.id, {
        agentId: selectedAgent,
        modelOverride: agentModelOverride || undefined,
      });
      onUpdated();
      // Refresh detail to get the new run_id
      const updated = await fetchTask(projectId, task.id);
      setDetail(updated);
    } catch (err: unknown) {
      alert((err instanceof Error ? err.message : String(err)) || 'Failed to execute task with agent');
    } finally {
      setExecutingAgent(false);
    }
  };

  const handleMoveToColumn = async (columnId: string) => {
    const currentColumnId = detail?.column_id ?? task.column_id;
    if (!columnId || columnId === currentColumnId) return;
    setMovingToColumn(true);
    try {
      await moveTask(projectId, task.id, columnId);
      onUpdated();
      const updated = await fetchTask(projectId, task.id);
      setDetail(updated);
    } catch (err) {
      console.error('Failed to move task:', err);
    } finally {
      setMovingToColumn(false);
    }
  };

  const priorityClass = PRIORITY_COLORS[detail?.priority ?? task.priority] || PRIORITY_COLORS.P2;

  return (
    <div className="fixed inset-y-0 right-0 z-50 w-full sm:w-[480px] bg-card border-l shadow-xl flex flex-col">
      {/* Header */}
      <div className="flex items-center justify-between px-4 py-3 border-b shrink-0">
        <div className="flex items-center gap-2">
          <Badge variant="outline" className={`${priorityClass}`}>{detail?.priority ?? task.priority}</Badge>
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
                {projectColumns.length > 0 ? (
                  <select
                    value={detail?.column_id ?? task.column_id}
                    onChange={(e) => handleMoveToColumn(e.target.value)}
                    disabled={movingToColumn}
                    className="h-7 rounded-md border border-input bg-background px-2 text-xs"
                  >
                    {projectColumns
                      .sort((a, b) => a.position - b.position)
                      .map((col) => {
                        const currentColId = detail?.column_id ?? task.column_id;
                        return (
                          <option key={col.id} value={col.id}>
                            {col.name}{col.id === currentColId ? ' (current)' : ''}
                          </option>
                        );
                      })}
                  </select>
                ) : (
                  <Badge variant="outline">{detail.status}</Badge>
                )}
              </div>
              <div>
                <label className="text-xs text-muted-foreground block mb-1">Priority</label>
                <select
                  value={detail.priority}
                  onChange={async (e) => {
                    const newPriority = e.target.value;
                    try {
                      await updateTask(projectId, task.id, { priority: newPriority });
                      onUpdated();
                      const updated = await fetchTask(projectId, task.id);
                      setDetail(updated);
                    } catch (err) {
                      console.error('Failed to update priority:', err);
                    }
                  }}
                  className="h-7 rounded-md border border-input bg-background px-2 text-xs"
                >
                  {['P0', 'P1', 'P2', 'P3'].map((p) => (
                    <option key={p} value={p}>{p}</option>
                  ))}
                </select>
              </div>
              <div>
                <label className="text-xs text-muted-foreground block mb-1">Agent</label>
                <span>{detail.assigned_agent || '—'}</span>
              </div>
              <div>
                <label className="text-xs text-muted-foreground block mb-1">Estimate</label>
                <input
                  type="number"
                  min="0"
                  step="0.5"
                  value={detail.estimated_hours ?? ''}
                  onChange={async (e) => {
                    const val = e.target.value;
                    const hours = val === '' ? null : parseFloat(val);
                    try {
                      await updateTask(projectId, task.id, { estimatedHours: hours });
                      onUpdated();
                      const updated = await fetchTask(projectId, task.id);
                      setDetail(updated);
                    } catch (err) {
                      console.error('Failed to update estimate:', err);
                    }
                  }}
                  placeholder="hours"
                  className="h-7 w-full rounded-md border border-input bg-background px-2 text-xs"
                />
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

            {/* Execute sections */}
            {detail && (() => {
              // Compute executable statuses from project semantics
              const executableStatuses = new Set<string>();
              if (statusSemantics) {
                for (const s of statusSemantics.claimable || []) executableStatuses.add(s);
                for (const s of statusSemantics.initial || []) executableStatuses.add(s);
              }
              // Fallback for projects without semantics
              if (executableStatuses.size === 0) {
                for (const s of ['ready', 'backlog', 'planning']) executableStatuses.add(s);
              }
              if (!executableStatuses.has(detail.status)) return null;

              return (
                <div className="space-y-2">
                  {/* Agent Execute Task */}
                  <div className="border rounded-lg bg-muted/30">
                    <button
                      type="button"
                      className="flex items-center justify-between w-full p-3 text-left"
                      onClick={() => setAgentExecCollapsed(!agentExecCollapsed)}
                    >
                      <label className="text-xs text-muted-foreground cursor-pointer flex items-center gap-1.5">
                        <Play className="h-3 w-3" />
                        Execute Task
                      </label>
                      {agentExecCollapsed ? (
                        <ChevronRight className="h-3.5 w-3.5 text-muted-foreground" />
                      ) : (
                        <ChevronDown className="h-3.5 w-3.5 text-muted-foreground" />
                      )}
                    </button>
                    {!agentExecCollapsed && (
                      <div className="px-3 pb-3 space-y-2">
                        <p className="text-[10px] text-muted-foreground">
                          Spawns a standalone agent session to work on this task. Includes memory injection and task branch isolation.
                        </p>
                        <div>
                          <label className="text-[10px] text-muted-foreground block mb-0.5">Agent</label>
                          <select
                            value={selectedAgent}
                            onChange={(e) => setSelectedAgent(e.target.value)}
                            className="h-8 w-full rounded-md border border-input bg-background px-2 text-xs"
                          >
                            <option value="">Select an agent...</option>
                            {agents.map((a) => (
                              <option key={a.id} value={a.id}>
                                {a.emoji ? `${a.emoji} ` : ''}{a.name || a.id}
                              </option>
                            ))}
                          </select>
                        </div>
                        <div>
                          <label className="text-[10px] text-muted-foreground block mb-0.5">Model</label>
                          <ProviderModelSelector
                            value={agentModelOverride}
                            onChange={setAgentModelOverride}
                            placeholder="Use agent default"
                            className="h-8 w-full text-xs"
                          />
                        </div>
                        <Button
                          size="sm"
                          onClick={handleAgentExecute}
                          disabled={executingAgent || !selectedAgent}
                          className="w-full gap-1.5"
                        >
                          <Play className="h-3.5 w-3.5" />
                          {executingAgent ? 'Starting session...' : 'Execute with Agent'}
                        </Button>
                      </div>
                    )}
                  </div>

                  {/* Pipeline Execute Task */}
                  <div className="border rounded-lg bg-muted/30">
                    <button
                      type="button"
                      className="flex items-center justify-between w-full p-3 text-left"
                      onClick={() => setPipelineExecCollapsed(!pipelineExecCollapsed)}
                    >
                      <label className="text-xs text-muted-foreground cursor-pointer flex items-center gap-1.5">
                        <Zap className="h-3 w-3" />
                        Pipeline Execute Task
                      </label>
                      {pipelineExecCollapsed ? (
                        <ChevronRight className="h-3.5 w-3.5 text-muted-foreground" />
                      ) : (
                        <ChevronDown className="h-3.5 w-3.5 text-muted-foreground" />
                      )}
                    </button>
                    {!pipelineExecCollapsed && (
                      <div className="px-3 pb-3 space-y-2">
                        <div>
                          <label className="text-[10px] text-muted-foreground block mb-0.5">Pipeline</label>
                          <select
                            value={selectedPipeline}
                            onChange={(e) => setSelectedPipeline(e.target.value)}
                            className="h-8 w-full rounded-md border border-input bg-background px-2 text-xs"
                          >
                            <option value="">
                              Use project default{projectDefaultPipeline ? ` (${pipelines.find(p => p.id === projectDefaultPipeline)?.name || projectDefaultPipeline})` : ''}
                            </option>
                            {pipelines.map((p: Pipeline) => (
                              <option key={p.id} value={p.id}>
                                {p.name || p.id}{p.id === projectDefaultPipeline ? ' *' : ''}
                              </option>
                            ))}
                          </select>
                        </div>
                        <div>
                          <label className="text-[10px] text-muted-foreground flex items-center gap-1 mb-0.5">
                            <Key className="h-2.5 w-2.5" />
                            API Keys
                          </label>
                          <select
                            value={keyUserOverride}
                            onChange={(e) => setKeyUserOverride(e.target.value)}
                            className="h-8 w-full rounded-md border border-input bg-background px-2 text-xs"
                          >
                            {userOptions.map(opt => (
                              <option key={opt.value} value={opt.value}>{opt.label}</option>
                            ))}
                          </select>
                        </div>
                        <div>
                          <label className="text-[10px] text-muted-foreground block mb-0.5">Model Override</label>
                          <ProviderModelSelector
                            value={modelOverride}
                            onChange={setModelOverride}
                            placeholder="Use pipeline default"
                            className="h-8 w-full text-xs"
                          />
                        </div>
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
                  </div>
                </div>
              );
            })()}

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
