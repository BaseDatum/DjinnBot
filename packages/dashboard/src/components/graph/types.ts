/** Shared types for the memory graph system. */

export type GraphViewMode = 'personal' | 'shared' | 'combined';

/** Which rendering mode to use for the graph canvas. */
export type GraphDimension = '2d' | '3d';

/** How the Z-axis is used in 3D mode. */
export type ZAxisMode = 'force' | 'vault' | 'type' | 'time';

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
  /** Runtime physics fields injected by ForceGraph2D / ForceGraph3D */
  x?: number;
  y?: number;
  z?: number;
  vx?: number;
  vy?: number;
  vz?: number;
  fx?: number | null;
  fy?: number | null;
  fz?: number | null;
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

/** A link as understood by ForceGraph2D/3D (source/target can be resolved to objects). */
export interface ForceLink {
  source: GraphNode | string;
  target: GraphNode | string;
  type?: string;
  label?: string;
}

/** Z-axis mode descriptors for the UI. */
export const Z_AXIS_MODES: { value: ZAxisMode; label: string; description: string }[] = [
  { value: 'force', label: 'Free', description: 'Physics-driven 3D layout' },
  { value: 'vault', label: 'Vault', description: 'Personal below, shared above' },
  { value: 'type', label: 'Type', description: 'Layered by memory type' },
  { value: 'time', label: 'Time', description: 'Oldest at bottom, newest on top' },
];

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
