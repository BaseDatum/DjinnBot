/**
 * Process Processor — detects execution flows (call chains).
 *
 * Phase 5b: Identifies entry points (high in-degree from imports, low out-degree
 * to other modules, or explicitly named patterns like main/handler/route) and
 * traces call chains from them to build Process nodes.
 */

import type { KnowledgeGraph, GraphNode, NodeLabel } from '../types/index.js';

const CODE_LABELS = new Set<NodeLabel>([
  'Function', 'Class', 'Method', 'Interface', 'CodeElement',
  'Struct', 'Enum', 'Trait', 'Impl', 'Constructor',
]);

/** Entry point name patterns. */
const ENTRY_POINT_PATTERNS = [
  /^main$/i,
  /^handler/i,
  /^route/i,
  /^middleware/i,
  /^serve/i,
  /^listen/i,
  /^app$/i,
  /^index$/i,
  /^init/i,
  /^bootstrap/i,
  /^setup/i,
  /^register/i,
  /^create.*server/i,
  /^create.*app/i,
  /^handle.*request/i,
];

export interface ProcessResult {
  processes: Array<{
    id: string;
    label: string;
    heuristicLabel: string;
    processType: 'intra_community' | 'cross_community';
    stepCount: number;
    communities: string[];
    entryPointId: string;
    terminalId: string;
  }>;
  steps: Array<{
    nodeId: string;
    processId: string;
    step: number;
  }>;
  stats: {
    totalProcesses: number;
    crossCommunityCount: number;
  };
}

export async function processProcesses(
  graph: KnowledgeGraph,
  memberships: Array<{ nodeId: string; communityId: string }>,
  onProgress?: (message: string, progress: number) => void,
  options?: { maxProcesses?: number; minSteps?: number },
): Promise<ProcessResult> {
  const maxProcesses = options?.maxProcesses ?? 100;
  const minSteps = options?.minSteps ?? 3;

  onProgress?.('Scoring entry points...', 0);

  // Build adjacency lists for CALLS edges
  const callers = new Map<string, string[]>(); // target → [callers]
  const callees = new Map<string, string[]>(); // source → [callees]

  graph.forEachRelationship(rel => {
    if (rel.type !== 'CALLS') return;
    const sources = callers.get(rel.targetId) || [];
    sources.push(rel.sourceId);
    callers.set(rel.targetId, sources);

    const targets = callees.get(rel.sourceId) || [];
    targets.push(rel.targetId);
    callees.set(rel.sourceId, targets);
  });

  // Build community membership lookup
  const nodeCommunity = new Map<string, string>();
  for (const m of memberships) {
    nodeCommunity.set(m.nodeId, m.communityId);
  }

  // Score entry points
  const entryPoints: Array<{ nodeId: string; score: number; reason: string }> = [];

  graph.forEachNode(node => {
    if (!CODE_LABELS.has(node.label)) return;

    let score = 0;
    let reason = '';

    // Name pattern matching
    const name = node.properties.name.split('.').pop() || '';
    for (const pattern of ENTRY_POINT_PATTERNS) {
      if (pattern.test(name)) {
        score += 3;
        reason = 'name-pattern';
        break;
      }
    }

    // High in-degree from IMPORTS = likely entry point
    const incomingCallers = callers.get(node.id) || [];
    if (incomingCallers.length === 0 && (callees.get(node.id) || []).length > 0) {
      // No callers but has callees → root of a call chain
      score += 2;
      reason = reason || 'no-callers';
    }

    // Exported + has callees = likely entry point
    if (node.properties.isExported && (callees.get(node.id) || []).length > 1) {
      score += 1;
      reason = reason || 'exported-with-callees';
    }

    if (score > 0) {
      entryPoints.push({ nodeId: node.id, score, reason });
    }
  });

  // Sort by score descending, take top N
  entryPoints.sort((a, b) => b.score - a.score);
  const topEntries = entryPoints.slice(0, maxProcesses * 2);

  onProgress?.(`Found ${topEntries.length} entry point candidates`, 0.3);

  // Trace call chains from each entry point
  const processes: ProcessResult['processes'] = [];
  const steps: ProcessResult['steps'] = [];
  const usedNodes = new Set<string>();

  for (const entry of topEntries) {
    if (processes.length >= maxProcesses) break;

    const chain = traceCallChain(entry.nodeId, callees, usedNodes, 20);
    if (chain.length < minSteps) continue;

    const processId = `process_${processes.length}`;

    // Determine if cross-community
    const communities = new Set<string>();
    for (const nodeId of chain) {
      const comm = nodeCommunity.get(nodeId);
      if (comm) communities.add(comm);
    }

    const processType = communities.size > 1 ? 'cross_community' as const : 'intra_community' as const;

    // Generate heuristic label from entry + terminal
    const entryNode = graph.getNode(entry.nodeId);
    const terminalNode = graph.getNode(chain[chain.length - 1]);
    const entryName = entryNode?.properties.name.split('.').pop() || 'Unknown';
    const terminalName = terminalNode?.properties.name.split('.').pop() || '';
    const heuristicLabel = terminalName && terminalName !== entryName
      ? `${entryName} → ${terminalName}`
      : `${entryName} Flow`;

    processes.push({
      id: processId,
      label: `Process ${processes.length}`,
      heuristicLabel,
      processType,
      stepCount: chain.length,
      communities: [...communities],
      entryPointId: entry.nodeId,
      terminalId: chain[chain.length - 1],
    });

    for (let i = 0; i < chain.length; i++) {
      steps.push({
        nodeId: chain[i],
        processId,
        step: i + 1,
      });
      usedNodes.add(chain[i]);
    }
  }

  const crossCommunityCount = processes.filter(p => p.processType === 'cross_community').length;

  onProgress?.(`Detected ${processes.length} processes (${crossCommunityCount} cross-community)`, 1.0);

  return {
    processes,
    steps,
    stats: {
      totalProcesses: processes.length,
      crossCommunityCount,
    },
  };
}

/**
 * Trace a call chain from an entry point using DFS.
 * Avoids cycles and already-used nodes.
 */
function traceCallChain(
  entryId: string,
  callees: Map<string, string[]>,
  usedNodes: Set<string>,
  maxDepth: number,
): string[] {
  const chain: string[] = [];
  const visited = new Set<string>();

  function dfs(nodeId: string, depth: number) {
    if (depth > maxDepth) return;
    if (visited.has(nodeId)) return;

    visited.add(nodeId);
    chain.push(nodeId);

    const targets = callees.get(nodeId) || [];
    // Prefer targets not yet used in other processes
    const sorted = targets.sort((a, b) => {
      const aUsed = usedNodes.has(a) ? 1 : 0;
      const bUsed = usedNodes.has(b) ? 1 : 0;
      return aUsed - bUsed;
    });

    // Follow the first unexplored branch (longest-path heuristic)
    for (const target of sorted) {
      if (!visited.has(target)) {
        dfs(target, depth + 1);
        break; // Only follow one branch for linear process traces
      }
    }
  }

  dfs(entryId, 0);
  return chain;
}
