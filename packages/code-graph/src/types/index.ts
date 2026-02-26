/**
 * Code Knowledge Graph — Type Definitions
 *
 * Graph schema inspired by GitNexus but built from scratch.
 * Uses separate node types + a single CodeRelation edge table with
 * a `type` discriminator for natural Cypher queries.
 */

// ── Node Types ──────────────────────────────────────────────────────────────

export type NodeLabel =
  | 'File'
  | 'Folder'
  | 'Function'
  | 'Class'
  | 'Method'
  | 'Interface'
  | 'CodeElement'
  | 'Community'
  | 'Process'
  // Multi-language
  | 'Struct'
  | 'Enum'
  | 'Trait'
  | 'Impl'
  | 'Namespace'
  | 'TypeAlias'
  | 'Constructor';

export interface NodeProperties {
  name: string;
  filePath: string;
  startLine?: number;
  endLine?: number;
  language?: string;
  isExported?: boolean;
  content?: string;
  // Community-specific
  heuristicLabel?: string;
  cohesion?: number;
  symbolCount?: number;
  // Process-specific
  processType?: 'intra_community' | 'cross_community';
  stepCount?: number;
  communities?: string[];
  entryPointId?: string;
  terminalId?: string;
  // Entry point scoring
  entryPointScore?: number;
  entryPointReason?: string;
}

export interface GraphNode {
  id: string;
  label: NodeLabel;
  properties: NodeProperties;
}

// ── Relationship Types ──────────────────────────────────────────────────────

export type RelationshipType =
  | 'CONTAINS'
  | 'DEFINES'
  | 'CALLS'
  | 'IMPORTS'
  | 'EXTENDS'
  | 'IMPLEMENTS'
  | 'MEMBER_OF'
  | 'STEP_IN_PROCESS';

export interface GraphRelationship {
  id: string;
  sourceId: string;
  targetId: string;
  type: RelationshipType;
  /** 0-1 confidence score. 1.0 = certain, lower = fuzzy match. */
  confidence: number;
  /** Resolution reason: 'import-resolved', 'same-file', 'fuzzy-global', etc. */
  reason: string;
  /** Step number for STEP_IN_PROCESS (1-indexed). */
  step?: number;
}

// ── Knowledge Graph Interface ───────────────────────────────────────────────

export interface KnowledgeGraph {
  readonly nodeCount: number;
  readonly relationshipCount: number;

  addNode(node: GraphNode): void;
  addRelationship(rel: GraphRelationship): void;
  getNode(id: string): GraphNode | undefined;
  removeNode(nodeId: string): boolean;
  removeNodesByFile(filePath: string): number;

  forEachNode(fn: (node: GraphNode) => void): void;
  forEachRelationship(fn: (rel: GraphRelationship) => void): void;

  /** Get all nodes as an array (for serialization). */
  getNodes(): GraphNode[];
  /** Get all relationships as an array (for serialization). */
  getRelationships(): GraphRelationship[];
}

// ── Pipeline Types ──────────────────────────────────────────────────────────

export type PipelinePhase =
  | 'scanning'
  | 'structure'
  | 'parsing'
  | 'imports'
  | 'calls'
  | 'heritage'
  | 'communities'
  | 'processes'
  | 'search'
  | 'storing'
  | 'complete';

export interface PipelineProgress {
  phase: PipelinePhase;
  percent: number;
  message: string;
  detail?: string;
  stats?: {
    filesProcessed: number;
    totalFiles: number;
    nodesCreated: number;
  };
}

export interface PipelineResult {
  graph: KnowledgeGraph;
  repoPath: string;
  totalFileCount: number;
  nodeCount: number;
  relationshipCount: number;
  communityCount: number;
  processCount: number;
}

// ── Search Types ────────────────────────────────────────────────────────────

export interface SearchResult {
  nodeId: string;
  name: string;
  label: NodeLabel;
  filePath: string;
  startLine?: number;
  endLine?: number;
  score: number;
  sources: ('bm25' | 'semantic')[];
}

export interface ProcessSearchResult {
  processId: string;
  processLabel: string;
  processType: string;
  relevance: number;
  symbols: SearchResult[];
}

export interface ContextResult {
  symbol: GraphNode;
  incoming: {
    calls: Array<{ name: string; filePath: string; confidence: number }>;
    imports: Array<{ name: string; filePath: string }>;
    extends: Array<{ name: string; filePath: string }>;
    implements: Array<{ name: string; filePath: string }>;
  };
  outgoing: {
    calls: Array<{ name: string; filePath: string; confidence: number }>;
    imports: Array<{ name: string; filePath: string }>;
  };
  processes: Array<{
    processId: string;
    processLabel: string;
    step: number;
    totalSteps: number;
  }>;
  community?: {
    id: string;
    label: string;
    cohesion: number;
  };
}

export interface ImpactResult {
  target: GraphNode;
  risk: 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL';
  summary: {
    directDependents: number;
    affectedProcesses: number;
    affectedCommunities: number;
  };
  byDepth: Array<{
    depth: number;
    label: string;
    symbols: Array<{
      name: string;
      filePath: string;
      edgeType: RelationshipType;
      confidence: number;
    }>;
  }>;
  affectedProcesses: Array<{
    processId: string;
    processLabel: string;
    affectedStep: number;
  }>;
}

export interface ChangesResult {
  changedSymbols: Array<{
    name: string;
    filePath: string;
    label: NodeLabel;
    changeType: 'modified' | 'added' | 'deleted';
  }>;
  affectedProcesses: Array<{
    processId: string;
    processLabel: string;
  }>;
  riskLevel: 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL';
  summary: {
    changedCount: number;
    affectedCount: number;
    changedFiles: number;
  };
}

// ── Index Status ────────────────────────────────────────────────────────────

export interface IndexStatus {
  indexed: boolean;
  stale: boolean;
  nodeCount: number;
  relationshipCount: number;
  communityCount: number;
  processCount: number;
  lastIndexedAt: number | null;
  lastCommitHash: string | null;
  currentCommitHash: string | null;
}
