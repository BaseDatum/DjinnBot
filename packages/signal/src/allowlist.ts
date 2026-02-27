/**
 * Allowlist matching for Signal phone numbers.
 *
 * Supports three entry types:
 *   - '*'           → accept all senders
 *   - '+1555*'      → prefix wildcard (all numbers starting with +1555)
 *   - '+15551234567' → exact E.164 match
 */

import type { AllowlistEntryKind, AllowlistDbEntry } from './types.js';

// ── E.164 normalization ──────────────────────────────────────────────────────

/**
 * Normalize a phone number to E.164 format.
 * Strips spaces, dashes, parens. Ensures leading +.
 */
export function normalizeE164(raw: string): string {
  let cleaned = raw.replace(/[\s\-().]/g, '').trim();
  if (!cleaned) return '';
  if (!cleaned.startsWith('+')) {
    cleaned = `+${cleaned}`;
  }
  return cleaned;
}

// ── Parse allowlist entries ──────────────────────────────────────────────────

export function parseAllowlistEntry(raw: string): AllowlistEntryKind | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;

  if (trimmed === '*') {
    return { kind: 'any' };
  }

  // Prefix wildcard: "+1555*"
  if (trimmed.endsWith('*') && trimmed.length > 1) {
    const prefix = normalizeE164(trimmed.slice(0, -1));
    if (!prefix) return null;
    return { kind: 'prefix', prefix };
  }

  // Exact phone number
  const e164 = normalizeE164(trimmed);
  if (!e164) return null;
  return { kind: 'phone', e164 };
}

// ── Check if a sender is allowed ─────────────────────────────────────────────

export function isSenderAllowed(
  senderPhone: string,
  entries: AllowlistEntryKind[],
  allowAll: boolean,
): boolean {
  if (allowAll) return true;
  if (entries.length === 0) return false;

  const normalized = normalizeE164(senderPhone);
  if (!normalized) return false;

  for (const entry of entries) {
    if (entry.kind === 'any') return true;
    if (entry.kind === 'phone' && entry.e164 === normalized) return true;
    if (entry.kind === 'prefix' && normalized.startsWith(entry.prefix)) return true;
  }

  return false;
}

/**
 * Parse a list of DB allowlist entries into typed entries + find the
 * sender's default agent if one is configured.
 */
export function resolveAllowlist(dbEntries: AllowlistDbEntry[]): {
  entries: AllowlistEntryKind[];
  senderDefaults: Map<string, string>;
} {
  const entries: AllowlistEntryKind[] = [];
  const senderDefaults = new Map<string, string>();

  for (const row of dbEntries) {
    const parsed = parseAllowlistEntry(row.phoneNumber);
    if (parsed) entries.push(parsed);

    if (row.defaultAgentId && parsed?.kind === 'phone') {
      senderDefaults.set(parsed.e164, row.defaultAgentId);
    }
  }

  return { entries, senderDefaults };
}
