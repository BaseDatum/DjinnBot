export interface SandboxConfig {
  memory_mb: number;
  cpu_cores: number;
  max_procs: number;
  timeout_seconds: number;
  network: boolean;
}

export interface LifecycleConfig {
  max_concurrent_steps: number;
  queue_max_depth: number;
}

export interface PulseChecks {
  inbox: boolean;
  consolidate_memories: boolean;
  update_workspace_docs: boolean;
  cleanup_stale_files: boolean;
  post_status_slack: boolean;
}

export interface PulseConfig {
  enabled: boolean;
  interval_minutes: number;
  timeout_seconds: number;
  checks: PulseChecks;
}

export interface MessagingConfig {
  receive_enabled: boolean;
  slack_urgent_notifications: boolean;
  retention_days: number;
}

/** Wake guardrail settings — controls how agents can wake each other */
export interface WakeGuardrailsConfig {
  /** Minimum seconds between wakes per agent (default 300) */
  cooldownSeconds: number;
  /** Max wake-triggered pulses per agent per day (default 12) */
  maxWakesPerDay: number;
  /** Max daily active session minutes per agent (default 120) */
  maxDailySessionMinutes: number;
  /** Max wakes from a single source→target pair per day (default 5) */
  maxWakesPerPairPerDay: number;
}

/** Coordination settings for concurrent agent instances */
export interface CoordinationConfig {
  /** Max concurrent pulse sessions for this agent (default 2) */
  maxConcurrentPulseSessions: number;
  /** Wake guardrails (cost control for agent-to-agent wake-ups) */
  wakeGuardrails: WakeGuardrailsConfig;
}

export type ThinkingLevel = 'off' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh';

export interface AgentConfig {
  model: string;
  thinkingModel: string;
  /** Thinking level for the working model (off = disabled) */
  thinkingLevel?: ThinkingLevel;
  /** Thinking level for the decision/thinking model */
  thinkingModelThinkingLevel?: ThinkingLevel;
  /** Thread response mode: 'passive' (default) or 'active' */
  threadMode?: 'active' | 'passive';
  /** Whether pulse is enabled for this agent */
  pulseEnabled?: boolean;
  /** Pulse interval in minutes */
  pulseIntervalMinutes?: number;
  /**
   * Kanban columns this agent scans for work during pulse.
   * Maps directly to pulse_columns in config.yml.
   */
  pulseColumns?: string[];
  /**
   * Timeout in ms for the pulse container execution.
   * Maps directly to pulse_container_timeout_ms in config.yml.
   * Default: 120000 (2 minutes).
   */
  pulseContainerTimeoutMs?: number;
  /** Coordination settings (concurrency, wake guardrails) */
  coordination?: CoordinationConfig;
  sandbox?: SandboxConfig;
  lifecycle?: LifecycleConfig;
  pulse?: PulseConfig;
  messaging?: MessagingConfig;
}

export const SANDBOX_LIMITS = {
  memory_mb: { min: 256, max: 8192, default: 2048 },
  cpu_cores: { min: 1, max: 8, default: 2 },
  max_procs: { min: 32, max: 1024, default: 256 },
  timeout_seconds: { min: 30, max: 3600, default: 300 },
  network: { default: true }
} as const;

export const COORDINATION_DEFAULTS: CoordinationConfig = {
  maxConcurrentPulseSessions: 2,
  wakeGuardrails: {
    cooldownSeconds: 300,
    maxWakesPerDay: 12,
    maxDailySessionMinutes: 120,
    maxWakesPerPairPerDay: 5,
  },
};
