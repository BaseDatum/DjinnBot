/**
 * groupMessages — Groups consecutive tool_call messages into collapsible blocks.
 *
 * Shared between AgentChat and OnboardingChat so both interfaces collapse
 * multiple consecutive tool calls into a single ToolCallGroupCard.
 */

import type { ChatMessageData } from './ChatMessage';

/** A rendered item is either a single message or a group of consecutive tool calls. */
export type RenderItem =
  | { kind: 'message'; msg: ChatMessageData }
  | { kind: 'tool_group'; calls: ChatMessageData[] };

/**
 * Group consecutive tool_call messages into collapsible groups.
 * Non-tool messages pass through as-is.
 */
export function groupMessages(messages: ChatMessageData[]): RenderItem[] {
  const result: RenderItem[] = [];
  let currentGroup: ChatMessageData[] = [];

  const flushGroup = () => {
    if (currentGroup.length > 0) {
      result.push({ kind: 'tool_group', calls: [...currentGroup] });
      currentGroup = [];
    }
  };

  for (const msg of messages) {
    if (msg.type === 'tool_call') {
      currentGroup.push(msg);
    } else {
      flushGroup();
      result.push({ kind: 'message', msg });
    }
  }
  flushGroup();

  return result;
}
