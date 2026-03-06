import { Type, type Static } from '@sinclair/typebox';
import type { AgentTool, AgentToolResult, AgentToolUpdateCallback } from '@mariozechner/pi-agent-core';
// @ts-ignore — clawvault is an ESM package declared in package.json; types resolve at build time
import { buildContext, createVault, type ContextResult } from 'clawvault';
import { existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { SharedVaultClient } from './shared-vault-api.js';

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
  /** DjinnBot API base URL for shared vault context operations. */
  apiBaseUrl: string;
}

// ── Tool factory ───────────────────────────────────────────────────────────

export function createMemoryContextTools(config: MemoryContextToolsConfig): AgentTool[] {
  const { agentId, vaultPath, apiBaseUrl } = config;
  const sharedVaultApi = new SharedVaultClient(apiBaseUrl);

  // Track whether we've ensured the vault exists (one-time check per session).
  let vaultEnsured = false;
  const ensureVaultExists = async (): Promise<void> => {
    if (vaultEnsured) return;
    const configPath = join(vaultPath, '.clawvault.json');
    if (!existsSync(configPath)) {
      console.log(`[context_query] Auto-creating ClawVault at ${vaultPath} (missing .clawvault.json)`);
      await createVault(vaultPath, {
        name: agentId,
        qmdCollection: `djinnbot-${agentId}`,
      }, {
        skipBases: true,
        skipTasks: true,
      });
    }
    // Ensure the qmd collection is registered in qmd's SQLite database.
    // ClawVault.init()/load() and buildContext() do NOT do this — they only
    // set in-memory config.  Without this, qmd search/vsearch returns nothing.
    const collection = `djinnbot-${agentId}`;
    try {
      execFileSync('qmd', ['collection', 'add', vaultPath, '--name', collection, '--mask', '**/*.md'], {
        stdio: 'ignore',
        env: {
          ...process.env,
          PATH: `/root/.bun/bin:/usr/local/bin:${process.env.PATH}`,
          XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME || '/tmp/xdg-config',
        },
      });
    } catch {
      // Collection may already exist, or qmd not available
    }
    vaultEnsured = true;
  };

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

        // ── Defensive unwrapping ──────────────────────────────────────────
        // PTC agents sometimes pass an options dict as a positional arg,
        // e.g. context_query("task", {"scope": "all"}) → profile = {"scope": "all"}
        if (p.profile !== undefined && typeof p.profile !== 'string') {
          const bag = p.profile as any;
          (p as any).profile = bag.profile ?? 'auto';
          if (bag.scope && !(p as any).scope) (p as any).scope = bag.scope;
          if (bag.budget) (p as any).budget = bag.budget;
          if (bag.maxHops) (p as any).maxHops = bag.maxHops;
        }
        if (p.scope !== undefined && typeof p.scope !== 'string') {
          const bag = p.scope as any;
          (p as any).scope = bag.scope ?? 'all';
        }

        if (!p.task?.trim()) {
          return { content: [{ type: 'text', text: 'task description required' }], details: {} };
        }

        const scope = p.scope || 'all';
        const profile = p.profile || 'auto';
        const budget = Math.max(500, Math.min(p.budget || 4000, 16000));
        const maxHops = Math.max(1, Math.min(p.maxHops || 2, 3));
        const limit = 5;

        const sections: string[] = [];

        // ── Personal vault context (local ClawVault on JuiceFS mount) ──────
        if (scope === 'personal' || scope === 'all') {
          try {
            // Ensure vault is initialized before calling buildContext.
            // With JuiceFS, the mount directory may exist but .clawvault.json
            // may not have been created yet by the engine.
            await ensureVaultExists();

            const result: ContextResult = await buildContext(p.task, {
              vaultPath,
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
                `## Personal Context (profile: ${result.profile}, ${result.context.length} entries)\n\n` +
                result.markdown
              );
            } else {
              sections.push(`## Personal Context\nNo relevant context found for: ${p.task}`);
            }
          } catch (err) {
            console.error(`[context_query] Personal context build failed for ${vaultPath}:`, err);
            sections.push(`## Personal Context\nContext retrieval failed — vault may not be initialized yet.`);
          }
        }

        // ── Shared vault context (via API — engine maintains the index) ────
        if (scope === 'shared' || scope === 'all') {
          try {
            const result = await sharedVaultApi.buildContext(p.task, {
              limit,
              budget,
              profile,
              maxHops,
            });

            if (result.entries > 0) {
              sections.push(
                `## Shared Context (profile: ${result.profile}, ${result.entries} entries)\n\n` +
                result.context
              );
            } else {
              sections.push(`## Shared Context\nNo relevant context found for: ${p.task}`);
            }
          } catch (err) {
            console.error(`[context_query] Shared context API failed:`, err);
            sections.push(`## Shared Context\nContext retrieval failed — API may be unavailable.`);
          }
        }

        return { content: [{ type: 'text', text: sections.join('\n\n') }], details: {} };
      },
    },
  ];
}
