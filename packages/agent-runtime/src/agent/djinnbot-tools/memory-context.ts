import { Type, type Static } from '@sinclair/typebox';
import type { AgentTool, AgentToolResult, AgentToolUpdateCallback } from '@mariozechner/pi-agent-core';
// @ts-ignore — clawvault is an ESM package declared in package.json; types resolve at build time
import { buildContext, type ContextResult } from 'clawvault';

// ── Schemas ────────────────────────────────────────────────────────────────

const ContextQueryParamsSchema = Type.Object({
  task: Type.String({
    description:
      'Describe what you are working on or trying to find. ' +
      'This drives semantic search, graph traversal, and profile-based ordering. ' +
      'Be specific — e.g. "database migration strategy" rather than "database".',
  }),
  profile: Type.Optional(Type.Union([
    Type.Literal('auto'),
    Type.Literal('default'),
    Type.Literal('planning'),
    Type.Literal('incident'),
    Type.Literal('handoff'),
  ], {
    default: 'auto',
    description:
      'Context profile controls how results are ranked and ordered. ' +
      '"auto" (default) infers the best profile from your task description. ' +
      '"planning" prioritizes decisions, projects, and structural knowledge. ' +
      '"incident" prioritizes recent observations and lessons. ' +
      '"handoff" prioritizes session continuity and open questions. ' +
      '"default" uses balanced ordering.',
  })),
  budget: Type.Optional(Type.Number({
    default: 4000,
    description: 'Token budget for the assembled context window (default: 4000). Higher values return more context.',
  })),
  maxHops: Type.Optional(Type.Number({
    default: 2,
    description: 'Maximum graph expansion hops from search results (1-3, default: 2). Higher values discover more distant connections.',
  })),
  scope: Type.Optional(Type.Union([
    Type.Literal('personal'),
    Type.Literal('shared'),
    Type.Literal('all'),
  ], {
    default: 'all',
    description: 'Which vaults to query: "all" (default) for both personal and shared, "shared" for team vault only, "personal" for your own vault only.',
  })),
});
type ContextQueryParams = Static<typeof ContextQueryParamsSchema>;

// ── Types ──────────────────────────────────────────────────────────────────

interface VoidDetails {}

export interface MemoryContextToolsConfig {
  agentId: string;
  vaultPath: string;
  sharedPath: string;
}

// ── Tool factory ───────────────────────────────────────────────────────────

export function createMemoryContextTools(config: MemoryContextToolsConfig): AgentTool[] {
  const { vaultPath, sharedPath } = config;

  return [
    {
      name: 'context_query',
      description:
        'Build intelligent, task-relevant context from your memory vault. ' +
        'This is the BEST tool for retrieving relevant knowledge — it combines: ' +
        '(1) semantic vector search to find relevant memories by meaning, ' +
        '(2) knowledge graph traversal to discover connected memories via wiki-links, ' +
        '(3) profile-based ranking to prioritize the most useful information, ' +
        '(4) token budgeting to fit results into your context window. ' +
        'Use this FIRST when you need to recall project knowledge, find relevant decisions, ' +
        'or understand context for a task. Returns formatted markdown ready for use.',
      label: 'context_query',
      parameters: ContextQueryParamsSchema,
      execute: async (
        _toolCallId: string,
        params: unknown,
        _signal?: AbortSignal,
        _onUpdate?: AgentToolUpdateCallback<VoidDetails>
      ): Promise<AgentToolResult<VoidDetails>> => {
        const p = params as ContextQueryParams;

        if (!p.task?.trim()) {
          return { content: [{ type: 'text', text: 'task description required' }], details: {} };
        }

        const scope = p.scope || 'all';
        const profile = p.profile || 'auto';
        const budget = Math.max(500, Math.min(p.budget || 4000, 16000));
        const maxHops = Math.max(1, Math.min(p.maxHops || 2, 3));
        const limit = 5;

        const vaultPaths: { path: string; label: string }[] = [];
        if (scope === 'personal' || scope === 'all') {
          vaultPaths.push({ path: vaultPath, label: 'Personal' });
        }
        if (scope === 'shared' || scope === 'all') {
          vaultPaths.push({ path: sharedPath, label: 'Shared' });
        }

        const sections: string[] = [];

        for (const v of vaultPaths) {
          try {
            const result: ContextResult = await buildContext(p.task, {
              vaultPath: v.path,
              limit,
              format: 'markdown',
              recent: true,
              includeObservations: true,
              budget,
              profile,
              maxHops,
            });

            if (result.context.length > 0) {
              sections.push(
                `## ${v.label} Context (profile: ${result.profile}, ${result.context.length} entries)\n\n` +
                result.markdown
              );
            } else {
              sections.push(`## ${v.label} Context\nNo relevant context found for: ${p.task}`);
            }
          } catch (err) {
            console.error(`[context_query] ${v.label} context build failed for ${v.path}:`, err);
            sections.push(`## ${v.label} Context\nContext retrieval failed — vault may not be initialized yet.`);
          }
        }

        return { content: [{ type: 'text', text: sections.join('\n\n') }], details: {} };
      },
    },
  ];
}
