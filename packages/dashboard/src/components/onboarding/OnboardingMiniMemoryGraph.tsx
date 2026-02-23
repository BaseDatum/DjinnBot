/**
 * OnboardingMiniMemoryGraph — Compact 3D force graph showing the shared
 * memory graph being built in real time during onboarding.
 *
 * Uses react-force-graph-3d (Three.js/WebGL) for immersive rendering.
 * Connects to the shared vault WebSocket for instant live updates.
 * Only re-renders the graph when the node/edge set actually changes
 * (prevents the physics simulation from restarting on identical data).
 *
 * Rendering matches the full MemoryGraph3D — same color palette,
 * type-specific geometries, degree-based sizing, label sprites, and
 * shared vault rings from graphRenderers3d + graphColors.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import ForceGraph3DLib from 'react-force-graph-3d';
const ForceGraph3D = ForceGraph3DLib as any;
import * as THREE from 'three';
import { Share2 } from 'lucide-react';

import { useGraphWebSocket } from '@/hooks/useGraphWebSocket';
import type { GraphData as APIGraphData } from '@/lib/api';
import { COLORS_DARK, COLORS_LIGHT } from '../graph/graphColors';
import type { ColorPalette } from '../graph/graphColors';
import type { GraphNode } from '../graph/types';
import {
  makeNodeThreeObject,
  makeLinkColor3D,
  makeLinkWidth3D,
  updateLabelVisibility,
  syncHighlights3D,
} from '../graph/graphRenderers3d';
import type { Render3DRefs } from '../graph/graphRenderers3d';

// ── Types ────────────────────────────────────────────────────────────────────

interface OnboardingMiniMemoryGraphProps {}

// ── Recently-added tracking for glow animation ──────────────────────────────

const GLOW_DURATION_MS = 3000;

// ── Fingerprint helpers — detect actual data changes ────────────────────────

function graphFingerprint(nodes: any[], edges: any[]): string {
  // Build a cheap fingerprint from node IDs + edge pairs.
  // Sorting ensures order-independent comparison.
  const nIds = nodes.map((n: any) => n.id).sort().join(',');
  const eIds = edges.map((e: any) => `${e.source}-${e.target}`).sort().join(',');
  return `${nodes.length}:${edges.length}|${nIds}|${eIds}`;
}

// ── Component ────────────────────────────────────────────────────────────────

export function OnboardingMiniMemoryGraph({}: OnboardingMiniMemoryGraphProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const fgRef = useRef<any>(null);
  const sceneConfigured = useRef(false);
  const [dimensions, setDimensions] = useState<{ width: number; height: number }>({ width: 400, height: 200 });

  // Track container size
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const ro = new ResizeObserver((entries) => {
      for (const entry of entries) {
        const { width, height } = entry.contentRect;
        if (width > 0 && height > 0) {
          setDimensions({ width: Math.round(width), height: Math.round(height) });
        }
      }
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const [graphData, setGraphData] = useState<{ nodes: GraphNode[]; links: any[] }>({
    nodes: [],
    links: [],
  });
  const [nodeCount, setNodeCount] = useState(0);
  const recentNodeIds = useRef<Map<string, number>>(new Map()); // id -> timestamp added

  // Track existing node IDs via ref to avoid stale closures
  const existingIdsRef = useRef<Set<string>>(new Set());
  // Fingerprint of the last accepted graph to skip no-op updates
  const lastFingerprintRef = useRef<string>('');
  // Live nodes ref for label visibility loop
  const graphDataNodesRef = useRef<any[]>([]);
  // IDs of nodes added in the most recent update — drives auto-focus
  const [newlyAddedIds, setNewlyAddedIds] = useState<string[]>([]);
  // Timer for auto-deselecting the focused node
  const deselectTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Detect dark mode
  const [isDark, setIsDark] = useState(() => document.documentElement.classList.contains('dark'));
  useEffect(() => {
    const obs = new MutationObserver(() =>
      setIsDark(document.documentElement.classList.contains('dark'))
    );
    obs.observe(document.documentElement, { attributes: true, attributeFilter: ['class'] });
    return () => obs.disconnect();
  }, []);

  const bgColor = isDark ? '#000000' : '#ffffff';
  const colors = isDark ? COLORS_DARK : COLORS_LIGHT;

  // ── Refs for the shared renderer system (Render3DRefs) ──────────────────
  // The mini graph has no hover/select interaction, so these stay empty.
  const colorsRef = useRef<ColorPalette>(colors);
  colorsRef.current = colors;
  const isDarkRef = useRef(isDark);
  isDarkRef.current = isDark;
  const hoveredNodeRef = useRef<GraphNode | null>(null);
  const selectedNodeRef = useRef<GraphNode | null>(null);
  const highlightNodesRef = useRef<Set<string>>(new Set());
  const highlightLinksRef = useRef<Set<string>>(new Set());
  const degreeMapRef = useRef<Map<string, number>>(new Map());
  const orphanSetRef = useRef<Set<string>>(new Set());
  const showOrphansRef = useRef(false);

  const renderRefs: Render3DRefs = {
    colorsRef,
    isDarkRef,
    hoveredNodeRef,
    selectedNodeRef,
    highlightNodesRef,
    highlightLinksRef,
    degreeMapRef,
    orphanSetRef,
    showOrphansRef,
  };

  // Transform API graph data to force-graph format.
  // Returns null if the data is unchanged (same fingerprint).
  const transformGraph = useCallback(
    (raw: APIGraphData, opts?: { isInit?: boolean }): { nodes: GraphNode[]; links: any[]; addedIds: string[] } | null => {
      const now = Date.now();
      const rawNodes = raw.nodes ?? [];
      const rawEdges = raw.edges ?? [];

      // Check fingerprint — skip if identical
      const fp = graphFingerprint(rawNodes, rawEdges);
      if (fp === lastFingerprintRef.current) {
        return null; // no change
      }
      lastFingerprintRef.current = fp;

      const nodes: GraphNode[] = rawNodes.map((n: any) => ({
        id: `shared/${n.id}`,
        title: n.label ?? n.title ?? n.id,
        type: n.type ?? 'default',
        category: n.category ?? n.type ?? 'default',
        path: n.path ?? null,
        tags: n.tags ?? [],
        missing: n.missing ?? false,
        degree: n.degree ?? 0,
        createdAt: n.createdAt,
        isShared: true,
      }));
      const links = rawEdges.map((e: any) => ({
        source: `shared/${e.source}`,
        target: `shared/${e.target}`,
        type: e.type ?? 'default',
        label: e.label,
      }));

      // Track newly added nodes for glow effect + auto-focus
      const addedIds: string[] = [];
      for (const n of nodes) {
        if (!existingIdsRef.current.has(n.id)) {
          recentNodeIds.current.set(n.id, now);
          // Don't auto-focus on initial load — only on incremental updates
          if (!opts?.isInit) {
            addedIds.push(n.id);
          }
        }
      }
      // Clean up old glow entries
      for (const [id, ts] of recentNodeIds.current) {
        if (now - ts > GLOW_DURATION_MS) recentNodeIds.current.delete(id);
      }

      // Update the tracking set for next time
      existingIdsRef.current = new Set(nodes.map((n) => n.id));

      // Compute degree map for proper node sizing
      const dm = new Map<string, number>();
      for (const n of nodes) dm.set(n.id, 0);
      for (const e of links) {
        const sid = String(e.source);
        const tid = String(e.target);
        dm.set(sid, (dm.get(sid) ?? 0) + 1);
        dm.set(tid, (dm.get(tid) ?? 0) + 1);
      }
      degreeMapRef.current = dm;

      // Compute orphan set
      const connectedIds = new Set<string>();
      for (const e of links) {
        connectedIds.add(String(e.source));
        connectedIds.add(String(e.target));
      }
      orphanSetRef.current = new Set(nodes.filter((n) => !connectedIds.has(n.id)).map((n) => n.id));

      setNodeCount(nodes.length);
      return { nodes, links, addedIds };
    },
    [], // stable — no deps
  );

  // WebSocket callbacks
  const handleInit = useCallback(
    (graph: APIGraphData) => {
      // On init, always accept (reset fingerprint first)
      lastFingerprintRef.current = '';
      const result = transformGraph(graph, { isInit: true });
      if (result) {
        graphDataNodesRef.current = result.nodes;
        setGraphData({ nodes: result.nodes, links: result.links });
        // No auto-focus on init
      }
    },
    [transformGraph],
  );
  const handleUpdate = useCallback(
    (graph: APIGraphData) => {
      const rawNodes = graph.nodes ?? [];
      setGraphData((prev) => {
        // Never regress from a populated graph to empty
        if (prev.nodes.length > 0 && rawNodes.length === 0) {
          return prev;
        }
        const result = transformGraph(graph);
        if (!result) {
          return prev; // fingerprint unchanged — skip update
        }
        graphDataNodesRef.current = result.nodes;
        // Signal new nodes for auto-focus
        if (result.addedIds.length > 0) {
          setNewlyAddedIds(result.addedIds);
        }
        return { nodes: result.nodes, links: result.links };
      });
    },
    [transformGraph],
  );

  const { connected } = useGraphWebSocket({
    agentId: 'shared',
    enabled: true,
    onInit: handleInit,
    onUpdate: handleUpdate,
  });

  // ── Auto-focus: select + fly to the newest node when memories arrive ────
  useEffect(() => {
    if (newlyAddedIds.length === 0) return;

    // Pick the last added node as the focus target
    const targetId = newlyAddedIds[newlyAddedIds.length - 1];
    // Clear so this doesn't re-fire
    setNewlyAddedIds([]);

    // Wait for ForceGraph3D to run a few simulation ticks so the node
    // has a position we can fly to (freshly-added nodes start at 0,0,0).
    const delay = setTimeout(() => {
      const fg = fgRef.current;
      if (!fg) return;

      // Find the live node object (mutated in-place by the library)
      const liveNode = graphDataNodesRef.current.find((n: any) => n.id === targetId);
      if (!liveNode) return;

      // Select the node — sets up highlight state so the renderer
      // draws it with the focus glow and dims other nodes
      selectedNodeRef.current = liveNode as GraphNode;
      syncHighlights3D(renderRefs, () => fg.graphData()?.links ?? []);
      // Force re-render of Three.js objects to pick up the new highlight state
      fg.refresh();

      // Fly camera to the node
      const x = liveNode.x ?? 0;
      const y = liveNode.y ?? 0;
      const z = liveNode.z ?? 0;
      const distance = 80;
      fg.cameraPosition(
        { x, y, z: z + distance },
        { x, y, z },
        1000, // 1 second animation
      );

      // Auto-deselect after the glow fades, then zoom back out
      if (deselectTimerRef.current) clearTimeout(deselectTimerRef.current);
      deselectTimerRef.current = setTimeout(() => {
        selectedNodeRef.current = null;
        highlightNodesRef.current = new Set();
        highlightLinksRef.current = new Set();
        fg.refresh();
        // Zoom back out to show the full graph
        setTimeout(() => fg.zoomToFit?.(600, 60), 100);
      }, GLOW_DURATION_MS);
    }, 800); // wait for simulation to position the node

    return () => clearTimeout(delay);
  }, [newlyAddedIds]); // eslint-disable-line react-hooks/exhaustive-deps

  // Clean up deselect timer on unmount
  useEffect(() => {
    return () => {
      if (deselectTimerRef.current) clearTimeout(deselectTimerRef.current);
    };
  }, []);

  // ── Stable 3D rendering callbacks (same as MemoryGraph3D) ───────────────
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const nodeThreeObjectFn = useMemo(() => makeNodeThreeObject(renderRefs), []);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const linkColorFn = useMemo(() => makeLinkColor3D(renderRefs), []);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const linkWidthFn = useMemo(() => makeLinkWidth3D(renderRefs), []);

  // ── Per-frame label distance fade (same as MemoryGraph3D) ───────────────
  useEffect(() => {
    let frameId: number;
    const tick = () => {
      updateLabelVisibility(fgRef, renderRefs, graphDataNodesRef);
      frameId = requestAnimationFrame(tick);
    };
    frameId = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frameId);
  }, []); // stable refs — never recreated

  // Refresh node objects when theme changes (label bg/text colors)
  const prevDarkRef = useRef(isDark);
  useEffect(() => {
    if (prevDarkRef.current !== isDark && fgRef.current) {
      prevDarkRef.current = isDark;
      fgRef.current.refresh();
    }
  }, [isDark]);

  // Scene setup: add lights on first render
  useEffect(() => {
    if (!fgRef.current || sceneConfigured.current) return;
    const scene = fgRef.current.scene?.();
    if (!scene) return;

    const ambient = new THREE.AmbientLight(0xffffff, 0.6);
    scene.add(ambient);
    const directional = new THREE.DirectionalLight(0xffffff, 0.8);
    directional.position.set(50, 100, 50);
    scene.add(directional);

    // Prevent getting stuck at extreme zoom
    const controls = fgRef.current.controls?.();
    if (controls && 'minDistance' in controls) {
      controls.minDistance = 10;
    }

    sceneConfigured.current = true;
  }, [graphData.nodes.length]);

  // Auto-zoom to fit on data change (only when node count changes)
  useEffect(() => {
    if (fgRef.current && graphData.nodes.length > 0) {
      setTimeout(() => {
        fgRef.current?.zoomToFit?.(600, 60);
      }, 300);
    }
  }, [graphData.nodes.length]);

  const isEmpty = graphData.nodes.length === 0;

  return (
    <div className="flex flex-col border-t bg-card/20 h-[40%] min-h-0">
      {/* Header */}
      <div className="flex items-center gap-2 px-3 py-1.5 border-b bg-card/50 shrink-0">
        <Share2 className="h-3 w-3 text-muted-foreground" />
        <span className="text-[10px] font-mono text-muted-foreground uppercase tracking-wider font-medium">
          Memory Graph
        </span>
        <span className="text-[9px] text-muted-foreground/50 ml-auto">
          {nodeCount} {nodeCount === 1 ? 'node' : 'nodes'}
          {connected && <span className="inline-block w-1.5 h-1.5 rounded-full bg-emerald-400 ml-1.5 align-middle" title="Live" />}
        </span>
      </div>

      {/* Graph or empty state */}
      <div className="relative overflow-hidden flex-1 min-h-0" ref={containerRef}>
        {isEmpty ? (
          <div className="flex items-center justify-center h-full">
            <p className="text-[10px] text-muted-foreground/50 italic">
              Memories will appear here as agents learn about your project
            </p>
          </div>
        ) : (
          <ForceGraph3D
            ref={fgRef}
            graphData={graphData}
            nodeId="id"
            linkSource="source"
            linkTarget="target"
            width={dimensions.width}
            height={dimensions.height}
            backgroundColor={bgColor}
            nodeThreeObject={nodeThreeObjectFn}
            nodeThreeObjectExtend={false}
            linkColor={linkColorFn}
            linkWidth={linkWidthFn}
            linkOpacity={0.6}
            enableNodeDrag={false}
            enableNavigationControls={true}
            controlType="orbit"
            showNavInfo={false}
            cooldownTicks={120}
            d3AlphaDecay={0.02}
            d3VelocityDecay={0.28}
          />
        )}

        {/* 3D badge */}
        <div className="absolute top-2 right-2 px-1.5 py-0.5 rounded bg-primary/10 text-primary text-[9px] font-medium backdrop-blur-sm border border-primary/20 pointer-events-none">
          3D
        </div>
      </div>
    </div>
  );
}
