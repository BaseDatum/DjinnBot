import { randomUUID } from 'node:crypto';
import { Redis, type Redis as RedisType } from 'ioredis';
import {
  channels,
  createTimestamp,
  type AgentStepCommand,
  type AttachmentMeta,
  type ToolCommand,
  type ShutdownCommand,
  type AbortCommand,
} from '../redis-protocol/index.js';

export class CommandSender {
  constructor(private redis: RedisType) {}

  private generateRequestId(): string {
    return `req_${randomUUID().slice(0, 8)}`;
  }

  async sendAgentStep(
    runId: string,
    prompt: string,
    options: {
      requestId?: string;
      tools?: string[];
      maxSteps?: number;
      attachments?: AttachmentMeta[];
    } = {}
  ): Promise<string> {
    const requestId = options.requestId ?? this.generateRequestId();

    const cmd: AgentStepCommand = {
      type: 'agentStep',
      requestId,
      prompt,
      tools: options.tools ?? [],
      maxSteps: options.maxSteps ?? 100,
      timestamp: createTimestamp(),
      ...(options.attachments?.length ? { attachments: options.attachments } : {}),
    };

    const channel = channels.command(runId);
    
    try {
      await this.redis.publish(channel, JSON.stringify(cmd));
      console.log(`[CommandSender] Sent agentStep to ${runId}: ${requestId}`);
    } catch (error) {
      console.error(`[CommandSender] Failed to send agentStep to ${runId}:`, error);
      throw new Error(`Failed to publish agentStep command to ${runId}: ${error instanceof Error ? error.message : String(error)}`);
    }

    return requestId;
  }

  async sendTool(
    runId: string,
    toolName: string,
    args: Record<string, unknown> = {},
    options: { requestId?: string } = {}
  ): Promise<string> {
    const requestId = options.requestId ?? this.generateRequestId();

    const cmd: ToolCommand = {
      type: 'tool',
      requestId,
      toolName,
      args,
      timestamp: createTimestamp(),
    };

    const channel = channels.command(runId);
    
    try {
      await this.redis.publish(channel, JSON.stringify(cmd));
      console.log(`[CommandSender] Sent tool ${toolName} to ${runId}: ${requestId}`);
    } catch (error) {
      console.error(`[CommandSender] Failed to send tool ${toolName} to ${runId}:`, error);
      throw new Error(`Failed to publish tool command (${toolName}) to ${runId}: ${error instanceof Error ? error.message : String(error)}`);
    }

    return requestId;
  }

  async sendShutdown(
    runId: string,
    options: { requestId?: string; graceful?: boolean } = {}
  ): Promise<string> {
    const requestId = options.requestId ?? this.generateRequestId();

    const cmd: ShutdownCommand = {
      type: 'shutdown',
      requestId,
      graceful: options.graceful ?? true,
      timestamp: createTimestamp(),
    };

    const channel = channels.command(runId);
    
    try {
      await this.redis.publish(channel, JSON.stringify(cmd));
      console.log(`[CommandSender] Sent shutdown to ${runId}: ${requestId}`);
    } catch (error) {
      console.error(`[CommandSender] Failed to send shutdown to ${runId}:`, error);
      throw new Error(`Failed to publish shutdown command to ${runId}: ${error instanceof Error ? error.message : String(error)}`);
    }

    return requestId;
  }

  async sendAbort(runId: string, options: { requestId?: string } = {}): Promise<string> {
    const requestId = options.requestId ?? this.generateRequestId();

    const cmd: AbortCommand = {
      type: 'abort',
      requestId,
      timestamp: createTimestamp(),
    };

    const channel = channels.command(runId);
    
    try {
      await this.redis.publish(channel, JSON.stringify(cmd));
      console.log(`[CommandSender] Sent abort to ${runId}: ${requestId}`);
    } catch (error) {
      console.error(`[CommandSender] Failed to send abort to ${runId}:`, error);
      throw new Error(`Failed to publish abort command to ${runId}: ${error instanceof Error ? error.message : String(error)}`);
    }

    return requestId;
  }
}
