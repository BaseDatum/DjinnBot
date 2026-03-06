import { useState, useCallback, useEffect } from 'react';
import {
  DndContext,
  DragOverlay,
  pointerWithin,
  rectIntersection,
  KeyboardSensor,
  PointerSensor,
  useSensor,
  useSensors,
  type DragStartEvent,
  type DragEndEvent,
  type CollisionDetection,
} from '@dnd-kit/core';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { moveTask, fetchSwarms, resolveRoutineConfigs, type BoardSwarmResult } from '@/lib/api';
import { KanbanColumn } from './KanbanColumn';
import { SwarmLaunchDialog } from './SwarmLaunchDialog';
import { SwarmView } from '@/components/swarm/SwarmView';
import { PRIORITY_COLORS } from './constants';
import { Zap, X } from 'lucide-react';
import type { Task, Project } from './types';

// Fallback role → column mapping for legacy projects without routine mappings
const FALLBACK_ROLE_COLUMNS: Record<string, string[]> = {
  lead:     ['Ready', 'Review'],
  member:   ['Ready', 'In Progress'],
  reviewer: ['Review'],
};

interface ProjectAgent {
  agent_id: string;
  role: string;
  name?: string;
  emoji?: string | null;
}

interface ProjectBoardViewProps {
  project: Project;
  projectId: string;
  projectAgents: ProjectAgent[];
  onTaskClick: (task: Task) => void;
  onRefresh: () => void;
}

export function ProjectBoardView({
  project,
  projectId,
  projectAgents,
  onTaskClick,
  onRefresh,
}: ProjectBoardViewProps) {
  const [activeId, setActiveId] = useState<string | null>(null);
  const [swarmTaskMap, setSwarmTaskMap] = useState<Map<string, string>>(new Map());
  const [selectedTaskIds, setSelectedTaskIds] = useState<Set<string>>(new Set());
  const [showSwarmDialog, setShowSwarmDialog] = useState(false);
  const [activeSwarmId, setActiveSwarmId] = useState<string | null>(null);

  // Dynamic column→agent mapping from routine configurations
  // Maps column name → set of agent_ids that have that column in their resolved routines
  const [routineColumnMap, setRoutineColumnMap] = useState<Map<string, Set<string>>>(new Map());
  const [routineMapLoaded, setRoutineMapLoaded] = useState(false);

  const toggleTaskSelection = useCallback((taskId: string) => {
    setSelectedTaskIds(prev => {
      const next = new Set(prev);
      if (next.has(taskId)) next.delete(taskId);
      else next.add(taskId);
      return next;
    });
  }, []);

  const clearSelection = useCallback(() => setSelectedTaskIds(new Set()), []);

  // Fetch active swarms and build task_id → swarm_id map
  useEffect(() => {
    fetchSwarms()
      .then((data: any) => {
        const map = new Map<string, string>();
        for (const swarm of data.swarms || []) {
          if (swarm.status !== 'running') continue;
          for (const task of swarm.tasks || []) {
            if (task.task_id && (task.status === 'running' || task.status === 'ready' || task.status === 'pending')) {
              map.set(task.task_id, swarm.swarm_id);
            }
          }
        }
        setSwarmTaskMap(map);
      })
      .catch(() => {});
  }, []);

  // Resolve routine configs for each agent to build dynamic column→agent map
  useEffect(() => {
    if (projectAgents.length === 0) return;
    const columnMap = new Map<string, Set<string>>();
    const columnIdToName = new Map(
      (project.columns || []).map((c) => [c.id, c.name]),
    );

    Promise.all(
      projectAgents.map((pa) =>
        resolveRoutineConfigs(projectId, pa.agent_id)
          .then(({ resolved }) => {
            for (const cfg of resolved) {
              for (const colId of cfg.effectiveColumns) {
                const colName = columnIdToName.get(colId);
                if (!colName) continue;
                if (!columnMap.has(colName)) columnMap.set(colName, new Set());
                columnMap.get(colName)!.add(pa.agent_id);
              }
            }
          })
          .catch(() => {}),
      ),
    ).then(() => {
      setRoutineColumnMap(columnMap);
      setRoutineMapLoaded(true);
    });
  }, [projectAgents, projectId, project.columns]);

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 5 } }),
    useSensor(KeyboardSensor),
  );

  // Custom collision detection: prefer column droppables over task sortables
  // so cross-container drops work reliably
  const collisionDetection: CollisionDetection = useCallback((args) => {
    // First try pointerWithin — finds all droppables the pointer is inside
    const pointerCollisions = pointerWithin(args);
    if (pointerCollisions.length > 0) {
      // Prefer column droppable zones over individual task sortables
      const columnHit = pointerCollisions.find(
        (c) => c.data?.droppableContainer?.data?.current?.type === 'column',
      );
      // If we hit a sortable task, use that (enables reorder within column)
      const taskHit = pointerCollisions.find(
        (c) => c.data?.droppableContainer?.data?.current?.type === 'task',
      );
      if (taskHit) return [taskHit];
      if (columnHit) return [columnHit];
      return pointerCollisions;
    }
    // Fallback to rect intersection for edge cases
    return rectIntersection(args);
  }, []);

  const columns = project.columns || [];
  const tasks = project.tasks || [];
  const dependencies = project.dependencies || [];

  const getColumnTasks = useCallback(
    (columnId: string) =>
      tasks
        .filter((t) => t.column_id === columnId)
        .sort((a, b) => a.column_position - b.column_position),
    [tasks],
  );

  const findTask = useCallback(
    (taskId: string) => tasks.find((t) => t.id === taskId),
    [tasks],
  );

  // Compute which agents are rostered on each column.
  // Uses resolved routine mappings when available; falls back to role-based mapping
  // for agents without routine configs (legacy projects).
  const getColumnAgents = useCallback(
    (colName: string): ProjectAgent[] => {
      return projectAgents.filter((pa) => {
        // If routine mappings are loaded and this agent appears in any routine column,
        // use the routine-based mapping exclusively for this agent
        if (routineMapLoaded) {
          const agentHasRoutines = Array.from(routineColumnMap.values()).some(
            (agentSet) => agentSet.has(pa.agent_id),
          );
          if (agentHasRoutines) {
            const agentsOnCol = routineColumnMap.get(colName);
            return agentsOnCol ? agentsOnCol.has(pa.agent_id) : false;
          }
        }
        // Fallback: role-based mapping for agents without routine configs
        const roleCols = FALLBACK_ROLE_COLUMNS[pa.role] || [];
        return roleCols.includes(colName);
      });
    },
    [projectAgents, routineColumnMap, routineMapLoaded],
  );

  const handleDragStart = (event: DragStartEvent) => {
    setActiveId(event.active.id as string);
  };

  const handleDragEnd = async (event: DragEndEvent) => {
    const { active, over } = event;
    setActiveId(null);
    if (!over) return;

    const taskId = active.id as string;
    const task = findTask(taskId);
    if (!task) return;

    // Determine target column
    let targetColumnId: string;
    const overData = over.data.current;

    if (overData?.type === 'column') {
      targetColumnId = over.id as string;
    } else {
      const overTask = findTask(over.id as string);
      if (overTask) {
        targetColumnId = overTask.column_id;
      } else if (columns.some((c) => c.id === over.id)) {
        targetColumnId = over.id as string;
      } else {
        return;
      }
    }

    if (task.column_id === targetColumnId) return;

    try {
      await moveTask(projectId, taskId, targetColumnId);
      onRefresh();
    } catch (err) {
      console.error('[Board] Move failed:', err);
      onRefresh();
    }
  };

  const activeTask = activeId ? findTask(activeId) : null;

  return (
    <div className="flex-1 overflow-x-auto overflow-y-hidden p-4 md:px-6 min-w-0">
      {/* Swarm selection bar */}
      {selectedTaskIds.size > 0 && (
        <div className="flex items-center gap-3 mb-3 px-2 py-2 rounded-lg border bg-amber-500/5 border-amber-500/30">
          <Zap className="h-4 w-4 text-amber-500 shrink-0" />
          <span className="text-sm font-medium">
            {selectedTaskIds.size} task{selectedTaskIds.size > 1 ? 's' : ''} selected
          </span>
          <Button
            size="sm"
            className="h-7 text-xs gap-1"
            onClick={() => setShowSwarmDialog(true)}
          >
            <Zap className="h-3 w-3" />
            Execute as Swarm
          </Button>
          <Button
            variant="ghost"
            size="sm"
            className="h-7 text-xs gap-1 text-muted-foreground"
            onClick={clearSelection}
          >
            <X className="h-3 w-3" />
            Clear
          </Button>
        </div>
      )}

      {/* Active swarm view */}
      {activeSwarmId && (
        <div className="mb-4 rounded-lg border overflow-hidden" style={{ height: 300 }}>
          <div className="flex items-center justify-between px-3 py-1.5 border-b bg-muted/30">
            <span className="text-xs font-medium">Swarm: {activeSwarmId}</span>
            <Button variant="ghost" size="sm" className="h-6 w-6 p-0" onClick={() => setActiveSwarmId(null)}>
              <X className="h-3 w-3" />
            </Button>
          </div>
          <SwarmView swarmId={activeSwarmId} />
        </div>
      )}

      {/* Swarm launch dialog */}
      {showSwarmDialog && (
        <SwarmLaunchDialog
          projectId={projectId}
          selectedTaskIds={[...selectedTaskIds]}
          agents={projectAgents}
          onClose={() => setShowSwarmDialog(false)}
          onLaunched={(result: BoardSwarmResult) => {
            setShowSwarmDialog(false);
            clearSelection();
            setActiveSwarmId(result.swarm_id);
          }}
        />
      )}

      <DndContext
        sensors={sensors}
        collisionDetection={collisionDetection}
        onDragStart={handleDragStart}
        onDragEnd={handleDragEnd}
      >
        <div className="flex gap-3 h-full">
          {columns.map((column) => (
            <KanbanColumn
              key={column.id}
              column={column}
              tasks={getColumnTasks(column.id)}
              dependencies={dependencies}
              projectId={projectId}
              onTaskClick={onTaskClick}
              onTaskCreated={onRefresh}
              columnAgents={getColumnAgents(column.name)}
              swarmTaskMap={swarmTaskMap}
              selectedTaskIds={selectedTaskIds}
              onToggleSwarmSelect={toggleTaskSelection}
            />
          ))}
        </div>

        <DragOverlay>
          {activeTask ? (
            <div className="rounded-lg border bg-card p-3 shadow-lg w-[280px] rotate-2 opacity-90">
              <Badge
                variant="outline"
                className={`text-[10px] ${PRIORITY_COLORS[activeTask.priority] || ''}`}
              >
                {activeTask.priority}
              </Badge>
              <p className="text-sm font-medium mt-1 line-clamp-2">{activeTask.title}</p>
            </div>
          ) : null}
        </DragOverlay>
      </DndContext>
    </div>
  );
}
