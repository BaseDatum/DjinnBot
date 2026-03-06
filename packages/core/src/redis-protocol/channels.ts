export const channels = {
  command: (runId: string) => `run:${runId}:cmd`,
  output: (runId: string) => `run:${runId}:out`,
  events: (runId: string) => `run:${runId}:events`,
  status: (runId: string) => `run:${runId}:status`,
  rpcRequest: (runId: string) => `run:${runId}:rpc:request`,
  rpcResponse: (runId: string, requestId: string) => `run:${runId}:rpc:response:${requestId}`,
} as const;

export type ChannelName = keyof typeof channels;
