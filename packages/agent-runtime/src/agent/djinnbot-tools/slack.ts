import { Type, type Static } from '@sinclair/typebox';
import type { AgentTool, AgentToolResult, AgentToolUpdateCallback } from '@mariozechner/pi-agent-core';
import { authFetch } from '../../api/auth-fetch.js';

// ── Schemas ────────────────────────────────────────────────────────────────

const SendMessageParamsSchema = Type.Object({
  channel: Type.String({
    description:
      'Channel ID (e.g. C0ABC1234) or name with or without a leading # ' +
      '(e.g. "general" or "#general"). ' +
      'Using the channel ID is more reliable — use slack_lookup_channel if you only know the name.',
  }),
  text: Type.String({
    description: 'Message text. Supports Slack mrkdwn formatting (*bold*, _italic_, `code`, ```blocks```).',
  }),
  thread_ts: Type.Optional(Type.String({
    description:
      'Optional. Timestamp of the parent message to reply in a thread. ' +
      'Looks like "1234567890.123456". Omit to post a new top-level message.',
  })),
});
type SendMessageParams = Static<typeof SendMessageParamsSchema>;

const ListChannelsParamsSchema = Type.Object({
  limit: Type.Optional(Type.Number({
    description: 'Maximum number of channels to return (default 200, max 1000).',
    default: 200,
  })),
});
type ListChannelsParams = Static<typeof ListChannelsParamsSchema>;

const LookupChannelParamsSchema = Type.Object({
  name: Type.String({
    description: 'Channel name to look up, with or without a leading # (e.g. "general" or "#general").',
  }),
});
type LookupChannelParams = Static<typeof LookupChannelParamsSchema>;

// ── Types ──────────────────────────────────────────────────────────────────

interface VoidDetails {}

export interface SlackToolsConfig {
  agentId: string;
  apiBaseUrl?: string;
}

// ── Tool factories ─────────────────────────────────────────────────────────

export function createSlackTools(config: SlackToolsConfig): AgentTool[] {
  const { agentId } = config;

  const getApiBase = () =>
    config.apiBaseUrl || process.env.DJINNBOT_API_URL || 'http://api:8000';

  return [
    // ── slack_send_message ──────────────────────────────────────────────────
    {
      name: 'slack_send_message',
      description:
        'Send a message to a Slack channel. ' +
        'The channel can be specified as a channel ID (C…) or a name with or without #. ' +
        'Use slack_lookup_channel if you need to find the ID for a channel name first. ' +
        'Supports Slack mrkdwn for formatting. ' +
        'Optionally reply in a thread by providing thread_ts.',
      label: 'slack_send_message',
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
            channel: p.channel,
            text: p.text,
          };
          if (p.thread_ts) body.thread_ts = p.thread_ts;

          const res = await authFetch(
            `${apiBase}/v1/slack/${encodeURIComponent(agentId)}/send-message`,
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
                  text: err.detail ?? 'Slack is not configured for this agent. Ask the user to add a Bot Token in Settings → Channels → Slack.',
                }],
                details: {},
              };
            }
            return {
              content: [{ type: 'text', text: `Failed to send Slack message: ${res.status} — ${err.detail ?? res.statusText}` }],
              details: {},
            };
          }

          const data = await res.json() as { channel: string; ts: string };
          return {
            content: [{
              type: 'text',
              text: `Message sent to <#${data.channel}> (ts: ${data.ts}).`,
            }],
            details: {},
          };
        } catch (err) {
          return {
            content: [{ type: 'text', text: `Error sending Slack message: ${err instanceof Error ? err.message : String(err)}` }],
            details: {},
          };
        }
      },
    },

    // ── slack_list_channels ─────────────────────────────────────────────────
    {
      name: 'slack_list_channels',
      description:
        'List the Slack channels that this agent\'s bot is a member of. ' +
        'Returns channel IDs, names, membership status, and optional topic/purpose. ' +
        'The bot can only post to channels it has joined. ' +
        'Use this to discover available channels before sending a message.',
      label: 'slack_list_channels',
      parameters: ListChannelsParamsSchema,
      execute: async (
        _toolCallId: string,
        params: unknown,
        signal?: AbortSignal,
        _onUpdate?: AgentToolUpdateCallback<VoidDetails>,
      ): Promise<AgentToolResult<VoidDetails>> => {
        const p = params as ListChannelsParams;
        const apiBase = getApiBase();
        const limit = p.limit ?? 200;

        try {
          const url = new URL(`${apiBase}/v1/slack/${encodeURIComponent(agentId)}/channels`);
          url.searchParams.set('limit', String(limit));

          const res = await authFetch(url.toString(), { signal: signal ?? undefined });

          if (!res.ok) {
            const err = await res.json().catch(() => ({ detail: res.statusText })) as { detail?: string };
            if (res.status === 503) {
              return {
                content: [{
                  type: 'text',
                  text: err.detail ?? 'Slack is not configured for this agent.',
                }],
                details: {},
              };
            }
            return {
              content: [{ type: 'text', text: `Failed to list Slack channels: ${res.status} — ${err.detail ?? res.statusText}` }],
              details: {},
            };
          }

          const data = await res.json() as {
            channels: Array<{
              id: string;
              name: string;
              is_private: boolean;
              is_member: boolean;
              num_members?: number;
              topic?: string;
              purpose?: string;
            }>;
            total: number;
          };

          if (data.total === 0) {
            return {
              content: [{
                type: 'text',
                text: 'The bot is not a member of any Slack channels. Invite the bot to a channel first.',
              }],
              details: {},
            };
          }

          const lines = data.channels.map(ch => {
            const visibility = ch.is_private ? 'private' : 'public';
            const members = ch.num_members != null ? `, ${ch.num_members} members` : '';
            const topic = ch.topic ? ` — ${ch.topic}` : '';
            return `• ${ch.id}  #${ch.name}  (${visibility}${members})${topic}`;
          });

          return {
            content: [{
              type: 'text',
              text: `${data.total} Slack channel(s):\n\n${lines.join('\n')}`,
            }],
            details: {},
          };
        } catch (err) {
          return {
            content: [{ type: 'text', text: `Error listing Slack channels: ${err instanceof Error ? err.message : String(err)}` }],
            details: {},
          };
        }
      },
    },

    // ── slack_lookup_channel ────────────────────────────────────────────────
    {
      name: 'slack_lookup_channel',
      description:
        'Look up a Slack channel\'s ID by its name. ' +
        'Returns the channel ID (C…), name, and whether the bot is a member. ' +
        'Use this when you know the channel name (e.g. "general") but need the ID ' +
        'to reliably address it with slack_send_message.',
      label: 'slack_lookup_channel',
      parameters: LookupChannelParamsSchema,
      execute: async (
        _toolCallId: string,
        params: unknown,
        signal?: AbortSignal,
        _onUpdate?: AgentToolUpdateCallback<VoidDetails>,
      ): Promise<AgentToolResult<VoidDetails>> => {
        const p = params as LookupChannelParams;
        const apiBase = getApiBase();

        try {
          const url = new URL(`${apiBase}/v1/slack/${encodeURIComponent(agentId)}/channels/lookup`);
          url.searchParams.set('name', p.name);

          const res = await authFetch(url.toString(), { signal: signal ?? undefined });

          if (res.status === 404) {
            const err = await res.json().catch(() => ({ detail: `Channel '${p.name}' not found` })) as { detail?: string };
            return {
              content: [{ type: 'text', text: err.detail ?? `Channel '${p.name}' not found or bot is not a member.` }],
              details: {},
            };
          }

          if (!res.ok) {
            const err = await res.json().catch(() => ({ detail: res.statusText })) as { detail?: string };
            if (res.status === 503) {
              return {
                content: [{
                  type: 'text',
                  text: err.detail ?? 'Slack is not configured for this agent.',
                }],
                details: {},
              };
            }
            return {
              content: [{ type: 'text', text: `Failed to look up Slack channel: ${res.status} — ${err.detail ?? res.statusText}` }],
              details: {},
            };
          }

          const data = await res.json() as {
            id: string;
            name: string;
            is_private: boolean;
            is_member: boolean;
          };

          const memberNote = data.is_member
            ? 'Bot is a member — ready to send messages.'
            : 'Bot is NOT a member of this channel. Invite the bot first.';

          return {
            content: [{
              type: 'text',
              text: `Channel found:\n• ID: ${data.id}\n• Name: #${data.name}\n• Visibility: ${data.is_private ? 'private' : 'public'}\n• ${memberNote}`,
            }],
            details: {},
          };
        } catch (err) {
          return {
            content: [{ type: 'text', text: `Error looking up Slack channel: ${err instanceof Error ? err.message : String(err)}` }],
            details: {},
          };
        }
      },
    },
  ];
}
