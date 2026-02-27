import { Type, type Static } from '@sinclair/typebox';
import type { AgentTool, AgentToolResult, AgentToolUpdateCallback } from '@mariozechner/pi-agent-core';
import { authFetch } from '../../api/auth-fetch.js';

// -- Schemas ------------------------------------------------------------------

const SendTelegramMessageParamsSchema = Type.Object({
  chatId: Type.String({
    description:
      'Telegram chat ID (numeric, e.g. "12345678") or @username. ' +
      'This is the recipient who will receive the message from this agent\'s bot.',
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
        'The recipient must have previously started a conversation with the bot.',
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
  ];
}
