/**
 * ThreadManager — manages the lifecycle of Discord threads for pipeline runs.
 *
 * The first assigned agent creates a thread in the configured channel,
 * and all agents post their step updates into that thread.
 */

import type { Client, TextChannel, ThreadChannel } from 'discord.js';
import type { AgentRegistryEntry } from '@djinnbot/core';

export interface RunThread {
  runId: string;
  pipelineId: string;
  taskDescription: string;
  channelId: string;
  threadId: string;
  createdAt: number;
  assignedAgents: string[];
  /** Client of the agent who created the thread */
  ownerClient: Client;
}

export interface ThreadManagerConfig {
  /** Default channel for run threads */
  defaultChannelId?: string;
  /** Map of agentId → Client for all Discord-connected agents */
  agentClients: Map<string, Client>;
}

export class ThreadManager {
  private threads = new Map<string, RunThread>();
  private config: ThreadManagerConfig;

  constructor(config: ThreadManagerConfig) {
    this.config = config;
  }

  /**
   * Create a thread for a new pipeline run.
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
      console.warn('[ThreadManager] No channelId configured — cannot create Discord thread');
      return null;
    }

    const firstAgent = options.assignedAgents[0];
    if (!firstAgent) {
      console.warn('[ThreadManager] No assigned agents — cannot create thread');
      return null;
    }

    const client = this.config.agentClients.get(firstAgent.id);
    if (!client) {
      console.warn(`[ThreadManager] Agent ${firstAgent.id} has no Discord client`);
      return null;
    }

    try {
      const channel = await client.channels.fetch(channelId) as TextChannel;
      if (!channel || !('threads' in channel)) {
        console.warn(`[ThreadManager] Channel ${channelId} is not a text channel`);
        return null;
      }

      // Build agent roster
      const agentList = options.assignedAgents
        .map((a) => `${a.identity.emoji} **${a.identity.name}** — ${a.identity.role}`)
        .join('\n');

      // Post initial message
      const message = await channel.send({
        embeds: [{
          title: '🧞 Pipeline Run Started',
          description: [
            `**Task:** ${options.taskDescription}`,
            `**Pipeline:** ${options.pipelineId}`,
            `**Run:** \`${options.runId}\``,
            '',
            '**Assigned Agents:**',
            agentList,
          ].join('\n'),
          color: 0x5865F2,
          timestamp: new Date().toISOString(),
        }],
      });

      // Create thread from the message
      const thread = await message.startThread({
        name: `Run: ${options.taskDescription.slice(0, 90)}`,
        autoArchiveDuration: 1440, // 24 hours
      });

      const runThread: RunThread = {
        runId: options.runId,
        pipelineId: options.pipelineId,
        taskDescription: options.taskDescription,
        channelId,
        threadId: thread.id,
        createdAt: Date.now(),
        assignedAgents: options.assignedAgents.map((a) => a.id),
        ownerClient: client,
      };

      this.threads.set(options.runId, runThread);
      console.log(
        `[ThreadManager] ${firstAgent.identity.name} created thread for run ${options.runId}: ${thread.id}`,
      );
      return runThread;
    } catch (err) {
      console.error('[ThreadManager] Error creating thread:', err);
      return null;
    }
  }

  /**
   * Update the top-level thread when a run completes or fails.
   */
  async updateRunStatus(
    runId: string,
    status: 'completed' | 'failed',
    details?: string,
  ): Promise<void> {
    const thread = this.threads.get(runId);
    if (!thread) return;

    const emoji = status === 'completed' ? '✅' : '❌';

    try {
      const threadChannel = await thread.ownerClient.channels.fetch(thread.threadId) as ThreadChannel;
      if (threadChannel && 'send' in threadChannel) {
        await threadChannel.send({
          embeds: [{
            title: `${emoji} Run ${status.toUpperCase()}`,
            description: details ?? undefined,
            color: status === 'completed' ? 0x57F287 : 0xED4245,
            timestamp: new Date().toISOString(),
          }],
        });
      }
    } catch (err) {
      console.error('[ThreadManager] Error updating run status:', err);
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

  /** Get runId by thread info */
  getRunByThread(channelId: string, threadId: string): string | undefined {
    for (const [runId, thread] of this.threads) {
      if (thread.channelId === channelId && thread.threadId === threadId) {
        return runId;
      }
    }
    return undefined;
  }

  /** Check if a thread is a pipeline work thread */
  isPipelineThread(channelId: string, threadId: string): boolean {
    return this.getRunByThread(channelId, threadId) !== undefined;
  }

  /** Remove thread tracking */
  removeThread(runId: string): void {
    this.threads.delete(runId);
  }
}
