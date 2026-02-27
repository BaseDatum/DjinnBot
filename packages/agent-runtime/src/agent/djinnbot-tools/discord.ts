import { Type, type Static } from '@sinclair/typebox';
import type { AgentTool, AgentToolResult, AgentToolUpdateCallback } from '@mariozechner/pi-agent-core';
import { authFetch } from '../../api/auth-fetch.js';

// ── Schemas ────────────────────────────────────────────────────────────────

const SendMessageParamsSchema = Type.Object({
  target: Type.String({
    description:
      'Discord channel ID (e.g. 123456789012345678) or user ID for DM. ' +
      'Use discord_list_channels to find available channel IDs.',
  }),
  text: Type.String({
    description: 'Message text. Supports Discord markdown formatting (**bold**, *italic*, `code`, ```blocks```).',
  }),
  thread_id: Type.Optional(Type.String({
    description:
      'Optional. Thread ID to reply in. Omit to post a new top-level message.',
  })),
});
type SendMessageParams = Static<typeof SendMessageParamsSchema>;

const ListChannelsParamsSchema = Type.Object({
  limit: Type.Optional(Type.Number({
    description: 'Maximum number of channels to return (default 50, max 200).',
    default: 50,
  })),
});
type ListChannelsParams = Static<typeof ListChannelsParamsSchema>;

const LookupUserParamsSchema = Type.Object({
  user_id: Type.String({
    description: 'Discord user ID (snowflake) to look up.',
  }),
});
type LookupUserParams = Static<typeof LookupUserParamsSchema>;

// ── Types ──────────────────────────────────────────────────────────────────

interface VoidDetails {}

export interface DiscordToolsConfig {
  agentId: string;
  apiBaseUrl?: string;
}

// ── Tool factories ─────────────────────────────────────────────────────────

export function createDiscordTools(config: DiscordToolsConfig): AgentTool[] {
  const { agentId } = config;

  const getApiBase = () =>
    config.apiBaseUrl || process.env.DJINNBOT_API_URL || 'http://api:8000';

  return [
    // ── discord_send_message ──────────────────────────────────────────────
    {
      name: 'discord_send_message',
      description:
        'Send a message to a Discord channel or DM a user. ' +
        'The target can be a channel ID or user ID. ' +
        'Use discord_list_channels to discover available channels first. ' +
        'Supports Discord markdown for formatting. ' +
        'Optionally reply in a thread by providing thread_id.',
      label: 'discord_send_message',
      parameters: SendMessageParamsSchema,
      execute: async (
        _toolCallId: string,
        params: unknown,
        signal?: AbortSignal,
        _onUpdate?: AgentToolUpdateCallback<VoidDetails>,
      ): Promise<AgentToolResult<VoidDetails>> => {
        const p = params as SendMessageParams;
        const apiBase = getApiBase();

        try {
          const body: Record<string, unknown> = {
            target: p.target,
            text: p.text,
          };
          if (p.thread_id) body.thread_id = p.thread_id;

          const res = await authFetch(
            `${apiBase}/v1/discord/${encodeURIComponent(agentId)}/send-message`,
            {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify(body),
              signal: signal ?? undefined,
            },
          );

          if (!res.ok) {
            const err = await res.json().catch(() => ({ detail: res.statusText })) as { detail?: string };
            if (res.status === 503) {
              return {
                content: [{
                  type: 'text',
                  text: err.detail ?? 'Discord is not configured for this agent. Ask the user to add a Bot Token in Settings → Channels → Discord.',
                }],
                details: {},
              };
            }
            return {
              content: [{ type: 'text', text: `Failed to send Discord message: ${res.status} — ${err.detail ?? res.statusText}` }],
              details: {},
            };
          }

          const data = await res.json() as { channel_id: string; message_id: string };
          return {
            content: [{
              type: 'text',
              text: `Message sent to channel ${data.channel_id} (message ID: ${data.message_id}).`,
            }],
            details: {},
          };
        } catch (err) {
          return {
            content: [{ type: 'text', text: `Error sending Discord message: ${err instanceof Error ? err.message : String(err)}` }],
            details: {},
          };
        }
      },
    },

    // ── discord_list_channels ─────────────────────────────────────────────
    {
      name: 'discord_list_channels',
      description:
        'List the Discord channels that this agent\'s bot has access to. ' +
        'Returns channel IDs, names, types (text/voice/thread), and guild name. ' +
        'Use this to discover available channels before sending a message.',
      label: 'discord_list_channels',
      parameters: ListChannelsParamsSchema,
      execute: async (
        _toolCallId: string,
        params: unknown,
        signal?: AbortSignal,
        _onUpdate?: AgentToolUpdateCallback<VoidDetails>,
      ): Promise<AgentToolResult<VoidDetails>> => {
        const p = params as ListChannelsParams;
        const apiBase = getApiBase();
        const limit = p.limit ?? 50;

        try {
          const url = new URL(`${apiBase}/v1/discord/${encodeURIComponent(agentId)}/channels`);
          url.searchParams.set('limit', String(limit));

          const res = await authFetch(url.toString(), { signal: signal ?? undefined });

          if (!res.ok) {
            const err = await res.json().catch(() => ({ detail: res.statusText })) as { detail?: string };
            if (res.status === 503) {
              return {
                content: [{
                  type: 'text',
                  text: err.detail ?? 'Discord is not configured for this agent.',
                }],
                details: {},
              };
            }
            return {
              content: [{ type: 'text', text: `Failed to list Discord channels: ${res.status} — ${err.detail ?? res.statusText}` }],
              details: {},
            };
          }

          const data = await res.json() as {
            channels: Array<{
              id: string;
              name: string;
              type: string;
              guild_name?: string;
              topic?: string;
            }>;
            total: number;
          };

          if (data.total === 0) {
            return {
              content: [{
                type: 'text',
                text: 'The bot has no accessible channels. Make sure it\'s been added to a server.',
              }],
              details: {},
            };
          }

          const lines = data.channels.map(ch => {
            const guild = ch.guild_name ? ` [${ch.guild_name}]` : '';
            const topic = ch.topic ? ` — ${ch.topic}` : '';
            return `• ${ch.id}  #${ch.name}  (${ch.type})${guild}${topic}`;
          });

          return {
            content: [{
              type: 'text',
              text: `${data.total} Discord channel(s):\n\n${lines.join('\n')}`,
            }],
            details: {},
          };
        } catch (err) {
          return {
            content: [{ type: 'text', text: `Error listing Discord channels: ${err instanceof Error ? err.message : String(err)}` }],
            details: {},
          };
        }
      },
    },

    // ── discord_lookup_user ───────────────────────────────────────────────
    {
      name: 'discord_lookup_user',
      description:
        'Look up a Discord user by their user ID. ' +
        'Returns the user\'s username, display name, and whether they\'re a bot. ' +
        'Use this to verify a user ID before sending a DM.',
      label: 'discord_lookup_user',
      parameters: LookupUserParamsSchema,
      execute: async (
        _toolCallId: string,
        params: unknown,
        signal?: AbortSignal,
        _onUpdate?: AgentToolUpdateCallback<VoidDetails>,
      ): Promise<AgentToolResult<VoidDetails>> => {
        const p = params as LookupUserParams;
        const apiBase = getApiBase();

        try {
          const url = new URL(`${apiBase}/v1/discord/${encodeURIComponent(agentId)}/users/${encodeURIComponent(p.user_id)}`);

          const res = await authFetch(url.toString(), { signal: signal ?? undefined });

          if (res.status === 404) {
            return {
              content: [{ type: 'text', text: `User with ID '${p.user_id}' not found.` }],
              details: {},
            };
          }

          if (!res.ok) {
            const err = await res.json().catch(() => ({ detail: res.statusText })) as { detail?: string };
            return {
              content: [{ type: 'text', text: `Failed to look up Discord user: ${res.status} — ${err.detail ?? res.statusText}` }],
              details: {},
            };
          }

          const data = await res.json() as {
            id: string;
            username: string;
            display_name?: string;
            is_bot: boolean;
          };

          return {
            content: [{
              type: 'text',
              text: `User found:\n• ID: ${data.id}\n• Username: ${data.username}\n• Display name: ${data.display_name ?? 'none'}\n• Bot: ${data.is_bot ? 'yes' : 'no'}`,
            }],
            details: {},
          };
        } catch (err) {
          return {
            content: [{ type: 'text', text: `Error looking up Discord user: ${err instanceof Error ? err.message : String(err)}` }],
            details: {},
          };
        }
      },
    },
  ];
}
