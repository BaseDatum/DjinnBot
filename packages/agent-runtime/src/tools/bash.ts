import { spawn, type ChildProcess } from 'node:child_process';
import type { RedisPublisher } from '../redis/publisher.js';

export interface BashResult {
  exitCode: number | null;
  signal: string | null;
  stdout: string;
  stderr: string;
}

export interface BashOptions {
  cwd?: string;
  timeout?: number;
  env?: Record<string, string>;
}

export async function executeBash(
  command: string,
  publisher: RedisPublisher,
  requestId: string,
  options: BashOptions = {}
): Promise<BashResult> {
  const { cwd = '/workspace', timeout = 300000, env } = options;

  return new Promise((resolve, reject) => {
    let stdout = '';
    let stderr = '';
    let killed = false;

    const proc = spawn('bash', ['-c', command], {
      cwd,
      env: { ...process.env, ...env },
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    // Timeout handling
    const timeoutId = timeout > 0 ? setTimeout(() => {
      killed = true;
      proc.kill('SIGTERM');
      setTimeout(() => proc.kill('SIGKILL'), 5000);
    }, timeout) : null;

    // Stream stdout
    proc.stdout.on('data', (chunk: Buffer) => {
      const data = chunk.toString();
      stdout += data;
      publisher.publishOutput({
        type: 'stdout',
        requestId,
        data,
      }).catch(console.error);
    });

    // Stream stderr
    proc.stderr.on('data', (chunk: Buffer) => {
      const data = chunk.toString();
      stderr += data;
      publisher.publishOutput({
        type: 'stderr',
        requestId,
        data,
      }).catch(console.error);
    });

    proc.on('close', (code, signal) => {
      if (timeoutId) clearTimeout(timeoutId);
      
      resolve({
        exitCode: code,
        signal: signal || (killed ? 'SIGTERM' : null),
        stdout,
        stderr,
      });
    });

    proc.on('error', (err) => {
      if (timeoutId) clearTimeout(timeoutId);
      reject(err);
    });
  });
}