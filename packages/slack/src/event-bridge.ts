import { EventBus, runChannel, type PipelineEvent } from '@djinnbot/core';
import type { MessagingProvider } from './types.js';

/**
 * Bridges pipeline events to Slack messages
 */
export class SlackEventBridge {
  private eventBus: EventBus;
  private messaging: MessagingProvider;
  private defaultChannelId: string;
  private activeRuns = new Map<string, {
    threadId: string;
    channelId: string;
    unsubscribe: () => void;
    threadReady: Promise<string>;
    resolveThread: (threadId: string) => void;
  }>();

  constructor(options: {
    eventBus: EventBus;
    messaging: MessagingProvider;
    defaultChannelId: string;
  }) {
    this.eventBus = options.eventBus;
    this.messaging = options.messaging;
    this.defaultChannelId = options.defaultChannelId;
  }

  /**
   * Start bridging events for a specific pipeline run
   */
  async bridgeRun(runId: string, channelId?: string): Promise<void> {
    if (this.activeRuns.has(runId)) {
      console.log(`Run ${runId} is already being bridged`);
      return;
    }

    const targetChannelId = channelId || this.defaultChannelId;
    const channel = runChannel(runId);

    // Subscribe to run events
    const unsubscribe = this.eventBus.subscribe(channel, (event) => {
      const runInfo = this.activeRuns.get(runId);
      if (!runInfo) return;
      void this.handleEvent(runId, event as PipelineEvent);
    });

    // Create a promise that resolves when the thread is created
    let resolveThread: (threadId: string) => void;
    const threadReady = new Promise<string>((resolve) => {
      resolveThread = resolve;
    });

    this.activeRuns.set(runId, {
      threadId: '', // Will be set on RUN_CREATED
      channelId: targetChannelId,
      unsubscribe,
      threadReady,
      resolveThread: resolveThread!,
    });

    console.log(`Started bridging events for run ${runId}`);
  }

  /**
   * Stop bridging events for a run
   */
  stopRun(runId: string): void {
    const runInfo = this.activeRuns.get(runId);
    if (runInfo) {
      runInfo.unsubscribe();
      this.activeRuns.delete(runId);
      console.log(`Stopped bridging events for run ${runId}`);
    }
  }

  /**
   * Handle pipeline events and map them to Slack messages
   */
  private async handleEvent(
    runId: string,
    event: PipelineEvent
  ): Promise<void> {
    try {
      const runInfo = this.activeRuns.get(runId);
      if (!runInfo) return;

      // Wait for thread to be ready (except for RUN_CREATED which creates it)
      const threadId = event.type === 'RUN_CREATED'
        ? ''
        : await runInfo.threadReady;

      switch (event.type) {
        case 'RUN_CREATED': {
          // Create the thread and initial status message
          const newThreadId = await this.messaging.createThread({
            channelId: runInfo.channelId,
            title: event.taskDescription,
            runId: event.runId,
          });

          // Update the stored threadId and resolve the promise
          runInfo.threadId = newThreadId;
          runInfo.resolveThread(newThreadId);

          // Post started status
          await this.messaging.postStatus({
            threadId: newThreadId,
            status: 'started',
            title: 'Pipeline Started',
            details: `Pipeline: ${event.pipelineId}`,
          });
          break;
        }

        case 'STEP_QUEUED': {
          await this.messaging.postMessage({
            threadId,
            agentId: 'system',
            content: `⏳ Step *${event.stepId}* queued for *${event.agentId}*`,
          });
          break;
        }

        case 'STEP_STARTED': {
          await this.messaging.postMessage({
            threadId,
            agentId: 'system',
            content: `🔄 Working on step *${event.stepId}* (session: ${event.sessionId})`,
          });
          break;
        }

        case 'STEP_COMPLETE': {
          const outputs = Object.entries(event.outputs)
            .map(([key, value]) => `• ${key}: ${value.substring(0, 100)}${value.length > 100 ? '...' : ''}`)
            .join('\n');

          await this.messaging.postMessage({
            threadId,
            agentId: 'system',
            content: `✅ Step *${event.stepId}* completed`,
          });

          await this.messaging.postStatus({
            threadId,
            status: 'step_update',
            title: `Step Complete: ${event.stepId}`,
            details: outputs || undefined,
          });
          break;
        }

        case 'STEP_FAILED': {
          await this.messaging.postMessage({
            threadId,
            agentId: 'system',
            content: `❌ Step *${event.stepId}* failed\n\nError: \`\`\`${event.error}\`\`\``,
          });
          break;
        }

        case 'STEP_RETRYING': {
          await this.messaging.postMessage({
            threadId,
            agentId: 'system',
            content: `🔁 Retrying step *${event.stepId}*\n\nFeedback: ${event.feedback}`,
          });
          break;
        }

        case 'RUN_COMPLETE': {
          const outputs = Object.entries(event.outputs)
            .map(([key, value]) => `• ${key}: ${value.substring(0, 100)}${value.length > 100 ? '...' : ''}`)
            .join('\n');

          await this.messaging.postStatus({
            threadId,
            status: 'completed',
            title: 'Pipeline Completed Successfully',
            details: outputs || undefined,
          });

          // Stop bridging after completion
          this.stopRun(runId);
          break;
        }

        case 'RUN_FAILED': {
          await this.messaging.postStatus({
            threadId,
            status: 'failed',
            title: 'Pipeline Failed',
            details: event.error,
          });

          // Stop bridging after failure
          this.stopRun(runId);
          break;
        }

        case 'AGENT_MESSAGE': {
          await this.messaging.postMessage({
            threadId,
            agentId: event.from,
            content: `💬 Message to *${event.to}*:\n${event.message}`,
          });
          break;
        }

        case 'STEP_OUTPUT': {
          // Optionally post output chunks (might be too verbose)
          break;
        }

        case 'STEP_THINKING': {
          // Agent reasoning/thinking — not posted to Slack
          break;
        }

        case 'STEP_CANCELLED':
        case 'STEP_ERROR':
        case 'LOOP_ITEM_COMPLETE':
        case 'LOOP_ITEM_FAILED':
        case 'HUMAN_INTERVENTION':
        case 'SLACK_MESSAGE':
        case 'AGENT_STATE':
        case 'AGENT_STATE_CHANGED':
        case 'AGENT_THINKING':
        case 'TOOL_CALL_START':
        case 'TOOL_CALL_END':
        case 'TOOL_STARTED':
        case 'TOOL_COMPLETE':
        case 'FILE_CHANGED':
        case 'RUN_CREATED':
        case 'STEP_QUEUED':
        case 'CONTAINER_CRASHED':
        case 'CONTAINER_STOPPED':
        case 'CONTAINER_CREATE_FAILED':
        case 'REDIS_CONNECTION_ERROR':
        case 'CONTAINER_REDIS_ERROR':
        case 'CONTAINER_REDIS_CLOSE':
        case 'CONTAINER_REDIS_RECONNECTING':
        case 'CONTAINER_CRASH':
        case 'CONTAINER_START_ERROR': {
          // These events can be logged or ignored depending on verbosity needs
          break;
        }

        case 'COMMIT_FAILED': {
          // Git commit failure - log but don't block the run
          console.warn(`Git commit failed for step ${event.stepId}: ${event.error}`);
          break;
        }

        default: {
          // Exhaustive check - TypeScript will error if we miss a case
          const _exhaustiveCheck: never = event;
          break;
        }
      }
    } catch (error) {
      console.error(`Error handling event ${event.type} for run ${runId}:`, error);
    }
  }

  /**
   * Shutdown the bridge and clean up all subscriptions
   */
  async shutdown(): Promise<void> {
    for (const [runId] of this.activeRuns) {
      this.stopRun(runId);
    }
    this.activeRuns.clear();
    console.log('SlackEventBridge shutdown complete');
  }
}
