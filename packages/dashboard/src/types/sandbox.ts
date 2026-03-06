// Matches backend SandboxInfo from /api/agents/{id}/sandbox
export interface FileNode {
  name: string;
  path: string;
  type: 'file' | 'directory';
  size?: number;
  modified?: number;
  children?: FileNode[];
}

export interface InstalledTool {
  name: string;
  version?: string | null;
}

export interface DiskUsage {
  used: number;
  total: number;
  unit: string;
}

export interface SandboxInfo {
  sandboxId: string;
  diskUsage: DiskUsage;
  fileCount: number;
  directoryCount: number;
  installedTools: InstalledTool[];
  rootFiles: FileNode[];
}

// Matches backend FileTree from /api/agents/{id}/sandbox/tree
export interface FileTree {
  path: string;
  files: FileNode[];
}

// Matches backend FileContent from /api/agents/{id}/sandbox/file
export interface SandboxFileContent {
  path: string;
  content: string;
  size: number;
  modified: number;
  encoding: 'utf-8' | 'base64';
  truncated: boolean;
}

// Legacy compatibility aliases
export type SandboxOverview = SandboxInfo;
export type FileEntry = FileNode;
export type FileContent = SandboxFileContent;

export interface ResetSandboxResponse {
  success: boolean;
  message: string;
}
