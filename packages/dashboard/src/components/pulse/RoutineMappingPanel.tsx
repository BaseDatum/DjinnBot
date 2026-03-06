import { useState, useEffect, useCallback } from 'react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Plus, Trash2, Check } from 'lucide-react';
import { toast } from 'sonner';
import {
  fetchPulseRoutines,
  fetchRoutineMappings,
  createRoutineMapping,
  updateRoutineMapping,
  deleteRoutineMapping,
  type PulseRoutine,
  type RoutineMapping,
  type ProjectColumn,
} from '@/lib/api';

const CORE_TOOLS = ['get_my_projects', 'get_ready_tasks', 'get_project_vision', 'get_task_context', 'create_task', 'execute_task', 'transition_task'];
const GIT_TOOLS = ['claim_task', 'get_task_branch', 'open_pull_request', 'get_task_pr_status'];

interface RoutineMappingPanelProps {
  projectId: string;
  agentId: string;
  /** Optional: class name for the container */
  className?: string;
}

export function RoutineMappingPanel({ projectId, agentId, className }: RoutineMappingPanelProps) {
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
    setMappings(prev => prev.map(m => m.id === mapping.id ? { ...m, columnIds: next } : m));
    try {
      const updated = await updateRoutineMapping(projectId, agentId, mapping.id, {
        columnIds: next,
      });
      setMappings(prev => prev.map(m => m.id === mapping.id ? { ...m, ...updated } : m));
    } catch (err) {
      setMappings(prev => prev.map(m => m.id === mapping.id ? { ...m, columnIds: current } : m));
      toast.error('Failed to update columns');
    }
  };

  const handleToolToggle = async (mapping: RoutineMapping, tool: string) => {
    const current = mapping.toolOverrides || [];
    const next = current.includes(tool)
      ? current.filter(t => t !== tool)
      : [...current, tool];
    setMappings(prev => prev.map(m => m.id === mapping.id ? { ...m, toolOverrides: next } : m));
    try {
      const updated = await updateRoutineMapping(projectId, agentId, mapping.id, {
        toolOverrides: next,
      });
      setMappings(prev => prev.map(m => m.id === mapping.id ? { ...m, ...updated } : m));
    } catch (err) {
      setMappings(prev => prev.map(m => m.id === mapping.id ? { ...m, toolOverrides: current } : m));
      toast.error('Failed to update tools');
    }
  };

  if (loading) {
    return <div className="px-4 pb-4 text-xs text-muted-foreground">Loading...</div>;
  }

  return (
    <div className={className ?? 'border-t px-4 pb-4 pt-3 space-y-3'}>
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
                <span className="text-[10px] text-muted-foreground italic">No columns selected</span>
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
