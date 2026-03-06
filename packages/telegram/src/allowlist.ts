/**
 * Allowlist matching for Telegram users.
 *
 * Supports four entry types:
 *   - '*'            -> accept all senders
 *   - '12345678'     -> exact Telegram user ID
 *   - '@username'    -> exact username match (case-insensitive)
 *   - '@prefix*'     -> username prefix wildcard (case-insensitive)
 */

import type { AllowlistEntryKind, TelegramAllowlistDbEntry } from './types.js';

// -- Parse allowlist entries --------------------------------------------------

export function parseAllowlistEntry(raw: string): AllowlistEntryKind | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;

  // Wildcard: accept all
  if (trimmed === '*') {
    return { kind: 'any' };
  }

  // Username prefix wildcard: @dev*
  if (trimmed.startsWith('@') && trimmed.endsWith('*') && trimmed.length > 2) {
    const prefix = trimmed.slice(1, -1).toLowerCase();
    if (!prefix) return null;
    return { kind: 'prefix', prefix };
  }

  // Exact username: @johndoe
  if (trimmed.startsWith('@') && trimmed.length > 1) {
    const username = trimmed.slice(1).toLowerCase();
    if (!username) return null;
    return { kind: 'username', username };
  }

  // Numeric user ID
  const parsed = Number.parseInt(trimmed, 10);
  if (Number.isFinite(parsed) && parsed > 0 && String(parsed) === trimmed) {
    return { kind: 'user_id', userId: parsed };
  }

  return null;
}

// -- Check if a sender is allowed ---------------------------------------------

export function isSenderAllowed(
  userId: number,
  username: string | undefined,
  entries: AllowlistEntryKind[],
  allowAll: boolean,
): boolean {
  if (allowAll) return true;
  if (entries.length === 0) return false;

  const normalizedUsername = username?.toLowerCase();

  for (const entry of entries) {
    if (entry.kind === 'any') return true;

    if (entry.kind === 'user_id' && entry.userId === userId) return true;

    if (entry.kind === 'username' && normalizedUsername && entry.username === normalizedUsername) {
      return true;
    }

    if (entry.kind === 'prefix' && normalizedUsername && normalizedUsername.startsWith(entry.prefix)) {
      return true;
    }
  }

  return false;
}

/**
 * Parse a list of DB allowlist entries into typed entries.
 */
export function resolveAllowlist(dbEntries: TelegramAllowlistDbEntry[]): AllowlistEntryKind[] {
  const entries: AllowlistEntryKind[] = [];

  for (const row of dbEntries) {
    const parsed = parseAllowlistEntry(row.identifier);
    if (parsed) entries.push(parsed);
  }

  return entries;
}
