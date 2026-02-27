/**
 * PersistentDirectoryWorkspaceManager — Persistent project workspace without version control.
 *
 * For non-git projects (content pipelines, research, simple kanban).
 * The project workspace at WORKSPACES_DIR/{projectId}/ is persistent and
 * accumulates files across runs. The run workspace IS the project workspace —
 * agents work directly in the persistent directory.
 *
 * Standalone runs (no project) get an ephemeral directory in RUNS_DIR.
 */

import { existsSync, mkdirSync, rmSync, watch } from 'node:fs';
import { join } from 'node:path';
import type {
  IWorkspaceManager,
  WorkspaceInfo,
  FinalizeResult,
  WorkspaceType,
  ProjectWorkspaceConfig,
  CreateRunWorkspaceOptions,
} from './workspace-types.js';

const WORKSPACES_DIR = process.env.WORKSPACES_DIR || '/jfs/workspaces';
const RUNS_DIR = process.env.SHARED_RUNS_DIR || join(WORKSPACES_DIR, '.runs');

export class PersistentDirectoryWorkspaceManager implements IWorkspaceManager {
  readonly type: WorkspaceType = 'persistent_directory';

  /**
   * Track which runIds have been registered so getRunPath(runId) works.
   * For project runs the value is the project workspace path.
   * For standalone runs the value is RUNS_DIR/{runId}.
   */
  private runPaths = new Map<string, string>();

  constructor() {
    mkdirSync(WORKSPACES_DIR, { recursive: true });
    mkdirSync(RUNS_DIR, { recursive: true });
  }

  // ── Capability checks ─────────────────────────────────────────────────

  supportsVersionControl(): boolean {
    return false;
  }

  supportsTaskWorkspaces(): boolean {
    return false;
  }

  supportsBranchIntegration(): boolean {
    return false;
  }

  canHandle(config: ProjectWorkspaceConfig): boolean {
    if (config.workspaceType === 'persistent_directory') return true;
    return false;
  }

  // ── IWorkspaceManager ─────────────────────────────────────────────────

  async ensureProjectAsync(projectId: string): Promise<string> {
    const projectPath = join(WORKSPACES_DIR, projectId);
    if (!existsSync(projectPath)) {
      mkdirSync(projectPath, { recursive: true });
      console.log(`[PersistentDirWM] Created project directory: ${projectPath}`);
    }
    return projectPath;
  }

  async createRunWorkspaceAsync(
    projectId: string,
    runId: string,
    _options?: CreateRunWorkspaceOptions,
  ): Promise<WorkspaceInfo> {
    const projectPath = await this.ensureProjectAsync(projectId);

    // The run workspace IS the project workspace — persistent across runs.
    // We register the mapping so getRunPath(runId) works.
    this.runPaths.set(runId, projectPath);

    console.log(`[PersistentDirWM] Run ${runId} workspace → project directory ${projectPath}`);

    return {
      projectPath,
      runPath: projectPath,
    };
  }

  ensureRunWorkspace(runId: string): string {
    // Standalone runs (no project) get an ephemeral directory
    const runPath = join(RUNS_DIR, runId);
    if (!existsSync(runPath)) {
      mkdirSync(runPath, { recursive: true });
      console.log(`[PersistentDirWM] Created standalone workspace: ${runPath}`);
    }
    this.runPaths.set(runId, runPath);
    return runPath;
  }

  getRunPath(runId: string): string | null {
    const tracked = this.runPaths.get(runId);
    if (tracked && existsSync(tracked)) return tracked;

    // Fallback: check RUNS_DIR for standalone runs
    const runPath = join(RUNS_DIR, runId);
    return existsSync(runPath) ? runPath : null;
  }

  async finalizeRunWorkspace(
    runId: string,
    _projectId?: string,
  ): Promise<FinalizeResult> {
    const runPath = this.runPaths.get(runId);
    this.runPaths.delete(runId);

    // If this was a project run, the workspace is persistent — don't delete it.
    // Only clean up standalone run directories (those living in RUNS_DIR).
    if (runPath && runPath.startsWith(RUNS_DIR) && existsSync(runPath)) {
      try {
        rmSync(runPath, { recursive: true, force: true });
        console.log(`[PersistentDirWM] Cleaned up standalone workspace: ${runPath}`);
        return { cleaned: true, summary: 'Standalone workspace removed' };
      } catch (err) {
        return { cleaned: false, error: `Failed to clean up: ${err}` };
      }
    }

    // Project run — workspace is persistent, nothing to clean up
    return { cleaned: true, summary: 'Project workspace persisted' };
  }

  watchWorkspace(
    runPath: string,
    onChange: (path: string, action: 'create' | 'modify' | 'delete') => void,
  ): () => void {
    const debounceMap = new Map<string, ReturnType<typeof setTimeout>>();

    const watcher = watch(runPath, { recursive: true }, (eventType: string, filename: string | null) => {
      if (!filename) return;
      if (this.shouldIgnoreFile(filename)) return;

      const existing = debounceMap.get(filename);
      if (existing) clearTimeout(existing);

      debounceMap.set(filename, setTimeout(() => {
        debounceMap.delete(filename);
        const action = eventType === 'rename' ? 'create' : 'modify';
        onChange(filename, action);
      }, 300));
    });

    return () => {
      watcher.close();
      for (const timer of debounceMap.values()) clearTimeout(timer);
      debounceMap.clear();
    };
  }

  getWorkspaceContext(_runId: string): string {
    return '';
  }

  getRunsDir(): string {
    return RUNS_DIR;
  }

  // ── Private helpers ───────────────────────────────────────────────────

  private shouldIgnoreFile(filePath: string): boolean {
    const ignoredPatterns = [
      'node_modules/', '__pycache__/', '.venv/', 'venv/',
      'dist/', 'build/', '.next/', '.turbo/',
      '.cache/', '.pytest_cache/',
      'package-lock.json', 'yarn.lock', 'pnpm-lock.yaml',
      '.DS_Store', 'Thumbs.db',
      '.vscode/', '.idea/',
    ];

    const normalizedPath = filePath.replace(/\\/g, '/');
    return ignoredPatterns.some(pattern => {
      if (pattern.endsWith('/')) {
        return normalizedPath.startsWith(pattern) || normalizedPath.includes(`/${pattern}`);
      }
      return normalizedPath === pattern ||
             normalizedPath.endsWith(`/${pattern}`) ||
             normalizedPath.includes(`/${pattern}/`);
    });
  }
}

/**
 * Backward-compatible alias for the old name.
 */
export const SimpleWorkspaceManager = PersistentDirectoryWorkspaceManager;
export type SimpleWorkspaceManager = PersistentDirectoryWorkspaceManager;
