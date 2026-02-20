/**
 * MemoryGraph — orchestration shell for the knowledge graph workspace.
 *
 * Layout:
 *   [FilterSidebar] | [Graph canvas] | [NodePanel (when selected)]
 *                      [TimelineScrubber]
 *
 * All heavy logic lives in graph/* sub-modules.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import ForceGraph2DLib from 'react-force-graph-2d';
// Cast to any to work around generic type inference issues with linkCanvasObject prop
const ForceGraph2D = ForceGraph2DLib as any;
import { toast } from 'sonner';

import { CreateMemoryDialog } from '@/components/memory/CreateMemoryDialog';

import { useGraphData } from './graph/useGraphData';
import { useGraphInteraction } from './graph/useGraphInteraction';
import { COLORS_DARK, COLORS_LIGHT } from './graph/graphColors';
import {
  makeNodeCanvasObject,
  makeNodePointerAreaPaint,
  makeLinkColor,
  makeLinkWidth,
  makeLinkCanvasObject,
} from './graph/graphRenderers';
import { GraphFilterSidebar } from './graph/GraphFilterSidebar';
import { GraphNodePanel } from './graph/GraphNodePanel';
import { GraphTimelineScrubber } from './graph/GraphTimelineScrubber';
import { GraphContextMenu } from './graph/GraphContextMenu';
import { GraphLinkDialog } from './graph/GraphLinkDialog';

import type { GraphNode, GraphViewMode, ContextMenuState } from './graph/types';
import type { ColorPalette } from './graph/graphColors';
import type { RenderRefs } from './graph/graphRenderers';

interface MemoryGraphProps {
  agentId: string;
  /** Hide the personal/shared/combined view-mode selector (e.g. on the shared memory page). */
  hideViewMode?: boolean;
}

function useDarkMode() {
  const [isDark, setIsDark] = useState(() => document.documentElement.classList.contains('dark'));
  useEffect(() => {
    const obs = new MutationObserver(() =>
      setIsDark(document.documentElement.classList.contains('dark'))
    );
    obs.observe(document.documentElement, { attributes: true, attributeFilter: ['class'] });
    return () => obs.disconnect();
  }, []);
  return isDark;
}

// Resizable split pane.
// `invert` flips the drag direction for panels anchored to the right edge.
function useResizableSplit(initialPx: number, minPx: number, maxPx: number, invert = false) {
  const [width, setWidth] = useState(initialPx);
  const dragging = useRef(false);
  const startX = useRef(0);
  const startW = useRef(0);

  const onPointerDown = useCallback((e: React.PointerEvent) => {
    e.preventDefault();
    dragging.current = true;
    startX.current = e.clientX;
    startW.current = width;
    (e.target as HTMLElement).setPointerCapture(e.pointerId);
  }, [width]);

  const onPointerMove = useCallback((e: React.PointerEvent) => {
    if (!dragging.current) return;
    const delta = e.clientX - startX.current;
    const next = Math.max(minPx, Math.min(maxPx, startW.current + (invert ? -delta : delta)));
    setWidth(next);
  }, [minPx, maxPx, invert]);

  const onPointerUp = useCallback((e: React.PointerEvent) => {
    dragging.current = false;
    (e.target as HTMLElement).releasePointerCapture(e.pointerId);
  }, []);

  return { width, setWidth, onPointerDown, onPointerMove, onPointerUp };
}

export function MemoryGraph({ agentId, hideViewMode }: MemoryGraphProps) {
  const isDark = useDarkMode();
  const colors = isDark ? COLORS_DARK : COLORS_LIGHT;
  const colorsRef = useRef<ColorPalette>(colors);
  colorsRef.current = colors;

  // ── UI state ──────────────────────────────────────────────────────────────
  const [viewMode, setViewMode] = useState<GraphViewMode>('personal');
  const [searchQuery, setSearchQuery] = useState('');
  const [categoryFilter, setCategoryFilter] = useState('all');
  const [showOrphansOnly, setShowOrphansOnly] = useState(false);
  const [timelineValue, setTimelineValue] = useState<number | null>(null);
  const [contextMenu, setContextMenu] = useState<ContextMenuState | null>(null);
  const [linkTarget, setLinkTarget] = useState<GraphNode | null>(null);
  const [createOpen, setCreateOpen] = useState(false);
  const [dimensions, setDimensions] = useState({ width: 800, height: 600 });

  const wrapperRef = useRef<HTMLDivElement>(null);
  const hasZoomedRef = useRef(false);

  // Resizable right panel — invert drag direction (left = wider)
  const rightPanel = useResizableSplit(340, 240, 500, true);

  // ── Data ──────────────────────────────────────────────────────────────────
  const {
    rawData,
    filteredData,
    categories,
    orphanSet,
    degreeMap,
    neighborMap,
    connected,
    rebuilding,
    triggerRebuild,
    refetch,
    enterFocusMode,
    exitFocusMode,
    focusNodeId,
  } = useGraphData({
    agentId,
    viewMode,
    searchQuery,
    categoryFilter,
    showOrphansOnly,
    timelineMax: timelineValue,
  });

  // ── Interaction ───────────────────────────────────────────────────────────
  const {
    graphRef,
    selectedNode,
    setSelectedNode,
    handleNodeClick,
    handleNodeHover,
    handleBackgroundClick,
    handleNodeRightClick,
    handleBackgroundRightClick,
    renderRefs,
    zoomToNode,
    zoomToFit,
  } = useGraphInteraction({
    degreeMap,
    orphanSet,
    showOrphansOnly,
    onNodeRightClick: (node, x, y) => setContextMenu({ x, y, node }),
    onBackgroundRightClick: (x, y, gx, gy) =>
      setContextMenu({ x, y, node: null, graphX: gx, graphY: gy }),
  });

  // Keep refs in sync with latest palette
  const fullRefs: RenderRefs = {
    ...renderRefs,
    colorsRef,
  };

  // Sync degree/orphan refs
  renderRefs.degreeMapRef.current = degreeMap;
  renderRefs.orphanSetRef.current = orphanSet;
  renderRefs.showOrphansRef.current = showOrphansOnly;

  // ── Stable canvas callbacks (memoized once — read from refs) ─────────────
  // IMPORTANT: every function prop passed to ForceGraph2D MUST be a stable
  // reference.  If a prop identity changes the library tears down and rebuilds
  // its internal shadow canvas, resetting hover/pointer tracking.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const nodeCanvasObject = useMemo(() => makeNodeCanvasObject(fullRefs), []);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const nodePointerAreaPaint = useMemo(() => makeNodePointerAreaPaint(renderRefs), []);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const linkColorFn = useMemo(() => makeLinkColor(fullRefs), []);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const linkWidthFn = useMemo(() => makeLinkWidth(renderRefs), []);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const linkCanvasObjectFn = useMemo(() => makeLinkCanvasObject(fullRefs), []);
  // Stable mode callbacks — must NOT be inline arrows or ForceGraph rebuilds
  // its shadow canvas on every render.
  const nodeCanvasObjectMode = useCallback(() => 'replace' as const, []);
  const linkCanvasObjectMode = useCallback(() => 'replace' as const, []);

  // ── Graph data for ForceGraph ──────────────────────────────────────────────
  const graphData = useMemo(() => {
    if (!filteredData) return { nodes: [], links: [] };
    return {
      nodes: filteredData.nodes,
      links: filteredData.edges.map((e) => ({
        source: e.source,
        target: e.target,
        type: e.type,
        label: e.label,
      })),
    };
  }, [filteredData]);

  // ── Connections for selected node ─────────────────────────────────────────
  const connections = useMemo(() => {
    if (!selectedNode) return [];
    return Array.from(neighborMap.get(selectedNode.id) ?? [])
      .map((id) => filteredData?.nodes.find((n) => n.id === id))
      .filter((n): n is GraphNode => !!n);
  }, [selectedNode, neighborMap, filteredData]);

  // ── Zoom to fit on first data load ────────────────────────────────────────
  useEffect(() => {
    if (graphData.nodes.length > 0 && !hasZoomedRef.current && graphRef.current) {
      setTimeout(() => { graphRef.current?.zoomToFit(600, 60); hasZoomedRef.current = true; }, 150);
    }
  }, [graphData.nodes.length]);

  useEffect(() => { hasZoomedRef.current = false; }, [viewMode]);

  // ── Resize observer for canvas dimensions ────────────────────────────────
  useEffect(() => {
    if (!wrapperRef.current) return;
    const ro = new ResizeObserver((entries) => {
      for (const e of entries) {
        setDimensions({ width: Math.floor(e.contentRect.width), height: Math.floor(e.contentRect.height) });
      }
    });
    ro.observe(wrapperRef.current);
    return () => ro.disconnect();
  }, []);

  // ── Event handlers ────────────────────────────────────────────────────────
  const handleFocusNode = useCallback((node: GraphNode) => {
    enterFocusMode(node.id, 2);
    setSelectedNode(node);
    zoomToNode(node);
  }, [enterFocusMode, setSelectedNode, zoomToNode]);

  const handleDeleteNode = useCallback((node: GraphNode) => {
    setSelectedNode(node);
  }, [setSelectedNode]);

  const handleCopyId = useCallback((id: string) => {
    navigator.clipboard.writeText(id).then(() => toast.success('Copied to clipboard'));
  }, []);

  const handleNodeDeleted = useCallback(async () => {
    setSelectedNode(null);
    await refetch();
    toast.success('Memory deleted');
  }, [refetch, setSelectedNode]);

  const handleLinked = useCallback(async () => {
    setLinkTarget(null);
    await triggerRebuild();
    toast.success('Link created — graph rebuilt');
  }, [triggerRebuild]);

  const handleNodeCreated = useCallback(async () => {
    await refetch();
    toast.success('Memory created');
  }, [refetch]);

  // Keyboard shortcut: Escape to deselect / exit context menu
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        if (contextMenu) { setContextMenu(null); return; }
        if (selectedNode) setSelectedNode(null);
      }
    };
    document.addEventListener('keydown', handler);
    return () => document.removeEventListener('keydown', handler);
  }, [contextMenu, selectedNode, setSelectedNode]);

  return (
    <div
      className="flex flex-col border rounded-lg overflow-hidden bg-background"
      style={{ height: 'calc(100vh - 220px)', userSelect: 'none' }}
    >
      <div className="flex flex-1 min-h-0 overflow-hidden">
        {/* ── Left: filter sidebar ── */}
        <GraphFilterSidebar
          viewMode={viewMode}
          onViewModeChange={(m) => { setViewMode(m); setSelectedNode(null); }}
          hideViewMode={hideViewMode}
          categories={categories}
          categoryFilter={categoryFilter}
          onCategoryChange={setCategoryFilter}
          searchQuery={searchQuery}
          onSearchChange={setSearchQuery}
          showOrphansOnly={showOrphansOnly}
          onShowOrphansChange={setShowOrphansOnly}
          orphanCount={orphanSet.size}
          nodeCount={filteredData?.nodes.length ?? 0}
          edgeCount={filteredData?.edges.length ?? 0}
          stats={rawData?.stats ?? null}
          connected={connected}
          rebuilding={rebuilding}
          onRebuild={triggerRebuild}
          onZoomToFit={zoomToFit}
          focusNodeId={focusNodeId}
          onExitFocus={exitFocusMode}
          nodeTypeCounts={rawData?.stats.nodeTypeCounts ?? {}}
        />

        {/* ── Center: graph canvas ── */}
        <div className="flex-1 min-w-0 flex flex-col overflow-hidden">
          <div ref={wrapperRef} className="flex-1 min-h-0 relative">
            {filteredData && filteredData.nodes.length > 0 ? (
              <ForceGraph2D
                ref={graphRef}
                width={dimensions.width}
                height={dimensions.height}
                graphData={graphData}
                nodeId="id"
                linkSource="source"
                linkTarget="target"
                backgroundColor="transparent"
                nodeRelSize={4}
                autoPauseRedraw={false}
                nodeCanvasObject={nodeCanvasObject}
                nodeCanvasObjectMode={nodeCanvasObjectMode}
                nodePointerAreaPaint={nodePointerAreaPaint}
                linkColor={linkColorFn}
                linkWidth={linkWidthFn}
                linkCanvasObject={linkCanvasObjectFn}
                linkCanvasObjectMode={linkCanvasObjectMode}
                onNodeClick={handleNodeClick}
                onNodeHover={handleNodeHover}
                onBackgroundClick={handleBackgroundClick}
                onNodeRightClick={handleNodeRightClick}
                onBackgroundRightClick={handleBackgroundRightClick}
                cooldownTicks={120}
                d3AlphaDecay={0.02}
                d3VelocityDecay={0.28}
                enableNodeDrag={true}
              />
            ) : (
              <div className="flex items-center justify-center h-full text-muted-foreground text-sm">
                {rawData === null
                  ? 'Loading graph…'
                  : 'No nodes match the current filters'}
              </div>
            )}
          </div>

          {/* Timeline scrubber */}
          <GraphTimelineScrubber
            nodes={rawData?.nodes ?? []}
            value={timelineValue}
            onChange={setTimelineValue}
          />
        </div>

        {/* ── Right: node detail panel ── */}
        {selectedNode && (
          <>
            {/* Drag handle */}
            <div
              onPointerDown={rightPanel.onPointerDown}
              onPointerMove={rightPanel.onPointerMove}
              onPointerUp={rightPanel.onPointerUp}
              className="shrink-0 flex items-center justify-center bg-border hover:bg-primary/30 active:bg-primary/50 transition-colors cursor-col-resize"
              style={{ width: 6, touchAction: 'none' }}
            />
            <div className="shrink-0 overflow-hidden" style={{ width: rightPanel.width }}>
              <GraphNodePanel
                agentId={agentId}
                node={selectedNode}
                connections={connections}
                degreeMap={degreeMap}
                onClose={() => setSelectedNode(null)}
                onSelectNode={(n) => { setSelectedNode(n); zoomToNode(n); }}
                onLinkNode={(n) => setLinkTarget(n)}
                onDeleted={handleNodeDeleted}
              />
            </div>
          </>
        )}
      </div>

      {/* ── Context menu ── */}
      {contextMenu && (
        <GraphContextMenu
          x={contextMenu.x}
          y={contextMenu.y}
          node={contextMenu.node}
          onClose={() => setContextMenu(null)}
          onFocusNode={handleFocusNode}
          onLinkNode={(n) => { setLinkTarget(n); setContextMenu(null); }}
          onDeleteNode={handleDeleteNode}
          onCreateNode={() => { setCreateOpen(true); setContextMenu(null); }}
          onRebuild={() => { triggerRebuild(); setContextMenu(null); }}
          onZoomToFit={() => { zoomToFit(); setContextMenu(null); }}
          onCopyId={handleCopyId}
        />
      )}

      {/* ── Link dialog ── */}
      {linkTarget && (
        <GraphLinkDialog
          agentId={agentId}
          sourceNode={linkTarget}
          allNodes={rawData?.nodes ?? []}
          onClose={() => setLinkTarget(null)}
          onLinked={handleLinked}
        />
      )}

      {/* ── Create memory dialog ── */}
      <CreateMemoryDialog
        agentId={agentId}
        open={createOpen}
        onClose={() => setCreateOpen(false)}
        onCreated={handleNodeCreated}
      />
    </div>
  );
}
