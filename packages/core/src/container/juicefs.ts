/**
 * JuiceFS direct mount for the engine container.
 *
 * The engine's Docker named volume (`juicefs-data:/data`) is the raw volume
 * storage — NOT the JuiceFS FUSE filesystem.  Directories created via plain
 * `mkdirSync('/data/...')` are invisible to JuiceFS clients.
 *
 * This module mounts JuiceFS directly inside the engine container (via the
 * `juicefs` CLI + FUSE) so that subdirectory pre-creation for agent containers
 * goes through the real filesystem.  This is critical for read-only `--subdir`
 * mounts (e.g. `/cookies/{agentId}`): JuiceFS auto-creates missing subdirs for
 * rw mounts, but cannot for ro mounts — they must already exist.
 *
 * The mount is started once at engine startup and kept alive for the lifetime
 * of the process.  `createContainer` uses the mount path for pre-creation.
 */

import { execFile } from 'node:child_process';
import { existsSync, mkdirSync } from 'node:fs';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

/** Where the engine's own JuiceFS FUSE mount lives. */
const JFS_ENGINE_MOUNT = '/jfs';

let mounted = false;

/**
 * Mount the JuiceFS volume inside the engine container.
 * Idempotent — subsequent calls are no-ops if already mounted.
 *
 * Requires:
 *  - `juicefs` binary on PATH
 *  - `/dev/fuse` device available (cap_add: SYS_ADMIN in compose)
 *  - JFS_META_URL env var pointing to Redis metadata (e.g. redis://redis:6379/2)
 */
export async function mountJuiceFS(): Promise<string> {
  if (mounted) return JFS_ENGINE_MOUNT;

  const metaUrl = process.env.JFS_META_URL;
  if (!metaUrl) {
    console.warn('[JuiceFS] JFS_META_URL not set — skipping engine-side JuiceFS mount');
    return '';
  }

  // Ensure mount point exists
  if (!existsSync(JFS_ENGINE_MOUNT)) {
    mkdirSync(JFS_ENGINE_MOUNT, { recursive: true });
  }

  try {
    await execFileAsync('juicefs', [
      'mount',
      '--cache-dir', '/tmp/jfscache-engine',
      '--cache-size', '512',
      '--no-usage-report',
      '--attr-cache', '1',
      '--entry-cache', '1',
      '--dir-entry-cache', '1',
      '--background',
      metaUrl,
      JFS_ENGINE_MOUNT,
    ]);
    mounted = true;
    console.log(`[JuiceFS] Engine FUSE mount ready at ${JFS_ENGINE_MOUNT}`);
    return JFS_ENGINE_MOUNT;
  } catch (err: any) {
    console.error('[JuiceFS] Failed to mount JuiceFS in engine:', err.stderr || err.message);
    return '';
  }
}

/**
 * Return the engine's JuiceFS mount path, or empty string if not mounted.
 */
export function getJfsMountPath(): string {
  return mounted ? JFS_ENGINE_MOUNT : '';
}

/**
 * Ensure directories exist on the JuiceFS volume.
 * Falls back to the raw Docker volume path if JuiceFS is not mounted.
 *
 * @param jfsDirs  - paths relative to the JuiceFS root (e.g. `/cookies/yukihiro`)
 * @param fallbackDataPath - raw Docker volume path (e.g. `/data`)
 */
export function ensureJfsDirs(jfsDirs: string[], fallbackDataPath: string): void {
  const basePath = mounted ? JFS_ENGINE_MOUNT : fallbackDataPath;
  for (const dir of jfsDirs) {
    const full = `${basePath}${dir}`;
    try {
      mkdirSync(full, { recursive: true });
    } catch {
      // May already exist
    }
  }
}
