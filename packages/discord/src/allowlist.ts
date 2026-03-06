/**
 * DiscordAllowlist — resolves whether a Discord user is permitted to
 * interact with an agent bot.
 *
 * Supports:
 *   '*'                    — wildcard, allow everyone
 *   '123456789012345678'   — exact Discord user ID
 *   'role:RoleName'        — anyone with a matching guild role
 *
 * The allowlist is stored in the agent's channel credentials (extra_config.allow_from)
 * as a comma-separated string.
 */

import type { GuildMember } from 'discord.js';

export type AllowlistMatchSource = 'wildcard' | 'user_id' | 'role' | 'none';

export interface AllowlistMatch {
  allowed: boolean;
  matchKey?: string;
  matchSource: AllowlistMatchSource;
}

export interface DiscordAllowlistConfig {
  /**
   * Comma-separated allowlist string.
   * Examples: "*", "123456789,987654321", "role:Admin,role:Moderator,123456789"
   */
  allowFrom?: string;
  /**
   * DM policy: 'allowlist' (default) uses the same allowFrom list,
   * 'open' responds to any DM regardless of allowlist.
   */
  dmPolicy?: 'allowlist' | 'open';
}

export class DiscordAllowlist {
  private entries: string[];
  private hasWildcard: boolean;
  private roleEntries: string[];
  private userIdEntries: string[];
  private dmPolicy: 'allowlist' | 'open';

  constructor(config: DiscordAllowlistConfig) {
    const raw = config.allowFrom ?? '';
    this.entries = raw
      .split(',')
      .map((e) => e.trim())
      .filter(Boolean);

    this.hasWildcard = this.entries.includes('*');
    this.roleEntries = this.entries
      .filter((e) => e.startsWith('role:'))
      .map((e) => e.slice(5).toLowerCase());
    this.userIdEntries = this.entries
      .filter((e) => !e.startsWith('role:') && e !== '*');
    this.dmPolicy = config.dmPolicy ?? 'allowlist';
  }

  /** Check if the allowlist is empty (no entries at all → block everything) */
  get isEmpty(): boolean {
    return this.entries.length === 0;
  }

  /**
   * Check if a user is allowed to interact with this agent.
   *
   * @param userId  — The Discord user ID (snowflake string)
   * @param member  — The GuildMember (optional, needed for role-based checks)
   * @param isDM    — Whether this is a DM (applies dmPolicy)
   */
  isAllowed(userId: string, member?: GuildMember | null, isDM = false): AllowlistMatch {
    // Empty allowlist → block everything
    if (this.entries.length === 0) {
      return { allowed: false, matchSource: 'none' };
    }

    // DM with open policy → always allow
    if (isDM && this.dmPolicy === 'open') {
      return { allowed: true, matchKey: 'dm_open', matchSource: 'wildcard' };
    }

    // Wildcard → allow everyone
    if (this.hasWildcard) {
      return { allowed: true, matchKey: '*', matchSource: 'wildcard' };
    }

    // Exact user ID match
    if (this.userIdEntries.includes(userId)) {
      return { allowed: true, matchKey: userId, matchSource: 'user_id' };
    }

    // Role-based match (requires GuildMember)
    if (member && this.roleEntries.length > 0) {
      for (const roleName of this.roleEntries) {
        const hasRole = member.roles.cache.some(
          (r) => r.name.toLowerCase() === roleName,
        );
        if (hasRole) {
          return { allowed: true, matchKey: `role:${roleName}`, matchSource: 'role' };
        }
      }
    }

    return { allowed: false, matchSource: 'none' };
  }

  /** Serialize back to the comma-separated format for storage */
  toString(): string {
    return this.entries.join(',');
  }
}
