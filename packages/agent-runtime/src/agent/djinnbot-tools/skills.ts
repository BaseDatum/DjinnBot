import { Type } from '@sinclair/typebox';
import type { AgentTool, AgentToolResult, AgentToolUpdateCallback } from '@mariozechner/pi-agent-core';
import { authFetch } from '../../api/auth-fetch.js';
import { performResearch } from '@djinnbot/core';

// ── Types ──────────────────────────────────────────────────────────────────

interface VoidDetails {}

export interface SkillsToolsConfig {
  agentId: string;
  apiBaseUrl?: string;
}

// ── Tool factories ─────────────────────────────────────────────────────────

export function createSkillsTools(config: SkillsToolsConfig): AgentTool[] {
  const { agentId } = config;

  const getApiBase = () =>
    config.apiBaseUrl || process.env.DJINNBOT_API_URL || 'http://api:8000';

  return [
    // load_skill — gated content retrieval via API (access-controlled)
    {
      name: 'load_skill',
      description: 'Load skill instructions or companion files. Without a file param, loads the main SKILL.md. With file param, loads a specific sub-file (e.g. "references/css-patterns.md", "templates/architecture.html"). The main skill instructions list available sub-files.',
      label: 'load_skill',
      parameters: Type.Object({
        name: Type.String({ description: 'Skill name exactly as shown in the SKILLS manifest' }),
        file: Type.Optional(Type.String({
          description: 'Optional sub-file path within the skill directory (e.g. "references/css-patterns.md", "templates/architecture.html"). Omit to load the main SKILL.md.',
        })),
      }),
      execute: async (
        _toolCallId: string,
        params: unknown,
        signal?: AbortSignal,
        _onUpdate?: AgentToolUpdateCallback<VoidDetails>
      ): Promise<AgentToolResult<VoidDetails>> => {
        const p = params as { name: string; file?: string };
        const apiBase = getApiBase();

        try {
          let url = `${apiBase}/v1/skills/agents/${agentId}/${encodeURIComponent(p.name)}/content`;
          if (p.file) {
            url += `?file=${encodeURIComponent(p.file)}`;
          }

          const res = await authFetch(url, { signal: signal ?? undefined });
          if (res.status === 404) {
            const target = p.file ? `File "${p.file}" in skill "${p.name}"` : `Skill "${p.name}"`;
            return {
              content: [{ type: 'text', text: `${target} not found. Available skills are listed in your SKILLS manifest.` }],
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
          const data = await res.json() as { id: string; description: string; content: string; file?: string; has_files?: boolean };

          if (p.file) {
            return {
              content: [{ type: 'text', text: `# SKILL FILE: ${data.id}/${data.file}\n\n${data.content}` }],
              details: {},
            };
          }

          let text = `# SKILL: ${data.id}\n_${data.description}_\n\n${data.content}`;
          if (data.has_files) {
            text += `\n\n---\n_This skill has companion files. Use \`load_skill("${data.id}", file="<path>")\` to load templates, references, or examples._`;
          }
          return {
            content: [{ type: 'text', text }],
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

        const apiBase = getApiBase();
        const scope = p.scope ?? 'global';

        try {
          const createRes = await authFetch(`${apiBase}/v1/skills/`, {
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

          const grantRes = await authFetch(
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
        const apiBase = getApiBase();
        const scope = p.scope ?? 'global';

        try {
          const createRes = await authFetch(`${apiBase}/v1/skills/`, {
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

          await authFetch(
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
  ];
}
