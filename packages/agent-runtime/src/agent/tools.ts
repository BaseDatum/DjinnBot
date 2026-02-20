import { createReadTool, createWriteTool, createEditTool, createBashTool } from '@mariozechner/pi-coding-agent';
import type { AgentTool } from '@mariozechner/pi-agent-core';
import type { RedisPublisher } from '../redis/publisher.js';
import type { RequestIdRef } from './runner.js';
import { existsSync } from 'node:fs';

type Tool = AgentTool<any>;

export interface ToolsConfig {
  workspacePath: string;
  publisher: RedisPublisher;
  /** Mutable ref — tools read `.current` at call time, no need to recreate tools per turn. */
  requestIdRef: RequestIdRef;
  /** Default cwd for bash commands (defaults to BASH_DEFAULT_CWD env var, then HOME, then workspacePath) */
  bashDefaultCwd?: string;
}

export function createContainerTools(config: ToolsConfig): Tool[] {
  const { workspacePath, publisher, requestIdRef } = config;
  
  // Default cwd for bash: configurable via env var, falls back to HOME, then workspacePath
  const bashDefaultCwd = config.bashDefaultCwd 
    || process.env.BASH_DEFAULT_CWD 
    || process.env.HOME 
    || workspacePath;

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
        }).catch(console.error);
        return { exitCode: 1 };
      }

      return new Promise((resolve) => {
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
          opts.onData(data);
          publisher.publishOutput({
            type: 'stdout',
            requestId: requestIdRef.current,
            data: data.toString(),
          }).catch(console.error);
        });

        proc.stderr!.on('data', (data: Buffer) => {
          opts.onData(data);
          publisher.publishOutput({
            type: 'stderr',
            requestId: requestIdRef.current,
            data: data.toString(),
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
          opts.onData(Buffer.from(errorMsg));
          publisher.publishOutput({
            type: 'stderr',
            requestId: requestIdRef.current,
            data: errorMsg,
          }).catch(console.error);
          resolve({ exitCode: 1 });
        });
      });
    },
  };

  // Use bashDefaultCwd for the bash tool's base path (affects relative path resolution)
  const readTool = createReadTool(workspacePath, { operations: readOps });
  const writeTool = createWriteTool(workspacePath, { operations: writeOps });
  const editTool = createEditTool(workspacePath, { operations: editOps });
  const bashTool = createBashTool(bashDefaultCwd, { operations: bashOps });

  const tools: Tool[] = [readTool, writeTool, editTool, bashTool];
  return tools;
}
