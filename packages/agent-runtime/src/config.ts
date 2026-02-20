export interface RuntimeConfig {
  runId: string;
  redisUrl: string;
  workspacePath: string;
  clawvaultPath: string;
  personalVaultPath: string;
  sharedVaultPath: string;
  anthropicApiKey?: string;
}

export function loadConfig(): RuntimeConfig {
  const runId = process.env.RUN_ID;
  if (!runId) throw new Error('RUN_ID environment variable required');

  const clawvaultPath = process.env.CLAWVAULT_PATH || '/home/agent/clawvault';
  
  return {
    runId,
    redisUrl: process.env.REDIS_URL || 'redis://localhost:6379',
    workspacePath: process.env.WORKSPACE_PATH || '/home/agent/run-workspace',
    clawvaultPath,
    // Note: CLAWVAULT_PERSONAL is set by container manager to /home/agent/clawvault/{agentId}
    // The fallback here uses AGENT_ID if available, otherwise 'personal' as generic fallback
    personalVaultPath: process.env.CLAWVAULT_PERSONAL || `${clawvaultPath}/${process.env.AGENT_ID || 'personal'}`,
    sharedVaultPath: process.env.CLAWVAULT_SHARED || `${clawvaultPath}/shared`,
    anthropicApiKey: process.env.ANTHROPIC_API_KEY,
  };
}
