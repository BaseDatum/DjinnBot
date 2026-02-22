/**
 * Interaction state for the 3D graph.
 *
 * Similar to useGraphInteraction.ts but tailored for ForceGraph3D:
 *  - No shadow-canvas workarounds (Three.js raycasting is reliable)
 *  - Camera positioning via cameraPosition() instead of centerAt/zoom
 *  - Orbit controls for 3D navigation
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import type { GraphNode, ForceLink } from './types';
import { syncHighlights3D } from './graphRenderers3d';
import type { Render3DRefs } from './graphRenderers3d';
import type { ForceGraph3DMethods } from 'react-force-graph-3d';

export interface UseGraphInteraction3DReturn {
  graphRef: React.MutableRefObject<ForceGraph3DMethods | null>;
  selectedNode: GraphNode | null;
  setSelectedNode: (node: GraphNode | null) => void;
  handleNodeClick: (node: any, event: MouseEvent) => void;
  handleNodeHover: (node: any | null) => void;
  handleBackgroundClick: (event: MouseEvent) => void;
  handleNodeRightClick: (node: any, event: MouseEvent) => void;
  handleBackgroundRightClick: (event: MouseEvent) => void;
  renderRefs: Omit<Render3DRefs, 'colorsRef'>;
  flyToNode: (node: GraphNode) => void;
  zoomToFit: () => void;
}

interface Options {
  onNodeRightClick?: (node: GraphNode, screenX: number, screenY: number) => void;
  onBackgroundRightClick?: (screenX: number, screenY: number, graphX: number, graphY: number) => void;
  degreeMap: Map<string, number>;
  orphanSet: Set<string>;
  showOrphansOnly: boolean;
}

export function useGraphInteraction3D({
  onNodeRightClick,
  onBackgroundRightClick,
  degreeMap,
  orphanSet,
  showOrphansOnly,
}: Options): UseGraphInteraction3DReturn {
  const graphRef = useRef<ForceGraph3DMethods | null>(null);
  const [selectedNode, setSelectedNodeState] = useState<GraphNode | null>(null);

  // Stable refs for rendering callbacks
  const hoveredNodeRef = useRef<GraphNode | null>(null);
  const selectedNodeRef = useRef<GraphNode | null>(null);
  const highlightNodesRef = useRef<Set<string>>(new Set());
  const highlightLinksRef = useRef<Set<string>>(new Set());
  const degreeMapRef = useRef<Map<string, number>>(degreeMap);
  const orphanSetRef = useRef<Set<string>>(orphanSet);
  const showOrphansRef = useRef(showOrphansOnly);

  // Keep refs in sync
  degreeMapRef.current = degreeMap;
  orphanSetRef.current = orphanSet;
  showOrphansRef.current = showOrphansOnly;

  const getLinks = useCallback((): ForceLink[] => {
    return graphRef.current?.graphData?.()?.links ?? [];
  }, []);

  const rebuildHighlights = useCallback(() => {
    syncHighlights3D(
      { hoveredNodeRef, selectedNodeRef, highlightNodesRef, highlightLinksRef },
      getLinks,
    );
  }, [getLinks]);

  // Sync selection to ref
  useEffect(() => {
    selectedNodeRef.current = selectedNode;
    rebuildHighlights();
  }, [selectedNode, rebuildHighlights]);

  const setSelectedNode = useCallback((node: GraphNode | null) => {
    setSelectedNodeState(node);
  }, []);

  // ── Fly camera to orbit a node ───────────────────────────────────────────
  const flyToNode = useCallback((node: GraphNode) => {
    if (!graphRef.current || node.x == null || node.y == null) return;
    const distance = 80;
    const nodePos = { x: node.x, y: node.y, z: node.z ?? 0 };
    // Position camera at a distance, looking at the node
    graphRef.current.cameraPosition(
      {
        x: nodePos.x,
        y: nodePos.y,
        z: nodePos.z + distance,
      },
      nodePos,
      1000,
    );
  }, []);

  const handleNodeClick = useCallback((node: any, _event: MouseEvent) => {
    setSelectedNode(node as GraphNode);
    flyToNode(node as GraphNode);
  }, [setSelectedNode, flyToNode]);

  // Three.js raycasting is reliable — no shadow-canvas workaround needed
  const handleNodeHover = useCallback((node: any | null) => {
    const next = node as GraphNode | null;
    if (next?.id !== hoveredNodeRef.current?.id) {
      hoveredNodeRef.current = next;
      rebuildHighlights();
    }
  }, [rebuildHighlights]);

  const handleBackgroundClick = useCallback((_event: MouseEvent) => {
    hoveredNodeRef.current = null;
    setSelectedNode(null);
  }, [setSelectedNode]);

  const handleNodeRightClick = useCallback((node: any, event: MouseEvent) => {
    event.preventDefault();
    onNodeRightClick?.(node as GraphNode, event.clientX, event.clientY);
  }, [onNodeRightClick]);

  const handleBackgroundRightClick = useCallback((event: MouseEvent) => {
    event.preventDefault();
    onBackgroundRightClick?.(event.clientX, event.clientY, event.clientX, event.clientY);
  }, [onBackgroundRightClick]);

  const zoomToFit = useCallback(() => {
    graphRef.current?.zoomToFit(600, 60);
  }, []);

  return {
    graphRef,
    selectedNode,
    setSelectedNode,
    handleNodeClick,
    handleNodeHover,
    handleBackgroundClick,
    handleNodeRightClick,
    handleBackgroundRightClick,
    renderRefs: {
      hoveredNodeRef,
      selectedNodeRef,
      highlightNodesRef,
      highlightLinksRef,
      degreeMapRef,
      orphanSetRef,
      showOrphansRef,
    },
    flyToNode,
    zoomToFit,
  };
}
