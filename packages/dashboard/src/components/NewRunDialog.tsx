import { useState, useEffect } from 'react';
import { useNavigate } from '@tanstack/react-router';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Label } from '@/components/ui/label';
import {
  Play,
  Network,
  Loader2,
  ChevronDown,
  ChevronRight,
  Check,
  AlertCircle,
} from 'lucide-react';
import {
  fetchPipelines,
  fetchProjects,
  fetchProjectTasks,
  fetchAgents,
  startRun,
  startSwarm,
  type AgentListItem,
  type StartSwarmRequest,
} from '@/lib/api';

type RunType = 'pipeline' | 'swarm';

interface PipelineItem {
  id: string;
  name: string;
  description?: string;
  steps?: any[];
  agents?: any[];
}

interface ProjectItem {
  id: string;
  name: string;
  status: string;
}

interface TaskItem {
  id: string;
  title: string;
  status: string;
  priority: string;
  description?: string;
  assignedAgent?: string;
}

interface NewRunDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Pre-select the swarm tab */
  defaultType?: RunType;
}

export function NewRunDialog({ open, onOpenChange, defaultType }: NewRunDialogProps) {
  const navigate = useNavigate();
  const [runType, setRunType] = useState<RunType>(defaultType || 'pipeline');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Pipeline form state
  const [pipelines, setPipelines] = useState<PipelineItem[]>([]);
  const [selectedPipeline, setSelectedPipeline] = useState('');
  const [taskDescription, setTaskDescription] = useState('');
  const [context, setContext] = useState('');
  const [showAdvanced, setShowAdvanced] = useState(false);

  // Shared state
  const [projects, setProjects] = useState<ProjectItem[]>([]);
  const [selectedProject, setSelectedProject] = useState('');

  // Swarm form state
  const [agents, setAgents] = useState<AgentListItem[]>([]);
  const [selectedAgent, setSelectedAgent] = useState('');
  const [projectTasks, setProjectTasks] = useState<TaskItem[]>([]);
  const [selectedTaskIds, setSelectedTaskIds] = useState<Set<string>>(new Set());
  const [maxConcurrent, setMaxConcurrent] = useState(3);
  const [loadingTasks, setLoadingTasks] = useState(false);
  const [taskFilter, setTaskFilter] = useState('');

  // Load data when dialog opens
  useEffect(() => {
    if (!open) return;
    setError(null);

    // Load pipelines and projects in parallel
    fetchPipelines()
      .then((data) => {
        const pls = Array.isArray(data) ? data : data.pipelines || [];
        setPipelines(pls);
        if (pls.length > 0 && !selectedPipeline) {
          setSelectedPipeline(pls[0].id);
        }
      })
      .catch(() => {});

    fetchProjects()
      .then((data) => {
        const pjs = Array.isArray(data) ? data : data.projects || [];
        setProjects(pjs.filter((p: ProjectItem) => p.status !== 'archived'));
      })
      .catch(() => {});

    fetchAgents()
      .then((data) => {
        setAgents(data);
        if (data.length > 0 && !selectedAgent) {
          setSelectedAgent(data[0].id);
        }
      })
      .catch(() => {});
  }, [open]);

  // Reset default type when prop changes
  useEffect(() => {
    if (defaultType) setRunType(defaultType);
  }, [defaultType]);

  // Load project tasks when project selected (for swarm mode)
  useEffect(() => {
    if (!selectedProject || runType !== 'swarm') {
      setProjectTasks([]);
      setSelectedTaskIds(new Set());
      return;
    }
    setLoadingTasks(true);
    fetchProjectTasks(selectedProject)
      .then((data) => {
        const tasks = Array.isArray(data) ? data : data.tasks || [];
        setProjectTasks(tasks);
      })
      .catch(() => setProjectTasks([]))
      .finally(() => setLoadingTasks(false));
  }, [selectedProject, runType]);

  const handleSubmitPipeline = async () => {
    if (!selectedPipeline || !taskDescription.trim()) return;

    setSubmitting(true);
    setError(null);
    try {
      const newRun = await startRun(
        selectedPipeline,
        taskDescription.trim(),
        context.trim() || undefined,
        selectedProject || undefined,
      );
      onOpenChange(false);
      resetForm();
      navigate({ to: '/runs/$runId', params: { runId: newRun.id } });
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to start run');
    } finally {
      setSubmitting(false);
    }
  };

  const handleSubmitSwarm = async () => {
    if (!selectedProject || !selectedAgent || selectedTaskIds.size === 0) return;

    setSubmitting(true);
    setError(null);
    try {
      const selectedTasks = projectTasks.filter((t) => selectedTaskIds.has(t.id));

      const swarmReq: StartSwarmRequest = {
        agent_id: selectedAgent,
        tasks: selectedTasks.map((t) => ({
          key: t.id,
          title: t.title,
          project_id: selectedProject,
          task_id: t.id,
          execution_prompt: t.description || t.title,
          dependencies: [],
        })),
        max_concurrent: maxConcurrent,
      };

      const result = await startSwarm(swarmReq);
      onOpenChange(false);
      resetForm();
      // Navigate using window.location because the swarm route is not in the
      // generated route tree (TanStack Router doesn't know about it yet).
      window.location.href = `/runs/swarm/${result.swarm_id}`;
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to start swarm');
    } finally {
      setSubmitting(false);
    }
  };

  const resetForm = () => {
    setTaskDescription('');
    setContext('');
    setSelectedProject('');
    setSelectedTaskIds(new Set());
    setError(null);
    setShowAdvanced(false);
    setTaskFilter('');
  };

  const toggleTaskSelection = (taskId: string) => {
    setSelectedTaskIds((prev) => {
      const next = new Set(prev);
      if (next.has(taskId)) {
        next.delete(taskId);
      } else {
        next.add(taskId);
      }
      return next;
    });
  };

  const selectAllFilteredTasks = () => {
    const filtered = getFilteredTasks();
    setSelectedTaskIds((prev) => {
      const next = new Set(prev);
      const allSelected = filtered.every((t) => next.has(t.id));
      if (allSelected) {
        filtered.forEach((t) => next.delete(t.id));
      } else {
        filtered.forEach((t) => next.add(t.id));
      }
      return next;
    });
  };

  const getFilteredTasks = () => {
    if (!taskFilter.trim()) return projectTasks;
    const q = taskFilter.toLowerCase();
    return projectTasks.filter(
      (t) =>
        t.title.toLowerCase().includes(q) ||
        t.status.toLowerCase().includes(q) ||
        t.priority.toLowerCase().includes(q),
    );
  };

  const selectedPipelineData = pipelines.find((p) => p.id === selectedPipeline);
  const filteredTasks = getFilteredTasks();

  const canSubmitPipeline = !!selectedPipeline && !!taskDescription.trim();
  const canSubmitSwarm = !!selectedProject && !!selectedAgent && selectedTaskIds.size > 0;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl max-h-[85vh] flex flex-col">
        <DialogHeader>
          <DialogTitle>New Run</DialogTitle>
          <DialogDescription>
            Start a pipeline run or a parallel swarm execution.
          </DialogDescription>
        </DialogHeader>

        {/* Type toggle */}
        <div className="flex gap-2 p-1 bg-muted rounded-lg">
          <button
            className={`flex-1 flex items-center justify-center gap-2 px-3 py-2 rounded-md text-sm font-medium transition-colors ${
              runType === 'pipeline'
                ? 'bg-background text-foreground shadow-sm'
                : 'text-muted-foreground hover:text-foreground'
            }`}
            onClick={() => setRunType('pipeline')}
          >
            <Play className="h-4 w-4" />
            Pipeline Run
          </button>
          <button
            className={`flex-1 flex items-center justify-center gap-2 px-3 py-2 rounded-md text-sm font-medium transition-colors ${
              runType === 'swarm'
                ? 'bg-background text-foreground shadow-sm'
                : 'text-muted-foreground hover:text-foreground'
            }`}
            onClick={() => setRunType('swarm')}
          >
            <Network className="h-4 w-4" />
            Swarm
          </button>
        </div>

        {/* Form content */}
        <div className="flex-1 overflow-y-auto space-y-4 py-2">
          {runType === 'pipeline' ? (
            /* ── Pipeline Run Form ──────────────────────────────────── */
            <>
              {/* Pipeline selector */}
              <div className="space-y-2">
                <Label htmlFor="pipeline-select">Pipeline</Label>
                <select
                  id="pipeline-select"
                  value={selectedPipeline}
                  onChange={(e) => setSelectedPipeline(e.target.value)}
                  className="w-full h-10 rounded-md border border-input bg-background px-3 text-sm ring-offset-background focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                >
                  {pipelines.length === 0 && (
                    <option value="">No pipelines available</option>
                  )}
                  {pipelines.map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.name || p.id}
                    </option>
                  ))}
                </select>
                {selectedPipelineData?.description && (
                  <p className="text-xs text-muted-foreground">
                    {selectedPipelineData.description}
                  </p>
                )}
                {selectedPipelineData && (
                  <div className="flex gap-2 flex-wrap">
                    {selectedPipelineData.steps && (
                      <Badge variant="outline" className="text-xs">
                        {selectedPipelineData.steps.length} step
                        {selectedPipelineData.steps.length !== 1 ? 's' : ''}
                      </Badge>
                    )}
                    {selectedPipelineData.agents && (
                      <Badge variant="outline" className="text-xs">
                        {selectedPipelineData.agents.length} agent
                        {selectedPipelineData.agents.length !== 1 ? 's' : ''}
                      </Badge>
                    )}
                  </div>
                )}
              </div>

              {/* Task description */}
              <div className="space-y-2">
                <Label htmlFor="task-desc">Task Description</Label>
                <textarea
                  id="task-desc"
                  value={taskDescription}
                  onChange={(e) => setTaskDescription(e.target.value)}
                  placeholder="Describe the task for the pipeline to execute..."
                  className="w-full min-h-[100px] rounded-md border border-input bg-background px-3 py-2 text-sm ring-offset-background placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring resize-y"
                />
              </div>

              {/* Advanced options toggle */}
              <button
                onClick={() => setShowAdvanced(!showAdvanced)}
                className="flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground transition-colors"
              >
                {showAdvanced ? (
                  <ChevronDown className="h-3 w-3" />
                ) : (
                  <ChevronRight className="h-3 w-3" />
                )}
                Advanced Options
              </button>

              {showAdvanced && (
                <div className="space-y-4 pl-2 border-l-2 border-muted">
                  {/* Context */}
                  <div className="space-y-2">
                    <Label htmlFor="context">Additional Context</Label>
                    <textarea
                      id="context"
                      value={context}
                      onChange={(e) => setContext(e.target.value)}
                      placeholder="Optional context or constraints for the agent..."
                      className="w-full min-h-[60px] rounded-md border border-input bg-background px-3 py-2 text-sm ring-offset-background placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring resize-y"
                    />
                  </div>

                  {/* Project selector */}
                  <div className="space-y-2">
                    <Label htmlFor="project-select">
                      Project{' '}
                      <span className="text-muted-foreground font-normal">(optional)</span>
                    </Label>
                    <select
                      id="project-select"
                      value={selectedProject}
                      onChange={(e) => setSelectedProject(e.target.value)}
                      className="w-full h-10 rounded-md border border-input bg-background px-3 text-sm ring-offset-background focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                    >
                      <option value="">None (standalone run)</option>
                      {projects.map((p) => (
                        <option key={p.id} value={p.id}>
                          {p.name}
                        </option>
                      ))}
                    </select>
                    <p className="text-xs text-muted-foreground">
                      Linking to a project enables worktree support and git branching.
                    </p>
                  </div>
                </div>
              )}
            </>
          ) : (
            /* ── Swarm Form ─────────────────────────────────────────── */
            <>
              {/* Project selector (required for swarm) */}
              <div className="space-y-2">
                <Label htmlFor="swarm-project">Project</Label>
                <select
                  id="swarm-project"
                  value={selectedProject}
                  onChange={(e) => setSelectedProject(e.target.value)}
                  className="w-full h-10 rounded-md border border-input bg-background px-3 text-sm ring-offset-background focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                >
                  <option value="">Select a project...</option>
                  {projects.map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.name}
                    </option>
                  ))}
                </select>
              </div>

              {/* Agent selector */}
              <div className="space-y-2">
                <Label htmlFor="swarm-agent">Agent</Label>
                <select
                  id="swarm-agent"
                  value={selectedAgent}
                  onChange={(e) => setSelectedAgent(e.target.value)}
                  className="w-full h-10 rounded-md border border-input bg-background px-3 text-sm ring-offset-background focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                >
                  {agents.map((a) => (
                    <option key={a.id} value={a.id}>
                      {a.emoji ? `${a.emoji} ` : ''}
                      {a.name || a.id}
                      {a.role ? ` — ${a.role}` : ''}
                    </option>
                  ))}
                </select>
                <p className="text-xs text-muted-foreground">
                  All swarm executors will run under this agent identity.
                </p>
              </div>

              {/* Max concurrent */}
              <div className="space-y-2">
                <Label htmlFor="max-concurrent">
                  Max Concurrent{' '}
                  <span className="text-muted-foreground font-normal">({maxConcurrent})</span>
                </Label>
                <input
                  id="max-concurrent"
                  type="range"
                  min={1}
                  max={8}
                  value={maxConcurrent}
                  onChange={(e) => setMaxConcurrent(Number(e.target.value))}
                  className="w-full accent-primary"
                />
                <div className="flex justify-between text-xs text-muted-foreground">
                  <span>1</span>
                  <span>8</span>
                </div>
              </div>

              {/* Task selector */}
              <div className="space-y-2">
                <div className="flex items-center justify-between">
                  <Label>
                    Tasks{' '}
                    {selectedTaskIds.size > 0 && (
                      <Badge variant="secondary" className="ml-1 text-xs">
                        {selectedTaskIds.size} selected
                      </Badge>
                    )}
                  </Label>
                  {filteredTasks.length > 0 && (
                    <button
                      onClick={selectAllFilteredTasks}
                      className="text-xs text-muted-foreground hover:text-foreground transition-colors"
                    >
                      {filteredTasks.every((t) => selectedTaskIds.has(t.id))
                        ? 'Deselect all'
                        : 'Select all'}
                    </button>
                  )}
                </div>

                {!selectedProject ? (
                  <p className="text-sm text-muted-foreground py-4 text-center">
                    Select a project to see its tasks.
                  </p>
                ) : loadingTasks ? (
                  <div className="flex items-center justify-center py-4">
                    <Loader2 className="h-4 w-4 animate-spin mr-2" />
                    <span className="text-sm text-muted-foreground">Loading tasks...</span>
                  </div>
                ) : projectTasks.length === 0 ? (
                  <p className="text-sm text-muted-foreground py-4 text-center">
                    No tasks found in this project.
                  </p>
                ) : (
                  <>
                    {/* Task filter */}
                    <input
                      type="text"
                      placeholder="Filter tasks..."
                      value={taskFilter}
                      onChange={(e) => setTaskFilter(e.target.value)}
                      className="w-full h-8 rounded-md border border-input bg-background px-3 text-sm ring-offset-background placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                    />

                    {/* Task list */}
                    <div className="max-h-[200px] overflow-y-auto rounded-md border divide-y">
                      {filteredTasks.map((task) => {
                        const isSelected = selectedTaskIds.has(task.id);
                        return (
                          <button
                            key={task.id}
                            onClick={() => toggleTaskSelection(task.id)}
                            className={`w-full text-left px-3 py-2 text-sm flex items-center gap-3 transition-colors ${
                              isSelected ? 'bg-primary/5' : 'hover:bg-muted/50'
                            }`}
                          >
                            <div
                              className={`flex-shrink-0 h-4 w-4 rounded border flex items-center justify-center transition-colors ${
                                isSelected
                                  ? 'bg-primary border-primary text-primary-foreground'
                                  : 'border-input'
                              }`}
                            >
                              {isSelected && <Check className="h-3 w-3" />}
                            </div>
                            <div className="flex-1 min-w-0">
                              <p className="truncate font-medium">{task.title}</p>
                              <div className="flex items-center gap-2 mt-0.5">
                                <Badge
                                  variant="outline"
                                  className="text-[10px] px-1 py-0"
                                >
                                  {task.status}
                                </Badge>
                                <Badge
                                  variant="outline"
                                  className="text-[10px] px-1 py-0"
                                >
                                  {task.priority}
                                </Badge>
                              </div>
                            </div>
                          </button>
                        );
                      })}
                    </div>
                  </>
                )}
              </div>
            </>
          )}

          {/* Error display */}
          {error && (
            <div className="flex items-start gap-2 p-3 rounded-md bg-destructive/10 text-destructive text-sm">
              <AlertCircle className="h-4 w-4 mt-0.5 flex-shrink-0" />
              <p>{error}</p>
            </div>
          )}
        </div>

        {/* Footer */}
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={submitting}>
            Cancel
          </Button>
          {runType === 'pipeline' ? (
            <Button onClick={handleSubmitPipeline} disabled={!canSubmitPipeline || submitting}>
              {submitting ? (
                <>
                  <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                  Starting...
                </>
              ) : (
                <>
                  <Play className="mr-2 h-4 w-4" />
                  Start Pipeline Run
                </>
              )}
            </Button>
          ) : (
            <Button onClick={handleSubmitSwarm} disabled={!canSubmitSwarm || submitting}>
              {submitting ? (
                <>
                  <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                  Dispatching...
                </>
              ) : (
                <>
                  <Network className="mr-2 h-4 w-4" />
                  Start Swarm ({selectedTaskIds.size} task
                  {selectedTaskIds.size !== 1 ? 's' : ''})
                </>
              )}
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
