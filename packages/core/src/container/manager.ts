import Docker from 'dockerode';
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
}

const DEFAULT_IMAGE = 'djinnbot/agent-runtime:latest';
const READY_TIMEOUT_MS = 30000;

// Resource defaults — callers can override via ContainerConfig
const DEFAULT_MEMORY_LIMIT = 2 * 1024 * 1024 * 1024;  // 2 GB
const DEFAULT_CPU_LIMIT = 2;                            // 2 vCPUs

export class ContainerManager {
  private docker: Docker;
  private containers = new Map<string, ContainerInfo>();

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

      // When running inside Docker (as engine does), we use named volumes
      // instead of bind mounts since bind mounts would reference paths
      // inside the engine container, not on the Docker host.
      //
      // UNIFIED VOLUME ARCHITECTURE:
      // - Single volume: djinnbot_djinnbot-data → /djinnbot-data
      // - All data lives within subdirectories of this volume:
      //   * /djinnbot-data/runs/         - run git worktrees
      //   * /djinnbot-data/workspaces/   - project git repositories
      //   * /djinnbot-data/vaults/       - agent ClawVault memories (central storage)
      //   * /djinnbot-data/sandboxes/    - agent home directories
      //
      // Why single volume?
      // We previously had separate volumes (runs-data, workspaces-data, sandboxes-data)
      // but mounting both a parent directory AND subdirectories as separate volumes
      // causes mount shadowing - the subdirectory mount hides the parent's contents.
      // This led to data inconsistency where the API saw different data than agents.
      //
      // Agent home directory structure (created by entrypoint cmd below):
      // /home/agent/                              <- Symlinked to /djinnbot-data/sandboxes/{agentId}
      // ├── .cache/qmd/                          <- Symlinked to /djinnbot-data/.cache/qmd (shared index)
      // ├── .config/                             <- Symlinked to /djinnbot-data/.config (qmd index.yml lives here)
      // ├── clawvault/
      // │   ├── {agentId}/                       <- Symlinked to /djinnbot-data/vaults/{agentId}  ← CLAWVAULT_PATH
      // │   └── shared/                          <- Symlinked to /djinnbot-data/vaults/shared
      // ├── project-workspace/                   <- Symlinked to /djinnbot-data/workspaces/{projectId} (if project run)
      // └── run-workspace/                       <- Symlinked to /djinnbot-data/runs/{runId} (the git worktree)
      //
      // run-workspace is always the git worktree for this specific run.
      // project-workspace is the full project repo (for history, cherry-pick, etc.) — only set for project runs.

      // Resolve which path maps to run-workspace inside the container.
      // Prefer the explicit runWorkspacePath; fall back to the legacy workspacePath field.
      const effectiveRunPath = runWorkspacePath ?? workspacePath;

      // Extract relative path from /data/... to use with djinnbot-data volume.
      // e.g. "/data/runs/run_xxx" → "runs/run_xxx"
      const runRelative = effectiveRunPath.replace('/data/', '');

      // Project workspace relative path (only used when projectWorkspacePath is provided).
      // e.g. "/data/workspaces/proj_xxx" → "workspaces/proj_xxx"
      const projectRelative = projectWorkspacePath ? projectWorkspacePath.replace('/data/', '') : null;

      const container = await this.docker.createContainer({
        Image: image,
        name: `djinn-run-${runId}`,
        Env: [
          `RUN_ID=${runId}`,
          `AGENT_ID=${agentId}`,
          `REDIS_URL=${process.env.REDIS_URL || 'redis://redis:6379'}`,
          `WORKSPACE_PATH=/home/agent/run-workspace`,
          // ClawVault path environment variables
          // These are consumed by agent-runtime/src/entrypoint.ts
          // CLAWVAULT_PATH points to the personal vault directly so that
          // `clawvault search` without --vault resolves the correct vault.
          `CLAWVAULT_PATH=/home/agent/clawvault/${agentId}`,
          `CLAWVAULT_PERSONAL=/home/agent/clawvault/${agentId}`,
          `CLAWVAULT_SHARED=/home/agent/clawvault/shared`,
          `HOME=/home/agent`,
          // Git identity — ensures commits made by the agent inside the container
          // are attributed to the agent rather than failing with "user not configured".
          `GIT_AUTHOR_NAME=${agentId}`,
          `GIT_AUTHOR_EMAIL=${agentId}@djinnbot.local`,
          `GIT_COMMITTER_NAME=djinnbot`,
          `GIT_COMMITTER_EMAIL=djinnbot@local`,
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
          // SECURITY NOTES:
          // ================
          // We mount the main djinnbot-data volume for agent access. Docker volumes
          // don't support true subpath isolation (unlike Kubernetes). This means:
          //
          // 1. /djinnbot-data contains ALL agent vaults and sandboxes - agents could
          //    theoretically access other agents' data by navigating to
          //    /djinnbot-data/vaults/{other-agent}/ or /djinnbot-data/sandboxes/{other-agent}/
          //
          // 2. We mitigate this by:
          //    a) Setting up symlinks so /vault, /shared, /home/agent point to correct paths
          //    b) NOT exposing /djinnbot-data in environment variables
          //    c) Running agents with limited permissions (non-root) - TODO
          //    d) Agents are expected to use symlinked paths, not raw volume paths
          //
          // 3. For TRUE isolation, we would need either:
          //    a) Run engine on host (not in Docker) with bind mounts to specific paths
          //    b) Use a read-only base + copy-on-write overlay per agent
          //    c) Use nsjail or gVisor for sandboxing
          //
          // Mount structure:
          // - djinnbot_djinnbot-data → /djinnbot-data (single unified volume)
          //
          // The entrypoint command creates symlinks to provide clean paths for agents:
          //   /workspace, /vault, /shared, /home/agent → subdirectories in /djinnbot-data
          Mounts: [
            // UNIFIED DATA VOLUME - contains everything:
            //   /djinnbot-data/sandboxes/{agentId}/          - agent home directories
            //   /djinnbot-data/vaults/{agentId}/             - ClawVault memories (central storage)
            //   /djinnbot-data/vaults/shared/                - shared team memories
            //   /djinnbot-data/workspaces/{projId}/          - project git repos
            //   /djinnbot-data/runs/{runId}/                 - run git worktrees
            //
            // Vaults are stored centrally at /djinnbot-data/vaults/ (for API/dashboard access)
            // and symlinked into each agent's home under /home/agent/clawvault/.
            //
            // NOTE: This gives agents access to ALL data (other agents' vaults, etc.)
            // Security isolation is soft - via symlinks and convention, not hard mounts.
            // For true isolation, we'd need nsjail, gVisor, or host-side bind mounts.
            {
              Type: 'volume',
              Source: 'djinnbot_djinnbot-data',
              Target: '/djinnbot-data',
              ReadOnly: false,
            },
          ],
          NetworkMode: 'djinnbot_djinnbot_default',
          Memory: memoryLimit ?? DEFAULT_MEMORY_LIMIT,
          NanoCpus: (cpuLimit ?? DEFAULT_CPU_LIMIT) * 1e9,
          AutoRemove: true,
        },
        // Set up unified agent home directory structure with symlinks.
        // Creates /home/agent with organized subdirectories for vaults and workspaces.
        // The agent's home directory is actually at /djinnbot-data/sandboxes/{agentId}
        // and contains symlinks to the central vault storage and workspace directories.
        Cmd: [
          'sh', '-c',
          // Exit immediately if any command fails (prevents starting in broken state)
          `set -e && ` +
          // Symlink /data → /djinnbot-data so git's absolute worktree paths (written by the
          // engine, which mounts the volume at /data) resolve correctly inside the container
          // (which mounts the same volume at /djinnbot-data).
          `ln -sfn /djinnbot-data /data && ` +
          // Create the sandbox directory structure (vault entries will be symlinks, not dirs)
          `mkdir -p /djinnbot-data/sandboxes/${agentId}/clawvault ` +
          `/djinnbot-data/sandboxes/${agentId}/project-workspace ` +
          `/djinnbot-data/sandboxes/${agentId}/run-workspace ` +
          `/djinnbot-data/sandboxes/${agentId}/task-workspaces && ` +
          // Ensure central vault directories and the run worktree directory exist
          `mkdir -p /djinnbot-data/vaults/${agentId} /djinnbot-data/vaults/shared /djinnbot-data/${runRelative} && ` +
          // Symlink agent home to sandbox directory (rm -rf first in case it exists as a directory)
          `rm -rf /home/agent && ln -sfn /djinnbot-data/sandboxes/${agentId} /home/agent && ` +
          // Symlink entire vault directories (not contents) - cleaner and ensures all files are accessible
          `rm -rf /home/agent/clawvault/${agentId} && ln -sfn /djinnbot-data/vaults/${agentId} /home/agent/clawvault/${agentId} && ` +
          `rm -rf /home/agent/clawvault/shared && ln -sfn /djinnbot-data/vaults/shared /home/agent/clawvault/shared && ` +
          // Symlink run-workspace → the run's git worktree (/djinnbot-data/runs/{runId})
          `rm -rf /home/agent/run-workspace && ln -sfn /djinnbot-data/${runRelative} /home/agent/run-workspace && ` +
          // Symlink project-workspace → the project's main git repo (only for project runs)
          (projectRelative
            ? `mkdir -p /djinnbot-data/${projectRelative} && rm -rf /home/agent/project-workspace && ln -sfn /djinnbot-data/${projectRelative} /home/agent/project-workspace && `
            : ``) +
          // Symlink the qmd index so agents share the same index as the engine
          // Engine stores index at /data/.cache/qmd = /djinnbot-data/.cache/qmd in containers
          `mkdir -p /home/agent/.cache /djinnbot-data/.cache/qmd && ` +
          `rm -rf /home/agent/.cache/qmd && ln -sfn /djinnbot-data/.cache/qmd /home/agent/.cache/qmd && ` +
          // Symlink .config so qmd can find its index.yml (collection registry)
          // qmd resolves config dir as ~/.config/qmd; the registry lives on the
          // shared volume at /djinnbot-data/.config
          `mkdir -p /djinnbot-data/.config && ` +
          `rm -rf /home/agent/.config && ln -sfn /djinnbot-data/.config /home/agent/.config && ` +
          // ── Git credential helper ───────────────────────────────────────────
          // Pipeline runs: engine injects credentials into the remote URL before push.
          // Pulse sessions: agent pushes directly from inside the container, so we
          // install a global git credential helper that calls the DjinnBot API at
          // push time for a fresh GitHub App token.
          //
          // The script is base64-encoded so it survives sh -c quoting intact.
          // API_URL and AGENT_ID are substituted here (build time) so the script
          // is self-contained once written to disk.
          (() => {
            const apiUrl = config.env?.DJINNBOT_API_URL || process.env.DJINNBOT_API_URL || 'http://api:8000';
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
          // ── End credential helper ────────────────────────────────────────────
          // Start the agent runtime
          `exec node /app/packages/agent-runtime/dist/entrypoint.js`
        ],
      });

      const info: ContainerInfo = {
        containerId: container.id,
        runId,
        status: 'created',
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
        console.log('[ContainerManager] Redis subscriber closed');
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
}
