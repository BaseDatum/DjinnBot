import { authFetch } from '../api/auth-fetch.js';
import { execSync } from 'node:child_process';
import { existsSync, mkdirSync, rmSync, watch, statSync } from 'node:fs';
import { join } from 'node:path';

const WORKSPACES_DIR = process.env.WORKSPACES_DIR || '/data/workspaces';
// SHARED_RUNS_DIR aligns with docker-compose env var used by both engine and API
// This ensures TypeScript and Python look in the same location for run workspaces
const RUNS_DIR = process.env.SHARED_RUNS_DIR || join(WORKSPACES_DIR, '.runs');
// SANDBOXES_DIR is the persistent home directory root for agents
// Mirrors the /djinnbot-data/sandboxes/{agentId} path inside containers
const SANDBOXES_DIR = process.env.SANDBOXES_DIR || '/data/sandboxes';
const API_BASE_URL = process.env.DJINNBOT_API_URL || 'http://localhost:8000';



interface GitTokenResponse {
  token: string;
  expires_at: number;
  installation_id: number;
  repo_url: string;
}

export interface WorkspaceInfo {
  projectPath: string;
  runPath: string;
  branch: string;
}

/**
 * Convert a task title + id into a stable, filesystem-safe branch name.
 * Format: feat/{taskId-slug}
 * Example: "feat/task_abc123-implement-oauth-login"
 */
export function taskBranchName(taskId: string, taskTitle?: string): string {
  const slug = taskTitle
    ? taskTitle
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '')
        .slice(0, 40)
    : '';
  return slug ? `feat/${taskId}-${slug}` : `feat/${taskId}`;
}

export interface WorkspaceManagerConfig {
  /** Callback to get repository URL for a project (from database) - can be sync or async */
  getProjectRepository?: (projectId: string) => string | null | Promise<string | null>;
}

export class WorkspaceManager {
  private getProjectRepository?: (projectId: string) => string | null | Promise<string | null>;

  constructor(config?: WorkspaceManagerConfig) {
    this.getProjectRepository = config?.getProjectRepository;
    console.log(`[WorkspaceManager] Initialized with repo lookup callback: ${!!this.getProjectRepository}`);
    mkdirSync(WORKSPACES_DIR, { recursive: true });
    mkdirSync(RUNS_DIR, { recursive: true });
  }

  /**
   * Get the runs directory path.
   * Used by SandboxManager for backward compatibility.
   */
  getRunsDir(): string {
    return RUNS_DIR;
  }

  /**
   * Fetch a git access token from the API for a project.
   * This uses GitHub App installation tokens for authenticated access.
   */
  async fetchGitToken(projectId: string, repoUrl?: string): Promise<GitTokenResponse | null> {
    // 1. Try project-level token (fast path — uses ProjectGitHub DB record)
    try {
      const response = await authFetch(`${API_BASE_URL}/v1/github/projects/${projectId}/git-token`);
      if (response.ok) {
        return await response.json() as GitTokenResponse;
      }
      if (response.status !== 404) {
        throw new Error(`Failed to fetch git token: ${response.status}`);
      }
      // 404 = no ProjectGitHub record — fall through to repo-level lookup
    } catch (err) {
      console.warn(`[WorkspaceManager] Project git-token lookup failed for ${projectId}:`, err);
    }

    // 2. Fall back to repo-level token (resolves installation from GitHub API by repo URL)
    if (repoUrl && repoUrl.includes('github.com')) {
      try {
        const repoParam = encodeURIComponent(repoUrl);
        const response = await authFetch(`${API_BASE_URL}/v1/github/repo-token?repo=${repoParam}`);
        if (response.ok) {
          const data = await response.json() as any;
          console.log(`[WorkspaceManager] Resolved GitHub App token via repo-token for ${repoUrl} (installation: ${data.installation_id})`);
          return {
            token: data.token,
            expires_at: data.expires_at,
            installation_id: data.installation_id,
            repo_url: data.clone_url,
          };
        }
        if (response.status === 404) {
          console.warn(`[WorkspaceManager] GitHub App not installed on ${repoUrl}`);
        } else {
          console.warn(`[WorkspaceManager] repo-token failed: ${response.status}`);
        }
      } catch (err) {
        console.warn(`[WorkspaceManager] repo-token lookup failed for ${repoUrl}:`, err);
      }
    }

    return null;
  }

  /**
   * Ensure a project workspace exists. Clone from repo URL or init empty.
   * Synchronous version - uses env GITHUB_TOKEN for auth.
   */
  ensureProject(projectId: string, repoUrl?: string): string {
    const projectPath = join(WORKSPACES_DIR, projectId);
    if (existsSync(join(projectPath, '.git'))) {
      console.log(`[WorkspaceManager] Project ${projectId} already exists at ${projectPath}`);
      return projectPath;
    }

    console.log(`[WorkspaceManager] Creating project ${projectId} at ${projectPath}`);
    mkdirSync(projectPath, { recursive: true });
    
    if (repoUrl) {
      console.log(`[WorkspaceManager] Cloning repository: ${repoUrl}`);
      try {
        const cloneUrl = this.addCredentials(repoUrl);
        execSync(`git clone "${cloneUrl}" "${projectPath}"`, { 
          stdio: 'pipe',
          encoding: 'utf8'
        });
        console.log(`[WorkspaceManager] Successfully cloned ${repoUrl}`);
      } catch (err) {
        console.error(`[WorkspaceManager] Clone failed:`, err);
        // Cleanup failed clone attempt
        try {
          rmSync(projectPath, { recursive: true, force: true });
        } catch {}
        throw new Error(`Failed to clone repository: ${repoUrl}`);
      }
    } else {
      console.log(`[WorkspaceManager] Initializing empty git repository`);
      execSync('git init', { cwd: projectPath, stdio: 'pipe' });
      execSync('git commit --allow-empty -m "Initial commit"', {
        cwd: projectPath,
        stdio: 'pipe',
        env: {
          ...process.env,
          GIT_AUTHOR_NAME: 'djinnbot',
          GIT_AUTHOR_EMAIL: 'djinnbot@local',
          GIT_COMMITTER_NAME: 'djinnbot',
          GIT_COMMITTER_EMAIL: 'djinnbot@local',
        },
      });
    }
    return projectPath;
  }

  /**
   * Ensure a project workspace exists (async version).
   * Uses GitHub App installation token from API when available.
   */
  async ensureProjectAsync(projectId: string, repoUrl?: string): Promise<string> {
    const projectPath = join(WORKSPACES_DIR, projectId);
    if (existsSync(join(projectPath, '.git'))) {
      console.log(`[WorkspaceManager] Project ${projectId} already exists at ${projectPath}`);
      return projectPath;
    }

    // Look up repo URL from database if not provided
    if (!repoUrl && this.getProjectRepository) {
      console.log(`[WorkspaceManager] Looking up repository for ${projectId}...`);
      repoUrl = await Promise.resolve(this.getProjectRepository(projectId)) || undefined;
      if (repoUrl) {
        console.log(`[WorkspaceManager] Found repository URL for ${projectId}: ${repoUrl}`);
      } else {
        console.log(`[WorkspaceManager] No repository URL found for ${projectId}`);
      }
    } else if (!repoUrl) {
      console.log(`[WorkspaceManager] No repository lookup callback configured`);
    }

    console.log(`[WorkspaceManager] Creating project ${projectId} at ${projectPath}`);
    mkdirSync(projectPath, { recursive: true });
    
    if (repoUrl) {
      console.log(`[WorkspaceManager] Cloning repository: ${repoUrl}`);
      try {
        // Try to get authenticated URL from API (GitHub App)
        const gitToken = await this.fetchGitToken(projectId, repoUrl);
        let cloneUrl: string;
        
        if (gitToken) {
          console.log(`[WorkspaceManager] Using GitHub App token for clone (installation: ${gitToken.installation_id})`);
          cloneUrl = gitToken.repo_url;
        } else {
          // Fall back to env-based credentials
          cloneUrl = this.addCredentials(repoUrl);
          
          // Pre-flight: warn if no authentication is available at all
          if (cloneUrl === repoUrl && repoUrl.startsWith('https://')) {
            console.warn(
              `[WorkspaceManager] No authentication available for ${repoUrl}. ` +
              `Neither a GitHub App installation token nor GITHUB_TOKEN env var is configured. ` +
              `Clone will only succeed for public repositories.`
            );
          }
        }
        
        execSync(`git clone "${cloneUrl}" "${projectPath}"`, { 
          stdio: 'pipe',
          encoding: 'utf8',
          env: {
            ...process.env,
            GIT_TERMINAL_PROMPT: '0',
          }
        });
        console.log(`[WorkspaceManager] Successfully cloned ${repoUrl}`);
      } catch (err) {
        console.error(`[WorkspaceManager] Clone failed:`, err);
        // Cleanup failed clone attempt
        try {
          rmSync(projectPath, { recursive: true, force: true });
        } catch {}
        
        // Provide actionable error message
        const errMsg = (err as any)?.stderr || (err as Error)?.message || '';
        if (errMsg.includes('could not read Username') || errMsg.includes('Authentication failed')) {
          throw new Error(
            `Failed to clone repository ${repoUrl}: authentication failed. ` +
            `Install the GitHub App on this repository (Project Settings > GitHub) ` +
            `or set the GITHUB_TOKEN environment variable.`
          );
        }
        throw new Error(`Failed to clone repository: ${repoUrl}`);
      }
    } else {
      // No repository URL — initialise an empty git repo so worktrees can be created.
      // This allows projects that haven't linked a remote to still run tasks.
      console.log(`[WorkspaceManager] No repository URL for project ${projectId} — initialising empty git repo at ${projectPath}`);
      try {
        execSync('git init', { cwd: projectPath, stdio: 'pipe' });
        execSync('git commit --allow-empty -m "Initial commit"', {
          cwd: projectPath,
          stdio: 'pipe',
          env: {
            ...process.env,
            GIT_AUTHOR_NAME: 'djinnbot',
            GIT_AUTHOR_EMAIL: 'djinnbot@local',
            GIT_COMMITTER_NAME: 'djinnbot',
            GIT_COMMITTER_EMAIL: 'djinnbot@local',
          },
        });
        console.log(`[WorkspaceManager] Initialised empty project repo for ${projectId}`);
      } catch (initErr) {
        // Cleanup on failure
        try { rmSync(projectPath, { recursive: true, force: true }); } catch {}
        throw new Error(`Failed to initialise empty repo for project ${projectId}: ${(initErr as Error).message}`);
      }
    }
    return projectPath;
  }

  /**
   * Create a worktree for a run. Branch name: run/{run_id}
   */
  createRunWorktree(projectId: string, runId: string, repoUrl?: string): WorkspaceInfo {
    // Ensure project exists (will clone if repoUrl provided and not exists)
    const projectPath = this.ensureProject(projectId, repoUrl);
    const runPath = join(RUNS_DIR, runId);
    const branch = `run/${runId}`;

    console.log(`[WorkspaceManager] createRunWorktree: projectId=${projectId}, runId=${runId}`);

    // Check if worktree already exists
    if (existsSync(runPath)) {
      const gitPath = join(runPath, '.git');
      const gitExists = existsSync(gitPath);
      const gitIsFile = gitExists && !statSync(gitPath).isDirectory();
      
      // Valid worktree - .git is a FILE (pointer to parent repo)
      if (gitIsFile) {
        try {
          const currentBranch = execSync('git rev-parse --abbrev-ref HEAD', { 
            cwd: runPath, 
            encoding: 'utf8',
            stdio: ['pipe', 'pipe', 'pipe']
          }).trim();
          
          if (currentBranch === branch) {
            console.log(`[WorkspaceManager] Worktree already exists at ${runPath}`);
            return { projectPath, runPath, branch };
          }
        } catch {
          // Can't verify, continue to fail below
        }
      }
      
      // Corrupted worktree - .git is a DIRECTORY (agent ran git init) or verification failed
      if (gitExists && !gitIsFile) {
        throw new Error(
          `Run workspace ${runId} is corrupted: .git is a directory instead of a worktree pointer. ` +
          `An agent likely ran 'git init' in /workspace/.run which is forbidden. ` +
          `The run must be recreated.`
        );
      }
      
      // Something else is wrong
      throw new Error(
        `Run workspace ${runId} exists but is not a valid worktree. ` +
        `Path: ${runPath}. The run must be recreated.`
      );
    }

    // Worktree doesn't exist - create it
    console.log(`[WorkspaceManager] Creating worktree for run ${runId} from project ${projectId}`);

    // Pull latest if cloned repo
    if (repoUrl) {
      try {
        execSync('git pull --ff-only 2>/dev/null || true', { cwd: projectPath, stdio: 'pipe' });
      } catch {
        // Non-fatal
      }
    }

    // Prune any stale worktree references
    try {
      execSync('git worktree prune', { cwd: projectPath, stdio: 'pipe' });
    } catch {
      // Non-fatal
    }

    // Check if branch already exists (from a previous failed/incomplete run)
    const branchList = execSync(`git branch --list "${branch}"`, { 
      cwd: projectPath, 
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'pipe']
    }).trim();
    
    if (branchList) {
      // Branch exists but worktree doesn't - delete the orphan branch
      console.log(`[WorkspaceManager] Deleting orphan branch ${branch}`);
      execSync(`git branch -D "${branch}"`, { cwd: projectPath, stdio: 'pipe' });
    }

    // Create the worktree
    try {
      execSync(`git worktree add "${runPath}" -b "${branch}"`, { 
        cwd: projectPath, 
        stdio: 'pipe',
        encoding: 'utf8'
      });
      console.log(`[WorkspaceManager] Created worktree at ${runPath} (branch: ${branch})`);
    } catch (err: any) {
      const stderr = err.stderr?.toString() || err.message || 'Unknown error';
      console.error(`[WorkspaceManager] Failed to create worktree (sync):`);
      console.error(`  - Project path: ${projectPath}`);
      console.error(`  - Run path: ${runPath}`);
      console.error(`  - Branch: ${branch}`);
      console.error(`  - Error: ${stderr}`);
      throw new Error(`Failed to create worktree for run ${runId}: ${stderr}`);
    }

    return { projectPath, runPath, branch };
  }

  /**
   * Create a worktree for a run (async version).
   * Uses GitHub App installation token from API when available.
   *
   * @param taskBranch - Optional persistent task-scoped branch name (e.g. "feat/task_abc123-oauth").
   *   When provided the worktree will use this branch instead of the ephemeral "run/{runId}" branch.
   *   The branch is created if it does not yet exist, or checked out if it does.
   *   This enables multiple runs (design, implement, review) to share a single PR branch.
   */
  async createRunWorktreeAsync(projectId: string, runId: string, repoUrl?: string, taskBranch?: string): Promise<WorkspaceInfo> {
    // Ensure project exists (will clone with API auth if available)
    const projectPath = await this.ensureProjectAsync(projectId, repoUrl);
    const runPath = join(RUNS_DIR, runId);
    const branch = taskBranch ?? `run/${runId}`;

    console.log(`[WorkspaceManager] createRunWorktreeAsync: projectId=${projectId}, runId=${runId}`);

    // Check if worktree already exists
    if (existsSync(runPath)) {
      const gitPath = join(runPath, '.git');
      const gitExists = existsSync(gitPath);
      const gitIsFile = gitExists && !statSync(gitPath).isDirectory();
      
      // Valid worktree - .git is a FILE (pointer to parent repo)
      if (gitIsFile) {
        try {
          const currentBranch = execSync('git rev-parse --abbrev-ref HEAD', { 
            cwd: runPath, 
            encoding: 'utf8',
            stdio: ['pipe', 'pipe', 'pipe']
          }).trim();
          
          if (currentBranch === branch) {
            console.log(`[WorkspaceManager] Worktree already exists at ${runPath}`);
            return { projectPath, runPath, branch };
          }
        } catch {
          // Can't verify, continue to fail below
        }
      }
      
      // Corrupted worktree - .git is a DIRECTORY (agent ran git init)
      if (gitExists && !gitIsFile) {
        throw new Error(
          `Run workspace ${runId} is corrupted: .git is a directory instead of a worktree pointer. ` +
          `An agent likely ran 'git init' in /workspace/.run which is forbidden. ` +
          `The run must be recreated.`
        );
      }
      
      // Something else is wrong
      throw new Error(
        `Run workspace ${runId} exists but is not a valid worktree. ` +
        `Path: ${runPath}. The run must be recreated.`
      );
    }

    // Worktree doesn't exist - create it
    console.log(`[WorkspaceManager] Creating worktree for run ${runId} from project ${projectId}`);

    // Pull latest if cloned repo (with GitHub App auth if available)
    if (repoUrl) {
      try {
        const gitToken = await this.fetchGitToken(projectId, repoUrl);
        if (gitToken) {
          const originalUrl = execSync('git remote get-url origin', { cwd: projectPath, encoding: 'utf8' }).trim();
          try {
            execSync(`git remote set-url origin "${gitToken.repo_url}"`, { cwd: projectPath, stdio: 'pipe' });
            execSync('git pull --ff-only', { cwd: projectPath, stdio: 'pipe' });
          } finally {
            execSync(`git remote set-url origin "${originalUrl}"`, { cwd: projectPath, stdio: 'pipe' });
          }
        } else {
          execSync('git pull --ff-only 2>/dev/null || true', { cwd: projectPath, stdio: 'pipe' });
        }
      } catch {
        // Non-fatal
      }
    }

    // Prune any stale worktree references
    try {
      execSync('git worktree prune', { cwd: projectPath, stdio: 'pipe' });
    } catch {
      // Non-fatal
    }

    // Check if branch already exists in the project repo
    const branchList = execSync(`git branch --list "${branch}"`, { 
      cwd: projectPath, 
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'pipe']
    }).trim();

    const isTaskBranch = taskBranch !== undefined;

    if (branchList) {
      if (isTaskBranch) {
        // Task-scoped branch already exists (from a previous run on this task).
        // Check it out in a new worktree so this run can continue where the last left off.
        console.log(`[WorkspaceManager] Task branch ${branch} exists — creating worktree on existing branch`);
        try {
          execSync(`git worktree add "${runPath}" "${branch}"`, {
            cwd: projectPath,
            stdio: 'pipe',
            encoding: 'utf8',
          });
          console.log(`[WorkspaceManager] Created worktree at ${runPath} (existing task branch: ${branch})`);
        } catch (err: any) {
          const stderr = err.stderr?.toString() || err.message || 'Unknown error';
          throw new Error(`Failed to create worktree for run ${runId} on task branch ${branch}: ${stderr}`);
        }
      } else {
        // Ephemeral run branch exists but worktree doesn't — orphan from a crashed run.
        // Delete the stale branch and recreate.
        console.log(`[WorkspaceManager] Deleting orphan run branch ${branch}`);
        execSync(`git branch -D "${branch}"`, { cwd: projectPath, stdio: 'pipe' });
        try {
          execSync(`git worktree add "${runPath}" -b "${branch}"`, { 
            cwd: projectPath, stdio: 'pipe', encoding: 'utf8',
          });
          console.log(`[WorkspaceManager] Created worktree at ${runPath} (branch: ${branch})`);
        } catch (err: any) {
          const stderr = err.stderr?.toString() || err.message || 'Unknown error';
          throw new Error(`Failed to create worktree for run ${runId}: ${stderr}`);
        }
      }
    } else {
      // Branch does not exist yet — create it (works for both run/* and feat/* branches)
      try {
        execSync(`git worktree add "${runPath}" -b "${branch}"`, { 
          cwd: projectPath, 
          stdio: 'pipe',
          encoding: 'utf8'
        });
        console.log(`[WorkspaceManager] Created worktree at ${runPath} (new branch: ${branch})`);
      } catch (err: any) {
        const stderr = err.stderr?.toString() || err.message || 'Unknown error';
        throw new Error(`Failed to create worktree for run ${runId}: ${stderr}`);
      }
    }

    return { projectPath, runPath, branch };
  }

  /**
   * Ensure a run workspace exists (without a project — standalone git repo).
   * This is used for runs not associated with a project.
   */
  ensureRunWorkspace(runId: string): string {
    const runPath = join(RUNS_DIR, runId);
    
    // Already exists - return it
    if (existsSync(join(runPath, '.git'))) {
      console.log(`[WorkspaceManager] Standalone workspace already exists: ${runPath}`);
      return runPath;
    }

    console.log(`[WorkspaceManager] Creating standalone workspace for run ${runId} at ${runPath}`);
    console.log(`[WorkspaceManager] RUNS_DIR=${RUNS_DIR}`);
    
    try {
      mkdirSync(runPath, { recursive: true });
      execSync('git init', { cwd: runPath, stdio: 'pipe' });
      execSync('git commit --allow-empty -m "Initial commit"', {
        cwd: runPath,
        stdio: 'pipe',
        env: {
          ...process.env,
          GIT_AUTHOR_NAME: 'djinnbot',
          GIT_AUTHOR_EMAIL: 'djinnbot@local',
          GIT_COMMITTER_NAME: 'djinnbot',
          GIT_COMMITTER_EMAIL: 'djinnbot@local',
        },
      });
      console.log(`[WorkspaceManager] Created standalone workspace: ${runPath}`);
      return runPath;
    } catch (err: any) {
      const errorMsg = err.message || String(err);
      console.error(`[WorkspaceManager] Failed to create standalone workspace:`);
      console.error(`  - Run path: ${runPath}`);
      console.error(`  - Error: ${errorMsg}`);
      throw new Error(`Failed to create standalone workspace for run ${runId}: ${errorMsg}`);
    }
  }

  /**
   * Auto-commit after a step completes.
   */
  commitStep(runPath: string, stepId: string, agentId: string, summary: string): string | null {
    try {
      execSync('git add -A', { cwd: runPath, stdio: 'pipe' });
      const status = execSync('git status --porcelain', { cwd: runPath, encoding: 'utf8' }).trim();
      if (!status) return null;

      const message = `step/${stepId} (${agentId}): ${summary || 'completed'}`;
      execSync(`git commit -m "${message.replace(/"/g, '\\"')}"`, {
        cwd: runPath,
        stdio: 'pipe',
        env: {
          ...process.env,
          GIT_AUTHOR_NAME: agentId,
          GIT_AUTHOR_EMAIL: `${agentId}@djinnbot.local`,
          GIT_COMMITTER_NAME: 'djinnbot',
          GIT_COMMITTER_EMAIL: 'djinnbot@local',
        },
      });
      return execSync('git rev-parse HEAD', { cwd: runPath, encoding: 'utf8' }).trim();
    } catch (err) {
      console.error(`[WorkspaceManager] Commit failed:`, (err as Error).message);
      return null;
    }
  }

  cleanupRun(projectId: string, runId: string): void {
    const runPath = join(RUNS_DIR, runId);
    const projectPath = join(WORKSPACES_DIR, projectId);
    try {
      execSync(`git worktree remove "${runPath}" --force`, { cwd: projectPath, stdio: 'pipe' });
    } catch {
      try { rmSync(runPath, { recursive: true, force: true }); } catch {}
    }
    try { execSync('git worktree prune', { cwd: projectPath, stdio: 'pipe' }); } catch {}
  }

  /**
   * Push the current branch of a run workspace to the remote.
   *
   * This is the ONLY "finalization" step in the new architecture.
   * Agents work on feat/{taskId} branches; there is no automatic merge to main.
   * PRs are opened and merged by agents (or humans) via GitHub tools.
   *
   * Returns a result object so callers can log/event on push failure without
   * crashing the run — a push failure is non-fatal (work is committed locally).
   */
  async pushTaskBranch(runId: string, projectId?: string): Promise<{
    success: boolean;
    branch?: string;
    commitHash?: string;
    remoteUrl?: string;
    error?: string;
    authError?: boolean;
    noRemote?: boolean;
  }> {
    const runPath = join(RUNS_DIR, runId);

    if (!existsSync(runPath)) {
      return { success: false, error: `Run workspace not found: ${runPath}` };
    }

    try {
      // Get current branch name
      const branch = execSync('git rev-parse --abbrev-ref HEAD', {
        cwd: runPath,
        encoding: 'utf8',
        stdio: ['pipe', 'pipe', 'pipe'],
      }).trim();

      const commitHash = execSync('git rev-parse HEAD', {
        cwd: runPath,
        encoding: 'utf8',
        stdio: ['pipe', 'pipe', 'pipe'],
      }).trim();

      // Check remote exists — worktrees inherit the parent repo's remotes.
      let remoteUrl: string;
      try {
        remoteUrl = execSync('git remote get-url origin', {
          cwd: runPath,
          encoding: 'utf8',
          stdio: ['pipe', 'pipe', 'pipe'],
        }).trim();
      } catch {
        console.log(`[WorkspaceManager] pushTaskBranch: no remote origin for run ${runId} — skipping push`);
        return { success: false, branch, commitHash, noRemote: true };
      }

      // Use GitHub App token when available (preferred), fall back to env GITHUB_TOKEN.
      // fetchGitToken requires a projectId; if not provided, fall back to addCredentials.
      let authenticatedUrl: string;
      const gitToken = projectId ? await this.fetchGitToken(projectId, remoteUrl) : null;
      if (gitToken) {
        // Build authenticated URL from the token's pre-built repo URL
        authenticatedUrl = gitToken.repo_url;
      } else {
        authenticatedUrl = this.addCredentials(remoteUrl);
      }

      execSync(`git remote set-url origin "${authenticatedUrl}"`, {
        cwd: runPath,
        stdio: 'pipe',
      });

      try {
        execSync(`git push -u origin "${branch}"`, {
          cwd: runPath,
          stdio: 'pipe',
          timeout: 30000,
          env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
        });

        // Restore clean remote URL (no credentials in stored config)
        execSync(`git remote set-url origin "${remoteUrl}"`, {
          cwd: runPath,
          stdio: 'pipe',
        });

        console.log(`[WorkspaceManager] Pushed branch ${branch} for run ${runId} (${commitHash.slice(0, 8)})`);
        return { success: true, branch, commitHash, remoteUrl };

      } catch (pushErr: any) {
        // Restore clean remote URL even on failure
        try {
          execSync(`git remote set-url origin "${remoteUrl}"`, { cwd: runPath, stdio: 'pipe' });
        } catch {}

        const msg: string = pushErr.message || '';
        if (
          msg.includes('Authentication failed') ||
          msg.includes('Permission denied') ||
          msg.includes('invalid credentials') ||
          msg.includes('could not read Username')
        ) {
          return { success: false, branch, commitHash, error: 'Authentication failed — check credentials', authError: true };
        }
        if (msg.includes('Connection refused') || msg.includes('Could not resolve host') || msg.includes('timed out')) {
          return { success: false, branch, commitHash, error: 'Network error — check connection to remote' };
        }
        return { success: false, branch, commitHash, error: msg || 'Push failed' };
      }

    } catch (err: any) {
      return { success: false, error: `pushTaskBranch failed: ${err.message}` };
    }
  }

  /**
   * Finalize a run workspace after it completes:
   *   1. Push the task branch to remote (feat/{taskId} stays as a PR branch).
   *   2. Remove the worktree from the project repo.
   *
   * NO merge to main happens here. Merging is done by agents (or humans) via PRs.
   * If there is no remote, the worktree is cleaned up and work is preserved locally.
   */
  async finalizeRunWorkspace(
    runId: string,
    projectId?: string,
  ): Promise<{
    pushed: boolean;
    branch?: string;
    commitHash?: string;
    pushError?: string;
  }> {
    const runPath = join(RUNS_DIR, runId);

    if (!existsSync(runPath)) {
      console.log(`[WorkspaceManager] finalizeRunWorkspace: no workspace at ${runPath}, nothing to do`);
      return { pushed: false };
    }

    // 1. Push task branch to remote (with GitHub App token when available)
    const pushResult = await this.pushTaskBranch(runId, projectId);
    let pushed = pushResult.success;
    let pushError: string | undefined;

    if (!pushed && !pushResult.noRemote) {
      console.warn(`[WorkspaceManager] Push failed for run ${runId}: ${pushResult.error}`);
      pushError = pushResult.error;
    }

    // 2. Remove the worktree
    if (projectId) {
      this.cleanupRun(projectId, runId);
    } else {
      try { rmSync(runPath, { recursive: true, force: true }); } catch {}
    }

    return {
      pushed,
      branch: pushResult.branch,
      commitHash: pushResult.commitHash,
      pushError,
    };
  }

  getRunPath(runId: string): string | null {
    const runPath = join(RUNS_DIR, runId);
    return existsSync(runPath) ? runPath : null;
  }

  /**
   * Return a compact git context string for injection into agent prompts.
   * Includes: current branch, base branch, and the last N step-commit summaries.
   * Returns empty string if the path is not a git repo or git is unavailable.
   */
  getWorkspaceGitContext(runId: string, maxCommits: number = 10): string {
    const runPath = join(RUNS_DIR, runId);
    if (!existsSync(join(runPath, '.git'))) return '';

    try {
      const branch = execSync('git rev-parse --abbrev-ref HEAD', {
        cwd: runPath, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'],
      }).trim();

      // Detect the base branch (the branch this worktree was cut from).
      // git worktree branches follow "run/{runId}" — the base is typically main.
      let baseBranch = 'main';
      try {
        // Try to find the merge-base parent branch name via common-dir
        const commonDir = execSync('git rev-parse --git-common-dir', {
          cwd: runPath, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'],
        }).trim();
        if (commonDir && commonDir !== '.git') {
          // This is a worktree — list branches in the parent repo to find HEAD
          const parentDir = commonDir.replace(/[/\\]\.git$/, '');
          const parentHead = execSync('git rev-parse --abbrev-ref HEAD', {
            cwd: parentDir, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'],
          }).trim();
          baseBranch = parentHead || 'main';
        }
      } catch { /* non-fatal */ }

      // Collect the last N commits on this branch that are not in the base
      let recentCommits = '';
      try {
        recentCommits = execSync(
          `git log --oneline -${maxCommits} "${branch}" --not "${baseBranch}" --`,
          { cwd: runPath, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] }
        ).trim();
      } catch { /* non-fatal — branch may not diverge yet */ }

      const lines: string[] = [
        `## Workspace Git Context`,
        `- **Branch**: \`${branch}\`  (base: \`${baseBranch}\`)`,
        `- **Working directory**: \`/home/agent/run-workspace\``,
        `- **Project repo** (read-only reference): \`/home/agent/project-workspace\``,
      ];

      if (recentCommits) {
        lines.push('');
        lines.push('### Commits on this run branch (newest first)');
        lines.push('```');
        lines.push(recentCommits);
        lines.push('```');
        lines.push('');
        lines.push('_These commits represent work already done in earlier steps of this pipeline run._');
      } else {
        lines.push('- **Prior commits on this branch**: none yet');
      }

      return lines.join('\n');
    } catch {
      return '';
    }
  }

  /**
   * Watch a workspace directory for file changes.
   * Returns a cleanup function to stop watching.
   */
  watchWorkspace(
    runPath: string,
    onChange: (path: string, action: 'create' | 'modify' | 'delete') => void
  ): () => void {
    const debounceMap = new Map<string, ReturnType<typeof setTimeout>>();

    const watcher = watch(runPath, { recursive: true }, (eventType: string, filename: string | null) => {
      if (!filename) return;
      
      // Filter out noisy paths
      if (this.shouldIgnoreFile(filename)) return;

      // Debounce rapid changes to same file (increased from 100ms to 300ms)
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

  /**
   * Check if a file path should be ignored by the watcher.
   * Filters out noisy directories and files that agents typically don't need to track.
   */
  private shouldIgnoreFile(filePath: string): boolean {
    const ignoredPatterns = [
      // Version control
      '.git/',
      '.git',
      
      // Dependencies
      'node_modules/',
      '__pycache__/',
      '.venv/',
      'venv/',
      'vendor/',
      
      // Build outputs
      'dist/',
      'build/',
      '.next/',
      '.turbo/',
      'out/',
      'target/',
      
      // Cache directories
      '.cache/',
      '.pytest_cache/',
      '.mypy_cache/',
      '.ruff_cache/',
      '__pypackages__/',
      
      // Lock files (too noisy, change frequently)
      'package-lock.json',
      'yarn.lock',
      'pnpm-lock.yaml',
      'poetry.lock',
      'Pipfile.lock',
      'Cargo.lock',
      
      // OS files
      '.DS_Store',
      'Thumbs.db',
      'desktop.ini',
      
      // Editor/IDE
      '.vscode/',
      '.idea/',
      '*.swp',
      '*.swo',
      '*~',
      
      // DjinnBot internal
      '.djinnbot/',
      
      // Compiled files
      '*.pyc',
      '*.pyo',
      '*.pyd',
      '*.so',
      '*.dll',
      '*.dylib',
      '*.class',
      '*.o',
    ];

    const normalizedPath = filePath.replace(/\\/g, '/');

    return ignoredPatterns.some(pattern => {
      if (pattern.endsWith('/')) {
        // Directory pattern - check if path starts with or contains this directory
        return normalizedPath.startsWith(pattern) || normalizedPath.includes(`/${pattern}`);
      } else if (pattern.startsWith('*.')) {
        // Extension pattern - check if file ends with this extension
        return normalizedPath.endsWith(pattern.slice(1));
      } else if (pattern.includes('*')) {
        // Wildcard pattern - convert to regex
        const regex = new RegExp('^' + pattern.replace(/\*/g, '.*').replace(/\./g, '\\.') + '$');
        return regex.test(normalizedPath);
      } else {
        // Exact match or path component match
        return normalizedPath === pattern || 
               normalizedPath.endsWith(`/${pattern}`) ||
               normalizedPath.includes(`/${pattern}/`);
      }
    });
  }

  /**
   * Create a persistent task worktree inside an agent's sandbox home directory.
   *
   * This is used for PULSE sessions. Pipeline runs use createRunWorktreeAsync()
   * which creates an ephemeral worktree in RUNS_DIR. Pulse agents need a worktree
   * that persists across wake-ups so they can return to in-progress work.
   *
   * Path: SANDBOXES_DIR/{agentId}/task-workspaces/{taskId}/
   * Inside container: /home/agent/task-workspaces/{taskId}/
   *
   * The worktree is created on feat/{taskId} (taskBranch). If the branch already
   * exists remotely (another agent or pipeline run has pushed to it), it is
   * fetched and checked out. Otherwise a new branch is created from main.
   *
   * The project repo at WORKSPACES_DIR/{projectId} must already exist (ensured
   * by ensureProjectAsync before this is called).
   */
  async createTaskWorktree(
    agentId: string,
    projectId: string,
    taskId: string,
    taskBranch: string,
  ): Promise<{ worktreePath: string; branch: string; alreadyExists: boolean }> {
    const projectPath = await this.ensureProjectAsync(projectId);
    const worktreePath = join(SANDBOXES_DIR, agentId, 'task-workspaces', taskId);

    // Already exists and is a valid worktree — idempotent
    if (existsSync(worktreePath)) {
      const gitFile = join(worktreePath, '.git');
      if (existsSync(gitFile) && !statSync(gitFile).isDirectory()) {
        console.log(`[WorkspaceManager] Task worktree already exists for ${agentId}/${taskId}`);
        return { worktreePath, branch: taskBranch, alreadyExists: true };
      }
      // Corrupted — remove and recreate
      console.warn(`[WorkspaceManager] Removing corrupted task worktree for ${agentId}/${taskId}`);
      try { rmSync(worktreePath, { recursive: true, force: true }); } catch {}
    }

    mkdirSync(join(SANDBOXES_DIR, agentId, 'task-workspaces'), { recursive: true });

    // Pull latest from remote so we have the branch if it was pushed by another agent/pipeline
    try {
      let remoteUrl: string | undefined;
      try {
        remoteUrl = execSync('git remote get-url origin', { cwd: projectPath, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] }).trim();
      } catch { /* no remote */ }
      const gitToken = await this.fetchGitToken(projectId, remoteUrl);
      if (gitToken) {
        const originalUrl = execSync('git remote get-url origin', {
          cwd: projectPath, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'],
        }).trim();
        try {
          execSync(`git remote set-url origin "${gitToken.repo_url}"`, { cwd: projectPath, stdio: 'pipe' });
          execSync('git fetch --prune origin', { cwd: projectPath, stdio: 'pipe' });
        } finally {
          execSync(`git remote set-url origin "${originalUrl}"`, { cwd: projectPath, stdio: 'pipe' });
        }
      } else {
        execSync('git fetch --prune origin 2>/dev/null || true', { cwd: projectPath, stdio: 'pipe' });
      }
    } catch {
      // Non-fatal — we'll work with whatever is local
    }

    // Prune stale worktree refs
    try { execSync('git worktree prune', { cwd: projectPath, stdio: 'pipe' }); } catch {}

    // Does the branch exist locally or remotely?
    const localExists = execSync(`git branch --list "${taskBranch}"`, {
      cwd: projectPath, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'],
    }).trim().length > 0;

    const remoteExists = (() => {
      try {
        execSync(`git rev-parse --verify "origin/${taskBranch}"`, {
          cwd: projectPath, stdio: ['pipe', 'pipe', 'pipe'],
        });
        return true;
      } catch { return false; }
    })();

    if (localExists || remoteExists) {
      // Branch exists — if only remote, create local tracking branch first
      if (!localExists && remoteExists) {
        execSync(`git branch "${taskBranch}" "origin/${taskBranch}"`, { cwd: projectPath, stdio: 'pipe' });
      }
      execSync(`git worktree add "${worktreePath}" "${taskBranch}"`, { cwd: projectPath, stdio: 'pipe' });
      console.log(`[WorkspaceManager] Created task worktree at ${worktreePath} (existing branch: ${taskBranch})`);
    } else {
      // Branch doesn't exist anywhere — create it from main
      execSync(`git worktree add "${worktreePath}" -b "${taskBranch}"`, { cwd: projectPath, stdio: 'pipe' });
      console.log(`[WorkspaceManager] Created task worktree at ${worktreePath} (new branch: ${taskBranch})`);
    }

    return { worktreePath, branch: taskBranch, alreadyExists: false };
  }

  /**
   * Remove a task worktree from an agent's sandbox when work is complete
   * (typically after a PR is merged or the task is closed).
   *
   * Leaves the feat/{taskId} branch intact in the project repo — it was already
   * pushed to remote and is the PR branch. GitHub will delete it after merge
   * if the repo has "delete branch on merge" enabled.
   */
  removeTaskWorktree(agentId: string, projectId: string, taskId: string): void {
    const worktreePath = join(SANDBOXES_DIR, agentId, 'task-workspaces', taskId);
    const projectPath = join(WORKSPACES_DIR, projectId);

    if (!existsSync(worktreePath)) {
      console.log(`[WorkspaceManager] removeTaskWorktree: ${worktreePath} does not exist, nothing to do`);
      return;
    }

    try {
      execSync(`git worktree remove "${worktreePath}" --force`, { cwd: projectPath, stdio: 'pipe' });
    } catch {
      try { rmSync(worktreePath, { recursive: true, force: true }); } catch {}
    }

    try { execSync('git worktree prune', { cwd: projectPath, stdio: 'pipe' }); } catch {}
    console.log(`[WorkspaceManager] Removed task worktree for ${agentId}/${taskId}`);
  }

  private addCredentials(repoUrl: string): string {
    const token = process.env.GITHUB_TOKEN;
    const user = process.env.GITHUB_USER || 'djinnbot';
    if (token && repoUrl.startsWith('https://')) {
      return repoUrl.replace('https://', `https://${user}:${token}@`);
    }
    return repoUrl;
  }

}

