/**
 * useSigma — React hook that manages a Sigma.js instance with ForceAtlas2.
 *
 * Creates one Sigma renderer bound to a container ref.  Call `setGraph` to
 * swap the graphology graph and kick off a ForceAtlas2 web-worker layout.
 */

import { useRef, useEffect, useCallback, useState } from 'react';
import Sigma from 'sigma';
import Graph from 'graphology';
import FA2Layout from 'graphology-layout-forceatlas2/worker';
import forceAtlas2 from 'graphology-layout-forceatlas2';
import EdgeCurveProgram from '@sigma/edge-curve';
import type { SigmaNodeAttributes, SigmaEdgeAttributes } from './graph-adapter';

// ── ForceAtlas2 tuning ─────────────────────────────────────────────────────

function fa2Settings(nodeCount: number) {
  const small = nodeCount < 500;
  const med   = nodeCount < 2000;
  const large = nodeCount < 10000;
  return {
    gravity:       small ? 0.8 : med ? 0.5 : large ? 0.3 : 0.15,
    scalingRatio:  small ? 15  : med ? 30  : large ? 60  : 100,
    slowDown:      small ? 1   : med ? 2   : large ? 3   : 5,
    barnesHutOptimize: nodeCount > 200,
    barnesHutTheta: large ? 0.8 : 0.6,
    strongGravityMode: false,
    outboundAttractionDistribution: true,
    linLogMode: false,
    adjustSizes: true,
    edgeWeightInfluence: 1,
  };
}

function layoutDuration(n: number): number {
  if (n > 10000) return 45000;
  if (n > 5000)  return 35000;
  if (n > 2000)  return 30000;
  if (n > 1000)  return 25000;
  return 20000;
}

// ── Hook ───────────────────────────────────────────────────────────────────

export interface UseSigmaOptions {
  onNodeClick?: (nodeId: string) => void;
  onNodeHover?: (nodeId: string | null) => void;
  onStageClick?: () => void;
  visibleEdgeTypes?: Set<string>;
  /** Set of node IDs to highlight (e.g. process nodes, file tree connections) */
  highlightedNodeIds?: Set<string>;
  /** Map of nodeId → depth for blast radius colouring */
  blastRadiusMap?: Map<string, number>;
}

export interface UseSigmaReturn {
  containerRef: React.RefObject<HTMLDivElement | null>;
  sigmaRef: React.RefObject<Sigma<SigmaNodeAttributes, SigmaEdgeAttributes> | null>;
  graphRef: React.RefObject<Graph<SigmaNodeAttributes, SigmaEdgeAttributes> | null>;
  setGraph: (g: Graph<SigmaNodeAttributes, SigmaEdgeAttributes>) => void;
  zoomIn: () => void;
  zoomOut: () => void;
  resetZoom: () => void;
  focusNode: (id: string) => void;
  isLayoutRunning: boolean;
  startLayout: () => void;
  stopLayout: () => void;
  selectedNode: string | null;
  setSelectedNode: (id: string | null) => void;
}

export function useSigma(opts: UseSigmaOptions = {}): UseSigmaReturn {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const sigmaRef     = useRef<Sigma<SigmaNodeAttributes, SigmaEdgeAttributes> | null>(null);
  const graphRef     = useRef<Graph<SigmaNodeAttributes, SigmaEdgeAttributes> | null>(null);
  const layoutRef    = useRef<FA2Layout | null>(null);
  const timerRef     = useRef<ReturnType<typeof setTimeout> | null>(null);
  const selectedRef  = useRef<string | null>(null);
  const edgeTypesRef = useRef<Set<string> | null>(null);
  const highlightRef = useRef<Set<string> | null>(null);
  const blastRef     = useRef<Map<string, number> | null>(null);

  const [isLayoutRunning, setIsLayoutRunning] = useState(false);
  const [selectedNode, setSelectedNodeState]  = useState<string | null>(null);

  // Keep mutable refs in sync
  useEffect(() => {
    edgeTypesRef.current = opts.visibleEdgeTypes ?? null;
    sigmaRef.current?.refresh();
  }, [opts.visibleEdgeTypes]);

  useEffect(() => {
    highlightRef.current = opts.highlightedNodeIds ?? null;
    sigmaRef.current?.refresh();
  }, [opts.highlightedNodeIds]);

  useEffect(() => {
    blastRef.current = opts.blastRadiusMap ?? null;
    sigmaRef.current?.refresh();
  }, [opts.blastRadiusMap]);

  const setSelectedNode = useCallback((id: string | null) => {
    selectedRef.current = id;
    setSelectedNodeState(id);
    sigmaRef.current?.refresh();
  }, []);

  // ── Sigma init (once) ──────────────────────────────────────────────
  useEffect(() => {
    if (!containerRef.current) return;

    const g = new Graph<SigmaNodeAttributes, SigmaEdgeAttributes>();
    graphRef.current = g;

    const sigma = new Sigma(g, containerRef.current, {
      renderLabels: true,
      labelFont: 'ui-monospace, monospace',
      labelSize: 11,
      labelColor: { color: '#e4e4ed' },
      labelRenderedSizeThreshold: 8,
      labelDensity: 0.1,
      labelGridCellSize: 70,
      defaultNodeColor: '#6b7280',
      defaultEdgeColor: '#2a2a3a',
      defaultEdgeType: 'curved',
      edgeProgramClasses: {
        curved: EdgeCurveProgram,
      },
      minCameraRatio: 0.002,
      maxCameraRatio: 50,
      hideEdgesOnMove: true,
      zIndex: true,

      // Node reducer: selection + highlight + blast radius
      nodeReducer: (node: string, data: any) => {
        const res = { ...data };
        if (data.hidden) { res.hidden = true; return res; }

        // Blast radius colouring (highest priority visual)
        const blastMap = blastRef.current;
        if (blastMap && blastMap.size > 0) {
          const depth = blastMap.get(node);
          if (depth !== undefined) {
            const blastColors: Record<number, string> = { 1: '#ef4444', 2: '#f97316', 3: '#eab308' };
            res.color = blastColors[depth] || '#eab308';
            res.size = (data.size || 8) * (depth === 1 ? 2.0 : depth === 2 ? 1.6 : 1.3);
            res.zIndex = 3 - depth;
            res.highlighted = true;
            return res;
          }
        }

        // Highlight set (process highlight, file tree highlight)
        const hlSet = highlightRef.current;
        if (hlSet && hlSet.size > 0) {
          if (hlSet.has(node)) {
            res.color = data.communityColor || data.color;
            res.size = (data.size || 8) * 1.5;
            res.zIndex = 2;
            res.highlighted = true;
          } else {
            res.color = dimColor(data.color, 0.15);
            res.size = (data.size || 8) * 0.5;
            res.zIndex = 0;
          }
          return res;
        }

        // Selection highlighting
        const sel = selectedRef.current;
        if (sel) {
          const gr = graphRef.current;
          if (gr) {
            const isSel = node === sel;
            const isNeighbour = gr.hasEdge(node, sel) || gr.hasEdge(sel, node);
            if (isSel) {
              res.size = (data.size || 8) * 1.8;
              res.zIndex = 2;
              res.highlighted = true;
            } else if (isNeighbour) {
              res.size = (data.size || 8) * 1.3;
              res.zIndex = 1;
            } else {
              res.color = dimColor(data.color, 0.25);
              res.size = (data.size || 8) * 0.6;
              res.zIndex = 0;
            }
          }
        }
        return res;
      },

      // Edge reducer: selection + type visibility + highlights
      edgeReducer: (edge: string, data: any) => {
        const res = { ...data };
        const visible = edgeTypesRef.current;
        if (visible && data.relationType && !visible.has(data.relationType)) {
          res.hidden = true;
          return res;
        }

        const gr = graphRef.current;
        if (!gr) return res;
        const [src, tgt] = gr.extremities(edge);

        // Blast radius: highlight edges between blast nodes
        const blastMap = blastRef.current;
        if (blastMap && blastMap.size > 0) {
          const srcD = blastMap.get(src);
          const tgtD = blastMap.get(tgt);
          if (srcD !== undefined || tgtD !== undefined) {
            res.size = Math.max(2, (data.size || 1) * 3);
            res.color = '#ef4444';
            res.zIndex = 2;
          } else {
            res.color = dimColor(data.color, 0.08);
            res.size = 0.2;
          }
          return res;
        }

        // Highlight set
        const hlSet = highlightRef.current;
        if (hlSet && hlSet.size > 0) {
          if (hlSet.has(src) && hlSet.has(tgt)) {
            res.size = Math.max(2, (data.size || 1) * 3);
            res.zIndex = 2;
          } else {
            res.color = dimColor(data.color, 0.08);
            res.size = 0.2;
          }
          return res;
        }

        // Selection
        const sel = selectedRef.current;
        if (sel) {
          if (src === sel || tgt === sel) {
            res.size = Math.max(3, (data.size || 1) * 4);
            res.zIndex = 2;
          } else {
            res.color = dimColor(data.color, 0.1);
            res.size = 0.3;
            res.zIndex = 0;
          }
        }
        return res;
      },
    });

    sigmaRef.current = sigma;

    sigma.on('clickNode', ({ node }: { node: string }) => {
      setSelectedNode(node);
      opts.onNodeClick?.(node);
    });
    sigma.on('clickStage', () => {
      setSelectedNode(null);
      opts.onStageClick?.();
    });
    sigma.on('enterNode', ({ node }: { node: string }) => {
      opts.onNodeHover?.(node);
      if (containerRef.current) containerRef.current.style.cursor = 'pointer';
    });
    sigma.on('leaveNode', () => {
      opts.onNodeHover?.(null);
      if (containerRef.current) containerRef.current.style.cursor = 'grab';
    });

    // Resize sigma when container dimensions change (e.g. enlarge toggle)
    const ro = new ResizeObserver(() => {
      sigma.resize();
      sigma.refresh();
    });
    ro.observe(containerRef.current);

    return () => {
      ro.disconnect();
      if (timerRef.current) clearTimeout(timerRef.current);
      layoutRef.current?.kill();
      sigma.kill();
      sigmaRef.current = null;
      graphRef.current = null;
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ── Layout runner ──────────────────────────────────────────────────
  const runLayout = useCallback((g: Graph<SigmaNodeAttributes, SigmaEdgeAttributes>) => {
    if (g.order === 0) return;
    layoutRef.current?.kill();
    if (timerRef.current) clearTimeout(timerRef.current);

    const inferred = forceAtlas2.inferSettings(g);
    const custom = fa2Settings(g.order);
    const layout = new FA2Layout(g, { settings: { ...inferred, ...custom } });
    layoutRef.current = layout;
    layout.start();
    setIsLayoutRunning(true);

    timerRef.current = setTimeout(() => {
      layoutRef.current?.stop();
      layoutRef.current = null;
      sigmaRef.current?.refresh();
      setIsLayoutRunning(false);
    }, layoutDuration(g.order));
  }, []);

  const setGraph = useCallback((newGraph: Graph<SigmaNodeAttributes, SigmaEdgeAttributes>) => {
    const sigma = sigmaRef.current;
    if (!sigma) return;
    layoutRef.current?.kill();
    if (timerRef.current) clearTimeout(timerRef.current);

    graphRef.current = newGraph;
    sigma.setGraph(newGraph);
    setSelectedNode(null);
    runLayout(newGraph);
    sigma.getCamera().animatedReset({ duration: 500 });
  }, [runLayout, setSelectedNode]);

  // ── Camera controls ────────────────────────────────────────────────
  const zoomIn = useCallback(() => sigmaRef.current?.getCamera().animatedZoom({ duration: 200 }), []);
  const zoomOut = useCallback(() => sigmaRef.current?.getCamera().animatedUnzoom({ duration: 200 }), []);
  const resetZoom = useCallback(() => {
    sigmaRef.current?.getCamera().animatedReset({ duration: 300 });
    setSelectedNode(null);
  }, [setSelectedNode]);

  const focusNode = useCallback((nodeId: string) => {
    const sigma = sigmaRef.current;
    const g = graphRef.current;
    if (!sigma || !g || !g.hasNode(nodeId)) return;
    setSelectedNode(nodeId);
    const attrs = g.getNodeAttributes(nodeId);
    sigma.getCamera().animate({ x: attrs.x, y: attrs.y, ratio: 0.15 }, { duration: 400 });
  }, [setSelectedNode]);

  const startLayout = useCallback(() => {
    if (graphRef.current) runLayout(graphRef.current);
  }, [runLayout]);

  const stopLayout = useCallback(() => {
    if (timerRef.current) clearTimeout(timerRef.current);
    layoutRef.current?.stop();
    layoutRef.current = null;
    sigmaRef.current?.refresh();
    setIsLayoutRunning(false);
  }, []);

  return {
    containerRef, sigmaRef, graphRef,
    setGraph, zoomIn, zoomOut, resetZoom, focusNode,
    isLayoutRunning, startLayout, stopLayout,
    selectedNode, setSelectedNode,
  };
}

// ── Colour helpers ─────────────────────────────────────────────────────────

function hexToRgb(hex: string) {
  const r = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(hex);
  return r ? { r: parseInt(r[1], 16), g: parseInt(r[2], 16), b: parseInt(r[3], 16) } : { r: 100, g: 100, b: 100 };
}

function rgbToHex(r: number, g: number, b: number) {
  return '#' + [r, g, b].map(x => Math.max(0, Math.min(255, Math.round(x))).toString(16).padStart(2, '0')).join('');
}

function dimColor(hex: string, amount: number): string {
  const rgb = hexToRgb(hex);
  const bg = { r: 18, g: 18, b: 28 };
  return rgbToHex(bg.r + (rgb.r - bg.r) * amount, bg.g + (rgb.g - bg.g) * amount, bg.b + (rgb.b - bg.b) * amount);
}
