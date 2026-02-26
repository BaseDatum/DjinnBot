/**
 * Resolution Processor — resolves imports, calls, and heritage into graph edges.
 *
 * Phase 3-4: Takes extracted imports/calls/heritage from the parsing phase
 * and resolves them into IMPORTS, CALLS, EXTENDS, IMPLEMENTS edges with
 * confidence scoring.
 */

import { dirname, join, resolve, extname } from 'node:path';
import type { KnowledgeGraph, RelationshipType } from '../types/index.js';
import type { SymbolTable } from './symbol-table.js';
import type { ExtractedImport, ExtractedCall, ExtractedHeritage } from './parsing-processor.js';

/**
 * Resolve import statements into IMPORTS edges.
 */
export function resolveImports(
  graph: KnowledgeGraph,
  imports: ExtractedImport[],
  symbolTable: SymbolTable,
  allPaths: string[],
): void {
  // Build suffix index for path resolution
  const suffixIndex = buildSuffixIndex(allPaths);

  for (const imp of imports) {
    const sourceFileId = `File:${imp.filePath}`;

    // Try to resolve the import source to a file in the repo
    const resolvedFile = resolveImportPath(imp.importedFrom, imp.filePath, suffixIndex, allPaths);
    if (!resolvedFile) continue;

    // Try to find the specific symbol in the target file
    const targetSymbol = symbolTable.lookupExact(imp.importedName, resolvedFile);
    if (targetSymbol) {
      graph.addRelationship({
        id: `import_${imp.filePath}_${imp.importedName}_${resolvedFile}`,
        sourceId: sourceFileId,
        targetId: targetSymbol.nodeId,
        type: 'IMPORTS',
        confidence: 1.0,
        reason: 'import-resolved',
      });
    } else {
      // Link file-to-file if we can't resolve the symbol
      const targetFileId = `File:${resolvedFile}`;
      if (graph.getNode(targetFileId)) {
        graph.addRelationship({
          id: `import_file_${imp.filePath}_${resolvedFile}`,
          sourceId: sourceFileId,
          targetId: targetFileId,
          type: 'IMPORTS',
          confidence: 0.7,
          reason: 'file-level',
        });
      }
    }
  }
}

/**
 * Resolve call sites into CALLS edges with confidence scoring.
 */
export function resolveCalls(
  graph: KnowledgeGraph,
  calls: ExtractedCall[],
  symbolTable: SymbolTable,
): void {
  for (const call of calls) {
    // Strip member access to get the function name
    const calleeName = call.calleeName.includes('.')
      ? call.calleeName.split('.').pop()!
      : call.calleeName;

    // Find caller node
    const callerCandidates = symbolTable.lookupByName(call.callerName)
      .filter(s => s.filePath === call.callerFile);
    const caller = callerCandidates[0];
    if (!caller) continue;

    // Find callee candidates
    const calleeCandidates = symbolTable.lookupByName(calleeName);
    if (calleeCandidates.length === 0) continue;

    // Score candidates by proximity
    let bestMatch = calleeCandidates[0];
    let bestConfidence = 0.5;

    for (const candidate of calleeCandidates) {
      let confidence = 0.5;

      // Same file = high confidence
      if (candidate.filePath === call.callerFile) {
        confidence = 0.95;
      }
      // Exported symbol = medium-high confidence
      else if (candidate.isExported) {
        confidence = 0.8;
      }
      // Exact name match with dot accessor (method call) = bump
      if (call.calleeName.includes('.') && candidate.name.includes('.')) {
        confidence = Math.min(confidence + 0.1, 1.0);
      }

      if (confidence > bestConfidence) {
        bestConfidence = confidence;
        bestMatch = candidate;
      }
    }

    graph.addRelationship({
      id: `call_${caller.nodeId}_${bestMatch.nodeId}_${call.line}`,
      sourceId: caller.nodeId,
      targetId: bestMatch.nodeId,
      type: 'CALLS',
      confidence: bestConfidence,
      reason: bestConfidence >= 0.9 ? 'same-file' : bestConfidence >= 0.7 ? 'import-resolved' : 'fuzzy-global',
    });
  }
}

/**
 * Resolve heritage (extends/implements) into edges.
 */
export function resolveHeritage(
  graph: KnowledgeGraph,
  heritage: ExtractedHeritage[],
  symbolTable: SymbolTable,
): void {
  for (const h of heritage) {
    const childCandidates = symbolTable.lookupByName(h.childName)
      .filter(s => s.filePath === h.filePath);
    const child = childCandidates[0];
    if (!child) continue;

    const parentCandidates = symbolTable.lookupByName(h.parentName);
    if (parentCandidates.length === 0) continue;

    // Prefer same-file, then exported, then first match
    const parent = parentCandidates.find(p => p.filePath === h.filePath)
      || parentCandidates.find(p => p.isExported)
      || parentCandidates[0];

    const edgeType: RelationshipType = h.type === 'extends' ? 'EXTENDS' : 'IMPLEMENTS';
    const confidence = parent.filePath === h.filePath ? 1.0 : 0.85;

    graph.addRelationship({
      id: `${h.type}_${child.nodeId}_${parent.nodeId}`,
      sourceId: child.nodeId,
      targetId: parent.nodeId,
      type: edgeType,
      confidence,
      reason: parent.filePath === h.filePath ? 'same-file' : 'cross-file',
    });
  }
}

// ── Helpers ─────────────────────────────────────────────────────────────────

type SuffixIndex = Map<string, string[]>;

function buildSuffixIndex(paths: string[]): SuffixIndex {
  const index = new Map<string, string[]>();
  for (const p of paths) {
    // Index by filename and by last 2 segments
    const segments = p.split('/');
    const filename = segments[segments.length - 1];
    const stemmed = filename.replace(/\.(ts|tsx|js|jsx|mjs|cjs|py|go|rs|java|c|cpp|cc|h|hpp)$/, '');

    for (const key of [filename, stemmed]) {
      const existing = index.get(key) || [];
      existing.push(p);
      index.set(key, existing);
    }

    // Index by last two path segments (e.g., "services/auth")
    if (segments.length >= 2) {
      const twoSeg = segments.slice(-2).join('/');
      const stemmedTwo = twoSeg.replace(/\.(ts|tsx|js|jsx|mjs|cjs|py|go|rs|java|c|cpp|cc|h|hpp)$/, '');
      for (const key of [twoSeg, stemmedTwo]) {
        const existing = index.get(key) || [];
        existing.push(p);
        index.set(key, existing);
      }
    }
  }
  return index;
}

function resolveImportPath(
  importFrom: string,
  importerFile: string,
  suffixIndex: SuffixIndex,
  allPaths: string[],
): string | null {
  // Skip external imports (no ./ or ../ prefix and not in project)
  if (!importFrom.startsWith('.') && !importFrom.startsWith('/')) {
    // Could be a bare module specifier — try suffix match
    const parts = importFrom.split('/');
    const lastPart = parts[parts.length - 1];
    const candidates = suffixIndex.get(lastPart);
    if (candidates && candidates.length === 1) {
      return candidates[0];
    }
    return null;
  }

  // Relative import resolution
  const importerDir = dirname(importerFile);
  const resolved = join(importerDir, importFrom).replace(/\\/g, '/');

  // Try exact match
  if (allPaths.includes(resolved)) return resolved;

  // Try with common extensions
  const extensions = ['.ts', '.tsx', '.js', '.jsx', '.py', '.go', '.rs', '.java'];
  for (const ext of extensions) {
    const withExt = resolved + ext;
    if (allPaths.includes(withExt)) return withExt;
  }

  // Try /index.ts, /index.js
  for (const indexFile of ['index.ts', 'index.tsx', 'index.js', 'index.jsx', '__init__.py', 'mod.rs']) {
    const withIndex = `${resolved}/${indexFile}`;
    if (allPaths.includes(withIndex)) return withIndex;
  }

  return null;
}
