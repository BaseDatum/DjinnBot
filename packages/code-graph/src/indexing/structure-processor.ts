/**
 * Structure Processor — creates File and Folder nodes from paths.
 *
 * Phase 1 of the indexing pipeline. Only needs the list of file paths,
 * no file content required.
 */

import { dirname } from 'node:path';
import type { KnowledgeGraph } from '../types/index.js';

/**
 * Create File and Folder nodes and wire CONTAINS relationships.
 */
export function processStructure(graph: KnowledgeGraph, filePaths: string[]): void {
  const folders = new Set<string>();

  // Create File nodes and collect all parent folders
  for (const fp of filePaths) {
    const name = fp.split('/').pop() || fp;
    graph.addNode({
      id: `File:${fp}`,
      label: 'File',
      properties: { name, filePath: fp },
    });

    // Walk up the directory tree
    let dir = dirname(fp);
    while (dir && dir !== '.' && dir !== '/') {
      folders.add(dir);
      dir = dirname(dir);
    }
  }

  // Create Folder nodes
  for (const folder of folders) {
    const name = folder.split('/').pop() || folder;
    graph.addNode({
      id: `Folder:${folder}`,
      label: 'Folder',
      properties: { name, filePath: folder },
    });
  }

  // Wire Folder → Folder CONTAINS edges
  for (const folder of folders) {
    const parent = dirname(folder);
    if (parent && parent !== '.' && parent !== '/' && folders.has(parent)) {
      graph.addRelationship({
        id: `${parent}_contains_${folder}`,
        sourceId: `Folder:${parent}`,
        targetId: `Folder:${folder}`,
        type: 'CONTAINS',
        confidence: 1.0,
        reason: 'filesystem',
      });
    }
  }

  // Wire Folder → File CONTAINS edges
  for (const fp of filePaths) {
    const dir = dirname(fp);
    if (dir && dir !== '.' && dir !== '/') {
      graph.addRelationship({
        id: `${dir}_contains_file_${fp}`,
        sourceId: `Folder:${dir}`,
        targetId: `File:${fp}`,
        type: 'CONTAINS',
        confidence: 1.0,
        reason: 'filesystem',
      });
    }
  }
}
