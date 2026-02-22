import { authFetch } from './api/auth-fetch.js';
import { EventBus } from './events/event-bus.js';
import { Store } from './db/store.js';
import { ApiStore } from './db/api-store.js';
import { PipelineEngine } from './engine/pipeline-engine.js';
import { AgentExecutor, type AgentRunner } from './runtime/agent-executor.js';
import { PersonaLoader } from './runtime/persona-loader.js';
import { MockRunner } from './runtime/mock-runner.js';
import { PiMonoRunner } from './runtime/pi-mono-runner.js';
import type { PiMonoRunnerConfig } from './runtime/pi-mono-runner.js';
import { ContainerRunner } from './container/runner.js';
import { ProgressFileManager } from './memory/progress-file.js';
import { KnowledgeStore } from './memory/knowledge-store.js';
import { ContextAssembler } from './memory/context-assembler.js';
import { AgentMemoryManager, AgentMemory } from './memory/agent-memory.js';
import { AgentLifecycleTracker } from './lifecycle/agent-lifecycle-tracker.js';
import { parsePipeline } from './pipeline/parser.js';
import { readdir } from 'node:fs/promises';
import { join } from 'node:path';
import type { PipelineConfig } from './types/pipeline.js';
import type { PipelineRun } from './types/state.js';
import { runChannel } from './events/channels.js';
import { AgentRegistry } from './agents/index.js';
import { WorkspaceManager } from './runtime/workspace-manager.js';
import { AgentLifecycleManager } from './runtime/agent-lifecycle.js';
import { AgentInbox } from './events/agent-inbox.js';
import { AgentPulse } from './runtime/agent-pulse.js';
import { StandaloneSessionRunner } from './runtime/standalone-session.js';
import type { StandaloneSessionOptions, StandaloneSessionResult } from './runtime/standalone-session.js';
import { Redis } from 'ioredis';
import { TaskRunTracker } from './task/task-run-tracker.js';
import { SessionPersister } from './sessions/session-persister.js';

// Dynamic import for SlackBridge to avoid circular dependency
// @djinnbot/slack depends on @djinnbot/core for types
type SlackBridgeType = any;

export interface DjinnBotConfig {
  redisUrl: string;
  databasePath: string;
  dataDir: string;           // For progress files
  agentsDir: string;          // Agent persona directory
  pipelinesDir: string;       // Pipeline YAML directory
  agentRunner?: AgentRunner;  // Custom agent runner (defaults to PiMonoRunner or ContainerRunner)
  useApiStore?: boolean;      // Use HTTP API instead of SQLite
  apiUrl?: string;            // API base URL when useApiStore is true
  useContainerRunner?: boolean; // Use container-based agent runner (spawns containers per run)
}

export class DjinnBot {
  private eventBus: EventBus;
  private store: Store;
  private engine: PipelineEngine;
  private executor: AgentExecutor;
  private personaLoader: PersonaLoader;
  private progressFiles: ProgressFileManager;
  private knowledgeStore: KnowledgeStore;
  private contextAssembler: ContextAssembler;
  private pipelines: Map<string, PipelineConfig> = new Map();
  private agentRegistry: AgentRegistry;
  slackBridge?: SlackBridgeType;
  private agentMemoryManager?: AgentMemoryManager;
  private lifecycleManager: AgentLifecycleManager;
  private lifecycleTracker?: AgentLifecycleTracker;
  private agentInbox: AgentInbox;
  private agentPulse?: AgentPulse;
  private sessionRunner?: StandaloneSessionRunner;
  private taskRunTracker: TaskRunTracker | null = null;
  private redis?: Redis;
  private sessionPersister?: SessionPersister;

  private workspaceManager: WorkspaceManager;

  constructor(private config: DjinnBotConfig) {
    // Initialize store (SQLite or API-based)
    if (config.useApiStore) {
      this.store = new ApiStore({ apiUrl: config.apiUrl || 'http://api:8000' }) as unknown as Store;
    } else {
      this.store = new Store({ databasePath: config.databasePath });
    }
    this.store.initialize();

    // Initialize workspace manager with repository lookup callback
    this.workspaceManager = new WorkspaceManager({
      getProjectRepository: (projectId: string) => this.store.getProjectRepository(projectId)
    });
    this.eventBus = new EventBus({ redisUrl: config.redisUrl });

    this.personaLoader = new PersonaLoader(config.agentsDir);
    this.agentRegistry = new AgentRegistry(config.agentsDir);
    this.progressFiles = new ProgressFileManager(config.dataDir);
    this.knowledgeStore = new KnowledgeStore(this.store);
    this.lifecycleManager = new AgentLifecycleManager(this.eventBus);
    this.agentInbox = new AgentInbox(config.redisUrl);
    
    this.contextAssembler = new ContextAssembler({
      progressFiles: this.progressFiles,
      getKnowledge: async (runId: string) => {
        const entries = await this.knowledgeStore.getAll(runId);
        return entries.map(e => ({
          category: e.category,
          content: e.content,
          importance: e.importance,
        }));
      },
      getOutputs: (runId: string) => this.store.getOutputs(runId),
      // NEW: Agent memory context
      getAgentMemoryContext: async (agentId, runId, stepId, taskDescription) => {
        if (!this.agentMemoryManager) return '';
        try {
          const memory = await this.agentMemoryManager.get(agentId);
          return await memory.wake({ runId, stepId, taskDescription });
        } catch (err) {
          console.error('[DjinnBot] Agent memory wake failed:', err);
          return '';
        }
      },
      // Phase 9: Inbox messages injected into agent context
      getUnreadMessages: async (agentId: string) => {
        try {
          return await this.agentInbox.getUnread(agentId);
        } catch (err) {
          console.error('[DjinnBot] Failed to get unread messages:', err);
          return [];
        }
      },
      markMessagesRead: async (agentId: string, lastMessageId: string) => {
        try {
          await this.agentInbox.markRead(agentId, lastMessageId);
        } catch (err) {
          console.error('[DjinnBot] Failed to mark messages read:', err);
        }
      },
      // Phase 9: Installed tools injected into agent context
      getInstalledTools: (agentId: string) => {
        return this.lifecycleManager.getInstalledTools(agentId);
      },
      // Git context — branch, base, and recent step commits for the agent's workspace
      getWorkspaceGitContext: (runId: string) => {
        return this.workspaceManager.getWorkspaceGitContext(runId);
      },
    });
    
    // Create TaskRunTracker before engine so we can pass callbacks
    this.taskRunTracker = new TaskRunTracker({
      store: this.store,
      eventBus: this.eventBus,
    });

    this.engine = new PipelineEngine({
      eventBus: this.eventBus,
      store: this.store,
      onRunCompleted: async (runId, outputs) => {
        await this.taskRunTracker?.handleRunCompleted(runId, outputs);
      },
      onRunFailed: async (runId, error) => {
        await this.taskRunTracker?.handleRunFailed(runId, error);
      },
    });
    
    // Initialize session persister BEFORE creating runner (requires DJINNBOT_API_URL)
    const apiBaseUrl = process.env.DJINNBOT_API_URL;
    if (apiBaseUrl && config.redisUrl) {
      // Need Redis connection for session persister - create temporary one
      const tempRedis = new Redis(config.redisUrl);
      this.sessionPersister = new SessionPersister(apiBaseUrl, tempRedis);
      console.log('[DjinnBot] Session persister initialized with API:', apiBaseUrl);
    }

    // Create agent runner - either ContainerRunner or PiMonoRunner
    const agentRunner = config.agentRunner ?? this.createAgentRunner(config);
    
    this.executor = new AgentExecutor({
      eventBus: this.eventBus,
      agentRunner,
      agentMemoryManager: undefined as any, // Set after initialize()
      personaLoader: this.personaLoader,
      pipelines: this.pipelines,
      getOutputs: (runId: string) => this.store.getOutputs(runId),
      getRunTask: async (runId: string) => (await this.store.getRun(runId))?.taskDescription || '',
      getRunHumanContext: async (runId: string) => (await this.store.getRun(runId))?.humanContext,
      getLoopState: (runId: string, stepId: string) => {
        const state = this.store.getLoopState(runId, stepId);
        if (!state) return null;
        return {
          currentIndex: state.currentIndex,
          items: state.items.map(item => ({
            data: item.data,
            status: item.status,
          })),
        };
      },
      contextAssembler: this.contextAssembler,
      progressFiles: this.progressFiles,
      workspaceManager: this.workspaceManager,
      lifecycleManager: this.lifecycleManager,
      getRunProjectId: async (runId: string) => (await this.store.getRun(runId))?.projectId,
      getRunUserId: async (runId: string) => (await this.store.getRun(runId))?.userId,
      getRunModelOverride: async (runId: string) => (await this.store.getRun(runId))?.modelOverride,
      getRunTaskBranch: async (runId: string) => (await this.store.getRun(runId))?.taskBranch,
      sessionPersister: this.sessionPersister,
      apiBaseUrl: config.apiUrl || process.env.DJINNBOT_API_URL || process.env.DJINNBOT_API_URL?.replace(/\/api\/?$/, '') || 'http://api:8000',
      getAgentDefaultModel: (agentId: string) => this.agentRegistry.get(agentId)?.config.model,
    });
  }

  /**
   * Create the agent runner based on config.
   * Uses ContainerRunner if useContainerRunner is true, otherwise PiMonoRunner.
   */
  private createAgentRunner(config: DjinnBotConfig): AgentRunner {
    if (config.useContainerRunner) {
      console.log('[DjinnBot] Using ContainerRunner (container-based execution)');
      return new ContainerRunner({
        redisUrl: config.redisUrl,
        dataPath: config.dataDir,
        apiBaseUrl: config.apiUrl || process.env.DJINNBOT_API_URL || process.env.DJINNBOT_API_URL || 'http://api:8000',
        onStreamChunk: (agentId, runId, stepId, chunk) => {
          // Publish to EventBus for SSE streaming
          this.eventBus.publish(runChannel(runId), {
            type: 'STEP_OUTPUT',
            runId,
            stepId,
            chunk,
            timestamp: Date.now(),
          }).catch(err => console.error('[DjinnBot] Failed to publish stream chunk:', err));
          
          // Persist to session database.
          // Standalone/pulse sessions use runId as the session key directly.
          // Pipeline step sessions use the compound key runId_stepId.
          if (this.sessionPersister) {
            const sessionKey = runId.startsWith('standalone_') ? runId : `${runId}_${stepId}`;
            this.sessionPersister.addEvent(sessionKey, {
              type: 'output',
              timestamp: Date.now(),
              data: {
                stream: 'stdout',
                content: chunk,
              },
            }).catch(err => console.error('[DjinnBot] Failed to persist output event:', err));
          }
        },
        onThinkingChunk: (agentId, runId, stepId, chunk) => {
          // Publish to EventBus for SSE streaming
          this.eventBus.publish(runChannel(runId), {
            type: 'STEP_THINKING',
            runId,
            stepId,
            chunk,
            timestamp: Date.now(),
          }).catch(err => console.error('[DjinnBot] Failed to publish thinking chunk:', err));
          
          // Persist to session database.
          // Standalone/pulse sessions use runId as the session key directly.
          // Pipeline step sessions use the compound key runId_stepId.
          if (this.sessionPersister) {
            const sessionKey = runId.startsWith('standalone_') ? runId : `${runId}_${stepId}`;
            this.sessionPersister.addEvent(sessionKey, {
              type: 'thinking',
              timestamp: Date.now(),
              data: {
                thinking: chunk,
              },
            }).catch(err => console.error('[DjinnBot] Failed to persist thinking event:', err));
          }
        },
        onToolCallStart: (agentId, runId, stepId, toolName, toolCallId, args) => {
          // Publish to EventBus for SSE streaming
          this.eventBus.publish(runChannel(runId), {
            type: 'TOOL_CALL_START',
            runId, stepId, toolName, toolCallId,
            args: JSON.stringify(args),
            timestamp: Date.now(),
          }).catch(err => console.error('[DjinnBot] Failed to publish TOOL_CALL_START:', err));
          
          // Persist to session database.
          // Standalone/pulse sessions use runId as the session key directly.
          // Pipeline step sessions use the compound key runId_stepId.
          if (this.sessionPersister) {
            const sessionKey = runId.startsWith('standalone_') ? runId : `${runId}_${stepId}`;
            this.sessionPersister.addEvent(sessionKey, {
              type: 'tool_start',
              timestamp: Date.now(),
              data: {
                toolName,
                toolCallId,
                args,
              },
            }).catch(err => console.error('[DjinnBot] Failed to persist tool_start event:', err));
          }
        },
        onToolCallEnd: (agentId, runId, stepId, toolName, toolCallId, result, isError, durationMs) => {
          // Publish to EventBus for SSE streaming
          this.eventBus.publish(runChannel(runId), {
            type: 'TOOL_CALL_END',
            runId, stepId, toolName, toolCallId,
            result: result.slice(0, 10000),
            isError, durationMs,
            timestamp: Date.now(),
          }).catch(err => console.error('[DjinnBot] Failed to publish TOOL_CALL_END:', err));
          
          // Persist to session database.
          // Standalone/pulse sessions use runId as the session key directly.
          // Pipeline step sessions use the compound key runId_stepId.
          if (this.sessionPersister) {
            const sessionKey = runId.startsWith('standalone_') ? runId : `${runId}_${stepId}`;
            this.sessionPersister.addEvent(sessionKey, {
              type: 'tool_end',
              timestamp: Date.now(),
              data: {
                toolName,
                toolCallId,
                result,
                success: !isError,
                durationMs,
              },
            }).catch(err => console.error('[DjinnBot] Failed to persist tool_end event:', err));
          }
        },
        onMessageAgent: async (agentId, runId, stepId, to, message, priority, messageType) => {
          const msgId = await this.agentInbox.send({
            from: agentId,
            to,
            message,
            priority: priority as any,
            type: messageType as any,
            timestamp: Date.now(),
          });
          console.log(`[DjinnBot] Container agent ${agentId} → ${to}: "${message.slice(0, 80)}" (${msgId})`);

          // If urgent priority, publish a wake notification so AgentPulse can trigger immediately
          if (priority === 'urgent' || priority === 'high') {
            await this.agentInbox.publishWake(to, agentId, priority, messageType, msgId);
          }

          return msgId;
        },
        onSlackDm: async (agentId, runId, stepId, message, urgent) => {
          if (!this.slackBridge) {
            return 'Slack bridge not started - cannot send DM to user.';
          }
          try {
            await this.slackBridge.sendDmToUser(agentId, message, urgent);
            console.log(`[DjinnBot] Container agent ${agentId} sent Slack DM: "${message.slice(0, 80)}..."`);
            return `Message sent to user via Slack DM${urgent ? ' (marked urgent)' : ''}.`;
          } catch (err) {
            console.error(`[DjinnBot] Failed to send Slack DM from container:`, err);
            return `Failed to send Slack DM: ${(err as Error).message}`;
          }
        },
      });
    }

    // Default: PiMonoRunner (in-process execution)
    console.log('[DjinnBot] Using PiMonoRunner (in-process execution)');
    return new PiMonoRunner({
      // Provide API base URL so keys set via UI are fetched fresh on every run.
      apiBaseUrl: config.apiUrl || process.env.DJINNBOT_API_URL || process.env.DJINNBOT_API_URL?.replace(/\/api\/?$/, '') || 'http://api:8000',
      onStreamChunk: (agentId, runId, stepId, chunk) => {
        this.eventBus.publish(runChannel(runId), {
          type: 'STEP_OUTPUT',
          runId,
          stepId,
          chunk,
          timestamp: Date.now(),
        }).catch(err => console.error('[DjinnBot] Failed to publish stream chunk:', err));
      },
      onThinkingChunk: (agentId, runId, stepId, chunk) => {
        this.eventBus.publish(runChannel(runId), {
          type: 'STEP_THINKING',
          runId,
          stepId,
          chunk,
          timestamp: Date.now(),
        }).catch(err => console.error('[DjinnBot] Failed to publish thinking chunk:', err));
      },
      onShareKnowledge: async (agentId, runId, stepId, entry) => {
        await this.knowledgeStore.share(runId, agentId, entry.content, {
          category: entry.category as any,
          importance: entry.importance as any,
        });
        if (this.agentMemoryManager && (entry.importance === 'high' || entry.importance === 'critical')) {
          try {
            const memory = await this.agentMemoryManager.get(agentId);
            await memory.remember(
              entry.category === 'decision' ? 'decision' : entry.category === 'issue' ? 'lesson' : 'fact',
              `[${entry.category}] ${entry.content.slice(0, 80)}`,
              entry.content,
              { shared: true, importance: entry.importance, runId }
            );
          } catch (err) {
            console.error('[DjinnBot] Failed to persist knowledge to agent memory:', err);
          }
        }
      },
      onRemember: async (agentId, runId, stepId, entry) => {
        if (!this.agentMemoryManager) return;
        console.log(`[DjinnBot] ${agentId} remember(${entry.type}, "${entry.title}", shared=${!!entry.shared})`);
        try {
          const memory = await this.agentMemoryManager.get(agentId);
          await memory.remember(
            entry.type as any,
            entry.title,
            entry.content,
            { shared: entry.shared, runId }
          );
        } catch (err) {
          console.error('[DjinnBot] Failed to remember:', err);
        }
      },
      onRecall: async (agentId, runId, stepId, query, scope, profile, budget) => {
        if (!this.agentMemoryManager) return 'Memory not initialized.';
        try {
          const memory = await this.agentMemoryManager.get(agentId);
          const results = await memory.recall(query, {
            limit: 5,
            personalOnly: scope === 'personal',
            profile: profile as any,
            budget,
          });
          if (results.length === 0) return 'No relevant memories found.';
          return results.map(r => {
            let result = `**[${r.category}] ${r.title}** (score: ${r.score.toFixed(2)})`;
            if (r.source) result += ` [source: ${r.source}]`;
            result += `\n${r.snippet || r.content.slice(0, 200)}`;
            if (r.graphConnections && r.graphConnections.length > 0) {
              result += `\n_Connected to: ${r.graphConnections.slice(0, 3).join(', ')}_`;
            }
            return result;
          }).join('\n\n');
        } catch (err) {
          console.error('[DjinnBot] Failed to recall:', err);
          return 'Memory search failed.';
        }
      },
      onGraphQuery: async (agentId, runId, stepId, action, nodeId, query, maxHops) => {
        if (!this.agentMemoryManager) return 'Memory not initialized.';
        try {
          const memory = await this.agentMemoryManager.get(agentId);
          
          if (action === 'summary') {
            const graph = await memory.queryGraph();
            return JSON.stringify(graph.stats, null, 2) + '\n\nTop nodes:\n' +
              graph.nodes.sort((a, b) => b.degree - a.degree).slice(0, 10)
                .map(n => `- ${n.id} (${n.type}, ${n.degree} connections)`).join('\n');
          } else if (action === 'neighbors' && nodeId) {
            const neighbors = await memory.getNeighbors(nodeId, maxHops || 1);
            return `Neighbors of ${nodeId} (${maxHops || 1} hops):\n` +
              neighbors.nodes.map(n => `- ${n.id} [${n.type}] "${n.title}"`).join('\n') + '\n\nEdges:\n' +
              neighbors.edges.map(e => `- ${e.source} → ${e.target} (${e.type})`).join('\n');
          } else if (action === 'search' && query) {
            const graph = await memory.queryGraph();
            const matches = graph.nodes.filter(n =>
              n.title.toLowerCase().includes(query.toLowerCase()) ||
              n.id.toLowerCase().includes(query.toLowerCase())
            );
            return matches.length === 0 ? 'No matching nodes found.' :
              matches.map(n => `- ${n.id} [${n.type}] "${n.title}" (${n.degree} connections)`).join('\n');
          }
          return 'Invalid graph query action.';
        } catch (err) {
          console.error('[DjinnBot] Failed to query graph:', err);
          return 'Graph query failed.';
        }
      },
      onLinkMemory: async (agentId, runId, stepId, fromId, toId, relationType) => {
        if (!this.agentMemoryManager) return;
        try {
          const memory = await this.agentMemoryManager.get(agentId);
          await memory.linkMemories(fromId, toId, relationType as any);
        } catch (err) {
          console.error('[DjinnBot] Failed to link memories:', err);
        }
      },
      onCheckpoint: async (agentId, runId, stepId, workingOn, focus, decisions) => {
        if (!this.agentMemoryManager) return;
        try {
          const memory = await this.agentMemoryManager.get(agentId);
          const note = `Checkpoint: ${workingOn}${focus ? ` | Focus: ${focus}` : ''}${decisions?.length ? ` | Decisions: ${decisions.join(', ')}` : ''}`;
          await memory.capture(note);
        } catch (err) {
          console.error('[DjinnBot] Failed to save checkpoint:', err);
        }
      },
      onToolCallStart: (agentId, runId, stepId, toolName, toolCallId, args) => {
        this.eventBus.publish(runChannel(runId), {
          type: 'TOOL_CALL_START',
          runId, stepId, toolName, toolCallId, args,
          timestamp: Date.now(),
        }).catch(err => console.error('[DjinnBot] Failed to publish TOOL_CALL_START:', err));
      },
      onToolCallEnd: (agentId, runId, stepId, toolName, toolCallId, result, isError, durationMs) => {
        this.eventBus.publish(runChannel(runId), {
          type: 'TOOL_CALL_END',
          runId, stepId, toolName, toolCallId,
          result: result.slice(0, 10000),
          isError, durationMs,
          timestamp: Date.now(),
        }).catch(err => console.error('[DjinnBot] Failed to publish TOOL_CALL_END:', err));
      },
      onAgentState: (agentId, runId, stepId, state, toolName) => {
        this.eventBus.publish(runChannel(runId), {
          type: 'AGENT_STATE',
          runId, stepId, state, toolName,
          timestamp: Date.now(),
        }).catch(err => console.error('[DjinnBot] Failed to publish AGENT_STATE:', err));
      },
      onMessageAgent: async (agentId, runId, stepId, to, message, priority, type) => {
        const msgId = await this.agentInbox.send({
          from: agentId,
          to,
          message,
          priority: priority as any,
          type: type as any,
          timestamp: Date.now(),
        });
        console.log(`[DjinnBot] Agent ${agentId} → ${to}: "${message.slice(0, 80)}" (${msgId})`);

        // If urgent/high priority, publish wake notification
        if (priority === 'urgent' || priority === 'high') {
          await this.agentInbox.publishWake(to, agentId, priority, type, msgId);
        }

        return msgId;
      },
      onSlackDm: async (agentId, runId, stepId, message, urgent) => {
        if (!this.slackBridge) {
          return 'Slack bridge not started - cannot send DM to user.';
        }
        try {
          await this.slackBridge.sendDmToUser(agentId, message, urgent);
          console.log(`[DjinnBot] Agent ${agentId} sent Slack DM to user: "${message.slice(0, 80)}..."`);
          return `Message sent to user via Slack DM${urgent ? ' (marked urgent)' : ''}.`;
        } catch (err) {
          console.error(`[DjinnBot] Failed to send Slack DM to user:`, err);
          return `Failed to send Slack DM: ${(err as Error).message}`;
        }
      },
      onResearch: async (_agentId, _runId, _stepId, query, focus, model) => {
        const { performResearch } = await import('./runtime/research.js');
        return performResearch(query, focus, model);
      },
      onOnboardingHandoff: async (agentId, runId, _stepId, nextAgent, summary, context) => {
        // runId for onboarding sessions is the chat_session_id (e.g. "onb_stas_<onb_id>_<ts>")
        // Extract onboarding_session_id from the runId format: onb_<agentId>_<onbSessionId>_<ts>
        const parts = runId.split('_');
        // Format: onb_{agentId}_{onbSessionId}_{ts} — but onbSessionId itself has underscores
        // We stored it as: onb_<agentId>_<onb_session_id>_<timestamp>
        // The onboarding_session_id starts with "onb_" so find it by index
        const onboardingSessionId = parts.slice(2, -1).join('_');
        if (!onboardingSessionId) {
          console.warn(`[DjinnBot] onboarding_handoff: could not extract session ID from runId ${runId}`);
          return 'Handoff recorded — passing you to the next agent now.';
        }
        try {
          const apiUrl = process.env.DJINNBOT_API_URL || 'http://localhost:8000';
          const response = await authFetch(`${apiUrl}/v1/onboarding/sessions/${onboardingSessionId}/handoff`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              next_agent_id: nextAgent,
              context_update: context,
              summary,
            }),
          });
          if (!response.ok) {
            const text = await response.text();
            console.error(`[DjinnBot] Handoff API call failed: ${response.status} ${text}`);
          }
          console.log(`[DjinnBot] Agent ${agentId} handed off to ${nextAgent} in onboarding session ${onboardingSessionId}`);
        } catch (err) {
          console.error(`[DjinnBot] onboarding_handoff failed:`, err);
        }
        return `Handing off to ${nextAgent}. ${summary}`;
      },
    });
  }

  /** Initialize the bot - call after construction to discover agents */
  async initialize(): Promise<void> {
    await this.agentRegistry.discover();

    // Create workspace directories
    const workspacesDir = join(this.config.dataDir, 'workspaces');
    const { mkdirSync, existsSync } = await import('node:fs');
    const agentIds = this.agentRegistry.getIds();
    for (const agentId of agentIds) {
      const agentWorkspace = join(workspacesDir, agentId);
      if (!existsSync(agentWorkspace)) {
        mkdirSync(agentWorkspace, { recursive: true });
      }
    }
    console.log('[DjinnBot] Agent workspaces initialized');

    // Initialize agent memory vaults
    const vaultsDir = join(this.config.dataDir, 'vaults');
    this.agentMemoryManager = new AgentMemoryManager(vaultsDir);
    await this.agentMemoryManager.initialize(this.agentRegistry.getIds());
    console.log('[DjinnBot] Agent memory vaults initialized');

    // NOTE: VaultEmbedWatcher is intentionally NOT started here.
    // main.ts creates and starts a single VaultEmbedWatcher instance after DjinnBot
    // initializes. Starting a second instance here caused concurrent qmd processes
    // hitting the same SQLite index file, producing "initializeDatabase" lock errors
    // and silently failing to index shared vault memories written by onboarding agents.

    // Wire memory manager into executor
    (this.executor as any).agentMemoryManager = this.agentMemoryManager;

    // Initialize lifecycle tracker (needs Redis for Activity tab)
    this.redis = new Redis(this.config.redisUrl);
    this.lifecycleTracker = new AgentLifecycleTracker({
      redis: this.redis,
    });
    // Wire lifecycle tracker into executor
    (this.executor as any).lifecycleTracker = this.lifecycleTracker;
    console.log('[DjinnBot] Agent lifecycle tracker initialized');

    // Session persister was initialized in constructor (before runner creation)
    // Here we just update to use the main redis connection if available
    if (this.sessionPersister && this.redis) {
      this.sessionPersister = new SessionPersister(process.env.DJINNBOT_API_URL!, this.redis);
      console.log('[DjinnBot] Session persister reconnected to main Redis');
    } else if (!this.sessionPersister) {
      console.log('[DjinnBot] Session persistence disabled (DJINNBOT_API_URL not set)');
    }

    // Phase 9: Initialize lifecycle manager for all agents
    for (const agentId of this.agentRegistry.getIds()) {
      this.lifecycleManager.initAgent(agentId);
    }
    console.log('[DjinnBot] Agent lifecycle manager initialized');

    // Phase 9: Connect agent inbox
    await this.agentInbox.connect();
    console.log('[DjinnBot] Agent inbox connected');

    // Phase 9: Start pulse system with advanced scheduling
    this.agentPulse = new AgentPulse(
      {
        intervalMs: 30 * 60 * 1000, // 30 minutes (default fallback)
        timeoutMs: 60 * 1000,       // 60 seconds per agent
        agentIds: this.agentRegistry.getIds(),
        redisUrl: this.config.redisUrl,    // Enable wake-on-message
      },
      {
        getAgentState: (agentId) => this.lifecycleManager.getState(agentId),
        getUnreadCount: (agentId) => this.agentInbox.getUnreadCount(agentId),
        getUnreadMessages: (agentId) => this.agentInbox.getUnread(agentId) as any,
        runPulseSession: (agentId, context) => this.runPulseSession(agentId, context),
        getAgentPulseSchedule: async (agentId) => this.loadAgentPulseSchedule(agentId),
        getAgentPulseRoutines: async (agentId) => this.fetchAgentPulseRoutines(agentId),
        getAssignedTasks: async (agentId) => this.fetchAssignedTasks(agentId),
        startPulseSession: (agentId, sessionId) => {
          // Load per-agent maxConcurrent from config.yml coordination settings
          const maxConcurrent = this.getAgentMaxConcurrentPulseSessions(agentId);
          return this.lifecycleManager.startPulseSession(agentId, sessionId, maxConcurrent);
        },
        endPulseSession: (agentId, sessionId) => this.lifecycleManager.endPulseSession(agentId, sessionId),
        maxConcurrentPulseSessions: 2, // Global default — per-agent overrides via startPulseSession
        onRoutinePulseComplete: (routineId) => this.updateRoutineStats(routineId),
      },
    );
    await this.agentPulse.start();
    console.log('[DjinnBot] Agent pulse system started');

    // Subscribe to pulse schedule updates from dashboard
    await this.subscribeToPulseScheduleUpdates();
    console.log('[DjinnBot] Pulse schedule update listener started');

    // Initialize standalone session runner
    this.sessionRunner = new StandaloneSessionRunner(
      this.executor.getAgentRunner(),
      {
        dataDir: this.config.dataDir,
        agentsDir: this.config.agentsDir,
        sessionPersister: this.sessionPersister,
      }
    );
    console.log('[DjinnBot] Standalone session runner initialized');
  }

  /** Get the agent registry */
  getAgentRegistry(): AgentRegistry {
    return this.agentRegistry;
  }

  /** Expose WorkspaceManager for engine-level workspace operations (e.g. task worktree creation). */
  getWorkspaceManager(): WorkspaceManager {
    return this.workspaceManager;
  }

  /** Get the pulse timeline for all agents */
  getPulseTimeline(hours: number = 24): import('./runtime/pulse-types.js').PulseTimelineResponse | null {
    if (!this.agentPulse) {
      return null;
    }
    return this.agentPulse.getTimeline(hours);
  }

  /**
   * Read maxConcurrentPulseSessions from an agent's config.yml coordination section.
   * Returns the configured value, or 2 as default.
   */
  private getAgentMaxConcurrentPulseSessions(agentId: string): number {
    try {
      const configPath = join(this.config.agentsDir, agentId, 'config.yml');
      const fs = require('node:fs');
      const yaml = require('yaml');
      const content = fs.readFileSync(configPath, 'utf-8');
      const config = yaml.parse(content) || {};
      return config?.coordination?.max_concurrent_pulse_sessions ?? 2;
    } catch {
      return 2; // Default
    }
  }

  /** Load pulse schedule config for an agent from config.yml */
  private async loadAgentPulseSchedule(agentId: string): Promise<Partial<import('./runtime/pulse-types.js').PulseScheduleConfig>> {
    const configPath = join(this.config.agentsDir, agentId, 'config.yml');
    
    try {
      const { readFile } = await import('node:fs/promises');
      const { parse: parseYaml } = await import('yaml');
      const content = await readFile(configPath, 'utf-8');
      const config = parseYaml(content) || {};
      
      // Parse blackouts from YAML format
      const blackouts: import('./runtime/pulse-types.js').PulseBlackout[] = [];
      const rawBlackouts = config.pulse_blackouts || [];
      for (const b of rawBlackouts) {
        blackouts.push({
          type: b.type || 'recurring',
          label: b.label,
          startTime: b.start_time || b.startTime,
          endTime: b.end_time || b.endTime,
          daysOfWeek: b.days_of_week || b.daysOfWeek,
          start: b.start,
          end: b.end,
        });
      }
      
      return {
        enabled: config.pulse_enabled !== false,
        intervalMinutes: config.pulse_interval_minutes || 30,
        offsetMinutes: config.pulse_offset_minutes || 0,
        blackouts,
        oneOffs: config.pulse_one_offs || [],
        maxConsecutiveSkips: config.pulse_max_consecutive_skips || 5,
      };
    } catch {
      // Return defaults if config doesn't exist
      return {};
    }
  }

  /** Trigger a manual pulse for an agent */
  async triggerPulse(agentId: string): Promise<{ skipped: boolean; unreadCount: number; errors: string[]; actions?: string[]; output?: string } | null> {
    if (!this.agentPulse) {
      return null;
    }
    return this.agentPulse.triggerPulse(agentId);
  }

  /**
   * Subscribe to pulse schedule update events from the dashboard.
   * When dashboard updates an agent's pulse schedule (enable/disable, change interval, etc.),
   * the Python API publishes to Redis and we reload the schedule here.
   */
  private async subscribeToPulseScheduleUpdates(): Promise<void> {
    if (!this.redis) {
      console.warn('[DjinnBot] Redis not available, pulse schedule hot-reload disabled');
      return;
    }

    // Create a dedicated subscriber for pulse schedule updates
    const subscriber = this.redis.duplicate();
    
    subscriber.on('error', (err) => {
      console.error('[DjinnBot] Pulse schedule subscriber error:', err.message);
    });

    subscriber.on('message', async (channel, message) => {
      try {
        const data = JSON.parse(message);
        
        if (channel === 'djinnbot:pulse:schedule-updated') {
          const agentId = data.agentId;
          if (agentId && this.agentPulse) {
            console.log(`[DjinnBot] Pulse schedule updated for ${agentId}, reloading...`);
            await this.agentPulse.reloadAgentSchedule(agentId);
          }
        } else if (channel === 'djinnbot:pulse:offsets-updated') {
          // Auto-spread was called, reload all schedules
          console.log('[DjinnBot] Pulse offsets updated, reloading all schedules...');
          for (const agentId of this.agentRegistry.getIds()) {
            if (this.agentPulse) {
              await this.agentPulse.reloadAgentSchedule(agentId);
            }
          }
        } else if (channel === 'djinnbot:pulse:routine-updated') {
          // A specific routine was created/updated/deleted — reload the agent
          const agentId = data.agentId;
          if (agentId && this.agentPulse) {
            console.log(`[DjinnBot] Pulse routine updated for ${agentId}, reloading...`);
            await this.agentPulse.reloadAgentSchedule(agentId);
          }
        } else if (channel === 'djinnbot:pulse:trigger-routine') {
          // Manual trigger of a specific routine
          const { agentId, routineId, routineName } = data;
          if (agentId && routineId && this.agentPulse) {
            console.log(`[DjinnBot] Manual trigger for routine ${routineName || routineId}`);
            await this.agentPulse.triggerRoutine(agentId, routineId);
          }
        }
      } catch (err) {
        console.error('[DjinnBot] Failed to process pulse schedule update:', err);
      }
    });

    await subscriber.subscribe(
      'djinnbot:pulse:schedule-updated',
      'djinnbot:pulse:offsets-updated',
      'djinnbot:pulse:routine-updated',
      'djinnbot:pulse:trigger-routine',
    );
    console.log('[DjinnBot] Subscribed to pulse schedule update channels');
  }

  /**
   * Fetch tasks currently assigned to (or in progress for) an agent across all projects.
   * Used to pre-populate PulseContext.assignedTasks so the agent wakes up aware of its work.
   */
  private async fetchAssignedTasks(agentId: string): Promise<Array<{ id: string; title: string; status: string; project: string }>> {
    const apiUrl = process.env.DJINNBOT_API_URL || 'http://api:8000';
    try {
      // Get projects this agent is assigned to
      const projectsRes = await authFetch(`${apiUrl}/v1/agents/${agentId}/projects`);
      if (!projectsRes.ok) return [];
      const rawProjects = await projectsRes.json() as any;
      const projects: Array<{ project_id: string; project_name: string; project_status: string }> =
        Array.isArray(rawProjects) ? rawProjects : (rawProjects.projects || []);

      const activeTasks: Array<{ id: string; title: string; status: string; project: string }> = [];

      for (const p of projects) {
        if (p.project_status === 'archived') continue;
        try {
          // Fetch tasks assigned to this agent in non-terminal statuses
          const tasksRes = await authFetch(
            `${apiUrl}/v1/projects/${p.project_id}/tasks?agent=${encodeURIComponent(agentId)}`
          );
          if (!tasksRes.ok) continue;
          const tasks = await tasksRes.json() as any[];
          for (const t of tasks) {
            if (t.status && !['done', 'failed'].includes(t.status)) {
              activeTasks.push({
                id: t.id,
                title: t.title,
                status: t.status,
                project: p.project_name ?? p.project_id,
              });
            }
          }
        } catch {
          // Individual project fetch failure should not abort the whole list
        }
      }

      return activeTasks;
    } catch (err) {
      console.warn(`[DjinnBot] fetchAssignedTasks failed for ${agentId}:`, err);
      return [];
    }
  }

  /** Load pulse_columns from an agent's config.yml */
  private async loadAgentPulseColumns(agentId: string): Promise<string[]> {
    const configPath = join(this.config.agentsDir, agentId, 'config.yml');
    try {
      const { readFile } = await import('node:fs/promises');
      const { parse: parseYaml } = await import('yaml');
      const content = await readFile(configPath, 'utf-8');
      const config = parseYaml(content) || {};
      return Array.isArray(config.pulse_columns) ? config.pulse_columns : [];
    } catch {
      return [];
    }
  }

  /** Run a pulse session - agent "wakes up" and reviews their workspace with tools.
   *  When context.routineId is set, uses the routine's custom instructions
   *  instead of the default PULSE.md file.
   */
  private async runPulseSession(
    agentId: string, 
    context: import('./runtime/agent-pulse.js').PulseContext
  ): Promise<import('./runtime/agent-pulse.js').PulseSessionResult> {
    const label = context.routineName ? `${agentId}/${context.routineName}` : agentId;
    console.log(`[DjinnBot] Running pulse session for ${label}...`);
    
    if (!this.sessionRunner) {
      return {
        success: false,
        actions: [],
        output: 'Session runner not initialized',
      };
    }

    try {
      // Determine pulse columns: routine override > agent config.yml
      const pulseColumns = context.routinePulseColumns?.length
        ? context.routinePulseColumns
        : await this.loadAgentPulseColumns(agentId);

      // Load instructions: routine instructions > PULSE.md file
      const [persona, pulseInstructions] = await Promise.all([
        this.personaLoader.loadPersonaForSession(agentId, {
          sessionType: 'pulse',
        }),
        this.loadPulsePrompt(agentId, context),
      ]);
      const systemPrompt = `${persona.systemPrompt}\n\n---\n\n${pulseInstructions}`;
      
      // Build user prompt with current context
      const userPrompt = this.buildPulseUserPrompt(agentId, context);
      
      // Model resolution: routine.planningModel → agent.planningModel → agent.model → fallback
      const agent = this.agentRegistry.get(agentId);
      const model = context.routinePlanningModel
        || agent?.config?.planningModel
        || agent?.config?.model
        || 'openrouter/minimax/minimax-m2.5';

      // Determine timeout: routine override > agent config > default
      const timeout = context.routineTimeoutMs
        ?? agent?.config?.pulseContainerTimeoutMs
        ?? 120000;

      // Executor model resolution: routine.executorModel → agent.executorModel → agent.model → fallback
      const executorModel = context.routineExecutorModel
        || agent?.config?.executorModel
        || agent?.config?.model
        || 'openrouter/minimax/minimax-m2.5';

      // Run standalone session
      const result = await this.sessionRunner.runSession({
        agentId,
        systemPrompt,
        userPrompt,
        model,
        maxTurns: 999,
        timeout,
        source: 'pulse',
        pulseColumns,
        executorModel,
      });

      console.log(`[DjinnBot] Pulse session for ${label} completed: ${result.success}`);
      
      return {
        success: result.success,
        actions: result.actions || [],
        output: result.output,
      };
    } catch (err) {
      console.error(`[DjinnBot] Pulse session failed for ${label}:`, err);
      return {
        success: false,
        actions: [],
        output: `Pulse session error: ${err}`,
      };
    }
  }

  /**
   * Load the pulse prompt for a session.
   * 
   * Priority:
   * 1. Routine instructions from DB (if context has routineInstructions and no sourceFile)
   * 2. Routine sourceFile from disk (if sourceFile is set — means not yet edited in dashboard)
   * 3. Agent's PULSE.md from disk (legacy)
   * 4. Template PULSE.md
   * 5. Hardcoded default
   */
  private async loadPulsePrompt(
    agentId: string,
    context?: import('./runtime/agent-pulse.js').PulseContext,
  ): Promise<string> {
    let template: string | undefined;

    // Case 1: Routine with DB-stored instructions (sourceFile cleared by dashboard edit)
    if (context?.routineId && context.routineInstructions && !context.routineSourceFile) {
      template = context.routineInstructions;
    }

    // Case 2: Routine with sourceFile — read from disk so manual file edits are picked up
    if (!template && context?.routineSourceFile) {
      try {
        const { readFile } = await import('node:fs/promises');
        const filePath = join(this.config.agentsDir, agentId, context.routineSourceFile);
        template = await readFile(filePath, 'utf-8');
      } catch {
        // File may have been removed — fall back to DB instructions
        if (context.routineInstructions) {
          template = context.routineInstructions;
        }
      }
    }

    // Case 3: No routine — legacy PULSE.md from disk
    if (!template) {
      const agentPulsePath = join(this.config.agentsDir, agentId, 'PULSE.md');
      const templatePath = join(this.config.agentsDir, '_templates', 'PULSE.md');
      
      try {
        const { readFile } = await import('node:fs/promises');
        template = await readFile(agentPulsePath, 'utf-8');
      } catch {
        try {
          const { readFile } = await import('node:fs/promises');
          template = await readFile(templatePath, 'utf-8');
        } catch {
          template = this.getDefaultPulsePrompt();
        }
      }
    }
    
    // Replace placeholders
    const agent = this.agentRegistry.get(agentId);
    template = template.replace(/\{\{AGENT_NAME\}\}/g, agent?.identity?.name || agentId);
    template = template.replace(/\{\{AGENT_EMOJI\}\}/g, agent?.identity?.emoji || '🤖');
    
    return template;
  }

  /**
   * Fetch pulse routines for an agent from the API server.
   * Returns an empty array if the agent has no routines (triggers legacy fallback).
   */
  private async fetchAgentPulseRoutines(agentId: string): Promise<import('./runtime/pulse-types.js').PulseRoutine[]> {
    const apiUrl = process.env.DJINNBOT_API_URL || 'http://api:8000';
    try {
      const res = await authFetch(`${apiUrl}/v1/agents/${agentId}/pulse-routines`);
      if (!res.ok) return [];
      const data = await res.json() as any;
      const rawRoutines: any[] = data.routines || [];
      return rawRoutines.map((r: any) => ({
        id: r.id,
        agentId: r.agentId,
        name: r.name,
        description: r.description,
        instructions: r.instructions,
        sourceFile: r.sourceFile,
        enabled: r.enabled,
        intervalMinutes: r.intervalMinutes,
        offsetMinutes: r.offsetMinutes,
        blackouts: r.blackouts || [],
        oneOffs: r.oneOffs || [],
        timeoutMs: r.timeoutMs,
        maxConcurrent: r.maxConcurrent ?? 1,
        pulseColumns: r.pulseColumns,
        sortOrder: r.sortOrder ?? 0,
        color: r.color,
        lastRunAt: r.lastRunAt,
        totalRuns: r.totalRuns ?? 0,
        createdAt: r.createdAt,
        updatedAt: r.updatedAt,
      }));
    } catch (err) {
      console.warn(`[DjinnBot] fetchAgentPulseRoutines failed for ${agentId}:`, err);
      return [];
    }
  }

  /**
   * Update routine stats after a pulse run completes.
   * Fires-and-forgets a PATCH to the API server.
   */
  private updateRoutineStats(routineId: string): void {
    const apiUrl = process.env.DJINNBOT_API_URL || 'http://api:8000';
    // We don't know the agentId here, so use a simple dedicated endpoint
    // For now, fire-and-forget via direct DB or API call
    authFetch(`${apiUrl}/v1/pulse-routines/${routineId}/record-run`, {
      method: 'POST',
    }).catch((err) => {
      console.warn(`[DjinnBot] Failed to update routine stats for ${routineId}:`, err);
    });
  }

  private getDefaultPulsePrompt(): string {
    return `# Pulse Routine

You are an autonomous AI agent. This is your pulse wake-up routine.

## Your Task
1. Check your inbox for messages
2. Use recall to search for recent context
3. Take action on urgent items
4. Provide a summary of your findings

## Output Format
Provide a brief summary with:
- Inbox status
- Memories reviewed
- Actions taken
- Recommended next steps`;
  }

  private buildPulseUserPrompt(
    agentId: string,
    context: import('./runtime/agent-pulse.js').PulseContext
  ): string {
    const timestamp = new Date().toISOString();
    
    let inboxSection = '';
    if (context.unreadCount > 0) {
      inboxSection = `\n### Pre-loaded Inbox (${context.unreadCount} unread)\n`;
      inboxSection += context.unreadMessages.slice(0, 5).map(msg => 
        `- From **${msg.from}** [${msg.priority}]: "${msg.message.substring(0, 150)}..."`
      ).join('\n');
      if (context.unreadMessages.length > 5) {
        inboxSection += `\n... and ${context.unreadMessages.length - 5} more messages`;
      }
    } else {
      inboxSection = '\n### Inbox\nNo unread messages in your inbox.';
    }

    let tasksSection = '';
    if (context.assignedTasks && context.assignedTasks.length > 0) {
      tasksSection = `\n### Your Active Tasks\n`;
      tasksSection += context.assignedTasks.map(t =>
        `- [${t.status}] **${t.title}** (${t.id}) — project: ${t.project}`
      ).join('\n');
    } else {
      tasksSection = '\n### Your Active Tasks\nNo tasks currently assigned to you.';
    }

    return `# Pulse Wake-Up - ${timestamp}

${inboxSection}
${tasksSection}

## Your Workspace
- **Home**: \`/home/agent/\`
- **Run Workspace**: \`/home/agent/run-workspace/\` (your working directory)
- **Memory**: \`/home/agent/clawvault/\` (use \`recall\` tool, don't access directly)

## Pulse Routine

Execute the following steps:

**1. Context check (1 turn)**
- Use \`recall\` to surface recent handoffs, decisions, or urgent items from memory.
- Review inbox messages above.

**2. Task discovery (1 turn per project)**
- Call \`get_my_projects\` to list your projects.
- For each active project, call \`get_ready_tasks\`. The response contains:
  - \`in_progress\`: what you are already working on (with their downstream dependents).
  - \`tasks\`: ready candidates (with \`blocking_tasks\` showing what each one unlocks downstream).

**3. Parallel task selection**
A ready task is **safe to run in parallel** with your in-progress work if:
- Its \`blocking_tasks\` list does NOT contain any of your \`in_progress\` task IDs (no ordering conflict).
- It is in \`ready\`, \`backlog\`, or \`planning\` status (not already running).

Pick **up to 2 independent tasks** that pass the above check, prioritising P0 > P1 > P2 > P3.
If a task is unassigned, call \`claim_task\` first, then \`execute_task\`.
If it is already assigned to you, call \`execute_task\` directly.

**4. Respond to inbox** (if messages are urgent or require action)

**5. Complete**
Call \`complete\` with a summary: what you started, what is already running, any inbox actions taken.

**Rules**:
- Use \`recall\` for memories, not bash/find.
- Do not start tasks that depend on each other — only independent branches in parallel.
- Do not re-execute tasks already \`in_progress\` or \`review\`.

Start now.`;
  }

  /** Get memory system for a specific agent */
  async getAgentMemory(agentId: string): Promise<AgentMemory | null> {
    if (!this.agentMemoryManager) {
      return null;
    }
    return this.agentMemoryManager.get(agentId);
  }

  /** Run a standalone session (for pulse, Slack full sessions, etc.) */
  async runStandaloneSession(opts: StandaloneSessionOptions): Promise<StandaloneSessionResult> {
    if (!this.sessionRunner) {
      throw new Error('Session runner not initialized');
    }
    return this.sessionRunner.runSession(opts);
  }

  /** Send a DM to the user via Slack (for agents to escalate to the human) */
  async sendSlackDmToUser(agentId: string, message: string, urgent: boolean = false): Promise<string> {
    if (!this.slackBridge) {
      throw new Error('Slack bridge not started');
    }
    return this.slackBridge.sendDmToUser(agentId, message, urgent);
  }

  /** Start the Slack bridge for agent notifications and interactions */
  async startSlackBridge(
    channelId: string | undefined,
    onDecisionNeeded: (
      agentId: string,
      systemPrompt: string,
      userPrompt: string,
      model: string,
    ) => Promise<string>,
    onHumanGuidance?: (
      agentId: string,
      runId: string,
      stepId: string,
      guidance: string,
    ) => Promise<void>,
    defaultSlackDecisionModel?: string,
    onMemorySearch?: (
      agentId: string,
      query: string,
      limit?: number,
    ) => Promise<Array<{ title: string; snippet: string; category: string }>>,
    userSlackId?: string,
  ): Promise<void> {
    // Dynamic import to avoid circular dependency
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    // @ts-ignore - @djinnbot/slack is loaded dynamically to avoid circular dependency
    const slackModule = await import('@djinnbot/slack');
    const SlackBridge = slackModule.SlackBridge;
    this.slackBridge = new SlackBridge({
      eventBus: this.eventBus as any,
      agentRegistry: this.agentRegistry as any,
      defaultChannelId: channelId as any,
      onDecisionNeeded,
      onHumanGuidance,
      onMemorySearch,
      defaultSlackDecisionModel,
      userSlackId,

      // Wire up feedback → memory storage
      onFeedback: async (agentId: string, feedback: 'positive' | 'negative', responseText: string, userName: string) => {
        try {
          const memory = await this.getAgentMemory(agentId);
          if (!memory) return;
          const truncatedResponse = responseText.length > 500
            ? responseText.slice(0, 500) + '...'
            : responseText;
          if (feedback === 'positive') {
            await memory.remember('lesson', `Positive feedback from ${userName}`, [
              `${userName} gave a thumbs-up to this response:`,
              '',
              `> ${truncatedResponse.replace(/\n/g, '\n> ')}`,
              '',
              'This style/approach worked well — keep doing this.',
            ].join('\n'), { source: 'slack_feedback', feedback: 'positive' });
          } else {
            await memory.remember('lesson', `Negative feedback from ${userName}`, [
              `${userName} gave a thumbs-down to this response:`,
              '',
              `> ${truncatedResponse.replace(/\n/g, '\n> ')}`,
              '',
              'This response missed the mark. Review and adjust approach.',
            ].join('\n'), { source: 'slack_feedback', feedback: 'negative' });
          }
          console.log(`[DjinnBot] Feedback memory stored for ${agentId}: ${feedback} from ${userName}`);
        } catch (err) {
          console.warn(`[DjinnBot] Failed to store feedback memory for ${agentId}:`, err);
        }
      },
      
      // Wire up persona loader for full agent context
      onLoadPersona: async (
        agentId: string,
        sessionContext: { sessionType: 'slack' | 'pulse' | 'pipeline'; channelContext?: string; installedTools?: string[] }
      ) => {
        const persona = await this.personaLoader.loadPersonaForSession(agentId, sessionContext);
        return persona;
      },
      
      // Wire up full session runner
      onRunFullSession: async (opts: {
        agentId: string;
        systemPrompt: string;
        userPrompt: string;
        model: string;
        workspacePath?: string;
        vaultPath?: string;
        source?: 'slack_dm' | 'slack_channel' | 'api' | 'pulse';
        sourceId?: string;
      }) => {
        if (!this.sessionRunner) {
          return { output: 'Session runner not initialized', success: false };
        }
        
        console.log(`[DjinnBot] Running full Slack session for ${opts.agentId}`);
        
        const result = await this.sessionRunner.runSession({
          agentId: opts.agentId,
          systemPrompt: opts.systemPrompt,
          userPrompt: opts.userPrompt,
          model: opts.model,
          workspacePath: opts.workspacePath || join(this.config.dataDir, 'workspaces', opts.agentId),
          vaultPath: opts.vaultPath || join(this.config.dataDir, 'vaults', opts.agentId),
          maxTurns: 999,
          timeout: 180000, // 3 minutes for complex Slack tasks
          source: opts.source,
          sourceId: opts.sourceId,
        });
        
        return {
          output: result.output,
          success: result.success,
        };
      },
    });

    await this.slackBridge.start();
  }

  // Load pipeline definitions from YAML files
  async loadPipelines(): Promise<void> {
    const entries = await readdir(this.config.pipelinesDir, { withFileTypes: true });
    
    for (const entry of entries) {
      if (entry.isFile() && (entry.name.endsWith('.yaml') || entry.name.endsWith('.yml'))) {
        const filePath = join(this.config.pipelinesDir, entry.name);
        try {
          const pipeline = parsePipeline(filePath);
          this.pipelines.set(pipeline.id, pipeline);
          this.engine.registerPipeline(pipeline);
          console.log(`[DjinnBot] Loaded pipeline: ${pipeline.id} from ${entry.name}`);
        } catch (err) {
          console.error(`[DjinnBot] Failed to load pipeline from ${entry.name}:`, err);
        }
      }
    }
    
    console.log(`[DjinnBot] Loaded ${this.pipelines.size} pipelines`);
  }
  
  // Start a pipeline run (direct invocation, not via API)
  async startRun(pipelineId: string, task: string, context?: string): Promise<string> {
    const runId = await this.engine.startRun(pipelineId, task, context);
    
    // Subscribe the executor to this run
    // Note: for direct startRun, the first STEP_QUEUED may have already been emitted.
    // The executor uses xread from '$' so it will catch subsequent events.
    // For the API flow, use resumeRun() which subscribes before emitting.
    this.executor.subscribeToRun(runId, pipelineId);
    
    return runId;
  }

  // Resume an existing run (created by API) without creating a new one
  async resumeRun(runId: string): Promise<void> {
    const run = await this.store.getRun(runId);
    if (!run) {
      throw new Error(`Run ${runId} not found`);
    }

    // Subscribe executor BEFORE resuming so it catches the first STEP_QUEUED event
    this.executor.subscribeToRun(runId, run.pipelineId);

    // Subscribe Slack bridge if it's active
    if (this.slackBridge) {
      // Get assigned agents from the pipeline
      const pipeline = this.pipelines.get(run.pipelineId);
      const assignedAgentIds = pipeline?.agents.map(a => a.id) || [];

      // Fetch project-level Slack settings (channel + recipient user)
      let slackChannelId: string | undefined;
      let slackNotifyUserId: string | undefined;
      if (run.projectId && 'getProjectSlackSettings' in this.store) {
        try {
          const slackSettings = await (this.store as any).getProjectSlackSettings(run.projectId);
          slackChannelId = slackSettings?.slack_channel_id || undefined;
          slackNotifyUserId = slackSettings?.slack_notify_user_id || undefined;
        } catch {
          // Non-fatal — fall back to defaults
        }
      }

      this.slackBridge.subscribeToRun(
        runId,
        run.pipelineId,
        run.taskDescription,
        assignedAgentIds,
        slackChannelId,
        slackNotifyUserId,
      );
    }

    await this.engine.resumeRun(runId);
  }
  
  // Get run status
  async getRun(runId: string): Promise<PipelineRun | null> {
    return await this.store.getRun(runId);
  }
  
  // List all runs
  listRuns(pipelineId?: string): PipelineRun[] {
    return this.store.listRuns(pipelineId);
  }
  
  // Get pipeline configuration
  getPipeline(pipelineId: string): PipelineConfig | undefined {
    return this.pipelines.get(pipelineId);
  }
  
  // List all loaded pipelines
  listPipelines(): PipelineConfig[] {
    return Array.from(this.pipelines.values());
  }
  
  // Get the store instance (for main.ts compatibility)
  getStore(): Store {
    return this.store;
  }
  
  // Shutdown
  async shutdown(): Promise<void> {
    this.agentPulse?.stop();
    await this.slackBridge?.shutdown();
    await this.executor.shutdown();
    await this.engine.shutdown();
    await this.agentInbox.close();
    await this.eventBus.close();
    if (this.redis) {
      await this.redis.quit();
    }
    this.store.close();
    console.log('[DjinnBot] Shutdown complete');
  }
}
