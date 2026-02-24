import { loadConfig } from './config.js';
import { createRedisClient, createSubscriber } from './redis/client.js';
import { startCommandListener } from './redis/listener.js';
import { RedisPublisher } from './redis/publisher.js';
import { ContainerAgentRunner } from './agent/runner.js';
import { startFileWatcher } from './tools/watcher.js';
import type { StepStartEvent, StepEndEvent, StructuredOutputCommand } from '@djinnbot/core';

async function main(): Promise<void> {
  const config = loadConfig();
  console.log(`[AgentRuntime] Starting for run ${config.runId}`);

  // Setup Redis connections
  const redis = createRedisClient(config);
  const subscriber = createSubscriber(config);
  // Dedicated subscriber for broadcast channels (MCP grant invalidation)
  const broadcastSubscriber = createSubscriber(config);
  const publisher = new RedisPublisher(redis, config.runId);

  await redis.connect();
  await subscriber.connect();
  await broadcastSubscriber.connect();

  // Create agent runner with mounted paths.
  // IMPORTANT: Use config.personalVaultPath / config.sharedVaultPath — these
  // have symlinks resolved via realpathSync.  Raw env vars like
  // CLAWVAULT_PERSONAL point to symlinks (e.g. /home/agent/clawvault/shared →
  // /djinnbot-data/vaults/shared) and glob v10 cannot expand '**' through
  // symlinks, which causes the graph builder to find zero files.
  console.log(`[AgentRuntime] Vault paths: personal=${config.personalVaultPath}, shared=${config.sharedVaultPath}`);
  const runner = new ContainerAgentRunner({
    publisher,
    redis,
    agentId: process.env.AGENT_ID || 'unknown',
    workspacePath: config.workspacePath,
    vaultPath: config.personalVaultPath,
    sharedPath: config.sharedVaultPath,
    model: process.env.AGENT_MODEL,
    agentsDir: process.env.AGENTS_DIR,
    thinkingLevel: process.env.AGENT_THINKING_LEVEL,
  });

  // Seed conversation history if provided (chat session resume).
  // AGENT_CHAT_HISTORY is a JSON array of {role, content, created_at} objects
  // passed by the engine when starting a container for a resumed session.
  const agentSystemPrompt = process.env.AGENT_SYSTEM_PROMPT || '';
  const chatHistoryRaw = process.env.AGENT_CHAT_HISTORY || '';
  if (chatHistoryRaw) {
    try {
      const history: Array<{ role: string; content: string; created_at?: number }> = JSON.parse(chatHistoryRaw);
      if (Array.isArray(history) && history.length > 0) {
        console.log(`[AgentRuntime] Seeding ${history.length} historical messages into agent`);
        runner.seedHistory(agentSystemPrompt, history);
      }
    } catch (err) {
      console.warn('[AgentRuntime] Failed to parse AGENT_CHAT_HISTORY:', err);
    }
  }

  // Subscribe to MCP grant/revoke broadcast channel.
  // When the API server modifies MCP grants for this agent, it publishes
  // to 'djinnbot:mcp:grants-changed'. We mark the runner's MCP tool cache
  // dirty so the next turn re-fetches definitions from the API.
  const agentId = process.env.AGENT_ID || 'unknown';
  const MCP_GRANTS_CHANNEL = 'djinnbot:mcp:grants-changed';
  const TOOL_OVERRIDES_CHANNEL = 'djinnbot:tools:overrides-changed';

  broadcastSubscriber.on('message', (ch: string, message: string) => {
    // MCP grant changes
    if (ch === MCP_GRANTS_CHANNEL) {
      try {
        const data = JSON.parse(message);
        if (!data.agent_id || data.agent_id === agentId) {
          runner.invalidateMcpTools();
        }
      } catch {
        runner.invalidateMcpTools();
      }
      return;
    }

    // Built-in tool override changes
    if (ch === TOOL_OVERRIDES_CHANNEL) {
      try {
        const data = JSON.parse(message);
        if (!data.agent_id || data.agent_id === agentId) {
          runner.invalidateToolOverrides();
        }
      } catch {
        runner.invalidateToolOverrides();
      }
      return;
    }
  });

  await broadcastSubscriber.subscribe(MCP_GRANTS_CHANNEL);
  await broadcastSubscriber.subscribe(TOOL_OVERRIDES_CHANNEL);
  console.log(`[AgentRuntime] Subscribed to ${MCP_GRANTS_CHANNEL} and ${TOOL_OVERRIDES_CHANNEL} for agent ${agentId}`);

  // Start file watcher
  // File watcher runs continuously - requestId is undefined since changes
  // may occur outside of any specific request context
  const watcher = startFileWatcher(publisher, undefined, {
    workspacePath: config.workspacePath,
  });

  // IMPORTANT: Start command listener BEFORE publishing ready status!
  // Redis pub/sub doesn't queue messages - if we publish "ready" before subscribing
  // to the command channel, the engine may send commands that get lost because
  // we weren't listening yet.
  await startCommandListener(subscriber, config.runId, {
    onAgentStep: async (cmd) => {
      console.log(`[AgentRuntime] Received agent step: ${cmd.requestId}`);

      // Publish busy status
      await publisher.publishStatus({
        type: 'busy',
        runId: config.runId,
        requestId: cmd.requestId,
      });

      // Publish step start event
      const stepStart: Omit<StepStartEvent, 'timestamp'> = {
        type: 'stepStart',
        requestId: cmd.requestId,
        stepNumber: 1,
      };
      await publisher.publishEvent(stepStart);

      try {
        // Run the agent step.
        // agentSystemPrompt is read from AGENT_SYSTEM_PROMPT env var (set by
        // ChatSessionManager from the agent's persona files). It is only used
        // on the very first turn — the persistent Agent retains it afterward.
        // userPrompt is the new user message for this turn only; the persistent
        // Agent accumulates full conversation history across turns internally.
        const result = await runner.runStep(
          cmd.requestId,
          agentSystemPrompt,  // systemPrompt — from persona, used on first turn
          cmd.prompt,         // userPrompt  — the new message for this turn
          cmd.attachments,    // optional file attachments (images, documents)
        );

        // Publish step end event
        const stepEnd: Omit<StepEndEvent, 'timestamp'> = {
          type: 'stepEnd',
          requestId: cmd.requestId,
          stepNumber: 1,
          result: result.output || result.error || '',
          success: result.success,
        };
        await publisher.publishEvent(stepEnd);
      } catch (err) {
        const error = err instanceof Error ? err.message : String(err);
        console.error(`[AgentRuntime] Step failed:`, error);

        const stepEnd: Omit<StepEndEvent, 'timestamp'> = {
          type: 'stepEnd',
          requestId: cmd.requestId,
          stepNumber: 1,
          result: error,
          success: false,
        };
        await publisher.publishEvent(stepEnd);
      }

      // Publish idle status
      await publisher.publishStatus({ type: 'idle', runId: config.runId });
    },

    onTool: async (cmd) => {
      console.log(`[AgentRuntime] Received direct tool call: ${cmd.toolName}`);
      // Direct tool execution can be implemented later if needed
      // For now, most tool calls go through the agent loop
    },

    onShutdown: async (_cmd) => {
      console.log(`[AgentRuntime] Shutdown requested`);

      // Stop file watcher
      await watcher.close();

      // Publish exiting status
      await publisher.publishStatus({ type: 'exiting', runId: config.runId });

      // Cleanup Redis connections
      await broadcastSubscriber.quit();
      await subscriber.quit();
      await redis.quit();

      process.exit(0);
    },

    onAbort: async (cmd) => {
      console.log(`[AgentRuntime] Abort requested: ${cmd.requestId}`);
      
      // Abort the current agent step
      runner.abort();
      
      // Publish idle status
      await publisher.publishStatus({ type: 'idle', runId: config.runId });
    },

    onStructuredOutput: async (cmd: StructuredOutputCommand) => {
      console.log(`[AgentRuntime] Received structured output request: ${cmd.requestId}`);

      // Publish busy status
      await publisher.publishStatus({
        type: 'busy',
        runId: config.runId,
        requestId: cmd.requestId,
      });

      // Publish step start event
      const stepStart: Omit<StepStartEvent, 'timestamp'> = {
        type: 'stepStart',
        requestId: cmd.requestId,
        stepNumber: 1,
      };
      await publisher.publishEvent(stepStart);

      try {
        const result = await runner.runStructuredOutput({
          requestId: cmd.requestId,
          systemPrompt: cmd.systemPrompt,
          userPrompt: cmd.prompt,
          outputSchema: cmd.outputSchema,
          outputMethod: cmd.outputMethod,
          temperature: cmd.temperature,
          model: cmd.model,
        });

        // Publish step end event — result is the raw JSON for structured output
        const stepEnd: Omit<StepEndEvent, 'timestamp'> = {
          type: 'stepEnd',
          requestId: cmd.requestId,
          stepNumber: 1,
          result: result.rawJson || result.error || '',
          success: result.success,
        };
        await publisher.publishEvent(stepEnd);
      } catch (err) {
        const error = err instanceof Error ? err.message : String(err);
        console.error(`[AgentRuntime] Structured output failed:`, error);

        const stepEnd: Omit<StepEndEvent, 'timestamp'> = {
          type: 'stepEnd',
          requestId: cmd.requestId,
          stepNumber: 1,
          result: error,
          success: false,
        };
        await publisher.publishEvent(stepEnd);
      }

      // Publish idle status
      await publisher.publishStatus({ type: 'idle', runId: config.runId });
    },
  });

  // NOW publish ready status - command listener is already subscribed
  await publisher.publishStatus({ type: 'ready', runId: config.runId });
  console.log(`[AgentRuntime] Published ready status`);

  console.log(`[AgentRuntime] Ready and listening for commands`);

  // Handle process signals
  process.on('SIGTERM', async () => {
    console.log(`[AgentRuntime] SIGTERM received`);
    await watcher.close();
    await publisher.publishStatus({ type: 'exiting', runId: config.runId });
    await broadcastSubscriber.quit().catch(() => {});
    process.exit(0);
  });
}

main().catch((err) => {
  console.error('[AgentRuntime] Fatal error:', err);
  process.exit(1);
});
