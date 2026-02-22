import { Type } from '@sinclair/typebox';
import type { AgentTool, AgentToolResult, AgentToolUpdateCallback } from '@mariozechner/pi-agent-core';
import { authFetch } from '../../api/auth-fetch.js';

// ── Types ──────────────────────────────────────────────────────────────────

interface VoidDetails {}

export interface SecretsToolsConfig {
  agentId: string;
  apiBaseUrl?: string;
}

// ── Tool factories ─────────────────────────────────────────────────────────

export function createSecretsTools(config: SecretsToolsConfig): AgentTool[] {
  const { agentId } = config;

  const getApiBase = () =>
    config.apiBaseUrl || process.env.DJINNBOT_API_URL || 'http://api:8000';

  return [
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
        const apiBase = getApiBase();

        try {
          const headers: Record<string, string> = {};
          const internalToken = process.env.ENGINE_INTERNAL_TOKEN;
          if (internalToken) {
            headers['Authorization'] = `Bearer ${internalToken}`;
          }
          const res = await authFetch(
            `${apiBase}/v1/secrets/agents/${encodeURIComponent(agentId)}/env`,
            { signal: signal ?? undefined, headers },
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
