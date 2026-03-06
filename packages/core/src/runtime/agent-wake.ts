/**
 * AgentWake — Standalone wake system for inter-agent immediate wake-ups.
 *
 * Separated from AgentPulse so wakes work independently of the pulse/routine
 * scheduling system. Owns:
 *  - Wake guardrails (cooldown, daily cap, per-pair limit)
 *  - Redis wake listener (PSUBSCRIBE djinnbot:agent:*:wake)
 *  - Wake stats for dashboard display
 */

import { Redis, type Redis as RedisType } from 'ioredis';

// ── Wake guardrail configuration ────────────────────────────────────────────

export interface WakeGuardrailConfig {
  /** Minimum seconds between wakes per agent (default 300 = 5 min) */
  cooldownSeconds: number;
  /** Max wake-triggered sessions per agent per day (default 12) */
  maxWakesPerDay: number;
  /** Max wakes from a single source agent to a target per day (default 5) */
  maxWakesPerPairPerDay: number;
}

export const DEFAULT_WAKE_GUARDRAILS: WakeGuardrailConfig = {
  cooldownSeconds: 300,
  maxWakesPerDay: 12,
  maxWakesPerPairPerDay: 5,
};

export interface AgentWakeConfig {
  /** Redis URL for wake subscription and rate-limit counters. */
  redisUrl: string;
  /** Agent IDs to listen for wake notifications. */
  agentIds: string[];
  /** Wake guardrail overrides. */
  wakeGuardrails?: Partial<WakeGuardrailConfig>;
}

export interface AgentWakeDeps {
  /**
   * Called when a wake is requested (from wake_agent tool event or Redis subscriber).
   * The caller (DjinnBot) runs the actual wake session.
   */
  onWakeAgent: (targetAgentId: string, fromAgentId: string, message: string) => Promise<void>;
}

export class AgentWake {
  private wakeSubscriber: RedisType | null = null;
  private wakeRedis: RedisType | null = null;
  private wakeGuardrails: WakeGuardrailConfig;
  /** Last wake timestamp per agent (in-memory, reset on restart). */
  private lastWakeTime = new Map<string, number>();

  constructor(
    private config: AgentWakeConfig,
    private deps: AgentWakeDeps,
  ) {
    this.wakeGuardrails = { ...DEFAULT_WAKE_GUARDRAILS, ...config.wakeGuardrails };
  }

  /**
   * Start the wake system: connect Redis for rate-limit counters and
   * subscribe to wake notifications.
   */
  async start(): Promise<void> {
    // Redis for rate-limit counters (INCR/DECR/GET)
    this.wakeRedis = new Redis(this.config.redisUrl, {
      maxRetriesPerRequest: 3,
    });

    // Redis subscriber for wake notifications
    this.wakeSubscriber = new Redis(this.config.redisUrl, {
      maxRetriesPerRequest: null,
    });

    this.wakeSubscriber.on('error', (err) => {
      console.error('[AgentWake] Wake subscriber error:', err.message);
    });

    this.wakeSubscriber.on('pmessage', async (_pattern: string, channel: string, message: string) => {
      // Channel format: djinnbot:agent:{agentId}:wake
      const match = channel.match(/^djinnbot:agent:(.+):wake$/);
      if (!match) return;

      const targetAgentId = match[1];
      if (!this.config.agentIds.includes(targetAgentId)) return;

      try {
        const data = JSON.parse(message);
        await this.handleWakeNotification(targetAgentId, data);
      } catch (err) {
        console.error(`[AgentWake] Failed to handle wake notification for ${targetAgentId}:`, err);
      }
    });

    await this.wakeSubscriber.psubscribe('djinnbot:agent:*:wake');
    console.log('[AgentWake] Wake system started (pattern: djinnbot:agent:*:wake)');
  }

  /**
   * Check wake guardrails for a target agent.
   * Returns { allowed: true } if guardrails pass, or { allowed: false, reason }
   * if suppressed. Increments Redis counters on success.
   */
  async checkWakeGuardrails(
    agentId: string,
    fromAgentId: string,
  ): Promise<{ allowed: true } | { allowed: false; reason: string }> {
    const now = Date.now();

    // Guardrail 1: Cooldown period
    const lastWake = this.lastWakeTime.get(agentId) || 0;
    const cooldownMs = this.wakeGuardrails.cooldownSeconds * 1000;
    if (now - lastWake < cooldownMs) {
      const remainingSec = Math.ceil((cooldownMs - (now - lastWake)) / 1000);
      return { allowed: false, reason: `cooldown (${remainingSec}s remaining)` };
    }

    // Guardrail 2: Daily wake cap (Redis counter)
    if (this.wakeRedis) {
      const dayKey = `djinnbot:agent:${agentId}:wakes:${new Date().toISOString().slice(0, 10)}`;
      const dailyCount = await this.wakeRedis.incr(dayKey);
      if (dailyCount === 1) {
        await this.wakeRedis.expire(dayKey, 172800);
      }
      if (dailyCount > this.wakeGuardrails.maxWakesPerDay) {
        await this.wakeRedis.decr(dayKey);
        return { allowed: false, reason: `daily limit (${this.wakeGuardrails.maxWakesPerDay}) reached` };
      }

      // Guardrail 3: Per-pair daily limit (prevent A→B wake loops)
      const pairKey = `djinnbot:agent:${agentId}:wakes_from:${fromAgentId}:${new Date().toISOString().slice(0, 10)}`;
      const pairCount = await this.wakeRedis.incr(pairKey);
      if (pairCount === 1) {
        await this.wakeRedis.expire(pairKey, 172800);
      }
      if (pairCount > this.wakeGuardrails.maxWakesPerPairPerDay) {
        await this.wakeRedis.decr(pairKey);
        await this.wakeRedis.decr(dayKey);
        return { allowed: false, reason: `pair limit from ${fromAgentId} (${this.wakeGuardrails.maxWakesPerPairPerDay}/day) reached` };
      }
    } else {
      console.warn(`[AgentWake] No Redis connection for rate-limit counters — guardrails 2 & 3 skipped`);
    }

    // All guardrails passed — record cooldown timestamp
    this.lastWakeTime.set(agentId, now);
    return { allowed: true };
  }

  /**
   * Handle an incoming wake notification from the Redis subscriber.
   */
  private async handleWakeNotification(
    agentId: string,
    data: { from?: string; message?: string; reason?: string },
  ): Promise<void> {
    const from = data.from || 'unknown';
    const message = data.message || `Woken by ${from}`;
    console.log(`[AgentWake] Wake notification received for ${agentId} from ${from}: "${message.slice(0, 80)}"`);

    await this.deps.onWakeAgent(agentId, from, message);
  }

  /**
   * Get current wake guardrail stats for an agent (for dashboard display).
   */
  async getWakeStats(agentId: string): Promise<{
    wakesToday: number;
    maxWakesPerDay: number;
    cooldownSeconds: number;
    lastWakeTime: number | null;
  }> {
    let wakesToday = 0;
    if (this.wakeRedis) {
      const dayKey = `djinnbot:agent:${agentId}:wakes:${new Date().toISOString().slice(0, 10)}`;
      const count = await this.wakeRedis.get(dayKey);
      wakesToday = count ? parseInt(count, 10) : 0;
    }

    return {
      wakesToday,
      maxWakesPerDay: this.wakeGuardrails.maxWakesPerDay,
      cooldownSeconds: this.wakeGuardrails.cooldownSeconds,
      lastWakeTime: this.lastWakeTime.get(agentId) || null,
    };
  }

  /**
   * Update wake guardrails at runtime (from admin dashboard).
   */
  updateWakeGuardrails(overrides: Partial<WakeGuardrailConfig>): void {
    Object.assign(this.wakeGuardrails, overrides);
    console.log('[AgentWake] Wake guardrails updated:', this.wakeGuardrails);
  }

  /**
   * Gracefully shut down the wake system.
   */
  async stop(): Promise<void> {
    if (this.wakeSubscriber) {
      await this.wakeSubscriber.punsubscribe('djinnbot:agent:*:wake').catch(() => {});
      await this.wakeSubscriber.quit().catch(() => {});
      this.wakeSubscriber = null;
    }
    if (this.wakeRedis) {
      await this.wakeRedis.quit().catch(() => {});
      this.wakeRedis = null;
    }
    console.log('[AgentWake] Wake system stopped');
  }
}
