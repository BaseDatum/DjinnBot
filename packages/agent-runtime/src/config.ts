export interface RuntimeConfig {
  runId: string;
  redisUrl: string;
  workspacePath: string;
  clawvaultPath: string;
  apiBaseUrl: string;
  anthropicApiKey?: string;
}

export function loadConfig(): RuntimeConfig {
  const runId = process.env.RUN_ID;
  if (!runId) throw new Error('RUN_ID environment variable required');

  // With JuiceFS direct mounts, the personal vault path is a real FUSE mount
  // point — no symlinks to resolve.  glob v10 works correctly.
  // The shared vault is accessed via the DjinnBot API, not mounted locally.
  const clawvaultPath = process.env.CLAWVAULT_PATH || '/home/agent/clawvault';

  return {
    runId,
    redisUrl: process.env.REDIS_URL || 'redis://localhost:6379',
    workspacePath: process.env.WORKSPACE_PATH || '/home/agent/run-workspace',
    clawvaultPath,
    apiBaseUrl: process.env.DJINNBOT_API_URL || 'http://api:8000',
    anthropicApiKey: process.env.ANTHROPIC_API_KEY,
  };
}
