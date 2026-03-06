import type { AgentTool } from '@mariozechner/pi-agent-core';
import type { RedisPublisher } from '../redis/publisher.js';
import type { RedisClient } from '../redis/client.js';
import type { RequestIdRef } from './runner.js';
import { createStepControlTools } from './djinnbot-tools/step-control.js';
import { createMemoryTools } from './djinnbot-tools/memory.js';
import { createMemoryGraphTools } from './djinnbot-tools/memory-graph.js';
import { createMemoryContextTools } from './djinnbot-tools/memory-context.js';
import { createMessagingTools } from './djinnbot-tools/messaging.js';
import { createResearchTools } from './djinnbot-tools/research.js';
import { createSkillsTools } from './djinnbot-tools/skills.js';
import { createOnboardingTools } from './djinnbot-tools/onboarding.js';
import { createGitHubTools } from './djinnbot-tools/github.js';
import { createPulseProjectsTools } from './djinnbot-tools/pulse-projects.js';
import { createPulseTasksTools } from './djinnbot-tools/pulse-tasks.js';
import { createSecretsTools } from './djinnbot-tools/secrets.js';
import { createSlackTools } from './djinnbot-tools/slack.js';
import { createTelegramTools } from './djinnbot-tools/telegram.js';
import { createWhatsAppTools } from './djinnbot-tools/whatsapp.js';
import { createSignalTools } from './djinnbot-tools/signal.js';
import { createSpawnExecutorTools } from './djinnbot-tools/spawn-executor.js';
import { createExecutorControlTools } from './djinnbot-tools/executor-control.js';
import { createSwarmExecutorTools } from './djinnbot-tools/swarm-executor.js';
import { createWorkLedgerTools } from './djinnbot-tools/work-ledger.js';
import { createRunHistoryTools } from './djinnbot-tools/run-history.js';
import { createFocusedAnalysisTools } from './djinnbot-tools/focused-analysis.js';
import { createCodeGraphTools } from './djinnbot-tools/code-graph.js';
import { createTryApproachesTools } from './djinnbot-tools/try-approaches.js';
import type { MemoryRetrievalTracker } from './djinnbot-tools/memory-scoring.js';

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
  /** DjinnBot API base URL — used for shared vault API calls and other services. */
  apiBaseUrl: string;
  /** Absolute path to the agents directory — used for skill registry. */
  agentsDir?: string;
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
   * Whether this container is running an executor session
   * (SESSION_SOURCE=executor). Executor sessions are autonomous coding
   * sessions that should NOT have step-control (complete/fail), pulse
   * planning tools (spawn_executor, pulse-projects), or work dispatch
   * tools. They just do their coding work and exit.
   */
  isExecutorSession?: boolean;
  /**
   * Whether this container is running an onboarding session
   * (ONBOARDING_SESSION_ID env var is set).
   * Onboarding tools are included only when true.
   */
  isOnboardingSession?: boolean;
  /** Memory retrieval tracker for adaptive scoring. Shared with the runner. */
  retrievalTracker?: MemoryRetrievalTracker;
}

export function createDjinnBotTools(config: DjinnBotToolsConfig): AgentTool[] {
  const {
    publisher, redis, requestIdRef, agentId, sessionId, vaultPath, apiBaseUrl,
    onComplete, onFail, pulseColumns,
    isPipelineRun = false,
    isPulseSession = false,
    isExecutorSession = false,
    isOnboardingSession = false,
    retrievalTracker,
  } = config;

  // Chat-style sessions: no step-control tools, no auto-continuation.
  // Pipeline + executor + onboarding sessions have step-control and auto-continuation.
  // Pulse sessions are chat-style (planner does its work and ends naturally).
  //
  // Pipeline/Onboarding → complete/fail (step-control.ts)
  // Executor → executor_complete/executor_fail (executor-control.ts)
  // Pulse/Chat → no step control (session ends when model stops)
  const isChatSession = !isPipelineRun && !isExecutorSession && !isOnboardingSession;

  return [
    // Step control (complete/fail) — pipeline runs only
    ...(isPipelineRun ? createStepControlTools({ onComplete, onFail }) : []),

    // Executor control (executor_complete/executor_fail) — executor sessions only.
    // Stores structured outputs on the Run record AND signals session end.
    ...(isExecutorSession ? createExecutorControlTools({
      onComplete, onFail, apiBaseUrl, runId: sessionId,
    }) : []),

    ...createMemoryTools({ publisher, agentId, vaultPath, apiBaseUrl, retrievalTracker }),

    ...createMemoryGraphTools({ publisher, agentId, vaultPath, apiBaseUrl }),

    ...createMemoryContextTools({ agentId, vaultPath, apiBaseUrl }),

    ...createMessagingTools({ publisher, requestIdRef, vaultPath }),

    ...createWorkLedgerTools({ redis, agentId, sessionId }),

    ...createResearchTools({ agentId }),

    ...createSkillsTools({ agentId, apiBaseUrl }),

    ...createGitHubTools({ apiBaseUrl }),

    ...createSecretsTools({ agentId, apiBaseUrl }),

    ...createSlackTools({ agentId, apiBaseUrl }),

    ...createTelegramTools({ agentId, apiBaseUrl }),

    ...createWhatsAppTools({ agentId, apiBaseUrl }),

    ...createSignalTools({ agentId, apiBaseUrl }),

    // Pulse/pipeline tools — included for all sessions EXCEPT executors.
    // Executors are autonomous coding sessions that should only have coding tools,
    // not planning/dispatch tools. They don't need to query projects, manage tasks,
    // or spawn other executors.
    ...(!isExecutorSession ? createPulseProjectsTools({ agentId, apiBaseUrl, pulseColumns }) : []),

    ...(!isExecutorSession ? createPulseTasksTools({ agentId, apiBaseUrl }) : []),

    // Spawn executor — available in pulse sessions for plan-then-execute workflow
    // (excluded from executors — they should not spawn other executors)
    ...(!isExecutorSession ? createSpawnExecutorTools({ publisher, requestIdRef, agentId, apiBaseUrl }) : []),

    // Swarm executor — parallel multi-task execution with dependency DAG
    // (excluded from executors)
    ...(!isExecutorSession ? createSwarmExecutorTools({ publisher, requestIdRef, agentId, apiBaseUrl }) : []),

    // Run history — execution memory for learning from past attempts
    ...createRunHistoryTools({ agentId, apiBaseUrl }),

    // Focused analysis — lightweight analytical delegation to a sub-model
    ...createFocusedAnalysisTools({ agentId }),

    // Code knowledge graph — search, context, impact analysis, change mapping
    ...createCodeGraphTools({ apiBaseUrl }),

    // Speculative execution — try competing approaches in parallel, auto-select winner
    ...createTryApproachesTools({ publisher, requestIdRef, agentId, apiBaseUrl }),

    // Onboarding tools — only for onboarding sessions (ONBOARDING_SESSION_ID is set)
    ...(isOnboardingSession ? createOnboardingTools({ agentId, apiBaseUrl }) : []),
  ];
}
