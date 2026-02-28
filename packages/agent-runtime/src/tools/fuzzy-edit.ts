/**
 * Fuzzy Edit — Cascading replacement strategies for resilient code editing.
 *
 * LLMs frequently produce oldText with minor whitespace, indentation, or
 * encoding mismatches. Instead of failing on the first attempt, this module
 * tries progressively fuzzier matching strategies until one succeeds.
 *
 * Strategy cascade (in order):
 *   1. Exact match (identity)
 *   2. Line-trimmed match (ignore leading/trailing whitespace per line)
 *   3. Block anchor match (first+last line anchors with Levenshtein similarity)
 *   4. Indentation-flexible match (normalize common indentation)
 *   5. Whitespace-normalized match (collapse all whitespace)
 *
 * Adapted from OpenCode's edit tool approach (cline/gemini-cli lineage).
 */

// ── Types ─────────────────────────────────────────────────────────────────

export type Replacer = (content: string, find: string) => Generator<string, void, unknown>;

export interface FuzzyReplaceResult {
  /** The new content after replacement */
  newContent: string;
  /** Which strategy succeeded */
  strategy: string;
  /** Whether fuzzy matching was used (false = exact match) */
  usedFuzzy: boolean;
}

// ── Levenshtein distance ──────────────────────────────────────────────────

function levenshtein(a: string, b: string): number {
  if (a === '' || b === '') return Math.max(a.length, b.length);
  
  const matrix = Array.from({ length: a.length + 1 }, (_, i) =>
    Array.from({ length: b.length + 1 }, (_, j) => (i === 0 ? j : j === 0 ? i : 0)),
  );

  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      matrix[i][j] = Math.min(
        matrix[i - 1][j] + 1,
        matrix[i][j - 1] + 1,
        matrix[i - 1][j - 1] + cost,
      );
    }
  }
  return matrix[a.length][b.length];
}

// ── Strategy 1: Exact match ──────────────────────────────────────────────

export const SimpleReplacer: Replacer = function* (_content, find) {
  yield find;
};

// ── Strategy 2: Line-trimmed match ───────────────────────────────────────
// Match ignoring leading/trailing whitespace on each line.

export const LineTrimmedReplacer: Replacer = function* (content, find) {
  const originalLines = content.split('\n');
  const searchLines = find.split('\n');

  if (searchLines[searchLines.length - 1] === '') {
    searchLines.pop();
  }

  for (let i = 0; i <= originalLines.length - searchLines.length; i++) {
    let matches = true;
    for (let j = 0; j < searchLines.length; j++) {
      if (originalLines[i + j].trim() !== searchLines[j].trim()) {
        matches = false;
        break;
      }
    }

    if (matches) {
      let matchStartIndex = 0;
      for (let k = 0; k < i; k++) {
        matchStartIndex += originalLines[k].length + 1;
      }
      let matchEndIndex = matchStartIndex;
      for (let k = 0; k < searchLines.length; k++) {
        matchEndIndex += originalLines[i + k].length;
        if (k < searchLines.length - 1) matchEndIndex += 1;
      }
      yield content.substring(matchStartIndex, matchEndIndex);
    }
  }
};

// ── Strategy 3: Block anchor match ───────────────────────────────────────
// Match by first+last line with Levenshtein similarity on middle lines.

const SINGLE_CANDIDATE_THRESHOLD = 0.0;
const MULTIPLE_CANDIDATES_THRESHOLD = 0.3;

export const BlockAnchorReplacer: Replacer = function* (content, find) {
  const originalLines = content.split('\n');
  const searchLines = find.split('\n');

  if (searchLines.length < 3) return;
  if (searchLines[searchLines.length - 1] === '') searchLines.pop();

  const firstLineSearch = searchLines[0].trim();
  const lastLineSearch = searchLines[searchLines.length - 1].trim();
  const searchBlockSize = searchLines.length;

  const candidates: Array<{ startLine: number; endLine: number }> = [];
  for (let i = 0; i < originalLines.length; i++) {
    if (originalLines[i].trim() !== firstLineSearch) continue;
    for (let j = i + 2; j < originalLines.length; j++) {
      if (originalLines[j].trim() === lastLineSearch) {
        candidates.push({ startLine: i, endLine: j });
        break;
      }
    }
  }

  if (candidates.length === 0) return;

  const computeSimilarity = (startLine: number, endLine: number): number => {
    const actualBlockSize = endLine - startLine + 1;
    const linesToCheck = Math.min(searchBlockSize - 2, actualBlockSize - 2);
    if (linesToCheck <= 0) return 1.0;

    let similarity = 0;
    for (let j = 1; j < searchBlockSize - 1 && j < actualBlockSize - 1; j++) {
      const orig = originalLines[startLine + j].trim();
      const search = searchLines[j].trim();
      const maxLen = Math.max(orig.length, search.length);
      if (maxLen === 0) continue;
      similarity += (1 - levenshtein(orig, search) / maxLen) / linesToCheck;
    }
    return similarity;
  };

  const extractBlock = (startLine: number, endLine: number): string => {
    let matchStartIndex = 0;
    for (let k = 0; k < startLine; k++) matchStartIndex += originalLines[k].length + 1;
    let matchEndIndex = matchStartIndex;
    for (let k = startLine; k <= endLine; k++) {
      matchEndIndex += originalLines[k].length;
      if (k < endLine) matchEndIndex += 1;
    }
    return content.substring(matchStartIndex, matchEndIndex);
  };

  if (candidates.length === 1) {
    const { startLine, endLine } = candidates[0];
    if (computeSimilarity(startLine, endLine) >= SINGLE_CANDIDATE_THRESHOLD) {
      yield extractBlock(startLine, endLine);
    }
    return;
  }

  // Multiple candidates — pick best match
  let bestMatch: { startLine: number; endLine: number } | null = null;
  let maxSimilarity = -1;
  for (const c of candidates) {
    const sim = computeSimilarity(c.startLine, c.endLine);
    if (sim > maxSimilarity) {
      maxSimilarity = sim;
      bestMatch = c;
    }
  }

  if (maxSimilarity >= MULTIPLE_CANDIDATES_THRESHOLD && bestMatch) {
    yield extractBlock(bestMatch.startLine, bestMatch.endLine);
  }
};

// ── Strategy 4: Indentation-flexible match ───────────────────────────────
// Strip common indentation before comparing.

export const IndentationFlexibleReplacer: Replacer = function* (content, find) {
  const removeIndentation = (text: string): string => {
    const lines = text.split('\n');
    const nonEmpty = lines.filter(l => l.trim().length > 0);
    if (nonEmpty.length === 0) return text;

    const minIndent = Math.min(
      ...nonEmpty.map(l => {
        const match = l.match(/^(\s*)/);
        return match ? match[1].length : 0;
      }),
    );
    return lines.map(l => (l.trim().length === 0 ? l : l.slice(minIndent))).join('\n');
  };

  const normalizedFind = removeIndentation(find);
  const contentLines = content.split('\n');
  const findLines = find.split('\n');

  for (let i = 0; i <= contentLines.length - findLines.length; i++) {
    const block = contentLines.slice(i, i + findLines.length).join('\n');
    if (removeIndentation(block) === normalizedFind) {
      yield block;
    }
  }
};

// ── Strategy 5: Whitespace-normalized match ──────────────────────────────
// Collapse all whitespace for matching.

export const WhitespaceNormalizedReplacer: Replacer = function* (content, find) {
  const normalize = (text: string) => text.replace(/\s+/g, ' ').trim();
  const normalizedFind = normalize(find);

  // Multi-line matches
  const contentLines = content.split('\n');
  const findLines = find.split('\n');

  if (findLines.length > 1) {
    for (let i = 0; i <= contentLines.length - findLines.length; i++) {
      const block = contentLines.slice(i, i + findLines.length).join('\n');
      if (normalize(block) === normalizedFind) {
        yield block;
      }
    }
  }

  // Single-line matches
  for (const line of contentLines) {
    if (normalize(line) === normalizedFind) {
      yield line;
    }
  }
};

// ── Strategy 6: Trimmed boundary match ───────────────────────────────────
// Try matching with trimmed boundaries on the search text.

export const TrimmedBoundaryReplacer: Replacer = function* (content, find) {
  const trimmedFind = find.trim();
  if (trimmedFind === find) return; // Already trimmed, skip

  if (content.includes(trimmedFind)) {
    yield trimmedFind;
  }

  const contentLines = content.split('\n');
  const findLines = find.split('\n');
  for (let i = 0; i <= contentLines.length - findLines.length; i++) {
    const block = contentLines.slice(i, i + findLines.length).join('\n');
    if (block.trim() === trimmedFind) {
      yield block;
    }
  }
};

// ── Cascade ───────────────────────────────────────────────────────────────

const STRATEGIES: Array<{ name: string; replacer: Replacer }> = [
  { name: 'exact', replacer: SimpleReplacer },
  { name: 'line-trimmed', replacer: LineTrimmedReplacer },
  { name: 'block-anchor', replacer: BlockAnchorReplacer },
  { name: 'indentation-flexible', replacer: IndentationFlexibleReplacer },
  { name: 'whitespace-normalized', replacer: WhitespaceNormalizedReplacer },
  { name: 'trimmed-boundary', replacer: TrimmedBoundaryReplacer },
];

/**
 * Try to replace oldString with newString in content using cascading strategies.
 *
 * @param replaceAll - If true, replace all occurrences. If false (default),
 *   require exactly one occurrence (error if multiple found).
 * @throws Error if no match is found or multiple matches found (when !replaceAll).
 */
export function fuzzyReplace(
  content: string,
  oldString: string,
  newString: string,
  replaceAll = false,
): FuzzyReplaceResult {
  if (oldString === newString) {
    throw new Error('No changes to apply: oldString and newString are identical.');
  }

  let notFound = true;

  for (const { name, replacer } of STRATEGIES) {
    for (const search of replacer(content, oldString)) {
      const index = content.indexOf(search);
      if (index === -1) continue;
      notFound = false;

      if (replaceAll) {
        return {
          newContent: content.replaceAll(search, newString),
          strategy: name,
          usedFuzzy: name !== 'exact',
        };
      }

      // Check uniqueness
      const lastIndex = content.lastIndexOf(search);
      if (index !== lastIndex) continue; // Multiple matches, try next strategy

      return {
        newContent: content.substring(0, index) + newString + content.substring(index + search.length),
        strategy: name,
        usedFuzzy: name !== 'exact',
      };
    }
  }

  if (notFound) {
    throw new Error(
      'Could not find oldString in the file. It must match the content, including whitespace, indentation, and line endings.',
    );
  }
  throw new Error(
    'Found multiple matches for oldString. Provide more surrounding context to make the match unique, or use replaceAll.',
  );
}
