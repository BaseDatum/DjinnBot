/**
 * PulseScheduler - Computes upcoming pulses and detects conflicts.
 * 
 * Uses a priority queue approach: computes next pulse time for each agent,
 * maintains a sorted list, and fires pulses at the right time.
 * 
 * This is a pure computation module - actual pulse execution is handled by AgentPulse.
 */

import {
  PulseScheduleConfig,
  PulseBlackout,
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

export class PulseScheduler {
  private agents: Map<string, PulseScheduleConfig> = new Map();
  
  constructor() {}
  
  /**
   * Register or update an agent's pulse schedule.
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
  }
  
  /**
   * Auto-assign offsets to all agents to minimize conflicts.
   * Call this once at startup or when user requests auto-spread.
   */
  autoAssignOffsets(): void {
    const agentIds = Array.from(this.agents.keys()).sort();
    const defaultInterval = 30; // Use most common interval
    
    agentIds.forEach((agentId, index) => {
      const schedule = this.agents.get(agentId)!;
      // Spread agents evenly across the interval
      const offset = Math.floor((index * defaultInterval) / agentIds.length);
      this.agents.set(agentId, { ...schedule, offsetMinutes: offset });
    });
    
    console.log(`[PulseScheduler] Auto-assigned offsets to ${agentIds.length} agents`);
  }
  
  /**
   * Compute the next N pulses for a specific agent.
   */
  computeAgentPulses(
    agentId: string,
    fromTime: number = Date.now(),
    count: number = 10
  ): ScheduledPulse[] {
    const schedule = this.agents.get(agentId);
    if (!schedule || !schedule.enabled) return [];
    
    const pulses: ScheduledPulse[] = [];
    let currentTime = fromTime;
    const maxTime = fromTime + 7 * 24 * 60 * 60 * 1000; // Max 7 days ahead
    
    // First, add all one-off pulses in the future
    for (const oneOff of schedule.oneOffs) {
      const oneOffTime = new Date(oneOff).getTime();
      if (oneOffTime > fromTime && oneOffTime < maxTime) {
        pulses.push({
          agentId,
          scheduledAt: oneOffTime,
          source: 'one-off',
          status: 'scheduled',
        });
      }
    }
    
    // Then compute recurring pulses until we have enough
    while (pulses.length < count && currentTime < maxTime) {
      const nextPulse = this.computeNextRecurringPulse(schedule, currentTime);
      if (!nextPulse || nextPulse > maxTime) break;
      
      // Check if this time is in a blackout
      if (!this.isInBlackout(schedule, nextPulse)) {
        pulses.push({
          agentId,
          scheduledAt: nextPulse,
          source: 'recurring',
          status: 'scheduled',
        });
      }
      
      currentTime = nextPulse + 1; // Move past this pulse
    }
    
    // Sort by time and return requested count
    return pulses
      .sort((a, b) => a.scheduledAt - b.scheduledAt)
      .slice(0, count);
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
    
    // Find the start of the current interval period
    // We use intervals aligned to midnight UTC for consistency
    const dayStartMs = Math.floor(afterTime / (24 * 60 * 60 * 1000)) * (24 * 60 * 60 * 1000);
    
    // Find the interval slot after afterTime
    const msSinceDayStart = afterTime - dayStartMs;
    const currentSlot = Math.floor(msSinceDayStart / intervalMs);
    
    // The pulse time for this slot
    let nextPulseInSlot = dayStartMs + (currentSlot * intervalMs) + offsetMs;
    
    // If we've passed this slot's pulse, move to next slot
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
        // Check daily recurring blackout
        if (blackout.startTime && blackout.endTime) {
          // Check day of week if specified
          if (blackout.daysOfWeek && !blackout.daysOfWeek.includes(dayOfWeek)) {
            continue;
          }
          
          if (this.isTimeInRange(timeStr, blackout.startTime, blackout.endTime)) {
            return true;
          }
        }
      } else if (blackout.type === 'one-off') {
        // Check one-off blackout
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
   * Handles overnight ranges (e.g., 23:00 to 07:00).
   */
  private isTimeInRange(time: string, start: string, end: string): boolean {
    // Convert to minutes since midnight for easy comparison
    const toMinutes = (t: string) => {
      const [h, m] = t.split(':').map(Number);
      return h * 60 + m;
    };
    
    const timeMin = toMinutes(time);
    const startMin = toMinutes(start);
    const endMin = toMinutes(end);
    
    if (startMin <= endMin) {
      // Normal range (e.g., 09:00 to 17:00)
      return timeMin >= startMin && timeMin < endMin;
    } else {
      // Overnight range (e.g., 23:00 to 07:00)
      return timeMin >= startMin || timeMin < endMin;
    }
  }
  
  /**
   * Compute the pulse timeline for all agents over a time window.
   */
  computeTimeline(
    fromTime: number = Date.now(),
    hours: number = 24
  ): PulseTimelineResponse {
    const windowStart = fromTime;
    const windowEnd = fromTime + hours * 60 * 60 * 1000;
    
    const allPulses: ScheduledPulse[] = [];
    const byAgent: Record<string, number> = {};
    
    // Collect pulses from all agents
    for (const [agentId] of this.agents) {
      const agentPulses = this.computeAgentPulses(agentId, fromTime, 100)
        .filter(p => p.scheduledAt >= windowStart && p.scheduledAt < windowEnd);
      
      allPulses.push(...agentPulses);
      byAgent[agentId] = agentPulses.length;
    }
    
    // Sort all pulses by time
    allPulses.sort((a, b) => a.scheduledAt - b.scheduledAt);
    
    // Detect conflicts
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
      
      // Find all pulses within the conflict window
      const conflicting = pulses.filter(p => 
        p.scheduledAt >= windowStart && 
        p.scheduledAt < windowEnd &&
        p !== pulse
      );
      
      if (conflicting.length > 0) {
        // Check if we already have a conflict for this window
        const existing = conflicts.find(c => 
          Math.abs(c.windowStart - windowStart) < CONFLICT_WINDOW_MS
        );
        
        if (!existing) {
          const agents = [pulse, ...conflicting].map(p => ({
            agentId: p.agentId,
            scheduledAt: p.scheduledAt,
            source: p.source,
          }));
          
          // Dedupe by agentId (same agent can't conflict with itself)
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
   * Get the next pulse time for any agent (for the main scheduler to set timeout).
   */
  getNextPulseTime(): { agentId: string; time: number } | null {
    let nextPulse: { agentId: string; time: number } | null = null;
    
    for (const [agentId] of this.agents) {
      const pulses = this.computeAgentPulses(agentId, Date.now(), 1);
      if (pulses.length > 0) {
        const pulse = pulses[0];
        if (!nextPulse || pulse.scheduledAt < nextPulse.time) {
          nextPulse = { agentId, time: pulse.scheduledAt };
        }
      }
    }
    
    return nextPulse;
  }
  
  /**
   * Suggest offset changes to eliminate conflicts.
   * Returns a map of agentId -> suggested new offset.
   */
  suggestOffsetChanges(): Map<string, number> {
    const suggestions = new Map<string, number>();
    const timeline = this.computeTimeline(Date.now(), 24);
    
    if (timeline.conflicts.length === 0) {
      return suggestions;
    }
    
    // Simple greedy approach: for each conflict, move the second agent's offset
    const usedOffsets = new Set<number>();
    
    for (const [agentId, schedule] of this.agents) {
      if (!usedOffsets.has(schedule.offsetMinutes)) {
        usedOffsets.add(schedule.offsetMinutes);
      } else {
        // Find an unused offset
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
