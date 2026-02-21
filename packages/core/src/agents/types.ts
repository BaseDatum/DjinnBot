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

/**
 * Generic channel credentials resolved from {channel}.yml files.
 *
 * Each channel integration stores two tokens (primary + secondary) and
 * optional extra key-value config.  The semantic meaning varies by channel:
 *
 *   Slack:    primaryToken = botToken (xoxb-…), secondaryToken = appToken (xapp-…)
 *   Discord:  primaryToken = botToken, secondaryToken = applicationId
 *   Telegram: primaryToken = botToken, secondaryToken = webhookSecret (optional)
 */
export interface ChannelCredentials {
  primaryToken: string;
  secondaryToken?: string;
  extra?: Record<string, string>;
}

/**
 * @deprecated Use ChannelCredentials instead.  Kept as a convenience alias
 * so Slack-specific code can destructure with familiar field names.
 */
export interface SlackCredentials {
  botToken: string;
  appToken: string;
  botUserId?: string;
}

/** Convert generic ChannelCredentials to the Slack-specific shape. */
export function toSlackCredentials(creds: ChannelCredentials): SlackCredentials {
  return {
    botToken: creds.primaryToken,
    appToken: creds.secondaryToken!,
    botUserId: creds.extra?.bot_user_id,
  };
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
  /**
   * Per-channel credentials keyed by channel name (e.g. "slack", "discord", "telegram").
   * Loaded from {channel}.yml files in the agent directory.
   */
  channels: Record<string, ChannelCredentials>;
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
