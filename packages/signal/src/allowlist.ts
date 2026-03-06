/**
 * Re-export shared allowlist utilities from @djinnbot/core.
 * Signal-specific code imports from here for backward compatibility.
 */

export {
  normalizeE164,
  parseAllowlistEntry,
  isSenderAllowed,
  resolveAllowlist,
  type AllowlistEntryKind,
  type AllowlistDbEntry,
} from '@djinnbot/core';
