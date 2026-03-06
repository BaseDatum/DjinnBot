import { Key, Share2, Server } from 'lucide-react';
import { cn } from '@/lib/utils';

interface ProviderSource {
  source: string; // "personal" | "admin_shared" | "instance"
  masked_key: string;
}

interface KeyResolution {
  source?: string;
  userId?: string | null;
  resolvedProviders?: string[];
  providerSources?: Record<string, ProviderSource>;
}

interface KeySourceBadgeProps {
  keyResolution: KeyResolution;
  className?: string;
  /** Show the resolved providers list */
  showProviders?: boolean;
  /** Show per-provider key source details (enriched mode) */
  showKeyDetails?: boolean;
}

const SOURCE_META: Record<string, { label: string; color: string; icon: typeof Key }> = {
  personal: {
    label: 'Personal',
    color: 'border-green-500/40 text-green-600 dark:text-green-400',
    icon: Key,
  },
  admin_shared: {
    label: 'Shared',
    color: 'border-blue-500/40 text-blue-600 dark:text-blue-400',
    icon: Share2,
  },
  instance: {
    label: 'Instance',
    color: 'border-amber-500/40 text-amber-600 dark:text-amber-400',
    icon: Server,
  },
};

/**
 * Visual badge indicating which key source was used for a run/step/chat.
 *
 * Sources (top-level, legacy):
 *  - executing_user: User's own API keys
 *  - project_key_user: Project-level key user
 *  - system: Instance-level (admin) keys
 *
 * When `providerSources` is present (enriched format), shows per-provider
 * key type (personal / admin_shared / instance) with masked key hints.
 */
export function KeySourceBadge({ keyResolution, className, showProviders = false, showKeyDetails = false }: KeySourceBadgeProps) {
  const { source, resolvedProviders, providerSources } = keyResolution;

  // ── Enriched mode: show per-provider badges ──
  if (showKeyDetails && providerSources && Object.keys(providerSources).length > 0) {
    return (
      <span className={cn('inline-flex flex-wrap gap-1', className)}>
        {Object.entries(providerSources).map(([providerId, ps]) => {
          const meta = SOURCE_META[ps.source] || SOURCE_META.instance;
          const Icon = meta.icon;
          return (
            <span
              key={providerId}
              className={cn(
                'inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[10px] font-medium whitespace-nowrap',
                meta.color,
              )}
              title={`${providerId}: ${meta.label} key (${ps.masked_key})`}
            >
              <Icon className="h-2.5 w-2.5 shrink-0" />
              {providerId}
              <span className="font-mono text-muted-foreground">{ps.masked_key}</span>
            </span>
          );
        })}
      </span>
    );
  }

  // ── Summary mode: determine dominant source from providerSources ──
  let label = 'Unknown keys';
  let Icon = Key;
  let colorClass = 'border-muted-foreground/30 text-muted-foreground';

  // If we have providerSources, derive the dominant source for the summary badge
  if (providerSources && Object.keys(providerSources).length > 0) {
    const sources = new Set(Object.values(providerSources).map(ps => ps.source));
    if (sources.size === 1) {
      const src = [...sources][0];
      const meta = SOURCE_META[src];
      if (meta) {
        label = `${meta.label} keys`;
        Icon = meta.icon;
        colorClass = meta.color;
      }
    } else {
      // Mixed sources
      label = 'Mixed keys';
      Icon = Key;
      colorClass = 'border-purple-500/40 text-purple-600 dark:text-purple-400';
    }
  } else {
    // Legacy top-level source
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
  }

  const providers = resolvedProviders?.length
    ? resolvedProviders.join(', ')
    : null;

  // Build detailed tooltip when providerSources available
  const tooltip = providerSources && Object.keys(providerSources).length > 0
    ? Object.entries(providerSources)
        .map(([pid, ps]) => `${pid}: ${ps.source} (${ps.masked_key})`)
        .join('\n')
    : providers
      ? `Providers: ${providers}`
      : undefined;

  return (
    <span
      className={cn(
        'inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[10px] font-medium whitespace-nowrap',
        colorClass,
        className,
      )}
      title={tooltip}
    >
      <Icon className="h-2.5 w-2.5 shrink-0" />
      {label}
      {showProviders && providers && (
        <span className="text-muted-foreground ml-0.5">({providers})</span>
      )}
    </span>
  );
}
