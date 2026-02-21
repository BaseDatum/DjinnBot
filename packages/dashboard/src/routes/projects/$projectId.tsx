import { createFileRoute, Link, useNavigate } from '@tanstack/react-router';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  ArrowLeft,
  Trash2,
  Github,
} from 'lucide-react';
import { Skeleton } from '@/components/ui/skeleton';
import { useState, useEffect, useCallback, useRef } from 'react';
import { useSSE } from '@/hooks/useSSE';
import {
  fetchProject,
  fetchPipelines,
  planProject,
  deleteProject,
  fetchProjectAgents,
  fetchAgents,
} from '@/lib/api';
import { ProjectBoardView } from '@/components/projects/ProjectBoardView';
import { TaskDetailPanel } from '@/components/projects/TaskDetailPanel';
import { PlanDialog } from '@/components/projects/PlanDialog';
import { TeamPanel } from '@/components/projects/TeamPanel';
import { RepositorySettings } from '@/components/projects/RepositorySettings';
import { SlackSettings } from '@/components/projects/SlackSettings';
import { ProjectActivityFeed, type ActivityEntry } from '@/components/projects/ProjectActivityFeed';
import { DependencyGraph } from '@/components/DependencyGraph';
import { GanttChart } from '@/components/GanttChart';
import { ConfirmDialog } from '@/components/ConfirmDialog';
import type {
  Task,
  Project,
  SSEEvent,
  Pipeline,
  GraphData,
  TimelineData,
} from '@/components/projects/types';
import {
  fetchDependencyGraph,
  fetchTimeline,
  API_BASE,
} from '@/lib/api';

type ViewType = 'board' | 'graph' | 'timeline' | 'team' | 'settings';

const VALID_VIEWS: ViewType[] = ['board', 'graph', 'timeline', 'team', 'settings'];

export const Route = createFileRoute('/projects/$projectId')({
  validateSearch: (search: Record<string, unknown>) => ({
    view: VALID_VIEWS.includes(search.view as ViewType) ? (search.view as ViewType) : 'board',
    plan: search.plan === '1' ? '1' : undefined,
  }),
  component: ProjectBoardPage,
});

function ProjectBoardPage() {
  const { projectId } = Route.useParams() as { projectId: string };
  const { view, plan } = Route.useSearch();
  const navigate = useNavigate();

  // Open plan dialog when ?plan=1 is in the URL
  useEffect(() => {
    if (plan === '1') {
      setShowPlanDialog(true);
      // Clear the param so re-opening works cleanly
      navigate({ to: '.', search: (prev) => ({ ...prev, plan: undefined }), replace: true });
    }
  }, [plan]);

  const [project, setProject] = useState<Project | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [selectedTask, setSelectedTask] = useState<Task | null>(null);
  const [pipelines, setPipelines] = useState<Pipeline[]>([]);
  const [showPlanDialog, setShowPlanDialog] = useState(false);
  const [planning, setPlanning] = useState(false);
  const [planRunId, setPlanRunId] = useState<string | null>(null);
  const [confirmAction, setConfirmAction] = useState<{
    title: string; desc: string; action: () => void
  } | null>(null);

  // Activity feed — accumulate rich SSE events instead of just refreshing
  // Persist a per-project "cleared at" cutoff so clearing survives page refreshes.
  const clearedAtKey = `activity_cleared_at_${projectId}`;
  const [clearedAt, setClearedAt] = useState<number>(() => {
    const stored = localStorage.getItem(clearedAtKey);
    return stored ? parseInt(stored, 10) : 0;
  });
  const clearedAtRef = useRef(clearedAt);
  useEffect(() => { clearedAtRef.current = clearedAt; }, [clearedAt]);
  const [activityEntries, setActivityEntries] = useState<ActivityEntry[]>([]);
  const activityIdRef = useRef(0);

  // Graph / Timeline (lazy loaded)
  const [graphData, setGraphData] = useState<GraphData | null>(null);
  const [graphLoading, setGraphLoading] = useState(false);
  const [timelineData, setTimelineData] = useState<TimelineData | null>(null);
  const [timelineLoading, setTimelineLoading] = useState(false);

  // Agent data for column roster headers
  const [projectAgents, setProjectAgents] = useState<Array<{
    agent_id: string; role: string; name?: string; emoji?: string | null;
  }>>([]);

  const refreshTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const loadProject = useCallback(async () => {
    try {
      setError(null);
      const data = await fetchProject(projectId);
      setProject(data);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load project');
    } finally {
      setLoading(false);
    }
  }, [projectId]);

  const debouncedRefresh = useCallback(() => {
    if (refreshTimeoutRef.current) clearTimeout(refreshTimeoutRef.current);
    refreshTimeoutRef.current = setTimeout(() => {
      loadProject();
      refreshTimeoutRef.current = null;
    }, 300);
  }, [loadProject]);

  useEffect(() => {
    loadProject();
    fetchPipelines()
      .then((d) => setPipelines(Array.isArray(d) ? d : d.pipelines || []))
      .catch(() => {});
  }, [loadProject]);

  // Load team agents for column roster
  useEffect(() => {
    Promise.all([fetchProjectAgents(projectId), fetchAgents()])
      .then(([pas, allAgents]) => {
        const agentMap = new Map(allAgents.map((a) => [a.id, a]));
        setProjectAgents(
          pas.map((pa) => {
            const a = agentMap.get(pa.agent_id);
            return { agent_id: pa.agent_id, role: pa.role, name: a?.name, emoji: a?.emoji };
          }),
        );
      })
      .catch(() => {});
  }, [projectId]);

  // Lazy-load graph / timeline
  useEffect(() => {
    if (view === 'graph' && !graphData) {
      setGraphLoading(true);
      fetchDependencyGraph(projectId)
        .then(setGraphData)
        .catch(console.error)
        .finally(() => setGraphLoading(false));
    }
    if (view === 'timeline' && !timelineData) {
      setTimelineLoading(true);
      fetchTimeline(projectId)
        .then(setTimelineData)
        .catch(console.error)
        .finally(() => setTimelineLoading(false));
    }
  }, [view, graphData, timelineData, projectId]);

  const addActivity = useCallback((event: SSEEvent) => {
    const TRACKED = new Set([
      'TASK_CLAIMED', 'TASK_STATUS_CHANGED', 'TASK_UNBLOCKED', 'TASK_BLOCKED',
      'RUN_STARTED', 'RUN_COMPLETED', 'RUN_FAILED',
    ]);
    if (!TRACKED.has(event.type)) return;
    const now = Date.now();
    // Discard events that pre-date the last clear action
    if (now <= clearedAtRef.current) return;
    const entry: ActivityEntry = {
      id: `${++activityIdRef.current}`,
      type: event.type,
      timestamp: now,
      agentId: event.agentId as string | undefined,
      agentEmoji: event.agentEmoji as string | undefined,
      taskTitle: event.taskTitle as string | undefined,
      taskId: event.taskId as string | undefined,
      fromStatus: event.fromStatus as string | undefined,
      toStatus: event.toStatus as string | undefined,
      note: event.note as string | undefined,
      runId: event.runId as string | undefined,
    };
    setActivityEntries((prev) => [...prev.slice(-99), entry]);
  }, []);

  // Real-time updates via SSE
  useSSE<SSEEvent>({
    url: `${API_BASE}/events/stream`,
    enabled: !!project,
    onMessage: (event) => {
      if (event.projectId === projectId) {
        debouncedRefresh();
        addActivity(event);
        if (event.type === 'PROJECT_PLANNING_COMPLETED') setPlanRunId(null);
      }
    },
  });

  const handlePlan = async (pipelineId: string, context: string) => {
    setPlanning(true);
    try {
      const result = await planProject(projectId, { pipelineId, context: context || undefined });
      setPlanRunId(result.run_id);
      setShowPlanDialog(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to start planning');
    } finally {
      setPlanning(false);
    }
  };

  const handleDeleteProject = () => {
    if (!project) return;
    setConfirmAction({
      title: 'Delete Project',
      desc: `Delete "${project.name}"? This cannot be undone.`,
      action: async () => {
        await deleteProject(projectId);
        navigate({ to: '/projects' });
      },
    });
  };

  const isAutonomous = projectAgents.length > 0;

  if (loading) {
    return (
      <div className="flex flex-col h-full overflow-hidden">
        {/* Header skeleton */}
        <div className="shrink-0 px-4 md:px-6 py-3 border-b bg-card">
          <Skeleton width={60} height={12} className="mb-2" />
          <div className="flex items-center justify-between gap-2">
            <div className="flex items-center gap-2">
              <Skeleton width={180} height={22} />
              <Skeleton width={50} height={20} />
            </div>
            <Skeleton width={32} height={32} />
          </div>
        </div>
        {/* View tabs skeleton */}
        <div className="shrink-0 px-4 md:px-6 py-2 border-b flex gap-2">
          {[...Array(5)].map((_, i) => <Skeleton key={i} width={70} height={28} />)}
        </div>
        {/* Board skeleton */}
        <div className="flex-1 p-4 md:px-6 flex gap-4 overflow-hidden">
          {[...Array(4)].map((_, col) => (
            <div key={col} className="flex flex-col gap-2 w-48 shrink-0">
              <Skeleton height={24} width="80%" />
              {[...Array(3)].map((_, row) => (
                <div key={row} className="rounded-lg border p-3 space-y-2">
                  <Skeleton height={14} />
                  <Skeleton width="60%" height={12} />
                </div>
              ))}
            </div>
          ))}
        </div>
      </div>
    );
  }

  if (error || !project) {
    return (
      <div className="p-8">
        <Link to="/projects" className="mb-4 inline-flex items-center text-sm text-muted-foreground hover:text-foreground">
          <ArrowLeft className="mr-1 h-4 w-4" /> Back to projects
        </Link>
        <p className="text-destructive">{error || 'Project not found'}</p>
      </div>
    );
  }

  const tasks = project.tasks || [];
  const done = tasks.filter((t) => t.status === 'done').length;

  return (
    <div className="flex flex-col h-full overflow-hidden">
      {/* Header */}
      <div className="shrink-0 px-4 md:px-6 py-3 border-b bg-card">
        <Link
          to="/projects"
          className="mb-1 inline-flex items-center text-xs text-muted-foreground hover:text-foreground"
        >
          <ArrowLeft className="mr-1 h-3.5 w-3.5" /> Projects
        </Link>
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="flex items-center gap-2 min-w-0">
            <h1 className="text-lg font-bold truncate">{project.name}</h1>
            {project.repository && (
              <Badge variant="outline" className="text-xs shrink-0">
                <Github className="w-3 h-3 mr-1" /> Repo
              </Badge>
            )}
            {isAutonomous && (
              <Badge variant="outline" className="text-xs text-green-600 border-green-500/30 bg-green-500/5 shrink-0">
                🤖 Autonomous
              </Badge>
            )}
            <Badge variant="outline" className="text-xs shrink-0">
              {done}/{tasks.length} done
            </Badge>
          </div>

          <div className="flex items-center gap-2 shrink-0">
            <Button
              size="sm"
              variant="ghost"
              className="gap-1.5 text-destructive hover:text-destructive"
              onClick={handleDeleteProject}
            >
              <Trash2 className="h-3.5 w-3.5" />
            </Button>
          </div>
        </div>
      </div>

      {/* Planning banner */}
      {planRunId && (
        <div className="mx-4 md:mx-6 mt-2 rounded-lg border border-primary/20 bg-primary/5 px-4 py-2.5 flex items-center justify-between shrink-0">
          <div className="flex items-center gap-3">
            <span className="relative flex h-2.5 w-2.5">
              <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-primary opacity-75" />
              <span className="relative inline-flex rounded-full h-2.5 w-2.5 bg-primary" />
            </span>
            <p className="text-sm">AI planning in progress…</p>
          </div>
          <Link to="/runs/$runId" params={{ runId: planRunId }} className="text-xs text-primary hover:underline">
            View run →
          </Link>
        </div>
      )}

      {/* Main content area — board takes full height, others stack */}
      <div className="flex-1 min-h-0 flex">
        {/* Board view — kanban + activity flyout */}
        {view === 'board' && (
          <ProjectBoardView
            project={project}
            projectId={projectId}
            projectAgents={projectAgents}
            onTaskClick={setSelectedTask}
            onRefresh={loadProject}
          />
        )}

        {view === 'graph' && (
          <div className="flex-1 p-4 md:px-6">
            {graphLoading ? (
              <div className="space-y-3 max-w-2xl mx-auto pt-8">
                <Skeleton height={300} />
              </div>
            ) : graphData ? (
              <DependencyGraph
                tasks={graphData.nodes}
                edges={graphData.edges}
                criticalPath={graphData.critical_path}
                onTaskClick={(taskId) => {
                  const t = tasks.find((t) => t.id === taskId);
                  if (t) setSelectedTask(t);
                }}
              />
            ) : (
              <p className="text-muted-foreground text-center py-12">No dependency data</p>
            )}
          </div>
        )}

        {view === 'timeline' && (
          <div className="flex-1 p-4 md:px-6 overflow-auto">
            {timelineLoading ? (
              <div className="space-y-2 pt-4">
                {[...Array(6)].map((_, i) => <Skeleton key={i} height={36} />)}
              </div>
            ) : timelineData ? (
              <GanttChart
                data={timelineData}
                onTaskClick={(taskId) => {
                  const t = tasks.find((t) => t.id === taskId);
                  if (t) setSelectedTask(t);
                }}
              />
            ) : (
              <p className="text-muted-foreground text-center py-12">No timeline data</p>
            )}
          </div>
        )}

        {view === 'team' && (
          <div className="flex-1 p-4 md:px-6 overflow-auto">
            <div className="max-w-2xl mx-auto">
              <TeamPanel projectId={projectId} />
            </div>
          </div>
        )}

        {view === 'settings' && (
          <div className="flex-1 p-4 md:px-6 overflow-auto">
            <div className="max-w-2xl mx-auto space-y-6">
              <RepositorySettings
                projectId={projectId}
                currentRepoUrl={project.repository}
                onUpdate={loadProject}
              />
              <SlackSettings
                projectId={projectId}
                currentChannelId={project.slack_channel_id}
                currentNotifyUserId={project.slack_notify_user_id}
                onUpdate={loadProject}
              />
            </div>
          </div>
        )}
      </div>

      {/* Dialogs */}
      {showPlanDialog && (
        <PlanDialog
          pipelines={pipelines}
          onClose={() => setShowPlanDialog(false)}
          onPlan={handlePlan}
          planning={planning}
        />
      )}

      {confirmAction && (
        <ConfirmDialog
          open
          onOpenChange={(open) => !open && setConfirmAction(null)}
          title={confirmAction.title}
          description={confirmAction.desc}
          confirmLabel={confirmAction.title}
          variant="destructive"
          onConfirm={() => { confirmAction.action(); setConfirmAction(null); }}
        />
      )}

      {/* Live activity flyout — always available, hovers from right edge */}
      <ProjectActivityFeed
        entries={activityEntries}
        onClear={() => {
          const now = Date.now();
          localStorage.setItem(clearedAtKey, String(now));
          clearedAtRef.current = now;
          setClearedAt(now);
          setActivityEntries([]);
        }}
      />

      {/* Task detail slide-over */}
      {selectedTask && (
        <>
          <div className="fixed inset-0 z-40 bg-black/20" onClick={() => setSelectedTask(null)} />
          <TaskDetailPanel
            task={selectedTask}
            projectId={projectId}
            onClose={() => setSelectedTask(null)}
            onUpdated={loadProject}
          />
        </>
      )}
    </div>
  );
}
