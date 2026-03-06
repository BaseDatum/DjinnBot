/**
 * WorkspaceManagerFactory — Registry + factory for IWorkspaceManager implementations.
 *
 * The factory maintains a list of registered workspace managers and resolves
 * the correct one for a given project configuration. This allows different
 * project types to use different workspace strategies (git worktrees, plain
 * directories, or future custom implementations) without the engine needing
 * to know the details.
 *
 * Usage:
 *   const factory = new WorkspaceManagerFactory();
 *   factory.register(new GitWorktreeWorkspaceManager(config));
 *   factory.register(new SimpleWorkspaceManager());
 *
 *   // At run time, resolve based on project config:
 *   const mgr = factory.resolve({ projectId, repoUrl, workspaceType });
 */

import type { IWorkspaceManager, ProjectWorkspaceConfig, WorkspaceType } from './workspace-types.js';

export class WorkspaceManagerFactory {
  /** Registered managers, keyed by their workspace type. */
  private managers = new Map<WorkspaceType, IWorkspaceManager>();

  /**
   * The fallback manager used when no explicit type matches and no
   * registered manager's `canHandle()` returns true.
   * Typically the git worktree manager (legacy default).
   */
  private defaultManager: IWorkspaceManager | null = null;

  /**
   * Register a workspace manager implementation.
   * The first registered manager becomes the default.
   */
  register(manager: IWorkspaceManager): void {
    this.managers.set(manager.type, manager);
    if (!this.defaultManager) {
      this.defaultManager = manager;
    }
  }

  /**
   * Explicitly set the default manager (used when no type matches).
   */
  setDefault(manager: IWorkspaceManager): void {
    this.defaultManager = manager;
    // Also ensure it's in the registry
    if (!this.managers.has(manager.type)) {
      this.managers.set(manager.type, manager);
    }
  }

  /**
   * Resolve the appropriate workspace manager for a project.
   *
   * Resolution order:
   * 1. If `config.workspaceType` is set, use the manager registered for that type.
   * 2. Otherwise, iterate registered managers and return the first whose
   *    `canHandle(config)` returns true.
   * 3. Fall back to the default manager.
   *
   * Throws if no manager can handle the config.
   */
  resolve(config: ProjectWorkspaceConfig): IWorkspaceManager {
    // 1. Explicit type match
    if (config.workspaceType) {
      const mgr = this.managers.get(config.workspaceType);
      if (mgr) return mgr;
      throw new Error(
        `No workspace manager registered for type '${config.workspaceType}'. ` +
        `Available types: ${[...this.managers.keys()].join(', ')}`
      );
    }

    // 2. Capability-based match
    for (const mgr of this.managers.values()) {
      if (mgr.canHandle(config)) return mgr;
    }

    // 3. Default fallback
    if (this.defaultManager) return this.defaultManager;

    throw new Error(
      `No workspace manager can handle project ${config.projectId} ` +
      `(repoUrl=${config.repoUrl ?? 'none'}, workspaceType=${config.workspaceType ?? 'none'}). ` +
      `Register at least one workspace manager.`
    );
  }

  /**
   * Get a manager by explicit type. Returns undefined if not registered.
   */
  get(type: WorkspaceType): IWorkspaceManager | undefined {
    return this.managers.get(type);
  }

  /**
   * Get the default manager (the one used for legacy/untyped projects).
   */
  getDefault(): IWorkspaceManager | null {
    return this.defaultManager;
  }

  /**
   * List all registered workspace types.
   */
  getRegisteredTypes(): WorkspaceType[] {
    return [...this.managers.keys()];
  }
}
