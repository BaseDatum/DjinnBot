import { EventBus } from '../events/event-bus.js';

export type AgentState = 'idle' | 'working' | 'thinking' | 'tool_calling';

export interface AgentLifecycle {
  agentId: string;
  state: AgentState;
  currentWork?: { runId: string; stepId: string; startedAt: number };
  queue: Array<{ runId: string; pipelineId: string; stepId: string; queuedAt: number }>;
  lastActivity: number;
  installedTools: string[];
  /** Pulse session IDs currently running for this agent (independent of pipeline steps). */
  activePulseSessions: string[];
}

export interface QueueResult {
  queued: boolean;
  position?: number;
  executing: boolean;
}

interface AgentData {
  lifecycle: AgentLifecycle;
  installedToolsSet: Set<string>;
}

export class AgentLifecycleManager {
  private agents: Map<string, AgentData> = new Map();
  private eventBus: EventBus;

  constructor(eventBus: EventBus) {
    this.eventBus = eventBus;
  }

  private ensureAgent(agentId: string): AgentData {
    let data = this.agents.get(agentId);
    if (!data) {
      data = {
        lifecycle: {
          agentId,
          state: 'idle',
          queue: [],
          lastActivity: Date.now(),
          installedTools: [],
          activePulseSessions: [],
        },
        installedToolsSet: new Set<string>(),
      };
      this.agents.set(agentId, data);
    }
    return data;
  }

  private publishStateChange(
    agentId: string,
    previousState: AgentState,
    newState: AgentState,
    currentWork?: { runId: string; stepId: string }
  ): void {
    this.eventBus.publish('djinnbot:system', {
      type: 'AGENT_STATE_CHANGED' as const,
      agentId,
      previousState,
      newState,
      runId: currentWork?.runId || '',
      stepId: currentWork?.stepId || '',
      timestamp: Date.now(),
    }).catch(err => {
      console.error('[AgentLifecycleManager] Failed to publish state change:', err);
    });
  }

  initAgent(agentId: string): void {
    this.ensureAgent(agentId);
  }

  queueWork(runId: string, stepId: string, agentId: string, pipelineId = ''): QueueResult {
    const data = this.ensureAgent(agentId);
    const now = Date.now();
    data.lifecycle.lastActivity = now;

    if (data.lifecycle.state !== 'idle') {
      const position = data.lifecycle.queue.length + 1;
      data.lifecycle.queue.push({ runId, pipelineId, stepId, queuedAt: now });
      return { queued: true, position, executing: false };
    }

    data.lifecycle.state = 'working';
    data.lifecycle.currentWork = { runId, stepId, startedAt: now };
    this.publishStateChange(agentId, 'idle', 'working', { runId, stepId });

    return { queued: false, executing: true };
  }

  markWorking(agentId: string, runId: string, stepId: string): void {
    const data = this.ensureAgent(agentId);
    const previousState = data.lifecycle.state;
    const now = Date.now();

    data.lifecycle.state = 'working';
    data.lifecycle.currentWork = { runId, stepId, startedAt: now };
    data.lifecycle.lastActivity = now;

    if (previousState !== 'working') {
      this.publishStateChange(agentId, previousState, 'working', { runId, stepId });
    }
  }

  markThinking(agentId: string): void {
    const data = this.ensureAgent(agentId);
    const previousState = data.lifecycle.state;
    const now = Date.now();

    if (previousState !== 'working' && previousState !== 'thinking') {
      return;
    }

    data.lifecycle.state = 'thinking';
    data.lifecycle.lastActivity = now;

    this.publishStateChange(agentId, previousState, 'thinking', data.lifecycle.currentWork);
  }

  markToolCalling(agentId: string, toolName?: string): void {
    const data = this.ensureAgent(agentId);
    const previousState = data.lifecycle.state;
    const now = Date.now();

    if (previousState !== 'working' && previousState !== 'tool_calling') {
      return;
    }

    data.lifecycle.state = 'tool_calling';
    data.lifecycle.lastActivity = now;

    this.publishStateChange(agentId, previousState, 'tool_calling', data.lifecycle.currentWork);
  }

  markComplete(agentId: string): { runId: string; pipelineId: string; stepId: string } | null {
    const data = this.ensureAgent(agentId);
    const previousState = data.lifecycle.state;
    const now = Date.now();
    data.lifecycle.lastActivity = now;

    let nextWork: { runId: string; pipelineId: string; stepId: string } | null = null;

    if (data.lifecycle.queue.length > 0) {
      const next = data.lifecycle.queue.shift()!;
      nextWork = { runId: next.runId, pipelineId: next.pipelineId, stepId: next.stepId };
      data.lifecycle.currentWork = { runId: next.runId, stepId: next.stepId, startedAt: now };
      data.lifecycle.state = 'working';
      this.publishStateChange(agentId, previousState, 'working', nextWork);
    } else {
      data.lifecycle.currentWork = undefined;
      data.lifecycle.state = 'idle';
      this.publishStateChange(agentId, previousState, 'idle');
    }

    return nextWork;
  }

  /**
   * Register a pulse session as active for this agent.
   * Returns false if the agent is already at or above maxConcurrent pulse sessions.
   */
  startPulseSession(agentId: string, sessionId: string, maxConcurrent: number = 2): boolean {
    const data = this.ensureAgent(agentId);
    if (data.lifecycle.activePulseSessions.length >= maxConcurrent) {
      return false;
    }
    data.lifecycle.activePulseSessions.push(sessionId);
    data.lifecycle.lastActivity = Date.now();
    return true;
  }

  /** Deregister a pulse session. Does not affect pipeline step state. */
  endPulseSession(agentId: string, sessionId: string): void {
    const data = this.ensureAgent(agentId);
    data.lifecycle.activePulseSessions = data.lifecycle.activePulseSessions.filter(
      (id) => id !== sessionId
    );
    data.lifecycle.lastActivity = Date.now();
  }

  /** Number of pulse sessions currently active for this agent. */
  getPulseSessionCount(agentId: string): number {
    const data = this.agents.get(agentId);
    return data?.lifecycle.activePulseSessions.length ?? 0;
  }

  getState(agentId: string): AgentState {
    const data = this.agents.get(agentId);
    return data?.lifecycle.state ?? 'idle';
  }

  getLifecycle(agentId: string): AgentLifecycle | undefined {
    return this.agents.get(agentId)?.lifecycle;
  }

  getAllLifecycles(): AgentLifecycle[] {
    return Array.from(this.agents.values()).map((d) => d.lifecycle);
  }

  addInstalledTool(agentId: string, tool: string): void {
    const data = this.ensureAgent(agentId);
    data.installedToolsSet.add(tool);
    data.lifecycle.installedTools = Array.from(data.installedToolsSet);
    data.lifecycle.lastActivity = Date.now();
  }

  getInstalledTools(agentId: string): string[] {
    const data = this.agents.get(agentId);
    return data ? Array.from(data.installedToolsSet) : [];
  }
}