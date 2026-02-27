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
import { readdirSync, unlinkSync, existsSync } from 'node:fs';
import { join } from 'node:path';
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

// ── Stale lock cleanup ───────────────────────────────────────────────────────

/**
 * Remove stale signal-cli lock files from the data directory.
 *
 * signal-cli uses Java NIO file locks on account data files. When the container
 * is killed (SIGKILL / OOM), the lock isn't released — especially on FUSE
 * filesystems like JuiceFS where the kernel doesn't get an unlock syscall.
 * This causes the next signal-cli startup to block with:
 *   "Config file is in use by another instance, waiting…"
 *
 * Since we hold a Redis distributed lock guaranteeing only one engine instance
 * runs signal-cli at a time, any leftover lock files are stale and safe to remove.
 */
function cleanStaleLocks(configDir: string): void {
  const dataDir = join(configDir, 'data');
  if (!existsSync(dataDir)) return;

  try {
    const entries = readdirSync(dataDir, { withFileTypes: true });
    for (const entry of entries) {
      // signal-cli lock files: *.lock or lock files inside account directories
      if (entry.isFile() && entry.name.endsWith('.lock')) {
        const lockPath = join(dataDir, entry.name);
        console.log(`[SignalDaemon] Removing stale lock: ${lockPath}`);
        unlinkSync(lockPath);
      }
      if (entry.isDirectory()) {
        const lockPath = join(dataDir, entry.name, 'lock');
        if (existsSync(lockPath)) {
          console.log(`[SignalDaemon] Removing stale lock: ${lockPath}`);
          unlinkSync(lockPath);
        }
      }
    }
  } catch (err) {
    console.warn('[SignalDaemon] Failed to clean stale locks:', err);
  }
}

// ── Spawn ────────────────────────────────────────────────────────────────────

export function spawnSignalDaemon(config: SignalDaemonConfig): SignalDaemonHandle {
  const cliPath = config.cliPath ?? 'signal-cli';
  const args = buildDaemonArgs(config);

  // Clean stale lock files before spawning — safe because we hold the
  // Redis distributed lock (only one engine instance runs signal-cli).
  cleanStaleLocks(config.configDir);

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
const LOCK_HEARTBEAT_KEY = 'djinnbot:signal:daemon-heartbeat';
const LOCK_TTL_MS = 30_000;
const LOCK_RENEW_INTERVAL_MS = 10_000;

export async function acquireSignalDaemonLock(redis: Redis): Promise<{
  acquired: boolean;
  release: () => Promise<void>;
}> {
  const lockValue = `${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

  // Try to SET NX with TTL
  let result = await redis.set(LOCK_KEY, lockValue, 'PX', LOCK_TTL_MS, 'NX');

  if (result !== 'OK') {
    // Lock is held — but in a container environment, the holder is always
    // from a previous container (PID 1 check is useless since every container
    // has PID 1). Instead, we use a heartbeat key: the lock holder writes a
    // heartbeat on every renewal. If the heartbeat is older than 2x the
    // renewal interval, the lock is stale.
    const holder = await redis.get(LOCK_KEY);
    const lastHeartbeat = await redis.get(LOCK_HEARTBEAT_KEY);
    const heartbeatAge = lastHeartbeat ? Date.now() - parseInt(lastHeartbeat, 10) : Infinity;
    const stale = heartbeatAge > LOCK_RENEW_INTERVAL_MS * 3;

    if (stale) {
      console.log(`[SignalDaemon] Stale lock from ${holder ?? 'unknown'} (heartbeat ${heartbeatAge}ms old) — force-acquiring`);
      await redis.del(LOCK_KEY);
      await redis.del(LOCK_HEARTBEAT_KEY);
      result = await redis.set(LOCK_KEY, lockValue, 'PX', LOCK_TTL_MS, 'NX');
    }

    if (result !== 'OK') {
      console.warn(`[SignalDaemon] Lock held by ${holder ?? 'unknown'} — skipping Signal startup`);
      return { acquired: false, release: async () => {} };
    }
  }

  console.log(`[SignalDaemon] Acquired daemon lock: ${lockValue}`);

  // Write initial heartbeat
  await redis.set(LOCK_HEARTBEAT_KEY, String(Date.now()), 'PX', LOCK_TTL_MS);

  // Renew TTL and heartbeat periodically
  const renewTimer = setInterval(async () => {
    try {
      // Only renew if we still own the lock
      const current = await redis.get(LOCK_KEY);
      if (current === lockValue) {
        await redis.pexpire(LOCK_KEY, LOCK_TTL_MS);
        await redis.set(LOCK_HEARTBEAT_KEY, String(Date.now()), 'PX', LOCK_TTL_MS);
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
          redis.call("del", KEYS[2])
          return redis.call("del", KEYS[1])
        else
          return 0
        end
      `;
      await redis.eval(script, 2, LOCK_KEY, LOCK_HEARTBEAT_KEY, lockValue);
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
