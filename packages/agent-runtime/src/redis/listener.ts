import { Redis } from 'ioredis';
import { channels, commandMessageSchema } from '@djinnbot/core';
import type { AgentStepCommand, ToolCommand, ShutdownCommand, AbortCommand, StructuredOutputCommand, ChangeModelCommand } from '@djinnbot/core';

export interface CommandHandler {
  onAgentStep: (cmd: AgentStepCommand) => Promise<void>;
  onTool: (cmd: ToolCommand) => Promise<void>;
  onShutdown: (cmd: ShutdownCommand) => Promise<void>;
  onAbort: (cmd: AbortCommand) => Promise<void>;
  onStructuredOutput?: (cmd: StructuredOutputCommand) => Promise<void>;
  /** Called when the engine sends a model change command between turns. */
  onChangeModel?: (cmd: ChangeModelCommand) => Promise<void>;
}

export async function startCommandListener(
  subscriber: Redis,
  runId: string,
  handler: CommandHandler
): Promise<() => void> {
  const channel = channels.command(runId);

  subscriber.on('message', async (ch: string, message: string) => {
    if (ch !== channel) return;

    try {
      const parsed = JSON.parse(message);
      const cmd = commandMessageSchema.parse(parsed);

      switch (cmd.type) {
        case 'agentStep':
          await handler.onAgentStep(cmd);
          break;
        case 'tool':
          await handler.onTool(cmd);
          break;
        case 'shutdown':
          await handler.onShutdown(cmd);
          break;
        case 'abort':
          await handler.onAbort(cmd);
          break;
        case 'structuredOutput':
          if (handler.onStructuredOutput) {
            await handler.onStructuredOutput(cmd);
          } else {
            console.warn('[CommandListener] Received structuredOutput command but no handler registered');
          }
          break;
        case 'changeModel':
          if (handler.onChangeModel) {
            await handler.onChangeModel(cmd);
          } else {
            console.warn('[CommandListener] Received changeModel command but no handler registered');
          }
          break;
      }
    } catch (err) {
      console.error('[CommandListener] Failed to process message:', err);
    }
  });

  await subscriber.subscribe(channel);
  console.log(`[CommandListener] Subscribed to ${channel}`);

  return () => {
    subscriber.unsubscribe(channel);
  };
}