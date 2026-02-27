/**
 * JuiceFS direct mount for the engine container.
 *
 * The engine mounts JuiceFS directly via the `juicefs` CLI + FUSE at /jfs.
 * ALL persistent data (sandboxes, vaults, workspaces, runs, signal, etc.)
 * lives on this mount.  No Docker named volumes are used for engine
 * persistent storage — only postgres, redis, rustfs, and the juicefs-mount
 * sidecar are allowed Docker volumes.
 *
 * The mount is started once at engine startup and kept alive for the lifetime
 * of the process.  `createContainer` uses the mount path for pre-creation of
 * subdirectories needed by agent containers (especially read-only --subdir
 * mounts like /cookies/{agentId} which JuiceFS cannot auto-create).
 */

import { execFile } from 'node:child_process';
import { existsSync, mkdirSync } from 'node:fs';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

/** Where the engine's JuiceFS FUSE mount lives — all persistent data goes here. */
const JFS_MOUNT = '/jfs';

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
  if (mounted) return JFS_MOUNT;

  const metaUrl = process.env.JFS_META_URL;
  if (!metaUrl) {
    console.warn('[JuiceFS] JFS_META_URL not set — skipping engine-side JuiceFS mount');
    return '';
  }

  // Ensure mount point exists
  if (!existsSync(JFS_MOUNT)) {
    mkdirSync(JFS_MOUNT, { recursive: true });
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
      JFS_MOUNT,
    ]);
    mounted = true;
    console.log(`[JuiceFS] Engine FUSE mount ready at ${JFS_MOUNT}`);
    return JFS_MOUNT;
  } catch (err: any) {
    console.error('[JuiceFS] Failed to mount JuiceFS in engine:', err.stderr || err.message);
    return '';
  }
}

/**
 * Return the engine's JuiceFS mount path, or empty string if not mounted.
 */
export function getJfsMountPath(): string {
  return mounted ? JFS_MOUNT : '';
}

/**
 * Ensure directories exist on the JuiceFS volume.
 * This MUST be called after mountJuiceFS() — directories are created on the
 * real JuiceFS FUSE filesystem so that agent containers can use
 * `juicefs mount --subdir` (which requires pre-existing directories for
 * read-only mounts).
 *
 * @param jfsDirs - paths relative to the JuiceFS root (e.g. `/cookies/yukihiro`)
 */
export function ensureJfsDirs(jfsDirs: string[]): void {
  if (!mounted) {
    console.warn('[JuiceFS] ensureJfsDirs called but JuiceFS is not mounted — directories may not be visible to agents');
  }
  const basePath = JFS_MOUNT;
  for (const dir of jfsDirs) {
    const full = `${basePath}${dir}`;
    try {
      mkdirSync(full, { recursive: true });
    } catch {
      // May already exist
    }
  }
}
