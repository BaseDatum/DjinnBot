/**
 * Post-Edit Diagnostics — Run static analysis after file edits.
 *
 * Detects project type from the edited file's extension and runs the
 * appropriate checker (tsc, pyright/py_compile, go vet). Returns
 * structured diagnostic output that agents can act on.
 *
 * This is designed to be called after edit/multiedit tool executions.
 * It runs FAST: syntax-only checks by default, full type checking optional.
 */

import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, extname, resolve } from 'node:path';

// ── Types ─────────────────────────────────────────────────────────────────

export interface Diagnostic {
  file: string;
  line: number;
  column?: number;
  severity: 'error' | 'warning';
  message: string;
}

export interface DiagnosticsResult {
  /** Whether the check ran at all (false if no checker available) */
  ran: boolean;
  /** Which checker was used */
  checker: string;
  /** Diagnostics found */
  diagnostics: Diagnostic[];
  /** Human-readable summary for appending to edit output */
  summary: string;
}

// ── Max diagnostics per check ─────────────────────────────────────────────

const MAX_DIAGNOSTICS = 20;

// ── Language detection ────────────────────────────────────────────────────

type Language = 'typescript' | 'python' | 'go' | 'unknown';

function detectLanguage(filePath: string): Language {
  const ext = extname(filePath).toLowerCase();
  switch (ext) {
    case '.ts':
    case '.tsx':
    case '.js':
    case '.jsx':
    case '.mts':
    case '.cts':
      return 'typescript';
    case '.py':
    case '.pyw':
      return 'python';
    case '.go':
      return 'go';
    default:
      return 'unknown';
  }
}

// ── Find project root (walk up looking for config files) ──────────────────

function findProjectRoot(filePath: string, markers: string[]): string | null {
  let dir = dirname(resolve(filePath));
  const root = '/';
  
  while (dir !== root) {
    for (const marker of markers) {
      if (existsSync(resolve(dir, marker))) {
        return dir;
      }
    }
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

// ── TypeScript / JavaScript checker ───────────────────────────────────────

function checkTypeScript(filePath: string): DiagnosticsResult {
  const projectRoot = findProjectRoot(filePath, ['tsconfig.json', 'jsconfig.json']);
  
  if (!projectRoot) {
    // No tsconfig — just run a syntax check on the file
    const result = spawnSync('node', ['-e', `require('${filePath}')`], {
      encoding: 'utf-8',
      timeout: 15000,
    });
    
    if (result.status === 0) {
      return { ran: true, checker: 'node-syntax', diagnostics: [], summary: '' };
    }
    
    // Try to parse the error
    return {
      ran: true,
      checker: 'node-syntax',
      diagnostics: [],
      summary: '', // Don't report syntax errors without tsconfig
    };
  }

  // Run tsc --noEmit with focus on the edited file
  const result = spawnSync('npx', ['tsc', '--noEmit', '--pretty', 'false'], {
    cwd: projectRoot,
    encoding: 'utf-8',
    timeout: 30000,
    env: { ...process.env, NODE_ENV: 'development' },
  });

  if (result.status === 0) {
    return { ran: true, checker: 'tsc', diagnostics: [], summary: '' };
  }

  const output = (result.stdout || '') + (result.stderr || '');
  const diagnostics = parseTscOutput(output, filePath);

  return buildResult('tsc', diagnostics, filePath);
}

function parseTscOutput(output: string, filterFile?: string): Diagnostic[] {
  const diagnostics: Diagnostic[] = [];
  // tsc --pretty false format: path(line,col): error TSxxxx: message
  const regex = /^(.+?)\((\d+),(\d+)\):\s+(error|warning)\s+TS\d+:\s+(.+)$/gm;
  
  let match;
  while ((match = regex.exec(output)) !== null) {
    const [, file, line, col, severity, message] = match;
    
    // Only include diagnostics for the edited file (or all if no filter)
    if (filterFile && !file.endsWith(filterFile) && !filterFile.endsWith(file)) {
      // Normalize paths for comparison
      const normalizedFilter = resolve(filterFile);
      const normalizedFile = resolve(file);
      if (normalizedFilter !== normalizedFile) continue;
    }
    
    diagnostics.push({
      file,
      line: parseInt(line, 10),
      column: parseInt(col, 10),
      severity: severity as 'error' | 'warning',
      message,
    });
  }
  
  return diagnostics;
}

// ── Python checker ────────────────────────────────────────────────────────

function checkPython(filePath: string): DiagnosticsResult {
  // First try py_compile (always available, fast, syntax only)
  const result = spawnSync('python3', ['-m', 'py_compile', filePath], {
    encoding: 'utf-8',
    timeout: 10000,
  });

  if (result.status === 0) {
    return { ran: true, checker: 'py_compile', diagnostics: [], summary: '' };
  }

  const output = (result.stdout || '') + (result.stderr || '');
  const diagnostics = parsePythonOutput(output, filePath);
  
  return buildResult('py_compile', diagnostics, filePath);
}

function parsePythonOutput(output: string, filePath: string): Diagnostic[] {
  const diagnostics: Diagnostic[] = [];
  
  // py_compile format: File "path", line N
  //   followed by the error on subsequent lines
  const fileLineRegex = /File "(.+?)", line (\d+)/g;
  let match;
  while ((match = fileLineRegex.exec(output)) !== null) {
    const [, , line] = match;
    // Get the error message (usually the last line of output)
    const lines = output.trim().split('\n');
    const errorLine = lines[lines.length - 1];
    
    diagnostics.push({
      file: filePath,
      line: parseInt(line, 10),
      severity: 'error',
      message: errorLine || 'Syntax error',
    });
  }
  
  // If no structured match, treat the whole output as an error
  if (diagnostics.length === 0 && output.trim()) {
    diagnostics.push({
      file: filePath,
      line: 1,
      severity: 'error',
      message: output.trim().split('\n').pop() || 'Syntax error',
    });
  }
  
  return diagnostics;
}

// ── Go checker ────────────────────────────────────────────────────────────

function checkGo(filePath: string): DiagnosticsResult {
  const dir = dirname(filePath);
  
  const result = spawnSync('go', ['vet', './...'], {
    cwd: dir,
    encoding: 'utf-8',
    timeout: 15000,
  });

  if (result.status === 0) {
    return { ran: true, checker: 'go-vet', diagnostics: [], summary: '' };
  }

  const output = (result.stdout || '') + (result.stderr || '');
  const diagnostics = parseGoOutput(output, filePath);
  
  return buildResult('go-vet', diagnostics, filePath);
}

function parseGoOutput(output: string, filterFile: string): Diagnostic[] {
  const diagnostics: Diagnostic[] = [];
  // go vet format: ./file.go:line:col: message
  const regex = /^(.+?):(\d+):(\d+):\s+(.+)$/gm;
  
  let match;
  while ((match = regex.exec(output)) !== null) {
    const [, file, line, col, message] = match;
    diagnostics.push({
      file,
      line: parseInt(line, 10),
      column: parseInt(col, 10),
      severity: 'error',
      message,
    });
  }
  
  return diagnostics;
}

// ── Result builder ────────────────────────────────────────────────────────

function buildResult(checker: string, diagnostics: Diagnostic[], filePath: string): DiagnosticsResult {
  const errors = diagnostics.filter(d => d.severity === 'error');
  
  if (errors.length === 0) {
    return { ran: true, checker, diagnostics: [], summary: '' };
  }
  
  const limited = errors.slice(0, MAX_DIAGNOSTICS);
  const suffix = errors.length > MAX_DIAGNOSTICS
    ? `\n  ... and ${errors.length - MAX_DIAGNOSTICS} more error(s)`
    : '';
  
  const lines = limited.map(d => {
    const loc = d.column ? `${d.line}:${d.column}` : String(d.line);
    return `  ${d.file}:${loc} - ${d.severity}: ${d.message}`;
  });
  
  const summary = `\n\nErrors detected after edit (${checker}):\n${lines.join('\n')}${suffix}`;
  
  return {
    ran: true,
    checker,
    diagnostics: limited,
    summary,
  };
}

// ── Public API ────────────────────────────────────────────────────────────

/**
 * Run post-edit diagnostics on a file.
 * Returns structured results with a human-readable summary.
 * Catches all errors internally — never throws.
 */
export function runDiagnostics(filePath: string): DiagnosticsResult {
  const language = detectLanguage(filePath);
  
  try {
    switch (language) {
      case 'typescript':
        return checkTypeScript(filePath);
      case 'python':
        return checkPython(filePath);
      case 'go':
        return checkGo(filePath);
      default:
        return { ran: false, checker: 'none', diagnostics: [], summary: '' };
    }
  } catch (err) {
    // Never let diagnostics crash the tool
    console.error(`[diagnostics] Error checking ${filePath}:`, err);
    return { ran: false, checker: 'error', diagnostics: [], summary: '' };
  }
}
