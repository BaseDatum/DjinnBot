// ── Project ──────────────────────────────────────────────────────────────

export type ProjectStatus = 'active' | 'paused' | 'completed' | 'archived';

export interface Project {
  id: string;
  name: string;
  description: string;
  status: ProjectStatus;
  repository: string | null;       // optional git repo path
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
  taskStatuses: TaskStatus[];     // which task statuses map to this column
}

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

// ── Tasks ────────────────────────────────────────────────────────────────

export type TaskStatus = 'backlog' | 'planning' | 'ready' | 'in_progress' | 'review' | 'blocked' | 'done' | 'failed';
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
