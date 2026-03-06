import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Switch } from '@/components/ui/switch';
import {
  Play,
  Copy,
  Trash2,
  ChevronRight,
  Clock,
  Zap,
  FolderKanban,
} from 'lucide-react';
import type { PulseRoutine } from '@/lib/api';

interface PulseRoutineCardProps {
  routine: PulseRoutine;
  isExpanded: boolean;
  mappedProjects?: Array<{ projectId: string; projectName: string }>;
  onToggle: () => void;
  onExpand: () => void;
  onTrigger: () => void;
  onDuplicate: () => void;
  onDelete: () => void;
}

function formatInterval(minutes: number): string {
  if (minutes < 60) return `${minutes}m`;
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return m > 0 ? `${h}h ${m}m` : `${h}h`;
}

function formatRelativeTime(timestamp: number | null): string {
  if (!timestamp) return 'Never';
  const diff = Date.now() - timestamp;
  const minutes = Math.floor(diff / 60000);
  if (minutes < 1) return 'Just now';
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

export function PulseRoutineCard({
  routine,
  isExpanded,
  mappedProjects,
  onToggle,
  onExpand,
  onTrigger,
  onDuplicate,
  onDelete,
}: PulseRoutineCardProps) {
  const preview = routine.instructions
    .replace(/^#.*\n/gm, '')
    .replace(/\n+/g, ' ')
    .trim()
    .slice(0, 100);

  return (
    <div
      className={`rounded-lg border transition-colors ${
        routine.enabled
          ? 'border-border bg-card'
          : 'border-border/50 bg-muted/30 opacity-75'
      }`}
    >
      {/* Color accent bar */}
      <div
        className="h-1 rounded-t-lg"
        style={{ backgroundColor: routine.color || '#6366f1' }}
      />

      <div className="p-3 sm:p-4">
        {/* Header row */}
        <div className="flex items-start justify-between gap-2">
          <button
            onClick={onExpand}
            className="flex items-start gap-2 text-left group flex-1 min-w-0"
          >
            <ChevronRight
              className={`h-4 w-4 mt-0.5 text-muted-foreground transition-transform shrink-0 ${
                isExpanded ? 'rotate-90' : ''
              }`}
            />
            <div className="min-w-0">
              <div className="flex items-center gap-2 flex-wrap">
                <span className="font-semibold text-sm group-hover:underline truncate">
                  {routine.name}
                </span>
              </div>
              {preview && (
                <p className="text-xs text-muted-foreground mt-0.5 line-clamp-1">
                  {preview}
                </p>
              )}
            </div>
          </button>

          <div className="flex items-center gap-2 shrink-0">
            <Switch
              checked={routine.enabled}
              onCheckedChange={onToggle}
              className="scale-90"
            />
          </div>
        </div>

        {/* Stats row */}
        <div className="flex items-center gap-3 mt-2 text-xs text-muted-foreground">
          <span className="flex items-center gap-1">
            <Clock className="h-3 w-3" />
            every {formatInterval(routine.intervalMinutes)}
          </span>
          <span className="flex items-center gap-1">
            <Zap className="h-3 w-3" />
            {routine.totalRuns} runs
          </span>
          {routine.lastRunAt && (
            <span>Last: {formatRelativeTime(routine.lastRunAt)}</span>
          )}
        </div>

        {/* Mapped projects */}
        {mappedProjects && mappedProjects.length > 0 && (
          <div className="flex items-center gap-1.5 mt-2 flex-wrap">
            <FolderKanban className="h-3 w-3 text-muted-foreground shrink-0" />
            {mappedProjects.map((p) => (
              <Badge
                key={p.projectId}
                variant="outline"
                className="text-[10px] font-normal"
              >
                {p.projectName}
              </Badge>
            ))}
          </div>
        )}
        {mappedProjects && mappedProjects.length === 0 && (
          <div className="flex items-center gap-1 mt-2 text-[10px] text-muted-foreground">
            <FolderKanban className="h-3 w-3 shrink-0" />
            <span>Not mapped to any projects</span>
          </div>
        )}

        {/* Action buttons (always visible) */}
        <div className="flex items-center gap-1 mt-2">
          <Button
            variant="ghost"
            size="sm"
            className="h-7 px-2 text-xs"
            onClick={onTrigger}
            disabled={!routine.enabled}
          >
            <Play className="h-3 w-3 mr-1" />
            Trigger
          </Button>
          <Button
            variant="ghost"
            size="sm"
            className="h-7 px-2 text-xs"
            onClick={onDuplicate}
          >
            <Copy className="h-3 w-3 mr-1" />
            Duplicate
          </Button>
          <Button
            variant="ghost"
            size="sm"
            className="h-7 px-2 text-xs text-destructive hover:text-destructive"
            onClick={onDelete}
          >
            <Trash2 className="h-3 w-3 mr-1" />
            Delete
          </Button>
        </div>
      </div>
    </div>
  );
}
