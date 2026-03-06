/**
 * Multi-Edit Tool — Apply multiple edits to a single file in one tool call.
 *
 * Reads the file once, applies edits sequentially (each edit operates on
 * the result of the previous), writes once. Uses the fuzzy matching cascade
 * for resilient replacement.
 *
 * This is an AgentTool that auto-classifies as PTC, so agents can call it
 * from exec_code as: multiedit(path="src/main.ts", edits=[...])
 */

import { Type, type Static } from '@sinclair/typebox';
import type { AgentTool, AgentToolResult } from '@mariozechner/pi-agent-core';
import { readFile, writeFile, access } from 'node:fs/promises';
import { constants } from 'node:fs';
import { resolve, isAbsolute } from 'node:path';
import { fuzzyReplace } from './fuzzy-edit.js';

// ── Schema ────────────────────────────────────────────────────────────────

const EditEntry = Type.Object({
  oldText: Type.String({ description: 'Text to find and replace' }),
  newText: Type.String({ description: 'Replacement text' }),
  replaceAll: Type.Optional(Type.Boolean({ description: 'Replace all occurrences (default: false)' })),
});

const MultiEditParams = Type.Object({
  path: Type.String({ description: 'Path to the file to edit (relative or absolute)' }),
  edits: Type.Array(EditEntry, {
    description: 'Array of edit operations to apply sequentially. Each edit operates on the result of the previous.',
    minItems: 1,
  }),
});

type MultiEditInput = Static<typeof MultiEditParams>;

// ── Tool factory ──────────────────────────────────────────────────────────

export function createMultiEditTool(workspacePath: string): AgentTool {
  return {
    name: 'multiedit',
    label: 'multiedit',
    description:
      'Apply multiple edits to a single file in one call. Reads the file once, applies ' +
      'edits sequentially (each edit sees the result of the previous), writes once. ' +
      'More efficient than multiple separate edit calls. Uses fuzzy matching for resilience.',
    parameters: MultiEditParams,
    execute: async (
      _toolCallId: string,
      params: unknown,
    ): Promise<AgentToolResult<any>> => {
      const { path: filePath, edits } = params as MultiEditInput;
      const absolutePath = isAbsolute(filePath)
        ? filePath
        : resolve(workspacePath, filePath);

      // Verify file exists and is readable/writable
      try {
        await access(absolutePath, constants.R_OK | constants.W_OK);
      } catch {
        throw new Error(`File not found or not writable: ${filePath}`);
      }

      // Read file once
      const buffer = await readFile(absolutePath);
      let content = buffer.toString('utf-8');
      const originalContent = content;

      // Apply edits sequentially
      const results: Array<{ index: number; strategy: string; usedFuzzy: boolean }> = [];
      const errors: Array<{ index: number; error: string }> = [];

      for (let i = 0; i < edits.length; i++) {
        const edit = edits[i];
        try {
          const result = fuzzyReplace(content, edit.oldText, edit.newText, edit.replaceAll ?? false);
          content = result.newContent;
          results.push({ index: i, strategy: result.strategy, usedFuzzy: result.usedFuzzy });
        } catch (err) {
          errors.push({
            index: i,
            error: err instanceof Error ? err.message : String(err),
          });
          // Stop on first error — subsequent edits depend on previous
          break;
        }
      }

      // If we had errors, report them without writing
      if (errors.length > 0) {
        const applied = results.length;
        const failed = errors[0];
        throw new Error(
          `Edit ${failed.index + 1}/${edits.length} failed: ${failed.error}` +
          (applied > 0 ? ` (${applied} edit(s) were applied before failure — file NOT written)` : ''),
        );
      }

      // Verify content actually changed
      if (content === originalContent) {
        throw new Error('No changes made: all edits produced identical content.');
      }

      // Write file once
      await writeFile(absolutePath, content, 'utf-8');

      // Build summary
      const fuzzyCount = results.filter(r => r.usedFuzzy).length;
      const summary = [
        `Successfully applied ${results.length}/${edits.length} edit(s) to ${filePath}.`,
      ];
      if (fuzzyCount > 0) {
        summary.push(`${fuzzyCount} edit(s) used fuzzy matching.`);
      }

      return {
        content: [{ type: 'text', text: summary.join(' ') }],
        details: {
          editsApplied: results.length,
          totalEdits: edits.length,
          fuzzyMatches: fuzzyCount,
          strategies: results.map(r => r.strategy),
        },
      };
    },
  };
}
