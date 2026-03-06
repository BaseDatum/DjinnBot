/**
 * VaultEmbedWatcher
 *
 * Listens on Redis for `djinnbot:vault:updated` signals published by agent-runtime
 * containers after a memory is written. Debounces per-agent and runs:
 *
 *   qmd update -c <collection>   (re-scans new/changed files into the index)
 *   qmd embed  -c <collection>   (generates vector embeddings for unindexed content)
 *
 * This ensures memories are immediately available for semantic recall without
 * agents having to wait for a periodic background sweep.
 *
 * Debounce rationale: an agent might call remember() several times in quick
 * succession. We batch those into a single embed run fired DEBOUNCE_MS after
 * the last update for that agent, avoiding redundant API calls to the embedding
 * provider.
 *
 * Serialization: qmd uses a single SQLite database for all collections. Running
 * multiple qmd processes concurrently causes "database is locked" errors. All
 * embed runs are queued and executed one at a time via a serial promise chain.
 */

import { Redis } from 'ioredis';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { join } from 'node:path';

const execFileAsync = promisify(execFile);

const CHANNEL = 'djinnbot:vault:updated';
const DEBOUNCE_MS = 2000; // wait 2s after last write before embedding
const DEBOUNCE_SHARED_MS = 10_000; // shared vault: 10s debounce — during onboarding many agents write rapidly
const EMBED_TIMEOUT_MS = 120_000; // 2 min max per embed run
const QMD_BIN = '/usr/local/bin/qmd';

interface VaultUpdatedPayload {
  agentId: string;
  sharedUpdated: boolean;
  timestamp: number;
}

export class VaultEmbedWatcher {
  private subscriber: Redis;
  private debounceTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private running = false;

  // Serial execution queue: all qmd runs are chained onto this promise so they
  // never overlap. SQLite cannot handle concurrent writers across processes.
  private queue: Promise<void> = Promise.resolve();

  constructor(
    private redisUrl: string,
    private vaultsDir: string,
  ) {
    this.subscriber = new Redis(redisUrl, { lazyConnect: true });
  }

  async start(): Promise<void> {
    if (this.running) return;
    this.running = true;

    this.subscriber.on('error', (err) => {
      console.error('[VaultEmbedWatcher] Redis error:', err.message);
    });

    await this.subscriber.connect();
    await this.subscriber.subscribe(CHANNEL);

    this.subscriber.on('message', (channel, message) => {
      if (channel !== CHANNEL) return;
      try {
        const payload = JSON.parse(message) as VaultUpdatedPayload;
        this.scheduleEmbed(payload.agentId);
        if (payload.sharedUpdated) {
          this.scheduleEmbed('shared');
        }
      } catch (err) {
        console.error('[VaultEmbedWatcher] Failed to parse message:', err);
      }
    });

    console.log('[VaultEmbedWatcher] Listening for vault updates on', CHANNEL);
  }

  async stop(): Promise<void> {
    this.running = false;
    // Cancel all pending debounce timers
    for (const timer of this.debounceTimers.values()) {
      clearTimeout(timer);
    }
    this.debounceTimers.clear();
    await this.subscriber.quit();
  }

  private scheduleEmbed(agentId: string): void {
    // Cancel any existing debounce for this agent
    const existing = this.debounceTimers.get(agentId);
    if (existing) clearTimeout(existing);

    // Shared vault gets a longer debounce — during onboarding multiple agents
    // write shared memories in rapid succession and we don't want to re-embed
    // after every single write.
    const debounceMs = agentId === 'shared' ? DEBOUNCE_SHARED_MS : DEBOUNCE_MS;

    const timer = setTimeout(() => {
      this.debounceTimers.delete(agentId);
      // Enqueue onto the serial chain — never run two qmd processes at once
      this.queue = this.queue.then(() =>
        this.runEmbed(agentId).catch((err) => {
          console.error(`[VaultEmbedWatcher] Embed failed for ${agentId}:`, err);
        }),
      );
    }, debounceMs);

    this.debounceTimers.set(agentId, timer);
  }

  private async runEmbed(agentId: string): Promise<void> {
    // Collection names mirror what AgentMemory.ensureQmdCollection() creates:
    //   personal vault → djinnbot-{agentId}
    //   shared vault   → djinnbot-shared
    const collection = agentId === 'shared' ? 'djinnbot-shared' : `djinnbot-${agentId}`;
    const vaultPath = join(this.vaultsDir, agentId);

    console.log(`[VaultEmbedWatcher] Re-indexing vault for ${agentId} (collection: ${collection})`);

    const env = {
      ...process.env,
      PATH: `/root/.bun/bin:/usr/local/bin:${process.env.PATH}`,
    };

    try {
      // Step 1: update index (pick up new/changed files)
      await execFileAsync(QMD_BIN, ['update', '-c', collection], {
        env,
        timeout: EMBED_TIMEOUT_MS,
        cwd: vaultPath,
      });

      // Step 2: generate embeddings for any unindexed content
      await execFileAsync(QMD_BIN, ['embed', '-c', collection], {
        env,
        timeout: EMBED_TIMEOUT_MS,
        cwd: vaultPath,
      });

      console.log(`[VaultEmbedWatcher] Embed complete for ${agentId}`);
    } catch (err: any) {
      // Surface the stderr so we can diagnose issues without crashing the engine
      const stderr = err.stderr ? `\n${err.stderr}` : '';
      console.error(`[VaultEmbedWatcher] qmd failed for ${agentId} (collection: ${collection}):${stderr}`, err.message);
    }
  }
}
