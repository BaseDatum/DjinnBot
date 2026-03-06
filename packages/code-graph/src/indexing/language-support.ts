/**
 * Language detection and Tree-sitter grammar mapping.
 */

import { extname } from 'node:path';

export type SupportedLanguage =
  | 'typescript'
  | 'javascript'
  | 'python'
  | 'go'
  | 'rust'
  | 'java'
  | 'c'
  | 'cpp'
  | 'csharp'
  | 'php';

/** Extension → language mapping. */
const EXT_MAP: Record<string, SupportedLanguage> = {
  '.ts': 'typescript',
  '.tsx': 'typescript',
  '.js': 'javascript',
  '.jsx': 'javascript',
  '.mjs': 'javascript',
  '.cjs': 'javascript',
  '.py': 'python',
  '.go': 'go',
  '.rs': 'rust',
  '.java': 'java',
  '.c': 'c',
  '.h': 'c',
  '.cpp': 'cpp',
  '.cc': 'cpp',
  '.cxx': 'cpp',
  '.hpp': 'cpp',
  '.hh': 'cpp',
  '.cs': 'csharp',
  '.php': 'php',
};

export const SUPPORTED_EXTENSIONS = new Set(Object.keys(EXT_MAP));

/**
 * Detect language from filename. Returns null if unsupported.
 */
export function getLanguageFromFilename(filePath: string): SupportedLanguage | null {
  const ext = extname(filePath).toLowerCase();
  return EXT_MAP[ext] ?? null;
}

/**
 * Load the Tree-sitter grammar for a language.
 * Grammars are loaded lazily and cached.
 */
const grammarCache = new Map<SupportedLanguage, unknown>();

export async function getGrammar(language: SupportedLanguage): Promise<unknown> {
  if (grammarCache.has(language)) {
    return grammarCache.get(language)!;
  }

  let grammar: unknown;
  switch (language) {
    case 'typescript': {
      const mod = await import('tree-sitter-typescript');
      grammar = (mod as any).default?.typescript ?? (mod as any).typescript;
      break;
    }
    case 'javascript': {
      const mod = await import('tree-sitter-javascript');
      grammar = (mod as any).default ?? mod;
      break;
    }
    case 'python': {
      const mod = await import('tree-sitter-python');
      grammar = (mod as any).default ?? mod;
      break;
    }
    case 'go': {
      const mod = await import('tree-sitter-go');
      grammar = (mod as any).default ?? mod;
      break;
    }
    case 'rust': {
      const mod = await import('tree-sitter-rust');
      grammar = (mod as any).default ?? mod;
      break;
    }
    case 'java': {
      const mod = await import('tree-sitter-java');
      grammar = (mod as any).default ?? mod;
      break;
    }
    case 'c': {
      const mod = await import('tree-sitter-c');
      grammar = (mod as any).default ?? mod;
      break;
    }
    case 'cpp': {
      const mod = await import('tree-sitter-cpp');
      grammar = (mod as any).default ?? mod;
      break;
    }
    case 'csharp': {
      const mod = await import('tree-sitter-c-sharp');
      grammar = (mod as any).default ?? mod;
      break;
    }
    case 'php': {
      const mod = await import('tree-sitter-php');
      // tree-sitter-php exports .php and .php_only — use php_only for pure PHP
      grammar = (mod as any).default?.php_only ?? (mod as any).php_only ?? (mod as any).default ?? mod;
      break;
    }
  }

  grammarCache.set(language, grammar);
  return grammar;
}
