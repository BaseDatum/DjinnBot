export interface Column {
  id: string;
  name: string;
  position: number;
  wip_limit: number | null;
  task_statuses: string[];
}

export interface Task {
  id: string;
  title: string;
  description: string;
  status: string;
  priority: string;
  assigned_agent: string | null;
  tags: string[];
  column_id: string;
  column_position: number;
  run_id: string | null;
  estimated_hours: number | null;
  parent_task_id: string | null;
  metadata: Record<string, any>;
}

export interface Dependency {
  id: string;
  from_task_id: string;
  to_task_id: string;
  type: string;
}

export interface TaskDetail extends Task {
  blocking_dependencies: {
    id: string;
    from_task_id: string;
    from_task_title: string;
    from_task_status: string;
    type: string;
  }[];
  dependents: {
    id: string;
    to_task_id: string;
    to_task_title: string;
    to_task_status: string;
    type: string;
  }[];
  subtasks: {
    id: string;
    title: string;
    status: string;
  }[];
  run_history: {
    run_id: string;
    status: string;
    started_at: number | null;
  }[];
}

export interface Workflow {
  id: string;
  name: string;
  pipeline_id: string;
  is_default: boolean;
  task_filter: Record<string, unknown>;
  trigger: string | null;
}

export interface Pipeline {
  id: string;
  name: string;
  description?: string;
}

export interface StatusSemantics {
  initial: string[];
  terminal_done: string[];
  terminal_fail: string[];
  blocked: string[];
  in_progress: string[];
  claimable: string[];
}

export interface Project {
  id: string;
  name: string;
  description?: string;
  status: string;
  repository?: string;
  default_pipeline_id?: string;
  slack_channel_id?: string;
  slack_notify_user_id?: string;
  key_user_id?: string;
  vision?: string;
  template_id?: string | null;
  status_semantics?: StatusSemantics | null;
  columns: Column[];
  tasks: Task[];
  dependencies: Dependency[];
  workflows: Workflow[];
  created_at: number;
  updated_at: number;
}

export interface GraphData {
  nodes: {
    id: string;
    title: string;
    status: string;
    priority: string;
    assigned_agent: string | null;
    estimated_hours: number | null;
  }[];
  edges: {
    id: string;
    from_task_id: string;
    to_task_id: string;
    type: string;
  }[];
  critical_path: string[];
  topological_order: string[];
}

export interface TimelineData {
  tasks: {
    id: string;
    title: string;
    status: string;
    priority: string;
    assigned_agent: string | null;
    tags: string[];
    estimated_hours: number | null;
    dependencies: string[];
    scheduled_start: number;
    scheduled_end: number;
    duration_days: number;
    actual: boolean;
    is_critical: boolean;
  }[];
  project_start: number;
  project_end: number;
  total_hours: number;
  total_days: number;
  critical_path: string[];
  hours_per_day: number;
}

export interface SSEEvent {
  type: string;
  projectId?: string;
  runId?: string;
  [key: string]: unknown;
}

export interface RepositoryInfo {
  url: string;
  accessible: boolean;
  defaultBranch?: string;
  latestCommit?: string;
  branches?: Array<{ name: string; commit: string }>;
  error?: string;
}

export interface RepositoryStatus {
  configured: boolean;
  accessible: boolean;
  lastChecked?: number;
  error?: string;
}
