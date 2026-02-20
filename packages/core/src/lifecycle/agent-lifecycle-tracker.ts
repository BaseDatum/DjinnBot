import { Redis, type Redis as RedisType } from 'ioredis';

// Helper function to generate short UUIDs
function generateShortId(): string {
  return Math.random().toString(36).substring(2, 10);
}

// ─────────────────────────────────────────────────────────────
// State Types
// ─────────────────────────────────────────────────────────────

export type AgentLifecycleState = 'idle' | 'thinking' | 'working';

export interface WorkInfo {
  runId: string;
  stepId: string;
  stepType: string;
  startedAt: number;
}

export interface AgentStateData {
  state: AgentLifecycleState;
  lastActive: number | null;
  currentWork: WorkInfo | null;
}

// ─────────────────────────────────────────────────────────────
// Timeline Event Types
// ─────────────────────────────────────────────────────────────

export type TimelineEventType =
  | 'state_change'
  | 'work_started'
  | 'work_complete'
  | 'work_failed'
  | 'slack_message'
  | 'pulse_started'
  | 'pulse_complete'
  | 'tool_install'
  | 'sandbox_reset'
  | 'message_sent'
  | 'message_received';

export interface TimelineEvent {
  id: string;
  timestamp: number;
  type: TimelineEventType;
  data: Record<string, any>;
}

// ─────────────────────────────────────────────────────────────
// Configuration
// ─────────────────────────────────────────────────────────────

export interface AgentLifecycleTrackerConfig {
  redis: RedisType;
  maxTimelineEvents?: number; // Default 1000
  timelineRetentionMs?: number; // Default 7 days
}

// ─────────────────────────────────────────────────────────────
// AgentLifecycleTracker Class
// ─────────────────────────────────────────────────────────────

export class AgentLifecycleTracker {
  private redis: RedisType;
  private maxEvents: number;
  private retentionMs: number;

  constructor(config: AgentLifecycleTrackerConfig) {
    this.redis = config.redis;
    this.maxEvents = config.maxTimelineEvents ?? 1000;
    this.retentionMs = config.timelineRetentionMs ?? 7 * 24 * 60 * 60 * 1000;
  }

  // ─────────────────────────────────────────────────────────────
  // State Management
  // ─────────────────────────────────────────────────────────────

  async setState(agentId: string, state: AgentLifecycleState, work?: WorkInfo): Promise<void> {
    const stateKey = `djinnbot:agent:${agentId}:state`;

    const stateData: AgentStateData = {
      state,
      lastActive: Date.now(),
      currentWork: work || null,
    };

    await this.redis.set(stateKey, JSON.stringify(stateData));

    // Also add a state_change timeline event
    await this.addTimelineEvent(agentId, {
      id: `state_${generateShortId()}`,
      timestamp: Date.now(),
      type: 'state_change',
      data: { newState: state, work },
    });
  }

  async getState(agentId: string): Promise<AgentStateData> {
    const stateKey = `djinnbot:agent:${agentId}:state`;
    const data = await this.redis.get(stateKey);

    if (!data) {
      return { state: 'idle', lastActive: null, currentWork: null };
    }

    try {
      return JSON.parse(data);
    } catch {
      return { state: 'idle', lastActive: null, currentWork: null };
    }
  }

  // ─────────────────────────────────────────────────────────────
  // Timeline Management
  // ─────────────────────────────────────────────────────────────

  async addTimelineEvent(agentId: string, event: TimelineEvent): Promise<void> {
    const timelineKey = `djinnbot:agent:${agentId}:timeline`;

    const eventData = JSON.stringify({
      id: event.id,
      type: event.type,
      data: event.data,
    });

    // Add to sorted set with timestamp as score
    await this.redis.zadd(timelineKey, event.timestamp, eventData);

    // Trim to max events
    const count = await this.redis.zcard(timelineKey);
    if (count > this.maxEvents) {
      // Remove oldest events
      await this.redis.zremrangebyrank(timelineKey, 0, count - this.maxEvents - 1);
    }

    // Remove events older than retention period
    const cutoff = Date.now() - this.retentionMs;
    await this.redis.zremrangebyscore(timelineKey, '-inf', cutoff);
  }

  async getTimeline(agentId: string, options?: { limit?: number; since?: number }): Promise<TimelineEvent[]> {
    const timelineKey = `djinnbot:agent:${agentId}:timeline`;
    const limit = options?.limit ?? 100;

    let events: string[];

    if (options?.since) {
      // Get events after timestamp
      events = await this.redis.zrangebyscore(timelineKey, options.since, '+inf', 'LIMIT', 0, limit);
    } else {
      // Get most recent events (newest first)
      events = await this.redis.zrevrange(timelineKey, 0, limit - 1);
    }

    // Parse events
    const parsed: TimelineEvent[] = [];
    for (const eventStr of events) {
      try {
        const data = JSON.parse(eventStr);
        // Get the score (timestamp) for this event
        const scores = await this.redis.zscore(timelineKey, eventStr);
        const timestamp = scores ? parseInt(scores, 10) : Date.now();

        parsed.push({
          id: data.id,
          timestamp,
          type: data.type,
          data: data.data,
        });
      } catch {
        // Skip malformed events
      }
    }

    return parsed;
  }

  // ─────────────────────────────────────────────────────────────
  // Convenience Methods for Common Events
  // ─────────────────────────────────────────────────────────────

  async recordWorkStarted(agentId: string, runId: string, stepId: string, stepType: string): Promise<void> {
    // Update state
    await this.setState(agentId, 'working', {
      runId,
      stepId,
      stepType,
      startedAt: Date.now(),
    });

    // Add timeline event
    await this.addTimelineEvent(agentId, {
      id: `work_start_${runId}_${stepId}`,
      timestamp: Date.now(),
      type: 'work_started',
      data: { runId, stepId, stepType },
    });
  }

  async recordWorkComplete(
    agentId: string,
    runId: string,
    stepId: string,
    outputs: Record<string, any>,
    durationMs: number
  ): Promise<void> {
    // Update state to idle
    await this.setState(agentId, 'idle');

    // Add timeline event
    await this.addTimelineEvent(agentId, {
      id: `work_complete_${runId}_${stepId}`,
      timestamp: Date.now(),
      type: 'work_complete',
      data: { runId, stepId, outputs, durationMs },
    });
  }

  async recordWorkFailed(agentId: string, runId: string, stepId: string, error: string): Promise<void> {
    // Update state to idle
    await this.setState(agentId, 'idle');

    // Add timeline event
    await this.addTimelineEvent(agentId, {
      id: `work_failed_${runId}_${stepId}`,
      timestamp: Date.now(),
      type: 'work_failed',
      data: { runId, stepId, error },
    });
  }

  async recordSlackMessage(
    agentId: string,
    threadTs: string,
    message: string,
    direction: 'sent' | 'received'
  ): Promise<void> {
    await this.addTimelineEvent(agentId, {
      id: `slack_${direction}_${Date.now()}`,
      timestamp: Date.now(),
      type: 'slack_message',
      data: { threadTs, message, direction },
    });
  }

  async recordPulseStarted(agentId: string): Promise<void> {
    await this.setState(agentId, 'working', {
      runId: 'pulse',
      stepId: 'pulse',
      stepType: 'pulse',
      startedAt: Date.now(),
    });

    await this.addTimelineEvent(agentId, {
      id: `pulse_start_${Date.now()}`,
      timestamp: Date.now(),
      type: 'pulse_started',
      data: {},
    });
  }

  async recordPulseComplete(
    agentId: string,
    summary: string,
    checksCompleted: number,
    durationMs: number
  ): Promise<void> {
    await this.setState(agentId, 'idle');

    await this.addTimelineEvent(agentId, {
      id: `pulse_complete_${Date.now()}`,
      timestamp: Date.now(),
      type: 'pulse_complete',
      data: { summary, checksCompleted, durationMs },
    });
  }

  // ─────────────────────────────────────────────────────────────
  // Queue Management
  // ─────────────────────────────────────────────────────────────

  async getQueueDepth(agentId: string): Promise<number> {
    const queueKey = `djinnbot:agent:${agentId}:queue`;
    return await this.redis.llen(queueKey);
  }

  async addToQueue(agentId: string, workItem: WorkInfo): Promise<void> {
    const queueKey = `djinnbot:agent:${agentId}:queue`;
    await this.redis.rpush(queueKey, JSON.stringify(workItem));
  }

  async popFromQueue(agentId: string): Promise<WorkInfo | null> {
    const queueKey = `djinnbot:agent:${agentId}:queue`;
    const item = await this.redis.lpop(queueKey);
    if (!item) return null;

    try {
      return JSON.parse(item);
    } catch {
      return null;
    }
  }
}
