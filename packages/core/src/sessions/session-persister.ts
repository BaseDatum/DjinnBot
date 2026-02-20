import type { Redis } from 'ioredis';

export interface SessionData {
  id: string; // runId
  agentId: string;
  source: 'slack_dm' | 'slack_channel' | 'api' | 'pulse' | 'pipeline';
  sourceId?: string; // thread_ts, channel_id, or stepId for pipelines
  userPrompt: string;
  model: string;
}

export interface SessionEvent {
  type: 'thinking' | 'tool_start' | 'tool_end' | 'message' | 'output' | 'turn_start' | 'turn_end';
  timestamp: number;
  data: Record<string, unknown>;
}

interface SessionLiveEvent {
  type: 'created' | 'status' | 'event' | 'completed' | 'failed';
  sessionId: string;
  agentId: string;
  timestamp: number;
  data?: Record<string, unknown>;
}

export class SessionPersister {
  private readonly liveChannel = 'djinnbot:sessions:live';

  constructor(
    private apiBaseUrl: string,
    private redis: Redis
  ) {}

  async createSession(data: SessionData): Promise<void> {
    try {
      const response = await fetch(`${this.apiBaseUrl}/v1/internal/sessions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(data),
      });

      if (!response.ok) {
        console.error(`[SessionPersister] Failed to create session ${data.id}: ${response.status}`);
      }

      await this.publishLive({
        type: 'created',
        sessionId: data.id,
        agentId: data.agentId,
        timestamp: Date.now(),
        data: { source: data.source, model: data.model },
      });
    } catch (error) {
      console.error(`[SessionPersister] Error creating session ${data.id}:`, error);
    }
  }

  async updateStatus(sessionId: string, status: string): Promise<void> {
    try {
      const response = await fetch(`${this.apiBaseUrl}/v1/internal/sessions/${sessionId}/status`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ status }),
      });

      if (!response.ok) {
        console.error(`[SessionPersister] Failed to update status for ${sessionId}: ${response.status}`);
      }

      await this.publishLive({
        type: 'status',
        sessionId,
        agentId: '', // Will be filled by backend
        timestamp: Date.now(),
        data: { status },
      });
    } catch (error) {
      console.error(`[SessionPersister] Error updating status for ${sessionId}:`, error);
    }
  }

  async addEvent(sessionId: string, event: SessionEvent): Promise<void> {
    try {
      const response = await fetch(`${this.apiBaseUrl}/v1/internal/sessions/${sessionId}/events`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(event),
      });

      if (!response.ok) {
        console.error(`[SessionPersister] Failed to add event to ${sessionId}: ${response.status}`);
      }

      // Publish to per-session channel for live streaming
      const channel = `djinnbot:sessions:${sessionId}`;
      const payload = JSON.stringify(event);
      console.log(`[SessionPersister] Publishing to ${channel}: ${event.type}`);
      await this.redis.publish(channel, payload);

      // Publish to live channel for session list updates
      await this.publishLive({
        type: 'event',
        sessionId,
        agentId: '', // Will be filled by backend
        timestamp: Date.now(),
        data: { eventType: event.type },
      });
    } catch (error) {
      console.error(`[SessionPersister] Error adding event to ${sessionId}:`, error);
    }
  }

  async completeSession(
    sessionId: string,
    output: string,
    success: boolean,
    error?: string
  ): Promise<void> {
    try {
      const response = await fetch(`${this.apiBaseUrl}/v1/internal/sessions/${sessionId}/complete`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ output, success, error }),
      });

      if (!response.ok) {
        console.error(`[SessionPersister] Failed to complete session ${sessionId}: ${response.status}`);
      }

      await this.publishLive({
        type: success ? 'completed' : 'failed',
        sessionId,
        agentId: '', // Will be filled by backend
        timestamp: Date.now(),
        data: error ? { error } : undefined,
      });
    } catch (err) {
      console.error(`[SessionPersister] Error completing session ${sessionId}:`, err);
    }
  }

  private async publishLive(event: SessionLiveEvent): Promise<void> {
    try {
      await this.redis.publish(this.liveChannel, JSON.stringify(event));
    } catch (error) {
      console.error('[SessionPersister] Error publishing to live channel:', error);
    }
  }
}
