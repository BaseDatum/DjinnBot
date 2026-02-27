/**
 * signal-format — convert markdown to Signal text style ranges.
 *
 * Signal doesn't support markdown natively. Instead it uses positional
 * style ranges: { start, length, style }. This module converts common
 * markdown patterns into Signal's format, stripping the markdown
 * delimiters from the output text.
 *
 * Supported conversions:
 *   **bold**      → BOLD
 *   *italic*      → ITALIC (single asterisk not preceded by another)
 *   _italic_      → ITALIC
 *   `code`        → MONOSPACE
 *   ~~strike~~    → STRIKETHROUGH
 *   ||spoiler||   → SPOILER
 */

import type { TextStyleRange } from './types.js';

interface PatternDef {
  regex: RegExp;
  style: TextStyleRange['style'];
  delimLength: number;
}

const PATTERNS: PatternDef[] = [
  // Bold: **text** (must come before italic single *)
  { regex: /\*\*(.+?)\*\*/g, style: 'BOLD', delimLength: 2 },
  // Strikethrough: ~~text~~
  { regex: /~~(.+?)~~/g, style: 'STRIKETHROUGH', delimLength: 2 },
  // Spoiler: ||text||
  { regex: /\|\|(.+?)\|\|/g, style: 'SPOILER', delimLength: 2 },
  // Monospace (inline code): `text`
  { regex: /`([^`]+)`/g, style: 'MONOSPACE', delimLength: 1 },
  // Italic: _text_ (not preceded/followed by alphanumeric)
  { regex: /(?<![a-zA-Z0-9])_(.+?)_(?![a-zA-Z0-9])/g, style: 'ITALIC', delimLength: 1 },
  // Italic: *text* (single, not double)
  { regex: /(?<!\*)\*(?!\*)(.+?)(?<!\*)\*(?!\*)/g, style: 'ITALIC', delimLength: 1 },
];

export function markdownToSignalText(md: string): {
  text: string;
  styles: TextStyleRange[];
} {
  const styles: TextStyleRange[] = [];
  let result = md;

  // Process each pattern. Since we modify the string as we go,
  // we need to track offset shifts from delimiter removal.
  for (const pattern of PATTERNS) {
    const newStyles: TextStyleRange[] = [];
    let offset = 0;

    result = result.replace(pattern.regex, (match, inner, index) => {
      const adjustedStart = index - offset;
      newStyles.push({
        start: adjustedStart,
        length: inner.length,
        style: pattern.style,
      });
      // We're removing 2 * delimLength characters (opening + closing delimiters)
      offset += pattern.delimLength * 2;
      return inner;
    });

    styles.push(...newStyles);
  }

  // Handle code blocks: ```\ncontent\n``` → MONOSPACE
  const codeBlockRegex = /```(?:\w*\n)?([\s\S]*?)```/g;
  let codeOffset = 0;
  result = result.replace(codeBlockRegex, (match, inner, index) => {
    const adjustedStart = index - codeOffset;
    const trimmed = inner.trim();
    styles.push({
      start: adjustedStart,
      length: trimmed.length,
      style: 'MONOSPACE',
    });
    codeOffset += match.length - trimmed.length;
    return trimmed;
  });

  return { text: result, styles };
}
