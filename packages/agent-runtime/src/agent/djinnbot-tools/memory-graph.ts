import { Type, type Static } from '@sinclair/typebox';
import type { AgentTool, AgentToolResult, AgentToolUpdateCallback } from '@mariozechner/pi-agent-core';
import type { RedisPublisher } from '../../redis/publisher.js';
import { join } from 'node:path';
// @ts-ignore — clawvault is an ESM package declared in package.json; types resolve at build time
import { graphSummary, getMemoryGraph } from 'clawvault';

// ── Schemas ────────────────────────────────────────────────────────────────

const GraphQueryParamsSchema = Type.Object({
  action: Type.Union([
    Type.Literal('summary'),
    Type.Literal('neighbors'),
    Type.Literal('search'),
  ], { description: 'Query action' }),
  nodeId: Type.Optional(Type.String({ description: 'Node ID for neighbors' })),
  query: Type.Optional(Type.String({ description: 'Search term' })),
  maxHops: Type.Optional(Type.Number({ default: 1, description: 'Max hops (1-3)' })),
});
type GraphQueryParams = Static<typeof GraphQueryParamsSchema>;

// ── Types ──────────────────────────────────────────────────────────────────

interface VoidDetails {}

export interface MemoryGraphToolsConfig {
  publisher: RedisPublisher;
  agentId: string;
  vaultPath: string;
}

// ── Tool factories ─────────────────────────────────────────────────────────

export function createMemoryGraphTools(config: MemoryGraphToolsConfig): AgentTool[] {
  const { publisher, agentId, vaultPath } = config;

  return [
    {
      name: 'graph_query',
      description: 'Query your knowledge graph',
      label: 'graph_query',
      parameters: GraphQueryParamsSchema,
      execute: async (
        _toolCallId: string,
        params: unknown,
        _signal?: AbortSignal,
        _onUpdate?: AgentToolUpdateCallback<VoidDetails>
      ): Promise<AgentToolResult<VoidDetails>> => {
        const p = params as GraphQueryParams;

        try {
          switch (p.action) {
            case 'summary': {
              const summary = await graphSummary({ vaultPath });
              return { content: [{ type: 'text', text: JSON.stringify(summary, null, 2) }], details: {} };
            }

            case 'neighbors': {
              if (!p.nodeId) return { content: [{ type: 'text', text: 'nodeId required' }], details: {} };
              const graph = await getMemoryGraph(vaultPath);
              const maxHops = Math.min(p.maxHops || 1, 3);
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
              if (!neighborNodes.length) {
                return { content: [{ type: 'text', text: `No neighbors found for node: ${p.nodeId}` }], details: {} };
              }
              const lines = neighborNodes.map((n: any) => `- [${n.type}] ${n.title} (id: ${n.id})`);
              return { content: [{ type: 'text', text: lines.join('\n') }], details: {} };
            }

            case 'search': {
              if (!p.query) return { content: [{ type: 'text', text: 'query required' }], details: {} };
              const graph = await getMemoryGraph(vaultPath);
              const needle = p.query.toLowerCase();
              const matches = graph.nodes.filter((n: any) =>
                n.title.toLowerCase().includes(needle) ||
                n.tags.some((t: string) => t.toLowerCase().includes(needle))
              );
              if (!matches.length) {
                return { content: [{ type: 'text', text: `No graph nodes found matching: ${p.query}` }], details: {} };
              }
              const lines = matches.map((n: any) => `- [${n.type}] ${n.title} (id: ${n.id}, degree: ${n.degree})`);
              return { content: [{ type: 'text', text: lines.join('\n') }], details: {} };
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
