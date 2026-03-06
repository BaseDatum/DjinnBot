import { Type, type Static } from '@sinclair/typebox';
import type { AgentTool, AgentToolResult, AgentToolUpdateCallback } from '@mariozechner/pi-agent-core';
import type { RedisPublisher } from '../../redis/publisher.js';
import type { RequestIdRef } from '../runner.js';
import type { AgentMessageEvent, SlackDmEvent, WakeAgentEvent } from '@djinnbot/core';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';

// ── Schemas ────────────────────────────────────────────────────────────────

const MessageAgentParamsSchema = Type.Object({
  to: Type.String({ description: 'Agent ID' }),
  message: Type.String({ description: 'Message content' }),
  priority: Type.Optional(Type.Union([
    Type.Literal('low'),
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

const WakeAgentParamsSchema = Type.Object({
  to: Type.String({ description: 'Agent ID to wake immediately' }),
  message: Type.String({ description: 'Message explaining why they need to wake up now' }),
  reason: Type.Union([
    Type.Literal('user_request'),
    Type.Literal('blocker'),
    Type.Literal('critical_finding'),
  ], { description: 'Why this warrants an immediate wake-up (not just a normal inbox message)' }),
});
type WakeAgentParams = Static<typeof WakeAgentParamsSchema>;

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

// ── Types ──────────────────────────────────────────────────────────────────

interface VoidDetails {}

export interface MessagingToolsConfig {
  publisher: RedisPublisher;
  requestIdRef: RequestIdRef;
  vaultPath: string;
}

// ── Tool factories ─────────────────────────────────────────────────────────

export function createMessagingTools(config: MessagingToolsConfig): AgentTool[] {
  const { publisher, requestIdRef, vaultPath } = config;

  // Per-session rate limit for wake_agent (max 3 per session)
  let wakeCount = 0;
  const MAX_WAKES_PER_SESSION = 3;

  return [
    // === message_agent — Normal inbox delivery (checked on next pulse) ===
    {
      name: 'message_agent',
      description:
        'Send a message to another agent\'s inbox. They will see it on their next scheduled pulse. ' +
        'Use for: status updates, FYI messages, non-blocking review requests, general collaboration. ' +
        'For truly urgent things that need immediate attention, use wake_agent instead.',
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
        return {
          content: [{
            type: 'text',
            text: `Message sent to ${p.to}'s inbox. They'll see it on their next pulse wake-up.`,
          }],
          details: {},
        };
      },
    },

    // === wake_agent — Immediately wake another agent ===
    {
      name: 'wake_agent',
      description:
        'Immediately wake another agent and start a session with your message. ' +
        'This is EXPENSIVE — it spins up a container and runs an LLM session. ' +
        'Only use when: (1) a user explicitly requested something be done now, ' +
        '(2) you are blocked and need the other agent to unblock you immediately, or ' +
        '(3) you found a critical issue that needs immediate attention. ' +
        'Rate limited to 3 calls per session. For non-urgent communication, use message_agent instead.',
      label: 'wake_agent',
      parameters: WakeAgentParamsSchema,
      execute: async (
        _toolCallId: string,
        params: unknown,
        _signal?: AbortSignal,
        _onUpdate?: AgentToolUpdateCallback<VoidDetails>
      ): Promise<AgentToolResult<VoidDetails>> => {
        const p = params as WakeAgentParams;

        // Enforce per-session rate limit
        if (wakeCount >= MAX_WAKES_PER_SESSION) {
          return {
            content: [{
              type: 'text',
              text:
                `Rate limit reached: you have already used wake_agent ${MAX_WAKES_PER_SESSION} times this session. ` +
                `Use message_agent to send a normal inbox message instead.`,
            }],
            details: {},
          };
        }

        wakeCount++;

        // Emit dedicated wakeAgent event — engine handles this directly
        // as a wake trigger (no priority routing, no inbox dependency).
        const wakeEvent: Omit<WakeAgentEvent, 'timestamp'> = {
          type: 'wakeAgent',
          requestId: requestIdRef.current,
          to: p.to,
          message: p.message,
          reason: p.reason,
        };
        await publisher.publishEvent(wakeEvent as any);

        // Also send to inbox so the message is persisted and visible
        // even if the wake is suppressed by guardrails.
        const inboxEvent: Omit<AgentMessageEvent, 'timestamp'> = {
          type: 'agentMessage',
          requestId: requestIdRef.current,
          to: p.to,
          message: `[WAKE: ${p.reason}] ${p.message}`,
          priority: 'urgent',
          messageType: p.reason === 'blocker' ? 'unblock' : p.reason === 'user_request' ? 'help_request' : 'info',
        };
        await publisher.publishEvent(inboxEvent as any);

        return {
          content: [{
            type: 'text',
            text:
              `Wake signal sent to ${p.to} (reason: ${p.reason}). ` +
              `They will be woken immediately if within their wake budget. ` +
              `Message also sent to their inbox. ` +
              `(${MAX_WAKES_PER_SESSION - wakeCount} wake calls remaining this session)`,
          }],
          details: {},
        };
      },
    },

    {
      name: 'slack_dm',
      description: 'Send a DM to the user via Slack. Use for urgent findings, questions requiring human input, or blockers you cannot resolve.',
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
        return { content: [{ type: 'text', text: 'Message sent to user' }], details: {} };
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
  ];
}
