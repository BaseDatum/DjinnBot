import { Type, type Static } from '@sinclair/typebox';
import type { AgentTool, AgentToolResult, AgentToolUpdateCallback } from '@mariozechner/pi-agent-core';
import { performResearchWithMeta } from '@djinnbot/core';
import { logToolLlmCall } from './log-tool-llm-call.js';

// ── Schemas ────────────────────────────────────────────────────────────────

const ResearchParamsSchema = Type.Object({
  query: Type.String({
    description: 'The research question or topic to investigate. Be specific — e.g. "current SaaS valuation multiples for B2B tools 2025" or "competitor pricing for AI coding assistants"',
  }),
  focus: Type.Optional(Type.Union([
    Type.Literal('finance'),
    Type.Literal('marketing'),
    Type.Literal('technical'),
    Type.Literal('market'),
    Type.Literal('news'),
    Type.Literal('general'),
  ], {
    default: 'general',
    description: 'Domain focus to guide the research model toward relevant sources',
  })),
  model: Type.Optional(Type.String({
    default: 'perplexity/sonar-pro',
    description: 'Perplexity model on OpenRouter. Options: perplexity/sonar-pro (default, best quality), perplexity/sonar (faster, lighter), perplexity/sonar-reasoning (deeper reasoning for complex topics)',
  })),
});
type ResearchParams = Static<typeof ResearchParamsSchema>;

// ── Types ──────────────────────────────────────────────────────────────────

interface VoidDetails {}

export interface ResearchToolsConfig {
  agentId: string;
}

// ── Tool factories ─────────────────────────────────────────────────────────

export function createResearchTools(config: ResearchToolsConfig): AgentTool[] {
  const { agentId } = config;

  return [
    {
      name: 'research',
      description: 'Research a topic using Perplexity AI via OpenRouter. Returns synthesized, cited answers from live web sources. Use this for market research, competitive analysis, industry trends, technical documentation, pricing data, news, and any topic requiring up-to-date external knowledge.',
      label: 'research',
      parameters: ResearchParamsSchema,
      execute: async (
        _toolCallId: string,
        params: unknown,
        signal?: AbortSignal,
        _onUpdate?: AgentToolUpdateCallback<VoidDetails>
      ): Promise<AgentToolResult<VoidDetails>> => {
        const p = params as ResearchParams;
        const result = await performResearchWithMeta(
          p.query,
          p.focus || 'general',
          p.model || 'perplexity/sonar-pro',
          signal,
        );

        // Log the LLM call (fire-and-forget)
        logToolLlmCall({
          agentId,
          model: result.model,
          source: 'research',
          usage: result.usage,
          durationMs: result.durationMs,
        });

        return { content: [{ type: 'text', text: result.text }], details: {} };
      },
    },
  ];
}
