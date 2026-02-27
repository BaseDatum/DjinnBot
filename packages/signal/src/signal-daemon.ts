/**
 * SignalDaemon — spawns and manages the signal-cli child process.
 *
 * signal-cli runs in HTTP daemon mode on 127.0.0.1:{port}, exposing
 * a JSON-RPC API and SSE event stream. The binary is a GraalVM native
 * executable (no JRE required).
 *
 * Data directory lives on JuiceFS at /data/signal/data so state persists
 * across container restarts.
 *
 * A Redis distributed lock ensures only one engine instance spawns the
 * daemon at a time (prevents corruption during rolling deploys).
 */

import { spawn, type ChildProcess } from 'node:child_process';
import { Redis } from 'ioredis';

// ── Daemon handle ────────────────────────────────────────────────────────────

export interface SignalDaemonConfig {
  /** Path to signal-cli binary. Default: 'signal-cli'. */
  cliPath?: string;
  /** signal-cli --config directory. */
  configDir: string;
  /** Signal account number (e.g. +15551234567). Set after linking. */
  account?: string;
  /** HTTP listen host. Default: '127.0.0.1'. */
  httpHost?: string;
  /** HTTP listen port. Default: 8820. */
  httpPort?: number;
  /** Send read receipts for incoming messages. */
  sendReadReceipts?: boolean;
}

export interface SignalDaemonExitEvent {
  source: 'process' | 'spawn-error';
  code: number | null;
  signal: string | null;
}

export interface SignalDaemonHandle {
  pid?: number;
  stop: () => void;
  exited: Promise<SignalDaemonExitEvent>;
  isExited: () => boolean;
}

export function formatDaemonExit(exit: SignalDaemonExitEvent): string {
  return `signal daemon exited (source=${exit.source} code=${String(exit.code ?? 'null')} signal=${String(exit.signal ?? 'null')})`;
}

// ── Log classification ───────────────────────────────────────────────────────

export function classifyLogLine(line: string): 'log' | 'error' | null {
  const trimmed = line.trim();
  if (!trimmed) return null;
  if (/\b(ERROR|WARN|WARNING)\b/.test(trimmed)) return 'error';
  if (/\b(FAILED|SEVERE|EXCEPTION)\b/i.test(trimmed)) return 'error';
  return 'log';
}

function bindOutput(
  stream: NodeJS.ReadableStream | null | undefined,
  prefix: string,
): void {
  stream?.on('data', (data: Buffer) => {
    for (const line of data.toString().split(/\r?\n/)) {
      const kind = classifyLogLine(line);
      if (kind === 'error') {
        console.error(`[${prefix}] ${line.trim()}`);
      } else if (kind === 'log') {
        console.log(`[${prefix}] ${line.trim()}`);
      }
    }
  });
}

// ── Daemon args ──────────────────────────────────────────────────────────────

function buildDaemonArgs(config: SignalDaemonConfig): string[] {
  const args: string[] = [];

  // --config must come before the subcommand
  args.push('--config', config.configDir);

  if (config.account) {
    args.push('-a', config.account);
  }

  args.push('daemon');
  args.push('--http', `${config.httpHost ?? '127.0.0.1'}:${config.httpPort ?? 8820}`);
  args.push('--no-receive-stdout');
  args.push('--receive-mode', 'on-start');

  if (config.sendReadReceipts) {
    args.push('--send-read-receipts');
  }

  return args;
}

// ── Spawn ────────────────────────────────────────────────────────────────────

export function spawnSignalDaemon(config: SignalDaemonConfig): SignalDaemonHandle {
  const cliPath = config.cliPath ?? 'signal-cli';
  const args = buildDaemonArgs(config);

  console.log(`[SignalDaemon] Spawning: ${cliPath} ${args.join(' ')}`);

  const child: ChildProcess = spawn(cliPath, args, {
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  let exited = false;
  let settled = false;
  let resolveExit!: (value: SignalDaemonExitEvent) => void;

  const exitedPromise = new Promise<SignalDaemonExitEvent>((resolve) => {
    resolveExit = resolve;
  });

  const settle = (event: SignalDaemonExitEvent) => {
    if (settled) return;
    settled = true;
    exited = true;
    resolveExit(event);
  };

  bindOutput(child.stdout, 'signal-cli');
  bindOutput(child.stderr, 'signal-cli');

  child.once('exit', (code, signal) => {
    settle({
      source: 'process',
      code: typeof code === 'number' ? code : null,
      signal: signal ?? null,
    });
    console.error(formatDaemonExit({
      source: 'process',
      code: code ?? null,
      signal: signal ?? null,
    }));
  });

  child.once('close', (code, signal) => {
    settle({
      source: 'process',
      code: typeof code === 'number' ? code : null,
      signal: signal ?? null,
    });
  });

  child.on('error', (err) => {
    console.error(`[SignalDaemon] spawn error: ${String(err)}`);
    settle({ source: 'spawn-error', code: null, signal: null });
  });

  return {
    pid: child.pid ?? undefined,
    exited: exitedPromise,
    isExited: () => exited,
    stop: () => {
      if (!child.killed && !exited) {
        console.log('[SignalDaemon] Sending SIGTERM');
        child.kill('SIGTERM');
      }
    },
  };
}

// ── Redis distributed lock ───────────────────────────────────────────────────
// Ensures only one engine instance runs signal-cli at a time.

const LOCK_KEY = 'djinnbot:signal:daemon-lock';
const LOCK_TTL_MS = 30_000;
const LOCK_RENEW_INTERVAL_MS = 10_000;

export async function acquireSignalDaemonLock(redis: Redis): Promise<{
  acquired: boolean;
  release: () => Promise<void>;
}> {
  const lockValue = `${process.pid}-${Date.now()}`;

  // Try to SET NX with TTL
  const result = await redis.set(LOCK_KEY, lockValue, 'PX', LOCK_TTL_MS, 'NX');

  if (result !== 'OK') {
    const holder = await redis.get(LOCK_KEY);
    console.warn(`[SignalDaemon] Lock held by ${holder ?? 'unknown'} — skipping Signal startup`);
    return { acquired: false, release: async () => {} };
  }

  console.log(`[SignalDaemon] Acquired daemon lock: ${lockValue}`);

  // Renew TTL periodically
  const renewTimer = setInterval(async () => {
    try {
      // Only renew if we still own the lock
      const current = await redis.get(LOCK_KEY);
      if (current === lockValue) {
        await redis.pexpire(LOCK_KEY, LOCK_TTL_MS);
      }
    } catch (err) {
      console.warn('[SignalDaemon] Lock renewal failed:', err);
    }
  }, LOCK_RENEW_INTERVAL_MS);

  const release = async () => {
    clearInterval(renewTimer);
    try {
      // Only delete if we still own it (atomic check-and-delete via Lua)
      const script = `
        if redis.call("get", KEYS[1]) == ARGV[1] then
          return redis.call("del", KEYS[1])
        else
          return 0
        end
      `;
      await redis.eval(script, 1, LOCK_KEY, lockValue);
      console.log('[SignalDaemon] Released daemon lock');
    } catch (err) {
      console.warn('[SignalDaemon] Lock release failed:', err);
    }
  };

  return { acquired: true, release };
}

// ── Health check polling ─────────────────────────────────────────────────────

export async function waitForDaemonReady(params: {
  baseUrl: string;
  timeoutMs?: number;
  pollIntervalMs?: number;
  abortSignal?: AbortSignal;
}): Promise<void> {
  const timeout = params.timeoutMs ?? 30_000;
  const interval = params.pollIntervalMs ?? 250;
  const start = Date.now();

  while (Date.now() - start < timeout) {
    if (params.abortSignal?.aborted) {
      throw new Error('Signal daemon startup aborted');
    }

    try {
      const res = await fetch(`${params.baseUrl}/api/v1/check`, {
        method: 'GET',
        signal: AbortSignal.timeout(2000),
      });
      if (res.ok) {
        console.log(`[SignalDaemon] Daemon ready after ${Date.now() - start}ms`);
        return;
      }
    } catch {
      // Not ready yet
    }

    await new Promise((r) => setTimeout(r, interval));
  }

  throw new Error(`Signal daemon not ready after ${timeout}ms`);
}
