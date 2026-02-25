import Docker from 'dockerode';
import { mkdirSync } from 'node:fs';
import { Redis, type Redis as RedisType } from 'ioredis';
import { channels } from '../redis-protocol/index.js';

export interface ContainerConfig {
  runId: string;
  agentId: string;
  /** @deprecated Use runWorkspacePath instead. Kept for backward-compat with non-pipeline callers. */
  workspacePath: string;
  /** Absolute host path to the run's git worktree (e.g. /data/runs/{runId}).
   *  Symlinked inside the container as /home/agent/run-workspace. */
  runWorkspacePath?: string;
  /** Absolute host path to the project's main git repo (e.g. /data/workspaces/{projectId}).
   *  Symlinked inside the container as /home/agent/project-workspace. */
  projectWorkspacePath?: string;
  image?: string;
  env?: Record<string, string>;
  memoryLimit?: number; // bytes
  cpuLimit?: number; // cores
}

export interface ContainerInfo {
  containerId: string;
  runId: string;
  status: 'created' | 'starting' | 'ready' | 'running' | 'stopping' | 'stopped';
  /** Set to true when the image was auto-pulled during container creation. */
  imagePulled?: boolean;
}

const DEFAULT_IMAGE = process.env.AGENT_RUNTIME_IMAGE || 'ghcr.io/basedatum/djinnbot/agent-runtime:latest';
const READY_TIMEOUT_MS = 30000;

// Resource defaults — callers can override via ContainerConfig
const DEFAULT_MEMORY_LIMIT = 2 * 1024 * 1024 * 1024;  // 2 GB
const DEFAULT_CPU_LIMIT = 2;                            // 2 vCPUs

/** Callback invoked by ContainerManager when an image pull starts or completes. */
export type ImagePullCallback = (event: 'pull_start' | 'pull_success' | 'pull_failed', image: string, error?: string) => void;

export class ContainerManager {
  private docker: Docker;
  private containers = new Map<string, ContainerInfo>();

  /** Optional callback notified when the manager auto-pulls a missing image. */
  onImagePull?: ImagePullCallback;

  constructor(
    private redis: RedisType,
    dockerOptions?: Docker.DockerOptions
  ) {
    this.docker = new Docker(dockerOptions);
    this.setupRedisErrorHandlers();
    this.setupDockerEventMonitoring();
  }

  private setupRedisErrorHandlers(): void {
    this.redis.on('error', (err) => {
      console.error('[ContainerManager] Redis error:', err.message);
    });

    this.redis.on('close', () => {
      console.log('[ContainerManager] Redis connection closed');
    });

    this.redis.on('reconnecting', () => {
      console.log('[ContainerManager] Redis reconnecting...');
    });
  }

  private setupDockerEventMonitoring(): void {
    // Monitor Docker events for container crashes
    this.docker.getEvents((err, stream) => {
      if (err) {
        console.error('[ContainerManager] Failed to get Docker event stream:', err.message);
        return;
      }

      if (!stream) {
        console.error('[ContainerManager] Docker event stream is null');
        return;
      }

      // Buffer for incomplete JSON lines
      let buffer = '';

      stream.on('data', (chunk: Buffer) => {
        // Docker event stream is newline-delimited JSON (NDJSON)
        buffer += chunk.toString();
        const lines = buffer.split('\n');
        
        // Keep incomplete line in buffer
        buffer = lines.pop() || '';
        
        for (const line of lines) {
          if (!line.trim()) continue;
          
          let event: any;
          try {
            event = JSON.parse(line);
          } catch {
            // Skip malformed lines
            continue;
          }
          
          // Monitor die, kill, stop events
          if (event.Type === 'container' && ['die', 'kill', 'stop'].includes(event.Action)) {
            const containerName = event.Actor?.Attributes?.name;
            
            // Check if this is one of our managed containers
            if (containerName?.startsWith('djinn-run-')) {
              const runId = containerName.replace('djinn-run-', '');
              const info = this.containers.get(runId);
              
              if (info) {
                const exitCode = event.Actor?.Attributes?.exitCode || '1';
                console.error(`[ContainerManager] Container crashed for run ${runId}: ${event.Action} (exit code: ${exitCode})`);
                
                // Clean up internal state
                info.status = 'stopped';
                this.containers.delete(runId);
              }
            }
          }
        }
      });

      stream.on('error', (streamErr) => {
        console.error('[ContainerManager] Docker event stream error:', streamErr.message);
      });
    });
  }

  /**
   * Pull a Docker image. Returns true on success, false on failure.
   * Used internally when createContainer encounters a missing image.
   */
  private async pullImage(image: string): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      this.docker.pull(image, (err: Error | null, stream: NodeJS.ReadableStream) => {
        if (err) return reject(err);
        // Follow the pull progress to completion
        this.docker.modem.followProgress(stream, (progressErr: Error | null) => {
          if (progressErr) return reject(progressErr);
          resolve();
        });
      });
    });
  }

  /**
   * Returns true if the error is a Docker "No such image" 404.
   */
  private static isImageNotFoundError(err: any): boolean {
    return (
      err?.statusCode === 404 &&
      typeof err?.json?.message === 'string' &&
      err.json.message.includes('No such image')
    );
  }

  async createContainer(config: ContainerConfig): Promise<ContainerInfo> {
    const {
      runId,
      agentId,
      workspacePath,
      runWorkspacePath,
      projectWorkspacePath,
      image = DEFAULT_IMAGE,
      env = {},
      memoryLimit,
      cpuLimit,
    } = config;

    try {
      console.log(`[ContainerManager] Creating container for run ${runId} (agent: ${agentId})`);

      // Idempotency guard: if a container for this run already exists, reuse or clean it up
      // rather than letting Docker return a 409 Conflict. This handles engine restarts and
      // duplicate run signals from the Redis stream.
      try {
        const existing = this.docker.getContainer(`djinn-run-${runId}`);
        const info = await existing.inspect();
        if (info.State.Running || info.State.Status === 'created') {
          console.warn(`[ContainerManager] Container for run ${runId} already exists (${info.State.Status}), reusing`);
          const containerInfo: ContainerInfo = {
            containerId: info.Id,
            runId,
            status: info.State.Running ? 'running' : 'created',
          };
          this.containers.set(runId, containerInfo);
          return containerInfo;
        }
        // Container exists but is stopped/exited — remove it so we can recreate cleanly
        console.warn(`[ContainerManager] Stale container found for run ${runId} (${info.State.Status}), removing`);
        await existing.remove({ force: true });
      } catch (inspectErr: any) {
        if (inspectErr.statusCode !== 404) {
          // Unexpected inspect error — surface it rather than silently proceeding
          throw inspectErr;
        }
        // 404 = container doesn't exist, proceed to create normally
      }

      // ── JuiceFS direct-mount architecture ────────────────────────────────
      //
      // Each agent container mounts JuiceFS subdirectories directly over the
      // network (Redis metadata + RustFS S3 object storage).  This gives true
      // filesystem-level isolation: the kernel's FUSE mount namespace prevents
      // agents from accessing each other's data — no symlinks, no shared volume.
      //
      // The container gets CAP_SYS_ADMIN + /dev/fuse and runs `juicefs mount
      // --subdir <path>` for each mount point before starting the agent process.
      //
      // Mount table (each is an independent FUSE mount):
      //   juicefs --subdir /sandboxes/{agentId}    → /home/agent
      //   juicefs --subdir /vaults/{agentId}       → /home/agent/clawvault
      //   juicefs --subdir /runs/{runId}            → /home/agent/run-workspace
      //   juicefs --subdir /workspaces/{projectId}  → /home/agent/project-workspace  (optional)
      //
      // The shared vault is NOT mounted — agents access it via the DjinnBot API.
      // This provides a real security boundary: agents can only read/write shared
      // knowledge through validated API endpoints, not by touching the filesystem.

      // JuiceFS metadata URL — same Redis DB 2 used by the compose juicefs-mount service.
      const jfsMetaUrl = process.env.JFS_META_URL || 'redis://redis:6379/2';

      // Resolve which path maps to run-workspace inside the container.
      // Prefer the explicit runWorkspacePath; fall back to the legacy workspacePath field.
      const effectiveRunPath = runWorkspacePath ?? workspacePath;

      // Extract relative path from /data/... to use as JuiceFS subdir.
      // e.g. "/data/runs/run_xxx" → "runs/run_xxx"
      const runRelative = effectiveRunPath.replace('/data/', '');

      // Project workspace relative path (only used when projectWorkspacePath is provided).
      // e.g. "/data/workspaces/proj_xxx" → "workspaces/proj_xxx"
      const projectRelative = projectWorkspacePath ? projectWorkspacePath.replace('/data/', '') : null;

      // ── Pre-create JuiceFS subdirectories on the engine's mount ──────────
      // `juicefs mount --subdir` requires the subdirectory to already exist.
      // The engine has the JuiceFS volume mounted at /data, so we create
      // the necessary paths here before the agent container tries to mount them.
      const dataPath = process.env.DJINN_DATA_PATH || process.env.DATA_DIR || '/data';
      const dirsToEnsure = [
        `${dataPath}/sandboxes/${agentId}`,
        `${dataPath}/vaults/${agentId}`,
        `${dataPath}/${runRelative}`,
        ...(projectRelative ? [`${dataPath}/${projectRelative}`] : []),
      ];
      for (const dir of dirsToEnsure) {
        try { mkdirSync(dir, { recursive: true }); } catch { /* may already exist */ }
      }

      // ── Build the JuiceFS mount table ────────────────────────────────────
      // Each entry: [subdir, mountpoint, readOnly?]
      const jfsMounts: Array<[string, string, boolean]> = [
        [`/sandboxes/${agentId}`, '/home/agent', false],
        [`/vaults/${agentId}`, '/home/agent/clawvault', false],
        [`/${runRelative}`, '/home/agent/run-workspace', false],
      ];
      if (projectRelative) {
        jfsMounts.push([`/${projectRelative}`, '/home/agent/project-workspace', false]);
      }

      // Serialize the mount table as a compact env var for the boot script.
      // Format: "subdir:mountpoint:ro|rw;subdir:mountpoint:ro|rw;..."
      const jfsMountSpec = jfsMounts
        .map(([subdir, target, ro]) => `${subdir}:${target}:${ro ? 'ro' : 'rw'}`)
        .join(';');

      // JuiceFS cache tuning for agent containers — smaller than the central
      // mount since each container has its own cache.
      const jfsCacheSize = process.env.JFS_AGENT_CACHE_SIZE || '2048'; // 2GB default

      const apiUrl = config.env?.DJINNBOT_API_URL || process.env.DJINNBOT_API_URL || 'http://api:8000';

      const containerOpts: Docker.ContainerCreateOptions = {
        Image: image,
        name: `djinn-run-${runId}`,
        Env: [
          `RUN_ID=${runId}`,
          `AGENT_ID=${agentId}`,
          `REDIS_URL=${process.env.REDIS_URL || 'redis://redis:6379'}`,
          `WORKSPACE_PATH=/home/agent/run-workspace`,
          // ClawVault path — personal vault only (mounted via JuiceFS).
          // The shared vault is accessed via the DjinnBot API, not mounted.
          `CLAWVAULT_PATH=/home/agent/clawvault`,
          `HOME=/home/agent`,
          // DjinnBot API URL — used by agent-runtime for shared vault operations
          // and other API calls (git credentials, task management, etc.)
          `DJINNBOT_API_URL=${apiUrl}`,
          // Git identity — ensures commits made by the agent inside the container
          // are attributed to the agent rather than failing with "user not configured".
          `GIT_AUTHOR_NAME=${agentId}`,
          `GIT_AUTHOR_EMAIL=${agentId}@djinnbot.local`,
          `GIT_COMMITTER_NAME=djinnbot`,
          `GIT_COMMITTER_EMAIL=djinnbot@local`,
          // ── JuiceFS connection credentials ──────────────────────────────────
          // The boot script uses these to run `juicefs mount --subdir` for each
          // mount point before starting the agent process.
          `JFS_META_URL=${jfsMetaUrl}`,
          `JFS_MOUNT_SPEC=${jfsMountSpec}`,
          `JFS_CACHE_SIZE=${jfsCacheSize}`,
          // QMD/QMDR config — injected from process.env, which is populated at engine
          // startup from the DB (syncProviderApiKeysToDb) so DB-configured values are
          // reflected here even if the original env var was absent at boot time.
          ...(process.env.QMD_OPENAI_API_KEY ? [`QMD_OPENAI_API_KEY=${process.env.QMD_OPENAI_API_KEY}`] : []),
          ...(process.env.QMD_OPENAI_BASE_URL ? [`QMD_OPENAI_BASE_URL=${process.env.QMD_OPENAI_BASE_URL}`] : []),
          ...(process.env.QMD_EMBED_PROVIDER ? [`QMD_EMBED_PROVIDER=${process.env.QMD_EMBED_PROVIDER}`] : []),
          ...(process.env.QMD_OPENAI_EMBED_MODEL ? [`QMD_OPENAI_EMBED_MODEL=${process.env.QMD_OPENAI_EMBED_MODEL}`] : []),
          ...(process.env.QMD_RERANK_PROVIDER ? [`QMD_RERANK_PROVIDER=${process.env.QMD_RERANK_PROVIDER}`] : []),
          ...(process.env.QMD_RERANK_MODE ? [`QMD_RERANK_MODE=${process.env.QMD_RERANK_MODE}`] : []),
          ...(process.env.QMD_OPENAI_MODEL ? [`QMD_OPENAI_MODEL=${process.env.QMD_OPENAI_MODEL}`] : []),
          ...(process.env.OPENROUTER_API_KEY ? [`OPENROUTER_API_KEY=${process.env.OPENROUTER_API_KEY}`] : []),
          ...Object.entries(env).map(([k, v]) => `${k}=${v}`),
        ],
        HostConfig: {
          // No Docker volume mounts — each container mounts JuiceFS directly
          // over the network using its own FUSE client.
          NetworkMode: 'djinnbot_djinnbot_default',
          Memory: memoryLimit ?? DEFAULT_MEMORY_LIMIT,
          NanoCpus: (cpuLimit ?? DEFAULT_CPU_LIMIT) * 1e9,
          // CAP_SYS_ADMIN + /dev/fuse for JuiceFS FUSE mounts inside the container.
          // SecurityOpt disables both the default seccomp profile and AppArmor
          // confinement — both of which block the mount syscall even when
          // CAP_SYS_ADMIN is granted.  On Ubuntu/Debian VPS hosts Docker's
          // "docker-default" AppArmor profile denies mount; seccomp alone is
          // not sufficient.  This matches the effective privileges of the
          // juicefs-mount compose service (which uses `privileged: true`).
          CapAdd: ['SYS_ADMIN'],
          SecurityOpt: ['seccomp=unconfined', 'apparmor=unconfined'],
          Devices: [{ PathOnHost: '/dev/fuse', PathInContainer: '/dev/fuse', CgroupPermissions: 'rwm' }],
          // Chromium (Playwright) uses /dev/shm heavily for rendering.
          // Docker defaults /dev/shm to 64MB which causes SIGBUS crashes on
          // non-trivial pages. 256MB is sufficient for typical headless usage.
          ShmSize: 256 * 1024 * 1024,
          AutoRemove: true,
        },
        // Boot script: mount JuiceFS subdirectories, set up git credentials, start agent.
        Cmd: [
          'sh', '-c',
          // Exit immediately if any command fails
          `set -e && ` +
          // ── Mount JuiceFS subdirectories ─────────────────────────────────────
          // Parse JFS_MOUNT_SPEC (semicolon-delimited entries of subdir:target:mode)
          // and mount each as an independent FUSE filesystem.
          `echo "[boot] Mounting JuiceFS subdirectories..." && ` +
          `IFS=';' && for entry in $JFS_MOUNT_SPEC; do ` +
          `  subdir=$(echo "$entry" | cut -d: -f1) && ` +
          `  target=$(echo "$entry" | cut -d: -f2) && ` +
          `  mode=$(echo "$entry" | cut -d: -f3) && ` +
          `  ro_flag="" && ` +
          `  if [ "$mode" = "ro" ]; then ro_flag="--read-only"; fi && ` +
          `  echo "[boot]   $subdir -> $target ($mode)" && ` +
          `  mkdir -p "$target" && ` +
          `  juicefs mount ` +
          `    --subdir "$subdir" ` +
          `    --cache-dir /tmp/jfscache ` +
          `    --cache-size "$JFS_CACHE_SIZE" ` +
          `    --no-usage-report ` +
          `    --attr-cache 1 ` +
          `    --entry-cache 1 ` +
          `    --dir-entry-cache 1 ` +
          `    --background ` +
          `    $ro_flag ` +
          `    "$JFS_META_URL" ` +
          `    "$target" && ` +
          `  echo "[boot]   mounted $target" || ` +
          `  { echo "[boot] FATAL: failed to mount $subdir at $target"; exit 1; }; ` +
          `done && unset IFS && ` +
          `echo "[boot] All JuiceFS mounts ready" && ` +
          // ── Git credential helper ───────────────────────────────────────────
          (() => {
            const script = [
              '#!/bin/sh',
              '# djinnbot-git-credential: fetches a GitHub App token from the DjinnBot API.',
              '# Git calls this helper as: djinnbot-git-credential get',
              '[ "$1" = "get" ] || exit 0',
              'INPUT=$(cat)',
              'HOST=$(printf "%s" "$INPUT" | grep "^host=" | cut -d= -f2-)',
              '[ "$HOST" = "github.com" ] || exit 0',
              `API_URL="${apiUrl}"`,
              `AGENT_ID="${agentId}"`,
              'RESP=$(curl -sf "$API_URL/v1/github/git-credential?agent_id=$AGENT_ID" 2>/dev/null || true)',
              '[ -n "$RESP" ] || exit 1',
              // Extract token field from JSON without jq (plain sh / sed)
              'TOKEN=$(printf "%s" "$RESP" | sed \'s/.*"token":"\\([^"]*\\)".*/\\1/\')',
              '[ -n "$TOKEN" ] || exit 1',
              'printf "username=x-access-token\\npassword=%s\\n" "$TOKEN"',
            ].join('\n');
            const b64 = Buffer.from(script).toString('base64');
            return (
              `mkdir -p /usr/local/bin && ` +
              `echo '${b64}' | base64 -d > /usr/local/bin/djinnbot-git-credential && ` +
              `chmod +x /usr/local/bin/djinnbot-git-credential && ` +
              `git config --global credential.helper /usr/local/bin/djinnbot-git-credential && `
            );
          })() +
          // Start the agent runtime
          `exec node /app/packages/agent-runtime/dist/entrypoint.js`
        ],
      };

      // Attempt to create the container; if the image is missing, pull it and retry.
      let container: Docker.Container;
      let imagePulled = false;
      try {
        container = await this.docker.createContainer(containerOpts);
      } catch (createErr: any) {
        if (!ContainerManager.isImageNotFoundError(createErr)) throw createErr;

        // Image not found — attempt to pull it
        console.log(`[ContainerManager] Image "${image}" not found locally, pulling...`);
        this.onImagePull?.('pull_start', image);
        try {
          await this.pullImage(image);
          console.log(`[ContainerManager] Successfully pulled image "${image}"`);
          this.onImagePull?.('pull_success', image);
          imagePulled = true;
        } catch (pullErr: any) {
          const pullMsg = pullErr?.message || String(pullErr);
          console.error(`[ContainerManager] Failed to pull image "${image}":`, pullMsg);
          this.onImagePull?.('pull_failed', image, pullMsg);
          throw new Error(`Failed to pull agent runtime image "${image}": ${pullMsg}`);
        }

        // Retry container creation after successful pull
        container = await this.docker.createContainer(containerOpts);
      }

      const info: ContainerInfo = {
        containerId: container.id,
        runId,
        status: 'created',
        imagePulled,
      };
      this.containers.set(runId, info);

      return info;
    } catch (error) {
      const err = error as Error;
      console.error(`[ContainerManager] Failed to create container for run ${runId}:`, err.message);
      throw error;
    }
  }

  async startContainer(runId: string): Promise<void> {
    const info = this.containers.get(runId);
    if (!info) throw new Error(`No container for run ${runId}`);

    const container = this.docker.getContainer(info.containerId);
    info.status = 'starting';

    try {
      await container.start();
      console.log(`[ContainerManager] Started container ${info.containerId}`);

      // Wait for ready status from container
      await this.waitForReady(runId);
      info.status = 'ready';
    } catch (error) {
      const err = error as Error;
      console.error(`[ContainerManager] Failed to start container for run ${runId}:`, err.message);

      // Attempt to capture container logs before cleanup (AutoRemove may have
      // already destroyed it, but if it's still around this is invaluable for
      // diagnosing startup crashes).
      try {
        const logStream = await container.logs({ stdout: true, stderr: true, tail: 50 });
        const logs = typeof logStream === 'string' ? logStream : logStream.toString('utf-8');
        if (logs.trim()) {
          console.error(`[ContainerManager] Container logs for run ${runId}:\n${logs}`);
        }
      } catch {
        // Container already gone (AutoRemove) — nothing we can do
      }

      // Clean up on failure
      info.status = 'stopped';
      this.containers.delete(runId);
      
      // Attempt cleanup of the failed container
      try {
        await container.remove({ force: true });
      } catch (cleanupErr) {
        console.error(`[ContainerManager] Failed to cleanup container ${info.containerId}:`, cleanupErr);
      }
      
      throw error;
    }
  }

  private async waitForReady(runId: string): Promise<void> {
    const channel = channels.status(runId);
    const subscriber = this.redis.duplicate();

    return new Promise((resolve, reject) => {
      let cleaned = false;

      const cleanup = () => {
        if (cleaned) return;
        cleaned = true;
        subscriber.unsubscribe(channel).catch(err => console.error('[ContainerManager] Unsubscribe error:', err));
        subscriber.quit().catch(err => console.error('[ContainerManager] Quit error:', err));
      };

      const timeout = setTimeout(() => {
        cleanup();
        reject(new Error(`Container for run ${runId} did not become ready within ${READY_TIMEOUT_MS}ms`));
      }, READY_TIMEOUT_MS);

      subscriber.on('error', (err) => {
        clearTimeout(timeout);
        cleanup();
        reject(new Error(`Redis subscriber error: ${err.message}`));
      });

      subscriber.on('close', () => {
        console.log(`[ContainerManager] Container ready — redis subscriber for ${runId} closed`);
      });

      subscriber.on('message', (ch, message) => {
        if (ch !== channel) return;
        try {
          const status = JSON.parse(message);
          if (status.type === 'ready') {
            clearTimeout(timeout);
            cleanup();
            resolve();
          }
        } catch (parseErr) {
          console.error('[ContainerManager] Failed to parse ready message:', parseErr);
        }
      });

      subscriber.subscribe(channel).catch(err => {
        clearTimeout(timeout);
        cleanup();
        reject(new Error(`Failed to subscribe: ${err.message}`));
      });
    });
  }

  async stopContainer(runId: string, graceful = true): Promise<void> {
    const info = this.containers.get(runId);

    // If the container isn't in our in-memory map (e.g. engine restarted, or
    // this is a chat session container started before the current process) we
    // still want to kill it.  Container names are deterministic so we can
    // resolve it directly from Docker.
    let container: Docker.Container;
    if (!info) {
      const namedContainer = this.docker.getContainer(`djinn-run-${runId}`);
      try {
        const inspectInfo = await namedContainer.inspect();
        if (!inspectInfo.State.Running) {
          // Already stopped — nothing to do.
          return;
        }
        container = namedContainer;
        console.log(`[ContainerManager] Stopping untracked container for run ${runId}`);
      } catch (err: any) {
        if (err.statusCode === 404) {
          // Container doesn't exist at all — already gone.
          return;
        }
        throw err;
      }
    } else {
      info.status = 'stopping';
      container = this.docker.getContainer(info.containerId);
    }

    try {
      if (graceful) {
        // Send shutdown command via Redis
        const cmdChannel = channels.command(runId);
        
        try {
          await this.redis.publish(
            cmdChannel,
            JSON.stringify({
              type: 'shutdown',
              timestamp: Date.now(),
            })
          );
        } catch (publishErr) {
          const err = publishErr as Error;
          console.error(`[ContainerManager] Failed to publish shutdown command for run ${runId}:`, err.message);
          // Continue with forceful stop if Redis publish fails
        }

        // Wait for container to stop
        await container.wait({ condition: 'not-running' });
      } else {
        await container.stop({ t: 10 });
      }
    } catch (err: unknown) {
      const error = err as { message?: string };
      if (!error.message?.includes('not running')) {
        console.error(`[ContainerManager] Error stopping container:`, err);
      }
    }

    if (info) {
      info.status = 'stopped';
      this.containers.delete(runId);
    }
    console.log(`[ContainerManager] Stopped container for run ${runId}`);

    // AutoRemove is enabled, so Docker will remove the container on exit.
    // Attempt an explicit remove anyway as a safety net (e.g. for containers
    // that were stopped before the runtime started, or if AutoRemove failed).
    try {
      await container.remove({ force: false });
      console.log(`[ContainerManager] Removed container for run ${runId}`);
    } catch (rmErr: unknown) {
      const rmError = rmErr as { message?: string };
      // 404 = already gone (AutoRemove did its job), 409 = still running — both are fine to ignore
      if (!rmError.message?.includes('no such container') && !rmError.message?.includes('removal of container')) {
        console.warn(`[ContainerManager] Could not remove container for run ${runId}:`, rmError.message);
      }
    }
  }

  getContainer(runId: string): ContainerInfo | undefined {
    return this.containers.get(runId);
  }

  /**
   * Kill any running containers whose name matches a prefix pattern.
   *
   * Used on engine startup as a safety net to clean up Docker containers that
   * survived a restart but are not tracked in the in-memory session maps or the
   * database.  Typical pattern: `djinn-run-slack_` to catch orphaned Slack
   * conversation containers.
   *
   * @param namePrefix - Docker container name prefix to match (e.g. `djinn-run-slack_`)
   * @param excludeRunIds - Set of runIds that are actively managed and should NOT be killed
   * @returns Number of containers stopped
   */
  async killOrphanedContainersByPrefix(
    namePrefix: string,
    excludeRunIds?: Set<string>,
  ): Promise<number> {
    let stopped = 0;
    try {
      // List all running containers
      const containers = await this.docker.listContainers({ all: false });
      for (const info of containers) {
        // Docker container names are prefixed with '/'
        const name = (info.Names?.[0] ?? '').replace(/^\//, '');
        if (!name.startsWith(namePrefix)) continue;

        // Derive runId from the container name (strip the "djinn-run-" prefix)
        const runId = name.replace(/^djinn-run-/, '');
        if (excludeRunIds?.has(runId)) continue;

        console.log(`[ContainerManager] Killing orphaned container: ${name} (${info.Id.slice(0, 12)})`);
        try {
          const container = this.docker.getContainer(info.Id);
          await container.stop({ t: 5 });
          stopped++;
          // AutoRemove should clean it up; explicit remove as safety net
          try {
            await container.remove({ force: false });
          } catch {
            // Ignore — AutoRemove or already gone
          }
        } catch (err: any) {
          if (!err.message?.includes('not running')) {
            console.warn(`[ContainerManager] Failed to kill orphaned container ${name}:`, err.message);
          }
        }
      }
    } catch (err) {
      console.error('[ContainerManager] Error listing containers for orphan cleanup:', err);
    }
    return stopped;
  }
}
