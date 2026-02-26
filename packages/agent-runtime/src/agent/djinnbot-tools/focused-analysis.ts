/**
 * focused_analysis — lightweight analytical delegation tool.
 *
 * Sends a focused prompt (+ optional context like file contents, diffs, or specs)
 * to a fast/cheap LLM and returns the result in seconds.  The agent's own context
 * window stays clean for high-level reasoning and planning.
 *
 * This fills the gap between:
 *  - The agent's own context window (expensive, gets polluted with analytical detail)
 *  - spawn_executor (full container, 5+ min overhead, requires project/task infra)
 *
 * Typical latency: 3-30 seconds.  Typical cost: ~50-100x less than an executor spawn.
 */

import { Type, type Static } from '@sinclair/typebox';
import type { AgentTool, AgentToolResult, AgentToolUpdateCallback } from '@mariozechner/pi-agent-core';
import { focusedAnalysis } from '@djinnbot/core';
import { logToolLlmCall } from './log-tool-llm-call.js';

// ── Schemas ────────────────────────────────────────────────────────────────

const FocusedAnalysisParamsSchema = Type.Object({
  prompt: Type.String({
    description:
      'The focused question or instruction for the sub-model. Be specific and direct — ' +
      'e.g. "List all functions in this file that mutate global state" or ' +
      '"Does this diff introduce any SQL injection vulnerabilities?"',
  }),
  context: Type.Optional(Type.String({
    description:
      'Content to analyse: file contents, git diffs, specs, error logs, etc. ' +
      'Paste the relevant material here — the sub-model sees ONLY this context and your prompt, ' +
      'not your conversation history. Keep it focused: include only the parts relevant to your question. ' +
      'Max ~200K characters.',
  })),
  model: Type.Optional(Type.String({
    description:
      'Override the sub-model. Defaults to a fast/cheap model (anthropic/claude-sonnet-4). ' +
      'Use a stronger model for complex analysis:\n' +
      '  - anthropic/claude-sonnet-4 (default — fast, good for most analysis)\n' +
      '  - anthropic/claude-opus-4 (strongest reasoning, slower)\n' +
      '  - google/gemini-2.5-pro (very long context, good for large codebases)\n' +
      '  - openai/gpt-4.1 (strong all-round)\n' +
      '  - openai/o3-mini (fast reasoning)',
  })),
  maxTokens: Type.Optional(Type.Number({
    description:
      'Max response tokens (256–16384, default 4096). ' +
      'Use lower values for yes/no questions or short lists, higher for detailed analysis.',
  })),
  persona: Type.Optional(Type.Union([
    Type.Literal('analyst'),
    Type.Literal('security'),
    Type.Literal('reviewer'),
    Type.Literal('architect'),
    Type.Literal('tester'),
  ], {
    description:
      'Analytical persona for the sub-model:\n' +
      '  - analyst (default): general-purpose structured analysis\n' +
      '  - security: focus on vulnerabilities, injection, auth issues, secrets exposure\n' +
      '  - reviewer: code review — style, bugs, edge cases, performance\n' +
      '  - architect: system design, coupling, API contracts, scaling\n' +
      '  - tester: test coverage gaps, edge cases, acceptance criteria verification',
  })),
});
type FocusedAnalysisParams = Static<typeof FocusedAnalysisParamsSchema>;

// ── Persona system prompts ─────────────────────────────────────────────────

const PERSONA_PROMPTS: Record<string, string> = {
  analyst:
    'You are a focused analytical assistant. Provide precise, structured, and concise answers. ' +
    'Do not include preamble, pleasantries, or caveats unless the analysis genuinely warrants them. ' +
    'When analysing code, reference specific file paths and line numbers. ' +
    'When listing items, use numbered or bulleted lists. ' +
    'Prioritise actionable insights over exhaustive description.',

  security:
    'You are a security analyst reviewing code or configuration for vulnerabilities. ' +
    'Focus on: injection attacks (SQL, XSS, command, path traversal), authentication/authorisation flaws, ' +
    'secrets exposure, insecure defaults, CSRF, SSRF, race conditions, and supply-chain risks. ' +
    'Rate each finding by severity (critical/high/medium/low). ' +
    'Be specific: cite the exact line, variable, or pattern that creates the vulnerability. ' +
    'If nothing is found, say so clearly rather than inventing low-signal warnings.',

  reviewer:
    'You are a senior code reviewer. Focus on: correctness bugs, unhandled edge cases, ' +
    'error handling gaps, performance issues, readability problems, and violations of the ' +
    'codebase\'s existing patterns. Be specific — reference exact lines and suggest concrete fixes. ' +
    'Separate blocking issues from nits. Do not comment on style preferences unless they impact readability.',

  architect:
    'You are a software architect analysing system design. Focus on: coupling between modules, ' +
    'API contract clarity, data flow correctness, scaling bottlenecks, failure modes, ' +
    'and alignment with stated requirements. Reference specific interfaces, types, and data paths. ' +
    'When suggesting changes, weigh implementation cost against benefit.',

  tester:
    'You are a test engineer. Analyse the provided code or spec for: untested paths, ' +
    'edge cases (nulls, empty collections, boundary values, concurrency), missing error scenarios, ' +
    'and gaps between the spec and the implementation. Output concrete test case descriptions ' +
    'with expected inputs and outputs. Prioritise cases most likely to catch real bugs.',
};

// ── Types ──────────────────────────────────────────────────────────────────

interface VoidDetails {}

export interface FocusedAnalysisToolsConfig {
  agentId: string;
}

// ── Tool factory ───────────────────────────────────────────────────────────

export function createFocusedAnalysisTools(config: FocusedAnalysisToolsConfig): AgentTool[] {
  const { agentId } = config;

  return [
    {
      name: 'focused_analysis',
      description:
        'Delegate a focused analytical question to a fast sub-model WITHOUT consuming your own ' +
        'context window. The sub-model sees ONLY your prompt + the context you provide — ' +
        'it has no access to your conversation history or tools.\n\n' +
        'Use this instead of reasoning through large content yourself:\n' +
        '  - "Analyse this 500-line diff for security issues"\n' +
        '  - "Which of these 8 files need to change for feature X?"\n' +
        '  - "Convert this spec into acceptance test cases"\n' +
        '  - "Summarise these error logs — what is the root cause?"\n' +
        '  - "Does this implementation satisfy these acceptance criteria?"\n\n' +
        'Completes in 3-30 seconds (vs 5+ minutes for spawn_executor).\n' +
        'The result is returned directly to you for decision-making.\n\n' +
        'TIP: Read the relevant files first, then pass their contents as context. ' +
        'The sub-model cannot read files or use tools — it only analyses what you give it.',
      label: 'focused_analysis',
      parameters: FocusedAnalysisParamsSchema,
      execute: async (
        _toolCallId: string,
        params: unknown,
        signal?: AbortSignal,
        _onUpdate?: AgentToolUpdateCallback<VoidDetails>,
      ): Promise<AgentToolResult<VoidDetails>> => {
        const p = params as FocusedAnalysisParams;

        const persona = p.persona || 'analyst';
        const systemPrompt = PERSONA_PROMPTS[persona] ?? PERSONA_PROMPTS.analyst;

        const result = await focusedAnalysis({
          prompt: p.prompt,
          context: p.context,
          model: p.model,
          maxTokens: p.maxTokens,
          systemPrompt,
          signal,
        });

        // Log the LLM call (fire-and-forget)
        logToolLlmCall({
          agentId,
          model: result.model,
          source: 'focused_analysis',
          usage: result.usage,
          durationMs: result.durationMs,
        });

        // Format the response with metadata
        const parts: string[] = [];
        parts.push(result.content);

        const meta: string[] = [`model: ${result.model}`, `persona: ${persona}`];
        if (result.usage) {
          meta.push(
            `tokens: ${result.usage.promptTokens} in → ${result.usage.completionTokens} out`,
          );
        }
        meta.push(`${(result.durationMs / 1000).toFixed(1)}s`);
        parts.push(`\n---\n_${meta.join(' | ')}_`);

        return {
          content: [{ type: 'text', text: parts.join('\n') }],
          details: {},
        };
      },
    },
  ];
}
