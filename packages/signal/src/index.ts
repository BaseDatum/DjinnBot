/**
 * @djinnbot/signal — Signal channel integration for DjinnBot.
 *
 * One phone number shared across the platform. Messages are routed
 * to agents via configurable routing (prefix, sticky, per-sender default,
 * fallback). signal-cli runs as a native binary child process with
 * data persisted on JuiceFS.
 */

export { SignalBridge, type SignalBridgeFullConfig } from './signal-bridge.js';
export { SignalClient, type SignalClientConfig } from './signal-client.js';
export {
  spawnSignalDaemon,
  acquireSignalDaemonLock,
  waitForDaemonReady,
  type SignalDaemonConfig,
  type SignalDaemonHandle,
  type SignalDaemonExitEvent,
} from './signal-daemon.js';
export { SignalRouter, type SignalRouterConfig } from './signal-router.js';
export { SignalTypingManager } from './signal-typing-manager.js';
export {
  normalizeE164,
  parseAllowlistEntry,
  isSenderAllowed,
  resolveAllowlist,
} from './allowlist.js';
export { markdownToSignalText } from './signal-format.js';
export * from './types.js';
