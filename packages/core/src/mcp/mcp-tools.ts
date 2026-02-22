/**
 * MCP Tool Registration
 *
 * Fetches the OpenAPI schema from each mcpo server granted to this agent,
 * converts each operation into a native AgentTool, and returns the full list.
 *
 * The tools call mcpo HTTP endpoints directly — no bash/curl required.
 * Tool use is fully visible in the UI via the existing toolStart/toolEnd events.
 */

import { Type } from '@sinclair/typebox';
import type { TSchema, TObject, TProperties } from '@sinclair/typebox';
import type { AgentTool, AgentToolResult } from '@mariozechner/pi-agent-core';

// ── Types ──────────────────────────────────────────────────────────────────────

interface McpGrant {
  server_id: string;
  server_name: string;
  tool_name: string; // "*" = all tools on server
  base_url: string;
}

interface McpManifestResponse {
  grants: McpGrant[];
}

// Minimal OpenAPI types we care about
interface OpenApiSchema {
  paths?: Record<string, OpenApiPathItem>;
  components?: { schemas?: Record<string, OpenApiSchemaObject> };
}

interface OpenApiPathItem {
  post?: OpenApiOperation;
}

interface OpenApiOperation {
  operationId?: string;
  summary?: string;
  description?: string;
  requestBody?: {
    content?: {
      'application/json'?: {
        schema?: OpenApiSchemaObject;
      };
    };
  };
}

interface OpenApiSchemaObject {
  type?: string;
  description?: string;
  properties?: Record<string, OpenApiSchemaObject>;
  required?: string[];
  items?: OpenApiSchemaObject;
  enum?: unknown[];
  $ref?: string;
  anyOf?: OpenApiSchemaObject[];
  allOf?: OpenApiSchemaObject[];
  oneOf?: OpenApiSchemaObject[];
  default?: unknown;
}

// ── OpenAPI schema → TypeBox schema conversion ─────────────────────────────────

function resolveRef(
  ref: string,
  components: OpenApiSchema['components']
): OpenApiSchemaObject | null {
  // Handles "#/components/schemas/Foo"
  const match = ref.match(/^#\/components\/schemas\/(.+)$/);
  if (!match) return null;
  return components?.schemas?.[match[1]] ?? null;
}

function openApiToTypeBox(
  schema: OpenApiSchemaObject,
  components: OpenApiSchema['components'],
  depth = 0
): TSchema {
  // Guard infinite recursion
  if (depth > 8) return Type.Unknown();

  // Resolve $ref
  if (schema.$ref) {
    const resolved = resolveRef(schema.$ref, components);
    if (resolved) return openApiToTypeBox(resolved, components, depth + 1);
    return Type.Unknown();
  }

  // anyOf / oneOf / allOf — use Union of first two, fall back to Unknown
  const combiner = schema.anyOf ?? schema.oneOf ?? schema.allOf;
  if (combiner && combiner.length > 0) {
    const variants = combiner
      .slice(0, 4)
      .map(s => openApiToTypeBox(s, components, depth + 1));
    if (variants.length === 1) return variants[0];
    // TypeBox Union requires at least 2 elements
    return Type.Union(variants as [TSchema, TSchema, ...TSchema[]]);
  }

  const opts: Record<string, unknown> = {};
  if (schema.description) opts.description = schema.description;
  if (schema.default !== undefined) opts.default = schema.default;

  switch (schema.type) {
    case 'string':
      if (schema.enum) {
        const vals = schema.enum as string[];
        if (vals.length === 1) return Type.Literal(vals[0], opts);
        const literalSchemas = vals.map(v => Type.Literal(v));
        return Type.Union(
          literalSchemas as unknown as [TSchema, TSchema, ...TSchema[]],
          opts
        );
      }
      return Type.String(opts);

    case 'integer':
    case 'number':
      return Type.Number(opts);

    case 'boolean':
      return Type.Boolean(opts);

    case 'array': {
      const items = schema.items
        ? openApiToTypeBox(schema.items, components, depth + 1)
        : Type.Unknown();
      return Type.Array(items, opts);
    }

    case 'object': {
      if (!schema.properties || Object.keys(schema.properties).length === 0) {
        return Type.Record(Type.String(), Type.Unknown(), opts);
      }
      const props: TProperties = {};
      const required = new Set(schema.required ?? []);
      for (const [key, val] of Object.entries(schema.properties)) {
        const converted = openApiToTypeBox(val, components, depth + 1);
        props[key] = required.has(key)
          ? converted
          : Type.Optional(converted);
      }
      return Type.Object(props, opts);
    }

    default:
      // null, unknown, or missing type
      return Type.Unknown(opts);
  }
}

function buildParameterSchema(
  operation: OpenApiOperation,
  components: OpenApiSchema['components']
): TObject {
  const bodySchema =
    operation.requestBody?.content?.['application/json']?.schema;

  if (!bodySchema) {
    return Type.Object({});
  }

  // Resolve top-level $ref
  const resolved = bodySchema.$ref
    ? resolveRef(bodySchema.$ref, components) ?? bodySchema
    : bodySchema;

  if (resolved.type === 'object' && resolved.properties) {
    const props: TProperties = {};
    const required = new Set(resolved.required ?? []);
    for (const [key, val] of Object.entries(resolved.properties)) {
      const converted = openApiToTypeBox(val, components, 0);
      props[key] = required.has(key)
        ? converted
        : Type.Optional(converted);
    }
    return Type.Object(props, {
      description: resolved.description,
    });
  }

  return Type.Object({});
}

// ── HTTP call helper ───────────────────────────────────────────────────────────

async function callMcpoTool(
  endpointUrl: string,
  apiKey: string,
  params: Record<string, unknown>,
  signal?: AbortSignal
): Promise<string> {
  const res = await fetch(endpointUrl, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
    },
    body: JSON.stringify(params),
    signal,
  });

  const text = await res.text();

  if (!res.ok) {
    throw new Error(`mcpo ${res.status}: ${text.slice(0, 500)}`);
  }

  // Try to pretty-print JSON responses, otherwise return raw text
  try {
    const json = JSON.parse(text);
    return JSON.stringify(json, null, 2);
  } catch {
    return text;
  }
}

// ── Per-server tool builder ────────────────────────────────────────────────────

async function buildToolsForServer(
  serverId: string,
  serverName: string,
  baseUrl: string,
  apiKey: string,
  allowedTools: Set<string> | '*'
): Promise<AgentTool[]> {
  // Fetch the OpenAPI schema for this server
  let schema: OpenApiSchema;
  try {
    const res = await fetch(`${baseUrl}/openapi.json`, {
      headers: apiKey ? { Authorization: `Bearer ${apiKey}` } : {},
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) {
      console.warn(`[McpTools] ${serverId}: openapi.json returned ${res.status}`);
      return [];
    }
    schema = await res.json() as OpenApiSchema;
  } catch (err) {
    console.warn(`[McpTools] ${serverId}: failed to fetch openapi.json:`, err);
    return [];
  }

  const tools: AgentTool[] = [];
  const components = schema.components;

  for (const [path, pathItem] of Object.entries(schema.paths ?? {})) {
    const operation = pathItem.post;
    if (!operation) continue;

    // Operation path → tool name: strip leading slash
    // e.g. "/get_current_time" → "get_current_time"
    const rawName = path.replace(/^\//, '');
    if (!rawName) continue;

    // Check against allowed tool list
    if (allowedTools !== '*' && !allowedTools.has(rawName)) continue;

    // Namespaced tool name to avoid collisions: "time__get_current_time"
    const toolName = `${serverId}__${rawName}`;

    const description =
      operation.description ||
      operation.summary ||
      `${serverName}: ${rawName.replace(/_/g, ' ')}`;

    const paramSchema = buildParameterSchema(operation, components);

    const endpointUrl = `${baseUrl}${path}`;

    const tool: AgentTool = {
      name: toolName,
      label: toolName,
      description: `[${serverName}] ${description}`,
      parameters: paramSchema,
      execute: async (
        _toolCallId: string,
        params: unknown,
        signal?: AbortSignal
      ): Promise<AgentToolResult<unknown>> => {
        const result = await callMcpoTool(
          endpointUrl,
          apiKey,
          (params as Record<string, unknown>) ?? {},
          signal
        );
        return {
          content: [{ type: 'text', text: result }],
          details: { server: serverId, tool: rawName },
        };
      },
    };

    tools.push(tool);
  }

  console.log(
    `[McpTools] ${serverId}: registered ${tools.length} tool(s): [${tools.map(t => t.name).join(', ')}]`
  );
  return tools;
}

// ── Public API ─────────────────────────────────────────────────────────────────

/**
 * Fetch the MCP manifest for this agent from the API and build native AgentTools
 * for every granted, running MCP server.
 *
 * Called once per runStep() so that mid-session grant changes take effect on
 * the next turn (tools are refreshed via agent.setTools() each turn).
 *
 * @param apiToken  Bearer token sent to the DjinnBot API server (AGENT_API_KEY
 *                  or ENGINE_INTERNAL_TOKEN).  Required when AUTH_ENABLED=true.
 */
export async function createMcpTools(
  agentId: string,
  apiBaseUrl: string,
  mcpoApiKey: string,
  apiToken?: string
): Promise<AgentTool[]> {
  if (!mcpoApiKey && !process.env.MCPO_BASE_URL) {
    // mcpo not configured — skip silently
    return [];
  }

  let manifest: McpManifestResponse;
  try {
    const res = await fetch(
      `${apiBaseUrl}/v1/mcp/agents/${encodeURIComponent(agentId)}/manifest`,
      {
        headers: apiToken ? { Authorization: `Bearer ${apiToken}` } : {},
        signal: AbortSignal.timeout(5000),
      }
    );
    if (!res.ok) {
      if (res.status !== 404) {
        console.warn(`[McpTools] manifest fetch returned ${res.status}`);
      }
      return [];
    }
    manifest = await res.json() as McpManifestResponse;
  } catch (err) {
    console.warn('[McpTools] Failed to fetch MCP manifest:', err);
    return [];
  }

  if (!manifest.grants || manifest.grants.length === 0) {
    return [];
  }

  // Group grants by server
  const byServer = new Map<
    string,
    { serverName: string; baseUrl: string; tools: Set<string> | '*' }
  >();

  for (const grant of manifest.grants) {
    const existing = byServer.get(grant.server_id);
    if (grant.tool_name === '*') {
      // Wildcard overrides any specific grants
      byServer.set(grant.server_id, {
        serverName: grant.server_name,
        baseUrl: grant.base_url,
        tools: '*',
      });
    } else if (!existing) {
      byServer.set(grant.server_id, {
        serverName: grant.server_name,
        baseUrl: grant.base_url,
        tools: new Set([grant.tool_name]),
      });
    } else if (existing.tools !== '*') {
      existing.tools.add(grant.tool_name);
    }
  }

  // Build tools for each server in parallel
  const results = await Promise.all(
    [...byServer.entries()].map(([serverId, { serverName, baseUrl, tools }]) =>
      buildToolsForServer(serverId, serverName, baseUrl, mcpoApiKey, tools)
    )
  );

  return results.flat();
}
