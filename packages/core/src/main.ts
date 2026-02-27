#!/usr/bin/env node
/**
 * DjinnBot Core Engine Worker
 * 
 * This is the main worker process that:
 * 1. Instantiates the DjinnBot orchestrator
 * 2. Loads pipeline definitions from YAML files
 * 3. Listens for new run notifications from the API server via Redis
 * 4. Executes pipeline runs when triggered
 */

import { DjinnBot, type DjinnBotConfig } from './djinnbot.js';
import { PiMonoRunner } from './runtime/pi-mono-runner.js';
import { MockRunner } from './runtime/mock-runner.js';
import { Redis } from 'ioredis';
import { ChatSessionManager } from './chat/chat-session-manager.js';
import { ChatListener } from './chat/chat-listener.js';
import { VaultEmbedWatcher } from './memory/vault-embed-watcher.js';
import { McpoManager } from './mcp/mcpo-manager.js';
import { ContainerLogStreamer } from './container/log-streamer.js';
import { AgentLifecycleTracker } from './lifecycle/agent-lifecycle-tracker.js';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { PROVIDER_ENV_MAP } from './constants.js';
import { parseModelString } from './runtime/model-resolver.js';
import { authFetch } from './api/auth-fetch.js';
import { ensureAgentKeys } from './api/agent-key-manager.js';
import { SwarmSessionManager, type SwarmSessionDeps } from './runtime/swarm-session.js';
import { type SwarmRequest, type SwarmProgressEvent, swarmChannel, swarmStateKey } from './runtime/swarm-types.js';
import { mountJuiceFS, ensureJfsDirs } from './container/juicefs.js';

const execFileAsync = promisify(execFile);

// Configuration from environment variables
const CONFIG: DjinnBotConfig = {
  redisUrl: process.env.REDIS_URL || 'redis://localhost:6379',
  databasePath: process.env.DATABASE_PATH || './data/djinnbot.db',
  dataDir: process.env.DATA_DIR || './data',
  agentsDir: process.env.AGENTS_DIR || './agents',
  pipelinesDir: process.env.PIPELINES_DIR || './pipelines',
  agentRunner: process.env.MOCK_RUNNER === 'true' 
    ? new MockRunner() 
    : undefined,  // Let DjinnBot create runner with event callbacks
  useApiStore: process.env.USE_API_STORE === 'true',
  apiUrl: process.env.DJINNBOT_API_URL || 'http://api:8000',
  useContainerRunner: process.env.USE_CONTAINER_RUNNER === 'true',
};

const REDIS_STREAM = 'djinnbot:events:new_runs';
const SWARM_STREAM = 'djinnbot:events:new_swarms';
const CONSUMER_GROUP = 'djinnbot-engine';
const CONSUMER_NAME = `worker-${process.pid}`;

let djinnBot: DjinnBot | null = null;
let redisClient: Redis | null = null;
let isShuttingDown = false;
let globalRedis: Redis | null = null;
/** Dedicated Redis for non-blocking writes (SETEX) triggered by global event
 *  handlers — isolated from `redisClient` which is blocked by XREADGROUP. */
let opsRedis: Redis | null = null;
let chatSessionManager: ChatSessionManager | null = null;
let chatListener: ChatListener | null = null;
let vaultEmbedWatcher: VaultEmbedWatcher | null = null;
let graphRebuildSub: Redis | null = null;
let mcpoManager: McpoManager | null = null;
let containerLogStreamer: ContainerLogStreamer | null = null;
let swarmManager: SwarmSessionManager | null = null;
/** Lifecycle tracker for swarm activity feed events. Initialized in main(). */
let swarmLifecycle: AgentLifecycleTracker | null = null;
/** Maps swarmId → agentId for activity feed attribution. */
const swarmAgentMap = new Map<string, string>();

const VAULTS_DIR = process.env.VAULTS_DIR || '/data/vaults';
const CLAWVAULT_BIN = '/usr/local/bin/clawvault';
const GRAPH_REBUILD_CHANNEL = 'djinnbot:graph:rebuild';
const GRAPH_REBUILT_CHANNEL = 'djinnbot:graph:rebuilt';

/**
 * Initialize Redis client for listening to new run events
 */
async function initRedis(): Promise<Redis> {
  const client = new Redis(CONFIG.redisUrl);
  
  // Create a second client for global events (blocking reads need separate connection)
  globalRedis = new Redis(CONFIG.redisUrl);
  
  // Dedicated connection for non-blocking writes (SETEX) triggered by global
  // event handlers — `redisClient` is blocked by XREADGROUP BLOCK 5000 almost
  // continuously, so any SETEX/PUBLISH on it would be delayed up to 5 seconds.
  opsRedis = new Redis(CONFIG.redisUrl);
  
  client.on('error', (err) => {
    console.error('[Engine] Redis client error:', err);
  });
  
  console.log(`[Engine] Connected to Redis at ${CONFIG.redisUrl}`);
  
  // Create consumer groups if they don't exist
  try {
    await client.xgroup('CREATE', REDIS_STREAM, CONSUMER_GROUP, '0', 'MKSTREAM');
    console.log(`[Engine] Created consumer group: ${CONSUMER_GROUP} on ${REDIS_STREAM}`);
  } catch (err: any) {
    if (err.message?.includes('BUSYGROUP')) {
      console.log(`[Engine] Consumer group already exists: ${CONSUMER_GROUP} on ${REDIS_STREAM}`);
    } else {
      throw err;
    }
  }

  try {
    await client.xgroup('CREATE', SWARM_STREAM, CONSUMER_GROUP, '0', 'MKSTREAM');
    console.log(`[Engine] Created consumer group: ${CONSUMER_GROUP} on ${SWARM_STREAM}`);
  } catch (err: any) {
    if (err.message?.includes('BUSYGROUP')) {
      console.log(`[Engine] Consumer group already exists: ${CONSUMER_GROUP} on ${SWARM_STREAM}`);
    } else {
      throw err;
    }
  }
  
  return client;
}

/**
 * Process a new run signal from Redis
 * Engine fetches full run data via API instead of receiving it from Redis
 */
async function processNewRun(data: { event: string; run_id: string; pipeline_id: string }): Promise<void> {
  if (!djinnBot) {
    console.error('[Engine] DjinnBot not initialized');
    return;
  }
  
  const { run_id: runId, pipeline_id: pipelineId } = data;
  
  console.log(`[Engine] Processing new run signal: ${runId}`);
  
  try {
    // Fetch full run data from API (ApiStore handles this)
    const run = await djinnBot.getStore().getRun(runId);
    if (!run) {
      console.error(`[Engine] Run ${runId} not found in API`);
      return;
    }
    
    // Resume the run (taskDescription is already in the run record)
    await djinnBot.resumeRun(runId);
    console.log(`[Engine] Run ${runId} started successfully`);
  } catch (err) {
    console.error(`[Engine] Error processing run ${runId}:`, err);
  }
}

/**
 * Listen for new run events from Redis stream
 */
async function listenForNewRuns(): Promise<void> {
  if (!redisClient) {
    throw new Error('Redis client not initialized');
  }
  
  console.log(`[Engine] Listening for new runs on stream: ${REDIS_STREAM}`);
  
  while (!isShuttingDown) {
    try {
      // Read from the stream using consumer group
      const messages: any = await redisClient.xreadgroup(
        'GROUP',
        CONSUMER_GROUP,
        CONSUMER_NAME,
        'COUNT',
        10,
        'BLOCK',
        5000, // Block for 5 seconds
        'STREAMS',
        REDIS_STREAM,
        '>' // Only new messages
      );
      
      if (!messages || messages.length === 0) {
        continue;
      }
      
      // Parse ioredis xreadgroup response format
      // messages = [[streamName, [[messageId, [field, value, ...]]]]]
      for (const streamData of messages) {
        const [streamName, streamMessages] = streamData;
        
        for (const messageData of streamMessages) {
          const [id, fields] = messageData;
          
          // Convert fields array to object
          const data: Record<string, string> = {};
          for (let i = 0; i < fields.length; i += 2) {
            data[fields[i]] = fields[i + 1];
          }
          
          // Parse the signal
          const runSignal = {
            event: data.event?.toString() || 'run:new',
            run_id: data.run_id?.toString() || '',
            pipeline_id: data.pipeline_id?.toString() || '',
          };
          
          if (!runSignal.run_id) {
            console.warn('[Engine] Received run signal without run_id, skipping');
            await redisClient.xack(REDIS_STREAM, CONSUMER_GROUP, id);
            continue;
          }
          
          // Process the new run signal (fetches full data from API)
          await processNewRun(runSignal);
          
          // Acknowledge the message
          await redisClient.xack(REDIS_STREAM, CONSUMER_GROUP, id);
        }
      }
    } catch (err) {
      if (isShuttingDown) {
        break;
      }
      console.error('[Engine] Error reading from stream:', err);
      // Wait a bit before retrying
      await new Promise(resolve => setTimeout(resolve, 1000));
    }
  }
  
  console.log('[Engine] Stopped listening for new runs');
}

const GLOBAL_STREAM = 'djinnbot:events:global';

/**
 * Listen for global events (pulse triggers, etc.)
 */
async function listenForGlobalEvents(): Promise<void> {
  if (!globalRedis) return;
  
  console.log('[Engine] Listening for global events on stream:', GLOBAL_STREAM);
  
  // Track our position in the stream
  let lastId = '$'; // Start from new messages only
  
  while (!isShuttingDown) {
    try {
      // Use xread (not xreadgroup) for simpler pub/sub style
      const messages = await globalRedis.xread(
        'COUNT', 10,
        'BLOCK', 5000,
        'STREAMS', GLOBAL_STREAM,
        lastId
      );
      
      if (!messages || messages.length === 0) {
        continue;
      }
      
      for (const [streamName, streamMessages] of messages) {
        for (const [id, fields] of streamMessages) {
          lastId = id; // Update position
          
          // Parse the event
          const eventData: Record<string, string> = {};
          for (let i = 0; i < fields.length; i += 2) {
            eventData[fields[i]] = fields[i + 1];
          }
          
          // Handle the event
          if (eventData.data) {
            try {
              const event = JSON.parse(eventData.data);
              await handleGlobalEvent(event);
            } catch (e) {
              console.warn('[Engine] Failed to parse global event:', e);
            }
          }
        }
      }
    } catch (err) {
      if (isShuttingDown) break;
      console.error('[Engine] Error reading global events:', err);
      await new Promise(resolve => setTimeout(resolve, 1000));
    }
  }
}

// ── Swarm Executor System ──────────────────────────────────────────────────

/**
 * Initialize the SwarmSessionManager with dependencies wired to the API.
 */
function initSwarmManager(): SwarmSessionManager {
  const apiUrl = CONFIG.apiUrl || 'http://api:8000';

  // Dedicated Redis for swarm state persistence and progress publishing
  const swarmRedis = new Redis(CONFIG.redisUrl);

  // Initialize the module-level lifecycle tracker (if not already)
  if (!swarmLifecycle) {
    swarmLifecycle = new AgentLifecycleTracker({ redis: new Redis(CONFIG.redisUrl) });
  }

  const deps: SwarmSessionDeps = {
    spawnExecutor: async (params) => {
      const res = await authFetch(`${apiUrl}/v1/internal/spawn-executor`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          agent_id: params.agentId,
          project_id: params.projectId,
          task_id: params.taskId,
          execution_prompt: params.executionPrompt,
          deviation_rules: params.deviationRules,
          model_override: params.modelOverride,
          timeout_seconds: params.timeoutSeconds,
          swarm_task_key: params.swarmTaskKey,
        }),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({})) as { detail?: string };
        throw new Error(err.detail || `Spawn failed: ${res.status}`);
      }
      const data = await res.json() as { run_id: string };
      return data.run_id;
    },

    pollRun: async (runId) => {
      const res = await authFetch(`${apiUrl}/v1/runs/${runId}`);
      if (!res.ok) {
        throw new Error(`Poll failed: ${res.status}`);
      }
      const data = await res.json() as {
        status: string;
        outputs?: Record<string, string>;
        error?: string;
      };
      return data;
    },

    publishProgress: async (swarmId, event) => {
      await swarmRedis.publish(swarmChannel(swarmId), JSON.stringify(event));

      // Publish key swarm milestones to the agent's activity feed
      const agentId = swarmAgentMap.get(swarmId);
      if (!agentId) return;

      if (event.type === 'swarm:task_started' || event.type === 'swarm:task_completed' || event.type === 'swarm:task_failed') {
        // Individual task events — too noisy for the feed, skip
        return;
      }

      if (event.type === 'swarm:completed' || event.type === 'swarm:failed') {
        const summary = 'summary' in event ? event.summary : undefined;
        if (swarmLifecycle) {
          await swarmLifecycle.addTimelineEvent(agentId, {
            id: `swarm_done_${swarmId}`,
            timestamp: event.timestamp,
            type: 'swarm_completed' as any,
            data: {
              swarmId,
              status: event.type === 'swarm:completed' ? 'success' : 'failed',
              totalTasks: summary?.totalTasks,
              completed: summary?.completed,
              failed: summary?.failed,
              skipped: summary?.skipped,
              durationMs: summary?.totalDurationMs,
            },
          });
        }
        // Clean up map entry
        swarmAgentMap.delete(swarmId);
      }
    },

    persistState: async (swarmId, state) => {
      // Convert camelCase state to snake_case for the Python API layer and
      // agent-runtime tool, which both expect snake_case field names.
      const snakeState = {
        swarm_id: state.swarmId,
        agent_id: state.agentId,
        status: state.status,
        tasks: state.tasks.map(t => ({
          key: t.key,
          title: t.title,
          task_id: t.taskId,
          project_id: t.projectId,
          status: t.status,
          run_id: t.runId,
          dependencies: t.dependencies,
          outputs: t.outputs,
          error: t.error,
          started_at: t.startedAt,
          completed_at: t.completedAt,
        })),
        max_concurrent: state.maxConcurrent,
        active_count: state.activeCount,
        completed_count: state.completedCount,
        failed_count: state.failedCount,
        total_count: state.totalCount,
        created_at: state.createdAt,
        updated_at: state.updatedAt,
      };
      // Persist for 1 hour (polling fallback + debugging)
      await swarmRedis.setex(swarmStateKey(swarmId), 3600, JSON.stringify(snakeState));
    },

    // Post-swarm branch integration: merge per-executor branches into canonical task branch
    mergeExecutorBranches: async (params) => {
      if (!djinnBot) throw new Error('DjinnBot not initialized');
      const wm = djinnBot.getWorkspaceManager();
      if (!wm.supportsBranchIntegration()) {
        throw new Error(`Workspace manager '${wm.type}' does not support branch integration`);
      }
      return wm.asBranchIntegrationProvider!().mergeBranches(params.projectId, params.targetBranch, params.executorBranches);
    },

    // Post-swarm PR creation (uses the API's existing PR endpoint)
    openPullRequest: async (params) => {
      try {
        const res = await authFetch(`${apiUrl}/v1/projects/${params.projectId}/tasks/${params.taskId}/pull-request`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            agentId: 'djinnbot',
            title: params.title,
            body: params.body,
            draft: false,
          }),
        });
        if (!res.ok) return null;
        const data = await res.json() as { pr_number: number; pr_url: string };
        return data;
      } catch {
        return null;
      }
    },
  };

  return new SwarmSessionManager(deps);
}

/**
 * Listen for new swarm dispatch events from Redis stream.
 * Runs in the background alongside listenForNewRuns.
 */
async function listenForSwarmEvents(): Promise<void> {
  if (!opsRedis) return;

  // Dedicated Redis connections — stream reader blocks on XREADGROUP,
  // cancel subscriber uses pub/sub. Both need separate connections.
  const swarmRedis = new Redis(CONFIG.redisUrl);
  const cancelSub = new Redis(CONFIG.redisUrl);

  console.log(`[Engine] Listening for swarm events on stream: ${SWARM_STREAM}`);

  // Subscribe to cancel commands using pattern matching.
  // The server publishes to djinnbot:swarm:{swarmId}:control
  cancelSub.on('pmessage', (_pattern: string, channel: string, message: string) => {
    const match = channel.match(/^djinnbot:swarm:(.+):control$/);
    if (!match) return;
    const swarmId = match[1];

    try {
      const data = JSON.parse(message);
      if (data.action === 'cancel' && swarmManager) {
        console.log(`[Engine] Received cancel command for swarm ${swarmId}`);
        swarmManager.cancelSwarm(swarmId).catch(err => {
          console.error(`[Engine] Failed to cancel swarm ${swarmId}:`, err);
        });
      }
    } catch {
      // Ignore malformed messages
    }
  });

  await cancelSub.psubscribe('djinnbot:swarm:*:control');
  console.log('[Engine] Subscribed to swarm cancel commands (pattern: djinnbot:swarm:*:control)');

  while (!isShuttingDown) {
    try {
      const messages: any = await swarmRedis.xreadgroup(
        'GROUP', CONSUMER_GROUP, CONSUMER_NAME,
        'COUNT', 5,
        'BLOCK', 5000,
        'STREAMS', SWARM_STREAM, '>',
      );

      if (!messages || messages.length === 0) continue;

      for (const streamData of messages) {
        const [, streamMessages] = streamData;

        for (const messageData of streamMessages) {
          const [id, fields] = messageData;

          const data: Record<string, string> = {};
          for (let i = 0; i < fields.length; i += 2) {
            data[fields[i]] = fields[i + 1];
          }

          if (data.payload) {
            try {
              const payload = JSON.parse(data.payload) as {
                swarm_id: string;
                agent_id: string;
                tasks: any[];
                maxConcurrent?: number;
                deviationRules?: string;
                globalTimeoutSeconds?: number;
              };

              console.log(`[Engine] Processing new swarm: ${payload.swarm_id} (${payload.tasks.length} tasks)`);

              if (swarmManager) {
                const request: SwarmRequest = {
                  agentId: payload.agent_id,
                  tasks: payload.tasks,
                  maxConcurrent: payload.maxConcurrent,
                  deviationRules: payload.deviationRules,
                  globalTimeoutSeconds: payload.globalTimeoutSeconds,
                };

                await swarmManager.startSwarm(payload.swarm_id, request);
                console.log(`[Engine] Swarm ${payload.swarm_id} started`);

                // Track for activity feed and publish swarm_started event
                swarmAgentMap.set(payload.swarm_id, payload.agent_id);
                if (swarmLifecycle) {
                  await swarmLifecycle.addTimelineEvent(payload.agent_id, {
                    id: `swarm_start_${payload.swarm_id}`,
                    timestamp: Date.now(),
                    type: 'swarm_started' as any,
                    data: {
                      swarmId: payload.swarm_id,
                      totalTasks: payload.tasks.length,
                      maxConcurrent: payload.maxConcurrent ?? 3,
                    },
                  });
                }
              } else {
                console.error(`[Engine] SwarmSessionManager not initialized`);
              }
            } catch (err) {
              console.error(`[Engine] Error processing swarm:`, err);
            }
          }

          await swarmRedis.xack(SWARM_STREAM, CONSUMER_GROUP, id);
        }
      }
    } catch (err) {
      if (isShuttingDown) break;
      console.error('[Engine] Error reading swarm events:', err);
      await new Promise(resolve => setTimeout(resolve, 1000));
    }
  }

  await cancelSub.punsubscribe('djinnbot:swarm:*:control').catch(() => {});
  await cancelSub.quit().catch(() => {});
  await swarmRedis.quit().catch(() => {});
  console.log('[Engine] Stopped listening for swarm events');
}

/**
 * Perform a system update: pull new images and recreate containers.
 *
 * The engine container has /var/run/docker.sock mounted and the Docker CLI
 * installed (see Dockerfile.engine).  The compose file and .env are bind-
 * mounted at /compose inside the container (see docker-compose.ghcr.yml).
 *
 * Steps mirror the CLI `djinn update` command:
 *   1. Pull compose service images (`docker compose pull`)
 *   2. Pull the agent-runtime image (spawned dynamically, not in compose)
 *   3. Recreate all containers (`docker compose up -d --force-recreate`)
 *
 * The engine container itself will be replaced during step 3 — Docker
 * handles this gracefully.
 */
async function handleSystemUpdate(targetVersion: string): Promise<void> {
  const composeDir = '/compose';
  const agentRuntimeImage = `ghcr.io/basedatum/djinnbot/agent-runtime:${targetVersion}`;

  // Publish progress via Redis
  const publishProgress = async (stage: string, message: string, error?: boolean) => {
    if (opsRedis) {
      const event = {
        type: 'SYSTEM_UPDATE_PROGRESS',
        stage,
        message,
        error: !!error,
        timestamp: Date.now(),
      };
      await opsRedis.xadd('djinnbot:events:global', '*', 'data', JSON.stringify(event)).catch(() => {});
    }
    if (error) {
      console.error(`[Engine] Update ${stage}: ${message}`);
    } else {
      console.log(`[Engine] Update ${stage}: ${message}`);
    }
  };

  try {
    // Step 0: Update DJINNBOT_VERSION in .env if target is a specific version
    if (targetVersion !== 'latest') {
      const { readFile, writeFile } = await import('node:fs/promises');
      const envPath = `${composeDir}/.env`;
      try {
        let envContent = await readFile(envPath, 'utf-8');
        // Replace or add DJINNBOT_VERSION
        if (/^DJINNBOT_VERSION=/m.test(envContent)) {
          envContent = envContent.replace(
            /^DJINNBOT_VERSION=.*$/m,
            `DJINNBOT_VERSION=${targetVersion}`
          );
        } else {
          envContent += `\nDJINNBOT_VERSION=${targetVersion}\n`;
        }
        await writeFile(envPath, envContent);
        await publishProgress('env', `Set DJINNBOT_VERSION=${targetVersion}`);
      } catch (err) {
        await publishProgress('env', `Could not update .env: ${err}`, true);
        // Non-fatal — compose may still use the default
      }
    }

    // Step 1: Pull compose images
    // The compose file is docker-compose.ghcr.yml (not the default name),
    // and the project name must match the host's compose project so the
    // engine finds the correct running containers.
    const composeArgs = [
      'compose',
      '-f', `${composeDir}/docker-compose.ghcr.yml`,
      '--env-file', `${composeDir}/.env`,
    ];
    await publishProgress('pull', 'Pulling compose service images...');
    await execFileAsync('docker', [...composeArgs, 'pull'], {
      cwd: composeDir,
      timeout: 300_000, // 5 min
    });
    await publishProgress('pull', 'Compose images pulled');

    // Step 2: Pull agent-runtime image (not in compose)
    await publishProgress('pull-runtime', `Pulling agent-runtime: ${agentRuntimeImage}`);
    try {
      await execFileAsync('docker', ['pull', agentRuntimeImage], { timeout: 300_000 });
      await publishProgress('pull-runtime', 'Agent-runtime image pulled');
    } catch (err) {
      await publishProgress('pull-runtime', `Agent-runtime pull failed (non-fatal): ${err}`, true);
    }

    // Step 3: Recreate containers
    await publishProgress('recreate', 'Recreating containers...');
    // Use spawn instead of execFile for this — the engine container will die mid-execution
    // but the new one will start. Fire-and-forget with a short delay to let the progress
    // event propagate.
    const { spawn } = await import('node:child_process');
    spawn('docker', [...composeArgs, 'up', '-d', '--force-recreate'], {
      cwd: composeDir,
      stdio: 'ignore',
      detached: true,
    }).unref();

    await publishProgress('recreate', 'Container recreation started — system will restart momentarily');
  } catch (err) {
    await publishProgress('error', `Update failed: ${err}`, true);
  }
}

/**
 * Run the @djinnbot/code-graph indexing pipeline for a project.
 *
 * The pipeline scans the project workspace, parses ASTs with Tree-sitter,
 * resolves imports/calls/heritage, detects communities and execution flows,
 * and persists the graph to KuzuDB.
 *
 * Results and progress are published to Redis keys that the API server polls.
 */
async function handleCodeGraphIndex(projectId: string, jobId?: string): Promise<void> {
  const workspacesDir = process.env.WORKSPACES_DIR || '/data/workspaces';
  const repoPath = `${workspacesDir}/${projectId}`;
  const dbPath = `${workspacesDir}/${projectId}/.code-graph.kuzu`;

  const resultKey = `djinnbot:code-graph:result:${projectId}`;
  const progressKey = `djinnbot:code-graph:progress:${projectId}`;

  try {
    // Dynamic import of the code-graph package
    const { runPipeline } = await import('@djinnbot/code-graph') as any;

    const result = await runPipeline(repoPath, dbPath, (progress: any) => {
      // Publish progress to Redis so the API can poll it
      if (opsRedis) {
        opsRedis.setex(progressKey, 120, JSON.stringify({
          phase: progress.phase,
          percent: progress.percent,
          message: progress.message,
        })).catch(() => {});
      }
    });

    // Publish success result
    if (opsRedis) {
      await opsRedis.setex(resultKey, 600, JSON.stringify({
        nodeCount: result.nodeCount,
        relationshipCount: result.relationshipCount,
        communityCount: result.communityCount,
        processCount: result.processCount,
      }));
      await opsRedis.del(progressKey);
    }

    console.log(
      `[Engine] Code graph indexed for ${projectId}: ` +
      `${result.nodeCount} nodes, ${result.relationshipCount} edges, ` +
      `${result.communityCount} communities, ${result.processCount} processes`
    );
  } catch (err: any) {
    console.error(`[Engine] Code graph indexing error for ${projectId}:`, err);
    if (opsRedis) {
      await opsRedis.setex(resultKey, 600, JSON.stringify({
        error: err?.message || String(err),
      }));
      await opsRedis.del(progressKey);
    }
  }
}

/**
 * Handle a global event
 */
async function handleGlobalEvent(event: { type: string; agentId?: string; [key: string]: any }): Promise<void> {
  switch (event.type) {
    case 'PULSE_TRIGGERED':
      if (event.agentId && djinnBot) {
        console.log(`[Engine] Processing manual pulse trigger for ${event.agentId}`);
        const result = await djinnBot.triggerPulse(event.agentId);
        console.log(`[Engine] Pulse result for ${event.agentId}:`, result);
        
        // Publish result back to Redis for API to read
        if (opsRedis) {
          const resultKey = `djinnbot:agent:${event.agentId}:pulse:result`;
          await opsRedis.setex(resultKey, 60, JSON.stringify({
            ...result,
            completedAt: Date.now(),
          }));
        }
      }
      break;
    
    // ── Task workspace lifecycle ─────────────────────────────────────────────
    // Python API publishes these when an agent claims a task (create) or when
    // a task's PR is merged/closed (remove).  The engine creates/removes the
    // worktree in the agent's persistent sandbox so the agent can push with
    // GitHub App credentials.
    case 'TASK_WORKSPACE_REQUESTED': {
      const { agentId, projectId, taskId, taskBranch } = event;
      if (!agentId || !projectId || !taskId || !taskBranch || !djinnBot) break;
      console.log(`[Engine] Creating task worktree for ${agentId}/${taskId} on ${taskBranch}`);
      try {
        const wm = djinnBot.getWorkspaceManager();
        if (!wm.supportsTaskWorkspaces()) {
          throw new Error(`Workspace manager '${wm.type}' does not support task workspaces`);
        }
        const taskWm = wm.asTaskWorkspaceProvider!();
        const result = await taskWm.createTaskWorkspace(agentId, projectId, taskId, { taskBranch });
        // Publish result so Python API can unblock the waiting HTTP response
        if (opsRedis) {
          await opsRedis.setex(
            `djinnbot:workspace:${agentId}:${taskId}`,
            300, // 5 min TTL — enough for the HTTP response to read it
            JSON.stringify({ success: true, worktreePath: result.workspacePath, branch: result.metadata?.branch, alreadyExists: result.alreadyExists }),
          );
        }
        console.log(`[Engine] Task workspace ready at ${result.workspacePath}`);
      } catch (err) {
        console.error(`[Engine] Failed to create task worktree for ${agentId}/${taskId}:`, err);
        if (opsRedis) {
          await opsRedis.setex(
            `djinnbot:workspace:${agentId}:${taskId}`,
            300,
            JSON.stringify({ success: false, error: String(err) }),
          );
        }
      }
      break;
    }

    case 'TASK_WORKSPACE_REMOVE_REQUESTED': {
      const { agentId, projectId, taskId } = event;
      if (!agentId || !projectId || !taskId || !djinnBot) break;
      console.log(`[Engine] Removing task worktree for ${agentId}/${taskId}`);
      try {
        const wm = djinnBot.getWorkspaceManager();
        if (wm.supportsTaskWorkspaces()) {
          wm.asTaskWorkspaceProvider!().removeTaskWorkspace(agentId, projectId, taskId);
        }
      } catch (err) {
        console.error(`[Engine] Failed to remove task worktree for ${agentId}/${taskId}:`, err);
      }
      break;
    }

    // ── MCP / mcpo events ────────────────────────────────────────────────────
    case 'MCP_RESTART_REQUESTED':
      if (mcpoManager) {
        mcpoManager.handleRestartRequest().catch((err) =>
          console.error('[Engine] McpoManager restart error:', err)
        );
      }
      break;

    // ── System update ──────────────────────────────────────────────────────
    case 'SYSTEM_UPDATE_REQUESTED': {
      const targetVersion = event.targetVersion || 'latest';
      console.log(`[Engine] System update requested → ${targetVersion}`);
      handleSystemUpdate(targetVersion).catch((err) =>
        console.error('[Engine] System update failed:', err)
      );
      break;
    }

    // ── Code Knowledge Graph indexing ──────────────────────────────────────
    case 'CODE_GRAPH_INDEX_REQUESTED': {
      const { projectId, jobId } = event;
      if (!projectId) break;
      console.log(`[Engine] Code graph index requested for project ${projectId} (job ${jobId})`);
      handleCodeGraphIndex(projectId, jobId).catch((err) =>
        console.error(`[Engine] Code graph indexing failed for ${projectId}:`, err)
      );
      break;
    }

    // Informational events from API - engine doesn't need to process these
    case 'PROJECT_CREATED':
    case 'TASK_CREATED':
    case 'TASK_UPDATED':
    case 'TASK_EXECUTION_STARTED':
    case 'RUN_CREATED':
    case 'RUN_UPDATED':
    case 'RUN_STATUS_CHANGED':
    case 'RUN_DELETED':
    case 'RUNS_BULK_DELETED':
    case 'STEP_UPDATED':
    case 'STEP_FAILED':
    case 'PROJECT_REPOSITORY_UPDATED':
    case 'TASK_PR_OPENED':
    case 'TASK_CLAIMED':
    // Onboarding informational events — handled by dashboard SSE, not engine
    case 'ONBOARDING_CONTEXT_UPDATED':
    case 'ONBOARDING_HANDOFF':
    case 'ONBOARDING_COMPLETED':
      // These events are for dashboard SSE updates, not engine processing
      break;
      
    default:
      console.log('[Engine] Unknown global event type:', event.type);
  }
}

/**
 * Graceful shutdown handler
 */
async function shutdown(signal: string): Promise<void> {
  if (isShuttingDown) {
    return;
  }
  
  isShuttingDown = true;
  console.log(`[Engine] Received ${signal}, shutting down gracefully...`);
  
  try {
    // Stop chat listener
    if (chatListener) {
      console.log('[Engine] Stopping chat listener...');
      await chatListener.stop();
    }
    
    // Shutdown chat session manager
    if (chatSessionManager) {
      console.log('[Engine] Shutting down chat session manager...');
      await chatSessionManager.shutdown();
    }
    
    // Shutdown DjinnBot (stops executor, engine, Telegram bridge, etc.)
    if (djinnBot) {
      await djinnBot.shutdown();
    }
    
    // Stop MCP manager
    if (mcpoManager) {
      mcpoManager.stop();
    }

    // Stop container log streamer
    if (containerLogStreamer) {
      await containerLogStreamer.stop();
    }

    // Stop vault embed watcher
    if (vaultEmbedWatcher) {
      await vaultEmbedWatcher.stop();
    }

    // Stop graph rebuild subscriber
    if (graphRebuildSub) {
      graphRebuildSub.disconnect();
    }

    // Cancel pending graph rebuild timers
    for (const timer of graphRebuildTimers.values()) {
      clearTimeout(timer);
    }

    // Close Redis connections
    if (redisClient) {
      redisClient.disconnect();
    }
    if (globalRedis) {
      globalRedis.disconnect();
    }
    if (opsRedis) {
      opsRedis.disconnect();
    }
    
    console.log('[Engine] Shutdown complete');
    process.exit(0);
  } catch (err) {
    console.error('[Engine] Error during shutdown:', err);
    process.exit(1);
  }
}

/**
 * Run `clawvault graph --refresh` for the given agent vault.
 * Debounced per-agent so rapid dashboard saves don't stack up rebuilds.
 *
 * The shared vault uses a much longer debounce (15s) because during
 * onboarding multiple agents write shared memories in quick succession
 * and the graph rebuild is expensive. Personal vaults use a shorter
 * debounce (3s) since writes are less frequent.
 */
const graphRebuildTimers = new Map<string, ReturnType<typeof setTimeout>>();
const GRAPH_REBUILD_DEBOUNCE_MS = 3_000;
const GRAPH_REBUILD_DEBOUNCE_SHARED_MS = 15_000;

async function rebuildGraphIndex(agentId: string): Promise<void> {
  const { join } = await import('node:path');
  const vaultPath = join(VAULTS_DIR, agentId);
  console.log(`[Engine] Rebuilding graph index for vault: ${agentId}`);
  try {
    await execFileAsync(CLAWVAULT_BIN, ['graph', '--refresh', '--vault', vaultPath], {
      timeout: 30_000,
    });
    console.log(`[Engine] Graph index rebuilt for ${agentId}`);
    // Notify the API server that graph-index.json has been updated so it can
    // broadcast fresh data to WebSocket clients immediately.
    if (opsRedis) {
      try {
        await opsRedis.publish(
          GRAPH_REBUILT_CHANNEL,
          JSON.stringify({ agent_id: agentId }),
        );
      } catch {
        // Non-fatal — the file-polling fallback will eventually pick it up
      }
    }
  } catch (err: any) {
    console.error(`[Engine] clawvault graph rebuild failed for ${agentId}:`, err.message);
  }
}

function scheduleGraphRebuild(agentId: string): void {
  const existing = graphRebuildTimers.get(agentId);
  if (existing) clearTimeout(existing);
  const debounceMs = agentId === 'shared'
    ? GRAPH_REBUILD_DEBOUNCE_SHARED_MS
    : GRAPH_REBUILD_DEBOUNCE_MS;
  const timer = setTimeout(() => {
    graphRebuildTimers.delete(agentId);
    rebuildGraphIndex(agentId).catch((err) =>
      console.error(`[Engine] Graph rebuild error for ${agentId}:`, err)
    );
  }, debounceMs);
  graphRebuildTimers.set(agentId, timer);
}

/**
 * Subscribe to graph rebuild requests published by the API server
 * (triggered when the dashboard writes a link or the user clicks Rebuild).
 */
async function startGraphRebuildSubscriber(redisUrl: string): Promise<void> {
  graphRebuildSub = new Redis(redisUrl, { lazyConnect: true });
  graphRebuildSub.on('error', (err) =>
    console.error('[Engine] graphRebuildSub Redis error:', err.message)
  );
  await graphRebuildSub.connect();
  await graphRebuildSub.subscribe(GRAPH_REBUILD_CHANNEL);
  graphRebuildSub.on('message', (channel, message) => {
    if (channel !== GRAPH_REBUILD_CHANNEL) return;
    try {
      const { agent_id: agentId } = JSON.parse(message) as { agent_id: string };
      if (agentId) scheduleGraphRebuild(agentId);
    } catch (err) {
      console.error('[Engine] Failed to parse graph rebuild message:', err);
    }
  });
  console.log(`[Engine] Listening for graph rebuild requests on ${GRAPH_REBUILD_CHANNEL}`);
}

// ─── Slack credential sync ────────────────────────────────────────────────────

/**
 * For every agent that has channel YAML files ({channel}.yml) with env var
 * references, resolve the tokens from process.env and upsert them into the
 * DB via the channels API.
 *
 * Strategy: read the existing DB state first. Only write a token if:
 *   - the env var is present in process.env, AND
 *   - the DB does not already have a stored token for that agent+channel
 *     (i.e. never clobber tokens that the user has set through the dashboard).
 *
 * This mirrors syncProviderApiKeysToDb() for model providers.
 */
async function syncChannelCredentialsToDb(): Promise<void> {
  const apiBaseUrl = process.env.DJINNBOT_API_URL || 'http://api:8000';

  if (!djinnBot) return;

  const registry = djinnBot.getAgentRegistry();
  const agents = registry.getAll();
  const writes: Promise<void>[] = [];

  for (const agent of agents) {
    const agentId = agent.id;

    // Iterate over all configured channels for this agent
    for (const [channel, creds] of Object.entries(agent.channels)) {
      const { primaryToken, secondaryToken, extra } = creds;

      // Fetch existing DB state for this agent+channel (non-blocking if fails)
      let existingPrimary: string | null = null;
      let existingSecondary: string | null = null;
      try {
        const res = await authFetch(`${apiBaseUrl}/v1/agents/${agentId}/channels/keys/all`);
        if (res.ok) {
          const data = await res.json() as { channels: Record<string, { primaryToken?: string; secondaryToken?: string }> };
          existingPrimary = data.channels?.[channel]?.primaryToken ?? null;
          existingSecondary = data.channels?.[channel]?.secondaryToken ?? null;
        }
      } catch {
        // Non-fatal — proceed with write attempt
      }

      // Only sync tokens that are new or changed
      const primaryChanged = existingPrimary !== primaryToken;
      const secondaryChanged = secondaryToken ? existingSecondary !== secondaryToken : false;

      if (!primaryChanged && !secondaryChanged) {
        console.log(`[Engine] syncChannelCredentialsToDb: ${agentId}/${channel} unchanged, skipping`);
        continue;
      }

      const body: Record<string, unknown> = { enabled: true };
      if (primaryChanged) body['primaryToken'] = primaryToken;
      if (secondaryChanged && secondaryToken) body['secondaryToken'] = secondaryToken;
      if (extra && Object.keys(extra).length > 0) {
        body['extraConfig'] = extra;
      }

      writes.push(
        authFetch(`${apiBaseUrl}/v1/agents/${agentId}/channels/${channel}`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        })
          .then((r) => {
            if (r.ok) {
              console.log(`[Engine] syncChannelCredentialsToDb: synced ${agentId}/${channel}`);
            } else {
              console.warn(`[Engine] syncChannelCredentialsToDb: PUT ${agentId}/${channel} returned ${r.status}`);
            }
          })
          .catch((err) => {
            console.warn(`[Engine] syncChannelCredentialsToDb: failed for ${agentId}/${channel}:`, err);
          }),
      );
    }
  }

  await Promise.all(writes);
  console.log(`[Engine] syncChannelCredentialsToDb: done (${writes.length} agent+channel(s) synced)`);
}

/**
 * Load channel credentials from the DB back into the AgentRegistry.
 *
 * Credentials set via the dashboard UI are stored in agent_channel_credentials
 * but the AgentRegistry only reads from YAML files on disk at discover() time.
 * This function bridges the gap: for each agent, it fetches DB credentials and
 * merges them into the in-memory registry so that channel bridges (Discord,
 * Slack, Telegram, etc.) can see dashboard-configured tokens.
 */
async function loadChannelCredentialsFromDb(): Promise<void> {
  const apiBaseUrl = process.env.DJINNBOT_API_URL || 'http://api:8000';
  if (!djinnBot) return;

  const registry = djinnBot.getAgentRegistry();
  const agents = registry.getAll();

  const credentialsByAgent: Record<string, Record<string, import('./agents/types.js').ChannelCredentials>> = {};

  for (const agent of agents) {
    try {
      const res = await authFetch(`${apiBaseUrl}/v1/agents/${agent.id}/channels/keys/all`);
      if (!res.ok) continue;

      const data = await res.json() as {
        channels: Record<string, { primaryToken?: string; secondaryToken?: string; extra?: Record<string, string> }>;
      };

      if (!data.channels || Object.keys(data.channels).length === 0) continue;

      const agentChannels: Record<string, import('./agents/types.js').ChannelCredentials> = {};
      for (const [channel, creds] of Object.entries(data.channels)) {
        if (!creds.primaryToken) continue;
        agentChannels[channel] = {
          primaryToken: creds.primaryToken,
          ...(creds.secondaryToken ? { secondaryToken: creds.secondaryToken } : {}),
          ...(creds.extra && Object.keys(creds.extra).length > 0 ? { extra: creds.extra } : {}),
        };
      }

      if (Object.keys(agentChannels).length > 0) {
        credentialsByAgent[agent.id] = agentChannels;
      }
    } catch (err) {
      console.warn(`[Engine] loadChannelCredentialsFromDb: failed for ${agent.id}:`, err);
    }
  }

  registry.mergeChannelCredentials(credentialsByAgent);
}

// PROVIDER_ENV_MAP is imported from constants.ts — the single source of truth.

/**
 * Extra env vars that belong in a provider's extra_config rather than api_key.
 * Maps provider_id -> { ENV_VAR_NAME: description }
 */
const PROVIDER_EXTRA_ENV_VARS: Record<string, string[]> = {
  'azure-openai-responses': ['AZURE_OPENAI_BASE_URL', 'AZURE_OPENAI_RESOURCE_NAME', 'AZURE_OPENAI_API_VERSION'],
  // qmdr memory search — optional overrides for base URL, embed provider, models, rerank config.
  // The primary key (QMD_OPENAI_API_KEY) is synced via PROVIDER_ENV_MAP above.
  qmdr: [
    'QMD_OPENAI_BASE_URL',
    'QMD_EMBED_PROVIDER',
    'QMD_OPENAI_EMBED_MODEL',
    'QMD_RERANK_PROVIDER',
    'QMD_RERANK_MODE',
    'QMD_OPENAI_MODEL',
  ],
};

/**
 * For every provider whose API key is present in process.env, upsert it into
 * the database via the settings API.  Also syncs extra env vars (e.g. Azure base URL).
 * This makes keys visible to the Python API server (which runs in a separate container
 * without those env vars) so the frontend can show them and containers receive them.
 *
 * Strategy: PUT only when a DB row doesn't already exist or the stored key
 * differs from the env var.  That way a user who overrides a key through the
 * UI isn't clobbered every time the engine restarts.
 */
async function syncProviderApiKeysToDb(): Promise<void> {
  const apiBaseUrl = process.env.DJINNBOT_API_URL || 'http://api:8000';

  // Fetch current DB state so we only write what has changed
  let existingKeys: Record<string, string> = {};
  let existingExtra: Record<string, string> = {};
  try {
    const res = await authFetch(`${apiBaseUrl}/v1/settings/providers/keys/all`);
    if (res.ok) {
      const data = await res.json() as { keys: Record<string, string>; extra?: Record<string, string> };
      existingKeys = data.keys ?? {};
      existingExtra = data.extra ?? {};
    }
  } catch (err) {
    console.warn('[Engine] syncProviderApiKeysToDb: could not fetch existing keys:', err);
    // Non-fatal — we'll still attempt to write below
  }

  const writes: Promise<void>[] = [];

  for (const [providerId, envVar] of Object.entries(PROVIDER_ENV_MAP)) {
    const envKey = process.env[envVar];
    if (!envKey) continue; // env var not set — nothing to sync

    // Build extra config from any supplemental env vars for this provider
    const extraEnvVars = PROVIDER_EXTRA_ENV_VARS[providerId] ?? [];
    const extraConfig: Record<string, string> = {};
    for (const extraVar of extraEnvVars) {
      const val = process.env[extraVar];
      if (val) extraConfig[extraVar] = val;
    }

    // Skip if the DB already has this exact key AND extra config hasn't changed
    const extraUnchanged = Object.keys(extraConfig).every(k => existingExtra[k] === extraConfig[k]);
    if (existingKeys[providerId] === envKey && extraUnchanged) continue;

    writes.push(
      authFetch(`${apiBaseUrl}/v1/settings/providers/${providerId}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          providerId,
          enabled: true,
          apiKey: envKey,
          ...(Object.keys(extraConfig).length > 0 ? { extraConfig } : {}),
        }),
      })
        .then((r) => {
          if (r.ok) {
            console.log(`[Engine] syncProviderApiKeysToDb: synced ${providerId} (${envVar})`);
          } else {
            console.warn(`[Engine] syncProviderApiKeysToDb: PUT ${providerId} returned ${r.status}`);
          }
        })
        .catch((err) => {
          console.warn(`[Engine] syncProviderApiKeysToDb: failed to sync ${providerId}:`, err);
        }),
    );
  }

  await Promise.all(writes);
  console.log(`[Engine] syncProviderApiKeysToDb: done (${writes.length} key(s) synced)`);
}

/**
 * Read all provider keys and extra env vars from the DB and apply them to
 * process.env.  This ensures that settings configured via the dashboard UI
 * (e.g. qmdr embedding keys) take effect for the engine process and its
 * child processes (VaultEmbedWatcher qmd invocations) without requiring a
 * container restart.
 *
 * Strategy: only set env vars that are currently absent so that docker-compose
 * values (set at container startup) are not silently overwritten.  Values the
 * user explicitly sets via the UI can be written back on the next restart via
 * syncProviderApiKeysToDb and will then win on subsequent loadProviderKeysFromDb
 * calls (since docker-compose will no longer supply a conflicting value).
 */
async function loadProviderKeysFromDb(): Promise<void> {
  const apiBaseUrl = process.env.DJINNBOT_API_URL || 'http://api:8000';
  try {
    const res = await authFetch(`${apiBaseUrl}/v1/settings/providers/keys/all`);
    if (!res.ok) return;
    const data = await res.json() as { keys: Record<string, string>; extra?: Record<string, string> };

    // Primary keys: provider_id → env var via PROVIDER_ENV_MAP
    for (const [providerId, apiKey] of Object.entries(data.keys ?? {})) {
      const envVar = PROVIDER_ENV_MAP[providerId];
      if (envVar && apiKey && !process.env[envVar]) {
        process.env[envVar] = apiKey;
        console.log(`[Engine] loadProviderKeysFromDb: set ${envVar} from DB`);
      }
    }

    // Extra env vars (e.g. QMD_OPENAI_BASE_URL, QMD_EMBED_PROVIDER, …)
    for (const [envVar, value] of Object.entries(data.extra ?? {})) {
      if (value && !process.env[envVar]) {
        process.env[envVar] = value;
        console.log(`[Engine] loadProviderKeysFromDb: set ${envVar} from DB`);
      }
    }
  } catch (err) {
    console.warn('[Engine] loadProviderKeysFromDb: failed (non-fatal):', err);
  }
}

/**
 * Load the agentRuntimeImage setting from the DB and apply it to process.env.
 * Dashboard-configured values override the docker-compose env var.
 * Only sets the env var if the DB value is non-empty and differs from the
 * current value, so docker-compose defaults are preserved when the DB setting
 * is blank (meaning "use the default").
 */
async function loadAgentRuntimeImageFromDb(): Promise<void> {
  const apiBaseUrl = process.env.DJINNBOT_API_URL || 'http://api:8000';
  try {
    const res = await authFetch(`${apiBaseUrl}/v1/settings/`);
    if (!res.ok) return;
    const data = await res.json() as { agentRuntimeImage?: string };
    const dbImage = data.agentRuntimeImage?.trim();
    if (dbImage) {
      process.env.AGENT_RUNTIME_IMAGE = dbImage;
      console.log(`[Engine] loadAgentRuntimeImageFromDb: set AGENT_RUNTIME_IMAGE=${dbImage}`);
    }
  } catch (err) {
    console.warn('[Engine] loadAgentRuntimeImageFromDb: failed (non-fatal):', err);
  }
}

/**
 * Main entry point
 */
async function main(): Promise<void> {
  console.log('[Engine] Starting DjinnBot Core Engine Worker');
  console.log('[Engine] Configuration:', {
    redisUrl: CONFIG.redisUrl,
    databasePath: CONFIG.databasePath,
    dataDir: CONFIG.dataDir,
    agentsDir: CONFIG.agentsDir,
    pipelinesDir: CONFIG.pipelinesDir,
    runner: process.env.MOCK_RUNNER === 'true' ? 'MockRunner' : 'PiMonoRunner',
  });
  
  try {
    // Mount JuiceFS inside the engine so subdirectory pre-creation (especially
    // for read-only mounts like /cookies/{agentId}) writes through the real FUSE
    // filesystem instead of the raw Docker named volume.
    await mountJuiceFS();

    // Fetch global settings from Redis
    const SETTINGS_KEY = "djinnbot:global:settings";
    let globalSettings: Record<string, any> = {
      defaultSlackDecisionModel: 'openrouter/minimax/minimax-m2.5',
      userSlackId: '',
    };

    // Initialize temporary Redis client to fetch settings
    const settingsClient = new Redis(CONFIG.redisUrl);
    try {
      const data = await settingsClient.get(SETTINGS_KEY);
      if (data) {
        globalSettings = { ...globalSettings, ...JSON.parse(data) };
        console.log('[Engine] Loaded global settings from Redis:', globalSettings);
      } else {
        console.log('[Engine] No global settings in Redis, using defaults');
      }
    } catch (e) {
      console.warn('[Engine] Failed to fetch global settings from Redis:', e);
    } finally {
      settingsClient.disconnect();
    }

    // Initialize DjinnBot
    console.log('[Engine] Initializing DjinnBot...');
    djinnBot = new DjinnBot(CONFIG);

    // Initialize agent registry (discovers agents from agents/ directory)
    console.log('[Engine] Discovering agents...');
    await djinnBot.initialize();
    console.log('[Engine] Discovered agents:', djinnBot.getAgentRegistry().getIds());

    // Sync env-var API keys into the database so the Python API server
    // (which has no access to these env vars) can reflect them in the UI
    // and inject them into agent containers.
    await syncProviderApiKeysToDb();

    // Ensure each agent has a unique API key for authenticated API access.
    // Keys are cached in memory and injected into agent containers as AGENT_API_KEY.
    const agentIds = djinnBot.getAgentRegistry().getIds();
    await ensureAgentKeys(agentIds);

    // Sync per-agent channel credentials from {channel}.yml env vars into the DB
    // so the Channels tab in the dashboard can show and update them.
    await syncChannelCredentialsToDb();

    // Load channel credentials from DB back into the AgentRegistry so that
    // tokens configured via the dashboard UI are available to channel bridges
    // (Discord, Slack, Telegram, etc.) without requiring YAML files or env vars.
    await loadChannelCredentialsFromDb();

    // Load provider config from DB back into process.env so DB-configured
    // values (e.g. qmdr keys set via the Settings UI) are available to the
    // VaultEmbedWatcher subprocess and any engine-side code that reads process.env.
    await loadProviderKeysFromDb();

    // Load agentRuntimeImage from DB settings so dashboard-configured values
    // override the env var / default without requiring a container restart.
    await loadAgentRuntimeImageFromDb();

    // Load pipelines from YAML files
    console.log('[Engine] Loading pipelines...');
    await djinnBot.loadPipelines();

    const pipelines = djinnBot.listPipelines();
    console.log(`[Engine] Loaded ${pipelines.length} pipelines:`,
      pipelines.map(p => p.id).join(', '));

    // Start Slack bridge — agents with Slack credentials will open websocket
    // connections regardless of whether a default channel is configured.
    {
      const slackChannelId = process.env.SLACK_CHANNEL_ID || undefined;
      if (slackChannelId) {
        console.log(`[Engine] Starting Slack bridge (SLACK_CHANNEL_ID=${slackChannelId})...`);
      } else {
        console.log('[Engine] Starting Slack bridge (no SLACK_CHANNEL_ID — pipeline thread posting will require per-project channel config)...');
      }
      await djinnBot.startSlackBridge(
        slackChannelId,
        async (agentId, systemPrompt, userPrompt, modelString) => {
          // Use @mariozechner/pi-agent-core's Agent to make a simple LLM call
          // for Slack event decisions
          const { Agent } = await import('@mariozechner/pi-agent-core');
          const { registerBuiltInApiProviders } = await import('@mariozechner/pi-ai');

          registerBuiltInApiProviders();

          // Use the same parseModelString that containers use — it handles
          // credential checks, pi-ai registry lookup, provider inference for
          // new models, custom providers, and OpenRouter fallback correctly.
          const model = parseModelString(modelString);

          console.log(`[Engine] onDecisionNeeded: ${modelString} → provider=${model.provider}, api=${model.api}`);
          
          const agent = new Agent({
            initialState: {
              systemPrompt,
              model,
              messages: [],
            },
          });

          // Collect output
          let output = '';
          const unsubscribe = agent.subscribe((event: any) => {
            if (event.type === 'message_update' && event.assistantMessageEvent?.type === 'text_delta') {
              output += event.assistantMessageEvent.delta;
            }
          });

          await agent.prompt(userPrompt);
          await agent.waitForIdle();
          unsubscribe();

          return output;
        },
        undefined, // onHumanGuidance
        globalSettings.defaultSlackDecisionModel,
        // onMemorySearch - pre-fetch agent memories for triage decisions (fast keyword search)
        async (agentId: string, query: string, limit = 5) => {
          if (!djinnBot) return [];
          try {
            const memory = await djinnBot.getAgentMemory(agentId);
            if (!memory) {
              return [];
            }
            // Use quickSearch (BM25 only) instead of recall (slow semantic search)
            return await memory.quickSearch(query, limit);
          } catch (err) {
            console.warn(`[Engine] Memory search failed for ${agentId}:`, err);
            return [];
          }
        },
        // User's Slack ID for DMs from agents (e.g., U12345678) — configured via dashboard settings
        (globalSettings as any).userSlackId || undefined
      );
      console.log('[Engine] Slack bridge started');
    }

    // Start Signal bridge — handles account linking and message routing via Redis RPC.
    // Starts the RPC handler immediately so the dashboard can initiate linking even
    // before Signal is fully configured.
    {
      const signalDataDir = process.env.SIGNAL_DATA_DIR || '/jfs/signal/data';
      const signalCliPath = process.env.SIGNAL_CLI_PATH || 'signal-cli';
      const signalHttpPort = parseInt(process.env.SIGNAL_HTTP_PORT || '8820', 10);

      // Ensure signal data directory exists on JuiceFS
      ensureJfsDirs(['/signal/data'], '/data');

      // Start Signal bridge in the background — lock acquisition may retry
      // for up to 75s after a container restart, so we don't block engine startup.
      // The CSM is injected later once both the bridge and CSM are ready.
      djinnBot.startSignalBridge({
        signalDataDir,
        signalCliPath,
        httpPort: signalHttpPort,
        defaultConversationModel: process.env.SIGNAL_DEFAULT_MODEL,
      }).then(() => {
        console.log('[Engine] Signal bridge started');
      }).catch((err) => {
        console.warn('[Engine] Signal bridge failed to start (non-fatal):', err);
      });
    }

    // Start WhatsApp bridge — handles account linking and message routing via Redis RPC.
    // Uses Baileys (WhatsApp Web multi-device protocol) running in-process.
    {
      const whatsappAuthDir = process.env.WHATSAPP_AUTH_DIR || '/data/whatsapp/auth';

      try {
        await djinnBot.startWhatsAppBridge({
          authDir: whatsappAuthDir,
          defaultConversationModel: process.env.WHATSAPP_DEFAULT_MODEL,
        });
        console.log('[Engine] WhatsApp bridge started');
      } catch (err) {
        console.warn('[Engine] WhatsApp bridge failed to start (non-fatal):', err);
      }
    }

    // Start Telegram bridge — one bot per agent, managed by TelegramBridgeManager.
    // Started before CSM init so the RPC handler is available; CSM is injected later.
    {
      try {
        await djinnBot.startTelegramBridge({
          defaultConversationModel: process.env.TELEGRAM_DEFAULT_MODEL,
        });
        console.log('[Engine] Telegram bridge started');
      } catch (err) {
        console.warn('[Engine] Telegram bridge failed to start (non-fatal):', err);
      }
    }

    // Start Discord bridge — agents with Discord credentials will connect to the gateway
    {
      console.log('[Engine] Starting Discord bridge...');
      try {
        await djinnBot.startDiscordBridge(
          async (agentId, systemPrompt, userPrompt, modelString) => {
            const { Agent } = await import('@mariozechner/pi-agent-core');
            const { registerBuiltInApiProviders } = await import('@mariozechner/pi-ai');

            registerBuiltInApiProviders();
            const model = parseModelString(modelString);

            const agent = new Agent({
              initialState: {
                systemPrompt,
                model,
                messages: [],
              },
            });

            let output = '';
            const unsubscribe = agent.subscribe((event: any) => {
              if (event.type === 'message_update' && event.assistantMessageEvent?.type === 'text_delta') {
                output += event.assistantMessageEvent.delta;
              }
            });

            await agent.prompt(userPrompt);
            await agent.waitForIdle();
            unsubscribe();

            return output;
          },
          undefined, // onHumanGuidance
          globalSettings.defaultSlackDecisionModel, // reuse same model setting
        );
        console.log('[Engine] Discord bridge started');
      } catch (err) {
        console.warn('[Engine] Discord bridge failed to start (non-fatal):', err);
      }
    }

    // Publish engine version to Redis so the API can report it
    {
      const engineVersion = process.env.DJINNBOT_BUILD_VERSION || 'dev';
      console.log(`[Engine] Version: ${engineVersion}`);
      const versionClient = new Redis(CONFIG.redisUrl);
      try {
        await versionClient.set('djinnbot:engine:version', engineVersion);
      } catch (e) {
        console.warn('[Engine] Failed to publish version to Redis:', e);
      } finally {
        versionClient.disconnect();
      }
    }

    // Initialize Redis client for listening
    console.log('[Engine] Initializing Redis...');
    redisClient = await initRedis();

    // Start graph rebuild subscriber (handles dashboard link creation)
    await startGraphRebuildSubscriber(CONFIG.redisUrl);

    // Start MCP / mcpo manager (writes config.json, tails logs, polls health)
    if (process.env.MCPO_CONFIG_PATH || process.env.MCPO_BASE_URL) {
      const mcpoDataDir = process.env.DATA_DIR || '/data';
      mcpoManager = new McpoManager({
        redis: new Redis(CONFIG.redisUrl),  // Dedicated connection — XADD log publishing must not contend with blocking XREADGROUP on redisClient
        apiBaseUrl: CONFIG.apiUrl || 'http://api:8000',
        dataDir: mcpoDataDir,
        mcpoApiKey: process.env.MCPO_API_KEY || 'changeme',
        mcpoContainerName: process.env.MCPO_CONTAINER_NAME || 'djinnbot-mcpo',
        mcpoBaseUrl: process.env.MCPO_BASE_URL || 'http://djinnbot-mcpo:8000',
      });
      mcpoManager.start().catch((err) => {
        console.error('[Engine] McpoManager start error:', err);
      });
      console.log('[Engine] MCP manager started');
    } else {
      console.log('[Engine] MCPO_BASE_URL not set, skipping MCP manager');
    }

    // Start container log streamer (streams all Docker container logs to Redis)
    // Uses its own dedicated Redis connection — completely isolated from engine operations
    containerLogStreamer = new ContainerLogStreamer({ redisUrl: CONFIG.redisUrl });
    containerLogStreamer.start().catch((err) => {
      console.error('[Engine] ContainerLogStreamer start error:', err);
    });
    console.log('[Engine] Container log streamer started');

    // Start vault embed watcher (handles qmd semantic search indexing)
    vaultEmbedWatcher = new VaultEmbedWatcher(CONFIG.redisUrl, VAULTS_DIR);
    await vaultEmbedWatcher.start();
    
    // Initialize chat session support if enabled
    if (process.env.ENABLE_CHAT !== 'false') {
      console.log('[Engine] Initializing chat session support...');
      // Create a lifecycle tracker for chat sessions so the Activity tab reflects
      // chat activity (session_started, session_completed, session_failed events).
      // Uses the same Redis client as the rest of the engine.
      const chatLifecycleTracker = new AgentLifecycleTracker({ redis: redisClient });
      chatSessionManager = new ChatSessionManager({
        redis: redisClient,
        apiBaseUrl: CONFIG.apiUrl || 'http://api:8000',
        dataPath: CONFIG.dataDir,
        agentsDir: CONFIG.agentsDir,
        containerImage: process.env.AGENT_RUNTIME_IMAGE,
        lifecycleTracker: chatLifecycleTracker,
      });
      
      // Wire inter-agent messaging and Slack DM hooks so chat sessions can
      // route messages the same way pipeline runs do.
      chatSessionManager.registerHooks({
        onAgentMessage: (agentId, _sessionId, to, message, priority, messageType) => {
          console.log(`[Engine] Chat agentMessage hook: ${agentId} → ${to} (priority: ${priority}, type: ${messageType}, session: ${_sessionId})`);
          djinnBot!.routeAgentMessage(agentId, to, message, priority, messageType)
            .catch((err: unknown) => console.error('[Engine] Failed to route chat agentMessage:', err));
        },
        onSlackDm: (agentId, _sessionId, message, urgent) => {
          if (!djinnBot!.slackBridge) {
            console.warn('[Engine] Chat agent tried to send Slack DM but bridge not started');
            return;
          }
          djinnBot!.slackBridge.sendDmToUser(agentId, message, urgent)
            .then(() => console.log(`[Engine] Chat agent ${agentId} sent Slack DM: "${message.slice(0, 80)}"`))
            .catch((err: unknown) => console.error('[Engine] Failed to send Slack DM from chat:', err));
        },
        onWakeAgent: (agentId, _sessionId, to, message, reason) => {
          console.log(`[Engine] Chat wakeAgent hook: ${agentId} → ${to} (reason: ${reason}, session: ${_sessionId})`);
          djinnBot!.runWakeSession(to, agentId, message)
            .catch((err: unknown) => console.error('[Engine] Failed to run wake session from chat:', err));
        },
      });

      chatListener = new ChatListener({
        redis: redisClient,
        sessionManager: chatSessionManager,
      });

      // Recover any sessions that were active when the engine last restarted.
      // Must run BEFORE the chat listener starts so new sessions don't race
      // with orphan cleanup.
      await chatSessionManager.recoverOrphanedSessions();
      
      // Start listening (non-blocking)
      chatListener.start().catch(err => {
        console.error('[Engine] Chat listener error:', err);
      });
      
      console.log('[Engine] Chat session support enabled');

      // Inject ChatSessionManager into SignalBridge for message processing.
      // Uses setSignalChatSessionManager which handles the race: if the bridge
      // hasn't started yet (background lock retry), the CSM is stored and
      // injected once the bridge is ready.
      try {
        djinnBot.setSignalChatSessionManager(chatSessionManager);
      } catch (err) {
        console.warn('[Engine] Failed to inject ChatSessionManager into SignalBridge:', err);
      }

      // Inject ChatSessionManager into SlackBridge for conversation streaming.
      // The bridge must already be running (started above) — we inject after
      // chat sessions are initialised to avoid circular startup ordering.
      if (djinnBot.slackBridge) {
        try {
          djinnBot.slackBridge.setChatSessionManager(chatSessionManager);
          console.log('[Engine] SlackBridge wired to ChatSessionManager for conversation streaming');
        } catch (err) {
          console.warn('[Engine] Failed to inject ChatSessionManager into SlackBridge:', err);
        }

        // Wire up memory consolidation: just before a Slack conversation session
        // is torn down (idle timeout), the agent runs one final turn to save
        // anything meaningful from the conversation — like a person jotting down
        // notes after a call.
        try {
          djinnBot.slackBridge.setOnBeforeTeardown(async (sessionId: string, _agentId: string) => {
            if (chatSessionManager) {
              await chatSessionManager.triggerConsolidation(sessionId);
            }
          });
          console.log('[Engine] Memory consolidation wired to SlackBridge teardown');
        } catch (err) {
          console.warn('[Engine] Failed to wire memory consolidation:', err);
        }
      }

      // Inject ChatSessionManager into WhatsAppBridge for message processing.
      // Uses setWhatsAppChatSessionManager which handles the race: if the bridge
      // hasn't started yet, the CSM is stored and injected once the bridge is ready.
      try {
        djinnBot.setWhatsAppChatSessionManager(chatSessionManager);
      } catch (err) {
        console.warn('[Engine] Failed to inject ChatSessionManager into WhatsAppBridge:', err);
      }

      // Inject ChatSessionManager into TelegramBridgeManager.
      // Uses setTelegramChatSessionManager which handles the race: if the bridge
      // hasn't started yet, the CSM is stored and injected once the bridge is ready.
      try {
        djinnBot.setTelegramChatSessionManager(chatSessionManager);
      } catch (err) {
        console.warn('[Engine] Failed to inject ChatSessionManager into TelegramBridge:', err);
      }

      // Inject ChatSessionManager into DiscordBridge for conversation streaming.
      if (djinnBot.discordBridge) {
        try {
          djinnBot.discordBridge.setChatSessionManager(chatSessionManager);
          console.log('[Engine] DiscordBridge wired to ChatSessionManager for conversation streaming');
        } catch (err) {
          console.warn('[Engine] Failed to inject ChatSessionManager into DiscordBridge:', err);
        }

        try {
          djinnBot.discordBridge.setOnBeforeTeardown(async (sessionId: string, _agentId: string) => {
            if (chatSessionManager) {
              await chatSessionManager.triggerConsolidation(sessionId);
            }
          });
          console.log('[Engine] Memory consolidation wired to DiscordBridge teardown');
        } catch (err) {
          console.warn('[Engine] Failed to wire Discord memory consolidation:', err);
        }
      }
    }
    
    // Set up graceful shutdown handlers
    process.on('SIGINT', () => shutdown('SIGINT'));
    process.on('SIGTERM', () => shutdown('SIGTERM'));
    
    // Recover interrupted runs on startup
    console.log('[Engine] Checking for interrupted runs...');
    try {
      const allRuns = await djinnBot.listRuns();
      const interruptedRuns = allRuns.filter(
        (r: any) => r.status === 'running' || r.status === 'pending'
      );
      if (interruptedRuns.length > 0) {
        console.log(`[Engine] Found ${interruptedRuns.length} interrupted run(s), resuming...`);
        for (const run of interruptedRuns) {
          try {
            await djinnBot.resumeRun(run.id);
            console.log(`[Engine] Recovered run ${run.id} (pipeline: ${run.pipelineId})`);
          } catch (err) {
            console.error(`[Engine] Failed to recover run ${run.id}:`, err);
          }
        }
      } else {
        console.log('[Engine] No interrupted runs found');
      }
    } catch (err) {
      console.error('[Engine] Error during run recovery:', err);
    }

    // Recover orphaned chat sessions — sessions that were 'starting' or 'running'
    // when the engine last crashed.  The containers are gone; mark them failed in the DB.
    if (chatSessionManager) {
      console.log('[Engine] Checking for orphaned chat sessions...');
      try {
        const apiUrl = process.env.DJINNBOT_API_URL || 'http://api:8000';
        const response = await authFetch(`${apiUrl}/v1/internal/chat/sessions?status=starting&status=running&limit=100`);
        if (response.ok) {
          const data = await response.json() as { sessions?: Array<{ id: string }> };
          const orphans = (data.sessions ?? []).filter(
            (s: { id: string }) => !chatSessionManager!.isSessionActive(s.id)
          );
          if (orphans.length > 0) {
            console.log(`[Engine] Found ${orphans.length} orphaned chat session(s), marking as failed...`);
            for (const s of orphans) {
              try {
                await authFetch(`${apiUrl}/v1/chat/sessions/${s.id}`, {
                  method: 'PATCH',
                  headers: { 'Content-Type': 'application/json' },
                  body: JSON.stringify({ status: 'failed', error: 'Engine restarted — session lost' }),
                });
                console.log(`[Engine] Marked orphaned chat session ${s.id} as failed`);
              } catch (err) {
                console.error(`[Engine] Failed to mark chat session ${s.id}:`, err);
              }
            }
          } else {
            console.log('[Engine] No orphaned chat sessions found');
          }
        } else {
          console.warn(`[Engine] Could not fetch chat sessions for orphan check (${response.status})`);
        }
      } catch (err) {
        console.error('[Engine] Error during chat session orphan recovery:', err);
      }
    }

    // Docker-level safety net: kill any running djinn-run-slack_* containers
    // that are not tracked by the current engine process.  This catches containers
    // that survived a docker-compose restart but were never registered in the DB
    // (e.g. Slack sessions started before the DB-registration fix).
    if (chatSessionManager) {
      try {
        const killed = await chatSessionManager.killOrphanedContainersByPrefix('djinn-run-slack_');
        if (killed > 0) {
          console.log(`[Engine] Killed ${killed} orphaned Slack container(s) at Docker level`);
        }
      } catch (err) {
        console.warn('[Engine] Docker-level Slack container cleanup failed:', err);
      }
    }

    // Initialize swarm executor system
    swarmManager = initSwarmManager();
    console.log('[Engine] SwarmSessionManager initialized');

    // Start listening for new run events
    console.log('[Engine] Ready to process runs');
    
    // Start listening for global events (pulse triggers, etc.) in background
    listenForGlobalEvents().catch(err => {
      console.error('[Engine] Global events listener error:', err);
    });

    // Start listening for swarm dispatch events in background
    listenForSwarmEvents().catch(err => {
      console.error('[Engine] Swarm events listener error:', err);
    });
    
    // Listen for runs (blocking)
    await listenForNewRuns();
    
  } catch (err) {
    console.error('[Engine] Fatal error during startup:', err);
    process.exit(1);
  }
}

// Set up global error handlers
process.on('unhandledRejection', (reason, promise) => {
  console.error('[Engine] Unhandled rejection at:', promise, 'reason:', reason);
  // Don't exit on unhandled rejection, just log it
});

process.on('uncaughtException', (err) => {
  console.error('[Engine] Uncaught exception:', err);
  // Exit on uncaught exception (more serious)
  process.exit(1);
});

// Start the worker
main().catch((err) => {
  console.error('[Engine] Unhandled error:', err);
  process.exit(1);
});
