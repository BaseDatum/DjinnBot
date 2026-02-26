/**
 * Converts API graph-data JSON into a graphology Graph for Sigma.js.
 *
 * Handles:
 *  - Node positioning (hierarchy-based for structural, cluster-based for symbols)
 *  - Community colouring via golden-angle distribution
 *  - Edge curvature + per-type colours
 *  - Density-aware size scaling
 */

import Graph from 'graphology';
import {
  NODE_COLORS,
  NODE_SIZES,
  EDGE_STYLES,
  getCommunityColor,
} from './constants';

// ── Sigma attribute interfaces ─────────────────────────────────────────────

export interface SigmaNodeAttributes {
  x: number;
  y: number;
  size: number;
  color: string;
  label: string;
  nodeType: string;
  filePath: string;
  startLine?: number;
  language?: string;
  hidden?: boolean;
  zIndex?: number;
  highlighted?: boolean;
  community?: number;
  communityColor?: string;
}

export interface SigmaEdgeAttributes {
  size: number;
  color: string;
  relationType: string;
  type?: string;
  curvature?: number;
  hidden?: boolean;
}

// ── API types ──────────────────────────────────────────────────────────────

export interface APINode {
  id: string;
  name: string;
  filePath: string;
  startLine?: number;
  label: string;
  language?: string;
}

export interface APIEdge {
  sourceId: string;
  targetId: string;
  type: string;
  confidence: number;
  step?: number;
}

export interface APICommunity {
  id: string;
  label: string;
  cohesion: number;
  symbolCount: number;
}

export interface APIGraphData {
  nodes: APINode[];
  edges: APIEdge[];
  communities: APICommunity[];
  processes: Array<{ id: string; label: string; processType: string; stepCount: number }>;
}

// ── Helpers ────────────────────────────────────────────────────────────────

function scaledNodeSize(base: number, nodeCount: number): number {
  if (nodeCount > 50_000) return Math.max(1, base * 0.4);
  if (nodeCount > 20_000) return Math.max(1.5, base * 0.5);
  if (nodeCount > 5_000) return Math.max(2, base * 0.65);
  if (nodeCount > 1_000) return Math.max(2.5, base * 0.8);
  return base;
}

const STRUCTURAL = new Set(['Folder', 'Package', 'Module', 'Namespace']);
const SYMBOL_TYPES = new Set(['Function', 'Class', 'Method', 'Interface', 'Struct', 'Trait', 'Enum', 'Record', 'Delegate']);

// ── Main converter ─────────────────────────────────────────────────────────

export function apiGraphToGraphology(
  data: APIGraphData,
): Graph<SigmaNodeAttributes, SigmaEdgeAttributes> {
  const graph = new Graph<SigmaNodeAttributes, SigmaEdgeAttributes>();
  const nodeCount = data.nodes.length;
  if (nodeCount === 0) return graph;

  // Build community membership from MEMBER_OF edges
  const communityMemberships = new Map<string, number>();
  const communityIdToIndex = new Map<string, number>();
  data.communities.forEach((c, i) => communityIdToIndex.set(c.id, i));
  for (const edge of data.edges) {
    if (edge.type === 'MEMBER_OF') {
      const idx = communityIdToIndex.get(edge.targetId);
      if (idx !== undefined) communityMemberships.set(edge.sourceId, idx);
    }
  }

  // Build parent→children from hierarchy edges
  const parentToChildren = new Map<string, string[]>();
  const childToParent = new Map<string, string>();
  for (const edge of data.edges) {
    if (edge.type === 'CONTAINS' || edge.type === 'DEFINES') {
      if (!parentToChildren.has(edge.sourceId)) parentToChildren.set(edge.sourceId, []);
      parentToChildren.get(edge.sourceId)!.push(edge.targetId);
      childToParent.set(edge.targetId, edge.sourceId);
    }
  }

  // Build community cluster centres using golden angle
  const clusterCenters = new Map<number, { x: number; y: number }>();
  const structuralSpread = Math.sqrt(nodeCount) * 40;
  if (communityIdToIndex.size > 0) {
    const goldenAngle = Math.PI * (3 - Math.sqrt(5));
    const count = communityIdToIndex.size;
    const clusterSpread = structuralSpread * 0.8;
    let idx = 0;
    for (const [, ci] of communityIdToIndex) {
      const angle = idx * goldenAngle;
      const radius = clusterSpread * Math.sqrt((idx + 1) / count);
      clusterCenters.set(ci, { x: radius * Math.cos(angle), y: radius * Math.sin(angle) });
      idx++;
    }
  }

  const childJitter = Math.sqrt(nodeCount) * 3;
  const clusterJitter = Math.sqrt(nodeCount) * 1.5;

  // Node lookup
  const apiNodeMap = new Map(data.nodes.map(n => [n.id, n]));
  const nodePositions = new Map<string, { x: number; y: number }>();

  // Separate structural from other nodes
  const structuralNodes = data.nodes.filter(n => STRUCTURAL.has(n.label));
  const goldenAngle = Math.PI * (3 - Math.sqrt(5));

  // Position structural nodes first (wide radial)
  structuralNodes.forEach((node, index) => {
    const angle = index * goldenAngle;
    const radius = structuralSpread * Math.sqrt((index + 1) / Math.max(structuralNodes.length, 1));
    const jitter = structuralSpread * 0.15;
    const x = radius * Math.cos(angle) + (Math.random() - 0.5) * jitter;
    const y = radius * Math.sin(angle) + (Math.random() - 0.5) * jitter;
    nodePositions.set(node.id, { x, y });

    const base = NODE_SIZES[node.label] || 8;
    graph.addNode(node.id, {
      x, y,
      size: scaledNodeSize(base, nodeCount),
      color: NODE_COLORS[node.label] || '#9ca3af',
      label: node.name,
      nodeType: node.label,
      filePath: node.filePath,
      startLine: node.startLine,
      language: node.language,
      hidden: false,
    });
  });

  // BFS from structural → position children near parents (or near cluster centre)
  const addNode = (nodeId: string) => {
    if (graph.hasNode(nodeId)) return;
    const node = apiNodeMap.get(nodeId);
    if (!node) return;

    let x: number, y: number;
    const commIdx = communityMemberships.get(nodeId);
    const centre = commIdx !== undefined ? clusterCenters.get(commIdx) : null;

    if (centre && SYMBOL_TYPES.has(node.label)) {
      x = centre.x + (Math.random() - 0.5) * clusterJitter;
      y = centre.y + (Math.random() - 0.5) * clusterJitter;
    } else {
      const parentId = childToParent.get(nodeId);
      const parentPos = parentId ? nodePositions.get(parentId) : null;
      if (parentPos) {
        x = parentPos.x + (Math.random() - 0.5) * childJitter;
        y = parentPos.y + (Math.random() - 0.5) * childJitter;
      } else {
        x = (Math.random() - 0.5) * structuralSpread * 0.5;
        y = (Math.random() - 0.5) * structuralSpread * 0.5;
      }
    }
    nodePositions.set(nodeId, { x, y });

    const base = NODE_SIZES[node.label] || 4;
    const hasCommunity = commIdx !== undefined;
    const usesCommunityColor = hasCommunity && SYMBOL_TYPES.has(node.label);
    const color = usesCommunityColor ? getCommunityColor(commIdx!) : (NODE_COLORS[node.label] || '#9ca3af');

    graph.addNode(nodeId, {
      x, y,
      size: scaledNodeSize(base, nodeCount),
      color,
      label: node.name,
      nodeType: node.label,
      filePath: node.filePath,
      startLine: node.startLine,
      language: node.language,
      hidden: false,
      community: commIdx,
      communityColor: hasCommunity ? getCommunityColor(commIdx!) : undefined,
    });
  };

  // BFS walk
  const queue = structuralNodes.map(n => n.id);
  const visited = new Set(queue);
  while (queue.length > 0) {
    const cid = queue.shift()!;
    for (const child of (parentToChildren.get(cid) || [])) {
      if (!visited.has(child)) {
        visited.add(child);
        addNode(child);
        queue.push(child);
      }
    }
  }

  // Orphans
  for (const node of data.nodes) {
    if (!graph.hasNode(node.id)) addNode(node.id);
  }

  // Edges
  const edgeBaseSize = nodeCount > 20_000 ? 0.4 : nodeCount > 5_000 ? 0.6 : 1.0;
  for (const edge of data.edges) {
    if (!graph.hasNode(edge.sourceId) || !graph.hasNode(edge.targetId)) continue;
    if (graph.hasEdge(edge.sourceId, edge.targetId)) continue;

    const style = EDGE_STYLES[edge.type] || { color: '#4a4a5a', size: 0.5 };
    graph.addEdge(edge.sourceId, edge.targetId, {
      size: edgeBaseSize * style.size,
      color: style.color,
      relationType: edge.type,
      type: 'curved',
      curvature: 0.12 + Math.random() * 0.08,
    });
  }

  return graph;
}

// ── Filtering ──────────────────────────────────────────────────────────────

export function filterByLabels(
  graph: Graph<SigmaNodeAttributes, SigmaEdgeAttributes>,
  visibleLabels: Set<string>,
): void {
  graph.forEachNode((id, attrs) => {
    graph.setNodeAttribute(id, 'hidden', !visibleLabels.has(attrs.nodeType));
  });
}

export function filterByDepth(
  graph: Graph<SigmaNodeAttributes, SigmaEdgeAttributes>,
  selectedNodeId: string | null,
  maxHops: number | null,
  visibleLabels: Set<string>,
): void {
  if (!maxHops || !selectedNodeId || !graph.hasNode(selectedNodeId)) {
    filterByLabels(graph, visibleLabels);
    return;
  }

  const inRange = new Set<string>();
  const q: { id: string; depth: number }[] = [{ id: selectedNodeId, depth: 0 }];
  while (q.length) {
    const { id, depth } = q.shift()!;
    if (inRange.has(id)) continue;
    inRange.add(id);
    if (depth < maxHops) {
      graph.forEachNeighbor(id, nid => {
        if (!inRange.has(nid)) q.push({ id: nid, depth: depth + 1 });
      });
    }
  }

  graph.forEachNode((id, attrs) => {
    graph.setNodeAttribute(id, 'hidden', !visibleLabels.has(attrs.nodeType) || !inRange.has(id));
  });
}
