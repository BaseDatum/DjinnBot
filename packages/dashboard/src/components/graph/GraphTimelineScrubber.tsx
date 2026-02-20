/**
 * Timeline scrubber — lets users replay graph construction over time.
 * Only renders when at least one node has a createdAt timestamp.
 */

import { useMemo } from 'react';
import { Clock, X } from 'lucide-react';
import { cn } from '@/lib/utils';
import type { GraphNode } from './types';

interface GraphTimelineScrubberProps {
  nodes: GraphNode[];
  value: number | null;
  onChange: (value: number | null) => void;
}

export function GraphTimelineScrubber({ nodes, value, onChange }: GraphTimelineScrubberProps) {
  const { minTs, maxTs, hasTimestamps } = useMemo(() => {
    const timestamps = nodes.map((n) => n.createdAt).filter((t): t is number => !!t);
    if (timestamps.length === 0) return { minTs: 0, maxTs: 0, hasTimestamps: false };
    return {
      minTs: Math.min(...timestamps),
      maxTs: Math.max(...timestamps),
      hasTimestamps: true,
    };
  }, [nodes]);

  if (!hasTimestamps) return null;

  const sliderValue = value ?? maxTs;

  const formatDate = (ts: number) =>
    new Date(ts).toLocaleDateString(undefined, {
      year: 'numeric',
      month: 'short',
      day: 'numeric',
    });

  // Count visible nodes at current timeline position
  const visibleCount = value !== null
    ? nodes.filter((n) => !n.createdAt || n.createdAt <= value).length
    : nodes.length;

  const pct = maxTs > minTs ? ((sliderValue - minTs) / (maxTs - minTs)) * 100 : 100;

  return (
    <div className="flex items-center gap-3 px-4 py-2 border-t border-border bg-background/95">
      <Clock className="h-3.5 w-3.5 text-muted-foreground shrink-0" />

      <div className="flex-1 flex items-center gap-3">
        {/* Date labels */}
        <span className="text-[10px] text-muted-foreground shrink-0">{formatDate(minTs)}</span>

        {/* Range slider */}
        <div className="flex-1 relative">
          <div className="h-1.5 rounded-full bg-muted overflow-hidden">
            <div
              className="h-full rounded-full bg-primary/70 transition-none"
              style={{ width: `${pct}%` }}
            />
          </div>
          <input
            type="range"
            min={minTs}
            max={maxTs}
            step={Math.max(1, Math.floor((maxTs - minTs) / 200))}
            value={sliderValue}
            onChange={(e) => onChange(Number(e.target.value))}
            className="absolute inset-0 w-full opacity-0 cursor-pointer h-full"
          />
        </div>

        <span className="text-[10px] text-muted-foreground shrink-0">{formatDate(maxTs)}</span>
      </div>

      {/* Current date label */}
      <div className="text-xs font-medium text-foreground shrink-0 min-w-[110px] text-center">
        {formatDate(sliderValue)}
        <span className="ml-1.5 text-[10px] text-muted-foreground">({visibleCount} nodes)</span>
      </div>

      {/* Reset */}
      <button
        onClick={() => onChange(null)}
        className={cn(
          'text-muted-foreground hover:text-foreground transition-colors',
          value === null && 'invisible'
        )}
        title="Reset timeline"
      >
        <X className="h-3.5 w-3.5" />
      </button>
    </div>
  );
}
