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
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { PROVIDER_ENV_MAP } from './constants.js';
import { parseModelString } from './runtime/model-resolver.js';

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

const VAULTS_DIR = process.env.VAULTS_DIR || '/data/vaults';
const CLAWVAULT_BIN = '/usr/local/bin/clawvault';
const GRAPH_REBUILD_CHANNEL = 'djinnbot:graph:rebuild';

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
  
  // Create consumer group if it doesn't exist
  try {
    await client.xgroup('CREATE', REDIS_STREAM, CONSUMER_GROUP, '0', 'MKSTREAM');
    console.log(`[Engine] Created consumer group: ${CONSUMER_GROUP}`);
  } catch (err: any) {
    if (err.message?.includes('BUSYGROUP')) {
      console.log(`[Engine] Consumer group already exists: ${CONSUMER_GROUP}`);
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
        const result = await wm.createTaskWorktree(agentId, projectId, taskId, taskBranch);
        // Publish result so Python API can unblock the waiting HTTP response
        if (opsRedis) {
          await opsRedis.setex(
            `djinnbot:workspace:${agentId}:${taskId}`,
            300, // 5 min TTL — enough for the HTTP response to read it
            JSON.stringify({ success: true, worktreePath: result.worktreePath, branch: result.branch, alreadyExists: result.alreadyExists }),
          );
        }
        console.log(`[Engine] Task worktree ready at ${result.worktreePath}`);
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
        wm.removeTaskWorktree(agentId, projectId, taskId);
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
    
    // Shutdown DjinnBot (stops executor and engine)
    if (djinnBot) {
      await djinnBot.shutdown();
    }
    
    // Stop MCP manager
    if (mcpoManager) {
      mcpoManager.stop();
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
 */
const graphRebuildTimers = new Map<string, ReturnType<typeof setTimeout>>();
const GRAPH_REBUILD_DEBOUNCE_MS = 1500;

async function rebuildGraphIndex(agentId: string): Promise<void> {
  const { join } = await import('node:path');
  const vaultPath = join(VAULTS_DIR, agentId);
  console.log(`[Engine] Rebuilding graph index for vault: ${agentId}`);
  try {
    await execFileAsync(CLAWVAULT_BIN, ['graph', '--refresh', '--vault', vaultPath], {
      timeout: 30_000,
    });
    console.log(`[Engine] Graph index rebuilt for ${agentId}`);
  } catch (err: any) {
    console.error(`[Engine] clawvault graph rebuild failed for ${agentId}:`, err.message);
  }
}

function scheduleGraphRebuild(agentId: string): void {
  const existing = graphRebuildTimers.get(agentId);
  if (existing) clearTimeout(existing);
  const timer = setTimeout(() => {
    graphRebuildTimers.delete(agentId);
    rebuildGraphIndex(agentId).catch((err) =>
      console.error(`[Engine] Graph rebuild error for ${agentId}:`, err)
    );
  }, GRAPH_REBUILD_DEBOUNCE_MS);
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
 * For every agent that has a slack.yml with env var references, attempt to
 * resolve the tokens from process.env and upsert them into the DB via the
 * channels API.
 *
 * Strategy: read the existing DB state first. Only write a token if:
 *   - the env var is present in process.env, AND
 *   - the DB does not already have a stored token for that agent+channel
 *     (i.e. never clobber tokens that the user has set through the dashboard).
 *
 * This mirrors syncProviderApiKeysToDb() for model providers.
 */
async function syncSlackCredentialsToDb(): Promise<void> {
  const apiBaseUrl = process.env.DJINNBOT_API_URL || 'http://api:8000';

  if (!djinnBot) return;

  const registry = djinnBot.getAgentRegistry();
  const agents = registry.getAll();
  const writes: Promise<void>[] = [];

  for (const agent of agents) {
    // We need the raw env var values even if slack.yml couldn't fully resolve
    // (e.g. only one of two tokens is set). Read slack.yml directly for the
    // env var names then resolve each independently.
    const agentId = agent.id;

    // Use the already-resolved slack credentials if available.
    // If fully resolved (both tokens present), check DB and sync.
    if (!agent.slack) {
      // No slack.yml or tokens missing — nothing to sync.
      continue;
    }

    const { botToken, appToken, botUserId } = agent.slack;

    // Fetch existing DB state for this agent+slack (non-blocking if fails)
    let existingPrimary: string | null = null;
    let existingSecondary: string | null = null;
    try {
      const res = await fetch(`${apiBaseUrl}/v1/agents/${agentId}/channels/keys/all`);
      if (res.ok) {
        const data = await res.json() as { channels: Record<string, { primaryToken?: string; secondaryToken?: string }> };
        existingPrimary = data.channels?.slack?.primaryToken ?? null;
        existingSecondary = data.channels?.slack?.secondaryToken ?? null;
      }
    } catch {
      // Non-fatal — proceed with write attempt
    }

    // Only sync tokens that are new or changed
    const primaryChanged = existingPrimary !== botToken;
    const secondaryChanged = existingSecondary !== appToken;

    if (!primaryChanged && !secondaryChanged) {
      console.log(`[Engine] syncSlackCredentialsToDb: ${agentId}/slack unchanged, skipping`);
      continue;
    }

    const body: Record<string, unknown> = { enabled: true };
    if (primaryChanged) body['primaryToken'] = botToken;
    if (secondaryChanged) body['secondaryToken'] = appToken;
    if (botUserId) {
      body['extraConfig'] = { bot_user_id: botUserId };
    }

    writes.push(
      fetch(`${apiBaseUrl}/v1/agents/${agentId}/channels/slack`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      })
        .then((r) => {
          if (r.ok) {
            console.log(`[Engine] syncSlackCredentialsToDb: synced ${agentId}/slack`);
          } else {
            console.warn(`[Engine] syncSlackCredentialsToDb: PUT ${agentId}/slack returned ${r.status}`);
          }
        })
        .catch((err) => {
          console.warn(`[Engine] syncSlackCredentialsToDb: failed for ${agentId}:`, err);
        }),
    );
  }

  await Promise.all(writes);
  console.log(`[Engine] syncSlackCredentialsToDb: done (${writes.length} agent(s) synced)`);
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
    const res = await fetch(`${apiBaseUrl}/v1/settings/providers/keys/all`);
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
      fetch(`${apiBaseUrl}/v1/settings/providers/${providerId}`, {
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
    const res = await fetch(`${apiBaseUrl}/v1/settings/providers/keys/all`);
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
    // Fetch global settings from Redis
    const SETTINGS_KEY = "djinnbot:global:settings";
    let globalSettings = {
      defaultSlackDecisionModel: 'openrouter/minimax/minimax-m2.5'
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

    // Sync per-agent Slack credentials from slack.yml env vars into the DB
    // so the Channels tab in the dashboard can show and update them.
    await syncSlackCredentialsToDb();

    // Load provider config from DB back into process.env so DB-configured
    // values (e.g. qmdr keys set via the Settings UI) are available to the
    // VaultEmbedWatcher subprocess and any engine-side code that reads process.env.
    await loadProviderKeysFromDb();

    // Load pipelines from YAML files
    console.log('[Engine] Loading pipelines...');
    await djinnBot.loadPipelines();

    const pipelines = djinnBot.listPipelines();
    console.log(`[Engine] Loaded ${pipelines.length} pipelines:`,
      pipelines.map(p => p.id).join(', '));

    // Start Slack bridge if configured
    if (process.env.SLACK_CHANNEL_ID) {
      console.log('[Engine] Starting Slack bridge...');
      await djinnBot.startSlackBridge(
        process.env.SLACK_CHANNEL_ID,
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
        // Sky's Slack user ID for DMs from agents (e.g., U12345678)
        process.env.SKY_SLACK_USER_ID
      );
      console.log('[Engine] Slack bridge started');
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

    // Start vault embed watcher (handles qmd semantic search indexing)
    vaultEmbedWatcher = new VaultEmbedWatcher(CONFIG.redisUrl, VAULTS_DIR);
    await vaultEmbedWatcher.start();
    
    // Initialize chat session support if enabled
    if (process.env.ENABLE_CHAT !== 'false') {
      console.log('[Engine] Initializing chat session support...');
      chatSessionManager = new ChatSessionManager({
        redis: redisClient,
        apiBaseUrl: CONFIG.apiUrl || 'http://api:8000',
        dataPath: CONFIG.dataDir,
        agentsDir: CONFIG.agentsDir,
        containerImage: process.env.CONTAINER_IMAGE,
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
        const response = await fetch(`${apiUrl}/v1/internal/chat/sessions?status=starting&status=running&limit=100`);
        if (response.ok) {
          const data = await response.json() as { sessions?: Array<{ id: string }> };
          const orphans = (data.sessions ?? []).filter(
            (s: { id: string }) => !chatSessionManager!.isSessionActive(s.id)
          );
          if (orphans.length > 0) {
            console.log(`[Engine] Found ${orphans.length} orphaned chat session(s), marking as failed...`);
            for (const s of orphans) {
              try {
                await fetch(`${apiUrl}/v1/chat/sessions/${s.id}`, {
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

    // Start listening for new run events
    console.log('[Engine] Ready to process runs');
    
    // Start listening for global events (pulse triggers, etc.) in background
    listenForGlobalEvents().catch(err => {
      console.error('[Engine] Global events listener error:', err);
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
