/**
 * Filesystem walker — scans a repository for parseable source files.
 *
 * Respects .gitignore via `git ls-files` when in a git repo, and falls back
 * to recursive directory walk with common ignore patterns.
 */

import { execSync } from 'node:child_process';
import { readdirSync, readFileSync, statSync, existsSync } from 'node:fs';
import { join, relative, extname } from 'node:path';
import { SUPPORTED_EXTENSIONS, getLanguageFromFilename } from './language-support.js';

/** Common directories to skip (even outside git repos). */
const IGNORE_DIRS = new Set([
  'node_modules', '.git', '.svn', '.hg', 'dist', 'build', 'out',
  '.next', '.nuxt', '.output', '__pycache__', '.mypy_cache', '.pytest_cache',
  'target', 'vendor', '.cargo', '.gradle', '.idea', '.vscode',
  'coverage', '.turbo', '.cache', 'tmp', 'temp',
]);

/** Max file size to process (1MB). Larger files are skipped. */
const MAX_FILE_SIZE = 1_024_000;

export interface ScannedFile {
  /** Relative path from repo root. */
  path: string;
  /** File size in bytes. */
  size: number;
}

/**
 * Walk the repository and return all parseable source files.
 *
 * Uses `git ls-files` in git repos for .gitignore awareness.
 * Falls back to recursive walk with heuristic ignore patterns.
 */
export async function walkRepositoryPaths(
  repoPath: string,
  onProgress?: (current: number, total: number, filePath: string) => void,
): Promise<ScannedFile[]> {
  let files: ScannedFile[];

  const isGit = existsSync(join(repoPath, '.git'));
  if (isGit) {
    files = scanViaGit(repoPath);
  } else {
    files = scanRecursive(repoPath, repoPath);
  }

  // Filter to supported languages + enforce size limit
  const parseable = files.filter(f => {
    if (f.size > MAX_FILE_SIZE) return false;
    return getLanguageFromFilename(f.path) !== null;
  });

  // Report progress
  for (let i = 0; i < parseable.length; i++) {
    onProgress?.(i + 1, parseable.length, parseable[i].path);
  }

  return parseable;
}

/**
 * Read file contents for a set of paths.
 * Returns a Map of relative path → content string.
 */
export function readFileContents(
  repoPath: string,
  paths: string[],
): Map<string, string> {
  const result = new Map<string, string>();
  for (const p of paths) {
    try {
      const content = readFileSync(join(repoPath, p), 'utf-8');
      result.set(p, content);
    } catch {
      // Skip unreadable files
    }
  }
  return result;
}

function scanViaGit(repoPath: string): ScannedFile[] {
  try {
    const stdout = execSync('git ls-files --cached --others --exclude-standard', {
      cwd: repoPath,
      encoding: 'utf-8',
      maxBuffer: 50 * 1024 * 1024, // 50MB
    });

    const files: ScannedFile[] = [];
    for (const line of stdout.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        const fullPath = join(repoPath, trimmed);
        const stat = statSync(fullPath);
        if (stat.isFile()) {
          files.push({ path: trimmed, size: stat.size });
        }
      } catch {
        // Skip files that can't be stat'd
      }
    }
    return files;
  } catch {
    // Fall back to recursive scan
    return scanRecursive(repoPath, repoPath);
  }
}

function scanRecursive(dir: string, rootPath: string): ScannedFile[] {
  const files: ScannedFile[] = [];

  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return files;
  }

  for (const entry of entries) {
    if (entry.name.startsWith('.') && entry.name !== '.') continue;
    if (IGNORE_DIRS.has(entry.name)) continue;

    const fullPath = join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...scanRecursive(fullPath, rootPath));
    } else if (entry.isFile()) {
      const relPath = relative(rootPath, fullPath);
      try {
        const stat = statSync(fullPath);
        files.push({ path: relPath, size: stat.size });
      } catch {
        // Skip
      }
    }
  }

  return files;
}
