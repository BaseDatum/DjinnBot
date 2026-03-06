/**
 * PulseScheduler - Computes upcoming pulses and detects conflicts.
 * 
 * Supports both legacy agent-level scheduling and routine-level scheduling.
 * When routines are registered for an agent, they take priority over the
 * agent-level schedule.
 * 
 * Uses a priority queue approach: computes next pulse time for each
 * routine (or legacy agent schedule), maintains a sorted list, and fires
 * pulses at the right time.
 * 
 * This is a pure computation module - actual pulse execution is handled
 * by AgentPulse.
 */

import {
  PulseScheduleConfig,
  PulseBlackout,
  PulseRoutine,
  ScheduledPulse,
  PulseConflict,
  PulseTimelineResponse,
  CONFLICT_WINDOW_MS,
  DEFAULT_PULSE_SCHEDULE,
} from './pulse-types.js';

export interface AgentScheduleEntry {
  agentId: string;
  schedule: PulseScheduleConfig;
}

/**
 * Internal entry: either a legacy agent schedule or a routine schedule.
 */
interface ScheduleEntry {
  agentId: string;
  routineId?: string;
  routineName?: string;
  schedule: PulseScheduleConfig;
}

export class PulseScheduler {
  /** Legacy agent-level schedules (used when no routines exist for the agent) */
  private agents: Map<string, PulseScheduleConfig> = new Map();
  /** Routine-level schedules keyed by routineId */
  private routines: Map<string, ScheduleEntry> = new Map();
  /** Track which agents have routines registered */
  private agentsWithRoutines: Set<string> = new Set();
  
  constructor() {}
  
  // ============================================================================
  // Routine-based API (preferred)
  // ============================================================================
  
  /**
   * Register or update a routine's schedule.
   */
  setRoutineSchedule(routine: PulseRoutine): void {
    const schedule: PulseScheduleConfig = {
      enabled: routine.enabled,
      intervalMinutes: routine.intervalMinutes,
      offsetMinutes: routine.offsetMinutes,
      blackouts: routine.blackouts,
      oneOffs: routine.oneOffs,
      maxConsecutiveSkips: 5,
    };
    this.routines.set(routine.id, {
      agentId: routine.agentId,
      routineId: routine.id,
      routineName: routine.name,
      schedule,
    });
    this.agentsWithRoutines.add(routine.agentId);
  }
  
  /**
   * Remove a routine from the scheduler.
   */
  removeRoutine(routineId: string): void {
    const entry = this.routines.get(routineId);
    if (entry) {
      this.routines.delete(routineId);
      // Check if agent still has any routines
      let hasOther = false;
      for (const [, e] of this.routines) {
        if (e.agentId === entry.agentId) {
          hasOther = true;
          break;
        }
      }
      if (!hasOther) {
        this.agentsWithRoutines.delete(entry.agentId);
      }
    }
  }

  /**
   * Get all routine entries for an agent.
   */
  getAgentRoutines(agentId: string): ScheduleEntry[] {
    const entries: ScheduleEntry[] = [];
    for (const [, entry] of this.routines) {
      if (entry.agentId === agentId) {
        entries.push(entry);
      }
    }
    return entries;
  }

  /**
   * Check if an agent has any routines registered.
   */
  hasRoutines(agentId: string): boolean {
    return this.agentsWithRoutines.has(agentId);
  }
  
  // ============================================================================
  // Legacy agent-level API (backward compatible)
  // ============================================================================
  
  /**
   * Register or update an agent's pulse schedule (legacy).
   */
  setAgentSchedule(agentId: string, schedule: Partial<PulseScheduleConfig>): void {
    const existing = this.agents.get(agentId) || { ...DEFAULT_PULSE_SCHEDULE };
    this.agents.set(agentId, { ...existing, ...schedule });
  }
  
  /**
   * Get an agent's schedule, or defaults if not set.
   */
  getAgentSchedule(agentId: string): PulseScheduleConfig {
    return this.agents.get(agentId) || { ...DEFAULT_PULSE_SCHEDULE };
  }
  
  /**
   * Remove an agent from the scheduler.
   */
  removeAgent(agentId: string): void {
    this.agents.delete(agentId);
    // Also remove all routines for this agent
    for (const [routineId, entry] of this.routines) {
      if (entry.agentId === agentId) {
        this.routines.delete(routineId);
      }
    }
    this.agentsWithRoutines.delete(agentId);
  }
  
  /**
   * Auto-assign offsets to all agents/routines to minimize conflicts.
   */
  autoAssignOffsets(): void {
    const entries = this.getAllScheduleEntries();
    const defaultInterval = 30;
    
    entries.forEach((entry, index) => {
      const offset = Math.floor((index * defaultInterval) / entries.length);
      entry.schedule.offsetMinutes = offset;
      
      if (entry.routineId) {
        this.routines.set(entry.routineId, entry);
      } else {
        this.agents.set(entry.agentId, entry.schedule);
      }
    });
    
    console.log(`[PulseScheduler] Auto-assigned offsets to ${entries.length} entries`);
  }
  
  // ============================================================================
  // Unified scheduling
  // ============================================================================
  
  /**
   * Get all active schedule entries.  Routine entries are used for agents that
   * have them; legacy agent entries are used for agents without routines.
   */
  private getAllScheduleEntries(): ScheduleEntry[] {
    const entries: ScheduleEntry[] = [];
    
    for (const [, entry] of this.routines) {
      entries.push(entry);
    }
    
    for (const [agentId, schedule] of this.agents) {
      if (!this.agentsWithRoutines.has(agentId)) {
        entries.push({ agentId, schedule });
      }
    }
    
    return entries.sort((a, b) => {
      if (a.agentId !== b.agentId) return a.agentId.localeCompare(b.agentId);
      return (a.routineName || '').localeCompare(b.routineName || '');
    });
  }
  
  /**
   * Compute the next N pulses for a schedule entry.
   */
  private computeEntryPulses(
    entry: ScheduleEntry,
    fromTime: number = Date.now(),
    count: number = 10
  ): ScheduledPulse[] {
    const { schedule, agentId, routineId, routineName } = entry;
    if (!schedule || !schedule.enabled) return [];
    
    const pulses: ScheduledPulse[] = [];
    let currentTime = fromTime;
    const maxTime = fromTime + 7 * 24 * 60 * 60 * 1000;
    
    // One-off pulses
    for (const oneOff of schedule.oneOffs) {
      const oneOffTime = new Date(oneOff).getTime();
      if (oneOffTime > fromTime && oneOffTime < maxTime) {
        pulses.push({
          agentId,
          scheduledAt: oneOffTime,
          source: 'one-off',
          status: 'scheduled',
          routineId,
          routineName,
        });
      }
    }
    
    // Recurring pulses
    while (pulses.length < count && currentTime < maxTime) {
      const nextPulse = this.computeNextRecurringPulse(schedule, currentTime);
      if (!nextPulse || nextPulse > maxTime) break;
      
      if (!this.isInBlackout(schedule, nextPulse)) {
        pulses.push({
          agentId,
          scheduledAt: nextPulse,
          source: 'recurring',
          status: 'scheduled',
          routineId,
          routineName,
        });
      }
      
      currentTime = nextPulse + 1;
    }
    
    return pulses
      .sort((a, b) => a.scheduledAt - b.scheduledAt)
      .slice(0, count);
  }
  
  /**
   * Compute the next N pulses for a specific agent (aggregates across routines).
   */
  computeAgentPulses(
    agentId: string,
    fromTime: number = Date.now(),
    count: number = 10
  ): ScheduledPulse[] {
    if (this.agentsWithRoutines.has(agentId)) {
      const allPulses: ScheduledPulse[] = [];
      for (const [, entry] of this.routines) {
        if (entry.agentId === agentId) {
          allPulses.push(...this.computeEntryPulses(entry, fromTime, count));
        }
      }
      return allPulses
        .sort((a, b) => a.scheduledAt - b.scheduledAt)
        .slice(0, count);
    }
    
    // Legacy
    const schedule = this.agents.get(agentId);
    if (!schedule) return [];
    return this.computeEntryPulses({ agentId, schedule }, fromTime, count);
  }
  
  /**
   * Compute the next recurring pulse time after a given timestamp.
   */
  private computeNextRecurringPulse(
    schedule: PulseScheduleConfig,
    afterTime: number
  ): number | null {
    const intervalMs = schedule.intervalMinutes * 60 * 1000;
    const offsetMs = schedule.offsetMinutes * 60 * 1000;
    
    const dayStartMs = Math.floor(afterTime / (24 * 60 * 60 * 1000)) * (24 * 60 * 60 * 1000);
    const msSinceDayStart = afterTime - dayStartMs;
    const currentSlot = Math.floor(msSinceDayStart / intervalMs);
    
    let nextPulseInSlot = dayStartMs + (currentSlot * intervalMs) + offsetMs;
    
    if (nextPulseInSlot <= afterTime) {
      nextPulseInSlot += intervalMs;
    }
    
    return nextPulseInSlot;
  }
  
  /**
   * Check if a timestamp falls within a blackout window.
   */
  private isInBlackout(schedule: PulseScheduleConfig, timestamp: number): boolean {
    const date = new Date(timestamp);
    const timeStr = `${date.getHours().toString().padStart(2, '0')}:${date.getMinutes().toString().padStart(2, '0')}`;
    const dayOfWeek = date.getDay();
    
    for (const blackout of schedule.blackouts) {
      if (blackout.type === 'recurring') {
        if (blackout.startTime && blackout.endTime) {
          if (blackout.daysOfWeek && !blackout.daysOfWeek.includes(dayOfWeek)) {
            continue;
          }
          if (this.isTimeInRange(timeStr, blackout.startTime, blackout.endTime)) {
            return true;
          }
        }
      } else if (blackout.type === 'one-off') {
        if (blackout.start && blackout.end) {
          const startMs = new Date(blackout.start).getTime();
          const endMs = new Date(blackout.end).getTime();
          if (timestamp >= startMs && timestamp <= endMs) {
            return true;
          }
        }
      }
    }
    
    return false;
  }
  
  /**
   * Check if a time string (HH:MM) is within a range.
   */
  private isTimeInRange(time: string, start: string, end: string): boolean {
    const toMinutes = (t: string) => {
      const [h, m] = t.split(':').map(Number);
      return h * 60 + m;
    };
    
    const timeMin = toMinutes(time);
    const startMin = toMinutes(start);
    const endMin = toMinutes(end);
    
    if (startMin <= endMin) {
      return timeMin >= startMin && timeMin < endMin;
    } else {
      return timeMin >= startMin || timeMin < endMin;
    }
  }
  
  /**
   * Compute the pulse timeline for all agents/routines over a time window.
   */
  computeTimeline(
    fromTime: number = Date.now(),
    hours: number = 24
  ): PulseTimelineResponse {
    const windowStart = fromTime;
    const windowEnd = fromTime + hours * 60 * 60 * 1000;
    
    const allPulses: ScheduledPulse[] = [];
    const byAgent: Record<string, number> = {};
    
    const entries = this.getAllScheduleEntries();
    
    for (const entry of entries) {
      const entryPulses = this.computeEntryPulses(entry, fromTime, 100)
        .filter(p => p.scheduledAt >= windowStart && p.scheduledAt < windowEnd);
      
      allPulses.push(...entryPulses);
      byAgent[entry.agentId] = (byAgent[entry.agentId] || 0) + entryPulses.length;
    }
    
    allPulses.sort((a, b) => a.scheduledAt - b.scheduledAt);
    const conflicts = this.detectConflicts(allPulses);
    
    return {
      windowStart,
      windowEnd,
      pulses: allPulses,
      conflicts,
      summary: {
        totalPulses: allPulses.length,
        byAgent,
        conflictCount: conflicts.length,
      },
    };
  }
  
  /**
   * Detect pulse conflicts (multiple agents pulsing within CONFLICT_WINDOW_MS).
   */
  private detectConflicts(pulses: ScheduledPulse[]): PulseConflict[] {
    const conflicts: PulseConflict[] = [];
    
    for (let i = 0; i < pulses.length; i++) {
      const pulse = pulses[i];
      const windowStart = pulse.scheduledAt;
      const windowEnd = pulse.scheduledAt + CONFLICT_WINDOW_MS;
      
      const conflicting = pulses.filter(p => 
        p.scheduledAt >= windowStart && 
        p.scheduledAt < windowEnd &&
        p !== pulse
      );
      
      if (conflicting.length > 0) {
        const existing = conflicts.find(c => 
          Math.abs(c.windowStart - windowStart) < CONFLICT_WINDOW_MS
        );
        
        if (!existing) {
          const agents = [pulse, ...conflicting].map(p => ({
            agentId: p.agentId,
            scheduledAt: p.scheduledAt,
            source: p.source,
          }));
          
          const uniqueAgents = agents.filter((a, idx, arr) => 
            arr.findIndex(x => x.agentId === a.agentId) === idx
          );
          
          if (uniqueAgents.length > 1) {
            conflicts.push({
              windowStart,
              windowEnd,
              agents: uniqueAgents,
              severity: uniqueAgents.length >= 4 ? 'critical' : 'warning',
            });
          }
        }
      }
    }
    
    return conflicts;
  }
  
  /**
   * Get the next pulse time for any agent/routine.
   */
  getNextPulseTime(): { agentId: string; routineId?: string; routineName?: string; time: number } | null {
    let next: { agentId: string; routineId?: string; routineName?: string; time: number } | null = null;
    
    const entries = this.getAllScheduleEntries();
    
    for (const entry of entries) {
      const pulses = this.computeEntryPulses(entry, Date.now(), 1);
      if (pulses.length > 0) {
        const pulse = pulses[0];
        if (!next || pulse.scheduledAt < next.time) {
          next = {
            agentId: entry.agentId,
            routineId: entry.routineId,
            routineName: entry.routineName,
            time: pulse.scheduledAt,
          };
        }
      }
    }
    
    return next;
  }
  
  /**
   * Suggest offset changes to eliminate conflicts.
   */
  suggestOffsetChanges(): Map<string, number> {
    const suggestions = new Map<string, number>();
    const timeline = this.computeTimeline(Date.now(), 24);
    
    if (timeline.conflicts.length === 0) {
      return suggestions;
    }
    
    const usedOffsets = new Set<number>();
    
    for (const [agentId, schedule] of this.agents) {
      if (!usedOffsets.has(schedule.offsetMinutes)) {
        usedOffsets.add(schedule.offsetMinutes);
      } else {
        for (let i = 0; i < schedule.intervalMinutes; i++) {
          if (!usedOffsets.has(i)) {
            suggestions.set(agentId, i);
            usedOffsets.add(i);
            break;
          }
        }
      }
    }
    
    return suggestions;
  }
}
