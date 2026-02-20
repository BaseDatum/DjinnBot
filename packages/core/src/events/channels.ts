export function pipelineChannel(pipelineId: string): string {
  return `djinnbot:events:pipeline:${pipelineId}`;
}

export function runChannel(runId: string): string {
  return `djinnbot:events:run:${runId}`;
}

export function stepChannel(runId: string, stepId: string): string {
  return `djinnbot:events:step:${runId}:${stepId}`;
}

export function commsChannel(runId: string): string {
  return `djinnbot:events:comms:${runId}`;
}

export const GLOBAL_CHANNEL = 'djinnbot:events:global';
