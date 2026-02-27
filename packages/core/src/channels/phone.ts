/**
 * Phone number utilities shared across messaging channels (Signal, WhatsApp, etc).
 *
 * E.164 normalization and validation.
 */

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
