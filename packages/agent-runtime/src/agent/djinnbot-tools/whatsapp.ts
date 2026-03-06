import { Type, type Static } from '@sinclair/typebox';
import type { AgentTool, AgentToolResult, AgentToolUpdateCallback } from '@mariozechner/pi-agent-core';
import { authFetch } from '../../api/auth-fetch.js';
import { checkMessagingPermission } from './messaging-permissions.js';

// ── Schemas ────────────────────────────────────────────────────────────────

const SendWhatsAppMessageParamsSchema = Type.Object({
  to: Type.String({
    description:
      'Recipient phone number in E.164 format (e.g. "+14155551234") or a WhatsApp group JID. ' +
      'This agent can only send to targets explicitly allowed by the admin.',
  }),
  message: Type.String({
    description: 'Message text. Supports WhatsApp formatting (*bold*, _italic_, ~strikethrough~, ```code```).',
  }),
  urgent: Type.Optional(Type.Boolean({
    description: 'When true, prefix the message with an URGENT indicator. Default: false.',
    default: false,
  })),
});
type SendWhatsAppMessageParams = Static<typeof SendWhatsAppMessageParamsSchema>;

const ListWhatsAppPermissionsParamsSchema = Type.Object({});

// ── Types ──────────────────────────────────────────────────────────────────

interface VoidDetails {}

export interface WhatsAppToolsConfig {
  agentId: string;
  apiBaseUrl?: string;
}

// ── Tool factory ───────────────────────────────────────────────────────────

export function createWhatsAppTools(config: WhatsAppToolsConfig): AgentTool[] {
  const { agentId } = config;

  const getApiBase = () =>
    config.apiBaseUrl || process.env.DJINNBOT_API_URL || 'http://api:8000';

  return [
    // ── send_whatsapp_message ────────────────────────────────────────────
    {
      name: 'send_whatsapp_message',
      description:
        'Send a WhatsApp message to a phone number or group. ' +
        'Messages are sent from the shared WhatsApp linked device. ' +
        'Use this to notify users about important events, task completions, or urgent issues. ' +
        'This agent can only send to admin-approved targets — use whatsapp_list_targets to see allowed targets.',
      label: 'send_whatsapp_message',
      parameters: SendWhatsAppMessageParamsSchema,
      execute: async (
        _toolCallId: string,
        params: unknown,
        signal?: AbortSignal,
        _onUpdate?: AgentToolUpdateCallback<VoidDetails>,
      ): Promise<AgentToolResult<VoidDetails>> => {
        const p = params as SendWhatsAppMessageParams;
        const apiBase = getApiBase();

        // Enforce messaging permissions
        const permCheck = await checkMessagingPermission(agentId, 'whatsapp', p.to, apiBase);
        if (!permCheck.allowed) {
          return {
            content: [{ type: 'text', text: `Permission denied: ${permCheck.reason}` }],
            details: {},
          };
        }

        try {
          const res = await authFetch(
            `${apiBase}/v1/whatsapp/${encodeURIComponent(agentId)}/send`,
            {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                to: p.to,
                message: p.message,
                urgent: p.urgent ?? false,
              }),
              signal,
            },
          );

          if (!res.ok) {
            const err = await res.json().catch(() => ({ detail: res.statusText })) as { detail?: string };
            if (res.status === 503) {
              return {
                content: [{
                  type: 'text',
                  text: err.detail ?? 'WhatsApp is not configured or not linked. Ask the user to link WhatsApp in Settings → Channels → WhatsApp.',
                }],
                details: {},
              };
            }
            return {
              content: [{ type: 'text', text: `Failed to send WhatsApp message: ${res.status} — ${err.detail ?? res.statusText}` }],
              details: {},
            };
          }

          const data = await res.json() as { status: string };
          return {
            content: [{ type: 'text', text: `WhatsApp message sent to ${p.to}.` }],
            details: {},
          };
        } catch (err) {
          return {
            content: [{ type: 'text', text: `Error sending WhatsApp message: ${err instanceof Error ? err.message : String(err)}` }],
            details: {},
          };
        }
      },
    },

    // ── whatsapp_list_targets ────────────────────────────────────────────
    {
      name: 'whatsapp_list_targets',
      description:
        'List the phone numbers and groups this agent is allowed to send WhatsApp messages to. ' +
        'A wildcard (*) means the agent can send to any target. ' +
        'Use this before send_whatsapp_message to discover valid recipients.',
      label: 'whatsapp_list_targets',
      parameters: ListWhatsAppPermissionsParamsSchema,
      execute: async (
        _toolCallId: string,
        _params: unknown,
        _signal?: AbortSignal,
        _onUpdate?: AgentToolUpdateCallback<VoidDetails>,
      ): Promise<AgentToolResult<VoidDetails>> => {
        const apiBase = getApiBase();
        try {
          const res = await authFetch(
            `${apiBase}/v1/agents/${encodeURIComponent(agentId)}/messaging-permissions?channel=whatsapp`,
          );
          if (!res.ok) {
            return {
              content: [{ type: 'text', text: 'No WhatsApp messaging permissions configured for this agent.' }],
              details: {},
            };
          }
          const data = (await res.json()) as {
            permissions: Array<{ target: string; label: string | null }>;
          };

          if (data.permissions.length === 0) {
            return {
              content: [{ type: 'text', text: 'No WhatsApp messaging permissions configured. Ask an admin to configure allowed targets.' }],
              details: {},
            };
          }

          const hasWildcard = data.permissions.some((p) => p.target === '*');
          if (hasWildcard) {
            return {
              content: [{ type: 'text', text: 'This agent has wildcard (*) WhatsApp permissions — it can send to any phone number or group.' }],
              details: {},
            };
          }

          const lines = data.permissions.map((p) => {
            const label = p.label ? ` (${p.label})` : '';
            return `• ${p.target}${label}`;
          });
          return {
            content: [{ type: 'text', text: `Allowed WhatsApp targets:\n\n${lines.join('\n')}` }],
            details: {},
          };
        } catch (err) {
          return {
            content: [{ type: 'text', text: `Error fetching WhatsApp permissions: ${err instanceof Error ? err.message : String(err)}` }],
            details: {},
          };
        }
      },
    },
  ];
}
