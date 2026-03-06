/**
 * SDK Generator for Programmatic Tool Calling (PTC)
 *
 * Generates a Python preamble from AgentTool[] definitions that provides
 * async function stubs for each tool. The generated code communicates with
 * the Node.js IPC server via HTTP to execute actual tool calls.
 *
 * Also generates compact one-line function signatures for inclusion in the
 * exec_code tool description (what the LLM sees in its prompt).
 */

import type { AgentTool } from '@mariozechner/pi-agent-core';
import type { TSchema, TObject } from '@sinclair/typebox';

// ── TypeBox schema introspection helpers ──────────────────────────────────

interface SchemaParam {
  /** Python-safe parameter name (e.g. type_ for 'type'). */
  name: string;
  /** Original schema key name — used in the IPC args dict. */
  originalName: string;
  /** Valid Python type hint for function signatures (e.g. str, int, bool). */
  pythonType: string;
  /** Human-readable type with enum values for docs/compact reference (e.g. "summary"|"neighbors"|"search"). */
  displayType: string;
  required: boolean;
  default?: string;
  description?: string;
}

/**
 * Map a TypeBox schema to a valid Python type hint string.
 * Always returns a runtime-safe type (str, int, bool, list, dict).
 */
function typeBoxToPythonType(schema: TSchema): string {
  const kind = (schema as any)[Symbol.for('TypeBox.Kind')] ?? schema.type;

  switch (kind) {
    case 'String':
      return 'str';
    case 'Number':
    case 'Integer':
      return 'int';
    case 'Boolean':
      return 'bool';
    case 'Array':
      return 'list';
    case 'Object':
      return 'dict';
    case 'Record':
      return 'dict';
    case 'Union':
    case 'Literal':
      return 'str';
    case 'Optional': {
      const inner = (schema as any).$ref ?? (schema as any).anyOf?.[0] ?? schema;
      return typeBoxToPythonType(inner);
    }
    default:
      return 'str';
  }
}

/**
 * Map a TypeBox schema to a human-readable display type that includes
 * enum values. Used in docstrings and the compact reference — NOT in
 * actual Python type hints (those use typeBoxToPythonType).
 */
function typeBoxToDisplayType(schema: TSchema): string {
  const kind = (schema as any)[Symbol.for('TypeBox.Kind')] ?? schema.type;

  switch (kind) {
    case 'Union': {
      const anyOf = (schema as any).anyOf ?? (schema as any).oneOf;
      if (anyOf?.length > 0 && anyOf.every((s: any) => s.const !== undefined)) {
        return anyOf.map((s: any) => JSON.stringify(s.const)).join('|');
      }
      return 'str';
    }
    case 'Literal': {
      const val = (schema as any).const;
      return val !== undefined ? JSON.stringify(val) : 'str';
    }
    case 'Optional': {
      const inner = (schema as any).$ref ?? (schema as any).anyOf?.[0] ?? schema;
      return typeBoxToDisplayType(inner);
    }
    default:
      return typeBoxToPythonType(schema);
  }
}

/**
 * Extract parameters from a TypeBox TObject schema.
 */
function extractParams(schema: TSchema): SchemaParam[] {
  const params: SchemaParam[] = [];

  // The schema should be a TObject with properties
  const properties = (schema as any).properties as Record<string, TSchema> | undefined;
  if (!properties) return params;

  const required = new Set<string>((schema as any).required ?? []);

  for (const [name, propSchema] of Object.entries(properties)) {
    const isRequired = required.has(name);

    // Check if the property is wrapped in Optional
    const isOptionalKind = (propSchema as any)[Symbol.for('TypeBox.Kind')] === 'Optional';

    // Unwrap Optional to get the inner schema
    const innerSchema = isOptionalKind
      ? ((propSchema as any).anyOf?.[0] ?? (propSchema as any).$ref ?? propSchema)
      : propSchema;

    const pythonType = typeBoxToPythonType(innerSchema);

    // Determine default value
    let defaultVal: string | undefined;
    if (!isRequired || isOptionalKind) {
      const explicitDefault = (propSchema as any).default ?? (innerSchema as any).default;
      if (explicitDefault !== undefined) {
        defaultVal = pythonDefault(explicitDefault);
      } else {
        defaultVal = 'None';
      }
    }

    params.push({
      name: sanitizePythonName(name),
      originalName: name,
      pythonType,
      displayType: typeBoxToDisplayType(isOptionalKind ? innerSchema : propSchema),
      required: isRequired && !isOptionalKind,
      default: defaultVal,
      description: (propSchema as any).description ?? (innerSchema as any).description,
    });
  }

  // Sort: required params first, then optional
  params.sort((a, b) => {
    if (a.required && !b.required) return -1;
    if (!a.required && b.required) return 1;
    return 0;
  });

  return params;
}

/**
 * Convert a JS default value to a Python literal string.
 */
function pythonDefault(value: unknown): string {
  if (value === null || value === undefined) return 'None';
  if (value === true) return 'True';
  if (value === false) return 'False';
  if (typeof value === 'string') return JSON.stringify(value);
  if (typeof value === 'number') return String(value);
  if (Array.isArray(value)) return '[]';
  return 'None';
}

/**
 * Convert camelCase to snake_case.
 * e.g. "tabId" → "tab_id", "pressEnter" → "press_enter", "domainSuffix" → "domain_suffix"
 */
function camelToSnake(name: string): string {
  return name.replace(/([a-z0-9])([A-Z])/g, '$1_$2').toLowerCase();
}

/**
 * Sanitize a tool/param name for Python (camelCase→snake_case, replace hyphens, avoid reserved words).
 */
function sanitizePythonName(name: string): string {
  let result = camelToSnake(name).replace(/-/g, '_');
  // Python reserved words
  const reserved = new Set(['type', 'class', 'import', 'from', 'return', 'pass', 'in', 'is', 'not', 'and', 'or', 'for', 'while', 'if', 'else', 'elif', 'try', 'except', 'finally', 'with', 'as', 'def', 'del', 'global', 'nonlocal', 'lambda', 'yield', 'assert', 'break', 'continue', 'raise']);
  if (reserved.has(result)) {
    result = result + '_';
  }
  return result;
}

// ── Python SDK generation ─────────────────────────────────────────────────

/**
 * Generate a compact function signature for the exec_code tool description.
 * Uses displayType (with enum values) since this is documentation text,
 * not executable Python.
 */
function generateFunctionSignature(tool: AgentTool): string {
  const fnName = sanitizePythonName(tool.name);
  const params = extractParams(tool.parameters);

  const paramParts = params.map(p => {
    const typeHint = `: ${p.displayType}`;
    if (p.default !== undefined) {
      return `${p.name}${typeHint} = ${p.default}`;
    }
    return `${p.name}${typeHint}`;
  });

  return `${fnName}(${paramParts.join(', ')})`;
}

/**
 * Generate a synchronous Python function for a single tool.
 *
 * All tool functions are synchronous — they use blocking HTTP via urllib
 * under the hood. This avoids async/await confusion entirely (EC-001).
 * The model's code runs top-level, no event loop needed.
 */
function generateFunction(tool: AgentTool): string {
  const fnName = sanitizePythonName(tool.name);
  const params = extractParams(tool.parameters);

  const paramParts = params.map(p => {
    const typeHint = `: ${p.pythonType}`;
    if (p.default !== undefined) {
      return `${p.name}${typeHint} = ${p.default}`;
    }
    return `${p.name}${typeHint}`;
  });

  // Build the args dict, using originalName for IPC keys and Python name for values.
  // e.g. remember(type_="lesson") → {"type": type_}  (IPC expects "type", not "type_")
  const hasOptional = params.some(p => p.default !== undefined);

  let argsExpr: string;
  if (hasOptional) {
    // Build dict with None filtering
    const entries = params.map(p => `"${p.originalName}": ${p.name}`).join(', ');
    argsExpr = `{k: v for k, v in {${entries}}.items() if v is not None}`;
  } else {
    const entries = params.map(p => `"${p.originalName}": ${p.name}`).join(', ');
    argsExpr = `{${entries}}`;
  }

  // Sanitize description for a single-line Python docstring.
  const rawDesc = (tool.description || tool.name)
    .replace(/\\/g, '\\\\')         // escape backslashes first
    .replace(/"""/g, '""\\"')        // break any triple double-quotes
    .replace(/\n/g, ' ')             // collapse newlines
    .replace(/\r/g, '')
    .replace(/\s+/g, ' ')           // collapse whitespace
    .trim()
    .slice(0, 120);

  // Build enum constraint notes for params with restricted values.
  // e.g. "action: "summary"|"neighbors"|"search""
  const enumNotes = params
    .filter(p => p.displayType !== p.pythonType)
    .map(p => `${p.name}: ${p.displayType}`)
    .join('; ');
  const docstring = enumNotes
    ? `${rawDesc} [${enumNotes}]`
    : rawDesc;

  const lines = [
    `def ${fnName}(${paramParts.join(', ')}) -> str:`,
    `    """${docstring}"""`,
    `    return _ptc_call("${tool.name}", ${argsExpr})`,
  ];

  return lines.join('\n');
}

/**
 * Generate the full Python SDK preamble for all PTC tools.
 *
 * The preamble includes:
 * - HTTP client setup (using urllib.request for zero dependencies)
 * - The _ptc_call() bridge function
 * - One synchronous function per tool
 *
 * All tool functions are synchronous — blocking HTTP calls via urllib.
 * User code runs top-level with no event loop. This eliminates the entire
 * class of asyncio.run() / nested event loop bugs (EC-001).
 */
export function generatePythonSdk(tools: AgentTool[], ipcPort: number): string {
  const functions = tools.map(t => generateFunction(t)).join('\n\n');

  return `
# ── PTC SDK (auto-generated) ────────────────────────────────────────────
import json
import urllib.request

_PTC_PORT = ${ipcPort}

def _ptc_call(name: str, args: dict) -> str:
    """Call a tool via the IPC bridge. Returns tool result as string."""
    data = json.dumps(args).encode("utf-8")
    req = urllib.request.Request(
        f"http://127.0.0.1:{_PTC_PORT}/tool/{name}",
        data=data,
        headers={"Content-Type": "application/json"},
    )
    try:
        with urllib.request.urlopen(req, timeout=300) as resp:
            return resp.read().decode("utf-8")
    except urllib.error.HTTPError as e:
        body = e.read().decode("utf-8", errors="replace")
        return f"Error calling {name}: {e.code} - {body}"
    except Exception as e:
        return f"Error calling {name}: {e}"

${functions}

# ── User code runs below ────────────────────────────────────────────────
`.trimStart();
}

/**
 * Append user code to the SDK preamble.
 *
 * User code runs at the top level — no async wrapper, no event loop.
 * Tool functions are plain synchronous calls. The model writes normal
 * Python: loops, try/except, print(). No await needed.
 */
export function wrapUserCode(sdkPreamble: string, userCode: string): string {
  return `${sdkPreamble}${userCode}
`;
}

/**
 * Generate compact one-line function signatures for the exec_code tool description.
 * This is what the LLM sees in its prompt — a compact reference of available functions.
 */
export function generateCompactReference(tools: AgentTool[]): string {
  const lines: string[] = [];

  // Group tools by source for readability
  const builtIn: AgentTool[] = [];
  const mcp: AgentTool[] = [];

  for (const tool of tools) {
    if (tool.name.includes('__')) {
      mcp.push(tool);
    } else {
      builtIn.push(tool);
    }
  }

  if (builtIn.length > 0) {
    for (const tool of builtIn) {
      const sig = generateFunctionSignature(tool);
      // Truncate description to ~60 chars
      const desc = (tool.description || '').replace(/\n/g, ' ').slice(0, 60);
      lines.push(`  ${sig} -> str  # ${desc}`);
    }
  }

  if (mcp.length > 0) {
    lines.push('');
    lines.push('  # MCP tools:');
    for (const tool of mcp) {
      const sig = generateFunctionSignature(tool);
      const desc = (tool.description || '').replace(/\n/g, ' ').slice(0, 60);
      lines.push(`  ${sig} -> str  # ${desc}`);
    }
  }

  return lines.join('\n');
}
