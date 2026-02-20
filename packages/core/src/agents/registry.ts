/**
 * AgentRegistry — discovers and loads agents from the agents/ directory.
 *
 * An agent is a directory containing at minimum IDENTITY.md.
 * Optional: SOUL.md, AGENTS.md, config.yml, slack.yml, avatar.png
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
  SlackCredentials,
} from './types.js';
import { DEFAULT_AGENT_CONFIG } from './types.js';

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
          const slackStatus = agent.slack ? '(Slack ✓)' : '(no Slack)';
          console.log(
            `[AgentRegistry] Loaded agent: ${id} — ${agent.identity.name} ${agent.identity.emoji} ${slackStatus}`
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

  /** Get all agents that have Slack credentials */
  getSlackAgents(): AgentRegistryEntry[] {
    return this.getAll().filter((a) => a.slack !== null);
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
    // Load optional files in parallel
    const [soul, agents, decision, configContent, slackContent, avatarExists] =
      await Promise.all([
        this.loadFile(join(dir, 'SOUL.md')),
        this.loadFile(join(dir, 'AGENTS.md')),
        this.loadFile(join(dir, 'DECISION.md')),
        this.loadFile(join(dir, 'config.yml')),
        this.loadFile(join(dir, 'slack.yml')),
        this.fileExists(join(dir, 'avatar.png')),
      ]);

    const identity = this.parseIdentity(identityContent);
    const config = this.parseConfig(configContent);
    const slack = this.parseSlackCredentials(slackContent);

    return {
      id,
      dir,
      identity,
      soul: soul || '',
      agents: agents || '',
      decision: decision || '',
      config,
      slack,
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
   * Parse slack.yml and resolve env var references.
   * Returns null if no valid credentials found.
   */
  private parseSlackCredentials(
    content: string | null
  ): SlackCredentials | null {
    if (!content) return null;

    try {
      const parsed = parseYaml(content) || {};

      const botToken = this.resolveEnvVar(parsed.bot_token || parsed.botToken);
      const appToken = this.resolveEnvVar(parsed.app_token || parsed.appToken);

      if (!botToken || !appToken) {
        return null;
      }

      return {
        botToken,
        appToken,
        botUserId: parsed.bot_user_id || parsed.botUserId || undefined,
      };
    } catch {
      console.warn('[AgentRegistry] Failed to parse slack.yml');
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
