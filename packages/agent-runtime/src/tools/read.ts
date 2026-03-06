import { readFile, stat } from 'node:fs/promises';
import { resolve, relative, isAbsolute } from 'node:path';

export interface ReadResult {
  content: string;
  encoding: 'utf8' | 'base64';
  size: number;
  lines?: number;
}

export interface ReadOptions {
  workspacePath?: string;
  offset?: number;
  limit?: number;
  binary?: boolean;
}

function isWithinWorkspace(filePath: string, workspacePath: string): boolean {
  const resolved = resolve(workspacePath, filePath);
  const rel = relative(workspacePath, resolved);
  return !rel.startsWith('..') && !isAbsolute(rel);
}

function isBinaryFile(buffer: Buffer): boolean {
  const sample = buffer.subarray(0, 8192);
  return sample.includes(0);
}

export async function readFileTool(
  path: string,
  options: ReadOptions = {}
): Promise<ReadResult> {
  const {
    workspacePath = '/workspace',
    offset,
    limit,
    binary = false,
  } = options;

  const fullPath = isAbsolute(path) ? path : resolve(workspacePath, path);

  if (!isWithinWorkspace(fullPath, workspacePath)) {
    throw new Error(`Access denied: ${path} is outside workspace`);
  }

  const stats = await stat(fullPath);
  if (!stats.isFile()) {
    throw new Error(`Not a file: ${path}`);
  }

  const buffer = await readFile(fullPath);
  const isBinary = binary || isBinaryFile(buffer);

  if (isBinary) {
    return {
      content: buffer.toString('base64'),
      encoding: 'base64',
      size: stats.size,
    };
  }

  let content = buffer.toString('utf8');
  let lines: number | undefined;

  if (offset !== undefined || limit !== undefined) {
    const allLines = content.split('\n');
    lines = allLines.length;

    const startLine = (offset ?? 1) - 1;
    const endLine = limit !== undefined ? startLine + limit : allLines.length;

    content = allLines.slice(startLine, endLine).join('\n');
  }

  return {
    content,
    encoding: 'utf8',
    size: stats.size,
    lines,
  };
}
