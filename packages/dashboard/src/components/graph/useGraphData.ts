/**
 * Data layer for the memory graph.
 * Handles fetching, merging personal/shared, WebSocket live updates,
 * filtering by search + category + timeline, and orphan detection.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  fetchAgentGraph,
  fetchSharedGraph,
  fetchNodeNeighbors,
  rebuildAgentGraph,
} from '@/lib/api';
import { useGraphWebSocket } from '@/hooks/useGraphWebSocket';
import type { GraphData, GraphNode, GraphViewMode } from './types';

function mergeGraphs(personal: GraphData, shared: GraphData): GraphData {
  const sharedNodes = shared.nodes.map((n) => ({
    ...n,
    id: `shared/${n.id}`,
    isShared: true,
    // Preserve the original category — do NOT override it
  }));
  const sharedEdges = shared.edges.map((e) => ({
    ...e,
    source: `shared/${e.source}`,
    target: `shared/${e.target}`,
  }));
  return {
    nodes: [...personal.nodes, ...sharedNodes],
    edges: [...personal.edges, ...sharedEdges],
    stats: {
      nodeCount: personal.stats.nodeCount + shared.stats.nodeCount,
      edgeCount: personal.stats.edgeCount + shared.stats.edgeCount,
      nodeTypeCounts: { ...personal.stats.nodeTypeCounts, ...shared.stats.nodeTypeCounts },
      edgeTypeCounts: { ...personal.stats.edgeTypeCounts, ...shared.stats.edgeTypeCounts },
    },
  };
}

/** Compute orphan set (nodes with degree 0). */
function computeOrphans(nodes: GraphNode[], edges: { source: string; target: string }[]): Set<string> {
  const connected = new Set<string>();
  for (const e of edges) {
    connected.add(e.source);
    connected.add(e.target);
  }
  return new Set(nodes.filter((n) => !connected.has(n.id)).map((n) => n.id));
}

interface UseGraphDataOptions {
  agentId: string;
  viewMode: GraphViewMode;
  searchQuery: string;
  categoryFilter: string;
  showOrphansOnly: boolean;
  timelineMax: number | null;
}

export interface UseGraphDataReturn {
  rawData: GraphData | null;
  filteredData: { nodes: GraphNode[]; edges: GraphData['edges'] } | null;
  categories: string[];
  orphanSet: Set<string>;
  degreeMap: Map<string, number>;
  neighborMap: Map<string, Set<string>>;
  connected: boolean;
  rebuilding: boolean;
  triggerRebuild: () => Promise<void>;
  refetch: () => Promise<void>;
  enterFocusMode: (nodeId: string, depth?: number) => Promise<void>;
  exitFocusMode: () => void;
  focusNodeId: string | null;
}

export function useGraphData({
  agentId,
  viewMode,
  searchQuery,
  categoryFilter,
  showOrphansOnly,
  timelineMax,
}: UseGraphDataOptions): UseGraphDataReturn {
  const [rawData, setRawData] = useState<GraphData | null>(null);
  const [rebuilding, setRebuilding] = useState(false);
  const [focusNodeId, setFocusNodeId] = useState<string | null>(null);
  const [focusData, setFocusData] = useState<{ nodes: GraphNode[]; edges: GraphData['edges'] } | null>(null);

  const hasZoomedRef = useRef(false);

  const fetchGraph = useCallback(async () => {
    try {
      let graph: GraphData;
      if (viewMode === 'personal') {
        graph = await fetchAgentGraph(agentId);
      } else if (viewMode === 'shared') {
        graph = (await fetchSharedGraph()) as GraphData;
      } else {
        const [personal, shared] = await Promise.all([
          fetchAgentGraph(agentId),
          fetchSharedGraph() as Promise<GraphData>,
        ]);
        graph = mergeGraphs(personal, shared);
      }
      setRawData(graph);
      hasZoomedRef.current = false;
    } catch (err) {
      console.error('Failed to fetch graph:', err);
    }
  }, [agentId, viewMode]);

  // Initial + viewMode-change fetch
  useEffect(() => {
    setFocusNodeId(null);
    setFocusData(null);
    fetchGraph();
  }, [fetchGraph]);

  // WebSocket live updates
  const { connected } = useGraphWebSocket({
    agentId,
    enabled: true,
    onInit: (graph) => {
      setRawData(graph as GraphData);
      hasZoomedRef.current = false;
    },
    onUpdate: (graph) => setRawData(graph as GraphData),
  });

  // Rebuild
  const triggerRebuild = useCallback(async () => {
    setRebuilding(true);
    try {
      await rebuildAgentGraph(agentId);
      await fetchGraph();
    } finally {
      setRebuilding(false);
    }
  }, [agentId, fetchGraph]);

  // Focus mode — fetch ego-network via the existing neighbors endpoint
  const enterFocusMode = useCallback(async (nodeId: string, depth = 2) => {
    // For shared nodes strip the prefix to get actual node id
    const actualId = nodeId.startsWith('shared/') ? nodeId.slice(7) : nodeId;
    const vaultId = nodeId.startsWith('shared/') ? 'shared' : agentId;
    try {
      const result = await fetchNodeNeighbors(vaultId, actualId, depth);
      const nodes = (result.nodes as GraphNode[]).map((n) =>
        nodeId.startsWith('shared/')
          ? { ...n, id: `shared/${n.id}`, isShared: true }
          : n
      );
      const edges = result.edges.map((e) =>
        nodeId.startsWith('shared/')
          ? { ...e, source: `shared/${e.source}`, target: `shared/${e.target}` }
          : e
      );
      setFocusData({ nodes, edges });
      setFocusNodeId(nodeId);
    } catch (err) {
      console.error('Failed to enter focus mode:', err);
    }
  }, [agentId]);

  const exitFocusMode = useCallback(() => {
    setFocusNodeId(null);
    setFocusData(null);
  }, []);

  // Derived data — categories, orphans, degrees, neighbor map
  const { categories, orphanSet, degreeMap, neighborMap } = useMemo(() => {
    const source = rawData;
    if (!source) return { categories: [], orphanSet: new Set<string>(), degreeMap: new Map<string, number>(), neighborMap: new Map<string, Set<string>>() };

    const categories = Array.from(new Set(source.nodes.map((n) => n.category).filter(Boolean))).sort() as string[];
    const orphanSet = computeOrphans(source.nodes, source.edges);
    const degreeMap = new Map<string, number>();
    const neighborMap = new Map<string, Set<string>>();

    source.nodes.forEach((n) => {
      degreeMap.set(n.id, 0);
      neighborMap.set(n.id, new Set());
    });
    source.edges.forEach((e) => {
      degreeMap.set(e.source, (degreeMap.get(e.source) ?? 0) + 1);
      degreeMap.set(e.target, (degreeMap.get(e.target) ?? 0) + 1);
      neighborMap.get(e.source)?.add(e.target);
      neighborMap.get(e.target)?.add(e.source);
    });

    return { categories, orphanSet, degreeMap, neighborMap };
  }, [rawData]);

  // Apply filters to produce the renderable slice
  const filteredData = useMemo(() => {
    const source = focusData ?? (rawData ? { nodes: rawData.nodes, edges: rawData.edges } : null);
    if (!source) return null;

    let nodes = source.nodes;

    // Text search
    if (searchQuery) {
      const q = searchQuery.toLowerCase();
      nodes = nodes.filter(
        (n) =>
          n.title?.toLowerCase().includes(q) ||
          n.id.toLowerCase().includes(q) ||
          n.tags?.some((t) => t.toLowerCase().includes(q))
      );
    }

    // Category filter
    if (categoryFilter !== 'all') {
      nodes = nodes.filter((n) => n.category === categoryFilter);
    }

    // Orphan-only filter
    if (showOrphansOnly) {
      nodes = nodes.filter((n) => orphanSet.has(n.id));
    }

    // Timeline gate — only show nodes created before the slider timestamp
    if (timelineMax !== null) {
      nodes = nodes.filter((n) => !n.createdAt || n.createdAt <= timelineMax);
    }

    const nodeIds = new Set(nodes.map((n) => n.id));
    const edges = source.edges.filter(
      (e) => nodeIds.has(e.source) && nodeIds.has(e.target)
    );

    return { nodes, edges };
  }, [rawData, focusData, searchQuery, categoryFilter, showOrphansOnly, timelineMax, orphanSet]);

  return {
    rawData,
    filteredData,
    categories,
    orphanSet,
    degreeMap,
    neighborMap,
    connected,
    rebuilding,
    triggerRebuild,
    refetch: fetchGraph,
    enterFocusMode,
    exitFocusMode,
    focusNodeId,
  };
}
