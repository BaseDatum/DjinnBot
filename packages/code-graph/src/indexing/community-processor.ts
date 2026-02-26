/**
 * Community Processor — detects functional clusters using Louvain algorithm.
 *
 * Phase 5a: Builds a Graphology graph from the knowledge graph's code symbols
 * and their relationships, then runs community detection to group related
 * symbols into clusters. Each cluster becomes a Community node.
 *
 * Uses Louvain (available in graphology-communities-louvain) for community
 * detection. Falls back to connected components if Louvain is not available.
 */

import Graph from 'graphology';
import type { KnowledgeGraph, GraphNode, NodeLabel } from '../types/index.js';

const CODE_LABELS = new Set<NodeLabel>([
  'Function', 'Class', 'Method', 'Interface', 'CodeElement',
  'Struct', 'Enum', 'Trait', 'Impl', 'Namespace', 'TypeAlias', 'Constructor',
]);

const STRUCTURAL_EDGE_TYPES = new Set(['CALLS', 'IMPORTS', 'EXTENDS', 'IMPLEMENTS']);

export interface CommunityResult {
  communities: Array<{
    id: string;
    label: string;
    heuristicLabel: string;
    cohesion: number;
    symbolCount: number;
  }>;
  memberships: Array<{
    nodeId: string;
    communityId: string;
  }>;
  stats: {
    totalCommunities: number;
    modularity: number;
  };
}

/**
 * Detect code communities via connected-component analysis with
 * heuristic labeling based on file paths and symbol names.
 */
export async function processCommunities(
  graph: KnowledgeGraph,
  onProgress?: (message: string, progress: number) => void,
): Promise<CommunityResult> {
  onProgress?.('Building community graph...', 0);

  // Build a graphology graph from code symbols
  const g = new Graph({ type: 'undirected', multi: false });

  // Add code symbol nodes
  const codeNodes: GraphNode[] = [];
  graph.forEachNode(node => {
    if (CODE_LABELS.has(node.label)) {
      codeNodes.push(node);
      g.addNode(node.id, { label: node.label, filePath: node.properties.filePath });
    }
  });

  onProgress?.(`Added ${codeNodes.length} symbols to community graph`, 0.2);

  // Add edges
  graph.forEachRelationship(rel => {
    if (!STRUCTURAL_EDGE_TYPES.has(rel.type)) return;
    if (g.hasNode(rel.sourceId) && g.hasNode(rel.targetId) && rel.sourceId !== rel.targetId) {
      try {
        g.addEdge(rel.sourceId, rel.targetId, { weight: rel.confidence });
      } catch {
        // Duplicate edge — ignore
      }
    }
  });

  onProgress?.('Running community detection...', 0.4);

  // Use connected components as community detection
  // (Louvain requires additional dep; connected components are a reliable baseline)
  const communityMap = detectCommunitiesViaComponents(g);

  onProgress?.('Labeling communities...', 0.7);

  // Group nodes by community
  const communityGroups = new Map<number, string[]>();
  for (const [nodeId, communityIdx] of communityMap) {
    const group = communityGroups.get(communityIdx) || [];
    group.push(nodeId);
    communityGroups.set(communityIdx, group);
  }

  // Build community results
  const communities: CommunityResult['communities'] = [];
  const memberships: CommunityResult['memberships'] = [];

  let idx = 0;
  for (const [communityIdx, members] of communityGroups) {
    // Skip tiny communities (noise)
    if (members.length < 2) continue;

    const communityId = `community_${idx}`;

    // Heuristic label from file paths and symbol names
    const heuristicLabel = generateHeuristicLabel(members, graph);

    // Compute cohesion (ratio of internal edges to possible edges)
    const internalEdges = countInternalEdges(members, g);
    const possibleEdges = members.length * (members.length - 1) / 2;
    const cohesion = possibleEdges > 0 ? internalEdges / possibleEdges : 0;

    communities.push({
      id: communityId,
      label: `Community ${idx}`,
      heuristicLabel,
      cohesion,
      symbolCount: members.length,
    });

    for (const nodeId of members) {
      memberships.push({ nodeId, communityId });
    }

    idx++;
  }

  onProgress?.(`Detected ${communities.length} communities`, 1.0);

  return {
    communities,
    memberships,
    stats: {
      totalCommunities: communities.length,
      modularity: 0, // Would need Louvain for real modularity score
    },
  };
}

/**
 * Simple connected-component detection.
 * Returns a map of nodeId → communityIndex.
 */
function detectCommunitiesViaComponents(g: Graph): Map<string, number> {
  const visited = new Set<string>();
  const communityMap = new Map<string, number>();
  let communityIdx = 0;

  for (const nodeId of g.nodes()) {
    if (visited.has(nodeId)) continue;

    // BFS from this node
    const queue = [nodeId];
    visited.add(nodeId);

    while (queue.length > 0) {
      const current = queue.shift()!;
      communityMap.set(current, communityIdx);

      for (const neighbor of g.neighbors(current)) {
        if (!visited.has(neighbor)) {
          visited.add(neighbor);
          queue.push(neighbor);
        }
      }
    }

    communityIdx++;
  }

  return communityMap;
}

/**
 * Generate a human-readable label for a community based on file paths.
 */
function generateHeuristicLabel(memberIds: string[], graph: KnowledgeGraph): string {
  // Collect file paths and extract directory names
  const dirCounts = new Map<string, number>();
  const nameParts = new Map<string, number>();

  for (const nodeId of memberIds) {
    const node = graph.getNode(nodeId);
    if (!node) continue;

    const fp = node.properties.filePath;
    if (fp) {
      const parts = fp.split('/');
      // Count directory occurrences
      for (let i = 0; i < parts.length - 1; i++) {
        const dir = parts[i];
        if (dir && !['src', 'lib', 'app', 'pkg', 'internal', 'cmd'].includes(dir)) {
          dirCounts.set(dir, (dirCounts.get(dir) || 0) + 1);
        }
      }
    }

    // Count name parts (split camelCase/snake_case)
    const name = node.properties.name.split('.').pop() || '';
    const words = name
      .replace(/([A-Z])/g, ' $1')
      .replace(/[_-]/g, ' ')
      .toLowerCase()
      .split(/\s+/)
      .filter(w => w.length > 2);
    for (const word of words) {
      nameParts.set(word, (nameParts.get(word) || 0) + 1);
    }
  }

  // Pick the most common directory name
  let bestDir = '';
  let bestDirCount = 0;
  for (const [dir, count] of dirCounts) {
    if (count > bestDirCount) {
      bestDirCount = count;
      bestDir = dir;
    }
  }

  if (bestDir) {
    return bestDir.charAt(0).toUpperCase() + bestDir.slice(1);
  }

  // Fallback: most common name part
  let bestPart = '';
  let bestPartCount = 0;
  for (const [part, count] of nameParts) {
    if (count > bestPartCount) {
      bestPartCount = count;
      bestPart = part;
    }
  }

  return bestPart
    ? bestPart.charAt(0).toUpperCase() + bestPart.slice(1)
    : `Group ${memberIds.length}`;
}

function countInternalEdges(members: string[], g: Graph): number {
  const memberSet = new Set(members);
  let count = 0;
  for (const nodeId of members) {
    if (!g.hasNode(nodeId)) continue;
    for (const neighbor of g.neighbors(nodeId)) {
      if (memberSet.has(neighbor)) {
        count++;
      }
    }
  }
  return count / 2; // Each edge counted twice in undirected graph
}
