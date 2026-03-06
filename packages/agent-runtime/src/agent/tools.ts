import {
  createReadTool,
  createWriteTool,
  createEditTool,
  createBashTool,
  createGrepTool,
  createFindTool,
  createLsTool,
  truncateTail,
  DEFAULT_MAX_LINES,
  DEFAULT_MAX_BYTES,
  formatSize,
} from '@mariozechner/pi-coding-agent';
import type { AgentTool } from '@mariozechner/pi-agent-core';
import type { RedisPublisher } from '../redis/publisher.js';
import type { RequestIdRef } from './runner.js';
import { existsSync, statSync, readdirSync, readFileSync } from 'node:fs';
import { writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { createMultiEditTool } from '../tools/multiedit.js';

type Tool = AgentTool<any>;

export interface ToolsConfig {
  workspacePath: string;
  publisher: RedisPublisher;
  /** Mutable ref — tools read `.current` at call time, no need to recreate tools per turn. */
  requestIdRef: RequestIdRef;
  /** Default cwd for bash commands (defaults to BASH_DEFAULT_CWD env var, then HOME, then workspacePath) */
  bashDefaultCwd?: string;
}

// ── Bash output truncation & overflow file management ─────────────────────

const TOOL_OUTPUT_DIR = '/tmp/djinnbot-tool-output';
let outputDirEnsured = false;

async function ensureOutputDir(): Promise<void> {
  if (outputDirEnsured) return;
  try {
    await mkdir(TOOL_OUTPUT_DIR, { recursive: true });
    outputDirEnsured = true;
  } catch {
    // Directory may already exist
    outputDirEnsured = true;
  }
}

async function saveOverflowOutput(fullOutput: string): Promise<string> {
  await ensureOutputDir();
  const id = `bash_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  const filepath = join(TOOL_OUTPUT_DIR, id);
  await writeFile(filepath, fullOutput, 'utf8');
  return filepath;
}

// ── Tool factory ──────────────────────────────────────────────────────────

export function createContainerTools(config: ToolsConfig): Tool[] {
  const { workspacePath, publisher, requestIdRef } = config;
  
  // Default cwd for bash: configurable via env var, falls back to HOME, then workspacePath
  const bashDefaultCwd = config.bashDefaultCwd 
    || process.env.BASH_DEFAULT_CWD 
    || process.env.HOME 
    || workspacePath;

  // ── Read operations ─────────────────────────────────────────────────────

  const readOps = {
    readFile: async (absolutePath: string): Promise<Buffer> => {
      const fs = await import('node:fs/promises');
      return await fs.readFile(absolutePath);
    },
    access: async (absolutePath: string): Promise<void> => {
      const fs = await import('node:fs/promises');
      await fs.access(absolutePath);
    },
  };

  // ── Write operations ────────────────────────────────────────────────────

  const writeOps = {
    writeFile: async (absolutePath: string, content: string): Promise<void> => {
      const fs = await import('node:fs/promises');
      await fs.writeFile(absolutePath, content, 'utf8');
    },
    mkdir: async (dir: string): Promise<void> => {
      const fs = await import('node:fs/promises');
      await fs.mkdir(dir, { recursive: true });
    },
  };

  // ── Edit operations ─────────────────────────────────────────────────────

  const editOps = {
    readFile: async (absolutePath: string): Promise<Buffer> => {
      const fs = await import('node:fs/promises');
      return await fs.readFile(absolutePath);
    },
    writeFile: async (absolutePath: string, content: string): Promise<void> => {
      const fs = await import('node:fs/promises');
      await fs.writeFile(absolutePath, content, 'utf8');
    },
    access: async (absolutePath: string): Promise<void> => {
      const fs = await import('node:fs/promises');
      await fs.access(absolutePath);
    },
  };

  // ── Grep operations ─────────────────────────────────────────────────────

  const grepOps = {
    isDirectory: (absolutePath: string): boolean => {
      return statSync(absolutePath).isDirectory();
    },
    readFile: (absolutePath: string): string => {
      return readFileSync(absolutePath, 'utf-8');
    },
  };

  // ── Find operations ─────────────────────────────────────────────────────

  const findOps = {
    exists: (absolutePath: string): boolean => {
      return existsSync(absolutePath);
    },
    glob: async (pattern: string, searchCwd: string, options: { ignore: string[]; limit: number }): Promise<string[]> => {
      // Delegate to fd (installed in the container) via synchronous spawn.
      // pi-coding-agent's default find implementation uses fd too, but providing
      // a custom glob ensures workspace boundary safety and consistent behavior.
      const { spawnSync } = await import('node:child_process');
      const path = await import('node:path');
      
      const args = [
        '--glob',
        '--color=never',
        '--hidden',
        '--max-results', String(options.limit),
      ];
      
      // Add ignore patterns
      for (const ig of options.ignore) {
        args.push('--exclude', ig.replace(/\*\*\//g, ''));
      }
      
      args.push(pattern, searchCwd);
      
      const result = spawnSync('fd', args, {
        encoding: 'utf-8',
        maxBuffer: 10 * 1024 * 1024,
      });
      
      if (result.error) {
        throw new Error(`Failed to run fd: ${result.error.message}`);
      }
      
      const output = result.stdout?.trim() || '';
      if (!output) return [];
      
      return output.split('\n')
        .map(line => line.trim())
        .filter(Boolean)
        .map(line => {
          // Return paths relative to searchCwd for consistency
          if (line.startsWith(searchCwd)) {
            return line.slice(searchCwd.length + 1);
          }
          return path.relative(searchCwd, line);
        });
    },
  };

  // ── Ls operations ───────────────────────────────────────────────────────

  const lsOps = {
    exists: (absolutePath: string): boolean => {
      return existsSync(absolutePath);
    },
    stat: (absolutePath: string) => {
      return statSync(absolutePath);
    },
    readdir: (absolutePath: string): string[] => {
      return readdirSync(absolutePath);
    },
  };

  // ── Bash operations (with output truncation & Redis streaming) ──────────

  const bashOps = {
    exec: async (
      command: string,
      cwd: string,
      opts: {
        onData: (data: Buffer) => void;
        signal?: AbortSignal;
        timeout?: number;
        env?: NodeJS.ProcessEnv;
      }
    ): Promise<{ exitCode: number | null }> => {
      const { spawn } = await import('node:child_process');
      
      // Determine effective cwd: use provided cwd, or fall back to bashDefaultCwd
      const effectiveCwd = cwd || bashDefaultCwd;
      
      // Check if cwd exists before spawning (spawn silently fails with ENOENT otherwise)
      if (!existsSync(effectiveCwd)) {
        const errorMsg = `Error: Working directory does not exist: ${effectiveCwd}\n`;
        opts.onData(Buffer.from(errorMsg));
        publisher.publishOutput({
          type: 'stderr',
          requestId: requestIdRef.current,
          data: errorMsg,
          source: 'tool',
        }).catch(console.error);
        return { exitCode: 1 };
      }

      // Collect full output for post-execution truncation
      let fullOutput = '';

      const result = await new Promise<{ exitCode: number | null }>((resolve) => {
        // Mirror upstream pi-coding-agent spawn options:
        // - detached: true  — bash runs in its own process group, enabling process-group kill
        //                     (process.kill(-pid, 'SIGKILL')) to also reap any background children
        //                     the agent spawns (e.g. `uvicorn ... &`)
        // - stdio stdin: 'ignore' — prevents background children from inheriting a writable
        //                     stdin pipe FD, which combined with detached avoids the bug where
        //                     a backgrounded process keeps the stdout/stderr pipe FDs open,
        //                     causing the 'close' event to never fire and hanging the tool call
        const proc = spawn('/bin/bash', ['-c', command], {
          cwd: effectiveCwd,
          env: { ...process.env, ...opts.env },
          detached: true,
          stdio: ['ignore', 'pipe', 'pipe'],
        });

        // Kill the entire process group (bash + all its children) on abort or timeout.
        // process.kill(-pid, 'SIGKILL') sends SIGKILL to every process in the group.
        const killGroup = () => {
          if (proc.pid) {
            try {
              process.kill(-proc.pid, 'SIGKILL');
            } catch {
              // Fallback: kill just the shell if group kill fails (e.g. already dead)
              try { proc.kill('SIGKILL'); } catch { /* already dead */ }
            }
          }
        };

        if (opts.signal) {
          opts.signal.addEventListener('abort', killGroup, { once: true });
        }

        // opts.timeout is in seconds (from the bash tool schema); convert to ms.
        // Fall back to 300,000 ms (5 min) when no timeout is specified.
        const timeout = opts.timeout != null ? opts.timeout * 1000 : 300_000;
        const timer = setTimeout(killGroup, timeout);

        proc.stdout!.on('data', (data: Buffer) => {
          const text = data.toString();
          fullOutput += text;
          opts.onData(data);
          publisher.publishOutput({
            type: 'stdout',
            requestId: requestIdRef.current,
            data: text,
            source: 'tool',
          }).catch(console.error);
        });

        proc.stderr!.on('data', (data: Buffer) => {
          const text = data.toString();
          fullOutput += text;
          opts.onData(data);
          publisher.publishOutput({
            type: 'stderr',
            requestId: requestIdRef.current,
            data: text,
            source: 'tool',
          }).catch(console.error);
        });

        proc.on('close', (code) => {
          clearTimeout(timer);
          if (opts.signal) opts.signal.removeEventListener('abort', killGroup);
          resolve({ exitCode: code });
        });

        proc.on('error', (err) => {
          clearTimeout(timer);
          if (opts.signal) opts.signal.removeEventListener('abort', killGroup);
          // Report the error so agents know what went wrong
          const errorMsg = `Error spawning bash: ${err.message}\n`;
          fullOutput += errorMsg;
          opts.onData(Buffer.from(errorMsg));
          publisher.publishOutput({
            type: 'stderr',
            requestId: requestIdRef.current,
            data: errorMsg,
            source: 'tool',
          }).catch(console.error);
          resolve({ exitCode: 1 });
        });
      });

      // ── Post-execution truncation ───────────────────────────────────────
      // After the process finishes, check if the output exceeds limits.
      // If so, save full output to a temp file and replace onData content
      // with the truncated version + a hint.
      const truncation = truncateTail(fullOutput);
      if (truncation.truncated) {
        try {
          const savedPath = await saveOverflowOutput(fullOutput);
          const hint = [
            '',
            `...${truncation.totalLines - truncation.outputLines} lines truncated (${formatSize(truncation.totalBytes)} total)...`,
            '',
            `Full output saved to: ${savedPath}`,
            `Use grep(pattern="...", path="${savedPath}") to search it, or read(path="${savedPath}", offset=N) to view sections.`,
          ].join('\n');

          // Send the truncation notice so the agent knows
          const noticeBuffer = Buffer.from(hint + '\n');
          opts.onData(noticeBuffer);
          publisher.publishOutput({
            type: 'stdout',
            requestId: requestIdRef.current,
            data: hint + '\n',
            source: 'tool',
          }).catch(console.error);
        } catch (err) {
          console.error('[tools] Failed to save overflow output:', err);
        }
      }

      return result;
    },
  };

  // ── Create tools ────────────────────────────────────────────────────────

  const readTool = createReadTool(workspacePath, { operations: readOps });
  const writeTool = createWriteTool(workspacePath, { operations: writeOps });
  const editTool = createEditTool(workspacePath, { operations: editOps });
  const bashTool = createBashTool(bashDefaultCwd, { operations: bashOps });
  const grepTool = createGrepTool(workspacePath, { operations: grepOps });
  const findTool = createFindTool(workspacePath, { operations: findOps });
  const lsTool = createLsTool(workspacePath, { operations: lsOps });
  const multiEditTool = createMultiEditTool(workspacePath);

  const tools: Tool[] = [
    readTool,
    writeTool,
    editTool,
    bashTool,
    grepTool,
    findTool,
    lsTool,
    multiEditTool,
  ];
  return tools;
}
