/**
 * Workspace Manager Interface Hierarchy
 *
 * The base IWorkspaceManager is purely about directory lifecycle:
 * creating, resolving, finalizing, and watching workspace directories.
 *
 * Version control (commit, push, branch, merge) is a separate concern
 * expressed through optional sub-interfaces. This allows workspace
 * managers that have no VCS (e.g. persistent_directory) to implement
 * the base contract without stubbing out git-shaped no-ops.
 *
 * Interface hierarchy:
 *
 *   IWorkspaceManager (base — directory lifecycle)
 *   ├── IVersionControlProvider   (optional — commit/snapshot per step)
 *   ├── ITaskWorkspaceProvider    (optional — persistent per-task workspaces)
 *   └── IBranchIntegrationProvider (optional — push/merge across branches)
 */

// ── Shared types ────────────────────────────────────────────────────────────

/**
 * Returned by createRunWorkspaceAsync.
 * Contains only generic filesystem paths. Implementation-specific metadata
 * (branch names, commit hashes, etc.) lives in `metadata`.
 */
export interface WorkspaceInfo {
  projectPath: string;
  runPath: string;
  /** Implementation-specific metadata (e.g. { branch: "feat/..." } for git). */
  metadata?: Record<string, unknown>;
}

/**
 * Returned by finalizeRunWorkspace.
 * Generic result — no git concepts in the type itself.
 */
export interface FinalizeResult {
  /** Whether the workspace was successfully cleaned up / published. */
  cleaned: boolean;
  /** Human-readable summary of what finalization did (for logging). */
  summary?: string;
  /** Error message if finalization partially failed (non-fatal). */
  error?: string;
  /** Implementation-specific details (branch, commitHash, pushed, etc.). */
  metadata?: Record<string, unknown>;
}

/**
 * Identifies the workspace strategy. Stored on the project so the
 * engine knows which IWorkspaceManager to use at run time.
 *
 * 'git_worktree'          — Full git worktree isolation per run (requires a git repo).
 * 'persistent_directory'  — Persistent project directory, no VCS.
 *
 * Extensible: add new literals here when new strategies are implemented.
 */
export type WorkspaceType = 'git_worktree' | 'persistent_directory';

/**
 * Minimal project metadata the factory needs to select a workspace manager.
 */
export interface ProjectWorkspaceConfig {
  projectId: string;
  /** The remote repository URL (if any). */
  repoUrl?: string;
  /** Explicit workspace type override. When absent the factory infers from repoUrl. */
  workspaceType?: WorkspaceType;
}

/**
 * Implementation-specific options passed to createRunWorkspaceAsync.
 * Each workspace manager reads only the keys it understands and ignores the rest.
 */
export interface CreateRunWorkspaceOptions {
  repoUrl?: string;
  /** Git-specific: persistent branch name for this task (e.g. "feat/task_abc123-oauth"). */
  taskBranch?: string;
}


// ── Base interface ──────────────────────────────────────────────────────────

/**
 * Core workspace lifecycle operations.
 *
 * Every workspace manager MUST implement this. It deals only with
 * directories on the filesystem — no version control concepts.
 */
export interface IWorkspaceManager {
  /** The workspace type this manager handles. */
  readonly type: WorkspaceType;

  /**
   * Ensure a project workspace exists (create if missing).
   * Returns the project workspace path.
   */
  ensureProjectAsync(projectId: string, repoUrl?: string): Promise<string>;

  /**
   * Create a workspace for a run within a project.
   * Implementations decide whether this is an isolated directory, a git
   * worktree, or a pointer to the project workspace itself.
   */
  createRunWorkspaceAsync(
    projectId: string,
    runId: string,
    options?: CreateRunWorkspaceOptions,
  ): Promise<WorkspaceInfo>;

  /**
   * Create a standalone workspace for a run not linked to any project.
   */
  ensureRunWorkspace(runId: string): string;

  /**
   * Get the filesystem path for a run's workspace, or null if not set up.
   */
  getRunPath(runId: string): string | null;

  /**
   * Finalize a run workspace after the run completes.
   * What "finalize" means is implementation-specific:
   *   git_worktree: push the branch, remove the worktree
   *   persistent_directory: no-op (workspace is the project dir)
   */
  finalizeRunWorkspace(runId: string, projectId?: string): Promise<FinalizeResult>;

  /**
   * Watch a workspace directory for file changes.
   * Returns a cleanup function to stop watching.
   */
  watchWorkspace(
    runPath: string,
    onChange: (path: string, action: 'create' | 'modify' | 'delete') => void,
  ): () => void;

  /**
   * Return a context string about this workspace for injection into agent prompts.
   * May include VCS info (branch, commits) or filesystem info, depending on type.
   * Returns '' if no context is available.
   */
  getWorkspaceContext(runId: string): string;

  /**
   * Get the base runs directory path.
   */
  getRunsDir(): string;

  /**
   * Check whether this manager can handle the given project config.
   * Used by the factory to select the right implementation.
   */
  canHandle(config: ProjectWorkspaceConfig): boolean;

  // ── Capability checks ─────────────────────────────────────────────────

  /** Whether this manager supports version control (commit per step, etc.). */
  supportsVersionControl(): boolean;

  /** Whether this manager supports persistent per-task workspaces. */
  supportsTaskWorkspaces(): boolean;

  /** Whether this manager supports branch integration (push/merge). */
  supportsBranchIntegration(): boolean;

  // ── Optional narrow-cast accessors ────────────────────────────────────

  asVersionControlProvider?(): IVersionControlProvider;
  asTaskWorkspaceProvider?(): ITaskWorkspaceProvider;
  asBranchIntegrationProvider?(): IBranchIntegrationProvider;
}


// ── Optional sub-interfaces ─────────────────────────────────────────────────

/**
 * Version control operations — commit/snapshot workspace state per step.
 *
 * Only implemented by workspace managers backed by a VCS (e.g. git).
 */
export interface IVersionControlProvider {
  /**
   * Snapshot the workspace state after a step completes.
   * Returns an opaque identifier for the snapshot (e.g. a commit hash),
   * or null if nothing changed.
   */
  commitStep(
    runPath: string,
    stepId: string,
    agentId: string,
    summary: string,
  ): string | null;
}

/**
 * Persistent per-task workspace operations.
 *
 * Used by pulse/persistent agents that need a workspace that survives
 * across multiple wake-up sessions for the same task.
 */
export interface ITaskWorkspaceProvider {
  /**
   * Create or return a persistent task workspace in an agent's sandbox.
   */
  createTaskWorkspace(
    agentId: string,
    projectId: string,
    taskId: string,
    /** Implementation-specific options (e.g. branch name for git). */
    options?: Record<string, unknown>,
  ): Promise<{ workspacePath: string; alreadyExists: boolean; metadata?: Record<string, unknown> }>;

  /**
   * Remove a task workspace when work is complete.
   */
  removeTaskWorkspace(
    agentId: string,
    projectId: string,
    taskId: string,
  ): void;
}

/**
 * Branch integration operations (push/merge across branches).
 *
 * Only meaningful for VCS-backed workspace managers.
 */
export interface IBranchIntegrationProvider {
  /**
   * Push the current branch/state of a run workspace to the remote.
   */
  pushBranch(
    runId: string,
    projectId?: string,
  ): Promise<{
    success: boolean;
    error?: string;
    metadata?: Record<string, unknown>;
  }>;

  /**
   * Merge multiple source branches into a target branch.
   */
  mergeBranches(
    projectId: string,
    targetBranch: string,
    sourceBranches: string[],
  ): Promise<{
    success: boolean;
    merged: string[];
    conflicts: Array<{ branch: string; error: string }>;
    metadata?: Record<string, unknown>;
  }>;
}
