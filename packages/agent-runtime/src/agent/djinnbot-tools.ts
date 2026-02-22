import type { AgentTool } from '@mariozechner/pi-agent-core';
import type { RedisPublisher } from '../redis/publisher.js';
import type { RedisClient } from '../redis/client.js';
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
import { createWorkLedgerTools } from './djinnbot-tools/work-ledger.js';

export interface DjinnBotToolsConfig {
  publisher: RedisPublisher;
  /** Redis client for direct operations (work ledger, coordination). */
  redis: RedisClient;
  /** Mutable ref — tools read `.current` at call time, no need to recreate tools per turn. */
  requestIdRef: RequestIdRef;
  agentId: string;
  /** Session ID for this container instance — used by work ledger for lock ownership. */
  sessionId: string;
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
  /**
   * Whether this container is running a pipeline step (RUN_ID starts with 'run_').
   * Pipeline tools (pulse-projects, pulse-tasks) are included when true.
   */
  isPipelineRun?: boolean;
  /**
   * Whether this container is running a pulse/standalone session
   * (RUN_ID starts with 'standalone_').
   * Pipeline tools (pulse-projects, pulse-tasks) are included when true.
   */
  isPulseSession?: boolean;
  /**
   * Whether this container is running an onboarding session
   * (ONBOARDING_SESSION_ID env var is set).
   * Onboarding tools are included only when true.
   */
  isOnboardingSession?: boolean;
}

export function createDjinnBotTools(config: DjinnBotToolsConfig): AgentTool[] {
  const {
    publisher, redis, requestIdRef, agentId, sessionId, vaultPath, sharedPath,
    onComplete, onFail, apiBaseUrl, pulseColumns,
    isOnboardingSession = false,
  } = config;

  return [
    ...createStepControlTools({ onComplete, onFail }),

    ...createMemoryTools({ publisher, agentId, vaultPath, sharedPath }),

    ...createMemoryGraphTools({ publisher, agentId, vaultPath }),

    ...createMessagingTools({ publisher, requestIdRef, vaultPath }),

    ...createWorkLedgerTools({ redis, agentId, sessionId }),

    ...createResearchTools(),

    ...createSkillsTools({ agentId, apiBaseUrl }),

    ...createGitHubTools({ apiBaseUrl }),

    ...createSecretsTools({ agentId, apiBaseUrl }),

    // Pulse/pipeline tools — always included (chat, pipeline, and pulse sessions)
    ...createPulseProjectsTools({ agentId, apiBaseUrl, pulseColumns }),

    ...createPulseTasksTools({ agentId, apiBaseUrl }),

    // Onboarding tools — only for onboarding sessions (ONBOARDING_SESSION_ID is set)
    ...(isOnboardingSession ? createOnboardingTools({ agentId, apiBaseUrl }) : []),
  ];
}
