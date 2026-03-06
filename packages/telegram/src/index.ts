/**
 * @djinnbot/telegram — Telegram channel integration for DjinnBot.
 *
 * One bot per agent. Each agent with Telegram enabled gets its own
 * BotFather bot token. Messages to a bot go directly to that agent —
 * no routing needed.
 */

export { TelegramBridgeManager, type TelegramBridgeFullConfig } from './telegram-bridge.js';
export { TelegramClient, type TelegramClientConfig } from './telegram-client.js';
export { TelegramTypingManager } from './telegram-typing-manager.js';
export {
  parseAllowlistEntry,
  isSenderAllowed,
  resolveAllowlist,
} from './allowlist.js';
export { markdownToTelegramHtml, chunkTelegramMessage } from './telegram-format.js';
export * from './types.js';
