/**
 * @djinnbot/code-graph — Code Knowledge Graph
 *
 * Indexes any codebase into a searchable knowledge graph with
 * Tree-sitter AST parsing, community detection, and execution flow tracing.
 */

// Types
export type {
  NodeLabel,
  NodeProperties,
  GraphNode,
  RelationshipType,
  GraphRelationship,
  KnowledgeGraph,
  PipelinePhase,
  PipelineProgress,
  PipelineResult,
  SearchResult,
  ProcessSearchResult,
  ContextResult,
  ImpactResult,
  ChangesResult,
  IndexStatus,
} from './types/index.js';

// Graph
export { createKnowledgeGraph } from './graph/knowledge-graph.js';

// Pipeline
export { runPipeline } from './indexing/pipeline.js';

// Storage
export { createKuzuStore, type KuzuStore } from './storage/kuzu-adapter.js';

// Language support
export {
  getLanguageFromFilename,
  SUPPORTED_EXTENSIONS,
  type SupportedLanguage,
} from './indexing/language-support.js';
