/**
 * Left-side filter sidebar: visual category pills, orphan filter,
 * graph health mini-bar, and search box.
 */

import { AlertCircle, Wifi, WifiOff, RefreshCw, ZoomIn, ArrowLeft, Box, Square } from 'lucide-react';
import { cn } from '@/lib/utils';
import type { GraphViewMode, ZAxisMode } from './types';
import { Z_AXIS_MODES } from './types';
import type { GraphStats } from './types';
import { getCategoryColor, COLORS_DARK, COLORS_LIGHT } from './graphColors';
import { useEffect, useState } from 'react';

function useDarkMode() {
  const [isDark, setIsDark] = useState(() => document.documentElement.classList.contains('dark'));
  useEffect(() => {
    const obs = new MutationObserver(() => setIsDark(document.documentElement.classList.contains('dark')));
    obs.observe(document.documentElement, { attributes: true, attributeFilter: ['class'] });
    return () => obs.disconnect();
  }, []);
  return isDark;
}

interface GraphFilterSidebarProps {
  viewMode: GraphViewMode;
  onViewModeChange: (mode: GraphViewMode) => void;
  /** Hide the personal/shared/combined selector entirely. */
  hideViewMode?: boolean;
  categories: string[];
  categoryFilter: string;
  onCategoryChange: (cat: string) => void;
  searchQuery: string;
  onSearchChange: (q: string) => void;
  showOrphansOnly: boolean;
  onShowOrphansChange: (v: boolean) => void;
  orphanCount: number;
  nodeCount: number;
  edgeCount: number;
  stats: GraphStats | null;
  connected: boolean;
  rebuilding: boolean;
  onRebuild: () => void;
  onZoomToFit: () => void;
  focusNodeId: string | null;
  onExitFocus: () => void;
  nodeTypeCounts: Record<string, number>;
  /** 3D-specific: whether the sidebar is inside a 3D graph */
  is3D?: boolean;
  /** 3D-specific: current Z-axis mode */
  zAxisMode?: ZAxisMode;
  /** 3D-specific: change Z-axis mode */
  onZAxisModeChange?: (mode: ZAxisMode) => void;
  /** Switch between 2D/3D rendering */
  onSwitchDimension?: () => void;
}

export function GraphFilterSidebar({
  viewMode,
  onViewModeChange,
  categories,
  categoryFilter,
  onCategoryChange,
  searchQuery,
  onSearchChange,
  showOrphansOnly,
  onShowOrphansChange,
  orphanCount,
  nodeCount,
  edgeCount,
  stats,
  connected,
  rebuilding,
  onRebuild,
  onZoomToFit,
  focusNodeId,
  onExitFocus,
  nodeTypeCounts,
  hideViewMode,
  is3D,
  zAxisMode,
  onZAxisModeChange,
  onSwitchDimension,
}: GraphFilterSidebarProps) {
  const isDark = useDarkMode();
  const palette = isDark ? COLORS_DARK : COLORS_LIGHT;

  return (
    <div className="h-full flex flex-col bg-background/95 border-r border-border w-[200px] shrink-0 overflow-auto">
      {/* View mode */}
      {!hideViewMode && (
        <div className="p-3 border-b border-border">
          <p className="text-[10px] font-semibold text-muted-foreground uppercase tracking-wider mb-2">Vault</p>
          <div className="flex flex-col gap-1">
            {(['personal', 'shared', 'combined'] as GraphViewMode[]).map((m) => (
              <button
                key={m}
                onClick={() => onViewModeChange(m)}
                className={cn(
                  'text-left px-2.5 py-1.5 rounded text-sm transition-colors capitalize',
                  viewMode === m
                    ? 'bg-primary/10 text-primary font-medium'
                    : 'text-foreground hover:bg-muted'
                )}
              >
                {m}
              </button>
            ))}
          </div>
        </div>
      )}

      {/* 2D / 3D toggle + Z-axis mode */}
      {onSwitchDimension && (
        <div className="p-3 border-b border-border">
          <p className="text-[10px] font-semibold text-muted-foreground uppercase tracking-wider mb-2">Dimension</p>
          <div className="flex gap-1 mb-2">
            <button
              onClick={is3D ? onSwitchDimension : undefined}
              className={cn(
                'flex-1 text-xs px-2 py-1.5 rounded flex items-center justify-center gap-1.5 transition-colors',
                !is3D
                  ? 'bg-primary/10 text-primary font-medium'
                  : 'text-foreground hover:bg-muted'
              )}
            >
              <Square className="h-3 w-3" />2D
            </button>
            <button
              onClick={!is3D ? onSwitchDimension : undefined}
              className={cn(
                'flex-1 text-xs px-2 py-1.5 rounded flex items-center justify-center gap-1.5 transition-colors',
                is3D
                  ? 'bg-primary/10 text-primary font-medium'
                  : 'text-foreground hover:bg-muted'
              )}
            >
              <Box className="h-3 w-3" />3D
            </button>
          </div>
          {is3D && zAxisMode && onZAxisModeChange && (
            <>
              <p className="text-[10px] font-semibold text-muted-foreground uppercase tracking-wider mb-1.5">Z-Axis</p>
              <div className="flex flex-col gap-0.5">
                {Z_AXIS_MODES.map((m) => (
                  <button
                    key={m.value}
                    onClick={() => onZAxisModeChange(m.value)}
                    className={cn(
                      'text-left px-2 py-1 rounded text-xs transition-colors',
                      zAxisMode === m.value
                        ? 'bg-primary/10 text-primary font-medium'
                        : 'text-muted-foreground hover:bg-muted/50'
                    )}
                    title={m.description}
                  >
                    {m.label}
                  </button>
                ))}
              </div>
            </>
          )}
        </div>
      )}

      {/* Search */}
      <div className="p-3 border-b border-border">
        <input
          type="text"
          placeholder="Search nodes…"
          value={searchQuery}
          onChange={(e) => onSearchChange(e.target.value)}
          className="w-full text-sm px-2.5 py-1.5 rounded border border-input bg-background focus:outline-none focus:ring-1 focus:ring-ring placeholder:text-muted-foreground"
        />
      </div>

      {/* Categories */}
      <div className="p-3 border-b border-border">
        <p className="text-[10px] font-semibold text-muted-foreground uppercase tracking-wider mb-2">Category</p>
        <div className="flex flex-col gap-0.5">
          <button
            onClick={() => onCategoryChange('all')}
            className={cn(
              'text-left px-2 py-1 rounded text-xs flex items-center gap-2 transition-colors',
              categoryFilter === 'all'
                ? 'bg-muted text-foreground font-medium'
                : 'text-muted-foreground hover:bg-muted/50'
            )}
          >
            <span className="w-2 h-2 rounded-full bg-muted-foreground/40" />
            All
            <span className="ml-auto text-[10px] text-muted-foreground">{nodeCount}</span>
          </button>
          {categories.map((cat) => {
            const color = getCategoryColor(palette, cat);
            const count = nodeTypeCounts[cat] ?? 0;
            return (
              <button
                key={cat}
                onClick={() => onCategoryChange(cat === categoryFilter ? 'all' : cat)}
                className={cn(
                  'text-left px-2 py-1 rounded text-xs flex items-center gap-2 transition-colors',
                  categoryFilter === cat
                    ? 'bg-muted text-foreground font-medium'
                    : 'text-muted-foreground hover:bg-muted/50'
                )}
              >
                <span
                  className="w-2 h-2 rounded-full shrink-0 transition-transform"
                  style={{
                    backgroundColor: color,
                    transform: categoryFilter === cat ? 'scale(1.4)' : 'scale(1)',
                  }}
                />
                <span className="truncate capitalize">{cat}</span>
                {count > 0 && (
                  <span className="ml-auto text-[10px] text-muted-foreground shrink-0">{count}</span>
                )}
              </button>
            );
          })}
        </div>
      </div>

      {/* Filters */}
      <div className="p-3 border-b border-border">
        <p className="text-[10px] font-semibold text-muted-foreground uppercase tracking-wider mb-2">Filters</p>
        <label className="flex items-center gap-2 cursor-pointer group">
          <input
            type="checkbox"
            checked={showOrphansOnly}
            onChange={(e) => onShowOrphansChange(e.target.checked)}
            className="h-3.5 w-3.5 rounded border-input"
          />
          <AlertCircle className="h-3 w-3 text-orange-400" />
          <span className="text-xs text-foreground">Orphans only</span>
          {orphanCount > 0 && (
            <span className="ml-auto text-[10px] bg-orange-400/15 text-orange-400 px-1 rounded">
              {orphanCount}
            </span>
          )}
        </label>
      </div>

      {/* Focus mode banner */}
      {focusNodeId && (
        <div className="p-3 border-b border-border bg-primary/5">
          <div className="flex items-center gap-1.5 mb-1">
            <div className="w-1.5 h-1.5 rounded-full bg-primary animate-pulse" />
            <span className="text-[10px] font-semibold text-primary uppercase tracking-wider">Focus mode</span>
          </div>
          <button
            onClick={onExitFocus}
            className="text-xs flex items-center gap-1 text-muted-foreground hover:text-foreground"
          >
            <ArrowLeft className="h-3 w-3" />Exit focus
          </button>
        </div>
      )}

      {/* Spacer */}
      <div className="flex-1" />

      {/* Graph health */}
      {stats && (
        <div className="p-3 border-t border-border">
          <p className="text-[10px] font-semibold text-muted-foreground uppercase tracking-wider mb-2">Graph health</p>
          <div className="space-y-1">
            <div className="flex justify-between text-xs">
              <span className="text-muted-foreground">Nodes</span>
              <span className="font-medium">{nodeCount}</span>
            </div>
            <div className="flex justify-between text-xs">
              <span className="text-muted-foreground">Edges</span>
              <span className="font-medium">{edgeCount}</span>
            </div>
            {orphanCount > 0 && (
              <div className="flex justify-between text-xs">
                <span className="text-orange-400">Orphans</span>
                <span className="font-medium text-orange-400">{orphanCount}</span>
              </div>
            )}
            {/* Density bar */}
            <div className="mt-2">
              <div className="h-1 rounded-full bg-muted overflow-hidden">
                <div
                  className="h-full rounded-full bg-primary/60 transition-all duration-500"
                  style={{
                    width: nodeCount > 0
                      ? `${Math.min(100, (edgeCount / Math.max(nodeCount, 1)) * 20)}%`
                      : '0%'
                  }}
                />
              </div>
              <p className="text-[10px] text-muted-foreground mt-0.5">
                Density: {nodeCount > 0 ? ((edgeCount / nodeCount) * 100 / 100).toFixed(1) : '0'} edges/node
              </p>
            </div>
          </div>
        </div>
      )}

      {/* Status + actions */}
      <div className="p-3 border-t border-border space-y-2">
        <div className="flex items-center gap-1.5">
          {connected
            ? <Wifi className="h-3 w-3 text-green-500" />
            : <WifiOff className="h-3 w-3 text-muted-foreground" />
          }
          <span className="text-[10px] text-muted-foreground">{connected ? 'Live' : 'Offline'}</span>
        </div>
        <div className="flex gap-1">
          <button
            onClick={onZoomToFit}
            className="flex-1 text-xs px-2 py-1 rounded border border-border hover:bg-muted transition-colors flex items-center justify-center gap-1"
          >
            <ZoomIn className="h-3 w-3" />Fit
          </button>
          <button
            onClick={onRebuild}
            disabled={rebuilding}
            className="flex-1 text-xs px-2 py-1 rounded border border-border hover:bg-muted transition-colors flex items-center justify-center gap-1 disabled:opacity-50"
          >
            <RefreshCw className={cn('h-3 w-3', rebuilding && 'animate-spin')} />
            {rebuilding ? '…' : 'Rebuild'}
          </button>
        </div>
      </div>
    </div>
  );
}
