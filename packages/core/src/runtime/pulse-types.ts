/**
 * Pulse scheduling types for advanced pulse management.
 * 
 * Design principles:
 * 1. Offset-based staggering: Each agent pulses at (interval * N) + offset
 * 2. Blackouts override recurring pulses but not one-offs
 * 3. One-offs are additional pulses, not replacements
 * 4. All times stored in UTC, displayed in user's timezone
 */

export interface PulseScheduleConfig {
  /** Whether pulse system is enabled for this agent */
  enabled: boolean;
  
  /** 
   * Base interval in minutes between pulses.
   * Recommended: 30 (default). Keep consistent across agents for predictable staggering.
   */
  intervalMinutes: number;
  
  /**
   * Offset in minutes within each interval period.
   * Range: 0 to intervalMinutes-1
   * 
   * Example: If intervalMinutes=30 and offsetMinutes=5,
   * agent pulses at :05, :35 past each hour.
   * 
   * Auto-assigned if not set (based on agent index).
   */
  offsetMinutes: number;
  
  /** 
   * Times when pulses should be skipped.
   * One-off pulses still fire during blackouts.
   */
  blackouts: PulseBlackout[];
  
  /**
   * Explicitly scheduled additional pulses.
   * These fire regardless of interval timing or blackouts.
   * Stored as ISO8601 UTC strings.
   */
  oneOffs: string[];
  
  /**
   * Maximum consecutive skips before alerting.
   * If agent is busy for this many pulse cycles, warn the user.
   * Default: 5
   */
  maxConsecutiveSkips?: number;
}

export interface PulseBlackout {
  /** Blackout type */
  type: 'recurring' | 'one-off';
  
  /** Human-readable label (e.g., "Nighttime", "Maintenance Window") */
  label?: string;
  
  // For recurring (daily) blackouts
  /** Start time in "HH:MM" format (24h), in agent's timezone */
  startTime?: string;
  /** End time in "HH:MM" format (24h), in agent's timezone */
  endTime?: string;
  /** Days of week this applies (0=Sunday). Omit for all days. */
  daysOfWeek?: number[];
  
  // For one-off blackouts
  /** Start datetime as ISO8601 UTC string */
  start?: string;
  /** End datetime as ISO8601 UTC string */
  end?: string;
}

export interface ScheduledPulse {
  /** Agent ID */
  agentId: string;
  
  /** Scheduled time as Unix timestamp (ms) */
  scheduledAt: number;
  
  /** How this pulse was scheduled */
  source: 'recurring' | 'one-off';
  
  /** Current status */
  status: 'scheduled' | 'pending' | 'running' | 'completed' | 'skipped';
  
  /** If skipped, why */
  skipReason?: 'agent-busy' | 'blackout' | 'manual' | 'timeout';
  
  /** Actual start time if running/completed */
  startedAt?: number;
  
  /** Actual end time if completed */
  completedAt?: number;
  
  /** Duration in ms if completed */
  durationMs?: number;

  /** Routine ID (if scheduled via a named routine) */
  routineId?: string;

  /** Routine name for display purposes */
  routineName?: string;
}

/**
 * A named pulse routine belonging to an agent.
 * Each routine has its own instructions (prompt), schedule, and config.
 */
export interface PulseRoutine {
  id: string;
  agentId: string;
  name: string;
  description?: string;

  /** The markdown prompt used as the pulse instructions for this routine */
  instructions: string;

  /** Schedule config */
  enabled: boolean;
  intervalMinutes: number;
  offsetMinutes: number;
  blackouts: PulseBlackout[];
  oneOffs: string[];

  /** Execution config */
  timeoutMs?: number;
  maxConcurrent: number;
  pulseColumns?: string[];

  /**
   * Per-routine tool selection.
   * When null/undefined → inherit from agent's default tools.
   * When set → only these tools are available during this routine.
   * E.g. ["get_my_projects", "get_ready_tasks", "transition_task"]
   */
  tools?: string[];

  /**
   * SDLC stage affinity — which stages this routine handles.
   * E.g. ["implement", "review"] for Yukihiro's task work routine.
   * When set, get_ready_tasks filters to tasks in matching stages.
   * null/undefined = no stage filtering (all stages).
   */
  stageAffinity?: string[];

  /**
   * Task work type filter — which work types this routine handles.
   * E.g. ["feature", "bugfix", "refactor"] for an implementation routine.
   * When set, get_ready_tasks filters to tasks with matching work_type.
   * null/undefined = no work type filtering (all types).
   */
  taskWorkTypes?: string[];

  /** Per-routine model overrides (null = inherit from agent config) */
  planningModel?: string;
  executorModel?: string;

  /** Display */
  sortOrder: number;
  color?: string;

  /** Stats */
  lastRunAt?: number;
  totalRuns: number;

  createdAt: number;
  updatedAt: number;
}

/**
 * Maps a pulse routine to a specific project for an agent.
 * Defines which columns the routine watches and what tool overrides apply.
 */
export interface ProjectAgentRoutineMapping {
  id: string;
  projectId: string;
  agentId: string;
  routineId: string;
  /** Column IDs this routine watches in this project. null = use routine defaults */
  columnIds?: string[];
  /** Tool overrides for this project-routine combo. null = use routine tools */
  toolOverrides?: string[];
  enabled: boolean;
  createdAt: number;
  updatedAt: number;
}

/**
 * Resolved configuration for a routine in a specific project.
 * Merges routine defaults with project-specific overrides.
 */
export interface ResolvedRoutineConfig {
  routineId: string;
  routineName: string;
  mappingId: string;
  /** Effective column names after resolving mapping overrides */
  effectiveColumns: string[];
  /** Effective task statuses derived from effective columns */
  effectiveStatuses: string[];
  /** Effective tool list. null = use agent defaults */
  effectiveTools: string[] | null;
  planningModel?: string;
  executorModel?: string;
}

export interface PulseConflict {
  /** Time window start (Unix timestamp ms) */
  windowStart: number;
  
  /** Time window end (Unix timestamp ms) */
  windowEnd: number;
  
  /** Agents with pulses in this window */
  agents: Array<{
    agentId: string;
    scheduledAt: number;
    source: 'recurring' | 'one-off';
  }>;
  
  /** Severity: 'warning' (2-3 agents) or 'critical' (4+ agents) */
  severity: 'warning' | 'critical';
}

export interface PulseTimelineResponse {
  /** Start of the timeline window (Unix timestamp ms) */
  windowStart: number;
  
  /** End of the timeline window (Unix timestamp ms) */
  windowEnd: number;
  
  /** All scheduled pulses in the window */
  pulses: ScheduledPulse[];
  
  /** Detected conflicts */
  conflicts: PulseConflict[];
  
  /** Summary stats */
  summary: {
    totalPulses: number;
    byAgent: Record<string, number>;
    conflictCount: number;
  };
}

export interface PulseScheduleUpdate {
  enabled?: boolean;
  intervalMinutes?: number;
  offsetMinutes?: number;
  blackouts?: PulseBlackout[];
  addOneOff?: string;  // ISO8601 UTC string
  removeOneOff?: string;  // ISO8601 UTC string
}

// Default configuration for new agents
export const DEFAULT_PULSE_SCHEDULE: PulseScheduleConfig = {
  enabled: true,
  intervalMinutes: 30,
  offsetMinutes: 0,  // Will be auto-assigned
  blackouts: [
    {
      type: 'recurring',
      label: 'Nighttime',
      startTime: '23:00',
      endTime: '07:00',
    }
  ],
  oneOffs: [],
  maxConsecutiveSkips: 5,
};

/**
 * Conflict detection window in milliseconds.
 * Pulses within this window of each other are considered conflicting.
 */
export const CONFLICT_WINDOW_MS = 2 * 60 * 1000;  // 2 minutes
