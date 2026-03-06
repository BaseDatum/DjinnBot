/**
 * In-memory Knowledge Graph implementation.
 *
 * Used as the intermediate representation during indexing.
 * After the pipeline completes, the graph is persisted to KuzuDB.
 */

import type { GraphNode, GraphRelationship, KnowledgeGraph } from '../types/index.js';

export function createKnowledgeGraph(): KnowledgeGraph {
  const nodeMap = new Map<string, GraphNode>();
  const relMap = new Map<string, GraphRelationship>();

  return {
    get nodeCount() {
      return nodeMap.size;
    },
    get relationshipCount() {
      return relMap.size;
    },

    addNode(node: GraphNode) {
      if (!nodeMap.has(node.id)) {
        nodeMap.set(node.id, node);
      }
    },

    addRelationship(rel: GraphRelationship) {
      if (!relMap.has(rel.id)) {
        relMap.set(rel.id, rel);
      }
    },

    getNode(id: string) {
      return nodeMap.get(id);
    },

    removeNode(nodeId: string): boolean {
      if (!nodeMap.has(nodeId)) return false;
      nodeMap.delete(nodeId);
      // Remove relationships involving this node
      for (const [relId, rel] of relMap) {
        if (rel.sourceId === nodeId || rel.targetId === nodeId) {
          relMap.delete(relId);
        }
      }
      return true;
    },

    removeNodesByFile(filePath: string): number {
      let removed = 0;
      for (const [nodeId, node] of nodeMap) {
        if (node.properties.filePath === filePath) {
          nodeMap.delete(nodeId);
          removed++;
        }
      }
      // Clean up orphaned relationships
      for (const [relId, rel] of relMap) {
        if (!nodeMap.has(rel.sourceId) || !nodeMap.has(rel.targetId)) {
          relMap.delete(relId);
        }
      }
      return removed;
    },

    forEachNode(fn) {
      nodeMap.forEach(fn);
    },

    forEachRelationship(fn) {
      relMap.forEach(fn);
    },

    getNodes() {
      return Array.from(nodeMap.values());
    },

    getRelationships() {
      return Array.from(relMap.values());
    },
  };
}
