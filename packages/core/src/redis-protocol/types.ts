import { z } from "zod";

// ============================================================================
// Common Fields
// ============================================================================

export const baseMessageSchema = z.object({
  requestId: z.string().optional(),
  timestamp: z.number(),
});

export type BaseMessage = z.infer<typeof baseMessageSchema>;

// ============================================================================
// Command Messages (Engine → Container)
// ============================================================================

export const attachmentMetaSchema = z.object({
  id: z.string(),
  filename: z.string(),
  mimeType: z.string(),
  sizeBytes: z.number(),
  isImage: z.boolean(),
  estimatedTokens: z.number().optional(),
});

export type AttachmentMeta = z.infer<typeof attachmentMetaSchema>;

export const agentStepCommandSchema = baseMessageSchema.extend({
  type: z.literal("agentStep"),
  requestId: z.string(),
  prompt: z.string(),
  tools: z.array(z.string()).default([]),
  maxSteps: z.number().default(999),
  attachments: z.array(attachmentMetaSchema).optional(),
  /** Optional model override for this turn. When set, the runner hot-swaps
   *  to this model seamlessly (preserving full conversation context). */
  model: z.string().optional(),
});

export type AgentStepCommand = z.infer<typeof agentStepCommandSchema>;

export const toolCommandSchema = baseMessageSchema.extend({
  type: z.literal("tool"),
  requestId: z.string(),
  toolName: z.string(),
  args: z.record(z.unknown()).default({}),
});

export type ToolCommand = z.infer<typeof toolCommandSchema>;

export const shutdownCommandSchema = baseMessageSchema.extend({
  type: z.literal("shutdown"),
  requestId: z.string().optional(),
  graceful: z.boolean().default(true),
});

export type ShutdownCommand = z.infer<typeof shutdownCommandSchema>;

export const abortCommandSchema = baseMessageSchema.extend({
  type: z.literal("abort"),
  requestId: z.string(),
});

export type AbortCommand = z.infer<typeof abortCommandSchema>;

export const changeModelCommandSchema = baseMessageSchema.extend({
  type: z.literal("changeModel"),
  requestId: z.string().optional(),
  /** New model string in "provider/model-id" format. */
  model: z.string(),
});

export type ChangeModelCommand = z.infer<typeof changeModelCommandSchema>;

export const structuredOutputCommandSchema = baseMessageSchema.extend({
  type: z.literal("structuredOutput"),
  requestId: z.string(),
  prompt: z.string(),
  systemPrompt: z.string(),
  outputSchema: z.object({
    name: z.string(),
    schema: z.record(z.unknown()),
    strict: z.boolean().optional(),
  }),
  outputMethod: z.enum(["response_format", "tool_use"]).optional(),
  temperature: z.number().optional(),
  maxOutputTokens: z.number().optional(),
  model: z.string().optional(),
});

export type StructuredOutputCommand = z.infer<typeof structuredOutputCommandSchema>;

export const commandMessageSchema = z.discriminatedUnion("type", [
  agentStepCommandSchema,
  toolCommandSchema,
  shutdownCommandSchema,
  abortCommandSchema,
  structuredOutputCommandSchema,
  changeModelCommandSchema,
]);

export type CommandMessage =
  | AgentStepCommand
  | ToolCommand
  | ShutdownCommand
  | AbortCommand
  | StructuredOutputCommand
  | ChangeModelCommand;

// ============================================================================
// Output Messages (Container → Engine)
// ============================================================================

export const stdoutMessageSchema = baseMessageSchema.extend({
  type: z.literal("stdout"),
  requestId: z.string().optional(),
  data: z.string(),
  /** Distinguish assistant text tokens from tool (bash) streaming output.
   *  'assistant' (default) = LLM text delta, 'tool' = bash stdout/stderr. */
  source: z.enum(["assistant", "tool"]).optional(),
});

export type StdoutMessage = z.infer<typeof stdoutMessageSchema>;

export const stderrMessageSchema = baseMessageSchema.extend({
  type: z.literal("stderr"),
  requestId: z.string().optional(),
  data: z.string(),
  source: z.enum(["assistant", "tool"]).optional(),
});

export type StderrMessage = z.infer<typeof stderrMessageSchema>;

export const outputMessageSchema = z.discriminatedUnion("type", [
  stdoutMessageSchema,
  stderrMessageSchema,
]);

export type OutputMessage = StdoutMessage | StderrMessage;

// ============================================================================
// Event Messages (Container → Engine)
// ============================================================================

export const stepStartEventSchema = baseMessageSchema.extend({
  type: z.literal("stepStart"),
  requestId: z.string(),
  stepNumber: z.number(),
});

export type StepStartEvent = z.infer<typeof stepStartEventSchema>;

export const stepEndEventSchema = baseMessageSchema.extend({
  type: z.literal("stepEnd"),
  requestId: z.string(),
  stepNumber: z.number(),
  result: z.string(),
  success: z.boolean(),
});

export type StepEndEvent = z.infer<typeof stepEndEventSchema>;

export const toolStartEventSchema = baseMessageSchema.extend({
  type: z.literal("toolStart"),
  requestId: z.string(),
  toolName: z.string(),
  args: z.record(z.unknown()).default({}),
});

export type ToolStartEvent = z.infer<typeof toolStartEventSchema>;

export const toolEndEventSchema = baseMessageSchema.extend({
  type: z.literal("toolEnd"),
  requestId: z.string(),
  toolName: z.string(),
  result: z.unknown(),
  success: z.boolean(),
  durationMs: z.number().optional(),
});

export type ToolEndEvent = z.infer<typeof toolEndEventSchema>;

export const fileChangeEventSchema = baseMessageSchema.extend({
  type: z.literal("fileChange"),
  requestId: z.string().optional(),
  path: z.string(),
  changeType: z.enum(["create", "modify", "delete"]),
  diff: z.string().optional(),
});

export type FileChangeEvent = z.infer<typeof fileChangeEventSchema>;

export const thinkingEventSchema = baseMessageSchema.extend({
  type: z.literal("thinking"),
  requestId: z.string(),
  thinking: z.string(),
});

export type ThinkingEvent = z.infer<typeof thinkingEventSchema>;

export const messageEventSchema = baseMessageSchema.extend({
  type: z.literal("message"),
  requestId: z.string(),
  role: z.enum(["user", "assistant", "system"]),
  content: z.string(),
});

export type MessageEvent = z.infer<typeof messageEventSchema>;

// Fire-and-forget messaging events (Container → Engine)
export const agentMessageEventSchema = baseMessageSchema.extend({
  type: z.literal("agentMessage"),
  requestId: z.string(),
  to: z.string(),
  message: z.string(),
  priority: z.enum(["normal", "high", "urgent"]).default("normal"),
  messageType: z.enum(["info", "review_request", "help_request", "unblock"]).default("info"),
});

export type AgentMessageEvent = z.infer<typeof agentMessageEventSchema>;

export const slackDmEventSchema = baseMessageSchema.extend({
  type: z.literal("slackDm"),
  requestId: z.string(),
  message: z.string(),
  urgent: z.boolean().default(false),
});

export type SlackDmEvent = z.infer<typeof slackDmEventSchema>;

export const eventMessageSchema = z.discriminatedUnion("type", [
  stepStartEventSchema,
  stepEndEventSchema,
  toolStartEventSchema,
  toolEndEventSchema,
  fileChangeEventSchema,
  thinkingEventSchema,
  messageEventSchema,
  agentMessageEventSchema,
  slackDmEventSchema,
]);

export type EventMessage =
  | StepStartEvent
  | StepEndEvent
  | ToolStartEvent
  | ToolEndEvent
  | FileChangeEvent
  | ThinkingEvent
  | MessageEvent
  | AgentMessageEvent
  | SlackDmEvent;

// ============================================================================
// Status Messages (Container → Engine)
// ============================================================================

export const readyStatusSchema = baseMessageSchema.extend({
  type: z.literal("ready"),
  runId: z.string(),
});

export type ReadyStatus = z.infer<typeof readyStatusSchema>;

export const busyStatusSchema = baseMessageSchema.extend({
  type: z.literal("busy"),
  runId: z.string(),
  requestId: z.string(),
});

export type BusyStatus = z.infer<typeof busyStatusSchema>;

export const idleStatusSchema = baseMessageSchema.extend({
  type: z.literal("idle"),
  runId: z.string(),
});

export type IdleStatus = z.infer<typeof idleStatusSchema>;

export const errorStatusSchema = baseMessageSchema.extend({
  type: z.literal("error"),
  runId: z.string(),
  message: z.string(),
  code: z.string().optional(),
});

export type ErrorStatus = z.infer<typeof errorStatusSchema>;

export const exitingStatusSchema = baseMessageSchema.extend({
  type: z.literal("exiting"),
  runId: z.string(),
  code: z.number().optional(),
});

export type ExitingStatus = z.infer<typeof exitingStatusSchema>;

export const statusMessageSchema = z.discriminatedUnion("type", [
  readyStatusSchema,
  busyStatusSchema,
  idleStatusSchema,
  errorStatusSchema,
  exitingStatusSchema,
]);

export type StatusMessage =
  | ReadyStatus
  | BusyStatus
  | IdleStatus
  | ErrorStatus
  | ExitingStatus;

// ============================================================================
// Union of All Messages
// ============================================================================

export const redisMessageSchema = z.union([
  commandMessageSchema,
  outputMessageSchema,
  eventMessageSchema,
  statusMessageSchema,
]);

export type RedisMessage =
  | CommandMessage
  | OutputMessage
  | EventMessage
  | StatusMessage;

// ============================================================================
// Helpers
// ============================================================================

export function createTimestamp(): number {
  return Date.now();
}

// ============================================================================
// RPC Messages (Container → Engine)
// ============================================================================

export const rpcRequestSchema = baseMessageSchema.extend({
  type: z.literal('rpcRequest'),
  requestId: z.string(),
  method: z.string(), // 'remember', 'recall', 'graph_query', etc.
  params: z.record(z.unknown()),
});

export type RpcRequest = z.infer<typeof rpcRequestSchema>;

export const rpcResponseSchema = baseMessageSchema.extend({
  type: z.literal('rpcResponse'),
  requestId: z.string(),
  success: z.boolean(),
  result: z.unknown().optional(),
  error: z.string().optional(),
});

export type RpcResponse = z.infer<typeof rpcResponseSchema>;

// ============================================================================
// Channel Definitions
// ============================================================================

export const channels = {
  command: (runId: string) => `run:${runId}:cmd`,
  output: (runId: string) => `run:${runId}:out`,
  events: (runId: string) => `run:${runId}:events`,
  status: (runId: string) => `run:${runId}:status`,
  rpcRequest: (runId: string) => `run:${runId}:rpc:request`,
  rpcResponse: (runId: string, requestId: string) => `run:${runId}:rpc:response:${requestId}`,
} as const;

export type ChannelName = keyof typeof channels;