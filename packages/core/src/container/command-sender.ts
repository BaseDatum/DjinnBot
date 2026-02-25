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
  type StructuredOutputCommand,
  type ChangeModelCommand,
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
      /** Optional model override for this turn — hot-swaps seamlessly. */
      model?: string;
    } = {}
  ): Promise<string> {
    const requestId = options.requestId ?? this.generateRequestId();

    const cmd: AgentStepCommand = {
      type: 'agentStep',
      requestId,
      prompt,
      tools: options.tools ?? [],
      maxSteps: options.maxSteps ?? 999,
      timestamp: createTimestamp(),
      ...(options.attachments?.length ? { attachments: options.attachments } : {}),
      ...(options.model ? { model: options.model } : {}),
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

  /**
   * Send a model change command to a running container.
   * The container hot-swaps the model seamlessly — full conversation context
   * is preserved. The new model takes effect on the very next turn.
   */
  async sendChangeModel(
    runId: string,
    model: string,
    options: { requestId?: string } = {}
  ): Promise<string> {
    const requestId = options.requestId ?? this.generateRequestId();

    const cmd: ChangeModelCommand = {
      type: 'changeModel',
      requestId,
      model,
      timestamp: createTimestamp(),
    };

    const channel = channels.command(runId);

    try {
      await this.redis.publish(channel, JSON.stringify(cmd));
      console.log(`[CommandSender] Sent changeModel to ${runId}: ${model}`);
    } catch (error) {
      console.error(`[CommandSender] Failed to send changeModel to ${runId}:`, error);
      throw new Error(`Failed to publish changeModel command to ${runId}: ${error instanceof Error ? error.message : String(error)}`);
    }

    return requestId;
  }

  async sendStructuredOutput(
    runId: string,
    prompt: string,
    options: {
      requestId?: string;
      systemPrompt: string;
      outputSchema: {
        name: string;
        schema: Record<string, unknown>;
        strict?: boolean;
      };
      outputMethod?: 'response_format' | 'tool_use';
      temperature?: number;
      model?: string;
    }
  ): Promise<string> {
    const requestId = options.requestId ?? this.generateRequestId();

    const cmd: StructuredOutputCommand = {
      type: 'structuredOutput',
      requestId,
      prompt,
      systemPrompt: options.systemPrompt,
      outputSchema: options.outputSchema,
      outputMethod: options.outputMethod,
      temperature: options.temperature,
      model: options.model,
      timestamp: createTimestamp(),
    };

    const channel = channels.command(runId);
    
    try {
      await this.redis.publish(channel, JSON.stringify(cmd));
      console.log(`[CommandSender] Sent structuredOutput to ${runId}: ${requestId}`);
    } catch (error) {
      console.error(`[CommandSender] Failed to send structuredOutput to ${runId}:`, error);
      throw new Error(`Failed to publish structuredOutput command to ${runId}: ${error instanceof Error ? error.message : String(error)}`);
    }

    return requestId;
  }
}
