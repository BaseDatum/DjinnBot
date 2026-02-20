import { writeFile, mkdir, access } from 'node:fs/promises';
import { resolve, dirname, relative, isAbsolute } from 'node:path';

export interface WriteResult {
  path: string;
  bytesWritten: number;
  created: boolean;
}

export interface WriteOptions {
  workspacePath?: string;
  encoding?: 'utf8' | 'base64';
  createDirs?: boolean;
}

function isWithinWorkspace(filePath: string, workspacePath: string): boolean {
  const resolved = resolve(workspacePath, filePath);
  const rel = relative(workspacePath, resolved);
  return !rel.startsWith('..') && !isAbsolute(rel);
}

export async function writeFileTool(
  path: string,
  content: string,
  options: WriteOptions = {}
): Promise<WriteResult> {
  const {
    workspacePath = '/workspace',
    encoding = 'utf8',
    createDirs = true,
  } = options;

  // Resolve and validate path
  const fullPath = isAbsolute(path) ? path : resolve(workspacePath, path);

  if (!isWithinWorkspace(fullPath, workspacePath)) {
    throw new Error(`Access denied: ${path} is outside workspace`);
  }

  // Create parent directories if needed
  if (createDirs) {
    await mkdir(dirname(fullPath), { recursive: true });
  }

  // Prepare content
  const buffer = encoding === 'base64'
    ? Buffer.from(content, 'base64')
    : Buffer.from(content, 'utf8');

  // Check if file exists (for created flag)
  let created = true;
  try {
    await access(fullPath);
    created = false;
  } catch {
    created = true;
  }

  // Write file
  await writeFile(fullPath, buffer);

  return {
    path: fullPath,
    bytesWritten: buffer.length,
    created,
  };
}
