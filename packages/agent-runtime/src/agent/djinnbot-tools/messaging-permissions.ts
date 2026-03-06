/**
 * Shared messaging permission types and enforcement for channel tools
 * (Telegram, WhatsApp, Signal).
 *
 * Permissions are per-agent, per-channel with fine-grained or wildcard control:
 *   - `*` wildcard = agent can send to any chat/phone on that channel
 *   - Specific identifiers = agent can only send to listed chats/phones
 *
 * Permissions are fetched from the API at tool creation time and cached
 * for the lifetime of the session. The runtime re-fetches on Redis broadcast.
 */

import { authFetch } from '../../api/auth-fetch.js';

// ── Types ──────────────────────────────────────────────────────────────────

export type MessagingChannel = 'telegram' | 'whatsapp' | 'signal';

export interface MessagingPermission {
  id: number;
  agentId: string;
  channel: MessagingChannel;
  /** `*` for wildcard (any target) or a specific chat ID / phone number / group ID */
  target: string;
  /** Human-friendly label (e.g. "Ops channel", "Alice's phone") */
  label: string | null;
  createdAt: number;
  updatedAt: number;
}

export interface MessagingPermissionsConfig {
  agentId: string;
  apiBaseUrl?: string;
}

// ── Permission cache ───────────────────────────────────────────────────────

/** In-memory cache of permissions per channel, populated lazily. */
const permissionCache = new Map<string, MessagingPermission[]>();

function cacheKey(agentId: string, channel: MessagingChannel): string {
  return `${agentId}:${channel}`;
}

/** Fetch permissions for a specific agent + channel. Cached per session. */
export async function getMessagingPermissions(
  agentId: string,
  channel: MessagingChannel,
  apiBaseUrl?: string,
): Promise<MessagingPermission[]> {
  const key = cacheKey(agentId, channel);
  const cached = permissionCache.get(key);
  if (cached) return cached;

  const apiBase = apiBaseUrl || process.env.DJINNBOT_API_URL || 'http://api:8000';
  try {
    const res = await authFetch(
      `${apiBase}/v1/agents/${encodeURIComponent(agentId)}/messaging-permissions?channel=${channel}`,
    );
    if (!res.ok) {
      // No permissions configured = empty list
      const perms: MessagingPermission[] = [];
      permissionCache.set(key, perms);
      return perms;
    }
    const data = (await res.json()) as { permissions: MessagingPermission[] };
    permissionCache.set(key, data.permissions);
    return data.permissions;
  } catch {
    return [];
  }
}

/** Clear the cache (called on Redis broadcast). */
export function invalidatePermissionCache(agentId?: string, channel?: MessagingChannel): void {
  if (agentId && channel) {
    permissionCache.delete(cacheKey(agentId, channel));
  } else if (agentId) {
    for (const k of permissionCache.keys()) {
      if (k.startsWith(`${agentId}:`)) permissionCache.delete(k);
    }
  } else {
    permissionCache.clear();
  }
}

// ── Permission enforcement ─────────────────────────────────────────────────

/**
 * Check if an agent is allowed to send to a specific target on a channel.
 *
 * Rules:
 *   1. If no permissions exist for this agent+channel → DENY (no config = no access)
 *   2. If any permission has target `*` → ALLOW (wildcard)
 *   3. If any permission target matches the requested target → ALLOW
 *   4. Otherwise → DENY
 */
export function isTargetAllowed(
  permissions: MessagingPermission[],
  target: string,
): boolean {
  if (permissions.length === 0) return false;
  return permissions.some(
    (p) => p.target === '*' || p.target === target,
  );
}

/**
 * High-level check: fetch permissions and validate target.
 * Returns { allowed: true } or { allowed: false, reason: string }.
 */
export async function checkMessagingPermission(
  agentId: string,
  channel: MessagingChannel,
  target: string,
  apiBaseUrl?: string,
): Promise<{ allowed: true } | { allowed: false; reason: string }> {
  const perms = await getMessagingPermissions(agentId, channel, apiBaseUrl);

  if (perms.length === 0) {
    return {
      allowed: false,
      reason:
        `No ${channel} messaging permissions configured for this agent. ` +
        `Ask an admin to add allowed targets in the agent's Tools tab.`,
    };
  }

  if (!isTargetAllowed(perms, target)) {
    const allowedTargets = perms
      .map((p) => (p.label ? `${p.target} (${p.label})` : p.target))
      .join(', ');
    return {
      allowed: false,
      reason:
        `Target "${target}" is not in this agent's allowed ${channel} targets. ` +
        `Allowed: ${allowedTargets}`,
    };
  }

  return { allowed: true };
}
