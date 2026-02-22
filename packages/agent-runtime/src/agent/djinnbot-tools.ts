import type { AgentTool } from '@mariozechner/pi-agent-core';
import type { RedisPublisher } from '../redis/publisher.js';
import type { RequestIdRef } from './runner.js';
import { createStepControlTools } from './djinnbot-tools/step-control.js';
import { createMemoryTools } from './djinnbot-tools/memory.js';
import { createMemoryGraphTools } from './djinnbot-tools/memory-graph.js';
import { createMessagingTools } from './djinnbot-tools/messaging.js';
import { createResearchTools } from './djinnbot-tools/research.js';
import { createSkillsTools } from './djinnbot-tools/skills.js';
import { createOnboardingTools } from './djinnbot-tools/onboarding.js';
import { createGitHubTools } from './djinnbot-tools/github.js';
import { createPulseProjectsTools } from './djinnbot-tools/pulse-projects.js';
import { createPulseTasksTools } from './djinnbot-tools/pulse-tasks.js';
import { createSecretsTools } from './djinnbot-tools/secrets.js';

export interface DjinnBotToolsConfig {
  publisher: RedisPublisher;
  /** Mutable ref — tools read `.current` at call time, no need to recreate tools per turn. */
  requestIdRef: RequestIdRef;
  agentId: string;
  vaultPath: string;
  sharedPath: string;
  /** Absolute path to the agents directory — used for skill registry. */
  agentsDir?: string;
  /**
   * DjinnBot API base URL (no /api suffix).
   * Defaults to DJINNBOT_API_URL env var, then 'http://api:8000'.
   */
  apiBaseUrl?: string;
  /**
   * Kanban column names this agent works from during pulse.
   * Defaults to PULSE_COLUMNS env var (comma-separated), then ['Backlog','Ready'].
   */
  pulseColumns?: string[];
  onComplete: (outputs: Record<string, string>, summary?: string) => void;
  onFail: (error: string, details?: string) => void;
}

export function createDjinnBotTools(config: DjinnBotToolsConfig): AgentTool[] {
  const { publisher, requestIdRef, agentId, vaultPath, sharedPath, onComplete, onFail, apiBaseUrl, pulseColumns } = config;

  return [
    ...createStepControlTools({ onComplete, onFail }),

    ...createMemoryTools({ publisher, agentId, vaultPath, sharedPath }),

    ...createMemoryGraphTools({ publisher, agentId, vaultPath }),

    ...createMessagingTools({ publisher, requestIdRef, vaultPath }),

    ...createResearchTools(),

    ...createSkillsTools({ agentId, apiBaseUrl }),

    ...createOnboardingTools({ agentId, apiBaseUrl }),

    ...createGitHubTools({ apiBaseUrl }),

    ...createPulseProjectsTools({ agentId, apiBaseUrl, pulseColumns }),

    ...createPulseTasksTools({ agentId, apiBaseUrl }),

    ...createSecretsTools({ agentId, apiBaseUrl }),
  ];
}
