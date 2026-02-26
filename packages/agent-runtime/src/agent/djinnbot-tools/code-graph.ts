/**
 * Code Knowledge Graph tools for the agent runtime.
 *
 * These call the Python API server's knowledge-graph endpoints.
 * The agent passes `projectId` at call time (not baked in at creation).
 */

import { Type, type Static } from '@sinclair/typebox';
import type { AgentTool, AgentToolResult } from '@mariozechner/pi-agent-core';
import { authFetch } from '../../api/auth-fetch.js';

// ── Schemas ────────────────────────────────────────────────────────────────

const CodeGraphQueryParamsSchema = Type.Object({
  projectId: Type.String({ description: 'Project ID (e.g. "proj_abc123")' }),
  query: Type.String({
    description: 'Natural language or keyword search query (e.g., "authentication middleware", "database connection")',
  }),
  task_context: Type.Optional(Type.String({
    description: 'What you are working on (helps ranking)',
  })),
  limit: Type.Optional(Type.Number({
    default: 10,
    description: 'Max results to return',
  })),
});
type CodeGraphQueryParams = Static<typeof CodeGraphQueryParamsSchema>;

const CodeGraphContextParamsSchema = Type.Object({
  projectId: Type.String({ description: 'Project ID' }),
  symbol_name: Type.String({
    description: 'Symbol name (e.g., "validateUser", "AuthService")',
  }),
  file_path: Type.Optional(Type.String({
    description: 'File path to disambiguate common names',
  })),
});
type CodeGraphContextParams = Static<typeof CodeGraphContextParamsSchema>;

const CodeGraphImpactParamsSchema = Type.Object({
  projectId: Type.String({ description: 'Project ID' }),
  target: Type.String({
    description: 'Name of function, class, or file to analyze',
  }),
  direction: Type.Union([
    Type.Literal('upstream'),
    Type.Literal('downstream'),
  ], {
    description: 'upstream = what depends on this, downstream = what this depends on',
  }),
  max_depth: Type.Optional(Type.Number({
    default: 3,
    description: 'Max relationship depth (1-5)',
  })),
  min_confidence: Type.Optional(Type.Number({
    default: 0.7,
    description: 'Minimum confidence 0-1',
  })),
});
type CodeGraphImpactParams = Static<typeof CodeGraphImpactParamsSchema>;

const CodeGraphChangesParamsSchema = Type.Object({
  projectId: Type.String({ description: 'Project ID' }),
});
type CodeGraphChangesParams = Static<typeof CodeGraphChangesParamsSchema>;

// ── Config ─────────────────────────────────────────────────────────────────

interface VoidDetails {}

export interface CodeGraphToolsConfig {
  apiBaseUrl?: string;
}

// ── Helper ─────────────────────────────────────────────────────────────────

async function callCodeGraphApi(
  apiBase: string,
  projectId: string,
  endpoint: string,
  opts: { method: 'GET' | 'POST'; body?: Record<string, unknown> },
): Promise<string> {
  const url = `${apiBase}/v1/projects/${projectId}/knowledge-graph/${endpoint}`;
  try {
    const fetchOpts: RequestInit = {
      method: opts.method,
      headers: { 'Content-Type': 'application/json' },
    };
    if (opts.body) {
      fetchOpts.body = JSON.stringify(opts.body);
    }
    const res = await authFetch(url, fetchOpts);
    if (!res.ok) {
      const text = await res.text();
      return `Code graph API error (${res.status}): ${text.slice(0, 500)}`;
    }
    const data = await res.json();
    return JSON.stringify(data, null, 2);
  } catch (err: any) {
    return `Code graph unavailable: ${err?.message || 'unknown error'}`;
  }
}

// ── Tool factory ───────────────────────────────────────────────────────────

export function createCodeGraphTools(config: CodeGraphToolsConfig): AgentTool[] {
  const getApiBase = () =>
    config.apiBaseUrl || process.env.DJINNBOT_API_URL || 'http://api:8000';

  return [
    {
      name: 'code_graph_query',
      description:
        'Search a project\'s codebase knowledge graph. Returns functions, classes, and ' +
        'execution flows matching your query. Use this to understand how code works together ' +
        'before making changes. Only available for projects with an indexed git workspace.',
      label: 'code_graph_query',
      parameters: CodeGraphQueryParamsSchema,
      execute: async (
        _toolCallId: string,
        params: unknown,
      ): Promise<AgentToolResult<VoidDetails>> => {
        const p = params as CodeGraphQueryParams;
        const result = await callCodeGraphApi(getApiBase(), p.projectId, 'query', {
          method: 'POST',
          body: { query: p.query, task_context: p.task_context, limit: p.limit ?? 10 },
        });
        return { content: [{ type: 'text', text: result }], details: {} };
      },
    },
    {
      name: 'code_graph_context',
      description:
        'Get complete context for a code symbol: who calls it, what it calls, which execution ' +
        'flows it participates in, and which functional cluster it belongs to. Use after ' +
        'code_graph_query to deeply understand a specific symbol.',
      label: 'code_graph_context',
      parameters: CodeGraphContextParamsSchema,
      execute: async (
        _toolCallId: string,
        params: unknown,
      ): Promise<AgentToolResult<VoidDetails>> => {
        const p = params as CodeGraphContextParams;
        const qp = p.file_path ? `?file_path=${encodeURIComponent(p.file_path)}` : '';
        const result = await callCodeGraphApi(
          getApiBase(), p.projectId,
          `context/${encodeURIComponent(p.symbol_name)}${qp}`,
          { method: 'GET' },
        );
        return { content: [{ type: 'text', text: result }], details: {} };
      },
    },
    {
      name: 'code_graph_impact',
      description:
        'Analyze what would break if you change a code symbol. Returns affected symbols grouped ' +
        'by depth (d=1: WILL BREAK, d=2: LIKELY AFFECTED) plus affected execution flows. Use ' +
        'BEFORE making changes to understand risk.',
      label: 'code_graph_impact',
      parameters: CodeGraphImpactParamsSchema,
      execute: async (
        _toolCallId: string,
        params: unknown,
      ): Promise<AgentToolResult<VoidDetails>> => {
        const p = params as CodeGraphImpactParams;
        const result = await callCodeGraphApi(getApiBase(), p.projectId, 'impact', {
          method: 'POST',
          body: {
            target: p.target,
            direction: p.direction,
            max_depth: p.max_depth ?? 3,
            min_confidence: p.min_confidence ?? 0.7,
          },
        });
        return { content: [{ type: 'text', text: result }], details: {} };
      },
    },
    {
      name: 'code_graph_changes',
      description:
        'Map current uncommitted git changes to affected code symbols and execution flows. ' +
        'Use as a pre-commit safety check to understand what your changes affect.',
      label: 'code_graph_changes',
      parameters: CodeGraphChangesParamsSchema,
      execute: async (
        _toolCallId: string,
        params: unknown,
      ): Promise<AgentToolResult<VoidDetails>> => {
        const p = params as CodeGraphChangesParams;
        const result = await callCodeGraphApi(getApiBase(), p.projectId, 'changes', {
          method: 'GET',
        });
        return { content: [{ type: 'text', text: result }], details: {} };
      },
    },
  ];
}
