import { realpathSync, existsSync } from 'node:fs';

export interface RuntimeConfig {
  runId: string;
  redisUrl: string;
  workspacePath: string;
  clawvaultPath: string;
  personalVaultPath: string;
  sharedVaultPath: string;
  anthropicApiKey?: string;
}

/**
 * Resolve symlinks in a path if the target exists.
 *
 * Vault paths are typically symlinks (e.g. /home/agent/clawvault/shared →
 * /djinnbot-data/vaults/shared).  glob v10 does NOT follow symlinks when
 * expanding `**`, so clawvault's graph builder silently finds zero files
 * when given a symlinked cwd.  Resolving here ensures every downstream
 * consumer (graph builder, ClawVault, etc.) works with the real path.
 */
function resolveSymlinks(p: string): string {
  try {
    if (existsSync(p)) return realpathSync(p);
  } catch { /* fall through */ }
  return p;
}

export function loadConfig(): RuntimeConfig {
  const runId = process.env.RUN_ID;
  if (!runId) throw new Error('RUN_ID environment variable required');

  const clawvaultPath = process.env.CLAWVAULT_PATH || '/home/agent/clawvault';
  
  const personalVaultPath = resolveSymlinks(
    process.env.CLAWVAULT_PERSONAL || `${clawvaultPath}/${process.env.AGENT_ID || 'personal'}`,
  );
  const sharedVaultPath = resolveSymlinks(
    process.env.CLAWVAULT_SHARED || `${clawvaultPath}/shared`,
  );

  return {
    runId,
    redisUrl: process.env.REDIS_URL || 'redis://localhost:6379',
    workspacePath: process.env.WORKSPACE_PATH || '/home/agent/run-workspace',
    clawvaultPath,
    personalVaultPath,
    sharedVaultPath,
    anthropicApiKey: process.env.ANTHROPIC_API_KEY,
  };
}
