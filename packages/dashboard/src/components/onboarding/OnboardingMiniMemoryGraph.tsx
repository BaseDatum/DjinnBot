/**
 * OnboardingMiniMemoryGraph — Compact 3D force graph showing the shared
 * memory graph being built in real time during onboarding.
 *
 * Uses react-force-graph-3d (Three.js/WebGL) for immersive rendering.
 * Connects to the shared vault WebSocket for instant live updates
 * (no polling). New nodes animate in with a brief emissive glow.
 *
 * This is a stripped-down 3D version — no sidebar, no panel,
 * no filters, no context menu. Just the graph with minimal chrome.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import ForceGraph3DLib from 'react-force-graph-3d';
const ForceGraph3D = ForceGraph3DLib as any;
import * as THREE from 'three';
import { Share2 } from 'lucide-react';

import { useGraphWebSocket } from '@/hooks/useGraphWebSocket';
import type { GraphData } from '@/lib/api';

// ── Types ────────────────────────────────────────────────────────────────────

interface MiniGraphNode {
  id: string;
  label?: string;
  category?: string;
  isShared?: boolean;
  // Force-graph mutable fields
  x?: number;
  y?: number;
  z?: number;
  fx?: number;
  fy?: number;
  fz?: number;
}

interface MiniGraphLink {
  source: string;
  target: string;
  label?: string;
}

interface OnboardingMiniMemoryGraphProps {}

// ── Category colors ──────────────────────────────────────────────────────────

const CATEGORY_COLORS: Record<string, number> = {
  fact: 0x60a5fa,        // blue
  decision: 0xf59e0b,    // amber
  architecture: 0x10b981, // emerald
  requirement: 0x8b5cf6, // violet
  persona: 0xec4899,     // pink
  context: 0x06b6d4,     // cyan
  reference: 0x6366f1,   // indigo
  plan: 0xf97316,        // orange
};
const DEFAULT_COLOR = 0x94a3b8; // slate

function getNodeColorHex(category?: string): number {
  if (!category) return DEFAULT_COLOR;
  return CATEGORY_COLORS[category.toLowerCase()] ?? DEFAULT_COLOR;
}

// ── Recently-added tracking for glow animation ──────────────────────────────

const GLOW_DURATION_MS = 3000;

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

  const [graphData, setGraphData] = useState<{ nodes: MiniGraphNode[]; links: MiniGraphLink[] }>({
    nodes: [],
    links: [],
  });
  const [nodeCount, setNodeCount] = useState(0);
  const recentNodeIds = useRef<Map<string, number>>(new Map()); // id -> timestamp added

  // Track existing node IDs via ref to avoid stale closures and
  // unnecessary re-creation of the transform callback.
  const existingIdsRef = useRef<Set<string>>(new Set());

  // Transform API graph data to force-graph format.
  // This is intentionally dependency-free (stable reference) — it reads
  // the mutable existingIdsRef instead of depending on graphData.nodes.
  const transformGraph = useCallback(
    (raw: GraphData, _opts?: { isInit?: boolean }) => {
      const now = Date.now();

      const nodes: MiniGraphNode[] = (raw.nodes ?? []).map((n: any) => ({
        id: `shared/${n.id}`,
        label: n.label ?? n.title ?? n.id,
        category: n.category ?? n.type,
        isShared: true,
      }));
      const links: MiniGraphLink[] = (raw.edges ?? []).map((e: any) => ({
        source: `shared/${e.source}`,
        target: `shared/${e.target}`,
        label: e.label,
      }));

      // Track newly added nodes for glow effect
      for (const n of nodes) {
        if (!existingIdsRef.current.has(n.id)) {
          recentNodeIds.current.set(n.id, now);
        }
      }
      // Clean up old glow entries
      for (const [id, ts] of recentNodeIds.current) {
        if (now - ts > GLOW_DURATION_MS) recentNodeIds.current.delete(id);
      }

      // Update the tracking set for next time
      existingIdsRef.current = new Set(nodes.map((n) => n.id));

      setNodeCount(nodes.length);
      return { nodes, links };
    },
    [], // stable — no deps
  );

  // WebSocket callbacks
  const handleInit = useCallback(
    (graph: GraphData) => setGraphData(transformGraph(graph, { isInit: true })),
    [transformGraph],
  );
  const handleUpdate = useCallback(
    (graph: GraphData) => {
      // Never regress from a populated graph to empty — the server may
      // be sending stale data while waiting for the graph rebuild.
      const nodes = graph.nodes ?? [];
      setGraphData((prev) => {
        if (prev.nodes.length > 0 && nodes.length === 0) {
          return prev; // keep current data
        }
        return transformGraph(graph);
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

  // 3D node renderer — creates a sphere with category color + emissive glow for recent nodes
  const nodeThreeObject = useCallback(
    (node: MiniGraphNode) => {
      const color = getNodeColorHex(node.category);
      const now = Date.now();
      const addedAt = recentNodeIds.current.get(node.id);
      const isRecent = addedAt && now - addedAt < GLOW_DURATION_MS;

      const geo = new THREE.SphereGeometry(3, 16, 12);
      const mat = new THREE.MeshLambertMaterial({
        color,
        emissive: isRecent ? color : 0x000000,
        emissiveIntensity: isRecent ? 0.8 : 0,
        transparent: true,
        opacity: 0.9,
      });
      const mesh = new THREE.Mesh(geo, mat);

      // Outer glow ring for recently added nodes
      if (isRecent) {
        const glowGeo = new THREE.SphereGeometry(5, 16, 12);
        const glowMat = new THREE.MeshBasicMaterial({
          color,
          transparent: true,
          opacity: 0.25,
        });
        const glowMesh = new THREE.Mesh(glowGeo, glowMat);
        mesh.add(glowMesh);
      }

      return mesh;
    },
    [graphData], // rebuild when graph changes so glow state updates
  );

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
      controls.minDistance = 20;
    }

    sceneConfigured.current = true;
  }, [graphData.nodes.length]);

  // Auto-zoom to fit on data change
  useEffect(() => {
    if (fgRef.current && graphData.nodes.length > 0) {
      setTimeout(() => {
        fgRef.current?.zoomToFit?.(400, 40);
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
            width={dimensions.width}
            height={dimensions.height}
            backgroundColor={bgColor}
            nodeThreeObject={nodeThreeObject}
            nodeThreeObjectExtend={false}
            linkColor={() => isDark ? 'rgba(100,116,139,0.3)' : 'rgba(100,116,139,0.2)'}
            linkWidth={0.3}
            linkOpacity={0.5}
            enableNodeDrag={false}
            enableNavigationControls={true}
            controlType="orbit"
            showNavInfo={false}
            cooldownTicks={80}
            d3AlphaDecay={0.03}
            d3VelocityDecay={0.3}
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
