import { Type, type Static } from '@sinclair/typebox';
import type { AgentTool, AgentToolResult, AgentToolUpdateCallback } from '@mariozechner/pi-agent-core';
import type { RedisPublisher } from '../../redis/publisher.js';
import { join, resolve } from 'node:path';
// @ts-ignore — clawvault is an ESM package declared in package.json; types resolve at build time
import { graphSummary, loadMemoryGraphIndex, buildOrUpdateMemoryGraphIndex, type MemoryGraph } from 'clawvault';

// ── Helpers ────────────────────────────────────────────────────────────────

/**
 * Read the graph index NON-DESTRUCTIVELY.
 *
 * The engine (packages/core/src/main.ts) builds graph-index.json via
 * `clawvault graph --refresh` and writes it to the vault's .clawvault/
 * directory.  The agent runtime runs inside a Docker container where vault
 * paths are symlinks into a shared volume.
 *
 * `getMemoryGraph` (from clawvault) calls `buildOrUpdateMemoryGraphIndex`
 * which unconditionally re-globs for *.md files and WRITES a new
 * graph-index.json — even if it finds zero files (e.g. symlink not yet
 * resolved, glob timing issue).  This overwrites the engine's good index
 * with an empty one, causing all subsequent graph queries to return no
 * results.
 *
 * Instead, we use `loadMemoryGraphIndex` (read-only — just reads the JSON
 * file) and only fall back to a full build when the index doesn't exist at
 * all (first-ever call before the engine has built one).
 */
function loadGraphSafe(vaultPath: string): MemoryGraph | null {
  const resolved = resolve(vaultPath);

  // 1. Try read-only load of the engine-built index
  const existing = loadMemoryGraphIndex(resolved);
  if (existing?.graph) {
    return existing.graph;
  }

  // 2. No index exists at all — build one (first-ever call).
  //    This write is acceptable because there's nothing to overwrite.
  //    Subsequent calls will hit the fast read-only path above.
  return null;
}

/**
 * Load graph, falling back to a full build only when no index exists.
 * The async fallback is separated so the common read-only path stays fast.
 */
async function getGraphReadOnly(vaultPath: string): Promise<MemoryGraph> {
  const graph = loadGraphSafe(vaultPath);
  if (graph) return graph;

  // Fallback: no index file exists yet — build one.
  const index = await buildOrUpdateMemoryGraphIndex(resolve(vaultPath));
  return index.graph;
}

// ── Schemas ────────────────────────────────────────────────────────────────

const GraphQueryParamsSchema = Type.Object({
  action: Type.Union([
    Type.Literal('summary'),
    Type.Literal('neighbors'),
    Type.Literal('search'),
  ], { description: 'Query action: "summary" for graph stats, "neighbors" for BFS traversal from a node, "search" to find nodes by title/tag' }),
  nodeId: Type.Optional(Type.String({ description: 'Node ID for neighbors action (e.g. "note:decisions/use-postgresql")' })),
  query: Type.Optional(Type.String({ description: 'Search term — matches against node titles, IDs, and tags (NOT full-text content — use the recall tool for content search)' })),
  maxHops: Type.Optional(Type.Number({ default: 1, description: 'Max hops for neighbors (1-3)' })),
  scope: Type.Optional(Type.Union([
    Type.Literal('personal'),
    Type.Literal('shared'),
    Type.Literal('all'),
  ], { default: 'all', description: 'Which vaults to query: "all" (default) searches both personal and shared, "shared" for team vault only, "personal" for your own graph only.' })),
});
type GraphQueryParams = Static<typeof GraphQueryParamsSchema>;

// ── Types ──────────────────────────────────────────────────────────────────

interface VoidDetails {}

export interface MemoryGraphToolsConfig {
  publisher: RedisPublisher;
  agentId: string;
  vaultPath: string;
  sharedPath: string;
}

// ── Tool factories ─────────────────────────────────────────────────────────

export function createMemoryGraphTools(config: MemoryGraphToolsConfig): AgentTool[] {
  const { publisher, agentId, vaultPath, sharedPath } = config;

  /** Return vault paths to query based on scope. */
  const vaultPathsForScope = (scope: string | undefined): { path: string; label: string }[] => {
    switch (scope) {
      case 'personal':
        return [{ path: vaultPath, label: 'Personal' }];
      case 'shared':
        return [{ path: sharedPath, label: 'Shared' }];
      case 'all':
      default:
        return [
          { path: vaultPath, label: 'Personal' },
          { path: sharedPath, label: 'Shared' },
        ];
    }
  };

  return [
    {
      name: 'graph_query',
      description:
        'Navigate your knowledge graph structure. Use this to explore how memories are connected — ' +
        'find nodes by title/tag, see neighbors, or get a graph summary. ' +
        'NOTE: This searches node TITLES, IDs, and TAGS only — for full-text content search, use the "recall" tool instead. ' +
        'For intelligent context retrieval that combines search + graph traversal, use the "context_query" tool.',
      label: 'graph_query',
      parameters: GraphQueryParamsSchema,
      execute: async (
        _toolCallId: string,
        params: unknown,
        _signal?: AbortSignal,
        _onUpdate?: AgentToolUpdateCallback<VoidDetails>
      ): Promise<AgentToolResult<VoidDetails>> => {
        const p = params as GraphQueryParams;
        const vaults = vaultPathsForScope(p.scope);

        try {
          switch (p.action) {
            case 'summary': {
              const sections: string[] = [];
              for (const v of vaults) {
                try {
                  const summary = await graphSummary({ vaultPath: v.path });
                  sections.push(`## ${v.label} Graph\n${JSON.stringify(summary, null, 2)}`);
                } catch (err) {
                  console.error(`[graph_query] ${v.label} summary failed for ${v.path}:`, err);
                  sections.push(`## ${v.label} Graph\nNo graph available.`);
                }
              }
              return { content: [{ type: 'text', text: sections.join('\n\n') }], details: {} };
            }

            case 'neighbors': {
              if (!p.nodeId) return { content: [{ type: 'text', text: 'nodeId required' }], details: {} };
              const maxHops = Math.min(p.maxHops || 1, 3);
              const sections: string[] = [];
              for (const v of vaults) {
                try {
                  const graph = await getGraphReadOnly(v.path);
                  const visited = new Set<string>();
                  let frontier = new Set<string>([p.nodeId]);
                  for (let hop = 0; hop < maxHops; hop++) {
                    const next = new Set<string>();
                    for (const nodeId of frontier) {
                      for (const edge of graph.edges) {
                        if (edge.source === nodeId && !visited.has(edge.target)) next.add(edge.target);
                        if (edge.target === nodeId && !visited.has(edge.source)) next.add(edge.source);
                      }
                      visited.add(nodeId);
                    }
                    frontier = next;
                    for (const n of next) visited.add(n);
                  }
                  visited.delete(p.nodeId);
                  const neighborNodes = graph.nodes.filter((n: any) => visited.has(n.id));
                  if (neighborNodes.length) {
                    const lines = neighborNodes.map((n: any) => `- [${n.type}] ${n.title} (id: ${n.id})`);
                    sections.push(`## ${v.label} Graph\n${lines.join('\n')}`);
                  } else {
                    sections.push(`## ${v.label} Graph\nNo neighbors found for node: ${p.nodeId}`);
                  }
                } catch (err) {
                  console.error(`[graph_query] ${v.label} neighbors failed for ${v.path}:`, err);
                  sections.push(`## ${v.label} Graph\nNo graph available.`);
                }
              }
              return { content: [{ type: 'text', text: sections.join('\n\n') }], details: {} };
            }

            case 'search': {
              if (!p.query) return { content: [{ type: 'text', text: 'query required' }], details: {} };
              const needle = p.query.toLowerCase();
              const sections: string[] = [];
              for (const v of vaults) {
                try {
                  const graph = await getGraphReadOnly(v.path);
                  const matches = graph.nodes.filter((n: any) =>
                    n.title.toLowerCase().includes(needle) ||
                    n.id.toLowerCase().includes(needle) ||
                    n.tags.some((t: string) => t.toLowerCase().includes(needle))
                  );
                  if (matches.length) {
                    const lines = matches.map((n: any) => `- [${n.type}] ${n.title} (id: ${n.id}, degree: ${n.degree})`);
                    sections.push(`## ${v.label} Graph\n${lines.join('\n')}`);
                  } else {
                    sections.push(`## ${v.label} Graph\nNo graph nodes found matching: ${p.query}`);
                  }
                } catch (err) {
                  console.error(`[graph_query] ${v.label} search failed for ${v.path}:`, err);
                  sections.push(`## ${v.label} Graph\nNo graph available.`);
                }
              }
              return { content: [{ type: 'text', text: sections.join('\n\n') }], details: {} };
            }

            default:
              return { content: [{ type: 'text', text: `Unknown action: ${p.action}` }], details: {} };
          }
        } catch (err) {
          return { content: [{ type: 'text', text: `Graph query failed: ${err}` }], details: {} };
        }
      },
    },

    {
      name: 'link_memory',
      description: 'Create a typed link between two memories in your knowledge graph. Use this to build connections between related decisions, lessons, and facts.',
      label: 'link_memory',
      parameters: Type.Object({
        fromId: Type.String({ description: 'Source memory ID (e.g. "decisions/use-postgresql")' }),
        toId: Type.String({ description: 'Target memory ID (e.g. "projects/user-auth")' }),
        relationType: Type.Union([
          Type.Literal('related'),
          Type.Literal('depends_on'),
          Type.Literal('blocks'),
        ], { description: 'How these memories are related' }),
      }),
      execute: async (
        _toolCallId: string,
        params: unknown,
        _signal?: AbortSignal,
        _onUpdate?: AgentToolUpdateCallback<VoidDetails>
      ): Promise<AgentToolResult<VoidDetails>> => {
        const p = params as { fromId: string; toId: string; relationType: string };

        const sourceFile = join(vaultPath, `${p.fromId}.md`);
        try {
          const { readFile, writeFile: writeFileFs } = await import('node:fs/promises');
          let content: string;
          try {
            content = await readFile(sourceFile, 'utf8');
          } catch {
            return {
              content: [{ type: 'text', text: `Source memory not found: ${p.fromId}` }],
              details: {},
            };
          }

          const linkLineRe = /^links:\s*\[(.*)\]/m;
          const match = content.match(linkLineRe);
          let existingLinks: string[] = [];
          if (match) {
            existingLinks = match[1].split(',').map(s => s.trim()).filter(Boolean);
          }

          const newLink = `${p.relationType}:${p.toId}`;
          if (!existingLinks.includes(newLink)) {
            existingLinks.push(newLink);
          }

          const newLinkLine = `links: [${existingLinks.join(', ')}]`;
          if (match) {
            content = content.replace(linkLineRe, newLinkLine);
          } else {
            content = content.replace(/^---\n/m, `---\n${newLinkLine}\n`);
          }

          await writeFileFs(sourceFile, content, 'utf8');

          publisher.publishVaultUpdated(agentId, false).catch(() => {});

          return {
            content: [{ type: 'text', text: `Linked ${p.fromId} → ${p.toId} (${p.relationType})` }],
            details: {},
          };
        } catch (err) {
          return {
            content: [{ type: 'text', text: `Failed to link memories: ${err}` }],
            details: {},
          };
        }
      },
    },
  ];
}
