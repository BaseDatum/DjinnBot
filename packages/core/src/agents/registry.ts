/**
 * AgentRegistry — discovers and loads agents from the agents/ directory.
 *
 * An agent is a directory containing at minimum IDENTITY.md.
 * Optional: SOUL.md, AGENTS.md, config.yml, {channel}.yml, avatar.png
 *
 * Adding an agent = creating a directory. Removing = deleting it.
 * No hardcoded lists anywhere.
 */

import { readdir, readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { parse as parseYaml } from 'yaml';
import type {
  AgentRegistryEntry,
  ParsedIdentity,
  AgentRuntimeConfig,
  ChannelCredentials,
} from './types.js';
import { DEFAULT_AGENT_CONFIG } from './types.js';

/**
 * Known channel YAML filenames (without extension).
 * Each maps to a channel key in AgentRegistryEntry.channels.
 * Adding a new channel integration = adding an entry here.
 */
const KNOWN_CHANNELS = ['slack', 'discord', 'telegram'] as const;

export class AgentRegistry {
  private agents = new Map<string, AgentRegistryEntry>();
  private orchestrator: AgentRegistryEntry | null = null;

  constructor(private agentsDir: string) {}

  /**
   * Scan the agents directory and load all agents.
   * Call this at startup.
   */
  async discover(): Promise<void> {
    this.agents.clear();
    this.orchestrator = null;

    const entries = await readdir(this.agentsDir, { withFileTypes: true });

    for (const entry of entries) {
      if (!entry.isDirectory()) continue;

      const id = entry.name;
      const dir = join(this.agentsDir, id);

      // Skip shared/ directory
      if (id === 'shared') continue;

      // Check for IDENTITY.md (required)
      const identityContent = await this.loadFile(join(dir, 'IDENTITY.md'));
      if (!identityContent) {
        // No IDENTITY.md — not a valid agent, skip silently
        continue;
      }

      try {
        const agent = await this.loadAgent(id, dir, identityContent);

        if (id === '_orchestrator') {
          this.orchestrator = agent;
          console.log(`[AgentRegistry] Loaded orchestrator`);
        } else {
          this.agents.set(id, agent);
          const channelNames = Object.keys(agent.channels);
          const channelStatus = channelNames.length > 0
            ? `(${channelNames.join(', ')} ✓)`
            : '(no channels)';
          console.log(
            `[AgentRegistry] Loaded agent: ${id} — ${agent.identity.name} ${agent.identity.emoji} ${channelStatus}`
          );
        }
      } catch (err) {
        console.error(`[AgentRegistry] Failed to load agent ${id}:`, err);
      }
    }

    console.log(
      `[AgentRegistry] Discovered ${this.agents.size} agents` +
        (this.orchestrator ? ' + orchestrator' : '')
    );
  }

  /** Get an agent by ID */
  get(id: string): AgentRegistryEntry | undefined {
    return this.agents.get(id);
  }

  /** Get the orchestrator */
  getOrchestrator(): AgentRegistryEntry | null {
    return this.orchestrator;
  }

  /** Get all agents (excludes orchestrator) */
  getAll(): AgentRegistryEntry[] {
    return Array.from(this.agents.values());
  }

  /**
   * Get all agents that have credentials for a specific channel.
   * e.g. getAgentsByChannel('slack') returns agents with Slack configured.
   */
  getAgentsByChannel(channel: string): AgentRegistryEntry[] {
    return this.getAll().filter((a) => channel in a.channels);
  }

  /**
   * @deprecated Use getAgentsByChannel('slack') instead.
   * Kept for backward compatibility during migration.
   */
  getSlackAgents(): AgentRegistryEntry[] {
    return this.getAgentsByChannel('slack');
  }

  /** Get agent IDs */
  getIds(): string[] {
    return Array.from(this.agents.keys());
  }

  /** Check if an agent exists */
  has(id: string): boolean {
    return this.agents.has(id);
  }

  // ─── Private Loading Methods ───────────────────────────────────────────

  private async loadAgent(
    id: string,
    dir: string,
    identityContent: string
  ): Promise<AgentRegistryEntry> {
    // Load optional core files and all known channel YAML files in parallel
    const channelLoads = KNOWN_CHANNELS.map((ch) => this.loadFile(join(dir, `${ch}.yml`)));

    const [soul, agents, decision, configContent, avatarExists, ...channelContents] =
      await Promise.all([
        this.loadFile(join(dir, 'SOUL.md')),
        this.loadFile(join(dir, 'AGENTS.md')),
        this.loadFile(join(dir, 'DECISION.md')),
        this.loadFile(join(dir, 'config.yml')),
        this.fileExists(join(dir, 'avatar.png')),
        ...channelLoads,
      ]);

    const identity = this.parseIdentity(identityContent);
    const config = this.parseConfig(configContent);

    // Parse all channel credentials
    const channels: Record<string, ChannelCredentials> = {};
    for (let i = 0; i < KNOWN_CHANNELS.length; i++) {
      const creds = this.parseChannelCredentials(channelContents[i]);
      if (creds) {
        channels[KNOWN_CHANNELS[i]] = creds;
      }
    }

    return {
      id,
      dir,
      identity,
      soul: soul || '',
      agents: agents || '',
      decision: decision || '',
      config,
      channels,
      hasAvatar: avatarExists,
    };
  }

  /**
   * Parse IDENTITY.md into structured fields.
   * Extracts from markdown list items like:
   *   - **Name:** Finn
   *   - **Role:** Solutions Architect
   */
  private parseIdentity(content: string): ParsedIdentity {
    const extract = (key: string): string => {
      // Match: - **Key:** Value  or  **Key:** Value
      const pattern = new RegExp(
        `\\*\\*${key}:\\*\\*\\s*(.+?)(?:\\n|$)`,
        'i'
      );
      const match = content.match(pattern);
      return match?.[1]?.trim() || '';
    };

    const name = extract('Name') || 'Unknown Agent';
    const role = extract('Role') || 'AI Agent';
    const emoji = extract('Emoji') || '🤖';
    const stagesRaw = extract('Pipeline Stages') || extract('Pipeline Stage');
    const pipelineStages = stagesRaw
      ? stagesRaw.split(',').map((s) => s.trim())
      : [];

    return { name, role, emoji, pipelineStages, raw: content };
  }

  /**
   * Parse config.yml and merge with defaults.
   */
  private parseConfig(content: string | null): AgentRuntimeConfig {
    if (!content) return { ...DEFAULT_AGENT_CONFIG };

    try {
      const parsed = parseYaml(content) || {};
      return {
        model: parsed.model || DEFAULT_AGENT_CONFIG.model,
        thinkingModel:
          parsed.thinking_model ||
          parsed.thinkingModel ||
          DEFAULT_AGENT_CONFIG.thinkingModel,
        planningModel:
          parsed.planning_model ||
          parsed.planningModel ||
          parsed.model ||  // Fall back to the agent's primary model
          DEFAULT_AGENT_CONFIG.planningModel,
        executorModel:
          parsed.executor_model ||
          parsed.executorModel ||
          parsed.model ||  // Fall back to the agent's primary model
          DEFAULT_AGENT_CONFIG.executorModel,
        maxConcurrentSteps:
          parsed.max_concurrent_steps ??
          DEFAULT_AGENT_CONFIG.maxConcurrentSteps,
        slackDecisionTimeoutMs:
          parsed.slack_decision_timeout_ms ??
          DEFAULT_AGENT_CONFIG.slackDecisionTimeoutMs,
        pulseContainerTimeoutMs:
          parsed.pulse_container_timeout_ms ??
          DEFAULT_AGENT_CONFIG.pulseContainerTimeoutMs,
        tools: parsed.tools || DEFAULT_AGENT_CONFIG.tools,
        threadMode:
          parsed.thread_mode ||
          parsed.threadMode ||
          DEFAULT_AGENT_CONFIG.threadMode,
        // skillsDisabled removed in V2 — access is managed via DB
      };
    } catch {
      console.warn('[AgentRegistry] Failed to parse config.yml, using defaults');
      return { ...DEFAULT_AGENT_CONFIG };
    }
  }

  /**
   * Parse a channel YAML file into generic ChannelCredentials.
   *
   * Channel YAML files use a standard two-token layout:
   *
   *   # Slack example (slack.yml)
   *   bot_token: ${SLACK_ERIC_BOT_TOKEN}     → primaryToken
   *   app_token: ${SLACK_ERIC_APP_TOKEN}     → secondaryToken
   *   bot_user_id: U0ABC1234                 → extra.bot_user_id
   *
   *   # Discord example (discord.yml)
   *   bot_token: ${DISCORD_ERIC_BOT_TOKEN}   → primaryToken
   *   app_id: ${DISCORD_ERIC_APP_ID}         → secondaryToken
   *   guild_id: 123456789012345678           → extra.guild_id
   *
   *   # Telegram example (telegram.yml)
   *   bot_token: ${TELEGRAM_ERIC_BOT_TOKEN}  → primaryToken
   *   webhook_secret: ${TELEGRAM_ERIC_...}   → secondaryToken (optional)
   *   allowed_chat_ids: -100123,987654       → extra.allowed_chat_ids
   *
   * The first token-like key found becomes primaryToken, the second becomes
   * secondaryToken.  All remaining keys go into extra.
   */
  private parseChannelCredentials(
    content: string | null
  ): ChannelCredentials | null {
    if (!content) return null;

    try {
      const parsed = parseYaml(content) || {};

      // Resolve all keys that look like tokens (contain "token", "key", "secret", "id" suffix)
      const tokenKeys = ['bot_token', 'botToken', 'token'];
      const secondaryKeys = ['app_token', 'appToken', 'app_id', 'appId', 'webhook_secret', 'webhookSecret'];

      let primaryToken: string | undefined;
      let secondaryToken: string | undefined;
      const extra: Record<string, string> = {};

      // Find primary token
      for (const key of tokenKeys) {
        if (parsed[key]) {
          primaryToken = this.resolveEnvVar(parsed[key]);
          break;
        }
      }

      // Find secondary token
      for (const key of secondaryKeys) {
        if (parsed[key]) {
          secondaryToken = this.resolveEnvVar(parsed[key]);
          break;
        }
      }

      // Primary token is required — without it, the channel isn't configured
      if (!primaryToken) {
        return null;
      }

      // Collect remaining keys as extra config
      const knownKeys = new Set([...tokenKeys, ...secondaryKeys]);
      for (const [key, value] of Object.entries(parsed)) {
        if (knownKeys.has(key)) continue;
        if (typeof value === 'string' && value) {
          const resolved = this.resolveEnvVar(value);
          if (resolved) extra[key] = resolved;
        } else if (value !== null && value !== undefined) {
          extra[key] = String(value);
        }
      }

      return {
        primaryToken,
        ...(secondaryToken ? { secondaryToken } : {}),
        ...(Object.keys(extra).length > 0 ? { extra } : {}),
      };
    } catch {
      console.warn('[AgentRegistry] Failed to parse channel YAML');
      return null;
    }
  }

  /**
   * Resolve env var references like ${SLACK_FINN_BOT_TOKEN}.
   * Returns the literal value if no env var pattern found.
   * Returns undefined if env var is referenced but not set.
   */
  private resolveEnvVar(value: unknown): string | undefined {
    if (typeof value !== 'string') return undefined;
    if (!value) return undefined;

    // Check for ${VAR_NAME} pattern
    const envMatch = value.match(/^\$\{(.+)\}$/);
    if (envMatch) {
      const envValue = process.env[envMatch[1]];
      if (!envValue) {
        console.warn(
          `[AgentRegistry] Env var ${envMatch[1]} not set`
        );
        return undefined;
      }
      return envValue;
    }

    // Literal value
    return value;
  }

  // ─── File Utilities ────────────────────────────────────────────────────

  private async loadFile(filePath: string): Promise<string | null> {
    try {
      return (await readFile(filePath, 'utf-8')).trim();
    } catch {
      return null;
    }
  }

  private async fileExists(filePath: string): Promise<boolean> {
    try {
      await stat(filePath);
      return true;
    } catch {
      return false;
    }
  }
}
