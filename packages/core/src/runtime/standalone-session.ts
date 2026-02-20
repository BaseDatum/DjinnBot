import type { AgentRunner, RunAgentOptions, AgentRunResult } from './agent-executor.js';
import type { AgentMemoryManager } from '../memory/agent-memory.js';
import type { AgentInbox } from '../events/agent-inbox.js';
import type { SessionPersister } from '../sessions/session-persister.js';
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
  source?: 'slack_dm' | 'slack_channel' | 'api' | 'pulse';
  sourceId?: string;
  /** Kanban column names this agent is allowed to work from (passed to pulse tools). */
  pulseColumns?: string[];
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
    }
  ) {}

  async runSession(opts: StandaloneSessionOptions): Promise<StandaloneSessionResult> {
    const sessionTimestamp = Date.now();
    const sessionId = `standalone_${opts.agentId}_${sessionTimestamp}`;
    const stepId = `STANDALONE_${sessionTimestamp}`;

    console.log(`[StandaloneSessionRunner] Starting session ${sessionId} for ${opts.agentId}`);

    // Create session in DB
    if (this.config.sessionPersister) {
      try {
        await this.config.sessionPersister.createSession({
          id: sessionId,
          agentId: opts.agentId,
          source: opts.source || 'api',
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
        maxTurns: opts.maxTurns || 30,
        timeout: opts.timeout || 120000,
        pulseColumns: opts.pulseColumns,
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
