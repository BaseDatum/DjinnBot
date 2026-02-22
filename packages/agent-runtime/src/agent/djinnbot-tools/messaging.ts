import { Type, type Static } from '@sinclair/typebox';
import type { AgentTool, AgentToolResult, AgentToolUpdateCallback } from '@mariozechner/pi-agent-core';
import type { RedisPublisher } from '../../redis/publisher.js';
import type { RequestIdRef } from '../runner.js';
import type { AgentMessageEvent, SlackDmEvent } from '@djinnbot/core';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';

// ── Schemas ────────────────────────────────────────────────────────────────

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

  return [
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
