/**
 * Re-export createMcpTools from the shared @djinnbot/core package.
 * The implementation lives in core so it can be used by both the
 * in-process PiMonoRunner and the containerised agent-runtime.
 */
export { createMcpTools } from '@djinnbot/core';
