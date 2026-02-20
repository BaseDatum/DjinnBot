import { createFileRoute, Link, useNavigate } from '@tanstack/react-router';
import { Card, CardHeader, CardTitle, CardDescription, CardContent } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { FolderKanban, Plus, CheckCircle2, Clock, AlertCircle, Trash2, Github, Sparkles } from 'lucide-react';
import { useState, useEffect } from 'react';
import { fetchProjects, createProject, deleteProject, listOnboardingSessions } from '@/lib/api';
import { ConfirmDialog } from '@/components/ConfirmDialog';
import { OnboardingChat } from '@/components/onboarding/OnboardingChat';
import { OnboardingSessionsPanel } from '@/components/onboarding/OnboardingSessionsPanel';
import { Skeleton } from '@/components/ui/skeleton';

// Keys for persisting onboarding state across refreshes
const STORAGE_KEY_SESSION_ID = 'onboarding_active_session_id';
const STORAGE_KEY_SHOW = 'onboarding_chat_open';

export const Route = createFileRoute('/projects/')({
  component: ProjectsPage,
});

function ProjectsPage() {
  const navigate = useNavigate();
  const [projects, setProjects] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [showCreate, setShowCreate] = useState(false);
  // Restore onboarding chat open state from sessionStorage so refresh doesn't close it
  const [showOnboarding, setShowOnboarding] = useState(
    () => sessionStorage.getItem(STORAGE_KEY_SHOW) === 'true'
  );
  const [resumeSessionId, setResumeSessionId] = useState<string | undefined>(
    () => sessionStorage.getItem(STORAGE_KEY_SESSION_ID) ?? undefined
  );
  // Sessions panel: start open so abandoned sessions are visible immediately
  const [showSessionsPanel, setShowSessionsPanel] = useState(true);
  const [newName, setNewName] = useState('');
  const [newDesc, setNewDesc] = useState('');
  const [newRepo, setNewRepo] = useState('');
  const [creating, setCreating] = useState(false);
  const [confirmAction, setConfirmAction] = useState<{ title: string; desc: string; action: () => void } | null>(null);

  const loadProjects = async () => {
    try {
      setError(null);
      const data = await fetchProjects();
      setProjects(data);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load projects');
    } finally {
      setLoading(false);
    }
  };

  // Persist onboarding open/session state to sessionStorage so refresh restores it
  useEffect(() => {
    if (showOnboarding) {
      sessionStorage.setItem(STORAGE_KEY_SHOW, 'true');
    } else {
      sessionStorage.removeItem(STORAGE_KEY_SHOW);
    }
  }, [showOnboarding]);

  useEffect(() => {
    if (resumeSessionId) {
      sessionStorage.setItem(STORAGE_KEY_SESSION_ID, resumeSessionId);
    } else {
      sessionStorage.removeItem(STORAGE_KEY_SESSION_ID);
    }
  }, [resumeSessionId]);

  // Keep the sessions panel visible whenever there are existing sessions
  useEffect(() => {
    listOnboardingSessions(undefined, 1).then((data) => {
      if (data.length > 0) setShowSessionsPanel(true);
    }).catch(() => {});
  }, []);

  useEffect(() => {
    loadProjects();
  }, []);

  const handleCreate = async () => {
    if (!newName.trim()) return;
    setCreating(true);
    // Optimistic insert — add a placeholder immediately so the UI responds instantly
    const optimisticId = `__optimistic_${Date.now()}`;
    const optimisticProject = {
      id: optimisticId,
      name: newName.trim(),
      description: newDesc.trim(),
      repository: newRepo.trim() || undefined,
      status: 'active',
      total_tasks: 0,
      completed_tasks: 0,
      task_counts: {},
    };
    setProjects(prev => [optimisticProject, ...prev]);
    const savedName = newName.trim();
    const savedDesc = newDesc.trim();
    const savedRepo = newRepo.trim();
    setNewName('');
    setNewDesc('');
    setNewRepo('');
    setShowCreate(false);
    try {
      const created = await createProject({
        name: savedName,
        description: savedDesc,
        repository: savedRepo || undefined,
      });
      // Replace the optimistic entry with the real one
      setProjects(prev => prev.map(p => p.id === optimisticId ? created : p));
    } catch (err) {
      // Remove the optimistic entry on failure
      setProjects(prev => prev.filter(p => p.id !== optimisticId));
      setError(err instanceof Error ? err.message : 'Failed to create project');
    } finally {
      setCreating(false);
    }
  };

  const handleDelete = async (projectId: string, projectName: string, e: React.MouseEvent) => {
    e.preventDefault(); // Prevent navigation to project detail
    e.stopPropagation();
    
    setConfirmAction({
      title: 'Delete Project',
      desc: `Are you sure you want to permanently delete "${projectName}"? This will delete all tasks, dependencies, and workflows. This action cannot be undone.`,
      action: async () => {
        try {
          await deleteProject(projectId);
          await loadProjects();
        } catch (err) {
          setError(err instanceof Error ? err.message : 'Failed to delete project');
        }
      }
    });
  };

  if (loading) {
    return (
      <div className="p-4 md:p-8 max-w-5xl mx-auto space-y-6">
        <div className="flex items-center gap-3">
          <FolderKanban className="h-8 w-8 shrink-0" />
          <div>
            <h1 className="text-2xl md:text-3xl font-bold tracking-tight">Projects</h1>
            <p className="text-muted-foreground mt-1">Manage your agent-driven projects</p>
          </div>
        </div>
        <div className="grid gap-4 grid-cols-1">
          {[...Array(4)].map((_, i) => (
            <Card key={i} className="p-4">
              <div className="flex items-start justify-between mb-3">
                <div className="flex items-center gap-3">
                  <Skeleton width={40} height={40} borderRadius="0.5rem" />
                  <div className="space-y-1.5">
                    <Skeleton width={160} height={16} />
                    <Skeleton width={220} height={13} />
                  </div>
                </div>
                <Skeleton width={60} height={22} />
              </div>
              <Skeleton height={8} className="mb-3" />
              <div className="flex gap-4">
                <Skeleton width={80} height={13} />
                <Skeleton width={70} height={13} />
              </div>
            </Card>
          ))}
        </div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="p-4 md:p-8 max-w-5xl mx-auto">
        <p className="text-destructive">Error: {error}</p>
        <Button variant="outline" className="mt-4" onClick={loadProjects}>Retry</Button>
      </div>
    );
  }

  return (
    <div className="p-4 md:p-8 max-w-5xl mx-auto">
      <div className="mb-6 md:mb-8 flex flex-col sm:flex-row sm:items-center justify-between gap-4">
        <div className="flex items-center gap-3">
          <FolderKanban className="h-8 w-8 shrink-0" />
          <div>
            <h1 className="text-2xl md:text-3xl font-bold tracking-tight">Projects</h1>
            <p className="text-muted-foreground mt-1">Manage your agent-driven projects</p>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <Button variant="outline" onClick={() => setShowCreate(!showCreate)}>
            <Plus className="h-4 w-4 mr-2" />
            Quick Create
          </Button>
          <Button onClick={() => setShowSessionsPanel(prev => !prev)}>
            <Sparkles className="h-4 w-4 mr-2" />
            Agent Guided
          </Button>
        </div>
      </div>

      {/* Create Project Form */}
      {showCreate && (
        <Card className="mb-6">
          <CardContent className="pt-6">
            <div className="space-y-4">
              <div>
                <label className="block text-sm font-medium mb-1.5">Project Name</label>
                <input
                  type="text"
                  value={newName}
                  onChange={(e) => setNewName(e.target.value)}
                  placeholder="My Awesome Project"
                  className="h-10 w-full rounded-md border border-input bg-background px-3 text-sm"
                  autoFocus
                  onKeyDown={(e) => e.key === 'Enter' && handleCreate()}
                />
              </div>
              <div>
                <label className="block text-sm font-medium mb-1.5">Description</label>
                <textarea
                  value={newDesc}
                  onChange={(e) => setNewDesc(e.target.value)}
                  placeholder="What is this project about?"
                  className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm resize-y h-20"
                />
              </div>
              <div>
                <label className="block text-sm font-medium mb-1.5">Git Repository (Optional)</label>
                <input
                  type="text"
                  value={newRepo}
                  onChange={(e) => setNewRepo(e.target.value)}
                  placeholder="https://github.com/user/repo.git"
                  className="h-10 w-full rounded-md border border-input bg-background px-3 text-sm"
                />
                <p className="text-xs text-muted-foreground mt-1">
                  HTTPS, SSH, or github.com/user/repo shorthand
                </p>
              </div>
              <div className="flex gap-2">
                <Button onClick={handleCreate} disabled={creating || !newName.trim()}>
                  {creating ? 'Creating...' : 'Create Project'}
                </Button>
                <Button variant="outline" onClick={() => setShowCreate(false)}>Cancel</Button>
              </div>
            </div>
          </CardContent>
        </Card>
      )}

      {/* Projects Grid */}
      {projects.length === 0 ? (
        <Card>
          <CardContent className="py-12 text-center">
            <FolderKanban className="h-12 w-12 mx-auto mb-4 text-muted-foreground" />
            <h3 className="text-lg font-medium mb-2">No projects yet</h3>
            <p className="text-muted-foreground mb-4">Create your first project to get started with agent-driven development.</p>
            <div className="flex items-center justify-center gap-3">
              <Button variant="outline" onClick={() => setShowCreate(true)}>
                <Plus className="h-4 w-4 mr-2" />
                Quick Create
              </Button>
              <Button onClick={() => setShowSessionsPanel(prev => !prev)}>
                <Sparkles className="h-4 w-4 mr-2" />
                Agent Guided
              </Button>
            </div>
          </CardContent>
        </Card>
      ) : (
        <div className="grid gap-4 grid-cols-1">
          {projects.map((project) => {
            const total = project.total_tasks || 0;
            const completed = project.completed_tasks || 0;
            const progress = total > 0 ? Math.round((completed / total) * 100) : 0;
            const taskCounts = project.task_counts || {};

            return (
              <Link
                key={project.id}
                to="/projects/$projectId"
                params={{ projectId: project.id }}
                search={{ view: 'board', plan: undefined }}
                className="block group"
              >
                <Card className="hover:border-primary/50 transition-colors cursor-pointer h-full">
                  <CardHeader className="pb-3">
                    <div className="flex items-start justify-between">
                      <div className="flex items-center gap-3">
                        <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-primary/10">
                          <FolderKanban className="h-5 w-5 text-primary" />
                        </div>
                        <div>
                          <div className="flex items-center gap-2">
                            <CardTitle className="text-base">{project.name}</CardTitle>
                            {project.repository && (
                              <Badge variant="outline" className="text-[10px] px-1.5 py-0">
                                <Github className="h-2.5 w-2.5" />
                              </Badge>
                            )}
                          </div>
                          {project.description && (
                            <CardDescription className="mt-0.5 line-clamp-1">{project.description}</CardDescription>
                          )}
                        </div>
                      </div>
                      <div className="flex items-center gap-2">
                        <Badge
                          variant={project.status === 'active' ? 'default' : 'secondary'}
                          className="text-xs shrink-0"
                        >
                          {project.status}
                        </Badge>
                        <Button
                          variant="ghost"
                          size="icon"
                          className="h-8 w-8 opacity-0 group-hover:opacity-100 transition-opacity"
                          onClick={(e) => handleDelete(project.id, project.name, e)}
                          title="Delete project"
                        >
                          <Trash2 className="h-4 w-4 text-destructive" />
                        </Button>
                      </div>
                    </div>
                  </CardHeader>
                  <CardContent>
                    {/* Progress bar */}
                    {total > 0 && (
                      <div className="mb-3">
                        <div className="flex items-center justify-between text-xs text-muted-foreground mb-1">
                          <span>{completed}/{total} tasks</span>
                          <span>{progress}%</span>
                        </div>
                        <div className="h-2 rounded-full bg-muted overflow-hidden">
                          <div
                            className="h-full rounded-full bg-primary transition-all"
                            style={{ width: `${progress}%` }}
                          />
                        </div>
                      </div>
                    )}

                    {/* Task status badges */}
                    <div className="flex flex-wrap gap-2 text-xs">
                      {(taskCounts.in_progress || 0) > 0 && (
                        <div className="flex items-center gap-1 text-blue-500">
                          <Clock className="h-3 w-3" />
                          {taskCounts.in_progress} in progress
                        </div>
                      )}
                      {(taskCounts.blocked || 0) > 0 && (
                        <div className="flex items-center gap-1 text-red-500">
                          <AlertCircle className="h-3 w-3" />
                          {taskCounts.blocked} blocked
                        </div>
                      )}
                      {(taskCounts.done || 0) > 0 && (
                        <div className="flex items-center gap-1 text-green-500">
                          <CheckCircle2 className="h-3 w-3" />
                          {taskCounts.done} done
                        </div>
                      )}
                      {total === 0 && (
                        <span className="text-muted-foreground">No tasks yet</span>
                      )}
                    </div>
                  </CardContent>
                </Card>
              </Link>
            );
          })}
        </div>
      )}

      {confirmAction && (
        <ConfirmDialog
          open={!!confirmAction}
          onOpenChange={(open) => !open && setConfirmAction(null)}
          title={confirmAction.title}
          description={confirmAction.desc}
          onConfirm={confirmAction.action}
        />
      )}

      {/* Onboarding sessions picker — inline panel below header */}
      {showSessionsPanel && !showOnboarding && (
        <Card className="mb-6">
          <CardHeader className="pb-3">
            <CardTitle className="text-base flex items-center gap-2">
              <Sparkles className="h-4 w-4 text-primary" />
              Agent Guided Setup
            </CardTitle>
            <CardDescription>Resume a previous session or start a new one.</CardDescription>
          </CardHeader>
          <CardContent>
            <OnboardingSessionsPanel
              onStartNew={() => {
                setResumeSessionId(undefined);
                setShowSessionsPanel(false);
                setShowOnboarding(true);
              }}
              onResume={(sessionId) => {
                setResumeSessionId(sessionId);
                setShowSessionsPanel(false);
                setShowOnboarding(true);
              }}
            />
          </CardContent>
        </Card>
      )}

      {/* Agent Guided Onboarding — full-screen modal */}
      {showOnboarding && (
        <OnboardingChat
          resumeSessionId={resumeSessionId}
          onClose={() => {
            setShowOnboarding(false);
            setResumeSessionId(undefined);
          }}
          onProjectCreated={(projectId) => {
            setShowOnboarding(false);
            setResumeSessionId(undefined);
            loadProjects();
            navigate({ to: '/projects/$projectId', params: { projectId }, search: { view: 'board', plan: undefined } });
          }}
        />
      )}
    </div>
  );
}
