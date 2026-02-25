import { Type, type Static } from '@sinclair/typebox';
import type { AgentTool, AgentToolResult, AgentToolUpdateCallback } from '@mariozechner/pi-agent-core';
import type { RedisPublisher } from '../../redis/publisher.js';
import { join, resolve } from 'node:path';
// @ts-ignore — clawvault is an ESM package declared in package.json; types resolve at build time
import { graphSummary, loadMemoryGraphIndex, buildOrUpdateMemoryGraphIndex, type MemoryGraph } from 'clawvault';
import { SharedVaultClient } from './shared-vault-api.js';

// ── Helpers ────────────────────────────────────────────────────────────────

/**
 * Read the graph index NON-DESTRUCTIVELY.
 *
 * The engine (packages/core/src/main.ts) builds graph-index.json via
 * `clawvault graph --refresh` and writes it to the vault's .clawvault/
 * directory.  The agent runtime sees this file via its JuiceFS mount of
 * the vault subdirectory.
 *
 * `getMemoryGraph` (from clawvault) calls `buildOrUpdateMemoryGraphIndex`
 * which unconditionally re-globs for *.md files and WRITES a new
 * graph-index.json — even if it finds zero files (e.g. during container
 * startup before the FUSE mount is fully settled).  This could overwrite
 * the engine's good index with an empty one.
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
  /** DjinnBot API base URL for shared vault graph operations. */
  apiBaseUrl: string;
}

// ── Tool factories ─────────────────────────────────────────────────────────

export function createMemoryGraphTools(config: MemoryGraphToolsConfig): AgentTool[] {
  const { publisher, agentId, vaultPath, apiBaseUrl } = config;
  const sharedVaultApi = new SharedVaultClient(apiBaseUrl);

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
        const scope = p.scope || 'all';

        // Helper: query personal graph (local ClawVault)
        const queryPersonalGraph = async (action: string): Promise<string> => {
          try {
            switch (action) {
              case 'summary': {
                const summary = await graphSummary({ vaultPath });
                return `## Personal Graph\n${JSON.stringify(summary, null, 2)}`;
              }
              case 'neighbors': {
                if (!p.nodeId) return '## Personal Graph\nnodeId required';
                const maxHops = Math.min(p.maxHops || 1, 3);
                const graph = await getGraphReadOnly(vaultPath);
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
                  return `## Personal Graph\n${lines.join('\n')}`;
                }
                return `## Personal Graph\nNo neighbors found for node: ${p.nodeId}`;
              }
              case 'search': {
                if (!p.query) return '## Personal Graph\nquery required';
                const needle = p.query.toLowerCase();
                const graph = await getGraphReadOnly(vaultPath);
                const matches = graph.nodes.filter((n: any) =>
                  n.title.toLowerCase().includes(needle) ||
                  n.id.toLowerCase().includes(needle) ||
                  n.tags?.some((t: string) => t.toLowerCase().includes(needle))
                );
                if (matches.length) {
                  const lines = matches.map((n: any) => `- [${n.type}] ${n.title} (id: ${n.id}, degree: ${n.degree})`);
                  return `## Personal Graph\n${lines.join('\n')}`;
                }
                return `## Personal Graph\nNo graph nodes found matching: ${p.query}`;
              }
              default: return `Unknown action: ${action}`;
            }
          } catch (err) {
            console.error(`[graph_query] Personal graph ${action} failed:`, err);
            return '## Personal Graph\nNo graph available.';
          }
        };

        // Helper: query shared graph (via API)
        const querySharedGraph = async (action: string): Promise<string> => {
          try {
            switch (action) {
              case 'summary': {
                const graphData = await sharedVaultApi.getGraph();
                return `## Shared Graph\n${JSON.stringify(graphData.stats, null, 2)}`;
              }
              case 'neighbors': {
                if (!p.nodeId) return '## Shared Graph\nnodeId required';
                const maxHops = Math.min(p.maxHops || 1, 3);
                const data = await sharedVaultApi.getNeighbors(p.nodeId, maxHops);
                if (data.nodes.length) {
                  const lines = data.nodes.map(n => `- [${n.type}] ${n.title} (id: ${n.id})`);
                  return `## Shared Graph\n${lines.join('\n')}`;
                }
                return `## Shared Graph\nNo neighbors found for node: ${p.nodeId}`;
              }
              case 'search': {
                if (!p.query) return '## Shared Graph\nquery required';
                const needle = p.query.toLowerCase();
                const graphData = await sharedVaultApi.getGraph();
                const matches = graphData.nodes.filter(n =>
                  n.title.toLowerCase().includes(needle) ||
                  n.id.toLowerCase().includes(needle) ||
                  n.tags?.some(t => t.toLowerCase().includes(needle))
                );
                if (matches.length) {
                  const lines = matches.map(n => `- [${n.type}] ${n.title} (id: ${n.id}, degree: ${n.degree})`);
                  return `## Shared Graph\n${lines.join('\n')}`;
                }
                return `## Shared Graph\nNo graph nodes found matching: ${p.query}`;
              }
              default: return `Unknown action: ${action}`;
            }
          } catch (err) {
            console.error(`[graph_query] Shared graph API ${action} failed:`, err);
            return '## Shared Graph\nNo graph available.';
          }
        };

        try {
          const sections: string[] = [];
          if (scope === 'personal' || scope === 'all') {
            sections.push(await queryPersonalGraph(p.action));
          }
          if (scope === 'shared' || scope === 'all') {
            sections.push(await querySharedGraph(p.action));
          }
          return { content: [{ type: 'text', text: sections.join('\n\n') }], details: {} };
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
