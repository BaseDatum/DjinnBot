import { Key, Share2, Server } from 'lucide-react';
import { cn } from '@/lib/utils';

interface KeyResolution {
  source?: string;
  userId?: string | null;
  resolvedProviders?: string[];
}

interface KeySourceBadgeProps {
  keyResolution: KeyResolution;
  className?: string;
  /** Show the resolved providers list */
  showProviders?: boolean;
}

/**
 * Visual badge indicating which key source was used for a run/step/chat.
 *
 * Sources:
 *  - executing_user: User's own API keys
 *  - project_key_user: Project-level key user
 *  - system: Instance-level (admin) keys
 */
export function KeySourceBadge({ keyResolution, className, showProviders = false }: KeySourceBadgeProps) {
  const { source, resolvedProviders } = keyResolution;

  let label = 'Unknown keys';
  let Icon = Key;
  let colorClass = 'border-muted-foreground/30 text-muted-foreground';

  switch (source) {
    case 'executing_user':
      label = 'Your keys';
      Icon = Key;
      colorClass = 'border-green-500/40 text-green-600 dark:text-green-400';
      break;
    case 'project_key_user':
      label = 'Project keys';
      Icon = Share2;
      colorClass = 'border-blue-500/40 text-blue-600 dark:text-blue-400';
      break;
    case 'system':
      label = 'Instance keys';
      Icon = Server;
      colorClass = 'border-amber-500/40 text-amber-600 dark:text-amber-400';
      break;
  }

  const providers = resolvedProviders?.length
    ? resolvedProviders.join(', ')
    : null;

  return (
    <span
      className={cn(
        'inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[10px] font-medium whitespace-nowrap',
        colorClass,
        className,
      )}
      title={providers ? `Providers: ${providers}` : undefined}
    >
      <Icon className="h-2.5 w-2.5 shrink-0" />
      {label}
      {showProviders && providers && (
        <span className="text-muted-foreground ml-0.5">({providers})</span>
      )}
    </span>
  );
}
