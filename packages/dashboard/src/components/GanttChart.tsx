import { useMemo } from 'react';
import { Badge } from '@/components/ui/badge';
import { cn } from '@/lib/utils';
import { STATUS_BG_CLASSES, PRIORITY_BORDER_CLASSES } from './projects/constants';

interface TimelineTask {
  id: string;
  title: string;
  status: string;
  priority: string;
  assigned_agent: string | null;
  tags: string[];
  estimated_hours: number | null;
  dependencies: string[];
  scheduled_start: number;
  scheduled_end: number;
  duration_days: number;
  actual: boolean;
  is_critical: boolean;
}

interface TimelineData {
  tasks: TimelineTask[];
  project_start: number;
  project_end: number;
  total_hours: number;
  total_days: number;
  critical_path: string[];
  hours_per_day: number;
}

interface GanttChartProps {
  data: TimelineData;
  onTaskClick?: (taskId: string) => void;
}

function formatDate(ms: number): string {
  const d = new Date(ms);
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}

export function GanttChart({ data, onTaskClick }: GanttChartProps) {
  const { tasks, project_start, project_end, total_days, critical_path } = data;

  // Generate day columns
  const days = useMemo(() => {
    const result: { date: Date; label: string; ms: number }[] = [];
    const msPerDay = 86400000;
    const start = new Date(project_start);
    start.setHours(0, 0, 0, 0);
    const startMs = start.getTime();
    
    // Show at most 60 days, or actual span + buffer
    const spanDays = Math.max(Math.ceil((project_end - project_start) / msPerDay) + 2, 7);
    const displayDays = Math.min(spanDays, 90);
    
    for (let i = 0; i < displayDays; i++) {
      const ms = startMs + i * msPerDay;
      const d = new Date(ms);
      result.push({
        date: d,
        label: d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' }),
        ms,
      });
    }
    return result;
  }, [project_start, project_end]);

  const totalSpanMs = days.length > 0 ? days[days.length - 1].ms + 86400000 - days[0].ms : 1;
  const startMs = days.length > 0 ? days[0].ms : project_start;

  // Sort tasks: critical path first, then by scheduled_start
  const sortedTasks = useMemo(() => {
    return [...tasks].sort((a, b) => {
      if (a.is_critical && !b.is_critical) return -1;
      if (!a.is_critical && b.is_critical) return 1;
      return a.scheduled_start - b.scheduled_start;
    });
  }, [tasks]);

  if (tasks.length === 0) {
    return (
      <div className="flex items-center justify-center h-64 text-muted-foreground">
        No tasks to display. Plan your project or add tasks first.
      </div>
    );
  }

  const dayWidth = 48; // px per day
  const rowHeight = 40;
  const headerHeight = 60;
  const labelWidth = 240;
  const chartWidth = days.length * dayWidth;

  return (
    <div className="border rounded-lg bg-card overflow-hidden">
      {/* Summary bar */}
      <div className="flex items-center gap-4 px-4 py-2 border-b bg-muted/30 text-sm">
        <span className="font-medium">{tasks.length} tasks</span>
        <span className="text-muted-foreground">·</span>
        <span>{data.total_hours}h estimated</span>
        <span className="text-muted-foreground">·</span>
        <span>{total_days} working days</span>
        <span className="text-muted-foreground">·</span>
        <span className="text-red-500 font-medium">{critical_path.length} tasks on critical path</span>
      </div>

      <div className="overflow-auto" style={{ maxHeight: '70vh' }}>
        <div className="flex" style={{ minWidth: labelWidth + chartWidth }}>
          {/* Task labels (sticky left) */}
          <div className="sticky left-0 z-10 bg-card border-r shrink-0" style={{ width: labelWidth }}>
            {/* Header */}
            <div className="flex items-end px-3 border-b bg-muted/50 font-medium text-xs text-muted-foreground" style={{ height: headerHeight }}>
              <span className="pb-2">Task</span>
            </div>
            {/* Task rows */}
            {sortedTasks.map((task) => (
              <div
                key={task.id}
                className={cn(
                  "flex items-center gap-2 px-3 border-b cursor-pointer hover:bg-muted/50 transition-colors",
                  task.is_critical && "bg-red-500/5"
                )}
                style={{ height: rowHeight }}
                onClick={() => onTaskClick?.(task.id)}
              >
                <div className={cn("w-2 h-2 rounded-full shrink-0", STATUS_BG_CLASSES[task.status] || 'bg-slate-400')} />
                <span className="text-xs truncate font-medium" title={task.title}>
                  {task.title}
                </span>
                {task.is_critical && (
                  <Badge variant="destructive" className="text-[8px] px-1 py-0 shrink-0">CRIT</Badge>
                )}
              </div>
            ))}
          </div>

          {/* Chart area */}
          <div className="relative" style={{ width: chartWidth }}>
            {/* Day headers */}
            <div className="flex border-b bg-muted/50" style={{ height: headerHeight }}>
              {days.map((day, i) => {
                const isWeekend = day.date.getDay() === 0 || day.date.getDay() === 6;
                const isFirstOfMonth = day.date.getDate() === 1;
                return (
                  <div
                    key={i}
                    className={cn(
                      "flex flex-col items-center justify-end pb-1 border-r text-[10px] shrink-0",
                      isWeekend && "bg-muted/70",
                      isFirstOfMonth && "border-l-2 border-l-primary/30"
                    )}
                    style={{ width: dayWidth }}
                  >
                    {(i === 0 || isFirstOfMonth) && (
                      <span className="font-medium text-muted-foreground">
                        {day.date.toLocaleDateString('en-US', { month: 'short' })}
                      </span>
                    )}
                    <span className={cn("text-muted-foreground", isWeekend && "opacity-50")}>
                      {day.date.getDate()}
                    </span>
                  </div>
                );
              })}
            </div>

            {/* Weekend shading — rendered once */}
            {days.map((day, i) => {
              const isWeekend = day.date.getDay() === 0 || day.date.getDay() === 6;
              if (!isWeekend) return null;
              return (
                <div
                  key={i}
                  className="absolute bg-muted/40 pointer-events-none"
                  style={{ 
                    left: i * dayWidth, 
                    width: dayWidth,
                    top: 0,
                    height: headerHeight + sortedTasks.length * rowHeight
                  }}
                />
              );
            })}

            {/* Task bars */}
            {sortedTasks.map((task) => {
              const barStart = ((task.scheduled_start - startMs) / totalSpanMs) * chartWidth;
              const barWidth = Math.max(((task.scheduled_end - task.scheduled_start) / totalSpanMs) * chartWidth, 4);
              
              return (
                <div
                  key={task.id}
                  className={cn("relative border-b", task.is_critical && "bg-red-500/5")}
                  style={{ height: rowHeight }}
                >
                  {/* Task bar */}
                  <div
                    className={cn(
                      "absolute top-2 rounded-sm border-l-[3px] cursor-pointer transition-all hover:brightness-110 hover:shadow-md",
                      STATUS_BG_CLASSES[task.status] || 'bg-slate-400',
                      PRIORITY_BORDER_CLASSES[task.priority] || 'border-l-slate-400',
                      task.is_critical && "ring-1 ring-red-500/50",
                      task.actual && "opacity-90"
                    )}
                    style={{
                      left: Math.max(barStart, 0),
                      width: Math.max(barWidth, 8),
                      height: rowHeight - 16,
                    }}
                    onClick={() => onTaskClick?.(task.id)}
                    title={`${task.title}\n${formatDate(task.scheduled_start)} → ${formatDate(task.scheduled_end)}\n${task.duration_days}d · ${task.estimated_hours || '?'}h`}
                  >
                    {barWidth > 60 && (
                      <span className="absolute inset-0 flex items-center px-2 text-[10px] font-medium text-white truncate drop-shadow-sm">
                        {task.title}
                      </span>
                    )}
                  </div>
                </div>
              );
            })}

            {/* Today marker — rendered once */}
            {(() => {
              const todayOffset = ((Date.now() - startMs) / totalSpanMs) * chartWidth;
              if (todayOffset > 0 && todayOffset < chartWidth) {
                return (
                  <div
                    className="absolute top-0 bottom-0 w-0.5 bg-primary z-20 pointer-events-none"
                    style={{ left: todayOffset, height: headerHeight + sortedTasks.length * rowHeight }}
                  >
                    <div className="absolute -top-1 -left-1.5 w-3.5 h-3.5 rounded-full bg-primary" />
                  </div>
                );
              }
              return null;
            })()}
          </div>
        </div>
      </div>
    </div>
  );
}
