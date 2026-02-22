/**
 * ThreadManager — manages the lifecycle of Slack threads for pipeline runs.
 *
 * The first assigned agent creates the thread, and all agents post
 * their step updates into that thread. This manager tracks the mapping.
 */

import { WebClient } from '@slack/web-api';
import type { AgentRegistryEntry } from '@djinnbot/core';

export interface RunThread {
  runId: string;
  pipelineId: string;
  taskDescription: string;
  channelId: string;
  threadTs: string;
  createdAt: number;
  /** Agent IDs assigned to steps in this run */
  assignedAgents: string[];
  /** WebClient of the agent who created the thread (used for status updates) */
  ownerClient: WebClient;
}

export interface ThreadManagerConfig {
  /** Default channel for run threads (optional — pipeline threads require per-project config when unset) */
  defaultChannelId?: string;
  /** Map of agentId → WebClient for all Slack-connected agents */
  agentClients: Map<string, WebClient>;
}

export class ThreadManager {
  private threads = new Map<string, RunThread>();
  private config: ThreadManagerConfig;

  constructor(config: ThreadManagerConfig) {
    this.config = config;
  }

  /**
   * Create a thread for a new pipeline run.
   * The first assigned agent posts the initial message.
   */
  async createRunThread(options: {
    runId: string;
    pipelineId: string;
    taskDescription: string;
    assignedAgents: AgentRegistryEntry[];
    channelId?: string;
  }): Promise<RunThread | null> {
    const channelId = options.channelId || this.config.defaultChannelId;
    if (!channelId) {
      console.warn('[ThreadManager] No channelId provided and no defaultChannelId configured — cannot create Slack thread. Set SLACK_CHANNEL_ID or configure a channel in Project Settings.');
      return null;
    }

    // Use the first assigned agent's client to create the thread
    const firstAgent = options.assignedAgents[0];
    if (!firstAgent) {
      console.warn('[ThreadManager] No assigned agents — cannot create Slack thread');
      return null;
    }

    const client = this.config.agentClients.get(firstAgent.id);
    if (!client) {
      console.warn(
        `[ThreadManager] Agent ${firstAgent.id} has no Slack client — cannot create thread`
      );
      return null;
    }

    // Build agent roster
    const agentList = options.assignedAgents
      .map((a) => `• ${a.identity.emoji} *${a.identity.name}* — ${a.identity.role}`)
      .join('\n');

    try {
      const result = await client.chat.postMessage({
        channel: channelId,
        text: `🧞 Pipeline Run: ${options.taskDescription}`,
        blocks: [
          {
            type: 'header',
            text: {
              type: 'plain_text',
              text: `🧞 Pipeline Run Started`,
              emoji: true,
            },
          },
          {
            type: 'section',
            text: {
              type: 'mrkdwn',
              text: `*Task:* ${options.taskDescription}\n*Pipeline:* ${options.pipelineId}\n*Run:* \`${options.runId}\``,
            },
          },
          { type: 'divider' },
          {
            type: 'section',
            text: {
              type: 'mrkdwn',
              text: `*Assigned Agents:*\n${agentList}`,
            },
          },
          {
            type: 'context',
            elements: [
              {
                type: 'mrkdwn',
                text: `⏱️ Started at ${new Date().toISOString()}`,
              },
            ],
          },
        ],
      });

      if (!result.ok || !result.ts) {
        console.error(
          '[ThreadManager] Failed to create thread:',
          result.error
        );
        return null;
      }

      const thread: RunThread = {
        runId: options.runId,
        pipelineId: options.pipelineId,
        taskDescription: options.taskDescription,
        channelId,
        threadTs: result.ts,
        createdAt: Date.now(),
        assignedAgents: options.assignedAgents.map((a) => a.id),
        ownerClient: client,
      };

      this.threads.set(options.runId, thread);
      console.log(
        `[ThreadManager] ${firstAgent.identity.name} created thread for run ${options.runId}: ${result.ts}`
      );
      return thread;
    } catch (err) {
      console.error('[ThreadManager] Error creating thread:', err);
      return null;
    }
  }

  /**
   * Update the top-level thread message when a run completes or fails.
   * Uses the thread owner's client (the agent who created it).
   */
  async updateRunStatus(
    runId: string,
    status: 'completed' | 'failed',
    details?: string
  ): Promise<void> {
    const thread = this.threads.get(runId);
    if (!thread) return;

    const emoji = status === 'completed' ? '✅' : '❌';

    try {
      await thread.ownerClient.chat.postMessage({
        channel: thread.channelId,
        thread_ts: thread.threadTs,
        text: `${emoji} Run ${status}`,
        blocks: [
          {
            type: 'section',
            text: {
              type: 'mrkdwn',
              text: `${emoji} *Run ${status.toUpperCase()}*${details ? `\n${details}` : ''}`,
            },
          },
          {
            type: 'context',
            elements: [
              {
                type: 'mrkdwn',
                text: `Finished at ${new Date().toISOString()}`,
              },
            ],
          },
        ],
      });
    } catch (err) {
      console.error(
        `[ThreadManager] Error updating run status:`,
        err
      );
    }
  }

  /** Get thread info for a run */
  getThread(runId: string): RunThread | undefined {
    return this.threads.get(runId);
  }

  /** Get all active threads */
  getAllThreads(): RunThread[] {
    return Array.from(this.threads.values());
  }

  /** Get runId by thread info (used by AgentSlackRuntime to look up run from threadTs) */
  getRunByThread(channelId: string, threadTs: string): string | undefined {
    for (const [runId, thread] of this.threads) {
      if (thread.channelId === channelId && thread.threadTs === threadTs) {
        return runId;
      }
    }
    return undefined;
  }

  /** Check if a thread is a pipeline work thread */
  isPipelineThread(channelId: string, threadTs: string): boolean {
    return this.getRunByThread(channelId, threadTs) !== undefined;
  }

  /** Remove thread tracking (after run is archived) */
  removeThread(runId: string): void {
    this.threads.delete(runId);
  }
}
