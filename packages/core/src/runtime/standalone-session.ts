import type { AgentRunner, RunAgentOptions, AgentRunResult } from './agent-executor.js';
import type { AgentMemoryManager } from '../memory/agent-memory.js';
import type { AgentInbox } from '../events/agent-inbox.js';
import type { SessionPersister } from '../sessions/session-persister.js';
import type { AgentLifecycleTracker } from '../lifecycle/agent-lifecycle-tracker.js';
import { join } from 'node:path';

export interface StandaloneSessionOptions {
  agentId: string;
  systemPrompt: string;
  userPrompt: string;
  model: string;
  workspacePath?: string;
  vaultPath?: string;
  maxTurns?: number;
  timeout?: number;
  source?: 'slack_dm' | 'slack_channel' | 'api' | 'pulse' | 'wake';
  sourceId?: string;
  /** Kanban column names this agent is allowed to work from (passed to pulse tools). */
  pulseColumns?: string[];
  /** Task work types this routine handles (passed to pulse tools). */
  taskWorkTypes?: string[];
  /** Executor model for spawn_executor — passed to container as EXECUTOR_MODEL env var. */
  executorModel?: string;
  /** DjinnBot user whose API keys are used for this session (per-user key resolution). */
  userId?: string;
}

export interface StandaloneSessionResult {
  success: boolean;
  output: string;
  error?: string;
  actions?: string[];
}

export class StandaloneSessionRunner {
  constructor(
    private runner: AgentRunner,
    private config: {
      dataDir: string;
      agentsDir: string;
      sessionPersister?: SessionPersister;
      /** Optional lifecycle tracker — records session_started/completed events
       *  for Slack and other standalone sessions so the Activity tab shows them. */
      lifecycleTracker?: AgentLifecycleTracker;
    }
  ) {}

  async runSession(opts: StandaloneSessionOptions): Promise<StandaloneSessionResult> {
    const sessionTimestamp = Date.now();
    const sessionId = `standalone_${opts.agentId}_${sessionTimestamp}`;
    const stepId = `STANDALONE_${sessionTimestamp}`;

    console.log(`[StandaloneSessionRunner] Starting session ${sessionId} for ${opts.agentId}`);

    // Record session started in the agent's activity timeline (skip 'pulse' — AgentPulse
    // records pulse_started/complete separately with richer context).
    const source = opts.source || 'api';
    if (this.config.lifecycleTracker && source !== 'pulse') {
      this.config.lifecycleTracker.recordSessionStarted(
        opts.agentId,
        sessionId,
        source,
        opts.userPrompt.slice(0, 200),
        opts.model,
      ).catch(err =>
        console.warn(`[StandaloneSessionRunner] Failed to record session_started for ${sessionId}:`, err)
      );
    }

    // Create session in DB
    if (this.config.sessionPersister) {
      try {
        await this.config.sessionPersister.createSession({
          id: sessionId,
          agentId: opts.agentId,
          source,
          sourceId: opts.sourceId,
          userPrompt: opts.userPrompt,
          model: opts.model,
        });
      } catch (err) {
        console.error(`[StandaloneSessionRunner] Failed to create session in DB:`, err);
        // Continue execution - don't let persistence failures break agent execution
      }
    }

    // Container system handles workspace - use provided paths or defaults
    const workspacePath = opts.workspacePath || join(this.config.dataDir, 'workspaces', opts.agentId);
    const vaultPath = opts.vaultPath || join(this.config.dataDir, 'vaults', opts.agentId);

    try {
      // Update status to running
      if (this.config.sessionPersister) {
        try {
          await this.config.sessionPersister.updateStatus(sessionId, 'running');
        } catch (err) {
          console.error(`[StandaloneSessionRunner] Failed to update status:`, err);
        }
      }

      const result = await this.runner.runAgent({
        agentId: opts.agentId,
        runId: sessionId,
        stepId: stepId,
        systemPrompt: opts.systemPrompt,
        userPrompt: opts.userPrompt,
        model: opts.model,
        workspacePath,
        vaultPath,
        maxTurns: opts.maxTurns || 999,
        timeout: opts.timeout || 120000,
        pulseColumns: opts.pulseColumns,
        taskWorkTypes: opts.taskWorkTypes,
        executorModel: opts.executorModel,
        userId: opts.userId,
      });

      console.log(`[StandaloneSessionRunner] Session ${sessionId} completed`);

      // Complete session
      if (this.config.sessionPersister) {
        try {
          await this.config.sessionPersister.completeSession(
            sessionId,
            result.output,
            result.success,
            result.error
          );
        } catch (err) {
          console.error(`[StandaloneSessionRunner] Failed to complete session in DB:`, err);
        }
      }

      // Record session completed in the agent's activity timeline.
      if (this.config.lifecycleTracker && source !== 'pulse') {
        const durationMs = Date.now() - sessionTimestamp;
        this.config.lifecycleTracker.recordSessionCompleted(opts.agentId, sessionId, {
          durationMs,
          outputPreview: result.output?.slice(0, 200),
          success: result.success,
          error: result.error,
        }).catch(err =>
          console.warn(`[StandaloneSessionRunner] Failed to record session_completed for ${sessionId}:`, err)
        );
      }

      return {
        success: result.success,
        output: result.output,
        error: result.error,
        actions: this.extractActions(result.output),
      };
    } catch (err) {
      console.error(`[StandaloneSessionRunner] Session ${sessionId} failed:`, err);

      // Mark failed
      if (this.config.sessionPersister) {
        try {
          await this.config.sessionPersister.completeSession(sessionId, '', false, String(err));
        } catch (persistErr) {
          console.error(`[StandaloneSessionRunner] Failed to mark session as failed in DB:`, persistErr);
        }
      }

      // Record session failed in the agent's activity timeline.
      if (this.config.lifecycleTracker && source !== 'pulse') {
        const durationMs = Date.now() - sessionTimestamp;
        this.config.lifecycleTracker.recordSessionCompleted(opts.agentId, sessionId, {
          durationMs,
          success: false,
          error: String(err),
        }).catch(e =>
          console.warn(`[StandaloneSessionRunner] Failed to record session_failed for ${sessionId}:`, e)
        );
      }

      return {
        success: false,
        output: '',
        error: String(err),
        actions: [],
      };
    }
  }

  private extractActions(output: string): string[] {
    // Try to parse actions from the output
    const actions: string[] = [];
    
    // Look for "Actions Taken:" section
    const actionMatch = output.match(/Actions.*?Taken:?\s*([\s\S]*?)(?=\n\n|$)/i);
    if (actionMatch) {
      const lines = actionMatch[1].split('\n')
        .map(l => l.trim())
        .filter(l => l.startsWith('-') || l.match(/^\d+\./));
      actions.push(...lines.map(l => l.replace(/^[-\d.]+\s*/, '')).filter(Boolean));
    }
    
    return actions;
  }
}
