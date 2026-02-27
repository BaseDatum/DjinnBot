/**
 * Shared channel infrastructure for phone-number-based messaging integrations.
 *
 * Provides common building blocks used by Signal, WhatsApp, and future
 * phone-number-based channel integrations.
 */

export { normalizeE164 } from './phone.js';
export {
  parseAllowlistEntry,
  isSenderAllowed,
  resolveAllowlist,
  type AllowlistEntryKind,
  type AllowlistDbEntry,
} from './allowlist.js';
export {
  ChannelRouter,
  type ChannelRouterConfig,
  type RouteResult,
  type RouteReason,
  type CommandResult,
} from './channel-router.js';
export {
  ChannelTypingManager,
  type ChannelTypingConfig,
} from './channel-typing.js';
