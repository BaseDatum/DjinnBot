/**
 * exec_code Tool for Programmatic Tool Calling (PTC)
 *
 * A single AgentTool that accepts Python code, injects an auto-generated
 * SDK preamble with async function stubs for all PTC-eligible tools, and
 * executes the code in a Python subprocess. Only stdout/stderr from the
 * subprocess enters the LLM's context window — intermediate tool results
 * are processed inside the code, not returned to the model.
 *
 * This is the key mechanism for reducing context usage: the LLM writes
 * filtering/aggregation logic in Python, calls tools via async functions,
 * and prints only the data it needs.
 */

import { Type, type Static } from '@sinclair/typebox';
import type { AgentTool, AgentToolResult, AgentToolUpdateCallback } from '@mariozechner/pi-agent-core';
import type { RedisPublisher } from '../../redis/publisher.js';
import type { RequestIdRef } from '../runner.js';
import { generatePythonSdk, wrapUserCode, generateCompactReference } from './sdk-generator.js';
import type { PtcIpcServer } from './ipc-server.js';

// ── Schema ────────────────────────────────────────────────────────────────

const ExecCodeParamsSchema = Type.Object({
  code: Type.String({
    description:
      'Python code to execute. Tool functions are available as async/await. ' +
      'Use print() to output results — ONLY print() output enters your context. ' +
      'Tool results are processed in-code, keeping intermediate data out of context.',
  }),
  timeout: Type.Optional(Type.Number({
    description: 'Execution timeout in seconds (default 120, max 600).',
  })),
});
type ExecCodeParams = Static<typeof ExecCodeParamsSchema>;

// ── Types ─────────────────────────────────────────────────────────────────

interface VoidDetails {}

export interface ExecCodeToolConfig {
  /** The IPC server instance (provides port for SDK generation). */
  ipcServer: PtcIpcServer;
  /** All PTC-eligible tools (used to generate SDK and compact reference). */
  ptcTools: AgentTool[];
  /** Redis publisher for streaming output. */
  publisher: RedisPublisher;
  /** Mutable ref to current requestId. */
  requestIdRef: RequestIdRef;
}

// ── Tool factory ──────────────────────────────────────────────────────────

/**
 * Create the exec_code tool.
 *
 * The tool description includes a compact reference of all available PTC
 * functions, so the LLM knows what it can call without needing full JSON
 * schemas in the prompt.
 */
export function createExecCodeTool(config: ExecCodeToolConfig): AgentTool {
  const { ipcServer, ptcTools, publisher, requestIdRef } = config;

  // Generate the compact function reference for the tool description.
  // This is regenerated when tools change (MCP refresh).
  let compactRef = generateCompactReference(ptcTools);

  const description =
    'Execute Python code with access to tool functions. ' +
    'Tools are plain synchronous functions — call them directly, NO async/await. ' +
    'ONLY print() output enters your context window — ' +
    'tool results are processed in code, not loaded into context. ' +
    'Use this for multi-step workflows, data filtering, batch operations, ' +
    'and any task where intermediate results should be processed before you see them. ' +
    'Always wrap code in try/except. Some params are renamed: type -> type_, class -> class_.\n\n' +
    'Available functions:\n' + compactRef;

  return {
    name: 'exec_code',
    description,
    label: 'exec_code',
    parameters: ExecCodeParamsSchema,
    execute: async (
      _toolCallId: string,
      params: unknown,
      signal?: AbortSignal,
      _onUpdate?: AgentToolUpdateCallback<VoidDetails>
    ): Promise<AgentToolResult<VoidDetails>> => {
      const p = params as ExecCodeParams;
      const timeoutSeconds = Math.min(Math.max(p.timeout ?? 120, 10), 600);

      // Generate the full SDK preamble + wrap user code
      const sdk = generatePythonSdk(ptcTools, ipcServer.port);
      const fullScript = wrapUserCode(sdk, p.code);

      console.log(`[exec_code] Executing ${p.code.length} chars of user code (timeout: ${timeoutSeconds}s, ${ptcTools.length} PTC tools available)`);

      try {
        const result = await executePython(fullScript, timeoutSeconds, publisher, requestIdRef, signal);

        // Combine stdout and stderr for the response
        const parts: string[] = [];
        if (result.stdout.trim()) {
          parts.push(result.stdout.trim());
        }
        if (result.stderr.trim()) {
          // Only include stderr if there was an error
          if (result.exitCode !== 0) {
            parts.push(`\n[stderr]\n${result.stderr.trim()}`);
          }
        }
        if (result.exitCode !== 0) {
          parts.push(`\n[exit code: ${result.exitCode}]`);
        }

        const output = parts.join('\n') || '(no output)';

        return {
          content: [{ type: 'text', text: output }],
          details: {},
        };
      } catch (err) {
        const errMsg = err instanceof Error ? err.message : String(err);
        console.error(`[exec_code] Execution failed:`, errMsg);
        return {
          content: [{ type: 'text', text: `exec_code failed: ${errMsg}` }],
          details: {},
        };
      }
    },
  };
}

/**
 * Update the compact reference when tools change (e.g. MCP refresh).
 * Returns a new exec_code tool with the updated description.
 */
export function refreshExecCodeTool(config: ExecCodeToolConfig): AgentTool {
  return createExecCodeTool(config);
}

// ── Python execution ──────────────────────────────────────────────────────

interface PythonResult {
  stdout: string;
  stderr: string;
  exitCode: number | null;
}

async function executePython(
  script: string,
  timeoutSeconds: number,
  publisher: RedisPublisher,
  requestIdRef: RequestIdRef,
  signal?: AbortSignal,
): Promise<PythonResult> {
  const { spawn } = await import('node:child_process');

  return new Promise<PythonResult>((resolve) => {
    let stdout = '';
    let stderr = '';

    // Spawn python3 with the script passed via stdin
    const proc = spawn('python3', ['-u', '-c', script], {
      cwd: process.env.WORKSPACE_PATH || '/home/agent/run-workspace',
      env: {
        ...process.env,
        // Ensure Python doesn't buffer output
        PYTHONUNBUFFERED: '1',
      },
      detached: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    // Kill the entire process group on abort or timeout
    const killGroup = () => {
      if (proc.pid) {
        try { process.kill(-proc.pid, 'SIGKILL'); } catch {
          try { proc.kill('SIGKILL'); } catch { /* already dead */ }
        }
      }
    };

    if (signal) {
      signal.addEventListener('abort', killGroup, { once: true });
    }

    const timer = setTimeout(() => {
      console.warn(`[exec_code] Timeout after ${timeoutSeconds}s, killing process`);
      killGroup();
    }, timeoutSeconds * 1000);

    proc.stdout!.on('data', (data: Buffer) => {
      const text = data.toString();
      stdout += text;
      // Stream stdout to Redis for real-time observability
      publisher.publishOutput({
        type: 'stdout',
        requestId: requestIdRef.current,
        data: text,
        source: 'tool',
      }).catch(console.error);
    });

    proc.stderr!.on('data', (data: Buffer) => {
      const text = data.toString();
      stderr += text;
      // Stream stderr to Redis
      publisher.publishOutput({
        type: 'stderr',
        requestId: requestIdRef.current,
        data: text,
        source: 'tool',
      }).catch(console.error);
    });

    proc.on('close', (code) => {
      clearTimeout(timer);
      if (signal) signal.removeEventListener('abort', killGroup);
      resolve({ stdout, stderr, exitCode: code });
    });

    proc.on('error', (err) => {
      clearTimeout(timer);
      if (signal) signal.removeEventListener('abort', killGroup);
      stderr += `Error spawning python3: ${err.message}\n`;
      resolve({ stdout, stderr, exitCode: 1 });
    });
  });
}
