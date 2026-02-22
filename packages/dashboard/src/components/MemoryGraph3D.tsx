/**
 * MemoryGraph3D — 3D knowledge graph workspace using ForceGraph3D + Three.js.
 *
 * Layout mirrors MemoryGraph.tsx:
 *   [FilterSidebar] | [3D Graph canvas] | [NodePanel (when selected)]
 *                      [TimelineScrubber]
 *
 * Reuses all existing sub-components (sidebar, panel, context menu, etc.)
 * from graph/* — only the rendering layer is different.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import ForceGraph3DLib from 'react-force-graph-3d';
const ForceGraph3D = ForceGraph3DLib as any;
import * as THREE from 'three';
import { toast } from 'sonner';

import { CreateMemoryDialog } from '@/components/memory/CreateMemoryDialog';

import { useGraphData } from './graph/useGraphData';
import { useGraphInteraction3D } from './graph/useGraphInteraction3d';
import { COLORS_DARK, COLORS_LIGHT } from './graph/graphColors';
import {
  makeNodeThreeObject,
  makeLinkColor3D,
  makeLinkWidth3D,
  makeLinkParticles,
  makeLinkParticleWidth,
  computeNodeFz,
  updateLabelVisibility,
} from './graph/graphRenderers3d';
import type { Render3DRefs } from './graph/graphRenderers3d';
import { GraphFilterSidebar } from './graph/GraphFilterSidebar';
import { GraphNodePanel } from './graph/GraphNodePanel';
import { GraphTimelineScrubber } from './graph/GraphTimelineScrubber';
import { GraphContextMenu } from './graph/GraphContextMenu';
import { GraphLinkDialog } from './graph/GraphLinkDialog';

import type { GraphNode, GraphViewMode, ContextMenuState, ZAxisMode } from './graph/types';
import type { ColorPalette } from './graph/graphColors';

interface MemoryGraph3DProps {
  agentId: string;
  hideViewMode?: boolean;
  /** Callback to switch back to 2D mode */
  onSwitchTo2D?: () => void;
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

// Resizable split pane (same as 2D version)
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

export function MemoryGraph3D({ agentId, hideViewMode, onSwitchTo2D }: MemoryGraph3DProps) {
  const isDark = useDarkMode();
  const colors = isDark ? COLORS_DARK : COLORS_LIGHT;
  const colorsRef = useRef<ColorPalette>(colors);
  colorsRef.current = colors;
  const isDarkRef = useRef(isDark);
  isDarkRef.current = isDark;

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
  const [zAxisMode, setZAxisMode] = useState<ZAxisMode>('force');

  const wrapperRef = useRef<HTMLDivElement>(null);
  const hasZoomedRef = useRef(false);

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
    flyToNode,
    zoomToFit,
  } = useGraphInteraction3D({
    degreeMap,
    orphanSet,
    showOrphansOnly,
    onNodeRightClick: (node, x, y) => setContextMenu({ x, y, node }),
    onBackgroundRightClick: (x, y, gx, gy) =>
      setContextMenu({ x, y, node: null, graphX: gx, graphY: gy }),
  });

  // Full refs including colors and theme
  const fullRefs: Render3DRefs = {
    ...renderRefs,
    colorsRef,
    isDarkRef,
  };

  // Sync degree/orphan refs
  renderRefs.degreeMapRef.current = degreeMap;
  renderRefs.orphanSetRef.current = orphanSet;
  renderRefs.showOrphansRef.current = showOrphansOnly;

  // ── Compute time range for Z-axis "time" mode ────────────────────────────
  const timeRange = useMemo(() => {
    if (!rawData) return undefined;
    let min = Infinity;
    let max = -Infinity;
    for (const n of rawData.nodes) {
      if (n.createdAt) {
        if (n.createdAt < min) min = n.createdAt;
        if (n.createdAt > max) max = n.createdAt;
      }
    }
    if (!isFinite(min)) return undefined;
    return { min, max };
  }, [rawData]);

  // ── Apply Z-axis constraints to graph data ────────────────────────────────
  const graphData = useMemo(() => {
    if (!filteredData) return { nodes: [], links: [] };

    const nodes = filteredData.nodes.map((n) => ({
      ...n,
      fz: computeNodeFz(n, zAxisMode, timeRange),
    }));

    return {
      nodes,
      links: filteredData.edges.map((e) => ({
        source: e.source,
        target: e.target,
        type: e.type,
        label: e.label,
      })),
    };
  }, [filteredData, zAxisMode, timeRange]);

  // ── Stable 3D rendering callbacks ────────────────────────────────────────
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const nodeThreeObjectFn = useMemo(() => makeNodeThreeObject(fullRefs), []);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const linkColorFn = useMemo(() => makeLinkColor3D(fullRefs), []);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const linkWidthFn = useMemo(() => makeLinkWidth3D(renderRefs), []);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const linkParticlesFn = useMemo(() => makeLinkParticles(renderRefs), []);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const linkParticleWidthFn = useMemo(() => makeLinkParticleWidth(renderRefs), []);

  // ── Connections for selected node ─────────────────────────────────────────
  const connections = useMemo(() => {
    if (!selectedNode) return [];
    return Array.from(neighborMap.get(selectedNode.id) ?? [])
      .map((id) => filteredData?.nodes.find((n) => n.id === id))
      .filter((n): n is GraphNode => !!n);
  }, [selectedNode, neighborMap, filteredData]);

  // ── Zoom to fit on first load ─────────────────────────────────────────────
  useEffect(() => {
    if (graphData.nodes.length > 0 && !hasZoomedRef.current && graphRef.current) {
      setTimeout(() => {
        graphRef.current?.zoomToFit(600, 60);
        hasZoomedRef.current = true;
      }, 300);
    }
  }, [graphData.nodes.length]);

  useEffect(() => { hasZoomedRef.current = false; }, [viewMode]);

  // ── Scene setup: lighting and background ──────────────────────────────────
  const sceneConfigured = useRef(false);
  useEffect(() => {
    if (!graphRef.current || sceneConfigured.current) return;
    const scene = graphRef.current.scene?.();
    if (!scene) return;

    // Ambient light for consistent base illumination
    const ambient = new THREE.AmbientLight(0xffffff, 0.6);
    scene.add(ambient);

    // Directional light from above-right for depth perception
    const directional = new THREE.DirectionalLight(0xffffff, 0.8);
    directional.position.set(50, 100, 50);
    scene.add(directional);

    sceneConfigured.current = true;
  }, [graphData.nodes.length]);

  // ── Per-frame label distance fade ──────────────────────────────────────
  useEffect(() => {
    let frameId: number;
    const tick = () => {
      updateLabelVisibility(graphRef, renderRefs);
      frameId = requestAnimationFrame(tick);
    };
    frameId = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frameId);
  }, []); // stable refs — never recreated

  // ── Refresh node objects when theme changes (label bg/text colors) ────
  const prevDarkRef = useRef(isDark);
  useEffect(() => {
    if (prevDarkRef.current !== isDark && graphRef.current) {
      prevDarkRef.current = isDark;
      // Force ForceGraph3D to rebuild node three-objects
      graphRef.current.refresh();
    }
  }, [isDark]);

  // ── Resize observer ──────────────────────────────────────────────────────
  useEffect(() => {
    if (!wrapperRef.current) return;
    const ro = new ResizeObserver((entries) => {
      for (const e of entries) {
        setDimensions({
          width: Math.floor(e.contentRect.width),
          height: Math.floor(e.contentRect.height),
        });
      }
    });
    ro.observe(wrapperRef.current);
    return () => ro.disconnect();
  }, []);

  // ── Event handlers ────────────────────────────────────────────────────────
  const handleFocusNode = useCallback((node: GraphNode) => {
    enterFocusMode(node.id, 2);
    setSelectedNode(node);
    flyToNode(node);
  }, [enterFocusMode, setSelectedNode, flyToNode]);

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

  // Keyboard: Escape to deselect / exit context menu
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

  // Background color for the 3D scene — match the site theme exactly
  const bgColor = isDark ? '#000000' : '#ffffff';

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
          // 3D-specific props
          is3D={true}
          zAxisMode={zAxisMode}
          onZAxisModeChange={setZAxisMode}
          onSwitchDimension={onSwitchTo2D}
        />

        {/* ── Center: 3D graph canvas ── */}
        <div className="flex-1 min-w-0 flex flex-col overflow-hidden">
          <div ref={wrapperRef} className="flex-1 min-h-0 relative">
            {filteredData && filteredData.nodes.length > 0 ? (
              <ForceGraph3D
                ref={graphRef}
                width={dimensions.width}
                height={dimensions.height}
                graphData={graphData}
                nodeId="id"
                linkSource="source"
                linkTarget="target"
                backgroundColor={bgColor}
                nodeThreeObject={nodeThreeObjectFn}
                nodeThreeObjectExtend={false}
                linkColor={linkColorFn}
                linkWidth={linkWidthFn}
                linkOpacity={0.6}
                linkDirectionalParticles={linkParticlesFn}
                linkDirectionalParticleWidth={linkParticleWidthFn}
                linkDirectionalParticleSpeed={0.005}
                onNodeClick={handleNodeClick}
                onNodeHover={handleNodeHover}
                onBackgroundClick={handleBackgroundClick}
                onNodeRightClick={handleNodeRightClick}
                onBackgroundRightClick={handleBackgroundRightClick}
                cooldownTicks={120}
                d3AlphaDecay={0.02}
                d3VelocityDecay={0.28}
                enableNodeDrag={true}
                controlType="orbit"
                showNavInfo={false}
              />
            ) : (
              <div className="flex items-center justify-center h-full text-muted-foreground text-sm">
                {rawData === null
                  ? 'Loading 3D graph…'
                  : 'No nodes match the current filters'}
              </div>
            )}

            {/* 3D mode indicator badge */}
            <div className="absolute top-3 right-3 px-2 py-1 rounded bg-primary/10 text-primary text-xs font-medium backdrop-blur-sm border border-primary/20">
              3D
            </div>
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
                onSelectNode={(n) => { setSelectedNode(n); flyToNode(n); }}
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
