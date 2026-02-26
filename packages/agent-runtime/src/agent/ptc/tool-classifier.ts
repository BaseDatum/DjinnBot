/**
 * Tool Classifier for Programmatic Tool Calling (PTC)
 *
 * Classifies each tool as either "direct" (stays as a normal JSON tool call
 * in the LLM prompt) or "ptc" (schema removed from prompt, callable only
 * via the exec_code tool).
 *
 * Direct tools are ones that control agent lifecycle or orchestration and
 * need the LLM to make a deliberate, single-shot decision.
 *
 * PTC tools are high-frequency, data-heavy tools where writing code to
 * call them (loop, filter, aggregate) saves context and latency.
 *
 * All MCP tools are always PTC.
 */

import type { AgentTool } from '@mariozechner/pi-agent-core';

export type PtcMode = 'direct' | 'ptc';

/**
 * Built-in tool names that MUST stay as direct JSON tool calls.
 * These tools control the agent loop lifecycle — calling them sets
 * stepCompleted/stepResult on the runner, which breaks the pi-agent-core
 * loop. If called via exec_code's IPC, the result goes to the Python
 * subprocess instead of the agent loop, so the step never terminates.
 */
const DIRECT_ONLY_TOOLS = new Set<string>([
  // Lifecycle — signals step completion/failure, aborts agent loop
  'complete',
  'fail',

  // Lifecycle — hands off to next agent, stops container
  'onboarding_handoff',
]);

/**
 * Classify a tool as direct or PTC.
 *
 * MCP tools (identified by double-underscore in name, e.g. "github__list_issues")
 * are always PTC. Built-in tools are classified by the DIRECT_ONLY_TOOLS set.
 */
export function classifyTool(tool: AgentTool): PtcMode {
  // MCP tools always PTC (namespaced as "serverId__toolName")
  if (tool.name.includes('__')) {
    return 'ptc';
  }

  if (DIRECT_ONLY_TOOLS.has(tool.name)) {
    return 'direct';
  }

  return 'ptc';
}

/**
 * Split a tool array into direct and PTC sets.
 */
export function splitTools(tools: AgentTool[]): {
  directTools: AgentTool[];
  ptcTools: AgentTool[];
} {
  const directTools: AgentTool[] = [];
  const ptcTools: AgentTool[] = [];

  for (const tool of tools) {
    if (classifyTool(tool) === 'direct') {
      directTools.push(tool);
    } else {
      ptcTools.push(tool);
    }
  }

  return { directTools, ptcTools };
}
