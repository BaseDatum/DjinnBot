import { readFile, writeFile } from 'node:fs/promises';
import { resolve, relative, isAbsolute } from 'node:path';

export interface EditResult {
  path: string;
  replacements: number;
  bytesChanged: number;
}

export interface EditOptions {
  workspacePath?: string;
}

function isWithinWorkspace(filePath: string, workspacePath: string): boolean {
  const resolved = resolve(workspacePath, filePath);
  const rel = relative(workspacePath, resolved);
  return !rel.startsWith('..') && !isAbsolute(rel);
}

export async function editFileTool(
  path: string,
  oldText: string,
  newText: string,
  options: EditOptions = {}
): Promise<EditResult> {
  const { workspacePath = '/workspace' } = options;

  // Resolve and validate path
  const fullPath = isAbsolute(path) ? path : resolve(workspacePath, path);

  if (!isWithinWorkspace(fullPath, workspacePath)) {
    throw new Error(`Access denied: ${path} is outside workspace`);
  }

  // Read current content
  const content = await readFile(fullPath, 'utf8');

  // Check if old text exists
  if (!content.includes(oldText)) {
    throw new Error(`Text not found in file: "${oldText.slice(0, 50)}${oldText.length > 50 ? '...' : ''}"`);
  }

  // Count replacements
  let replacements = 0;
  let index = 0;
  while ((index = content.indexOf(oldText, index)) !== -1) {
    replacements++;
    index += oldText.length;
  }

  // Perform replacement
  const newContent = content.split(oldText).join(newText);
  const bytesChanged = Math.abs(newContent.length - content.length);

  // Write back
  await writeFile(fullPath, newContent, 'utf8');

  return {
    path: fullPath,
    replacements,
    bytesChanged,
  };
}