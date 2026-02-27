/**
 * whatsapp-format — convert standard markdown to WhatsApp text formatting.
 *
 * WhatsApp uses inline delimiters for formatting:
 *   **bold**     → *bold*
 *   *italic*     → _italic_
 *   _italic_     → _italic_
 *   ~~strike~~   → ~strike~
 *   `code`       → `code`
 *   ```block```  → ```block```
 *
 * Also handles chunking long messages (WhatsApp has a ~4000 char practical limit).
 */

/**
 * Convert markdown to WhatsApp-flavored formatting.
 * Returns the formatted text string.
 */
export function markdownToWhatsApp(md: string): string {
  let result = md;

  // Bold: **text** → *text* (must come before italic)
  result = result.replace(/\*\*(.+?)\*\*/g, '*$1*');

  // Strikethrough: ~~text~~ → ~text~
  result = result.replace(/~~(.+?)~~/g, '~$1~');

  // Italic: *text* (single, not double — already converted bold above)
  // Only match if not preceded/followed by * (to avoid double-conversion)
  result = result.replace(/(?<!\*)\*(?!\*)(.+?)(?<!\*)\*(?!\*)/g, '_$1_');

  // Code blocks and inline code are the same syntax, no conversion needed.

  return result;
}

/**
 * Chunk a long message into WhatsApp-friendly segments.
 *
 * @param text The full text to chunk
 * @param maxLength Maximum length per chunk (default 4000)
 * @param mode 'newline' prefers paragraph boundaries, 'length' is hard cut
 */
export function chunkMessage(
  text: string,
  maxLength = 4000,
  mode: 'newline' | 'length' = 'newline',
): string[] {
  if (text.length <= maxLength) {
    return [text];
  }

  const chunks: string[] = [];
  let remaining = text;

  while (remaining.length > 0) {
    if (remaining.length <= maxLength) {
      chunks.push(remaining);
      break;
    }

    let splitIdx = maxLength;

    if (mode === 'newline') {
      // Try to find a paragraph boundary (double newline)
      const paragraphIdx = remaining.lastIndexOf('\n\n', maxLength);
      if (paragraphIdx > maxLength * 0.5) {
        splitIdx = paragraphIdx + 2;
      } else {
        // Fallback: single newline
        const newlineIdx = remaining.lastIndexOf('\n', maxLength);
        if (newlineIdx > maxLength * 0.5) {
          splitIdx = newlineIdx + 1;
        }
      }
    }

    chunks.push(remaining.slice(0, splitIdx));
    remaining = remaining.slice(splitIdx);
  }

  return chunks;
}
