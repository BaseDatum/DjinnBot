import { Type, type Static } from '@sinclair/typebox';
import type { AgentTool, AgentToolResult, AgentToolUpdateCallback } from '@mariozechner/pi-agent-core';
import type { RedisPublisher } from '../../redis/publisher.js';
import { exec } from 'node:child_process';
import { promisify } from 'node:util';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
// @ts-ignore — clawvault is an ESM package declared in package.json; types resolve at build time
import { ClawVault } from 'clawvault';
import { MemoryRetrievalTracker } from './memory-scoring.js';
import { SharedVaultClient } from './shared-vault-api.js';

const execAsync = promisify(exec);

// ── Schemas ────────────────────────────────────────────────────────────────

const RememberParamsSchema = Type.Object({
  type: Type.Union([
    Type.Literal('fact'),
    Type.Literal('feeling'),
    Type.Literal('decision'),
    Type.Literal('lesson'),
    Type.Literal('commitment'),
    Type.Literal('preference'),
    Type.Literal('relationship'),
    Type.Literal('project'),
  ], { description: 'What kind of memory this is' }),
  title: Type.String({ description: 'Short title (used as filename). Plain words only — do NOT include colons, quotes, or special characters.' }),
  content: Type.String({
    description: 'Detailed content. Use [[wiki-links]] to reference other memories.',
  }),
  shared: Type.Optional(Type.Boolean({ default: false, description: 'IMPORTANT: Set to true to store in the SHARED team vault (visible to ALL agents, persisted to the project knowledge graph). Set to false (default) for personal-only notes. During onboarding you MUST use shared: true for ALL project memories.' })),
  links: Type.Optional(Type.Array(Type.String(), {
    description: 'Memory IDs to link to',
  })),
});
type RememberParams = Static<typeof RememberParamsSchema>;

const RecallParamsSchema = Type.Object({
  query: Type.String({ description: 'What to search for' }),
  scope: Type.Optional(Type.Union([
    Type.Literal('personal'),
    Type.Literal('shared'),
    Type.Literal('all'),
  ], { default: 'all', description: 'Search scope' })),
  budget: Type.Optional(Type.Number({ default: 2000, description: 'Token budget' })),
});
type RecallParams = Static<typeof RecallParamsSchema>;

const RateMemoriesParamsSchema = Type.Object({
  ratings: Type.Array(Type.Object({
    memoryId: Type.String({ description: 'ID of the memory to rate (as returned by recall/context_query)' }),
    useful: Type.Boolean({ description: 'Was this memory useful for your current task?' }),
  }), {
    description: 'Rate each recalled memory as useful or not useful',
    minItems: 1,
  }),
  gap: Type.Optional(Type.String({
    description:
      'Knowledge you needed but could NOT find in memory. Be specific — ' +
      'e.g. "PostgreSQL connection pool config for prod" rather than "database info". ' +
      'This helps the team identify and fill knowledge holes.',
  })),
  gap_query: Type.Optional(Type.String({
    description: 'The search query you tried that failed to find what you needed',
  })),
});
type RateMemoriesParams = Static<typeof RateMemoriesParamsSchema>;

const ShareKnowledgeParamsSchema = Type.Object({
  category: Type.Union([
    Type.Literal('pattern'),
    Type.Literal('decision'),
    Type.Literal('issue'),
    Type.Literal('convention'),
  ], { description: 'Type of knowledge' }),
  content: Type.String({ description: 'The knowledge to share' }),
  importance: Type.Optional(Type.Union([
    Type.Literal('low'),
    Type.Literal('medium'),
    Type.Literal('high'),
    Type.Literal('critical'),
  ], { default: 'medium' })),
});
type ShareKnowledgeParams = Static<typeof ShareKnowledgeParamsSchema>;

// ── Types ──────────────────────────────────────────────────────────────────

interface VoidDetails {}

export interface MemoryToolsConfig {
  publisher: RedisPublisher;
  agentId: string;
  vaultPath: string;
  /** DjinnBot API base URL for shared vault operations. */
  apiBaseUrl: string;
  /** Optional retrieval tracker for adaptive memory scoring. */
  retrievalTracker?: MemoryRetrievalTracker;
}

// ── Tool factories ─────────────────────────────────────────────────────────

export function createMemoryTools(config: MemoryToolsConfig): AgentTool[] {
  const { publisher, agentId, vaultPath, apiBaseUrl, retrievalTracker } = config;

  // ── Personal vault (local JuiceFS mount, agent-owned qmd index) ────────
  let personalVault: InstanceType<typeof ClawVault> | null = null;

  const getPersonalVault = async (): Promise<InstanceType<typeof ClawVault>> => {
    if (!personalVault) {
      personalVault = new ClawVault(vaultPath);
      await personalVault.load();
    }
    return personalVault;
  };

  // ── Shared vault (API-backed, engine maintains the index) ──────────────
  const sharedVaultApi = new SharedVaultClient(apiBaseUrl);

  return [
    {
      name: 'remember',
      description: 'Store a memory. Pass shared: true to store in the SHARED team vault (visible to all agents) — REQUIRED for all project knowledge during onboarding. Pass shared: false (default) for personal notes only. Supports 8 memory types and wiki-links for building knowledge graphs.',
      label: 'remember',
      parameters: RememberParamsSchema,
      execute: async (
        _toolCallId: string,
        params: unknown,
        _signal?: AbortSignal,
        _onUpdate?: AgentToolUpdateCallback<VoidDetails>
      ): Promise<AgentToolResult<VoidDetails>> => {
        const p = params as RememberParams;
        const slug = p.title.toLowerCase().replace(/[^a-z0-9]+/g, '-');
        const memoryId = `${p.type}/${slug}`;

        console.log(`[remember] ${agentId}: type=${p.type}, title="${p.title}", shared=${!!p.shared} → personal: ${join(vaultPath, p.type, slug + '.md')}`);

        const extraFm: Record<string, unknown> = {
          id: memoryId,
          type: p.type,
          created: new Date().toISOString(),
          ...(p.links?.length ? { links: p.links } : {}),
        };

        const pv = await getPersonalVault();
        await pv.store({
          category: p.type,
          title: p.title,
          content: p.content,
          frontmatter: extraFm,
          overwrite: true,
          qmdUpdate: false,
          qmdEmbed: false,
        });
        console.log(`[remember] ${agentId}: personal vault write OK → ${memoryId}`);

        if (p.shared) {
          console.log(`[remember] ${agentId}: shared=true → writing to shared vault via API`);
          try {
            await sharedVaultApi.store({
              category: p.type,
              title: p.title,
              content: p.content,
              frontmatter: extraFm,
              agent_id: agentId,
            });
            console.log(`[remember] ${agentId}: shared vault write OK → ${memoryId}`);
          } catch (err) {
            console.error(`[remember] ${agentId}: shared vault API write failed:`, err);
          }
        } else {
          console.warn(`[remember] ${agentId}: shared=false — "${p.title}" stored in PERSONAL vault ONLY. If this is project knowledge, you should have used shared: true!`);
        }

        publisher.publishVaultUpdated(agentId, p.shared ?? false).catch(() => {});

        return { content: [{ type: 'text', text: `Memory saved: ${memoryId}${p.shared ? ' (shared)' : ' (personal only)'}` }], details: {} };
      },
    },

    {
      name: 'recall',
      description: 'Full-text content search across your memories (BM25 keyword + semantic matching). Use this to find memories by their CONTENT — searches inside the body text of all memory files. For graph-aware context retrieval that also traverses wiki-link connections, use "context_query" instead. Scope: "all" (default) searches both personal and shared, "shared" for team vault only, "personal" for your own memories only.',
      label: 'recall',
      parameters: RecallParamsSchema,
      execute: async (
        _toolCallId: string,
        params: unknown,
        _signal?: AbortSignal,
        _onUpdate?: AgentToolUpdateCallback<VoidDetails>
      ): Promise<AgentToolResult<VoidDetails>> => {
        const p = params as RecallParams;
        const scope = p.scope || 'all';

        // Collect all hits with metadata for adaptive score blending
        interface ScoredHit {
          memoryId: string;
          title: string;
          content: string;
          rawScore: number;
          blendedScore: number;
          source: string; // 'personal' | 'shared'
          retrievalSource: string; // 'bm25' | 'shared_bm25' | 'grep'
        }
        const allHits: ScoredHit[] = [];
        const fallbackSections: string[] = [];

        // ── Search personal vault (local ClawVault on JuiceFS mount) ────────
        const searchPersonalVault = async (): Promise<void> => {
          try {
            const vault = await getPersonalVault();
            const hits = await vault.query(p.query, { limit: 5 });
            for (const h of hits) {
              const rawScore = h.score ?? 0;
              const title = h.document?.title ?? 'Untitled';
              const content = h.snippet ?? h.document?.content ?? '';
              const memoryId = h.document?.id ?? h.document?.title ?? title;
              allHits.push({
                memoryId,
                title,
                content,
                rawScore,
                blendedScore: rawScore,
                source: 'personal',
                retrievalSource: 'bm25',
              });
            }
          } catch {
            // Grep fallback for personal vault
            try {
              const safeQuery = p.query.replace(/"/g, '').replace(/`/g, '');
              const { stdout } = await execAsync(
                `grep -r -i "${safeQuery}" "${vaultPath}" --include="*.md" 2>/dev/null | head -n 20`,
                { encoding: 'utf8', timeout: 30000, shell: '/bin/bash' },
              );
              const lines = stdout.split('\n').filter(Boolean);
              if (lines.length) {
                fallbackSections.push('## Personal Memory (grep fallback)', ...lines.map((l: string) => `  ${l}`));
              }
            } catch { /* no results */ }
          }
        };

        // ── Search shared vault (via API — engine maintains the index) ─────
        const searchSharedVault = async (): Promise<void> => {
          try {
            const results = await sharedVaultApi.search(p.query, 5);
            for (const r of results) {
              allHits.push({
                memoryId: r.filename?.replace(/\.md$/, '') ?? r.title ?? 'unknown',
                title: r.title ?? r.filename ?? 'Untitled',
                content: r.snippet ?? '',
                rawScore: r.score ?? 0,
                blendedScore: r.score ?? 0,
                source: 'shared',
                retrievalSource: 'shared_api',
              });
            }
          } catch (err) {
            console.warn('[recall] Shared vault API search failed:', err);
          }
        };

        if (scope === 'personal' || scope === 'all') {
          await searchPersonalVault();
        }

        if (scope === 'shared' || scope === 'all') {
          await searchSharedVault();
        }

        // ── Adaptive score blending ──────────────────────────────────────────
        if (retrievalTracker && allHits.length > 0) {
          try {
            const memoryIds = allHits.map(h => h.memoryId);
            const scores = await retrievalTracker.getAdaptiveScores(memoryIds);

            for (const hit of allHits) {
              const adaptive = scores.get(hit.memoryId);
              hit.blendedScore = retrievalTracker.blendScore(
                hit.rawScore,
                adaptive?.adaptiveScore,
              );

              // Track this retrieval for later flush
              retrievalTracker.track({
                memoryId: hit.memoryId,
                memoryTitle: hit.title,
                query: p.query,
                retrievalSource: hit.retrievalSource,
                rawScore: hit.rawScore,
              });
            }
          } catch (err) {
            // Non-fatal — fall back to raw scores
            console.warn('[recall] Adaptive score blending failed:', err);
            // Still track retrievals even without score blending
            for (const hit of allHits) {
              retrievalTracker.track({
                memoryId: hit.memoryId,
                memoryTitle: hit.title,
                query: p.query,
                retrievalSource: hit.retrievalSource,
                rawScore: hit.rawScore,
              });
            }
          }
        }

        // ── Sort by blended score and format ─────────────────────────────────
        allHits.sort((a, b) => b.blendedScore - a.blendedScore);

        const sections: string[] = [];

        // Group by source for display
        const personalHits = allHits.filter(h => h.source === 'personal');
        const sharedHits = allHits.filter(h => h.source === 'shared');

        if (scope === 'personal' || scope === 'all') {
          if (personalHits.length > 0) {
            sections.push('## Personal Memory');
            for (const h of personalHits) {
              const pct = Math.round(h.blendedScore * 100);
              sections.push(`### ${h.title} (${pct}%)\n${h.content}`);
            }
          } else {
            sections.push('## Personal Memory', 'No results found.');
          }
        }

        if (scope === 'shared' || scope === 'all') {
          if (sharedHits.length > 0) {
            sections.push('## Shared Knowledge');
            for (const h of sharedHits) {
              const pct = Math.round(h.blendedScore * 100);
              sections.push(`### ${h.title} (${pct}%)\n${h.content}`);
            }
          } else {
            sections.push('## Shared Knowledge', 'No results found.');
          }
        }

        // Append any grep fallback results
        if (fallbackSections.length > 0) {
          sections.push(...fallbackSections);
        }

        return { content: [{ type: 'text', text: sections.join('\n\n') }], details: {} };
      },
    },

    {
      name: 'rate_memories',
      description:
        'Rate how useful recalled memories were for your current task. ' +
        'Call this after using results from recall or context_query. ' +
        'Your ratings directly improve future memory retrieval — memories you mark as useful ' +
        'will rank higher in future searches, and those marked not-useful will be deprioritized. ' +
        'You can also report knowledge gaps — things you needed but couldn\'t find.',
      label: 'rate_memories',
      parameters: RateMemoriesParamsSchema,
      execute: async (
        _toolCallId: string,
        params: unknown,
        _signal?: AbortSignal,
        _onUpdate?: AgentToolUpdateCallback<VoidDetails>
      ): Promise<AgentToolResult<VoidDetails>> => {
        const p = params as RateMemoriesParams;

        if (!retrievalTracker) {
          return {
            content: [{ type: 'text', text: 'Memory scoring not available — ratings not recorded.' }],
            details: {},
          };
        }

        const valuations = p.ratings.map(r => ({
          memoryId: r.memoryId,
          memoryTitle: undefined as string | undefined,
          useful: r.useful,
        }));

        // Try to enrich with titles from tracked retrievals
        for (const v of valuations) {
          const tracked = retrievalTracker.tracked.find(t => t.memoryId === v.memoryId);
          if (tracked?.memoryTitle) {
            v.memoryTitle = tracked.memoryTitle;
          }
        }

        const result = await retrievalTracker.submitValuations(
          valuations,
          p.gap,
          p.gap_query,
        );

        const parts: string[] = [];
        const usefulCount = p.ratings.filter(r => r.useful).length;
        const notUsefulCount = p.ratings.filter(r => !r.useful).length;

        parts.push(`Rated ${p.ratings.length} memories: ${usefulCount} useful, ${notUsefulCount} not useful.`);

        if (p.gap) {
          parts.push(`Knowledge gap recorded: "${p.gap}"`);
        }

        if (!result.ok) {
          parts.push('(Warning: ratings may not have been persisted — API error)');
        }

        return {
          content: [{ type: 'text', text: parts.join(' ') }],
          details: {},
        };
      },
    },

    {
      name: 'share_knowledge',
      description: 'Share a pattern, decision, or issue with the team',
      label: 'share_knowledge',
      parameters: ShareKnowledgeParamsSchema,
      execute: async (
        _toolCallId: string,
        params: unknown,
        _signal?: AbortSignal,
        _onUpdate?: AgentToolUpdateCallback<VoidDetails>
      ): Promise<AgentToolResult<VoidDetails>> => {
        const p = params as ShareKnowledgeParams;

        try {
          const result = await sharedVaultApi.store({
            category: p.category,
            title: `${p.category}-${randomUUID().slice(0, 8)}`,
            content: p.content,
            frontmatter: {
              category: p.category,
              importance: p.importance || 'medium',
              author: process.env.AGENT_ID || 'unknown',
            },
            agent_id: agentId,
          });

          publisher.publishVaultUpdated(agentId, true).catch(() => {});

          return { content: [{ type: 'text', text: `Knowledge shared: ${result.filename}` }], details: {} };
        } catch (err) {
          return { content: [{ type: 'text', text: `Failed to share knowledge: ${err}` }], details: {} };
        }
      },
    },
  ];
}
