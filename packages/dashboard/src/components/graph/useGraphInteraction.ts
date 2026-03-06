/**
 * Interaction state — hover, selection, highlight refs, drag.
 *
 * Hover is kept entirely in refs (no React state) so canvas callbacks can read
 * it without re-render cycles.  `autoPauseRedraw={false}` on the ForceGraph
 * ensures continuous redraws.
 *
 * ## Why hover is tricky with react-force-graph-2d
 *
 * The library maintains a *shadow canvas* for pixel-based hit detection.  This
 * canvas is **throttled** (refreshed every ~800 ms) for performance.  Between
 * refreshes, `getObjUnderPointer()` reads stale pixel data.  If a node's
 * physics position drifts even a pixel since the last shadow paint, the lookup
 * fails and the library fires `onNodeHover(null)` — even though the mouse is
 * visually right on top of the node.
 *
 * **Fix:** we track the screen-space pointer position ourselves.  When
 * `hover(null)` fires, we check whether the pointer has actually moved since
 * the last `hover(node)`.  If it hasn't moved, the null is spurious and we
 * ignore it.  This makes hover rock-solid while keeping the clear instant when
 * the user genuinely moves away.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import type { GraphNode, ForceLink } from './types';
import { syncHighlights } from './graphRenderers';
import type { RenderRefs } from './graphRenderers';

export interface ForceGraphMethods {
  zoomToFit: (durationMs?: number, padding?: number) => void;
  centerAt: (x: number, y: number, durationMs?: number) => void;
  zoom: (zoom: number, durationMs?: number) => void;
  d3ReheatSimulation: () => void;
  graphData: () => { nodes: any[]; links: any[] };
}

export interface UseGraphInteractionReturn {
  graphRef: React.MutableRefObject<ForceGraphMethods | null>;
  hoveredNode: GraphNode | null;
  selectedNode: GraphNode | null;
  setSelectedNode: (node: GraphNode | null) => void;
  handleNodeClick: (node: any) => void;
  handleNodeHover: (node: any | null) => void;
  handleBackgroundClick: () => void;
  handleNodeRightClick: (node: any, event: MouseEvent) => void;
  handleBackgroundRightClick: (event: MouseEvent) => void;
  renderRefs: Pick<RenderRefs, 'hoveredNodeRef' | 'selectedNodeRef' | 'highlightNodesRef' | 'highlightLinksRef' | 'degreeMapRef' | 'orphanSetRef' | 'showOrphansRef' | 'dragNodeRef'>;
  zoomToNode: (node: GraphNode) => void;
  zoomToFit: () => void;
}

interface Options {
  onNodeRightClick?: (node: GraphNode, screenX: number, screenY: number) => void;
  onBackgroundRightClick?: (screenX: number, screenY: number, graphX: number, graphY: number) => void;
  degreeMap: Map<string, number>;
  orphanSet: Set<string>;
  showOrphansOnly: boolean;
}

export function useGraphInteraction({
  onNodeRightClick,
  onBackgroundRightClick,
  degreeMap,
  orphanSet,
  showOrphansOnly,
}: Options): UseGraphInteractionReturn {
  const graphRef = useRef<ForceGraphMethods | null>(null);
  const [selectedNode, setSelectedNodeState] = useState<GraphNode | null>(null);

  // ── Stable refs for canvas rendering ──────────────────────────────────────
  const hoveredNodeRef = useRef<GraphNode | null>(null);
  const selectedNodeRef = useRef<GraphNode | null>(null);
  const highlightNodesRef = useRef<Set<string>>(new Set());
  const highlightLinksRef = useRef<Set<string>>(new Set());
  const degreeMapRef = useRef<Map<string, number>>(degreeMap);
  const orphanSetRef = useRef<Set<string>>(orphanSet);
  const showOrphansRef = useRef(showOrphansOnly);
  const dragNodeRef = useRef<GraphNode | null>(null);

  // ── Pointer tracking for hover stability ──────────────────────────────────
  // The screen-space coordinates of the pointer when hover last fired a
  // non-null node.  If hover(null) arrives and the pointer hasn't moved
  // beyond a small threshold since then, we treat it as a spurious event
  // from the stale shadow canvas and ignore it.
  const pointerAtHoverRef = useRef<{ x: number; y: number } | null>(null);
  const pointerNowRef = useRef<{ x: number; y: number }>({ x: 0, y: 0 });

  // Attach a global pointermove listener to track current pointer position.
  useEffect(() => {
    const handler = (e: PointerEvent) => {
      pointerNowRef.current = { x: e.clientX, y: e.clientY };
    };
    window.addEventListener('pointermove', handler, { passive: true });
    return () => window.removeEventListener('pointermove', handler);
  }, []);

  // Keep refs in sync
  degreeMapRef.current = degreeMap;
  orphanSetRef.current = orphanSet;
  showOrphansRef.current = showOrphansOnly;

  const getLinks = useCallback((): ForceLink[] => {
    return graphRef.current?.graphData?.()?.links ?? [];
  }, []);

  const rebuildHighlights = useCallback(() => {
    syncHighlights(
      { hoveredNodeRef, selectedNodeRef, highlightNodesRef, highlightLinksRef },
      getLinks,
    );
  }, [getLinks]);

  // Sync selection → ref
  useEffect(() => {
    selectedNodeRef.current = selectedNode;
    rebuildHighlights();
  }, [selectedNode, rebuildHighlights]);

  const setSelectedNode = useCallback((node: GraphNode | null) => {
    setSelectedNodeState(node);
  }, []);

  const handleNodeClick = useCallback((node: any) => {
    setSelectedNode(node as GraphNode);
    if (graphRef.current && node.x != null && node.y != null) {
      graphRef.current.centerAt(node.x, node.y, 500);
      graphRef.current.zoom(2, 500);
    }
  }, [setSelectedNode]);

  /**
   * Hover handler.
   *
   * - hover(node): immediate — update ref, snapshot pointer position.
   * - hover(null): only clear if the pointer has moved ≥ 4px since the last
   *   hover(node).  This absorbs spurious nulls from the shadow canvas without
   *   adding any delay to genuine hover-off transitions.
   */
  const POINTER_MOVE_THRESHOLD = 4; // px screen-space

  const handleNodeHover = useCallback((node: any | null) => {
    const next = node as GraphNode | null;

    if (next) {
      // ── Hover ON ──────────────────────────────────────────────────────
      if (next.id !== hoveredNodeRef.current?.id) {
        hoveredNodeRef.current = next;
        rebuildHighlights();
      }
      // Snapshot pointer position at the moment we confirmed hover
      pointerAtHoverRef.current = { ...pointerNowRef.current };
    } else {
      // ── Hover OFF candidate ───────────────────────────────────────────
      if (!hoveredNodeRef.current) return; // already null

      // Has the pointer actually moved since we last saw a real hover?
      const anchor = pointerAtHoverRef.current;
      if (anchor) {
        const dx = pointerNowRef.current.x - anchor.x;
        const dy = pointerNowRef.current.y - anchor.y;
        if (dx * dx + dy * dy < POINTER_MOVE_THRESHOLD * POINTER_MOVE_THRESHOLD) {
          // Pointer hasn't moved — this null is from the stale shadow canvas.
          return;
        }
      }

      // Pointer genuinely moved away — clear hover.
      hoveredNodeRef.current = null;
      pointerAtHoverRef.current = null;
      rebuildHighlights();
    }
  }, [rebuildHighlights]);

  /**
   * Background click handler.
   *
   * The library routes clicks via its own `state.hoverObj` which reads the
   * (often stale) shadow canvas.  If the shadow canvas missed the node,
   * the library fires onBackgroundClick even though the user clicked ON a
   * node.  We detect this by checking our own `hoveredNodeRef` — if it's
   * set, the user intended a node click, so we route it accordingly.
   */
  const handleBackgroundClick = useCallback(() => {
    if (hoveredNodeRef.current) {
      // The library thought this was a background click, but our pointer-
      // tracking says the user is on a node.  Treat as a node click.
      const node = hoveredNodeRef.current;
      setSelectedNode(node);
      if (graphRef.current && node.x != null && node.y != null) {
        graphRef.current.centerAt(node.x, node.y, 500);
        graphRef.current.zoom(2, 500);
      }
      return;
    }
    hoveredNodeRef.current = null;
    pointerAtHoverRef.current = null;
    setSelectedNode(null);
  }, [setSelectedNode]);

  const handleNodeRightClick = useCallback((node: any, event: MouseEvent) => {
    event.preventDefault();
    onNodeRightClick?.(node as GraphNode, event.clientX, event.clientY);
  }, [onNodeRightClick]);

  const handleBackgroundRightClick = useCallback((event: MouseEvent) => {
    event.preventDefault();
    const canvas = (event.target as HTMLElement).closest('canvas');
    if (!canvas) return;
    const rect = canvas.getBoundingClientRect();
    const screenX = event.clientX;
    const screenY = event.clientY;
    onBackgroundRightClick?.(screenX, screenY, screenX - rect.left, screenY - rect.top);
  }, [onBackgroundRightClick]);

  const zoomToNode = useCallback((node: GraphNode) => {
    if (!graphRef.current || node.x == null || node.y == null) return;
    graphRef.current.centerAt(node.x, node.y, 600);
    graphRef.current.zoom(2.5, 600);
  }, []);

  const zoomToFit = useCallback(() => {
    graphRef.current?.zoomToFit(600, 60);
  }, []);

  return {
    graphRef,
    get hoveredNode() { return hoveredNodeRef.current; },
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
      dragNodeRef,
    },
    zoomToNode,
    zoomToFit,
  };
}
