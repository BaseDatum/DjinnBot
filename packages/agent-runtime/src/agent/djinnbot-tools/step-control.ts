import { Type, type Static } from '@sinclair/typebox';
import type { AgentTool, AgentToolResult, AgentToolUpdateCallback } from '@mariozechner/pi-agent-core';

// ── Schemas ────────────────────────────────────────────────────────────────

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

// ── Types ──────────────────────────────────────────────────────────────────

interface VoidDetails {}

export interface StepControlConfig {
  onComplete: (outputs: Record<string, string>, summary?: string) => void;
  onFail: (error: string, details?: string) => void;
}

// ── Tool factories ─────────────────────────────────────────────────────────

export function createStepControlTools(config: StepControlConfig): AgentTool[] {
  const { onComplete, onFail } = config;

  return [
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
  ];
}
