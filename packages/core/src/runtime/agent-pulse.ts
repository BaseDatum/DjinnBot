import { PulseScheduler } from './pulse-scheduler.js';
import { 
  PulseScheduleConfig, 
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
   * The agent reviews memories, inbox, tasks, and decides what to do.
   */
  runPulseSession?: (agentId: string, context: PulseContext) => Promise<PulseSessionResult>;
  /**
   * Load agent's pulse schedule from config.
   * If not provided, uses default schedule.
   */
  getAgentPulseSchedule?: (agentId: string) => Promise<Partial<PulseScheduleConfig>>;
  /**
   * Fetch tasks currently assigned to (or claimable by) this agent across all projects.
   * Used to pre-populate PulseContext.assignedTasks so the agent wakes up aware of its work.
   */
  getAssignedTasks?: (agentId: string) => Promise<Array<{ id: string; title: string; status: string; project: string }>>;
  /**
   * Register a pulse session as active for this agent.
   * Returns false if the agent is already at maxConcurrent — caller should skip the pulse.
   * Independent of pipeline step tracking so pipeline steps and pulse sessions don't block each other.
   */
  startPulseSession?: (agentId: string, sessionId: string) => boolean;
  /** Deregister a pulse session. */
  endPulseSession?: (agentId: string, sessionId: string) => void;
  /** Max number of concurrent pulse sessions allowed per agent (default: 2). */
  maxConcurrentPulseSessions?: number;
}

export interface PulseContext {
  unreadCount: number;
  unreadMessages: Array<{ from: string; message: string; priority: string }>;
  assignedTasks?: Array<{ id: string; title: string; status: string; project: string }>;
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
}

export class AgentPulse {
  private nextPulseTimeout: NodeJS.Timeout | null = null;
  private config: PulseConfig;
  private deps: PulseDependencies;
  private scheduler: PulseScheduler;
  private manualTriggerPending = new Set<string>();
  private consecutiveSkips = new Map<string, number>();
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
    
    // Load schedules for all agents
    await this.loadAllSchedules();
    
    // Auto-assign offsets if not already configured
    this.scheduler.autoAssignOffsets();
    
    this.running = true;
    this.scheduleNextPulse();
    
    console.log(`[AgentPulse] Pulse system started`);
  }

  /**
   * Load pulse schedules for all agents from config.
   */
  private async loadAllSchedules(): Promise<void> {
    for (const agentId of this.config.agentIds) {
      await this.reloadAgentSchedule(agentId);
    }
  }

  /**
   * Reload a single agent's schedule from config.
   * Called at startup and when dashboard updates schedule via Redis event.
   */
  async reloadAgentSchedule(agentId: string): Promise<void> {
    try {
      const scheduleConfig = this.deps.getAgentPulseSchedule 
        ? await this.deps.getAgentPulseSchedule(agentId)
        : {};
      
      this.scheduler.setAgentSchedule(agentId, {
        ...DEFAULT_PULSE_SCHEDULE,
        ...scheduleConfig,
        // Use config.intervalMs as fallback if not in schedule
        intervalMinutes: scheduleConfig.intervalMinutes ?? (this.config.intervalMs / 60000),
      });
      
      console.log(`[AgentPulse] Reloaded schedule for ${agentId}: enabled=${scheduleConfig.enabled ?? true}`);
      
      // Re-schedule if running to pick up the new schedule
      if (this.running && this.nextPulseTimeout) {
        clearTimeout(this.nextPulseTimeout);
        this.scheduleNextPulse();
      }
    } catch (err) {
      console.error(`[AgentPulse] Failed to load schedule for ${agentId}:`, err);
      // Use defaults
      this.scheduler.setAgentSchedule(agentId, DEFAULT_PULSE_SCHEDULE);
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
      // Check again in 5 minutes
      this.nextPulseTimeout = setTimeout(() => this.scheduleNextPulse(), 5 * 60 * 1000);
      return;
    }
    
    const delay = Math.max(0, next.time - Date.now());
    console.log(`[AgentPulse] Next pulse: ${next.agentId} in ${Math.round(delay / 1000)}s`);
    
    this.nextPulseTimeout = setTimeout(async () => {
      try {
        await this.executePulse(next.agentId, next.time, 'recurring');
      } catch (err) {
        console.error(`[AgentPulse] Pulse execution error:`, err);
      }
      
      // Schedule the next one
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
   * Update an agent's pulse schedule.
   */
  async updateAgentSchedule(agentId: string, updates: Partial<PulseScheduleConfig>): Promise<void> {
    const current = this.scheduler.getAgentSchedule(agentId);
    this.scheduler.setAgentSchedule(agentId, { ...current, ...updates });
    
    // Re-schedule if we're running
    if (this.running) {
      if (this.nextPulseTimeout) {
        clearTimeout(this.nextPulseTimeout);
      }
      this.scheduleNextPulse();
    }
  }

  /**
   * Add a one-off pulse for an agent.
   */
  addOneOffPulse(agentId: string, time: Date | string): void {
    const schedule = this.scheduler.getAgentSchedule(agentId);
    const timeStr = typeof time === 'string' ? time : time.toISOString();
    
    if (!schedule.oneOffs.includes(timeStr)) {
      schedule.oneOffs.push(timeStr);
      this.scheduler.setAgentSchedule(agentId, schedule);
      
      // Re-schedule
      if (this.running && this.nextPulseTimeout) {
        clearTimeout(this.nextPulseTimeout);
        this.scheduleNextPulse();
      }
    }
  }

  /**
   * Remove a one-off pulse for an agent.
   */
  removeOneOffPulse(agentId: string, time: string): void {
    const schedule = this.scheduler.getAgentSchedule(agentId);
    schedule.oneOffs = schedule.oneOffs.filter(t => t !== time);
    this.scheduler.setAgentSchedule(agentId, schedule);
  }

  /**
   * Manually trigger a pulse for a specific agent (called from API trigger)
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
   * Execute a single pulse for an agent.
   */
  private async executePulse(
    agentId: string, 
    scheduledAt: number, 
    source: 'recurring' | 'one-off' | 'manual'
  ): Promise<PulseResult> {
    // Gate on concurrent pulse session count, not the binary idle/working pipeline state.
    // This lets agents run multiple parallel task sessions while not double-firing beyond the cap.
    const maxConcurrent = this.deps.maxConcurrentPulseSessions ?? 2;
    const pulseSessionId = `pulse_${agentId}_${scheduledAt}`;

    if (this.deps.startPulseSession) {
      const accepted = this.deps.startPulseSession(agentId, pulseSessionId);
      if (!accepted) {
        // At concurrency limit — track and skip
        const skips = (this.consecutiveSkips.get(agentId) || 0) + 1;
        this.consecutiveSkips.set(agentId, skips);
        const schedule = this.scheduler.getAgentSchedule(agentId);
        if (skips >= (schedule.maxConsecutiveSkips || 5)) {
          console.warn(`[AgentPulse] Agent ${agentId} has been at concurrency limit for ${skips} consecutive pulses!`);
        }
        return { agentId, skipped: true, unreadCount: 0, errors: [], scheduledAt, source };
      }
    } else {
      // Fallback: use legacy idle-state gate when startPulseSession is not wired
      const state = this.deps.getAgentState(agentId);
      if (state !== 'idle') {
        const skips = (this.consecutiveSkips.get(agentId) || 0) + 1;
        this.consecutiveSkips.set(agentId, skips);
        const schedule = this.scheduler.getAgentSchedule(agentId);
        if (skips >= (schedule.maxConsecutiveSkips || 5)) {
          console.warn(`[AgentPulse] Agent ${agentId} has been busy for ${skips} consecutive pulses!`);
        }
        return { agentId, skipped: true, unreadCount: 0, errors: [], scheduledAt, source };
      }
    }

    // Reset consecutive skips on successful execution attempt
    this.consecutiveSkips.set(agentId, 0);

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

    // Fetch tasks assigned to this agent across all projects
    let assignedTasks: Array<{ id: string; title: string; status: string; project: string }> = [];
    if (this.deps.getAssignedTasks) {
      try {
        assignedTasks = await this.deps.getAssignedTasks(agentId);
      } catch (err) {
        errors.push(`Assigned tasks fetch failed: ${err}`);
      }
    }

    // Consolidate memory (if available)
    if (this.deps.consolidateMemory) {
      try {
        await this.deps.consolidateMemory(agentId);
      } catch (err) {
        errors.push(`Memory consolidation failed: ${err}`);
      }
    }

    // Run full pulse session if available (agent wakes up and thinks)
    let actions: string[] = [];
    let output: string | undefined;
    
    if (this.deps.runPulseSession) {
      // pulseSessionId was registered above via startPulseSession — ensure cleanup in finally.
      try {
        console.log(`[AgentPulse] Running pulse session for ${agentId}...`);
        const sessionResult = await this.deps.runPulseSession(agentId, {
          unreadCount,
          unreadMessages,
          assignedTasks,
        });
        
        if (sessionResult.success) {
          actions = sessionResult.actions;
          output = sessionResult.output;
          console.log(`[AgentPulse] ${agentId} pulse session completed:`, actions);
        } else {
          errors.push('Pulse session failed');
        }
      } catch (err) {
        errors.push(`Pulse session error: ${err}`);
      } finally {
        this.deps.endPulseSession?.(agentId, pulseSessionId);
      }
    } else {
      // No session runner — still need to release the slot
      this.deps.endPulseSession?.(agentId, pulseSessionId);
    }

    const result: PulseResult = { 
      agentId, 
      skipped: false, 
      unreadCount, 
      errors, 
      actions, 
      output, 
      scheduledAt, 
      source 
    };
    
    this.deps.onPulseComplete?.(agentId, result);
    
    // If this was a one-off, remove it from the schedule
    if (source === 'one-off') {
      this.removeOneOffPulse(agentId, new Date(scheduledAt).toISOString());
    }
    
    return result;
  }

  // Legacy method for backwards compatibility
  async pulseAll(): Promise<void> {
    // In the new system, this isn't used - pulses are scheduled individually
    console.warn('[AgentPulse] pulseAll() is deprecated, pulses are now scheduled individually');
  }

  // Legacy method for backwards compatibility
  async pulseAgent(agentId: string): Promise<PulseResult> {
    return this.executePulse(agentId, Date.now(), 'manual');
  }
}
