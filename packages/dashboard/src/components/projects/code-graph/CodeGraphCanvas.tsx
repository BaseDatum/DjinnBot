/**
 * CodeGraphCanvas — interactive Sigma.js force-directed graph of the
 * project's code knowledge graph.
 *
 * Features:
 *  - ForceAtlas2 physics layout (web-worker based)
 *  - Community-coloured nodes
 *  - Node type + edge type filtering
 *  - Click-to-select with neighbour highlighting
 *  - Zoom / pan / focus / reset controls
 *  - Layout pause/resume
 */

import { useEffect, useCallback, useState, useMemo } from 'react';
import {
  ZoomIn, ZoomOut, Maximize2, Focus, RotateCcw,
  Play, Pause, Filter,
} from 'lucide-react';
import { useSigma } from './useSigma';
import { apiGraphToGraphology, filterByLabels, type APIGraphData } from './graph-adapter';
import {
  DEFAULT_VISIBLE_LABELS,
  DEFAULT_VISIBLE_EDGES,
  NODE_COLORS,
  EDGE_STYLES,
} from './constants';

interface Props {
  graphData: APIGraphData;
  onNodeSelect?: (node: { id: string; name: string; label: string; filePath: string; startLine?: number } | null) => void;
}

export function CodeGraphCanvas({ graphData, onNodeSelect }: Props) {
  // Filter state
  const [visibleLabels, setVisibleLabels] = useState<Set<string>>(new Set(DEFAULT_VISIBLE_LABELS));
  const [visibleEdges, setVisibleEdges] = useState<Set<string>>(new Set(DEFAULT_VISIBLE_EDGES));
  const [showFilters, setShowFilters] = useState(false);

  const handleNodeClick = useCallback((nodeId: string) => {
    const n = graphData.nodes.find(n => n.id === nodeId);
    if (n && onNodeSelect) {
      onNodeSelect({ id: n.id, name: n.name, label: n.label, filePath: n.filePath, startLine: n.startLine });
    }
  }, [graphData, onNodeSelect]);

  const handleStageClick = useCallback(() => {
    onNodeSelect?.(null);
  }, [onNodeSelect]);

  const {
    containerRef, sigmaRef, graphRef,
    setGraph, zoomIn, zoomOut, resetZoom, focusNode,
    isLayoutRunning, startLayout, stopLayout,
    selectedNode, setSelectedNode,
  } = useSigma({
    onNodeClick: handleNodeClick,
    onStageClick: handleStageClick,
    visibleEdgeTypes: visibleEdges,
  });

  // Build + set the graphology graph when data changes
  useEffect(() => {
    if (!graphData || graphData.nodes.length === 0) return;
    const g = apiGraphToGraphology(graphData);
    setGraph(g);
  }, [graphData, setGraph]);

  // Apply label filters
  useEffect(() => {
    const g = graphRef.current;
    if (!g || g.order === 0) return;
    filterByLabels(g, visibleLabels);
    sigmaRef.current?.refresh();
  }, [visibleLabels, graphRef, sigmaRef]);

  // Stats
  const stats = useMemo(() => {
    const labelCounts: Record<string, number> = {};
    for (const n of graphData.nodes) {
      labelCounts[n.label] = (labelCounts[n.label] || 0) + 1;
    }
    return { total: graphData.nodes.length, edges: graphData.edges.length, labelCounts };
  }, [graphData]);

  const toggleLabel = (label: string) => {
    setVisibleLabels(prev => {
      const next = new Set(prev);
      next.has(label) ? next.delete(label) : next.add(label);
      return next;
    });
  };

  const toggleEdge = (edgeType: string) => {
    setVisibleEdges(prev => {
      const next = new Set(prev);
      next.has(edgeType) ? next.delete(edgeType) : next.add(edgeType);
      return next;
    });
  };

  // Focus on selected
  const handleFocus = useCallback(() => {
    if (selectedNode) focusNode(selectedNode);
  }, [selectedNode, focusNode]);

  const handleClear = useCallback(() => {
    setSelectedNode(null);
    resetZoom();
    onNodeSelect?.(null);
  }, [setSelectedNode, resetZoom, onNodeSelect]);

  return (
    <div className="relative w-full h-full min-h-[500px] bg-background rounded-lg border overflow-hidden">
      {/* Sigma container */}
      <div
        ref={containerRef}
        className="w-full h-full cursor-grab active:cursor-grabbing"
        style={{ minHeight: 500 }}
      />

      {/* Hovered node tooltip */}
      {selectedNode && (
        <div className="absolute top-3 left-1/2 -translate-x-1/2 flex items-center gap-2 px-3 py-1.5 bg-primary/10 border border-primary/30 rounded-lg backdrop-blur-sm z-20 text-xs">
          <div className="w-1.5 h-1.5 bg-primary rounded-full animate-pulse" />
          <span className="font-mono font-medium">
            {graphData.nodes.find(n => n.id === selectedNode)?.name || selectedNode}
          </span>
          <button onClick={handleClear} className="ml-1 px-1.5 py-0.5 text-[10px] text-muted-foreground hover:text-foreground hover:bg-muted rounded transition-colors">
            Clear
          </button>
        </div>
      )}

      {/* Controls — bottom right */}
      <div className="absolute bottom-3 right-3 flex flex-col gap-1 z-10">
        <ControlButton onClick={zoomIn} title="Zoom In"><ZoomIn className="w-3.5 h-3.5" /></ControlButton>
        <ControlButton onClick={zoomOut} title="Zoom Out"><ZoomOut className="w-3.5 h-3.5" /></ControlButton>
        <ControlButton onClick={resetZoom} title="Fit to Screen"><Maximize2 className="w-3.5 h-3.5" /></ControlButton>

        <div className="h-px bg-border my-0.5" />

        {selectedNode && (
          <ControlButton onClick={handleFocus} title="Focus Selected" accent>
            <Focus className="w-3.5 h-3.5" />
          </ControlButton>
        )}
        {selectedNode && (
          <ControlButton onClick={handleClear} title="Clear Selection">
            <RotateCcw className="w-3.5 h-3.5" />
          </ControlButton>
        )}

        <div className="h-px bg-border my-0.5" />

        <ControlButton
          onClick={isLayoutRunning ? stopLayout : startLayout}
          title={isLayoutRunning ? 'Stop Layout' : 'Run Layout'}
          active={isLayoutRunning}
        >
          {isLayoutRunning ? <Pause className="w-3.5 h-3.5" /> : <Play className="w-3.5 h-3.5" />}
        </ControlButton>
      </div>

      {/* Filter toggle — top right */}
      <div className="absolute top-3 right-3 z-20">
        <ControlButton onClick={() => setShowFilters(p => !p)} title="Filters" active={showFilters}>
          <Filter className="w-3.5 h-3.5" />
        </ControlButton>
      </div>

      {/* Filter panel */}
      {showFilters && (
        <div className="absolute top-12 right-3 z-20 w-56 max-h-[70vh] overflow-y-auto rounded-lg border bg-background/95 backdrop-blur-sm p-3 space-y-3 text-xs">
          {/* Node types */}
          <div>
            <div className="font-medium mb-1.5 text-muted-foreground uppercase tracking-wider text-[10px]">Node Types</div>
            <div className="space-y-0.5">
              {Object.entries(stats.labelCounts)
                .sort(([,a],[,b]) => b - a)
                .map(([label, count]) => (
                  <label key={label} className="flex items-center gap-2 py-0.5 cursor-pointer hover:bg-muted/50 rounded px-1">
                    <input
                      type="checkbox"
                      checked={visibleLabels.has(label)}
                      onChange={() => toggleLabel(label)}
                      className="rounded border-muted-foreground/40"
                    />
                    <span className="w-2 h-2 rounded-full shrink-0" style={{ backgroundColor: NODE_COLORS[label] || '#9ca3af' }} />
                    <span className="truncate">{label}</span>
                    <span className="ml-auto text-muted-foreground">{count}</span>
                  </label>
                ))
              }
            </div>
          </div>

          {/* Edge types */}
          <div>
            <div className="font-medium mb-1.5 text-muted-foreground uppercase tracking-wider text-[10px]">Edge Types</div>
            <div className="space-y-0.5">
              {Object.entries(EDGE_STYLES).map(([type, style]) => (
                <label key={type} className="flex items-center gap-2 py-0.5 cursor-pointer hover:bg-muted/50 rounded px-1">
                  <input
                    type="checkbox"
                    checked={visibleEdges.has(type)}
                    onChange={() => toggleEdge(type)}
                    className="rounded border-muted-foreground/40"
                  />
                  <span className="w-3 h-0.5 shrink-0 rounded" style={{ backgroundColor: style.color }} />
                  <span className="truncate">{style.label}</span>
                </label>
              ))}
            </div>
          </div>
        </div>
      )}

      {/* Layout running indicator */}
      {isLayoutRunning && (
        <div className="absolute bottom-3 left-1/2 -translate-x-1/2 flex items-center gap-2 px-3 py-1 bg-emerald-500/10 border border-emerald-500/30 rounded-full backdrop-blur-sm z-10 text-xs">
          <div className="w-1.5 h-1.5 bg-emerald-400 rounded-full animate-ping" />
          <span className="text-emerald-400 font-medium">Layout optimising...</span>
        </div>
      )}

      {/* Stats bar — bottom left */}
      <div className="absolute bottom-3 left-3 z-10 text-[10px] text-muted-foreground bg-background/80 backdrop-blur-sm rounded px-2 py-1 border">
        {stats.total} nodes &middot; {stats.edges} edges &middot; {graphData.communities.length} communities &middot; {graphData.processes.length} flows
      </div>
    </div>
  );
}

// ── Small control button ───────────────────────────────────────────────────

function ControlButton({
  onClick, title, children, accent, active,
}: {
  onClick: () => void;
  title: string;
  children: React.ReactNode;
  accent?: boolean;
  active?: boolean;
}) {
  return (
    <button
      onClick={onClick}
      title={title}
      className={`
        w-8 h-8 flex items-center justify-center border rounded-md transition-colors
        ${active
          ? 'bg-primary border-primary text-primary-foreground'
          : accent
            ? 'bg-primary/10 border-primary/30 text-primary hover:bg-primary/20'
            : 'bg-background border-border text-muted-foreground hover:bg-muted hover:text-foreground'
        }
      `}
    >
      {children}
    </button>
  );
}
