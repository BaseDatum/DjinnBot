import { Type, type Static } from '@sinclair/typebox';
import type { AgentTool, AgentToolResult, AgentToolUpdateCallback } from '@mariozechner/pi-agent-core';
import { authFetch } from '../../api/auth-fetch.js';
import { checkMessagingPermission } from './messaging-permissions.js';

// -- Schemas ------------------------------------------------------------------

const SendTelegramMessageParamsSchema = Type.Object({
  chatId: Type.String({
    description:
      'Telegram chat ID (numeric, e.g. "12345678") or @username. ' +
      'This is the recipient who will receive the message from this agent\'s bot. ' +
      'This agent can only send to targets explicitly allowed by the admin.',
  }),
  message: Type.String({
    description: 'Message text. Supports markdown formatting (**bold**, *italic*, `code`).',
  }),
  urgent: Type.Optional(Type.Boolean({
    description: 'When true, prefix the message with an URGENT indicator. Default: false.',
    default: false,
  })),
});
type SendTelegramMessageParams = Static<typeof SendTelegramMessageParamsSchema>;

const ListTelegramPermissionsParamsSchema = Type.Object({});

// -- Types --------------------------------------------------------------------

interface VoidDetails {}

export interface TelegramToolsConfig {
  agentId: string;
  apiBaseUrl?: string;
}

// -- Tool factory -------------------------------------------------------------

export function createTelegramTools(config: TelegramToolsConfig): AgentTool[] {
  const { agentId } = config;

  const getApiBase = () =>
    config.apiBaseUrl || process.env.DJINNBOT_API_URL || 'http://api:8000';

  return [
    {
      name: 'send_telegram_message',
      description:
        'Send a Telegram message to a specific user or chat for escalation or notification. ' +
        'The message is sent from this agent\'s Telegram bot. ' +
        'Use this to proactively notify users about important events, task completions, or urgent issues. ' +
        'The recipient must have previously started a conversation with the bot. ' +
        'This agent can only send to admin-approved targets — use telegram_list_targets to see allowed targets.',
      label: 'send_telegram_message',
      parameters: SendTelegramMessageParamsSchema,
      execute: async (
        _toolCallId: string,
        params: unknown,
        signal?: AbortSignal,
        _onUpdate?: AgentToolUpdateCallback<VoidDetails>,
      ): Promise<AgentToolResult<VoidDetails>> => {
        const p = params as SendTelegramMessageParams;
        const apiBase = getApiBase();

        // Enforce messaging permissions
        const permCheck = await checkMessagingPermission(agentId, 'telegram', p.chatId, apiBase);
        if (!permCheck.allowed) {
          return {
            content: [{ type: 'text', text: `Permission denied: ${permCheck.reason}` }],
            details: {},
          };
        }

        try {
          const response = await authFetch(
            `${apiBase}/v1/telegram/${agentId}/send`,
            {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                chatId: p.chatId,
                message: p.message,
                urgent: p.urgent ?? false,
              }),
              signal,
            },
          );

          if (!response.ok) {
            const errorText = await response.text().catch(() => 'Unknown error');
            return {
              content: [{ type: 'text', text: `Failed to send Telegram message: ${response.status} ${errorText}` }],
              details: {},
            };
          }

          const data = await response.json() as { status: string };
          return {
            content: [{ type: 'text', text: `Telegram message sent to ${p.chatId}.` }],
            details: {},
          };
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          return {
            content: [{ type: 'text', text: `Failed to send Telegram message: ${msg}` }],
            details: {},
          };
        }
      },
    },

    // ── telegram_list_targets ──────────────────────────────────────────────
    {
      name: 'telegram_list_targets',
      description:
        'List the Telegram chat IDs and usernames this agent is allowed to send messages to. ' +
        'A wildcard (*) means the agent can send to any target. ' +
        'Use this before send_telegram_message to discover valid recipients.',
      label: 'telegram_list_targets',
      parameters: ListTelegramPermissionsParamsSchema,
      execute: async (
        _toolCallId: string,
        _params: unknown,
        _signal?: AbortSignal,
        _onUpdate?: AgentToolUpdateCallback<VoidDetails>,
      ): Promise<AgentToolResult<VoidDetails>> => {
        const apiBase = getApiBase();
        try {
          const res = await authFetch(
            `${apiBase}/v1/agents/${encodeURIComponent(agentId)}/messaging-permissions?channel=telegram`,
          );
          if (!res.ok) {
            return {
              content: [{ type: 'text', text: 'No Telegram messaging permissions configured for this agent.' }],
              details: {},
            };
          }
          const data = (await res.json()) as {
            permissions: Array<{ target: string; label: string | null }>;
          };

          if (data.permissions.length === 0) {
            return {
              content: [{ type: 'text', text: 'No Telegram messaging permissions configured. Ask an admin to configure allowed targets.' }],
              details: {},
            };
          }

          const hasWildcard = data.permissions.some((p) => p.target === '*');
          if (hasWildcard) {
            return {
              content: [{ type: 'text', text: 'This agent has wildcard (*) Telegram permissions — it can send to any chat ID or username.' }],
              details: {},
            };
          }

          const lines = data.permissions.map((p) => {
            const label = p.label ? ` (${p.label})` : '';
            return `• ${p.target}${label}`;
          });
          return {
            content: [{ type: 'text', text: `Allowed Telegram targets:\n\n${lines.join('\n')}` }],
            details: {},
          };
        } catch (err) {
          return {
            content: [{ type: 'text', text: `Error fetching Telegram permissions: ${err instanceof Error ? err.message : String(err)}` }],
            details: {},
          };
        }
      },
    },
  ];
}
