import { Type, type Static } from '@sinclair/typebox';
import type { AgentTool, AgentToolResult, AgentToolUpdateCallback } from '@mariozechner/pi-agent-core';
import type { RedisPublisher } from '../redis/publisher.js';
import type { RequestIdRef } from './runner.js';
import type { AgentMessageEvent, SlackDmEvent } from '@djinnbot/core';
import { performResearch } from '@djinnbot/core';
import { exec } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdir, writeFile } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { randomUUID } from 'node:crypto';
// @ts-ignore — clawvault is an ESM package declared in package.json; types resolve at build time
import { ClawVault, graphSummary, getMemoryGraph } from 'clawvault';

// ── Pulse tool parameter schemas ─────────────────────────────────────────────

const GetMyProjectsParamsSchema = Type.Object({
  includeArchived: Type.Optional(Type.Boolean({
    default: false,
    description: 'Include archived projects in results',
  })),
});
type GetMyProjectsParams = Static<typeof GetMyProjectsParamsSchema>;

const GetReadyTasksParamsSchema = Type.Object({
  projectId: Type.String({ description: 'Project ID to get ready tasks from' }),
  limit: Type.Optional(Type.Number({ default: 5, description: 'Maximum number of tasks to return' })),
});
type GetReadyTasksParams = Static<typeof GetReadyTasksParamsSchema>;

const ExecuteTaskParamsSchema = Type.Object({
  projectId: Type.String({ description: 'Project ID containing the task' }),
  taskId: Type.String({ description: 'Task ID to execute' }),
  pipelineId: Type.Optional(Type.String({ description: 'Optional: specific pipeline ID to use for execution' })),
});
type ExecuteTaskParams = Static<typeof ExecuteTaskParamsSchema>;

const TransitionTaskParamsSchema = Type.Object({
  projectId: Type.String({ description: 'Project ID' }),
  taskId: Type.String({ description: 'Task ID' }),
  status: Type.String({ description: 'Target status: in_progress | review | done | failed | blocked | ready | backlog | planning' }),
  note: Type.Optional(Type.String({ description: 'Optional note explaining the transition' })),
});
type TransitionTaskParams = Static<typeof TransitionTaskParamsSchema>;

const execAsync = promisify(exec);

// TypeBox schemas for tool parameters
const CompleteParamsSchema = Type.Object({
  outputs: Type.Record(Type.String(), Type.String(), {
    description: 'Key-value pairs of step outputs',
  }),
  summary: Type.Optional(Type.String({
    description: 'Brief one-line summary of what you accomplished',
  })),
});
type CompleteParams = Static<typeof CompleteParamsSchema>;

const FailParamsSchema = Type.Object({
  error: Type.String({ description: 'What went wrong' }),
  details: Type.Optional(Type.String({ description: 'Additional context' })),
});
type FailParams = Static<typeof FailParamsSchema>;

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

const MessageAgentParamsSchema = Type.Object({
  to: Type.String({ description: 'Agent ID' }),
  message: Type.String({ description: 'Message content' }),
  priority: Type.Optional(Type.Union([
    Type.Literal('normal'),
    Type.Literal('high'),
    Type.Literal('urgent'),
  ], { default: 'normal' })),
  type: Type.Optional(Type.Union([
    Type.Literal('info'),
    Type.Literal('review_request'),
    Type.Literal('help_request'),
    Type.Literal('unblock'),
  ], { default: 'info' })),
});
type MessageAgentParams = Static<typeof MessageAgentParamsSchema>;

const SlackDmParamsSchema = Type.Object({
  message: Type.String({ description: 'Message to send' }),
  urgent: Type.Optional(Type.Boolean({ default: false })),
});
type SlackDmParams = Static<typeof SlackDmParamsSchema>;

const CheckpointParamsSchema = Type.Object({
  workingOn: Type.String({ description: 'Current task' }),
  focus: Type.Optional(Type.String({ description: 'Focus area' })),
  decisions: Type.Optional(Type.Array(Type.String(), { description: 'Decisions made' })),
});
type CheckpointParams = Static<typeof CheckpointParamsSchema>;

const ResearchParamsSchema = Type.Object({
  query: Type.String({
    description: 'The research question or topic to investigate. Be specific — e.g. "current SaaS valuation multiples for B2B tools 2025" or "competitor pricing for AI coding assistants"',
  }),
  focus: Type.Optional(Type.Union([
    Type.Literal('finance'),
    Type.Literal('marketing'),
    Type.Literal('technical'),
    Type.Literal('market'),
    Type.Literal('news'),
    Type.Literal('general'),
  ], {
    default: 'general',
    description: 'Domain focus to guide the research model toward relevant sources',
  })),
  model: Type.Optional(Type.String({
    default: 'perplexity/sonar-pro',
    description: 'Perplexity model on OpenRouter. Options: perplexity/sonar-pro (default, best quality), perplexity/sonar (faster, lighter), perplexity/sonar-reasoning (deeper reasoning for complex topics)',
  })),
});
type ResearchParams = Static<typeof ResearchParamsSchema>;

const UpdateOnboardingContextParamsSchema = Type.Object({
  context: Type.Record(Type.String(), Type.Unknown(), {
    description: 'Key-value pairs to merge into the onboarding session context. ' +
      'Use keys: project_name, goal, repo, open_source, revenue_goal, target_customer, ' +
      'monetization, timeline, v1_scope, tech_preferences, summary. ' +
      'Only include keys where you have confirmed information.',
  }),
});
type UpdateOnboardingContextParams = Static<typeof UpdateOnboardingContextParamsSchema>;

const OnboardingHandoffParamsSchema = Type.Object({
  next_agent: Type.Union([
    Type.Literal('jim'),
    Type.Literal('eric'),
    Type.Literal('finn'),
    Type.Literal('yang'),
    Type.Literal('done'),
  ], {
    description: 'Which agent to hand off to next. Use "done" only when all agents have finished — this creates the project and kicks off the planning pipeline automatically.',
  }),
  summary: Type.String({
    description: 'One-sentence summary of the project as you understand it so far, to brief the next agent.',
  }),
  context: Type.Optional(Type.Record(Type.String(), Type.Unknown(), {
    description: 'Structured context extracted during this interview phase. Keys: project_name, goal, repo, open_source, revenue_goal, target_customer, monetization, timeline, v1_scope, tech_preferences.',
  })),
});
type OnboardingHandoffParams = Static<typeof OnboardingHandoffParamsSchema>;

const GetGithubTokenParamsSchema = Type.Object({
  repo: Type.String({
    description: 'Repository path or full URL. Accepts: "owner/repo", ' +
      '"https://github.com/owner/repo", "https://github.com/owner/repo.git". ' +
      'The API resolves which GitHub App installation covers this repo automatically.',
  }),
});
type GetGithubTokenParams = Static<typeof GetGithubTokenParamsSchema>;

interface VoidDetails {}

export interface DjinnBotToolsConfig {
  publisher: RedisPublisher;
  /** Mutable ref — tools read `.current` at call time, no need to recreate tools per turn. */
  requestIdRef: RequestIdRef;
  agentId: string;
  vaultPath: string;
  sharedPath: string;
  /** Absolute path to the agents directory — used for skill registry. */
  agentsDir?: string;
  /**
   * DjinnBot API base URL (no /api suffix).
   * Defaults to DJINNBOT_API_URL env var, then 'http://api:8000'.
   */
  apiBaseUrl?: string;
  /**
   * Kanban column names this agent works from during pulse.
   * Defaults to PULSE_COLUMNS env var (comma-separated), then ['Backlog','Ready'].
   */
  pulseColumns?: string[];
  onComplete: (outputs: Record<string, string>, summary?: string) => void;
  onFail: (error: string, details?: string) => void;
}

export function createDjinnBotTools(config: DjinnBotToolsConfig): AgentTool[] {
  const { publisher, requestIdRef, agentId, vaultPath, sharedPath, onComplete, onFail } = config;

  // ── ClawVault instances (loaded once, reused per call) ────────────────────
  // ClawVault wraps qmd for structured memory storage and robust search.
  // We load the vault index once at tool-set creation time. The in-memory
  // document registry is used for metadata enrichment only; qmd's SQLite index
  // is always queried live so newly indexed memories are always found.
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
    // === Step Control ===
    {
      name: 'complete',
      description: 'Call when you have finished the task successfully',
      label: 'complete',
      parameters: CompleteParamsSchema,
      execute: async (
        _toolCallId: string,
        params: unknown,
        _signal?: AbortSignal,
        _onUpdate?: AgentToolUpdateCallback<VoidDetails>
      ): Promise<AgentToolResult<VoidDetails>> => {
        const p = params as CompleteParams;
        onComplete(p.outputs, p.summary);
        return { content: [{ type: 'text', text: 'Step completed.' }], details: {} };
      },
    },
    {
      name: 'fail',
      description: 'Call when you cannot complete the task',
      label: 'fail',
      parameters: FailParamsSchema,
      execute: async (
        _toolCallId: string,
        params: unknown,
        _signal?: AbortSignal,
        _onUpdate?: AgentToolUpdateCallback<VoidDetails>
      ): Promise<AgentToolResult<VoidDetails>> => {
        const p = params as FailParams;
        onFail(p.error, p.details);
        return { content: [{ type: 'text', text: 'Step failed.' }], details: {} };
      },
    },

    // === Memory (via ClawVault) ===
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

        // Shared frontmatter fields — clawvault.store() merges these with title/date
        const extraFm: Record<string, unknown> = {
          id: memoryId,
          type: p.type,
          created: new Date().toISOString(),
          ...(p.links?.length ? { links: p.links } : {}),
        };

        // Write to personal vault via ClawVault
        const pv = await getPersonalVault();
        await pv.store({
          category: p.type,
          title: p.title,
          content: p.content,
          frontmatter: extraFm,
          overwrite: true,
          // VaultEmbedWatcher handles qmd update + embed; skip inline to avoid
          // concurrent SQLite writes that cause "database is locked" errors.
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

        // Signal the engine to re-index and embed this agent's vault (non-blocking)
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

        // Search via ClawVault's query() method which uses `qmd query --json`:
        // combined BM25 + vector search + reranking. This is robust against the
        // FTS5 stopword bug in `qmd search` that causes "no results" for certain
        // multi-word queries (e.g. any query containing "name").
        // Falls back to grep if ClawVault/qmd unavailable.
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
            // ClawVault or qmd unavailable — fall back to grep
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

        // Signal engine to re-index the shared vault
        publisher.publishVaultUpdated(agentId, true).catch(() => {});

        return { content: [{ type: 'text', text: `Knowledge shared: ${p.category}/${id}` }], details: {} };
      },
    },
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
              // Use ClawVault's graphSummary() which reads the in-process memory graph index.
              const summary = await graphSummary({ vaultPath });
              return { content: [{ type: 'text', text: JSON.stringify(summary, null, 2) }], details: {} };
            }

            case 'neighbors': {
              if (!p.nodeId) return { content: [{ type: 'text', text: 'nodeId required' }], details: {} };
              // Use ClawVault's getMemoryGraph() and traverse edges in-process.
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
              const neighborNodes = graph.nodes.filter(n => visited.has(n.id));
              if (!neighborNodes.length) {
                return { content: [{ type: 'text', text: `No neighbors found for node: ${p.nodeId}` }], details: {} };
              }
              const lines = neighborNodes.map(n => `- [${n.type}] ${n.title} (id: ${n.id})`);
              return { content: [{ type: 'text', text: lines.join('\n') }], details: {} };
            }

            case 'search': {
              if (!p.query) return { content: [{ type: 'text', text: 'query required' }], details: {} };
              // Search graph nodes by title and tags using ClawVault's memory graph.
              const graph = await getMemoryGraph(vaultPath);
              const needle = p.query.toLowerCase();
              const matches = graph.nodes.filter(n =>
                n.title.toLowerCase().includes(needle) ||
                n.tags.some((t: string) => t.toLowerCase().includes(needle))
              );
              if (!matches.length) {
                return { content: [{ type: 'text', text: `No graph nodes found matching: ${p.query}` }], details: {} };
              }
              const lines = matches.map(n => `- [${n.type}] ${n.title} (id: ${n.id}, degree: ${n.degree})`);
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

    // === Messaging (Fire-and-forget via Redis) ===
    {
      name: 'message_agent',
      description: 'Send a message to another agent',
      label: 'message_agent',
      parameters: MessageAgentParamsSchema,
      execute: async (
        _toolCallId: string,
        params: unknown,
        _signal?: AbortSignal,
        _onUpdate?: AgentToolUpdateCallback<VoidDetails>
      ): Promise<AgentToolResult<VoidDetails>> => {
        const p = params as MessageAgentParams;
        const event: Omit<AgentMessageEvent, 'timestamp'> = {
          type: 'agentMessage',
          requestId: requestIdRef.current,
          to: p.to,
          message: p.message,
          priority: p.priority || 'normal',
          messageType: p.type || 'info',
        };
        await publisher.publishEvent(event as any);
        return { content: [{ type: 'text', text: `Message sent to ${p.to}` }], details: {} };
      },
    },
    {
      name: 'slack_dm',
      description: 'Send a DM to Sky via Slack',
      label: 'slack_dm',
      parameters: SlackDmParamsSchema,
      execute: async (
        _toolCallId: string,
        params: unknown,
        _signal?: AbortSignal,
        _onUpdate?: AgentToolUpdateCallback<VoidDetails>
      ): Promise<AgentToolResult<VoidDetails>> => {
        const p = params as SlackDmParams;
        const event: Omit<SlackDmEvent, 'timestamp'> = {
          type: 'slackDm',
          requestId: requestIdRef.current,
          message: p.message,
          urgent: p.urgent || false,
        };
        await publisher.publishEvent(event as any);
        return { content: [{ type: 'text', text: 'Message sent to Sky' }], details: {} };
      },
    },
    {
      name: 'checkpoint',
      description: 'Save your current working state for recovery',
      label: 'checkpoint',
      parameters: CheckpointParamsSchema,
      execute: async (
        _toolCallId: string,
        params: unknown,
        _signal?: AbortSignal,
        _onUpdate?: AgentToolUpdateCallback<VoidDetails>
      ): Promise<AgentToolResult<VoidDetails>> => {
        const p = params as CheckpointParams;
        const checkpointPath = join(vaultPath, '.checkpoint.json');
        const checkpoint = {
          timestamp: new Date().toISOString(),
          requestId: requestIdRef.current,
          workingOn: p.workingOn,
          focus: p.focus,
          decisions: p.decisions || [],
        };
        await writeFile(checkpointPath, JSON.stringify(checkpoint, null, 2), 'utf8');
        return { content: [{ type: 'text', text: 'Checkpoint saved' }], details: {} };
      },
    },

    // === Memory Graph ===
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

        // Append a link entry to the source memory's frontmatter by rewriting the file.
        // Format: links: [targetId, ...]  in YAML front matter.
        const sourceFile = join(vaultPath, `${p.fromId}.md`);
        try {
          const { readFile, writeFile } = await import('node:fs/promises');
          let content: string;
          try {
            content = await readFile(sourceFile, 'utf8');
          } catch {
            return {
              content: [{ type: 'text', text: `Source memory not found: ${p.fromId}` }],
              details: {},
            };
          }

          // Parse existing links from frontmatter
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
            // Insert before closing --- of front matter
            content = content.replace(/^---\n/m, `---\n${newLinkLine}\n`);
          }

          await writeFile(sourceFile, content, 'utf8');

          // Signal engine to re-index
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

    // === Research (Perplexity via OpenRouter) ===
    {
      name: 'research',
      description: 'Research a topic using Perplexity AI via OpenRouter. Returns synthesized, cited answers from live web sources. Use this for market research, competitive analysis, industry trends, technical documentation, pricing data, news, and any topic requiring up-to-date external knowledge.',
      label: 'research',
      parameters: ResearchParamsSchema,
      execute: async (
        _toolCallId: string,
        params: unknown,
        signal?: AbortSignal,
        _onUpdate?: AgentToolUpdateCallback<VoidDetails>
      ): Promise<AgentToolResult<VoidDetails>> => {
        const p = params as ResearchParams;
        const result = await performResearch(
          p.query,
          p.focus || 'general',
          p.model || 'perplexity/sonar-pro',
          signal,
        );
        return { content: [{ type: 'text', text: result }], details: {} };
      },
    },

    // === Onboarding ===

    // update_onboarding_context — update the live project profile sidebar
    {
      name: 'update_onboarding_context',
      description: 'Update the onboarding session context with newly extracted project information. ' +
        'Call this whenever you learn something concrete about the project (name, goal, tech stack, etc.). ' +
        'This updates the live "Project Profile" sidebar in real time. ' +
        'Recognised keys: project_name, goal, repo, open_source, revenue_goal, target_customer, ' +
        'monetization, timeline, v1_scope, tech_preferences, summary.',
      label: 'update_onboarding_context',
      parameters: UpdateOnboardingContextParamsSchema,
      execute: async (
        _toolCallId: string,
        params: unknown,
        signal?: AbortSignal,
        _onUpdate?: AgentToolUpdateCallback<VoidDetails>
      ): Promise<AgentToolResult<VoidDetails>> => {
        const p = params as UpdateOnboardingContextParams;
        const apiBase = config.apiBaseUrl
          || process.env.DJINNBOT_API_URL
          || 'http://api:8000';
        const onboardingSessionId = process.env.ONBOARDING_SESSION_ID;
        if (!onboardingSessionId) {
          return { content: [{ type: 'text', text: 'No onboarding session ID available — context not updated.' }], details: {} };
        }
        try {
          const response = await fetch(
            `${apiBase}/v1/onboarding/sessions/${onboardingSessionId}/context`,
            {
              method: 'PATCH',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify(p.context),
              signal: signal ?? undefined,
            },
          );
          if (!response.ok) {
            const text = await response.text();
            return { content: [{ type: 'text', text: `Context update failed: ${response.status} ${text}` }], details: {} };
          }
          const keys = Object.keys(p.context).join(', ');
          return { content: [{ type: 'text', text: `Onboarding context updated: ${keys}` }], details: {} };
        } catch (err) {
          return { content: [{ type: 'text', text: `Failed to update onboarding context: ${err}` }], details: {} };
        }
      },
    },

    // onboarding_handoff — signal the orchestrator to switch to the next agent
    {
      name: 'onboarding_handoff',
      description:
        'Hand off the onboarding conversation to the next specialist agent. ' +
        'Call this when you have fully covered your area and built the memory graph for your phase. ' +
        'This stops your container and starts the next agent pre-seeded with everything gathered so far. ' +
        'DO NOT call complete() — call this instead to hand off.',
      label: 'onboarding_handoff',
      parameters: OnboardingHandoffParamsSchema,
      execute: async (
        _toolCallId: string,
        params: unknown,
        signal?: AbortSignal,
        _onUpdate?: AgentToolUpdateCallback<VoidDetails>
      ): Promise<AgentToolResult<VoidDetails>> => {
        const p = params as OnboardingHandoffParams;
        const apiBase = config.apiBaseUrl
          || process.env.DJINNBOT_API_URL
          || 'http://api:8000';
        const onboardingSessionId = process.env.ONBOARDING_SESSION_ID;

        console.log(`[onboarding_handoff] ${agentId} → ${p.next_agent}: "${p.summary}" (sessionId=${onboardingSessionId})`);

        if (!onboardingSessionId) {
          console.error('[onboarding_handoff] ONBOARDING_SESSION_ID env var is not set — handoff cannot proceed!');
          return {
            content: [{ type: 'text', text: 'Handoff failed: no onboarding session ID available (ONBOARDING_SESSION_ID not set).' }],
            details: {},
          };
        }

        try {
          const response = await fetch(
            `${apiBase}/v1/onboarding/sessions/${onboardingSessionId}/handoff`,
            {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                next_agent_id: p.next_agent,
                summary: p.summary,
                context_update: p.context,
              }),
              signal: signal ?? undefined,
            },
          );
          if (!response.ok) {
            const text = await response.text();
            console.error(`[onboarding_handoff] API call failed: ${response.status} ${text}`);
            return {
              content: [{ type: 'text', text: `Handoff API call failed: ${response.status} ${text}` }],
              details: {},
            };
          }
          console.log(`[onboarding_handoff] Handoff to ${p.next_agent} accepted by API`);
          return {
            content: [{ type: 'text', text: `Handing off to ${p.next_agent}. ${p.summary} The next agent will continue from here.` }],
            details: {},
          };
        } catch (err) {
          console.error(`[onboarding_handoff] Fetch failed:`, err);
          return {
            content: [{ type: 'text', text: `Handoff failed: ${err}` }],
            details: {},
          };
        }
      },
    },

    // === GitHub App token tool ===

    // get_github_token — get a short-lived token for a specific repo, auto-configure git credential helper
    {
      name: 'get_github_token',
      description: 'Get a GitHub App access token for a specific repository. ' +
        'Pass the repo URL or "owner/repo" path — the API automatically resolves which ' +
        'installation covers that repo (no installation ID needed). ' +
        'If the GitHub App is not installed on the repo, returns a clear message with ' +
        'instructions for the user to install it. ' +
        'This tool also configures the git credential helper so subsequent ' +
        'git clone/pull/push commands work without any extra auth.',
      label: 'get_github_token',
      parameters: GetGithubTokenParamsSchema,
      execute: async (
        _toolCallId: string,
        params: unknown,
        signal?: AbortSignal,
        _onUpdate?: AgentToolUpdateCallback<VoidDetails>
      ): Promise<AgentToolResult<VoidDetails>> => {
        const { repo } = params as GetGithubTokenParams;
        const apiBase = config.apiBaseUrl || process.env.DJINNBOT_API_URL || 'http://api:8000';
        try {
          const url = new URL(`${apiBase}/v1/github/repo-token`);
          url.searchParams.set('repo', repo);
          const response = await fetch(url.toString(), { signal: signal ?? undefined });

          if (!response.ok) {
            const body = await response.json().catch(() => ({ detail: response.statusText })) as { detail?: string };
            const detail = body.detail ?? response.statusText;
            if (response.status === 404) {
              // App not installed — surface the message directly to the user
              return { content: [{ type: 'text', text: detail }], details: {} };
            }
            if (response.status === 503) {
              return { content: [{ type: 'text', text: 'GitHub App is not configured on this DjinnBot instance. Use a Personal Access Token instead (Settings → Secrets → add GITHUB_TOKEN → grant to Stas).' }], details: {} };
            }
            return { content: [{ type: 'text', text: `Failed to get GitHub token: ${response.status} — ${detail}` }], details: {} };
          }

          const data = await response.json() as {
            token: string;
            expires_at: number;
            installation_id: number;
            owner: string;
            repo: string;
            clone_url: string;
          };
          const { token, clone_url, owner, repo: repoName } = data;

          // Configure git credential helper so all subsequent git operations authenticate automatically.
          const { execSync } = await import('child_process');
          try {
            execSync('git config --global credential.helper store', { stdio: 'ignore' });
            // Append the credential entry to ~/.git-credentials
            const fs = await import('fs');
            const credLine = `https://x-access-token:${token}@github.com\n`;
            fs.appendFileSync(`${process.env.HOME ?? '/root'}/.git-credentials`, credLine, 'utf8');
            // Also set insteadOf so bare "https://github.com" URLs are rewritten
            execSync(
              `git config --global url."https://x-access-token:${token}@github.com/".insteadOf "https://github.com/"`,
              { stdio: 'ignore' },
            );
          } catch {
            // Credential helper config is best-effort — token is still returned
          }

          const expiresIn = Math.round((data.expires_at - Date.now()) / 60000);
          return {
            content: [{
              type: 'text',
              text: [
                `GitHub App token obtained for ${owner}/${repoName} (installation ${data.installation_id}).`,
                `Expires in ~${expiresIn} minutes.`,
                `Git credential helper configured — \`git clone https://github.com/${owner}/${repoName}.git\` will work directly.`,
                `Authenticated clone URL: ${clone_url}`,
              ].join('\n'),
            }],
            details: {},
          };
        } catch (err) {
          return { content: [{ type: 'text', text: `Failed to get GitHub token: ${err}` }], details: {} };
        }
      },
    },

    // === Skills ===

    // load_skill — gated content retrieval via API (access-controlled)
    {
      name: 'load_skill',
      description: 'Load the full instructions for a named skill. Use when you need detailed guidance for a specific capability listed in your SKILLS manifest.',
      label: 'load_skill',
      parameters: Type.Object({
        name: Type.String({ description: 'Skill name exactly as shown in the SKILLS manifest' }),
      }),
      execute: async (
        _toolCallId: string,
        params: unknown,
        signal?: AbortSignal,
        _onUpdate?: AgentToolUpdateCallback<VoidDetails>
      ): Promise<AgentToolResult<VoidDetails>> => {
        const p = params as { name: string };
        const apiBase = config.apiBaseUrl || process.env.DJINNBOT_API_URL || 'http://api:8000';

        try {
          const res = await fetch(
            `${apiBase}/v1/skills/agents/${agentId}/${encodeURIComponent(p.name)}/content`,
            { signal: signal ?? undefined },
          );
          if (res.status === 404) {
            return {
              content: [{ type: 'text', text: `Skill "${p.name}" not found. Available skills are listed in your SKILLS manifest.` }],
              details: {},
            };
          }
          if (res.status === 403) {
            return {
              content: [{ type: 'text', text: `You do not have access to skill "${p.name}".` }],
              details: {},
            };
          }
          if (res.status === 503) {
            return {
              content: [{ type: 'text', text: `Skill "${p.name}" is currently disabled.` }],
              details: {},
            };
          }
          if (!res.ok) {
            return {
              content: [{ type: 'text', text: `Error loading skill "${p.name}": HTTP ${res.status}` }],
              details: {},
            };
          }
          const data = await res.json() as { id: string; description: string; content: string };
          return {
            content: [{ type: 'text', text: `# SKILL: ${data.id}\n_${data.description}_\n\n${data.content}` }],
            details: {},
          };
        } catch (err) {
          return { content: [{ type: 'text', text: `Error loading skill: ${err}` }], details: {} };
        }
      },
    },

    // create_skill — write a new skill via API; auto-grants access to the creating agent
    {
      name: 'create_skill',
      description: 'Create a new skill and add it to the skills library. The creating agent automatically gets access. Use scope="global" for skills other agents should be able to use (a human grants them access), or scope="agent" for a skill only you will use.',
      label: 'create_skill',
      parameters: Type.Object({
        name: Type.String({ description: 'Short slug identifier (e.g. "github-pr", "sql-query"). Lowercase, hyphens OK.' }),
        description: Type.String({ description: 'One-line description shown in the skill manifest' }),
        tags: Type.Optional(Type.Array(Type.String(), {
          description: 'Keywords for automatic pipeline matching (e.g. ["github", "pr", "pull-request"])',
        })),
        content: Type.String({ description: 'Full markdown instructions for the skill. Be thorough — this is what agents will read.' }),
        scope: Type.Optional(Type.Union([
          Type.Literal('global'),
          Type.Literal('agent'),
        ], { default: 'global', description: '"global" adds to the shared library (you get access; a human grants other agents). "agent" is private to you.' })),
      }),
      execute: async (
        _toolCallId: string,
        params: unknown,
        signal?: AbortSignal,
        _onUpdate?: AgentToolUpdateCallback<VoidDetails>
      ): Promise<AgentToolResult<VoidDetails>> => {
        const p = params as {
          name: string;
          description: string;
          tags?: string[];
          content: string;
          scope?: 'global' | 'agent';
        };

        const apiBase = config.apiBaseUrl || process.env.DJINNBOT_API_URL || 'http://api:8000';
        const scope = p.scope ?? 'global';

        try {
          // 1. Create the skill in the library
          const createRes = await fetch(`${apiBase}/v1/skills/`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              name: p.name,
              description: p.description,
              tags: p.tags ?? [],
              content: p.content,
              scope,
              owner_agent_id: scope === 'agent' ? agentId : null,
            }),
            signal: signal ?? undefined,
          });

          if (!createRes.ok) {
            const err = await createRes.text();
            return { content: [{ type: 'text', text: `Failed to create skill: HTTP ${createRes.status} — ${err}` }], details: {} };
          }

          const skill = await createRes.json() as { id: string; scope: string };

          // 2. Auto-grant access to the creating agent
          const grantRes = await fetch(
            `${apiBase}/v1/skills/agents/${agentId}/${encodeURIComponent(skill.id)}/grant`,
            {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ granted_by: agentId }),
              signal: signal ?? undefined,
            },
          );

          const grantNote = grantRes.ok
            ? 'You have been granted access to it.'
            : 'Note: auto-grant failed — ask an admin to grant you access.';

          const scopeNote = scope === 'global'
            ? 'It is in the global library; a human can grant other agents access from the dashboard.'
            : 'It is private to you.';

          return {
            content: [{
              type: 'text',
              text: `Skill "${skill.id}" created (scope: ${skill.scope}). ${grantNote} ${scopeNote}`,
            }],
            details: {},
          };
        } catch (err) {
          return { content: [{ type: 'text', text: `Failed to create skill: ${err}` }], details: {} };
        }
      },
    },

    // ── Project / task / pulse tools ─────────────────────────────────────────
    // These tools are always registered so agents can use them in any session
    // (pulse, pipeline, chat) without needing conditional gating.
    // The API URL and pulse column scoping are resolved from config/env at
    // call time so they are always up-to-date.

    {
      name: 'get_my_projects',
      description: 'Get list of projects you are assigned to. Returns projects where you have an active role (owner or member). Use this during pulse to discover work.',
      label: 'get_my_projects',
      parameters: GetMyProjectsParamsSchema,
      execute: async (
        _toolCallId: string,
        params: unknown,
        signal?: AbortSignal,
      ): Promise<AgentToolResult<VoidDetails>> => {
        const p = params as GetMyProjectsParams;
        const apiBase = config.apiBaseUrl
          || process.env.DJINNBOT_API_URL
          || 'http://api:8000';
        try {
          const url = `${apiBase}/v1/agents/${agentId}/projects`;
          const response = await fetch(url, { signal });
          if (!response.ok) throw new Error(`${response.status} ${response.statusText}`);
          const raw = (await response.json()) as any;
          const rawList: any[] = Array.isArray(raw) ? raw : (raw.projects || []);
          const projects = rawList.map((proj: any) => ({
            id: proj.project_id ?? proj.id,
            name: proj.project_name ?? proj.name,
            status: proj.project_status ?? proj.status,
            description: proj.project_description ?? proj.description ?? '',
            role: proj.role,
          }));
          const filtered = p.includeArchived ? projects : projects.filter((proj: any) => proj.status !== 'archived');
          if (filtered.length === 0) {
            return { content: [{ type: 'text', text: 'No active projects assigned to you.' }], details: {} };
          }
          const list = filtered.map((proj: any) =>
            `- **${proj.name}** (${proj.id})\n  Status: ${proj.status}, Role: ${proj.role}`
          ).join('\n');
          return { content: [{ type: 'text', text: `Found ${filtered.length} project(s):\n\n${list}` }], details: {} };
        } catch (err) {
          return { content: [{ type: 'text', text: `Error fetching projects: ${err instanceof Error ? err.message : String(err)}` }], details: {} };
        }
      },
    },

    {
      name: 'get_ready_tasks',
      description:
        'Get tasks that are ready to execute in a project. Returns:\n' +
        '- tasks: candidates assigned to you (or unassigned) with all dependencies met, sorted by priority (P0 > P1 > P2 > P3). Each task includes blocking_tasks (downstream tasks waiting on this one).\n' +
        '- in_progress: your tasks already running in this project, with their downstream dependents.\n' +
        'Use in_progress + blocking_tasks together to identify which ready tasks are independent of your current work and safe to start in parallel.',
      label: 'get_ready_tasks',
      parameters: GetReadyTasksParamsSchema,
      execute: async (
        _toolCallId: string,
        params: unknown,
        signal?: AbortSignal,
      ): Promise<AgentToolResult<VoidDetails>> => {
        const p = params as GetReadyTasksParams;
        const apiBase = config.apiBaseUrl
          || process.env.DJINNBOT_API_URL
          || 'http://api:8000';

        // Resolve columns → statuses at call time (env may have been set after module load)
        const columnToStatus: Record<string, string> = {
          'Backlog': 'backlog', 'Planning': 'planning', 'Ready': 'ready',
          'In Progress': 'in_progress', 'Review': 'review',
          'Blocked': 'blocked', 'Done': 'done', 'Failed': 'failed',
        };
        const columns = config.pulseColumns
          || (process.env.PULSE_COLUMNS ? process.env.PULSE_COLUMNS.split(',').map(c => c.trim()).filter(Boolean) : [])
          || ['Backlog', 'Ready'];
        const statuses = columns.map(c => columnToStatus[c]).filter(Boolean).join(',') || 'backlog,planning,ready';

        try {
          const limit = p.limit || 5;
          const url = `${apiBase}/v1/projects/${p.projectId}/ready-tasks?agent_id=${encodeURIComponent(agentId)}&limit=${limit}&statuses=${encodeURIComponent(statuses)}`;
          const response = await fetch(url, { signal });
          if (!response.ok) throw new Error(`${response.status} ${response.statusText}`);
          const raw = (await response.json()) as any;
          const tasks: any[] = Array.isArray(raw) ? raw : (raw.tasks || []);
          const inProgress: any[] = Array.isArray(raw) ? [] : (raw.in_progress || []);

          let inProgressSection = inProgress.length > 0
            ? `\n### Your tasks currently in progress (${inProgress.length})\n` +
              inProgress.map((t: any) => {
                const blocksInfo = t.blocks?.length > 0
                  ? `\n   Unblocks when done: ${t.blocks.map((b: any) => `${b.title} [${b.status}]`).join(', ')}`
                  : '';
                return `- [${t.status}] **${t.title}** (${t.id}) [${t.priority || 'P2'}]${blocksInfo}`;
              }).join('\n')
            : '\n### Your tasks currently in progress\nNone.';

          if (tasks.length === 0) {
            return { content: [{ type: 'text', text: `${inProgressSection}\n\n### Ready tasks\nNo ready tasks found in project ${p.projectId}.` }], details: {} };
          }

          const taskList = tasks.map((t: any, idx: number) => {
            const blockingInfo = t.blocking_tasks?.length > 0
              ? `\n   Unlocks when done: ${t.blocking_tasks.map((b: any) => `${b.title} [${b.status}]`).join(', ')}`
              : '';
            const assigned = t.assigned_agent ? ` (assigned: ${t.assigned_agent})` : ' (unassigned — can claim)';
            return `${idx + 1}. [${t.priority || 'P2'}] **${t.title}** (${t.id})${assigned}\n   Status: ${t.status}${t.description ? `\n   ${t.description.substring(0, 100)}${t.description.length > 100 ? '...' : ''}` : ''}${blockingInfo}`;
          }).join('\n\n');

          return {
            content: [{
              type: 'text',
              text: `${inProgressSection}\n\n### Ready tasks — pick independent ones to run in parallel (${tasks.length} candidate(s))\n\n${taskList}\n\n**Parallelism tip**: A ready task is safe to start alongside your in-progress work if none of its blocking_tasks overlap with your in-progress task IDs.`,
            }],
            details: {},
          };
        } catch (err) {
          return { content: [{ type: 'text', text: `Error fetching ready tasks: ${err instanceof Error ? err.message : String(err)}` }], details: {} };
        }
      },
    },

    {
      name: 'claim_task',
      description:
        'Atomically claim an unassigned task so no other agent picks it up simultaneously. ' +
        'Provisions an authenticated git workspace at /home/agent/task-workspaces/{taskId}/ ' +
        'so you can commit and push immediately. Call this BEFORE starting work on a task.',
      label: 'claim_task',
      parameters: Type.Object({
        projectId: Type.String({ description: 'Project ID' }),
        taskId: Type.String({ description: 'Task ID to claim' }),
      }),
      execute: async (
        _toolCallId: string,
        params: unknown,
        signal?: AbortSignal,
      ): Promise<AgentToolResult<VoidDetails>> => {
        const { projectId, taskId } = params as { projectId: string; taskId: string };
        const apiBase = config.apiBaseUrl
          || process.env.DJINNBOT_API_URL
          || 'http://api:8000';
        try {
          const claimUrl = `${apiBase}/v1/projects/${projectId}/tasks/${taskId}/claim`;
          const claimResp = await fetch(claimUrl, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ agentId }),
            signal,
          });
          const claimData = (await claimResp.json()) as any;
          if (!claimResp.ok) throw new Error(claimData.detail || `${claimResp.status} ${claimResp.statusText}`);
          const branch: string = claimData.branch;

          let worktreePath = `/home/agent/task-workspaces/${taskId}`;
          let workspaceNote = '';
          try {
            const wsUrl = `${apiBase}/v1/projects/${projectId}/tasks/${taskId}/workspace`;
            const wsResp = await fetch(wsUrl, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ agentId }),
              signal,
            });
            const wsData = (await wsResp.json()) as any;
            if (wsResp.ok) {
              worktreePath = wsData.worktree_path ?? worktreePath;
              workspaceNote = wsData.already_existed
                ? ' (workspace already existed — prior work is preserved)'
                : ' (new workspace provisioned)';
            } else {
              workspaceNote = ` (workspace setup failed: ${wsData.detail ?? wsResp.status} — you may need to set up git manually)`;
            }
          } catch (wsErr) {
            workspaceNote = ` (workspace setup error: ${wsErr instanceof Error ? wsErr.message : String(wsErr)})`;
          }

          return {
            content: [{
              type: 'text',
              text: [
                `Task claimed successfully.`, ``,
                `**Task ID**: ${taskId}`,
                `**Branch**: ${branch}`,
                `**Workspace**: ${worktreePath}${workspaceNote}`, ``,
                `Your workspace is a git worktree already checked out on branch \`${branch}\`.`,
                `Git credentials are configured — you can push directly:`, ``,
                '```bash',
                `cd ${worktreePath}`,
                `# ... make your changes ...`,
                `git add -A && git commit -m "your message"`,
                `git push`,
                '```', ``,
                `When you are done, call transition_task to move it to 'review'.`,
              ].join('\n'),
            }],
            details: {},
          };
        } catch (err) {
          return { content: [{ type: 'text', text: `Error claiming task: ${err instanceof Error ? err.message : String(err)}` }], details: {} };
        }
      },
    },

    {
      name: 'get_task_context',
      description:
        'Get full details of a specific task: description, status, priority, assigned agent, git branch, PR info. ' +
        'Use this to understand what a task requires before starting work.',
      label: 'get_task_context',
      parameters: Type.Object({
        projectId: Type.String({ description: 'Project ID' }),
        taskId: Type.String({ description: 'Task ID' }),
      }),
      execute: async (
        _toolCallId: string,
        params: unknown,
        signal?: AbortSignal,
      ): Promise<AgentToolResult<VoidDetails>> => {
        const { projectId, taskId } = params as { projectId: string; taskId: string };
        const apiBase = config.apiBaseUrl
          || process.env.DJINNBOT_API_URL
          || 'http://api:8000';
        try {
          const url = `${apiBase}/v1/projects/${projectId}/tasks/${taskId}`;
          const response = await fetch(url, { signal });
          const data = (await response.json()) as any;
          if (!response.ok) throw new Error(data.detail || `${response.status} ${response.statusText}`);
          const meta = data.metadata || {};
          const lines = [
            `**Task**: ${data.title} (${taskId})`,
            `**Status**: ${data.status}  **Priority**: ${data.priority}`,
            `**Assigned**: ${data.assigned_agent || 'unassigned'}`,
            `**Estimated**: ${data.estimated_hours ? `${data.estimated_hours}h` : 'unknown'}`,
            `**Branch**: ${meta.git_branch || 'not yet created (call get_task_branch)'}`,
            `**PR**: ${meta.pr_url || 'none'}`,
            `\n**Description**:\n${data.description || '(no description)'}`,
          ];
          return { content: [{ type: 'text', text: lines.join('\n') }], details: {} };
        } catch (err) {
          return { content: [{ type: 'text', text: `Error fetching task: ${err instanceof Error ? err.message : String(err)}` }], details: {} };
        }
      },
    },

    {
      name: 'open_pull_request',
      description:
        'Open a GitHub pull request for a task branch (feat/{taskId}) targeting main. ' +
        'Call this when your implementation is ready for review. ' +
        'Returns the PR URL and number. Stores the PR link in the task metadata.',
      label: 'open_pull_request',
      parameters: Type.Object({
        projectId: Type.String({ description: 'Project ID' }),
        taskId: Type.String({ description: 'Task ID' }),
        title: Type.String({ description: 'PR title' }),
        body: Type.Optional(Type.String({ description: 'PR description (markdown)' })),
        draft: Type.Optional(Type.Boolean({ description: 'Open as draft PR (default false)' })),
      }),
      execute: async (
        _toolCallId: string,
        params: unknown,
        signal?: AbortSignal,
      ): Promise<AgentToolResult<VoidDetails>> => {
        const { projectId, taskId, title, body, draft } = params as {
          projectId: string; taskId: string; title: string; body?: string; draft?: boolean;
        };
        const apiBase = config.apiBaseUrl
          || process.env.DJINNBOT_API_URL
          || 'http://api:8000';
        try {
          const url = `${apiBase}/v1/projects/${projectId}/tasks/${taskId}/pull-request`;
          const response = await fetch(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ agentId, title, body: body ?? '', draft: draft ?? false }),
            signal,
          });
          const data = (await response.json()) as any;
          if (!response.ok) throw new Error(data.detail || `${response.status} ${response.statusText}`);
          return {
            content: [{
              type: 'text',
              text: [
                `Pull request opened.`, ``,
                `**PR #${data.pr_number}**: ${data.title}`,
                `**URL**: ${data.pr_url}`,
                `**Status**: ${data.draft ? 'Draft' : 'Ready for review'}`, ``,
                `The PR link has been saved to the task. Call transition_task with status 'review' to move the task to the review column.`,
              ].join('\n'),
            }],
            details: {},
          };
        } catch (err) {
          return { content: [{ type: 'text', text: `Error opening PR: ${err instanceof Error ? err.message : String(err)}` }], details: {} };
        }
      },
    },

    {
      name: 'transition_task',
      description:
        'Move a task to a new kanban status (e.g. in_progress → review, review → done). ' +
        'Also cascades dependency unblocking when status is "done". ' +
        'Valid statuses: backlog, planning, ready, in_progress, review, blocked, done, failed.',
      label: 'transition_task',
      parameters: TransitionTaskParamsSchema,
      execute: async (
        _toolCallId: string,
        params: unknown,
        signal?: AbortSignal,
      ): Promise<AgentToolResult<VoidDetails>> => {
        const { projectId, taskId, status, note } = params as TransitionTaskParams;
        const apiBase = config.apiBaseUrl
          || process.env.DJINNBOT_API_URL
          || 'http://api:8000';
        try {
          const url = `${apiBase}/v1/projects/${projectId}/tasks/${taskId}/transition`;
          const response = await fetch(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ status, note }),
            signal,
          });
          const data = (await response.json()) as any;
          if (!response.ok) throw new Error(data.detail || `${response.status} ${response.statusText}`);
          return {
            content: [{ type: 'text', text: `Task transitioned: ${data.from_status} → ${data.to_status}${note ? `\nNote: ${note}` : ''}` }],
            details: {},
          };
        } catch (err) {
          return { content: [{ type: 'text', text: `Error transitioning task: ${err instanceof Error ? err.message : String(err)}` }], details: {} };
        }
      },
    },

    {
      name: 'execute_task',
      description:
        'Start executing a task by triggering its pipeline. This creates a new pipeline run and transitions the task to in_progress state. Use this to kick off structured multi-agent work during pulse.',
      label: 'execute_task',
      parameters: ExecuteTaskParamsSchema,
      execute: async (
        _toolCallId: string,
        params: unknown,
        signal?: AbortSignal,
      ): Promise<AgentToolResult<VoidDetails>> => {
        const p = params as ExecuteTaskParams;
        const apiBase = config.apiBaseUrl
          || process.env.DJINNBOT_API_URL
          || 'http://api:8000';
        try {
          const url = `${apiBase}/v1/projects/${p.projectId}/tasks/${p.taskId}/execute`;
          const body: any = {};
          if (p.pipelineId) body.pipelineId = p.pipelineId;
          const response = await fetch(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body),
            signal,
          });
          if (!response.ok) {
            const errorData = (await response.json().catch(() => ({}))) as { detail?: string };
            throw new Error(errorData.detail || `${response.status} ${response.statusText}`);
          }
          const data = (await response.json()) as { run_id?: string };
          return {
            content: [{
              type: 'text',
              text: `Task execution started!\n\nRun ID: ${data.run_id}\nTask: ${p.taskId}\nProject: ${p.projectId}\n\nThe pipeline is now running autonomously in the engine. Check the dashboard or call get_task_context to follow progress.`,
            }],
            details: {},
          };
        } catch (err) {
          return { content: [{ type: 'text', text: `Error executing task: ${err instanceof Error ? err.message : String(err)}` }], details: {} };
        }
      },
    },

    // fetch_skill_from_web — research a topic and create a skill from the result
    {
      name: 'fetch_skill_from_web',
      description: 'Research a topic from the web and automatically create a skill from the findings. Useful for fetching up-to-date best practices, API documentation, workflows, or procedures and saving them as reusable skills for the team.',
      label: 'fetch_skill_from_web',
      parameters: Type.Object({
        skill_name: Type.String({ description: 'Name for the new skill (e.g. "stripe-webhooks")' }),
        description: Type.String({ description: 'One-line description of what this skill covers' }),
        research_query: Type.String({ description: 'What to research — be specific (e.g. "Stripe webhook verification best practices Node.js 2025")' }),
        tags: Type.Optional(Type.Array(Type.String(), { description: 'Keywords for matching' })),
        focus: Type.Optional(Type.Union([
          Type.Literal('technical'),
          Type.Literal('market'),
          Type.Literal('general'),
          Type.Literal('finance'),
          Type.Literal('marketing'),
          Type.Literal('news'),
        ], { default: 'technical' })),
        scope: Type.Optional(Type.Union([
          Type.Literal('global'),
          Type.Literal('agent'),
        ], { default: 'global' })),
      }),
      execute: async (
        _toolCallId: string,
        params: unknown,
        signal?: AbortSignal,
        _onUpdate?: AgentToolUpdateCallback<VoidDetails>
      ): Promise<AgentToolResult<VoidDetails>> => {
        const p = params as {
          skill_name: string;
          description: string;
          research_query: string;
          tags?: string[];
          focus?: string;
          scope?: 'global' | 'agent';
        };

        // Step 1: Research
        let researchResult: string;
        try {
          researchResult = await performResearch(
            p.research_query,
            p.focus || 'technical',
            'perplexity/sonar-pro',
            signal,
          );
        } catch (err) {
          return { content: [{ type: 'text', text: `Research failed: ${err}` }], details: {} };
        }

        // Step 2: Format as skill content
        const content = [
          `## Source`,
          `_Fetched via web research: "${p.research_query}"_`,
          '',
          researchResult,
        ].join('\n');

        // Step 3: Create skill via API + auto-grant to self
        const apiBase = config.apiBaseUrl || process.env.DJINNBOT_API_URL || 'http://api:8000';
        const scope = p.scope ?? 'global';

        try {
          const createRes = await fetch(`${apiBase}/v1/skills/`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              name: p.skill_name,
              description: p.description,
              tags: p.tags ?? [],
              content,
              scope,
              owner_agent_id: scope === 'agent' ? agentId : null,
            }),
            signal: signal ?? undefined,
          });

          if (!createRes.ok) {
            const errText = await createRes.text();
            return { content: [{ type: 'text', text: `Skill creation failed after research: HTTP ${createRes.status} — ${errText}` }], details: {} };
          }

          const skill = await createRes.json() as { id: string; scope: string };

          // Auto-grant access to creating agent
          await fetch(
            `${apiBase}/v1/skills/agents/${agentId}/${encodeURIComponent(skill.id)}/grant`,
            {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ granted_by: agentId }),
              signal: signal ?? undefined,
            },
          ).catch(() => {});

          return {
            content: [{
              type: 'text',
              text: `Skill "${skill.id}" created from web research and added to the skills library (scope: ${skill.scope}).\n\nResearch summary:\n${researchResult.slice(0, 500)}${researchResult.length > 500 ? '...' : ''}`,
            }],
            details: {},
          };
        } catch (err) {
          return { content: [{ type: 'text', text: `Skill creation failed after research: ${err}` }], details: {} };
        }
      },
    },

    // === Secrets ===

    // get_secret — pull-model access to user-defined credentials.
    // Secrets are stored encrypted at rest by the user and scoped per-agent.
    // The agent requests only what it needs, only when it needs it.
    {
      name: 'get_secret',
      description:
        'Retrieve one or more secrets granted to you by the user. ' +
        'Secrets are credentials like GitHub PATs, GitLab tokens, SSH keys, ' +
        'API keys, or any other sensitive value the user has stored for you. ' +
        'Call this when you need a credential to perform an operation — ' +
        'do NOT assume secrets are available as environment variables. ' +
        'Returns a JSON object mapping environment-variable name → value ' +
        '(e.g. {"GITHUB_TOKEN": "ghp_xxx", "GITLAB_TOKEN": "glpat_yyy"}). ' +
        'If keys is omitted, all secrets granted to you are returned. ' +
        'If keys is provided, only those keys are returned (non-existent keys are silently omitted).',
      label: 'get_secret',
      parameters: Type.Object({
        keys: Type.Optional(Type.Array(Type.String(), {
          description:
            'Optional list of environment-variable names to fetch ' +
            '(e.g. ["GITHUB_TOKEN", "GITLAB_TOKEN"]). ' +
            'Omit to receive all secrets granted to you.',
        })),
      }),
      execute: async (
        _toolCallId: string,
        params: unknown,
        signal?: AbortSignal,
        _onUpdate?: AgentToolUpdateCallback<VoidDetails>
      ): Promise<AgentToolResult<VoidDetails>> => {
        const p = params as { keys?: string[] };
        const apiBase = config.apiBaseUrl || process.env.DJINNBOT_API_URL || 'http://api:8000';

        try {
          const res = await fetch(
            `${apiBase}/v1/secrets/agents/${encodeURIComponent(agentId)}/env`,
            { signal: signal ?? undefined },
          );

          if (res.status === 404) {
            return {
              content: [{ type: 'text', text: 'No secrets have been granted to you.' }],
              details: {},
            };
          }
          if (!res.ok) {
            return {
              content: [{ type: 'text', text: `Failed to fetch secrets: HTTP ${res.status}` }],
              details: {},
            };
          }

          const data = await res.json() as { agent_id: string; env: Record<string, string> };
          let env = data.env ?? {};

          // Filter to requested keys if specified
          if (p.keys && p.keys.length > 0) {
            const filtered: Record<string, string> = {};
            for (const key of p.keys) {
              if (key in env) filtered[key] = env[key];
            }
            env = filtered;
          }

          if (Object.keys(env).length === 0) {
            const msg = p.keys?.length
              ? `None of the requested keys (${p.keys.join(', ')}) are in your granted secrets.`
              : 'No secrets have been granted to you yet. Ask the user to add them in Settings → Secrets.';
            return { content: [{ type: 'text', text: msg }], details: {} };
          }

          const keyList = Object.keys(env).join(', ');
          return {
            content: [{
              type: 'text',
              text: `Secrets retrieved (${Object.keys(env).length} key(s): ${keyList}):\n\n\`\`\`json\n${JSON.stringify(env, null, 2)}\n\`\`\``,
            }],
            details: {},
          };
        } catch (err) {
          return {
            content: [{ type: 'text', text: `Error fetching secrets: ${err instanceof Error ? err.message : String(err)}` }],
            details: {},
          };
        }
      },
    },
  ];
}
