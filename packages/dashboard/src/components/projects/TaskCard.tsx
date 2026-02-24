import { useRef } from 'react';
import { Link } from '@tanstack/react-router';
import { Badge } from '@/components/ui/badge';
import { GripVertical, Link2, Lock, GitBranch, GitPullRequest, Network } from 'lucide-react';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip';
import { useSortable } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { PRIORITY_COLORS } from './constants';
import type { Task, Dependency } from './types';

interface SortableTaskCardProps {
  task: Task;
  dependencies: Dependency[];
  onClick: () => void;
  /** If set, this task is part of an active swarm */
  swarmId?: string;
  /** Whether this task is selected for swarm execution */
  isSwarmSelected?: boolean;
  /** Toggle swarm selection */
  onToggleSwarmSelect?: (taskId: string) => void;
}

export function SortableTaskCard({
  task,
  dependencies,
  onClick,
  swarmId,
  isSwarmSelected,
  onToggleSwarmSelect,
}: SortableTaskCardProps) {
  const {
    attributes,
    listeners,
    setNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({ id: task.id, data: { type: 'task', task } });

  // Track whether a drag occurred so we can suppress the click that follows
  const didDragRef = useRef(false);
  const pointerStartRef = useRef<{ x: number; y: number } | null>(null);

  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
    opacity: isDragging ? 0.5 : 1,
  };

  const depCount = dependencies.filter(d => d.to_task_id === task.id).length;
  const isBlocked = task.status === 'blocked';
  const priorityClass = PRIORITY_COLORS[task.priority] || PRIORITY_COLORS.P2;

  // Merge dnd-kit listeners with our drag-tracking so clicks are suppressed after drags
  const handlePointerDown = (e: React.PointerEvent) => {
    didDragRef.current = false;
    pointerStartRef.current = { x: e.clientX, y: e.clientY };
    listeners?.onPointerDown?.(e as any);
  };

  const handleClick = (e: React.MouseEvent) => {
    if (didDragRef.current) {
      didDragRef.current = false;
      return;
    }
    // If pointer moved significantly, treat as drag not click
    if (pointerStartRef.current) {
      const dx = e.clientX - pointerStartRef.current.x;
      const dy = e.clientY - pointerStartRef.current.y;
      if (Math.abs(dx) > 5 || Math.abs(dy) > 5) return;
    }
    onClick();
  };

  // Mark drag as occurred whenever transform is non-null (item moved)
  if (isDragging) didDragRef.current = true;

  return (
    <div ref={setNodeRef} style={style} {...attributes}>
      <div
        className={`group rounded-lg border bg-card p-3 cursor-grab active:cursor-grabbing transition-all hover:border-primary/50 hover:shadow-sm ${isBlocked ? 'opacity-60' : ''} ${isSwarmSelected ? 'ring-1 ring-amber-500/50 border-amber-500/40' : ''}`}
        onPointerDown={handlePointerDown}
        onKeyDown={listeners?.onKeyDown as React.KeyboardEventHandler<HTMLDivElement> | undefined}
        onClick={handleClick}
      >
        <div className="flex items-start gap-2">
          {onToggleSwarmSelect && (
            <input
              type="checkbox"
              checked={!!isSwarmSelected}
              onChange={(e) => {
                e.stopPropagation();
                onToggleSwarmSelect(task.id);
              }}
              onClick={(e) => e.stopPropagation()}
              onPointerDown={(e) => e.stopPropagation()}
              className="mt-1 h-3.5 w-3.5 shrink-0 rounded border-muted-foreground/50 accent-amber-500"
              title="Select for swarm execution"
            />
          )}
          <div className="mt-0.5 shrink-0">
            <GripVertical className="h-4 w-4 text-muted-foreground opacity-0 group-hover:opacity-100 transition-opacity" />
          </div>
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-2 mb-1">
              <Badge variant="outline" className={`text-[10px] px-1.5 py-0 ${priorityClass}`}>
                {task.priority}
              </Badge>
              {isBlocked && <Lock className="h-3 w-3 text-red-500" />}
              {depCount > 0 && (
                <span className="flex items-center gap-0.5 text-[10px] text-muted-foreground">
                  <Link2 className="h-3 w-3" />
                  {depCount}
                </span>
              )}
            </div>
            <p className="text-sm font-medium leading-tight line-clamp-2">{task.title}</p>
            {task.tags.length > 0 && (
              <div className="flex flex-wrap gap-1 mt-1.5">
                {task.tags.slice(0, 3).map(tag => (
                  <span key={tag} className="text-[10px] px-1.5 py-0.5 rounded bg-muted text-muted-foreground">
                    {tag}
                  </span>
                ))}
                {task.tags.length > 3 && (
                  <span className="text-[10px] text-muted-foreground">+{task.tags.length - 3}</span>
                )}
              </div>
            )}
            <div className="flex items-center gap-2 mt-2 text-[10px] text-muted-foreground">
              {task.assigned_agent && (
                <span className="truncate max-w-[100px]">🤖 {task.assigned_agent}</span>
              )}
              {task.estimated_hours && (
                <span>{task.estimated_hours}h</span>
              )}
              {task.run_id && task.status === 'in_progress' && (
                <span className="flex items-center gap-1 text-blue-500">
                  <span className="relative flex h-2 w-2">
                    <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-blue-400 opacity-75"></span>
                    <span className="relative inline-flex rounded-full h-2 w-2 bg-blue-500"></span>
                  </span>
                  Running
                </span>
              )}
              {task.run_id && task.status !== 'in_progress' && !swarmId && (
                <Link
                  to="/runs/$runId"
                  params={{ runId: task.run_id }}
                  onClick={(e) => e.stopPropagation()}
                  className="text-primary hover:underline"
                >
                  View run
                </Link>
              )}
              {swarmId && (
                <Link
                  to="/runs/swarm/$swarmId"
                  params={{ swarmId }}
                  onClick={(e) => e.stopPropagation()}
                  className="flex items-center gap-0.5 text-indigo-400 hover:text-indigo-300"
                >
                  <Network className="h-3 w-3" />
                  <span className="animate-pulse">In swarm</span>
                </Link>
              )}
            </div>
            {/* Git branch & PR row */}
            {(task.metadata?.git_branch || task.metadata?.pr_url) && (
              <div className="flex items-center gap-2 mt-1 text-[10px] text-muted-foreground">
                {task.metadata?.git_branch && (
                  <TooltipProvider>
                    <Tooltip>
                      <TooltipTrigger asChild>
                        <span className="flex items-center gap-0.5 font-mono truncate max-w-[120px]">
                          <GitBranch className="h-3 w-3 shrink-0" />
                          {String(task.metadata.git_branch).replace('feat/', '')}
                        </span>
                      </TooltipTrigger>
                      <TooltipContent>{String(task.metadata.git_branch)}</TooltipContent>
                    </Tooltip>
                  </TooltipProvider>
                )}
                {task.metadata?.pr_url && (
                  <a
                    href={String(task.metadata.pr_url)}
                    target="_blank"
                    rel="noopener noreferrer"
                    onClick={(e) => e.stopPropagation()}
                    className="flex items-center gap-0.5 text-primary hover:underline"
                  >
                    <GitPullRequest className="h-3 w-3" />
                    PR #{task.metadata?.pr_number || '?'}
                  </a>
                )}
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
