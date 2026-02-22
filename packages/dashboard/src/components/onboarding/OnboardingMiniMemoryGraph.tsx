/**
 * OnboardingMiniMemoryGraph — Compact 2D force graph showing the shared
 * memory graph being built in real time during onboarding.
 *
 * Uses react-force-graph-2d (Canvas2D) for lightweight rendering at small
 * sizes. Connects to the shared vault WebSocket for instant live updates
 * (no polling). New nodes animate in with a brief glow effect.
 *
 * This is a stripped-down version of MemoryGraph — no sidebar, no panel,
 * no filters, no context menu. Just the graph with minimal chrome.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import ForceGraph2DLib from 'react-force-graph-2d';
const ForceGraph2D = ForceGraph2DLib as any;
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
  fx?: number;
  fy?: number;
}

interface MiniGraphLink {
  source: string;
  target: string;
  label?: string;
}

interface OnboardingMiniMemoryGraphProps {
  /** Height of the graph container in px */
  height?: number;
}

// ── Category colors ──────────────────────────────────────────────────────────

const CATEGORY_COLORS: Record<string, string> = {
  fact: '#60a5fa',        // blue
  decision: '#f59e0b',    // amber
  architecture: '#10b981', // emerald
  requirement: '#8b5cf6', // violet
  persona: '#ec4899',     // pink
  context: '#06b6d4',     // cyan
  reference: '#6366f1',   // indigo
  plan: '#f97316',        // orange
};
const DEFAULT_COLOR = '#94a3b8'; // slate

function getNodeColor(category?: string): string {
  if (!category) return DEFAULT_COLOR;
  return CATEGORY_COLORS[category.toLowerCase()] ?? DEFAULT_COLOR;
}

// ── Recently-added tracking for glow animation ──────────────────────────────

const GLOW_DURATION_MS = 3000;

// ── Component ────────────────────────────────────────────────────────────────

export function OnboardingMiniMemoryGraph({ height = 200 }: OnboardingMiniMemoryGraphProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const fgRef = useRef<any>(null);
  const [graphData, setGraphData] = useState<{ nodes: MiniGraphNode[]; links: MiniGraphLink[] }>({
    nodes: [],
    links: [],
  });
  const [nodeCount, setNodeCount] = useState(0);
  const recentNodeIds = useRef<Map<string, number>>(new Map()); // id -> timestamp added

  // Transform API graph data to force-graph format
  const transformGraph = useCallback(
    (raw: GraphData) => {
      const now = Date.now();
      const existingIds = new Set(graphData.nodes.map((n) => n.id));

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
        if (!existingIds.has(n.id)) {
          recentNodeIds.current.set(n.id, now);
        }
      }
      // Clean up old glow entries
      for (const [id, ts] of recentNodeIds.current) {
        if (now - ts > GLOW_DURATION_MS) recentNodeIds.current.delete(id);
      }

      setNodeCount(nodes.length);
      return { nodes, links };
    },
    [graphData.nodes],
  );

  // WebSocket callbacks
  const handleInit = useCallback(
    (graph: GraphData) => setGraphData(transformGraph(graph)),
    [transformGraph],
  );
  const handleUpdate = useCallback(
    (graph: GraphData) => setGraphData(transformGraph(graph)),
    [transformGraph],
  );

  const { connected } = useGraphWebSocket({
    agentId: 'shared',
    enabled: true,
    onInit: handleInit,
    onUpdate: handleUpdate,
  });

  // Node canvas renderer
  const paintNode = useCallback(
    (node: MiniGraphNode, ctx: CanvasRenderingContext2D, globalScale: number) => {
      const r = 4;
      const color = getNodeColor(node.category);
      const now = Date.now();
      const addedAt = recentNodeIds.current.get(node.id);
      const isRecent = addedAt && now - addedAt < GLOW_DURATION_MS;

      // Glow effect for recent nodes
      if (isRecent) {
        const progress = (now - addedAt!) / GLOW_DURATION_MS;
        const glowAlpha = 0.6 * (1 - progress);
        const glowRadius = r + 8 * (1 - progress);
        ctx.beginPath();
        ctx.arc(node.x!, node.y!, glowRadius, 0, 2 * Math.PI);
        ctx.fillStyle = color.replace(')', `, ${glowAlpha})`).replace('rgb', 'rgba');
        ctx.fill();
      }

      // Node circle
      ctx.beginPath();
      ctx.arc(node.x!, node.y!, r, 0, 2 * Math.PI);
      ctx.fillStyle = color;
      ctx.fill();

      // Label (only at high zoom)
      if (globalScale > 1.5 && node.label) {
        ctx.font = `${Math.max(3, 8 / globalScale)}px -apple-system, sans-serif`;
        ctx.textAlign = 'center';
        ctx.textBaseline = 'top';
        ctx.fillStyle = '#aaa';
        ctx.fillText(node.label.slice(0, 20), node.x!, node.y! + r + 2);
      }
    },
    [],
  );

  // Auto-zoom to fit on data change
  useEffect(() => {
    if (fgRef.current && graphData.nodes.length > 0) {
      setTimeout(() => {
        fgRef.current?.zoomToFit?.(400, 20);
      }, 300);
    }
  }, [graphData.nodes.length]);

  // Request animation frame for glow updates
  const [, setTick] = useState(0);
  useEffect(() => {
    if (recentNodeIds.current.size === 0) return;
    const interval = setInterval(() => setTick((t) => t + 1), 50);
    const timeout = setTimeout(() => clearInterval(interval), GLOW_DURATION_MS + 100);
    return () => {
      clearInterval(interval);
      clearTimeout(timeout);
    };
  }, [graphData]);

  const isEmpty = graphData.nodes.length === 0;

  return (
    <div className="flex flex-col border-t bg-card/20" ref={containerRef}>
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
      <div style={{ height }} className="relative overflow-hidden">
        {isEmpty ? (
          <div className="flex items-center justify-center h-full">
            <p className="text-[10px] text-muted-foreground/50 italic">
              Memories will appear here as agents learn about your project
            </p>
          </div>
        ) : (
          <ForceGraph2D
            ref={fgRef}
            graphData={graphData}
            width={320}
            height={height}
            backgroundColor="transparent"
            nodeCanvasObject={paintNode}
            nodePointerAreaPaint={(node: MiniGraphNode, color: string, ctx: CanvasRenderingContext2D) => {
              ctx.beginPath();
              ctx.arc(node.x!, node.y!, 6, 0, 2 * Math.PI);
              ctx.fillStyle = color;
              ctx.fill();
            }}
            linkColor={() => 'rgba(100,116,139,0.2)'}
            linkWidth={0.5}
            enableNodeDrag={false}
            enableZoomInteraction={true}
            enablePanInteraction={true}
            cooldownTicks={60}
            d3VelocityDecay={0.4}
          />
        )}
      </div>
    </div>
  );
}
