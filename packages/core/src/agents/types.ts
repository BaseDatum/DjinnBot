/**
 * Agent primitive types.
 * An agent is a directory on disk. These types represent the parsed/loaded state.
 */

/** Parsed from IDENTITY.md */
export interface ParsedIdentity {
  name: string;
  role: string;
  emoji: string;
  pipelineStages: string[];
  /** Raw IDENTITY.md content (for system prompt assembly) */
  raw: string;
}

/** Parsed from config.yml (or defaults) */
export interface AgentRuntimeConfig {
  model: string;
  thinkingModel: string;
  maxConcurrentSteps: number;
  slackDecisionTimeoutMs: number;
  /** Timeout in ms for pulse container execution. Default: 120000 (2 min). */
  pulseContainerTimeoutMs: number;
  tools: string[];
  /** 
   * Thread response mode:
   * - 'passive' (default): Only respond to threads where agent is @mentioned or has participated
   * - 'active': Evaluate ALL threads in channels where agent is present
   */
  threadMode: 'active' | 'passive';
  // skillsDisabled removed in V2 — skill access is managed via DB (agent_skills table)
}

/** Parsed from slack.yml (tokens resolved from env) */
export interface SlackCredentials {
  botToken: string;
  appToken: string;
  botUserId?: string;
}

/** Full agent registry entry — everything we know about an agent */
export interface AgentRegistryEntry {
  /** Directory name = agent ID */
  id: string;
  /** Absolute path to agent directory */
  dir: string;
  /** Parsed identity */
  identity: ParsedIdentity;
  /** Raw SOUL.md content */
  soul: string;
  /** Raw AGENTS.md content */
  agents: string;
  /** Raw DECISION.md content - instructions for decision-making, memory, learning */
  decision: string;
  /** Merged config (config.yml + defaults) */
  config: AgentRuntimeConfig;
  /** Slack credentials (null = no Slack presence) */
  slack: SlackCredentials | null;
  /** Whether avatar.png exists */
  hasAvatar: boolean;
}

/** Default agent config values */
export const DEFAULT_AGENT_CONFIG: AgentRuntimeConfig = {
  model: 'openrouter/minimax/minimax-m2.5',
  thinkingModel: 'openrouter/minimax/minimax-m2.5',
  maxConcurrentSteps: 2,
  slackDecisionTimeoutMs: 15000,
  pulseContainerTimeoutMs: 120000,
  tools: ['read', 'write', 'bash'],
  threadMode: 'passive',
};
