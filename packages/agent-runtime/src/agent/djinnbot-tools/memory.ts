import { Type, type Static } from '@sinclair/typebox';
import type { AgentTool, AgentToolResult, AgentToolUpdateCallback } from '@mariozechner/pi-agent-core';
import type { RedisPublisher } from '../../redis/publisher.js';
import { exec } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdir, writeFile } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { randomUUID } from 'node:crypto';
// @ts-ignore — clawvault is an ESM package declared in package.json; types resolve at build time
import { ClawVault } from 'clawvault';

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
  sharedPath: string;
}

// ── Tool factories ─────────────────────────────────────────────────────────

export function createMemoryTools(config: MemoryToolsConfig): AgentTool[] {
  const { publisher, agentId, vaultPath, sharedPath } = config;

  // ── ClawVault instances (loaded once, reused per call) ──────────────────
  let personalVault: InstanceType<typeof ClawVault> | null = null;
  let sharedVault: InstanceType<typeof ClawVault> | null = null;

  const getPersonalVault = async (): Promise<InstanceType<typeof ClawVault>> => {
    if (!personalVault) {
      personalVault = new ClawVault(vaultPath);
      await personalVault.load();
    }
    return personalVault;
  };

  const getSharedVault = async (): Promise<InstanceType<typeof ClawVault>> => {
    if (!sharedVault) {
      sharedVault = new ClawVault(sharedPath);
      await sharedVault.load();
    }
    return sharedVault;
  };

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
          console.log(`[remember] ${agentId}: shared=true → writing to shared vault: ${join(sharedPath, p.type, slug + '.md')}`);
          const sv = await getSharedVault();
          await sv.store({
            category: p.type,
            title: p.title,
            content: p.content,
            frontmatter: extraFm,
            overwrite: true,
            qmdUpdate: false,
            qmdEmbed: false,
          });
          console.log(`[remember] ${agentId}: shared vault write OK → ${memoryId}`);
        } else {
          console.warn(`[remember] ${agentId}: shared=false — "${p.title}" stored in PERSONAL vault ONLY. If this is project knowledge, you should have used shared: true!`);
        }

        publisher.publishVaultUpdated(agentId, p.shared ?? false).catch(() => {});

        return { content: [{ type: 'text', text: `Memory saved: ${memoryId}${p.shared ? ' (shared)' : ' (personal only)'}` }], details: {} };
      },
    },

    {
      name: 'recall',
      description: 'Search memory for relevant information. Use scope="shared" to search team/project memories, scope="personal" for your own memories, scope="all" (default) for both.',
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
        const sections: string[] = [];

        const search = async (
          getVault: () => Promise<InstanceType<typeof ClawVault>>,
          label: string,
          fallbackDir: string,
        ): Promise<void> => {
          try {
            const vault = await getVault();
            const hits = await vault.query(p.query, { limit: 5 });
            if (!hits.length) {
              sections.push(`## ${label}`, 'No results found.');
              return;
            }
            const formatted = hits.map((h: any) => {
              const score = Math.round((h.score ?? 0) * 100);
              const title = h.document?.title ?? 'Untitled';
              const content = h.snippet ?? h.document?.content ?? '';
              return `### ${title} (${score}%)\n${content}`;
            });
            sections.push(`## ${label}`, ...formatted);
          } catch {
            try {
              const safeQuery = p.query.replace(/"/g, '').replace(/`/g, '');
              const { stdout } = await execAsync(
                `grep -r -i "${safeQuery}" "${fallbackDir}" --include="*.md" 2>/dev/null | head -n 20`,
                { encoding: 'utf8', timeout: 30000, shell: '/bin/bash' },
              );
              const lines = stdout.split('\n').filter(Boolean);
              if (lines.length) {
                sections.push(`## ${label} (grep fallback)`, ...lines.map((l: string) => `  ${l}`));
              } else {
                sections.push(`## ${label}`, 'No results found.');
              }
            } catch {
              sections.push(`## ${label}`, 'No results found.');
            }
          }
        };

        if (scope === 'personal' || scope === 'all') {
          await search(getPersonalVault, 'Personal Memory', vaultPath);
        }

        if (scope === 'shared' || scope === 'all') {
          await search(getSharedVault, 'Shared Knowledge', sharedPath);
        }

        return { content: [{ type: 'text', text: sections.join('\n\n') }], details: {} };
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
        const id = randomUUID().slice(0, 8);
        const filePath = join(sharedPath, p.category, `${id}.md`);

        const content = [
          '---',
          `category: ${p.category}`,
          `importance: ${p.importance || 'medium'}`,
          `created: ${new Date().toISOString()}`,
          `author: ${process.env.AGENT_ID || 'unknown'}`,
          '---',
          '',
          p.content,
        ].join('\n');

        await mkdir(dirname(filePath), { recursive: true });
        await writeFile(filePath, content, 'utf8');

        publisher.publishVaultUpdated(agentId, true).catch(() => {});

        return { content: [{ type: 'text', text: `Knowledge shared: ${p.category}/${id}` }], details: {} };
      },
    },
  ];
}
