// ── Project Templates ────────────────────────────────────────────────────

export interface StatusSemantics {
  /** Where new tasks land */
  initial: string[];
  /** Dependency resolution: "all deps done" */
  terminal_done: string[];
  /** Cascade blocking trigger */
  terminal_fail: string[];
  /** Where blocked tasks are moved */
  blocked: string[];
  /** Active work (agent concurrency checks) */
  in_progress: string[];
  /** Agents can claim these */
  claimable: string[];
}

export interface ProjectTemplate {
  id: string;
  slug: string;
  name: string;
  description: string;
  icon: string | null;
  isBuiltin: boolean;
  columns: Array<{
    name: string;
    position: number;
    wip_limit: number | null;
    statuses: string[];
  }>;
  statusSemantics: StatusSemantics;
  defaultPipelineId: string | null;
  onboardingAgentChain: string[] | null;
  metadata: Record<string, any>;
  sortOrder: number;
  createdAt: number;
  updatedAt: number;
}

// ── Project ──────────────────────────────────────────────────────────────

export type ProjectStatus = 'active' | 'paused' | 'completed' | 'archived';

export interface Project {
  id: string;
  name: string;
  description: string;
  status: ProjectStatus;
  repository: string | null;       // optional git repo path
  vision: string | null;           // living markdown document — project goals/architecture/priorities
  templateId: string | null;       // template this project was created from
  statusSemantics: StatusSemantics | null; // dynamic status semantics (null = legacy fallback)
  createdAt: number;
  updatedAt: number;
  completedAt: number | null;
}

// ── Kanban Columns ───────────────────────────────────────────────────────

export interface KanbanColumn {
  id: string;
  projectId: string;
  name: string;
  position: number;               // sort order
  wipLimit: number | null;        // max tasks in this column, null = unlimited
  taskStatuses: string[];         // which task statuses map to this column (dynamic, not hardcoded)
}

/**
 * @deprecated Use project templates instead. Kept for backward compatibility.
 * These match the "software-dev" built-in template.
 */
export const DEFAULT_COLUMNS: Omit<KanbanColumn, 'id' | 'projectId'>[] = [
  { name: 'Backlog',     position: 0, wipLimit: null, taskStatuses: ['backlog'] },
  { name: 'Planning',    position: 1, wipLimit: null, taskStatuses: ['planning'] },
  { name: 'Blocked',     position: 2, wipLimit: null, taskStatuses: ['blocked'] },
  { name: 'Ready',       position: 3, wipLimit: null, taskStatuses: ['ready'] },
  { name: 'In Progress', position: 4, wipLimit: 5,    taskStatuses: ['in_progress'] },
  { name: 'Review',      position: 5, wipLimit: null, taskStatuses: ['review'] },
  { name: 'Done',        position: 6, wipLimit: null, taskStatuses: ['done'] },
  { name: 'Failed',      position: 7, wipLimit: null, taskStatuses: ['failed'] },
];

/** Default status semantics for the software-dev template (legacy fallback). */
export const DEFAULT_STATUS_SEMANTICS: StatusSemantics = {
  initial: ['backlog'],
  terminal_done: ['done'],
  terminal_fail: ['failed'],
  blocked: ['blocked'],
  in_progress: ['in_progress'],
  claimable: ['backlog', 'planning', 'planned', 'ux', 'ready', 'test', 'failed'],
};

// ── Tasks ────────────────────────────────────────────────────────────────

/**
 * Task status is now a dynamic string — validated against the project's
 * column definitions at runtime, not at the type level.
 *
 * For software-dev projects, common statuses include:
 * 'backlog' | 'planning' | 'ready' | 'in_progress' | 'review' | 'blocked' | 'done' | 'failed'
 *
 * Custom templates can define any status strings.
 */
export type TaskStatus = string;
export type TaskPriority = 'P0' | 'P1' | 'P2' | 'P3';
export type DependencyType = 'blocks' | 'informs';  // hard vs soft

export interface Task {
  id: string;
  projectId: string;
  title: string;
  description: string;
  status: TaskStatus;
  priority: TaskPriority;
  assignedAgent: string | null;
  workflowId: string | null;      // which ProjectWorkflow to use
  pipelineId: string | null;      // resolved pipeline ID (from workflow)
  runId: string | null;           // current active run
  parentTaskId: string | null;    // for sub-task decomposition
  tags: string[];
  estimatedHours: number | null;
  columnId: string;               // current kanban column
  columnPosition: number;         // position within column
  metadata: Record<string, any>;  // git branch, PR link, etc.
  createdAt: number;
  updatedAt: number;
  completedAt: number | null;
}

export interface TaskRunReference {
  runId: string;
  pipelineId: string;
  status: string;
  startedAt: number;
  completedAt: number | null;
}

// ── Dependencies ─────────────────────────────────────────────────────────

export interface DependencyEdge {
  id: string;
  projectId: string;
  fromTaskId: string;             // must finish first
  toTaskId: string;               // blocked until `from` completes
  type: DependencyType;
}

// ── Project Workflows ────────────────────────────────────────────────────

export type WorkflowTrigger = 'manual' | 'auto';

export interface ProjectWorkflow {
  id: string;
  projectId: string;
  name: string;
  pipelineId: string;
  isDefault: boolean;
  taskFilter: {
    tags?: string[];
    priorities?: TaskPriority[];
  };
  trigger: WorkflowTrigger;
}

// ── Helper: resolve status semantics ─────────────────────────────────────

/**
 * Get the status semantics for a project, falling back to defaults.
 */
export function getStatusSemantics(project: Pick<Project, 'statusSemantics'>): StatusSemantics {
  return project.statusSemantics ?? DEFAULT_STATUS_SEMANTICS;
}

/**
 * Check if a status is a terminal "done" status for the project.
 */
export function isTerminalDone(status: string, semantics: StatusSemantics): boolean {
  return semantics.terminal_done.includes(status);
}

/**
 * Check if a status is a terminal "fail" status for the project.
 */
export function isTerminalFail(status: string, semantics: StatusSemantics): boolean {
  return semantics.terminal_fail.includes(status);
}
