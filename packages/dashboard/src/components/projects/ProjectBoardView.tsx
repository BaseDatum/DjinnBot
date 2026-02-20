import { useState, useCallback } from 'react';
import {
  DndContext,
  DragOverlay,
  closestCorners,
  KeyboardSensor,
  PointerSensor,
  useSensor,
  useSensors,
  type DragStartEvent,
  type DragEndEvent,
} from '@dnd-kit/core';
import { Badge } from '@/components/ui/badge';
import { moveTask } from '@/lib/api';
import { KanbanColumn } from './KanbanColumn';
import { PRIORITY_COLORS } from './constants';
import type { Task, Project } from './types';

// Map role → which columns they typically work from
const ROLE_COLUMNS: Record<string, string[]> = {
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

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 3 } }),
    useSensor(KeyboardSensor),
  );

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

  // Compute which agents are rostered on each column
  const getColumnAgents = useCallback(
    (colName: string): ProjectAgent[] => {
      return projectAgents.filter((pa) => {
        const roleCols = ROLE_COLUMNS[pa.role] || [];
        return roleCols.includes(colName);
      });
    },
    [projectAgents],
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
      <DndContext
        sensors={sensors}
        collisionDetection={closestCorners}
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
