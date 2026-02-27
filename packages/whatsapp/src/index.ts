/**
 * @djinnbot/whatsapp — WhatsApp channel integration for DjinnBot.
 *
 * One phone number shared across the platform. Messages are routed
 * to agents via configurable routing (prefix, sticky, per-sender default,
 * fallback). Baileys (WhatsApp Web multi-device protocol) runs in-process.
 */

export { WhatsAppBridge, type WhatsAppBridgeFullConfig } from './whatsapp-bridge.js';
export { WhatsAppSocket, type WhatsAppSocketConfig, type WhatsAppSocketEvents } from './whatsapp-socket.js';
export { markdownToWhatsApp, chunkMessage } from './whatsapp-format.js';
export * from './types.js';
