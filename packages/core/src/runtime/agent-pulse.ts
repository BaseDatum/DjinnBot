import { Redis, type Redis as RedisType } from 'ioredis';
import { PulseScheduler } from './pulse-scheduler.js';
import { 
  PulseScheduleConfig, 
  PulseRoutine,
  ScheduledPulse,
  DEFAULT_PULSE_SCHEDULE,
  PulseTimelineResponse,
  ResolvedRoutineConfig,
} from './pulse-types.js';

// ── Wake guardrail configuration ────────────────────────────────────────────

export interface WakeGuardrailConfig {
  /** Minimum seconds between wakes per agent (default 300 = 5 min) */
  cooldownSeconds: number;
  /** Max wake-triggered pulses per agent per day (default 12) */
  maxWakesPerDay: number;
  /** Max daily session minutes per agent (default 120) */
  maxDailySessionMinutes: number;
  /** Max wakes from a single source agent to a target per day (default 5) */
  maxWakesPerPairPerDay: number;
}

export const DEFAULT_WAKE_GUARDRAILS: WakeGuardrailConfig = {
  cooldownSeconds: 300,
  maxWakesPerDay: 12,
  maxDailySessionMinutes: 120,
  maxWakesPerPairPerDay: 5,
};

export interface PulseConfig {
  intervalMs: number;   // Default: 30 * 60 * 1000 (30 min) - used as fallback
  timeoutMs: number;    // Default: 60 * 1000 (60 sec per agent)
  agentIds: string[];   // Agents to pulse
  /** Redis URL for wake subscription (required for wake-on-message) */
  redisUrl?: string;
  /** Wake guardrail overrides (per-agent overrides loaded from config) */
  wakeGuardrails?: Partial<WakeGuardrailConfig>;
}

export interface PulseDependencies {
  getAgentState: (agentId: string) => 'idle' | 'working' | 'thinking' | 'tool_calling';
  getUnreadCount: (agentId: string) => Promise<number>;
  getUnreadMessages: (agentId: string) => Promise<Array<{ from: string; message: string; priority: string }>>;
  consolidateMemory?: (agentId: string) => Promise<void>;
  /** Called when a pulse completes - used for manual trigger feedback */
  onPulseComplete?: (agentId: string, result: PulseResult) => void;
  /** 
   * Run a full agent session with tools for the pulse (agent wakes up).
   * When a routineId is provided, the session runner should use the routine's
   * instructions from the database.
   */
  runPulseSession?: (agentId: string, context: PulseContext) => Promise<PulseSessionResult>;
  /**
   * Load agent's pulse schedule from config (legacy).
   * If not provided, uses default schedule.
   */
  getAgentPulseSchedule?: (agentId: string) => Promise<Partial<PulseScheduleConfig>>;
  /**
   * Load all pulse routines for an agent from the database.
   * If this returns a non-empty array, routine-based scheduling is used
   * instead of the legacy agent-level schedule.
   */
  getAgentPulseRoutines?: (agentId: string) => Promise<PulseRoutine[]>;
  /**
   * Fetch tasks currently assigned to (or claimable by) this agent across all projects.
   */
  getAssignedTasks?: (agentId: string) => Promise<Array<{ id: string; title: string; status: string; project: string }>>;
  /**
   * Resolve the effective routine config across all projects for a given
   * agent + routine. Returns project-specific column/tool configs.
   * Used when routine-to-project mappings exist (Phase 2 modular workflows).
   */
  resolveRoutineProjectConfigs?: (agentId: string, routineId: string) => Promise<ResolvedRoutineConfig[]>;
  /**
   * Register a pulse session as active for this agent.
   * Returns false if the agent is already at maxConcurrent — caller should skip.
   */
  startPulseSession?: (agentId: string, sessionId: string) => boolean;
  /** Deregister a pulse session. */
  endPulseSession?: (agentId: string, sessionId: string) => void;
  /** Max number of concurrent pulse sessions allowed per agent (default: 2). */
  maxConcurrentPulseSessions?: number;
  /**
   * Called after a routine pulse completes to update stats (last_run_at, total_runs).
   */
  onRoutinePulseComplete?: (routineId: string) => void;
}

export interface PulseContext {
  unreadCount: number;
  unreadMessages: Array<{ from: string; message: string; priority: string }>;
  assignedTasks?: Array<{ id: string; title: string; status: string; project: string }>;
  /** When executing a specific routine, its ID is provided */
  routineId?: string;
  /** The routine name for logging/display */
  routineName?: string;
  /** The routine's custom instructions from the database */
  routineInstructions?: string;
  /** Override pulse columns for this routine */
  routinePulseColumns?: string[];
  /** Override timeout for this routine */
  routineTimeoutMs?: number;
  /** Override planning model for this routine (used for the pulse session itself) */
  routinePlanningModel?: string;
  /** Override executor model for this routine (passed to spawn_executor) */
  routineExecutorModel?: string;
  /**
   * Per-routine tool selection. When set, only these tools should be
   * available to the agent during this pulse session.
   * null/undefined = use agent's default tool set.
   */
  routineTools?: string[];
  /**
   * Per-routine stage affinity — which SDLC stages this routine handles.
   * Passed through to pulse tools for filtering.
   */
  routineStageAffinity?: string[];
  /**
   * Per-routine task work type filter — which work types this routine handles.
   * Passed through to pulse tools for filtering.
   */
  routineTaskWorkTypes?: string[];
  /**
   * Resolved project-specific routine configs. When a routine is mapped
   * to specific projects (via ProjectAgentRoutine), this contains the
   * resolved config per project so the session runner knows which
   * columns and tools to use for each project.
   */
  projectRoutineConfigs?: ResolvedRoutineConfig[];
}

export interface PulseSessionResult {
  success: boolean;
  actions: string[];  // What the agent decided to do
  output?: string;    // Any output/summary
}

export interface PulseResult {
  agentId: string;
  skipped: boolean;      // true if agent was busy
  unreadCount: number;
  errors: string[];
  actions?: string[];    // What the agent did during pulse
  output?: string;       // Agent's summary/output
  scheduledAt?: number;  // When this pulse was scheduled for
  source?: 'recurring' | 'one-off' | 'manual';
  /** Routine ID if this pulse was from a named routine */
  routineId?: string;
  /** Routine name for display */
  routineName?: string;
}

export class AgentPulse {
  private nextPulseTimeout: NodeJS.Timeout | null = null;
  private config: PulseConfig;
  private deps: PulseDependencies;
  private scheduler: PulseScheduler;
  private manualTriggerPending = new Set<string>();
  private consecutiveSkips = new Map<string, number>();
  /** Track active sessions per routine for per-routine concurrency gating */
  private activeRoutineSessions = new Map<string, Set<string>>();
  private running = false;

  // ── Wake system state ──────────────────────────────────────────────────
  private wakeSubscriber: RedisType | null = null;
  private wakeRedis: RedisType | null = null;
  private wakeGuardrails: WakeGuardrailConfig;
  /** Last wake timestamp per agent (in-memory, reset on restart) */
  private lastWakeTime = new Map<string, number>();

  constructor(config: PulseConfig, deps: PulseDependencies) {
    this.config = config;
    this.deps = deps;
    this.scheduler = new PulseScheduler();
    this.wakeGuardrails = { ...DEFAULT_WAKE_GUARDRAILS, ...config.wakeGuardrails };
  }

  /**
   * Initialize and start the pulse system.
   */
  async start(): Promise<void> {
    console.log(`[AgentPulse] Initializing pulse system for ${this.config.agentIds.length} agents`);
    
    // Load schedules for all agents (routines + legacy fallback)
    await this.loadAllSchedules();
    
    // Auto-assign offsets if not already configured
    this.scheduler.autoAssignOffsets();
    
    this.running = true;
    this.scheduleNextPulse();

    // Start wake-on-message listener
    if (this.config.redisUrl) {
      await this.startWakeListener();
    }
    
    console.log(`[AgentPulse] Pulse system started`);
  }

  // ── Wake-on-message system ─────────────────────────────────────────────

  /**
   * Subscribe to wake notifications for all agents.
   * Uses Redis PSUBSCRIBE on djinnbot:agent:*:wake pattern.
   */
  private async startWakeListener(): Promise<void> {
    if (!this.config.redisUrl) return;

    this.wakeSubscriber = new Redis(this.config.redisUrl, {
      maxRetriesPerRequest: null,
    });
    this.wakeRedis = new Redis(this.config.redisUrl, {
      maxRetriesPerRequest: 3,
    });

    this.wakeSubscriber.on('error', (err) => {
      console.error('[AgentPulse] Wake subscriber error:', err.message);
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
        console.error(`[AgentPulse] Failed to handle wake for ${targetAgentId}:`, err);
      }
    });

    await this.wakeSubscriber.psubscribe('djinnbot:agent:*:wake');
    console.log('[AgentPulse] Wake listener started (pattern: djinnbot:agent:*:wake)');
  }

  /**
   * Handle an incoming wake notification with guardrails.
   */
  private async handleWakeNotification(
    agentId: string,
    data: { from?: string; priority?: string; messageType?: string; messageId?: string }
  ): Promise<void> {
    const now = Date.now();
    const from = data.from || 'unknown';

    // Guardrail 1: Cooldown period
    const lastWake = this.lastWakeTime.get(agentId) || 0;
    const cooldownMs = this.wakeGuardrails.cooldownSeconds * 1000;
    if (now - lastWake < cooldownMs) {
      const remainingSec = Math.ceil((cooldownMs - (now - lastWake)) / 1000);
      console.log(`[AgentPulse] Wake suppressed for ${agentId}: cooldown (${remainingSec}s remaining)`);
      return;
    }

    // Guardrail 2: Daily wake cap (Redis counter)
    if (this.wakeRedis) {
      const dayKey = `djinnbot:agent:${agentId}:wakes:${new Date().toISOString().slice(0, 10)}`;
      const dailyCount = await this.wakeRedis.incr(dayKey);
      // Set expiry on first increment (48h to handle timezone edge cases)
      if (dailyCount === 1) {
        await this.wakeRedis.expire(dayKey, 172800);
      }
      if (dailyCount > this.wakeGuardrails.maxWakesPerDay) {
        console.warn(`[AgentPulse] Wake suppressed for ${agentId}: daily limit (${this.wakeGuardrails.maxWakesPerDay}) reached`);
        await this.wakeRedis.decr(dayKey); // Roll back the increment
        return;
      }

      // Guardrail 3: Per-pair daily limit (prevent A→B wake loops)
      const pairKey = `djinnbot:agent:${agentId}:wakes_from:${from}:${new Date().toISOString().slice(0, 10)}`;
      const pairCount = await this.wakeRedis.incr(pairKey);
      if (pairCount === 1) {
        await this.wakeRedis.expire(pairKey, 172800);
      }
      if (pairCount > this.wakeGuardrails.maxWakesPerPairPerDay) {
        console.warn(`[AgentPulse] Wake suppressed for ${agentId}: pair limit from ${from} (${this.wakeGuardrails.maxWakesPerPairPerDay}/day) reached`);
        await this.wakeRedis.decr(pairKey);
        await this.wakeRedis.decr(dayKey); // Roll back the daily count too
        return;
      }
    }

    // Guardrail 4: Agent must be idle (not already running)
    const state = this.deps.getAgentState(agentId);
    if (state !== 'idle') {
      console.log(`[AgentPulse] Wake for ${agentId} deferred: agent is ${state} (message stays in inbox)`);
      return;
    }

    // All guardrails passed — trigger the pulse
    this.lastWakeTime.set(agentId, now);
    console.log(`[AgentPulse] Waking ${agentId} (triggered by ${from}, priority: ${data.priority || 'unknown'})`);

    // Trigger as a manual pulse so it uses the default pulse path
    this.triggerPulse(agentId).catch(err => {
      console.error(`[AgentPulse] Failed to trigger wake pulse for ${agentId}:`, err);
    });
  }

  /**
   * Get current wake guardrail stats for an agent (for dashboard display).
   */
  async getWakeStats(agentId: string): Promise<{
    wakesToday: number;
    maxWakesPerDay: number;
    cooldownSeconds: number;
    lastWakeTime: number | null;
    maxDailySessionMinutes: number;
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
      maxDailySessionMinutes: this.wakeGuardrails.maxDailySessionMinutes,
    };
  }

  /**
   * Update wake guardrails at runtime (from admin dashboard).
   */
  updateWakeGuardrails(overrides: Partial<WakeGuardrailConfig>): void {
    Object.assign(this.wakeGuardrails, overrides);
    console.log('[AgentPulse] Wake guardrails updated:', this.wakeGuardrails);
  }

  /**
   * Load pulse schedules for all agents from config / database.
   */
  private async loadAllSchedules(): Promise<void> {
    for (const agentId of this.config.agentIds) {
      await this.reloadAgentSchedule(agentId);
    }
  }

  /**
   * Reload a single agent's schedule.
   * First tries to load routines from the database; falls back to legacy
   * config.yml schedule if no routines exist.
   */
  async reloadAgentSchedule(agentId: string): Promise<void> {
    try {
      // Try routine-based scheduling first
      if (this.deps.getAgentPulseRoutines) {
        const routines = await this.deps.getAgentPulseRoutines(agentId);
        if (routines.length > 0) {
          // Register all routines with the scheduler
          for (const routine of routines) {
            this.scheduler.setRoutineSchedule(routine);
          }
          console.log(`[AgentPulse] Loaded ${routines.length} routine(s) for ${agentId}`);
          
          if (this.running && this.nextPulseTimeout) {
            clearTimeout(this.nextPulseTimeout);
            this.scheduleNextPulse();
          }
          return;
        } else {
          // No routines configured — disable legacy schedule so we don't
          // spawn empty pulse sessions for agents with no routines.
          this.scheduler.setAgentSchedule(agentId, {
            ...DEFAULT_PULSE_SCHEDULE,
            enabled: false,
          });
          console.log(`[AgentPulse] No routines for ${agentId}, pulse disabled`);
          
          if (this.running && this.nextPulseTimeout) {
            clearTimeout(this.nextPulseTimeout);
            this.scheduleNextPulse();
          }
          return;
        }
      }

      // Fallback: legacy agent-level schedule from config.yml
      // (only reached when getAgentPulseRoutines dep is not provided)
      const scheduleConfig = this.deps.getAgentPulseSchedule 
        ? await this.deps.getAgentPulseSchedule(agentId)
        : {};
      
      this.scheduler.setAgentSchedule(agentId, {
        ...DEFAULT_PULSE_SCHEDULE,
        ...scheduleConfig,
        intervalMinutes: scheduleConfig.intervalMinutes ?? (this.config.intervalMs / 60000),
      });
      
      console.log(`[AgentPulse] Reloaded legacy schedule for ${agentId}: enabled=${scheduleConfig.enabled ?? true}`);
      
      if (this.running && this.nextPulseTimeout) {
        clearTimeout(this.nextPulseTimeout);
        this.scheduleNextPulse();
      }
    } catch (err) {
      console.error(`[AgentPulse] Failed to load schedule for ${agentId}:`, err);
      this.scheduler.setAgentSchedule(agentId, DEFAULT_PULSE_SCHEDULE);
    }
  }

  /**
   * Reload a single routine's schedule (called when dashboard updates it).
   */
  async reloadRoutineSchedule(routine: PulseRoutine): Promise<void> {
    this.scheduler.setRoutineSchedule(routine);
    console.log(`[AgentPulse] Reloaded routine "${routine.name}" (${routine.id}) for ${routine.agentId}`);
    
    if (this.running && this.nextPulseTimeout) {
      clearTimeout(this.nextPulseTimeout);
      this.scheduleNextPulse();
    }
  }

  /**
   * Remove a routine from the scheduler.
   */
  removeRoutine(routineId: string): void {
    this.scheduler.removeRoutine(routineId);
    this.activeRoutineSessions.delete(routineId);
    
    if (this.running && this.nextPulseTimeout) {
      clearTimeout(this.nextPulseTimeout);
      this.scheduleNextPulse();
    }
  }

  /**
   * Schedule the next pulse using the priority queue approach.
   */
  private scheduleNextPulse(): void {
    if (!this.running) return;
    
    const next = this.scheduler.getNextPulseTime();
    if (!next) {
      console.log('[AgentPulse] No upcoming pulses scheduled');
      this.nextPulseTimeout = setTimeout(() => this.scheduleNextPulse(), 5 * 60 * 1000);
      return;
    }
    
    const delay = Math.max(0, next.time - Date.now());
    const label = next.routineName 
      ? `${next.agentId}/${next.routineName}` 
      : next.agentId;
    console.log(`[AgentPulse] Next pulse: ${label} in ${Math.round(delay / 1000)}s`);
    
    this.nextPulseTimeout = setTimeout(async () => {
      try {
        await this.executePulse(next.agentId, next.time, 'recurring', next.routineId, next.routineName);
      } catch (err) {
        console.error(`[AgentPulse] Pulse execution error:`, err);
      }
      
      this.scheduleNextPulse();
    }, delay);
  }

  async stop(): Promise<void> {
    this.running = false;
    if (this.nextPulseTimeout) {
      clearTimeout(this.nextPulseTimeout);
      this.nextPulseTimeout = null;
    }

    // Clean up wake subscriber
    if (this.wakeSubscriber) {
      await this.wakeSubscriber.punsubscribe('djinnbot:agent:*:wake').catch(() => {});
      await this.wakeSubscriber.quit().catch(() => {});
      this.wakeSubscriber = null;
    }
    if (this.wakeRedis) {
      await this.wakeRedis.quit().catch(() => {});
      this.wakeRedis = null;
    }

    console.log('[AgentPulse] Pulse system stopped');
  }

  /**
   * Get the pulse timeline for all agents.
   */
  getTimeline(hours: number = 24): PulseTimelineResponse {
    return this.scheduler.computeTimeline(Date.now(), hours);
  }

  /**
   * Update an agent's pulse schedule (legacy).
   */
  async updateAgentSchedule(agentId: string, updates: Partial<PulseScheduleConfig>): Promise<void> {
    const current = this.scheduler.getAgentSchedule(agentId);
    this.scheduler.setAgentSchedule(agentId, { ...current, ...updates });
    
    if (this.running) {
      if (this.nextPulseTimeout) {
        clearTimeout(this.nextPulseTimeout);
      }
      this.scheduleNextPulse();
    }
  }

  /**
   * Add a one-off pulse for an agent (legacy).
   */
  addOneOffPulse(agentId: string, time: Date | string): void {
    const schedule = this.scheduler.getAgentSchedule(agentId);
    const timeStr = typeof time === 'string' ? time : time.toISOString();
    
    if (!schedule.oneOffs.includes(timeStr)) {
      schedule.oneOffs.push(timeStr);
      this.scheduler.setAgentSchedule(agentId, schedule);
      
      if (this.running && this.nextPulseTimeout) {
        clearTimeout(this.nextPulseTimeout);
        this.scheduleNextPulse();
      }
    }
  }

  /**
   * Remove a one-off pulse for an agent (legacy).
   */
  removeOneOffPulse(agentId: string, time: string): void {
    const schedule = this.scheduler.getAgentSchedule(agentId);
    schedule.oneOffs = schedule.oneOffs.filter(t => t !== time);
    this.scheduler.setAgentSchedule(agentId, schedule);
  }

  /**
   * Manually trigger a pulse for a specific agent.
   * Uses the legacy (non-routine) path.
   */
  async triggerPulse(agentId: string): Promise<PulseResult> {
    console.log(`[AgentPulse] Manual trigger for ${agentId}`);
    
    if (!this.config.agentIds.includes(agentId)) {
      return { agentId, skipped: true, unreadCount: 0, errors: [`Agent ${agentId} not in pulse list`], source: 'manual' };
    }

    if (this.manualTriggerPending.has(agentId)) {
      return { agentId, skipped: true, unreadCount: 0, errors: ['Pulse already in progress'], source: 'manual' };
    }

    this.manualTriggerPending.add(agentId);
    
    try {
      const result = await Promise.race([
        this.executePulse(agentId, Date.now(), 'manual'),
        new Promise<PulseResult>((_, reject) => 
          setTimeout(() => reject(new Error('Pulse timeout')), this.config.timeoutMs)
        ),
      ]);
      
      console.log(`[AgentPulse] Manual pulse completed for ${agentId}:`, result);
      return result;
    } catch (err) {
      const errorResult: PulseResult = { 
        agentId, 
        skipped: false, 
        unreadCount: 0, 
        errors: [`Pulse failed: ${err}`],
        source: 'manual',
      };
      this.deps.onPulseComplete?.(agentId, errorResult);
      return errorResult;
    } finally {
      this.manualTriggerPending.delete(agentId);
    }
  }

  /**
   * Manually trigger a specific named routine.
   */
  async triggerRoutine(agentId: string, routineId: string, routine?: PulseRoutine): Promise<PulseResult> {
    console.log(`[AgentPulse] Manual routine trigger for ${agentId}/${routineId}`);
    
    const triggerKey = `${agentId}:${routineId}`;
    if (this.manualTriggerPending.has(triggerKey)) {
      return { agentId, routineId, skipped: true, unreadCount: 0, errors: ['Routine pulse already in progress'], source: 'manual' };
    }

    this.manualTriggerPending.add(triggerKey);
    
    try {
      const result = await this.executePulse(
        agentId, Date.now(), 'manual',
        routineId, routine?.name,
      );
      return result;
    } catch (err) {
      return { 
        agentId, routineId, 
        skipped: false, unreadCount: 0, 
        errors: [`Routine pulse failed: ${err}`],
        source: 'manual',
      };
    } finally {
      this.manualTriggerPending.delete(triggerKey);
    }
  }

  /**
   * Execute a single pulse for an agent, optionally for a specific routine.
   */
  private async executePulse(
    agentId: string, 
    scheduledAt: number, 
    source: 'recurring' | 'one-off' | 'manual',
    routineId?: string,
    routineName?: string,
  ): Promise<PulseResult> {
    // --- Two-level concurrency gating ---
    
    // Level 1: Per-routine concurrency (if this is a routine pulse)
    if (routineId) {
      const routineEntries = this.scheduler.getAgentRoutines(agentId);
      const routineEntry = routineEntries.find(r => r.routineId === routineId);
      // Default max concurrent per routine is 1
      const maxPerRoutine = 1; // Could be enhanced to read from routine config
      
      const activeSessions = this.activeRoutineSessions.get(routineId) || new Set();
      if (activeSessions.size >= maxPerRoutine) {
        const skipKey = `routine:${routineId}`;
        const skips = (this.consecutiveSkips.get(skipKey) || 0) + 1;
        this.consecutiveSkips.set(skipKey, skips);
        if (skips >= 5) {
          console.warn(`[AgentPulse] Routine ${routineName || routineId} has been at concurrency limit for ${skips} consecutive pulses!`);
        }
        return { agentId, routineId, routineName, skipped: true, unreadCount: 0, errors: [], scheduledAt, source };
      }
    }

    // Level 2: Per-agent concurrency
    const pulseSessionId = routineId 
      ? `pulse_${agentId}_${routineId}_${scheduledAt}` 
      : `pulse_${agentId}_${scheduledAt}`;

    if (this.deps.startPulseSession) {
      const accepted = this.deps.startPulseSession(agentId, pulseSessionId);
      if (!accepted) {
        const skipKey = routineId ? `routine:${routineId}` : agentId;
        const skips = (this.consecutiveSkips.get(skipKey) || 0) + 1;
        this.consecutiveSkips.set(skipKey, skips);
        const schedule = this.scheduler.getAgentSchedule(agentId);
        if (skips >= (schedule.maxConsecutiveSkips || 5)) {
          console.warn(`[AgentPulse] Agent ${agentId} has been at concurrency limit for ${skips} consecutive pulses!`);
        }
        return { agentId, routineId, routineName, skipped: true, unreadCount: 0, errors: [], scheduledAt, source };
      }
    } else {
      // Fallback: use legacy idle-state gate
      const state = this.deps.getAgentState(agentId);
      if (state !== 'idle') {
        const skipKey = routineId ? `routine:${routineId}` : agentId;
        const skips = (this.consecutiveSkips.get(skipKey) || 0) + 1;
        this.consecutiveSkips.set(skipKey, skips);
        return { agentId, routineId, routineName, skipped: true, unreadCount: 0, errors: [], scheduledAt, source };
      }
    }

    // Track routine session
    if (routineId) {
      if (!this.activeRoutineSessions.has(routineId)) {
        this.activeRoutineSessions.set(routineId, new Set());
      }
      this.activeRoutineSessions.get(routineId)!.add(pulseSessionId);
    }

    // Reset consecutive skips
    const skipKey = routineId ? `routine:${routineId}` : agentId;
    this.consecutiveSkips.set(skipKey, 0);

    const errors: string[] = [];
    let unreadCount = 0;
    let unreadMessages: Array<{ from: string; message: string; priority: string }> = [];

    // Check inbox
    try {
      unreadCount = await this.deps.getUnreadCount(agentId);
      if (unreadCount > 0) {
        unreadMessages = await this.deps.getUnreadMessages(agentId);
      }
    } catch (err) {
      errors.push(`Inbox check failed: ${err}`);
    }

    // Fetch assigned tasks
    let assignedTasks: Array<{ id: string; title: string; status: string; project: string }> = [];
    if (this.deps.getAssignedTasks) {
      try {
        assignedTasks = await this.deps.getAssignedTasks(agentId);
      } catch (err) {
        errors.push(`Assigned tasks fetch failed: ${err}`);
      }
    }

    // Consolidate memory
    if (this.deps.consolidateMemory) {
      try {
        await this.deps.consolidateMemory(agentId);
      } catch (err) {
        errors.push(`Memory consolidation failed: ${err}`);
      }
    }

    // Run full pulse session
    let actions: string[] = [];
    let output: string | undefined;
    
    if (this.deps.runPulseSession) {
      try {
        const label = routineName ? `${agentId}/${routineName}` : agentId;
        console.log(`[AgentPulse] Running pulse session for ${label}...`);
        
        // Build context — include routine info so the session runner
        // can load the correct instructions and config
        const context: PulseContext = {
          unreadCount,
          unreadMessages,
          assignedTasks,
          routineId,
          routineName,
        };

        // If we have routine info, look up its details for the context
        if (routineId && this.deps.getAgentPulseRoutines) {
          try {
            const routines = await this.deps.getAgentPulseRoutines(agentId);
            const routine = routines.find(r => r.id === routineId);
            if (routine) {
              context.routineInstructions = routine.instructions;
              context.routinePulseColumns = routine.pulseColumns;
              context.routineTimeoutMs = routine.timeoutMs;
              context.routinePlanningModel = routine.planningModel;
              context.routineExecutorModel = routine.executorModel;
              context.routineTools = routine.tools;
              context.routineStageAffinity = routine.stageAffinity;
              context.routineTaskWorkTypes = routine.taskWorkTypes;
            }
          } catch {
            // Non-fatal: the session runner can still fall back to defaults
          }
        }

        // Resolve project-specific routine configs (Phase 2 modular workflows)
        if (routineId && this.deps.resolveRoutineProjectConfigs) {
          try {
            const projectConfigs = await this.deps.resolveRoutineProjectConfigs(agentId, routineId);
            if (projectConfigs.length > 0) {
              context.projectRoutineConfigs = projectConfigs;
            }
          } catch {
            // Non-fatal: falls back to routine-level defaults
          }
        }
        
        const sessionResult = await this.deps.runPulseSession(agentId, context);
        
        if (sessionResult.success) {
          actions = sessionResult.actions;
          output = sessionResult.output;
          console.log(`[AgentPulse] ${label} pulse session completed:`, actions);
        } else {
          errors.push('Pulse session failed');
        }
      } catch (err) {
        errors.push(`Pulse session error: ${err}`);
      } finally {
        this.deps.endPulseSession?.(agentId, pulseSessionId);
        // Release routine session tracking
        if (routineId) {
          this.activeRoutineSessions.get(routineId)?.delete(pulseSessionId);
        }
      }
    } else {
      this.deps.endPulseSession?.(agentId, pulseSessionId);
      if (routineId) {
        this.activeRoutineSessions.get(routineId)?.delete(pulseSessionId);
      }
    }

    const result: PulseResult = { 
      agentId, 
      skipped: false, 
      unreadCount, 
      errors, 
      actions, 
      output, 
      scheduledAt, 
      source,
      routineId,
      routineName,
    };
    
    this.deps.onPulseComplete?.(agentId, result);
    
    // Notify routine stats update
    if (routineId) {
      this.deps.onRoutinePulseComplete?.(routineId);
    }
    
    // If this was a one-off, remove it from the schedule
    if (source === 'one-off') {
      this.removeOneOffPulse(agentId, new Date(scheduledAt).toISOString());
    }
    
    return result;
  }

  // Legacy method for backwards compatibility
  async pulseAll(): Promise<void> {
    console.warn('[AgentPulse] pulseAll() is deprecated, pulses are now scheduled individually');
  }

  // Legacy method for backwards compatibility
  async pulseAgent(agentId: string): Promise<PulseResult> {
    return this.executePulse(agentId, Date.now(), 'manual');
  }
}
