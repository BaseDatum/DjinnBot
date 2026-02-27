/**
 * SignalRouter — routes incoming Signal messages to the correct agent.
 *
 * Now extends the shared ChannelRouter from @djinnbot/core.
 * This thin wrapper exists for backward compatibility and any
 * Signal-specific routing logic in the future.
 */

import { ChannelRouter } from '@djinnbot/core';
import type { Redis } from 'ioredis';
import type { AgentRegistry } from '@djinnbot/core';

export interface SignalRouterConfig {
  agentRegistry: AgentRegistry;
  redis: Redis;
  defaultAgentId: string;
  stickyTtlMs: number;
}

/** Built-in commands handled before routing. */
export interface CommandResult {
  handled: boolean;
  response?: string;
}

export class SignalRouter extends ChannelRouter {
  constructor(config: SignalRouterConfig) {
    super({
      ...config,
      channelName: 'signal',
    });
  }
}
