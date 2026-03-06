import { useState } from 'react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip';
import { Plus } from 'lucide-react';
import { SortableContext, verticalListSortingStrategy } from '@dnd-kit/sortable';
import { useDroppable } from '@dnd-kit/core';
import { createTask } from '@/lib/api';
import { SortableTaskCard } from './TaskCard';
import type { Column, Task, Dependency } from './types';

interface TeamAgent {
  agent_id: string;
  role: string;
  name?: string;
  emoji?: string | null;
}

interface KanbanColumnProps {
  column: Column;
  tasks: Task[];
  dependencies: Dependency[];
  projectId: string;
  onTaskClick: (task: Task) => void;
  onTaskCreated: () => void;
  /** Agents whose pulse_columns include this column */
  columnAgents?: TeamAgent[];
  /** Map of task_id → swarm_id for tasks in active swarms */
  swarmTaskMap?: Map<string, string>;
  /** Set of selected task IDs for swarm launch */
  selectedTaskIds?: Set<string>;
  /** Callback to toggle task selection for swarm */
  onToggleSwarmSelect?: (taskId: string) => void;
}

export function KanbanColumn({
  column,
  tasks,
  dependencies,
  projectId,
  onTaskClick,
  onTaskCreated,
  columnAgents = [],
  swarmTaskMap,
  selectedTaskIds,
  onToggleSwarmSelect,
}: KanbanColumnProps) {
  const [showAdd, setShowAdd] = useState(false);
  const [newTitle, setNewTitle] = useState('');
  const [creating, setCreating] = useState(false);

  // Make column a droppable zone
  const { setNodeRef, isOver } = useDroppable({
    id: column.id,
    data: { type: 'column', column }
  });

  const isOverWip = column.wip_limit !== null && tasks.length >= column.wip_limit;

  const handleCreate = async () => {
    if (!newTitle.trim()) return;
    setCreating(true);
    try {
      await createTask(projectId, { title: newTitle.trim(), columnId: column.id });
      setNewTitle('');
      setShowAdd(false);
      onTaskCreated();
    } catch (err) {
      console.error('Failed to create task:', err);
    } finally {
      setCreating(false);
    }
  };

  return (
    <div 
      ref={setNodeRef}
      className={`flex flex-col bg-muted/30 rounded-lg min-w-[280px] w-[280px] md:w-[300px] shrink-0 transition-all ${
        isOver ? 'ring-2 ring-primary bg-primary/5' : ''
      }`}
    >
      {/* Column Header */}
      <div className={`px-3 py-2 border-b ${isOverWip ? 'border-destructive/50' : ''}`}>
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <h3 className={`text-sm font-semibold ${isOverWip ? 'text-destructive' : ''}`}>
              {column.name}
            </h3>
            <span className={`text-xs px-1.5 py-0.5 rounded-full ${
              isOverWip
                ? 'bg-destructive/10 text-destructive font-medium'
                : 'bg-muted text-muted-foreground'
            }`}>
              {tasks.length}
              {column.wip_limit !== null && `/${column.wip_limit}`}
            </span>
          </div>
          {isOverWip && (
            <Badge variant="destructive" className="text-[10px] h-4">WIP</Badge>
          )}
        </div>
        {/* Agent roster for this column */}
        {columnAgents.length > 0 && (
          <TooltipProvider>
            <div className="flex items-center gap-1 mt-1.5 flex-wrap">
              {columnAgents.map((agent) => (
                <Tooltip key={agent.agent_id}>
                  <TooltipTrigger asChild>
                    <span className="flex h-5 w-5 items-center justify-center rounded text-[11px] bg-primary/10 border border-primary/20 cursor-default">
                      {agent.emoji || '🤖'}
                    </span>
                  </TooltipTrigger>
                  <TooltipContent>
                    {agent.name || agent.agent_id} · {agent.role}
                  </TooltipContent>
                </Tooltip>
              ))}
            </div>
          </TooltipProvider>
        )}
      </div>

      {/* Tasks */}
      <div className="flex-1 overflow-y-auto p-2 space-y-2 min-h-[100px] max-h-[calc(100vh-240px)]">
        <SortableContext items={tasks.map(t => t.id)} strategy={verticalListSortingStrategy}>
          {tasks.map(task => (
            <SortableTaskCard
              key={task.id}
              task={task}
              dependencies={dependencies}
              onClick={() => onTaskClick(task)}
              swarmId={swarmTaskMap?.get(task.id)}
              isSwarmSelected={selectedTaskIds?.has(task.id)}
              onToggleSwarmSelect={onToggleSwarmSelect}
            />
          ))}
        </SortableContext>

        {tasks.length === 0 && (
          <div className="text-xs text-muted-foreground text-center py-8">
            No tasks
          </div>
        )}
      </div>

      {/* Add Task */}
      <div className="p-2 border-t">
        {showAdd ? (
          <div className="space-y-2">
            <input
              type="text"
              value={newTitle}
              onChange={(e) => setNewTitle(e.target.value)}
              placeholder="Task title..."
              className="h-8 w-full rounded-md border border-input bg-background px-2 text-sm"
              autoFocus
              onKeyDown={(e) => {
                if (e.key === 'Enter') handleCreate();
                if (e.key === 'Escape') { setShowAdd(false); setNewTitle(''); }
              }}
            />
            <div className="flex gap-1">
              <Button size="sm" className="h-7 text-xs" onClick={handleCreate} disabled={creating || !newTitle.trim()}>
                Add
              </Button>
              <Button size="sm" variant="ghost" className="h-7 text-xs" onClick={() => { setShowAdd(false); setNewTitle(''); }}>
                Cancel
              </Button>
            </div>
          </div>
        ) : (
          <button
            onClick={() => setShowAdd(true)}
            className="flex items-center gap-1 w-full px-2 py-1.5 text-xs text-muted-foreground hover:text-foreground hover:bg-accent rounded transition-colors"
          >
            <Plus className="h-3 w-3" /> Add task
          </button>
        )}
      </div>
    </div>
  );
}
