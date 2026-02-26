/**
 * Indexing Pipeline — orchestrates the full codebase indexing process.
 *
 * Phases:
 * 1. Scan — walk file tree
 * 2. Structure — create File/Folder nodes
 * 3. Parse — Tree-sitter AST extraction (chunked for memory efficiency)
 * 4. Resolve — imports, calls, heritage → graph edges
 * 5. Communities — Louvain/connected-component clustering
 * 6. Processes — execution flow detection
 * 7. Store — persist to KuzuDB
 */

import { join } from 'node:path';
import { createKnowledgeGraph } from '../graph/knowledge-graph.js';
import { walkRepositoryPaths, readFileContents } from './filesystem-walker.js';
import { processStructure } from './structure-processor.js';
import { createSymbolTable } from './symbol-table.js';
import { parseFiles } from './parsing-processor.js';
import { resolveImports, resolveCalls, resolveHeritage } from './resolution-processor.js';
import { processCommunities } from './community-processor.js';
import { processProcesses } from './process-processor.js';
import { createKuzuStore } from '../storage/kuzu-adapter.js';
import type { PipelineProgress, PipelineResult } from '../types/index.js';

/** Max bytes of source content per parsing chunk. */
const CHUNK_BYTE_BUDGET = 20 * 1024 * 1024; // 20MB

export async function runPipeline(
  repoPath: string,
  dbPath: string,
  onProgress: (progress: PipelineProgress) => void,
): Promise<PipelineResult> {
  const graph = createKnowledgeGraph();
  const symbolTable = createSymbolTable();

  // ── Phase 1: Scan ────────────────────────────────────────────────────
  onProgress({ phase: 'scanning', percent: 0, message: 'Scanning repository...' });

  const scannedFiles = await walkRepositoryPaths(repoPath, (current, total, filePath) => {
    onProgress({
      phase: 'scanning',
      percent: Math.round((current / total) * 10),
      message: 'Scanning repository...',
      detail: filePath,
      stats: { filesProcessed: current, totalFiles: total, nodesCreated: 0 },
    });
  });

  const totalFiles = scannedFiles.length;
  onProgress({ phase: 'scanning', percent: 10, message: `Found ${totalFiles} files` });

  // ── Phase 2: Structure ───────────────────────────────────────────────
  onProgress({ phase: 'structure', percent: 10, message: 'Analyzing project structure...' });

  const allPaths = scannedFiles.map(f => f.path);
  processStructure(graph, allPaths);

  onProgress({
    phase: 'structure', percent: 15,
    message: `Structure: ${graph.nodeCount} nodes`,
    stats: { filesProcessed: totalFiles, totalFiles, nodesCreated: graph.nodeCount },
  });

  // ── Phase 3: Parse (chunked) ─────────────────────────────────────────
  onProgress({ phase: 'parsing', percent: 15, message: `Parsing ${totalFiles} files...` });

  // Build byte-budget chunks
  const chunks: string[][] = [];
  let currentChunk: string[] = [];
  let currentBytes = 0;
  for (const file of scannedFiles) {
    if (currentChunk.length > 0 && currentBytes + file.size > CHUNK_BYTE_BUDGET) {
      chunks.push(currentChunk);
      currentChunk = [];
      currentBytes = 0;
    }
    currentChunk.push(file.path);
    currentBytes += file.size;
  }
  if (currentChunk.length > 0) chunks.push(currentChunk);

  const allImports: any[] = [];
  const allCalls: any[] = [];
  const allHeritage: any[] = [];
  let filesParsed = 0;

  for (let ci = 0; ci < chunks.length; ci++) {
    const chunkPaths = chunks[ci];
    const chunkContents = readFileContents(repoPath, chunkPaths);
    const chunkFiles = chunkPaths
      .filter(p => chunkContents.has(p))
      .map(p => ({ path: p, content: chunkContents.get(p)! }));

    const result = await parseFiles(graph, chunkFiles, symbolTable, (current, total, fp) => {
      const globalCurrent = filesParsed + current;
      const pct = 15 + ((globalCurrent / totalFiles) * 40);
      onProgress({
        phase: 'parsing', percent: Math.round(pct),
        message: `Parsing chunk ${ci + 1}/${chunks.length}...`,
        detail: fp,
        stats: { filesProcessed: globalCurrent, totalFiles, nodesCreated: graph.nodeCount },
      });
    });

    allImports.push(...result.imports);
    allCalls.push(...result.calls);
    allHeritage.push(...result.heritage);
    filesParsed += chunkFiles.length;
  }

  // ── Phase 4: Resolution ──────────────────────────────────────────────
  onProgress({ phase: 'imports', percent: 55, message: 'Resolving imports...' });
  resolveImports(graph, allImports, symbolTable, allPaths);

  onProgress({ phase: 'calls', percent: 62, message: 'Resolving function calls...' });
  resolveCalls(graph, allCalls, symbolTable);

  onProgress({ phase: 'heritage', percent: 68, message: 'Resolving class hierarchy...' });
  resolveHeritage(graph, allHeritage, symbolTable);

  // ── Phase 5: Communities ─────────────────────────────────────────────
  onProgress({ phase: 'communities', percent: 72, message: 'Detecting code communities...' });

  const communityResult = await processCommunities(graph, (msg, pct) => {
    onProgress({
      phase: 'communities', percent: 72 + Math.round(pct * 10),
      message: msg,
      stats: { filesProcessed: totalFiles, totalFiles, nodesCreated: graph.nodeCount },
    });
  });

  // Add community nodes + memberships to graph
  for (const comm of communityResult.communities) {
    graph.addNode({
      id: comm.id,
      label: 'Community',
      properties: {
        name: comm.label,
        filePath: '',
        heuristicLabel: comm.heuristicLabel,
        cohesion: comm.cohesion,
        symbolCount: comm.symbolCount,
      },
    });
  }
  for (const m of communityResult.memberships) {
    graph.addRelationship({
      id: `${m.nodeId}_member_of_${m.communityId}`,
      sourceId: m.nodeId,
      targetId: m.communityId,
      type: 'MEMBER_OF',
      confidence: 1.0,
      reason: 'community-detection',
    });
  }

  // ── Phase 6: Processes ───────────────────────────────────────────────
  onProgress({ phase: 'processes', percent: 82, message: 'Detecting execution flows...' });

  const processResult = await processProcesses(graph, communityResult.memberships, (msg, pct) => {
    onProgress({
      phase: 'processes', percent: 82 + Math.round(pct * 8),
      message: msg,
      stats: { filesProcessed: totalFiles, totalFiles, nodesCreated: graph.nodeCount },
    });
  });

  // Add process nodes + steps to graph
  for (const proc of processResult.processes) {
    graph.addNode({
      id: proc.id,
      label: 'Process',
      properties: {
        name: proc.label,
        filePath: '',
        heuristicLabel: proc.heuristicLabel,
        processType: proc.processType,
        stepCount: proc.stepCount,
        communities: proc.communities,
        entryPointId: proc.entryPointId,
        terminalId: proc.terminalId,
      },
    });
  }
  for (const step of processResult.steps) {
    graph.addRelationship({
      id: `${step.nodeId}_step_${step.step}_${step.processId}`,
      sourceId: step.nodeId,
      targetId: step.processId,
      type: 'STEP_IN_PROCESS',
      confidence: 1.0,
      reason: 'trace-detection',
      step: step.step,
    });
  }

  // ── Phase 7: Store to KuzuDB ─────────────────────────────────────────
  onProgress({ phase: 'storing', percent: 90, message: 'Persisting to KuzuDB...' });

  const store = await createKuzuStore(dbPath);
  await store.loadGraph(graph);
  store.close();

  // ── Done ─────────────────────────────────────────────────────────────
  onProgress({
    phase: 'complete', percent: 100,
    message: `Done! ${graph.nodeCount} nodes, ${graph.relationshipCount} edges, ${communityResult.communities.length} communities, ${processResult.processes.length} processes`,
    stats: { filesProcessed: totalFiles, totalFiles, nodesCreated: graph.nodeCount },
  });

  // Clean up
  symbolTable.clear();

  return {
    graph,
    repoPath,
    totalFileCount: totalFiles,
    nodeCount: graph.nodeCount,
    relationshipCount: graph.relationshipCount,
    communityCount: communityResult.communities.length,
    processCount: processResult.processes.length,
  };
}
