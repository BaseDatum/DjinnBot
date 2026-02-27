/**
 * ChannelRouter — shared multi-agent routing for phone-number-based channels.
 *
 * One phone number serves the entire DjinnBot platform. The router
 * determines which agent should handle each incoming message.
 *
 * Routing order (first match wins):
 *   1. Explicit prefix: message starts with @agentname or /agentname
 *   2. Sticky conversation: sender recently talked to an agent (Redis TTL)
 *   3. Sender default: allowlist entry has a default_agent_id
 *   4. Fallback: system-wide default agent
 *
 * Sticky conversation state is stored in Redis (survives engine restarts).
 *
 * Used by both Signal and WhatsApp integrations.
 */

import { Redis } from 'ioredis';
import type { AgentRegistry } from '../agents/index.js';
import { normalizeE164 } from './phone.js';

// ── Types ────────────────────────────────────────────────────────────────────

export type RouteReason =
  | 'explicit_prefix'
  | 'sticky_conversation'
  | 'sender_default'
  | 'fallback';

export interface RouteResult {
  agentId: string;
  reason: RouteReason;
}

export type CommandAction =
  | { type: 'reset'; agentId?: string }
  | { type: 'model'; model: string; agentId?: string }
  | { type: 'modelfavs' }
  | { type: 'context'; agentId?: string }
  | { type: 'compact'; instructions?: string; agentId?: string }
  | { type: 'status'; agentId?: string };

export interface CommandResult {
  handled: boolean;
  response?: string;
  /** When set, the bridge must perform this action (session reset, model change, etc.). */
  action?: CommandAction;
}

export interface ChannelRouterConfig {
  agentRegistry: AgentRegistry;
  redis: Redis;
  defaultAgentId: string;
  stickyTtlMs: number;
  /** Channel name used for Redis key prefix and agent filtering (e.g. 'signal', 'whatsapp') */
  channelName: string;
}

// ── Router ───────────────────────────────────────────────────────────────────

export class ChannelRouter {
  protected config: ChannelRouterConfig;

  constructor(config: ChannelRouterConfig) {
    this.config = config;
  }

  private get stickyKeyPrefix(): string {
    return `${this.config.channelName}:conv:`;
  }

  // ── Built-in commands ──────────────────────────────────────────────────

  /**
   * Check if the message is a built-in command.
   * Returns { handled: true, response } if it is.
   */
  async handleCommand(sender: string, text: string): Promise<CommandResult> {
    const trimmed = text.trim();
    const lower = trimmed.toLowerCase();

    if (lower === '/help') {
      return {
        handled: true,
        response: [
          'Available commands:',
          '  /agents  — List available agents',
          '  /switch <name> — Switch to a different agent',
          '  /new — Start a fresh conversation (clears history)',
          '  /model <name> — Switch the AI model',
          '  /modelfavs — Show your favorite models',
          '  /context — Show current context window usage',
          '  /compact [instructions] — Compact session context',
          '  /status — Show session status',
          '  /end — End current conversation routing',
          '  /help — Show this help',
          '',
          'You can also start a message with @agentname to route to a specific agent.',
        ].join('\n'),
      };
    }

    if (lower === '/agents') {
      const agents = this.getRoutableAgents();
      if (agents.length === 0) {
        return { handled: true, response: `No agents are available on ${this.config.channelName}.` };
      }
      const lines = agents.map((a) => `  ${a.emoji} ${a.name} (${a.id})`);
      return {
        handled: true,
        response: `Available agents:\n${lines.join('\n')}`,
      };
    }

    if (lower === '/end') {
      await this.clearConversation(sender);
      return { handled: true, response: 'Conversation ended. Your next message will be routed to the default agent.' };
    }

    if (lower.startsWith('/switch ')) {
      const name = trimmed.slice('/switch '.length).trim().toLowerCase();
      const agent = this.findAgentByName(name);
      if (!agent) {
        const available = this.getRoutableAgents().map((a) => a.id).join(', ');
        return {
          handled: true,
          response: `Agent "${name}" not found. Available: ${available}`,
        };
      }
      await this.setActiveConversation(sender, agent.id);
      return {
        handled: true,
        response: `Switched to ${agent.emoji} ${agent.name}. Your messages will now be routed to them.`,
      };
    }

    if (lower === '/new') {
      // Resolve which agent the sender is currently talking to so the bridge
      // can build the deterministic session ID for cleanup.
      const agentId = await this.getActiveConversation(normalizeE164(sender));
      await this.clearConversation(sender);
      return {
        handled: true,
        action: { type: 'reset', agentId: agentId ?? undefined },
      };
    }

    if (lower === '/modelfavs') {
      return {
        handled: true,
        action: { type: 'modelfavs' },
      };
    }

    if (lower.startsWith('/model ') || lower === '/model') {
      const modelArg = trimmed.slice('/model'.length).trim();
      if (!modelArg) {
        return {
          handled: true,
          response: 'Usage: /model <model-name>\nExample: /model anthropic/claude-sonnet-4',
        };
      }
      const agentId = await this.getActiveConversation(normalizeE164(sender));
      return {
        handled: true,
        action: { type: 'model', model: modelArg, agentId: agentId ?? undefined },
      };
    }

    if (lower === '/context') {
      const agentId = await this.getActiveConversation(normalizeE164(sender));
      return {
        handled: true,
        action: { type: 'context', agentId: agentId ?? undefined },
      };
    }

    if (lower === '/compact' || lower.startsWith('/compact ')) {
      const instructions = trimmed.slice('/compact'.length).trim() || undefined;
      const agentId = await this.getActiveConversation(normalizeE164(sender));
      return {
        handled: true,
        action: { type: 'compact', instructions, agentId: agentId ?? undefined },
      };
    }

    if (lower === '/status') {
      const agentId = await this.getActiveConversation(normalizeE164(sender));
      return {
        handled: true,
        action: { type: 'status', agentId: agentId ?? undefined },
      };
    }

    return { handled: false };
  }

  // ── Routing ────────────────────────────────────────────────────────────

  /**
   * Route an incoming message to the correct agent.
   */
  async route(
    sender: string,
    messageText: string,
    senderDefaults: Map<string, string>,
  ): Promise<RouteResult> {
    const normalized = normalizeE164(sender);

    // 1. Explicit prefix: @agentname or /agentname at start of message
    const prefixAgent = this.extractAgentPrefix(messageText);
    if (prefixAgent) {
      await this.setActiveConversation(normalized, prefixAgent);
      return { agentId: prefixAgent, reason: 'explicit_prefix' };
    }

    // 2. Sticky conversation (Redis)
    const sticky = await this.getActiveConversation(normalized);
    if (sticky) {
      // Refresh TTL on continued conversation
      await this.setActiveConversation(normalized, sticky);
      return { agentId: sticky, reason: 'sticky_conversation' };
    }

    // 3. Sender default from allowlist
    const senderDefault = senderDefaults.get(normalized);
    if (senderDefault) {
      await this.setActiveConversation(normalized, senderDefault);
      return { agentId: senderDefault, reason: 'sender_default' };
    }

    // 4. Fallback
    const fallback = this.config.defaultAgentId;
    await this.setActiveConversation(normalized, fallback);
    return { agentId: fallback, reason: 'fallback' };
  }

  // ── Sticky conversation state (Redis) ──────────────────────────────────

  async setActiveConversation(sender: string, agentId: string): Promise<void> {
    const key = `${this.stickyKeyPrefix}${normalizeE164(sender)}`;
    await this.config.redis.set(key, agentId, 'PX', this.config.stickyTtlMs);
  }

  async clearConversation(sender: string): Promise<void> {
    const key = `${this.stickyKeyPrefix}${normalizeE164(sender)}`;
    await this.config.redis.del(key);
  }

  private async getActiveConversation(sender: string): Promise<string | null> {
    const key = `${this.stickyKeyPrefix}${normalizeE164(sender)}`;
    return this.config.redis.get(key);
  }

  // ── Agent lookup helpers ───────────────────────────────────────────────

  /**
   * Extract an agent name from @prefix or /prefix at the start of a message.
   * Returns the agent ID if found, null otherwise.
   */
  private extractAgentPrefix(text: string): string | null {
    const trimmed = text.trim();
    const match = trimmed.match(/^[@/](\w+)\s/);
    if (!match) return null;

    const name = match[1].toLowerCase();
    const agent = this.findAgentByName(name);
    return agent?.id ?? null;
  }

  private findAgentByName(name: string): { id: string; name: string; emoji: string } | null {
    const lower = name.toLowerCase();
    const agents = this.config.agentRegistry.getAll();

    for (const agent of agents) {
      if (agent.id.toLowerCase() === lower) {
        return { id: agent.id, name: agent.identity.name, emoji: agent.identity.emoji };
      }
      if (agent.identity.name.toLowerCase() === lower) {
        return { id: agent.id, name: agent.identity.name, emoji: agent.identity.emoji };
      }
    }
    return null;
  }

  protected getRoutableAgents(): Array<{ id: string; name: string; emoji: string }> {
    const channelAgents = this.config.agentRegistry.getAgentsByChannel(this.config.channelName);
    if (channelAgents.length > 0) {
      return channelAgents.map((a) => ({
        id: a.id,
        name: a.identity.name,
        emoji: a.identity.emoji,
      }));
    }
    // Fallback: all agents
    return this.config.agentRegistry.getAll().map((a) => ({
      id: a.id,
      name: a.identity.name,
      emoji: a.identity.emoji,
    }));
  }
}
