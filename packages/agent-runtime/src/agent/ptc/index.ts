/**
 * Programmatic Tool Calling (PTC) — Public API
 *
 * PTC allows the LLM to write Python code that calls tools programmatically,
 * reducing context usage by 30-40%+ by:
 *  1. Removing tool JSON schemas from the prompt (replaced by compact signatures)
 *  2. Keeping intermediate tool results out of the LLM's context window
 *
 * Usage:
 *   const ptc = await initPtc({ tools, publisher, requestIdRef });
 *   // ptc.directTools   → pass to agent.setTools() (includes exec_code)
 *   // ptc.ptcTools       → tools callable only via exec_code
 *   // ptc.execCodeTool   → the exec_code AgentTool
 *   // ptc.ipcServer      → the IPC bridge (auto-started)
 */

export { classifyTool, splitTools, type PtcMode } from './tool-classifier.js';
export { generatePythonSdk, wrapUserCode, generateCompactReference } from './sdk-generator.js';
export { startPtcIpcServer, type PtcIpcServer, type PtcIpcServerOptions } from './ipc-server.js';
export { createExecCodeTool, refreshExecCodeTool, type ExecCodeToolConfig } from './exec-code.js';

import type { AgentTool } from '@mariozechner/pi-agent-core';
import type { RedisPublisher } from '../../redis/publisher.js';
import type { RequestIdRef } from '../runner.js';
import { splitTools } from './tool-classifier.js';
import { startPtcIpcServer, type PtcIpcServer } from './ipc-server.js';
import { createExecCodeTool } from './exec-code.js';

export interface PtcInitOptions {
  /** All registered tools (built-in + MCP). Will be split into direct vs PTC. */
  tools: AgentTool[];
  /** Redis publisher for streaming events. */
  publisher: RedisPublisher;
  /** Mutable ref to current requestId. */
  requestIdRef: RequestIdRef;
}

export interface PtcInstance {
  /**
   * Tools to pass to agent.setTools().
   * Contains only the direct tools + the exec_code tool.
   * PTC-eligible tool schemas are NOT included (they're in exec_code's description).
   */
  agentTools: AgentTool[];

  /** The direct-only tools (lifecycle, orchestration). */
  directTools: AgentTool[];

  /** PTC-eligible tools (callable from exec_code only). */
  ptcTools: AgentTool[];

  /** The exec_code AgentTool instance. */
  execCodeTool: AgentTool;

  /** The IPC server bridge. */
  ipcServer: PtcIpcServer;

  /**
   * Refresh the PTC instance with new tools (e.g. after MCP refresh).
   * Updates the IPC server's tool map and regenerates exec_code description.
   * Returns the new agentTools array to pass to agent.setTools().
   */
  refresh(tools: AgentTool[]): AgentTool[];

  /** Shut down the IPC server. */
  close(): Promise<void>;
}

/**
 * Initialize Programmatic Tool Calling.
 *
 * Starts the IPC server, splits tools, generates the exec_code tool,
 * and returns everything the runner needs.
 */
export async function initPtc(options: PtcInitOptions): Promise<PtcInstance> {
  const { publisher, requestIdRef } = options;
  const { directTools, ptcTools } = splitTools(options.tools);

  // Build the tool map for the IPC server
  const toolMap = new Map<string, AgentTool>();
  for (const tool of ptcTools) {
    toolMap.set(tool.name, tool);
  }

  // Start the IPC server
  const ipcServer = await startPtcIpcServer({
    tools: toolMap,
    publisher,
    requestIdRef,
  });

  // Create the exec_code tool
  const execCodeTool = createExecCodeTool({
    ipcServer,
    ptcTools,
    publisher,
    requestIdRef,
  });

  // The tools the agent sees: direct tools + exec_code
  const initialAgentTools = [...directTools, execCodeTool];

  console.log(
    `[PTC] Initialized: ${directTools.length} direct tools, ${ptcTools.length} PTC tools, ` +
    `exec_code tool on port ${ipcServer.port}`
  );

  // Mutable state held by the instance
  const instance: PtcInstance = {
    agentTools: initialAgentTools,
    directTools,
    ptcTools,
    execCodeTool,
    ipcServer,

    refresh(newTools: AgentTool[]): AgentTool[] {
      const split = splitTools(newTools);

      // Update IPC server's tool map
      const newMap = new Map<string, AgentTool>();
      for (const tool of split.ptcTools) {
        newMap.set(tool.name, tool);
      }
      ipcServer.updateTools(newMap);

      // Regenerate exec_code tool with updated compact reference
      const newExecCodeTool = createExecCodeTool({
        ipcServer,
        ptcTools: split.ptcTools,
        publisher,
        requestIdRef,
      });

      const newAgentTools = [...split.directTools, newExecCodeTool];

      // Update instance state
      instance.directTools = split.directTools;
      instance.ptcTools = split.ptcTools;
      instance.execCodeTool = newExecCodeTool;
      instance.agentTools = newAgentTools;

      console.log(
        `[PTC] Refreshed: ${split.directTools.length} direct, ${split.ptcTools.length} PTC`
      );

      return newAgentTools;
    },

    async close() {
      await ipcServer.close();
    },
  };

  return instance;
}
