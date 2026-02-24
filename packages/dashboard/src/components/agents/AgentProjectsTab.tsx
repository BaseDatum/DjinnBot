import { useState, useEffect, useCallback } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Bot, FolderKanban, ArrowRight, Plus, Trash2, Settings2, ChevronDown, ChevronRight, Check } from 'lucide-react';
import { toast } from 'sonner';
import {
  fetchAgentProjects,
  fetchPulseRoutines,
  fetchRoutineMappings,
  createRoutineMapping,
  updateRoutineMapping,
  deleteRoutineMapping,
  type PulseRoutine,
  type RoutineMapping,
  type ProjectColumn,
} from '@/lib/api';


interface AgentProjectsTabProps {
  agentId: string;
}

const ROLE_COLORS: Record<string, string> = {
  lead: 'bg-amber-500/10 text-amber-600 border-amber-500/30',
  member: 'bg-blue-500/10 text-blue-600 border-blue-500/30',
  reviewer: 'bg-purple-500/10 text-purple-600 border-purple-500/30',
};

const STATUS_COLORS: Record<string, string> = {
  active: 'text-green-600',
  planning: 'text-amber-600',
  completed: 'text-muted-foreground',
  archived: 'text-muted-foreground',
};

export function AgentProjectsTab({ agentId }: AgentProjectsTabProps) {
  const queryClient = useQueryClient();
  const [expandedProject, setExpandedProject] = useState<string | null>(null);

  const { data: projects = [], isLoading } = useQuery({
    queryKey: ['agentProjects', agentId],
    queryFn: () => fetchAgentProjects(agentId),
    refetchInterval: 30_000,
  });

  if (isLoading) {
    return (
      <div className="flex items-center justify-center py-12 text-muted-foreground text-sm">
        Loading projects...
      </div>
    );
  }

  if (projects.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center py-12 gap-3 text-muted-foreground">
        <FolderKanban className="h-8 w-8 opacity-40" />
        <p className="text-sm">Not assigned to any projects</p>
        <p className="text-xs text-center max-w-xs">
          Assign this agent to a project via the project's Team panel to enable autonomous task execution.
        </p>
      </div>
    );
  }

  return (
    <div className="p-4 space-y-3">
      {projects.map((proj: any) => {
        const roleColor = ROLE_COLORS[proj.role] || ROLE_COLORS.member;
        const statusColor = STATUS_COLORS[proj.project_status] || 'text-muted-foreground';
        const isExpanded = expandedProject === proj.project_id;

        return (
          <div
            key={proj.project_id}
            className="rounded-lg border bg-card hover:border-primary/40 transition-colors"
          >
            <div className="flex items-start gap-3 p-3.5">
              <div className="flex h-9 w-9 items-center justify-center rounded-lg bg-primary/10 shrink-0 mt-0.5">
                <FolderKanban className="h-4.5 w-4.5 text-primary" />
              </div>

              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2 flex-wrap">
                  <Link
                    to="/projects/$projectId"
                    params={{ projectId: proj.project_id }}
                    search={{ view: 'board', plan: undefined }}
                    className="font-semibold text-sm hover:text-primary transition-colors truncate"
                  >
                    {proj.project_name}
                  </Link>
                  <Badge
                    variant="outline"
                    className={`text-[10px] capitalize ${roleColor}`}
                  >
                    {proj.role}
                  </Badge>
                  <span className={`text-[10px] capitalize ${statusColor}`}>
                    {proj.project_status}
                  </span>
                </div>

                <div className="mt-1.5 flex items-center gap-2">
                  <Button
                    variant="ghost"
                    size="sm"
                    className="h-6 text-xs gap-1 text-muted-foreground"
                    onClick={() => setExpandedProject(isExpanded ? null : proj.project_id)}
                  >
                    <Settings2 className="h-3 w-3" />
                    Routine Mappings
                    {isExpanded ? <ChevronDown className="h-3 w-3" /> : <ChevronRight className="h-3 w-3" />}
                  </Button>
                </div>
              </div>

              <Link
                to="/projects/$projectId"
                params={{ projectId: proj.project_id }}
                search={{ view: 'board', plan: undefined }}
                className="shrink-0 self-center text-muted-foreground hover:text-primary transition-colors"
              >
                <ArrowRight className="h-4 w-4" />
              </Link>
            </div>

            {isExpanded && (
              <RoutineMappingPanel
                projectId={proj.project_id}
                agentId={agentId}
              />
            )}
          </div>
        );
      })}

      <p className="text-xs text-muted-foreground text-center pt-1">
        {projects.length} project{projects.length === 1 ? '' : 's'}
      </p>
    </div>
  );
}


// ═══════════════════════════════════════════════════════════════════════════
// Routine Mapping Panel — shown when a project is expanded
// ═══════════════════════════════════════════════════════════════════════════

function RoutineMappingPanel({ projectId, agentId }: { projectId: string; agentId: string }) {
  const [mappings, setMappings] = useState<RoutineMapping[]>([]);
  const [projectColumns, setProjectColumns] = useState<ProjectColumn[]>([]);
  const [routines, setRoutines] = useState<PulseRoutine[]>([]);
  const [loading, setLoading] = useState(true);
  const [addingRoutineId, setAddingRoutineId] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const [mapData, routineData] = await Promise.all([
        fetchRoutineMappings(projectId, agentId),
        fetchPulseRoutines(agentId),
      ]);
      setMappings(mapData.mappings);
      setProjectColumns(mapData.projectColumns);
      setRoutines(routineData.routines);
    } catch (err) {
      toast.error('Failed to load routine mappings');
    } finally {
      setLoading(false);
    }
  }, [projectId, agentId]);

  useEffect(() => { load(); }, [load]);

  const mappedRoutineIds = new Set(mappings.map(m => m.routineId));
  const unmappedRoutines = routines.filter(r => !mappedRoutineIds.has(r.id));

  const handleAdd = async (routineId: string) => {
    try {
      setAddingRoutineId(routineId);
      await createRoutineMapping(projectId, agentId, { routineId });
      await load();
      toast.success('Routine mapped');
    } catch (err) {
      toast.error('Failed to map routine');
    } finally {
      setAddingRoutineId(null);
    }
  };

  const handleDelete = async (mappingId: string) => {
    try {
      await deleteRoutineMapping(projectId, agentId, mappingId);
      setMappings(prev => prev.filter(m => m.id !== mappingId));
      toast.success('Mapping removed');
    } catch (err) {
      toast.error('Failed to remove mapping');
    }
  };

  const handleToggle = async (mapping: RoutineMapping) => {
    try {
      const updated = await updateRoutineMapping(projectId, agentId, mapping.id, {
        enabled: !mapping.enabled,
      });
      setMappings(prev => prev.map(m => m.id === mapping.id ? { ...m, ...updated } : m));
    } catch (err) {
      toast.error('Failed to toggle mapping');
    }
  };

  const handleColumnToggle = async (mapping: RoutineMapping, colId: string) => {
    const current = mapping.columnIds || [];
    const next = current.includes(colId)
      ? current.filter(id => id !== colId)
      : [...current, colId];
    try {
      const updated = await updateRoutineMapping(projectId, agentId, mapping.id, {
        columnIds: next.length > 0 ? next : undefined,
      });
      setMappings(prev => prev.map(m => m.id === mapping.id ? { ...m, ...updated } : m));
    } catch (err) {
      toast.error('Failed to update columns');
    }
  };

  const handleToolToggle = async (mapping: RoutineMapping, tool: string) => {
    const current = mapping.toolOverrides || [];
    const next = current.includes(tool)
      ? current.filter(t => t !== tool)
      : [...current, tool];
    try {
      const updated = await updateRoutineMapping(projectId, agentId, mapping.id, {
        toolOverrides: next.length > 0 ? next : undefined,
      });
      setMappings(prev => prev.map(m => m.id === mapping.id ? { ...m, ...updated } : m));
    } catch (err) {
      toast.error('Failed to update tools');
    }
  };

  if (loading) {
    return <div className="px-4 pb-4 text-xs text-muted-foreground">Loading...</div>;
  }

  const CORE_TOOLS = ['get_my_projects', 'get_ready_tasks', 'execute_task', 'get_task_context', 'transition_task'];
  const GIT_TOOLS = ['claim_task', 'get_task_branch', 'open_pull_request', 'get_task_pr_status'];

  return (
    <div className="border-t px-4 pb-4 pt-3 space-y-3">
      {mappings.length === 0 && (
        <p className="text-xs text-muted-foreground">
          No routines mapped. Map a routine to configure which columns and tools it uses in this project.
        </p>
      )}

      {mappings.map((mapping) => (
        <div key={mapping.id} className="rounded border bg-muted/30 p-3 space-y-2">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              <span className="text-sm font-medium">{mapping.routineName || 'Unknown'}</span>
              <Badge
                variant={mapping.enabled ? 'default' : 'secondary'}
                className="text-[10px] cursor-pointer"
                onClick={() => handleToggle(mapping)}
              >
                {mapping.enabled ? 'Enabled' : 'Disabled'}
              </Badge>
            </div>
            <Button
              variant="ghost"
              size="sm"
              className="h-6 w-6 p-0 text-muted-foreground hover:text-destructive"
              onClick={() => handleDelete(mapping.id)}
            >
              <Trash2 className="h-3 w-3" />
            </Button>
          </div>

          {/* Column selection */}
          <div>
            <label className="text-[10px] font-medium text-muted-foreground uppercase tracking-wider">
              Columns
            </label>
            <div className="flex flex-wrap gap-1 mt-1">
              {projectColumns.map((col) => {
                const active = mapping.columnIds?.includes(col.id);
                return (
                  <Badge
                    key={col.id}
                    variant={active ? 'default' : 'outline'}
                    className="text-[10px] cursor-pointer transition-colors"
                    onClick={() => handleColumnToggle(mapping, col.id)}
                  >
                    {active && <Check className="h-2 w-2 mr-0.5" />}
                    {col.name}
                  </Badge>
                );
              })}
              {(!mapping.columnIds || mapping.columnIds.length === 0) && (
                <span className="text-[10px] text-muted-foreground italic">Using routine defaults</span>
              )}
            </div>
          </div>

          {/* Tool overrides */}
          <div>
            <label className="text-[10px] font-medium text-muted-foreground uppercase tracking-wider">
              Tool Overrides
            </label>
            <div className="flex flex-wrap gap-1 mt-1">
              <span className="text-[10px] text-muted-foreground mr-1">Core:</span>
              {CORE_TOOLS.map((tool) => {
                const active = mapping.toolOverrides?.includes(tool);
                return (
                  <Badge
                    key={tool}
                    variant={active ? 'default' : 'outline'}
                    className="text-[10px] cursor-pointer transition-colors font-mono"
                    onClick={() => handleToolToggle(mapping, tool)}
                  >
                    {active && <Check className="h-2 w-2 mr-0.5" />}
                    {tool.replace(/_/g, ' ')}
                  </Badge>
                );
              })}
            </div>
            <div className="flex flex-wrap gap-1 mt-1">
              <span className="text-[10px] text-muted-foreground mr-1">Git:</span>
              {GIT_TOOLS.map((tool) => {
                const active = mapping.toolOverrides?.includes(tool);
                return (
                  <Badge
                    key={tool}
                    variant={active ? 'default' : 'outline'}
                    className="text-[10px] cursor-pointer transition-colors font-mono"
                    onClick={() => handleToolToggle(mapping, tool)}
                  >
                    {active && <Check className="h-2 w-2 mr-0.5" />}
                    {tool.replace(/_/g, ' ')}
                  </Badge>
                );
              })}
              {(!mapping.toolOverrides || mapping.toolOverrides.length === 0) && (
                <span className="text-[10px] text-muted-foreground italic ml-1">Using routine defaults</span>
              )}
            </div>
          </div>
        </div>
      ))}

      {/* Add routine mapping */}
      {unmappedRoutines.length > 0 && (
        <div className="flex flex-wrap gap-1.5 pt-1">
          <span className="text-xs text-muted-foreground self-center mr-1">Map routine:</span>
          {unmappedRoutines.map((r) => (
            <Button
              key={r.id}
              variant="outline"
              size="sm"
              className="h-6 text-xs gap-1"
              disabled={addingRoutineId === r.id}
              onClick={() => handleAdd(r.id)}
            >
              <Plus className="h-3 w-3" />
              {r.name}
            </Button>
          ))}
        </div>
      )}
    </div>
  );
}
