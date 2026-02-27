/**
 * telegram-format — convert markdown to Telegram HTML.
 *
 * Telegram's Bot API supports a subset of HTML:
 *   <b>bold</b>, <i>italic</i>, <code>inline</code>,
 *   <pre>block</pre>, <s>strike</s>, <tg-spoiler>spoiler</tg-spoiler>,
 *   <a href="url">text</a>, <blockquote>quote</blockquote>
 *
 * Special characters (<, >, &) must be escaped.
 * Telegram message limit is 4096 characters per message.
 */

const TELEGRAM_MESSAGE_LIMIT = 4096;

// -- HTML escaping ------------------------------------------------------------

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

// -- Markdown to Telegram HTML ------------------------------------------------

/**
 * Convert common markdown patterns to Telegram HTML.
 * Processes in a specific order to handle nesting correctly.
 */
export function markdownToTelegramHtml(md: string): string {
  let result = md;

  // 1. Escape HTML entities in the raw text FIRST, but we need to be careful
  //    not to escape the HTML tags we're about to insert. So we do the
  //    conversion in a two-pass approach:
  //    Pass 1: Extract code blocks and inline code (they need escaping but no formatting)
  //    Pass 2: Convert markdown to HTML in the remaining text

  // Extract fenced code blocks first (```lang\ncode\n```)
  const codeBlocks: string[] = [];
  result = result.replace(/```(\w*)\n([\s\S]*?)```/g, (_match, lang, code) => {
    const escaped = escapeHtml(code.trimEnd());
    const langAttr = lang ? ` class="language-${escapeHtml(lang)}"` : '';
    const placeholder = `\x00CODEBLOCK${codeBlocks.length}\x00`;
    codeBlocks.push(`<pre><code${langAttr}>${escaped}</code></pre>`);
    return placeholder;
  });

  // Also handle ``` without language
  result = result.replace(/```([\s\S]*?)```/g, (_match, code) => {
    const escaped = escapeHtml(code.trim());
    const placeholder = `\x00CODEBLOCK${codeBlocks.length}\x00`;
    codeBlocks.push(`<pre>${escaped}</pre>`);
    return placeholder;
  });

  // Extract inline code (`code`)
  const inlineCodes: string[] = [];
  result = result.replace(/`([^`\n]+)`/g, (_match, code) => {
    const escaped = escapeHtml(code);
    const placeholder = `\x00INLINE${inlineCodes.length}\x00`;
    inlineCodes.push(`<code>${escaped}</code>`);
    return placeholder;
  });

  // Now escape the remaining text
  result = escapeHtml(result);

  // Bold: **text**
  result = result.replace(/\*\*(.+?)\*\*/g, '<b>$1</b>');

  // Strikethrough: ~~text~~
  result = result.replace(/~~(.+?)~~/g, '<s>$1</s>');

  // Italic: _text_ (not preceded/followed by alphanumeric)
  result = result.replace(/(?<![a-zA-Z0-9])_(.+?)_(?![a-zA-Z0-9])/g, '<i>$1</i>');

  // Italic: *text* (single, not double)
  result = result.replace(/(?<!\*)\*(?!\*)(.+?)(?<!\*)\*(?!\*)/g, '<i>$1</i>');

  // Links: [text](url)
  result = result.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2">$1</a>');

  // Blockquotes: > text (at line start)
  result = result.replace(/^&gt;\s?(.+)$/gm, '<blockquote>$1</blockquote>');
  // Merge consecutive blockquotes
  result = result.replace(/<\/blockquote>\n<blockquote>/g, '\n');

  // Restore code blocks and inline code
  for (let i = 0; i < codeBlocks.length; i++) {
    result = result.replace(`\x00CODEBLOCK${i}\x00`, codeBlocks[i]);
  }
  for (let i = 0; i < inlineCodes.length; i++) {
    result = result.replace(`\x00INLINE${i}\x00`, inlineCodes[i]);
  }

  return result.trim();
}

// -- Message chunking ---------------------------------------------------------

/**
 * Split a long message into chunks that fit within Telegram's 4096-char limit.
 * Splits at paragraph boundaries (double newline) when possible, falling back
 * to single newlines, then hard-cutting at the limit.
 */
export function chunkTelegramMessage(text: string, limit = TELEGRAM_MESSAGE_LIMIT): string[] {
  if (text.length <= limit) {
    return [text];
  }

  const chunks: string[] = [];
  let remaining = text;

  while (remaining.length > 0) {
    if (remaining.length <= limit) {
      chunks.push(remaining);
      break;
    }

    // Try to split at double newline (paragraph boundary)
    let splitIdx = remaining.lastIndexOf('\n\n', limit);
    if (splitIdx > limit * 0.3) {
      chunks.push(remaining.slice(0, splitIdx).trimEnd());
      remaining = remaining.slice(splitIdx + 2).trimStart();
      continue;
    }

    // Try to split at single newline
    splitIdx = remaining.lastIndexOf('\n', limit);
    if (splitIdx > limit * 0.3) {
      chunks.push(remaining.slice(0, splitIdx).trimEnd());
      remaining = remaining.slice(splitIdx + 1).trimStart();
      continue;
    }

    // Try to split at space
    splitIdx = remaining.lastIndexOf(' ', limit);
    if (splitIdx > limit * 0.3) {
      chunks.push(remaining.slice(0, splitIdx).trimEnd());
      remaining = remaining.slice(splitIdx + 1).trimStart();
      continue;
    }

    // Hard cut at limit
    chunks.push(remaining.slice(0, limit));
    remaining = remaining.slice(limit);
  }

  return chunks;
}
