/** Shared types for the memory graph system. */

export type GraphViewMode = 'personal' | 'shared' | 'combined';

export interface GraphNode {
  id: string;
  title: string;
  type: string;
  category: string;
  path: string | null;
  tags: string[];
  missing: boolean;
  degree: number;
  createdAt?: number;
  /** Set to true for nodes originating from the shared vault */
  isShared?: boolean;
  /** Runtime physics fields injected by ForceGraph2D */
  x?: number;
  y?: number;
  vx?: number;
  vy?: number;
  fx?: number | null;
  fy?: number | null;
}

export interface GraphEdge {
  id: string;
  source: string;
  target: string;
  type: string;
  label?: string;
}

export interface GraphStats {
  nodeCount: number;
  edgeCount: number;
  nodeTypeCounts: Record<string, number>;
  edgeTypeCounts: Record<string, number>;
}

export interface GraphData {
  nodes: GraphNode[];
  edges: GraphEdge[];
  stats: GraphStats;
}

/** A link as understood by ForceGraph2D (source/target can be resolved to objects). */
export interface ForceLink {
  source: GraphNode | string;
  target: GraphNode | string;
  type?: string;
  label?: string;
}

export interface ContextMenuState {
  x: number;
  y: number;
  node: GraphNode | null;
  /** Canvas-space coordinates for newly-created nodes */
  graphX?: number;
  graphY?: number;
}

export interface FocusState {
  nodeId: string;
  depth: number;
}
