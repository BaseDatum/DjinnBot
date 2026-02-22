import { PulseScheduler } from './pulse-scheduler.js';
import { 
  PulseScheduleConfig, 
  PulseRoutine,
  ScheduledPulse,
  DEFAULT_PULSE_SCHEDULE,
  PulseTimelineResponse 
} from './pulse-types.js';

export interface PulseConfig {
  intervalMs: number;   // Default: 30 * 60 * 1000 (30 min) - used as fallback
  timeoutMs: number;    // Default: 60 * 1000 (60 sec per agent)
  agentIds: string[];   // Agents to pulse
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
   * instructions instead of the default PULSE.md.
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
  /** The routine's custom instructions (replaces PULSE.md) */
  routineInstructions?: string;
  /** The routine's source file (if instructions should be read from disk) */
  routineSourceFile?: string;
  /** Override pulse columns for this routine */
  routinePulseColumns?: string[];
  /** Override timeout for this routine */
  routineTimeoutMs?: number;
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

  constructor(config: PulseConfig, deps: PulseDependencies) {
    this.config = config;
    this.deps = deps;
    this.scheduler = new PulseScheduler();
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
    
    console.log(`[AgentPulse] Pulse system started`);
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
        }
      }

      // Fallback: legacy agent-level schedule from config.yml
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

  stop(): void {
    this.running = false;
    if (this.nextPulseTimeout) {
      clearTimeout(this.nextPulseTimeout);
      this.nextPulseTimeout = null;
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
              context.routineSourceFile = routine.sourceFile;
              context.routinePulseColumns = routine.pulseColumns;
              context.routineTimeoutMs = routine.timeoutMs;
            }
          } catch {
            // Non-fatal: the session runner can still fall back to defaults
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
