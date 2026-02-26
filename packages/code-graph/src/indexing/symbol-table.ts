/**
 * Symbol Table — tracks all parsed symbols for cross-file resolution.
 *
 * Used during import and call resolution to look up symbols by name
 * and file path. Supports multi-definition disambiguation.
 */

import type { GraphNode, NodeLabel } from '../types/index.js';

export interface SymbolEntry {
  nodeId: string;
  name: string;
  label: NodeLabel;
  filePath: string;
  isExported: boolean;
}

export interface SymbolTable {
  register(entry: SymbolEntry): void;
  lookupByName(name: string): SymbolEntry[];
  lookupByFile(filePath: string): SymbolEntry[];
  lookupExact(name: string, filePath: string): SymbolEntry | undefined;
  clear(): void;
  readonly size: number;
}

export function createSymbolTable(): SymbolTable {
  /** name → entries (multiple files can define the same name). */
  const byName = new Map<string, SymbolEntry[]>();
  /** filePath → entries. */
  const byFile = new Map<string, SymbolEntry[]>();
  /** "name::filePath" → entry for exact lookup. */
  const exact = new Map<string, SymbolEntry>();

  return {
    register(entry) {
      const nameEntries = byName.get(entry.name) || [];
      nameEntries.push(entry);
      byName.set(entry.name, nameEntries);

      const fileEntries = byFile.get(entry.filePath) || [];
      fileEntries.push(entry);
      byFile.set(entry.filePath, fileEntries);

      exact.set(`${entry.name}::${entry.filePath}`, entry);
    },

    lookupByName(name) {
      return byName.get(name) || [];
    },

    lookupByFile(filePath) {
      return byFile.get(filePath) || [];
    },

    lookupExact(name, filePath) {
      return exact.get(`${name}::${filePath}`);
    },

    clear() {
      byName.clear();
      byFile.clear();
      exact.clear();
    },

    get size() {
      return exact.size;
    },
  };
}
