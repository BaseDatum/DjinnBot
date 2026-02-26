// API URL resolution (runtime → build-time → relative fallback):
//
// 1. Runtime config: window.__RUNTIME_CONFIG__.API_URL
//    Set by entrypoint.sh at container startup from the VITE_API_URL env var.
//    Allows changing the API URL without rebuilding the image — just restart
//    the container with a new VITE_API_URL value.
//
// 2. Build-time config: __API_URL__
//    Baked in by Vite from VITE_API_URL at `npm run build` / `docker build`.
//    Used as fallback for local dev or when runtime config isn't set.
//
// 3. Empty string → relative paths, proxied by nginx/Traefik.
//
// The /v1 path prefix is appended here; callers never include it.

/** Resolve the API origin, preferring runtime config over build-time. */
function resolveApiUrl(): string {
  // Runtime config takes precedence (set at container startup, no rebuild needed)
  const runtimeUrl =
    typeof window !== 'undefined' &&
    (window as any).__RUNTIME_CONFIG__?.API_URL;
  if (runtimeUrl) return runtimeUrl;

  // Fall back to build-time value (baked in by Vite)
  return __API_URL__;
}

const _resolvedApiUrl = resolveApiUrl();

export const API_BASE = `${_resolvedApiUrl}/v1`;

/**
 * Convert an API base URL (http/https) to a WebSocket base URL (ws/wss).
 * When API_BASE is relative (empty URL) we fall back to window.location.host.
 */
export function wsBase(): string {
  if (_resolvedApiUrl) {
    return _resolvedApiUrl.replace(/^http/, 'ws');
  }
  const protocol = window.location.protocol === 'https:' ? 'wss' : 'ws';
  return `${protocol}://${window.location.host}`;
}

// Import shared types for use in this file
import type {
  AgentState,
  AgentLifecycle,
  WorkInfo,
  PulseStatus,
  LifecycleData,
  TimelineEventData,
  ResourceUsage,
  LifecycleResponse,
  TimelineEventType,
  TimelineEvent,
  ActivityResponse,
} from '@/types/lifecycle';

import type {
  MessageType,
  MessagePriority,
  AgentMessage,
  InboxFilter,
  InboxResponse,
  SendMessageRequest,
  SendMessageResponse,
  MarkReadResponse,
  ClearInboxResponse,
} from '@/types/inbox';

import type {
  SandboxConfig,
  LifecycleConfig,
  PulseChecks,
  PulseConfig,
  MessagingConfig,
  AgentConfig,
} from '@/types/config';

import { SANDBOX_LIMITS } from '@/types/config';

import type {
  FileEntry,
  InstalledTool,
  DiskUsage,
  SandboxOverview,
  FileContent,
  SandboxInfo,
  SandboxFileContent,
  FileTree,
  ResetSandboxResponse,
} from '@/types/sandbox';

// Re-export types for consumers of this module
export type {
  AgentState,
  AgentLifecycle,
  WorkInfo,
  PulseStatus,
  LifecycleData,
  TimelineEventData,
  ResourceUsage,
  LifecycleResponse,
  TimelineEventType,
  TimelineEvent,
  ActivityResponse,
  MessageType,
  MessagePriority,
  AgentMessage,
  InboxFilter,
  InboxResponse,
  SendMessageRequest,
  SendMessageResponse,
  MarkReadResponse,
  ClearInboxResponse,
  SandboxConfig,
  LifecycleConfig,
  PulseChecks,
  PulseConfig,
  MessagingConfig,
  AgentConfig,
  FileEntry,
  InstalledTool,
  DiskUsage,
  SandboxOverview,
  FileContent,
};

export { SANDBOX_LIMITS, ResetSandboxResponse };

import { authFetch } from '@/lib/auth';

async function handleResponse(res: Response, fallbackMessage: string): Promise<any> {
  if (!res.ok) {
    const body = await res.json().catch(() => ({ detail: fallbackMessage }));
    throw new Error(body.detail || `${fallbackMessage} (${res.status})`);
  }
  return res.json();
}

export async function fetchStatus() {
  const res = await authFetch(`${API_BASE}/status`);
  return handleResponse(res, 'Failed to fetch status');
}

export async function fetchRuns(params?: { pipeline_id?: string; status?: string }): Promise<any> {
  const searchParams = new URLSearchParams();
  if (params?.pipeline_id) searchParams.set('pipeline_id', params.pipeline_id);
  if (params?.status) searchParams.set('status', params.status);
  const query = searchParams.toString();
  const res = await authFetch(`${API_BASE}/runs/${query ? '?' + query : ''}`);
  return handleResponse(res, 'Failed to fetch runs');
}

export async function fetchSwarms(): Promise<any> {
  const res = await authFetch(`${API_BASE}/internal/swarms`);
  return handleResponse(res, 'Failed to fetch swarms');
}

export interface SwarmTaskDef {
  key: string;
  title: string;
  project_id: string;
  task_id: string;
  execution_prompt: string;
  dependencies: string[];
  model?: string;
  timeout_seconds?: number;
}

export interface StartSwarmRequest {
  agent_id: string;
  tasks: SwarmTaskDef[];
  max_concurrent?: number;
  deviation_rules?: string;
  global_timeout_seconds?: number;
}

export async function startSwarm(req: StartSwarmRequest): Promise<{
  swarm_id: string;
  status: string;
  total_tasks: number;
  max_concurrent: number;
  root_tasks: string[];
  max_depth: number;
  progress_channel: string;
}> {
  const res = await authFetch(`${API_BASE}/internal/swarm-execute`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(req),
  });
  return handleResponse(res, 'Failed to start swarm');
}

export async function fetchRun(runId: string) {
  const res = await authFetch(`${API_BASE}/runs/${runId}`);
  return handleResponse(res, 'Failed to fetch run');
}

export async function fetchRunLogs(runId: string): Promise<any[]> {
  const res = await authFetch(`${API_BASE}/runs/${runId}/logs`);
  return handleResponse(res, 'Failed to fetch run logs');
}

export async function fetchPipelines() {
  const res = await authFetch(`${API_BASE}/pipelines/`);
  return handleResponse(res, 'Failed to fetch pipelines');
}

export async function fetchPipelineRaw(pipelineId: string): Promise<{ pipeline_id: string; yaml: string; file: string }> {
  const res = await authFetch(`${API_BASE}/pipelines/${pipelineId}/raw`);
  return handleResponse(res, 'Failed to fetch pipeline YAML');
}

export async function updatePipeline(pipelineId: string, yamlContent: string) {
  const res = await authFetch(`${API_BASE}/pipelines/${pipelineId}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ yaml_content: yamlContent }),
  });
  return handleResponse(res, 'Failed to update pipeline');
}

export async function validatePipeline(pipelineId: string) {
  const res = await authFetch(`${API_BASE}/pipelines/${pipelineId}/validate`, { method: 'POST' });
  return handleResponse(res, 'Failed to validate pipeline');
}

export async function startRun(pipelineId: string, task: string, context?: string, projectId?: string) {
  const body: Record<string, unknown> = { pipeline_id: pipelineId, task };
  if (context) body.context = context;
  if (projectId) body.project_id = projectId;
  const res = await authFetch(`${API_BASE}/runs/`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  return handleResponse(res, 'Failed to start run');
}

export async function cancelRun(runId: string) {
  const res = await authFetch(`${API_BASE}/runs/${runId}/cancel`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
  });
  if (!res.ok) throw new Error('Failed to cancel run');
  return res.json();
}

export async function restartRun(runId: string, context?: string) {
  const res = await authFetch(`${API_BASE}/runs/${runId}/restart`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ context: context || null }),
  });
  if (!res.ok) throw new Error('Failed to restart run');
  return res.json();
}

export interface AgentListItem {
  id: string;
  name: string;
  emoji: string | null;
  role: string | null;
  pulse_enabled?: boolean;
  /** Agent's configured working model from config.yml (e.g. "anthropic/claude-sonnet-4"). */
  model?: string | null;
}

export async function fetchAgents(): Promise<AgentListItem[]> {
  const res = await authFetch(`${API_BASE}/agents/`);
  const data = await handleResponse(res, 'Failed to fetch agents');
  return Array.isArray(data) ? data : data.agents || [];
}

export async function fetchAgent(agentId: string) {
  const res = await authFetch(`${API_BASE}/agents/${agentId}`);
  return handleResponse(res, 'Failed to fetch agent');
}

export interface MemorySearchResult {
  agent_id: string;
  filename: string;
  snippet: string;
  score: number;
}

export async function searchMemory(query: string, agentId?: string, limit: number = 20): Promise<MemorySearchResult[]> {
  const params = new URLSearchParams({ q: query, limit: String(limit) });
  if (agentId) params.set('agent_id', agentId);
  const res = await authFetch(`${API_BASE}/memory/search?${params}`);
  return handleResponse(res, 'Failed to search memories');
}

export async function fetchAgentMemory(agentId: string) {
  const res = await authFetch(`${API_BASE}/agents/${agentId}/memory`);
  return handleResponse(res, 'Failed to fetch agent memory');
}

export async function fetchMemoryFile(agentId: string, filename: string) {
  const encodedPath = filename.split('/').map(encodeURIComponent).join('/');
  const res = await authFetch(`${API_BASE}/memory/vaults/${agentId}/${encodedPath}`);
  return handleResponse(res, 'Failed to fetch memory file');
}

export async function updateMemoryFile(agentId: string, filename: string, content: string) {
  const encodedPath = filename.split('/').map(encodeURIComponent).join('/');
  const res = await authFetch(`${API_BASE}/memory/vaults/${agentId}/${encodedPath}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ content }),
  });
  return handleResponse(res, 'Failed to update memory file');
}

export async function createMemoryFile(agentId: string, content: string, filename: string) {
  const res = await authFetch(`${API_BASE}/memory/vaults/${agentId}/files`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ content, filename }),
  });
  return handleResponse(res, 'Failed to create memory file');
}

export async function restartStep(runId: string, stepId: string, context?: string) {
  const res = await authFetch(`${API_BASE}/runs/${runId}/steps/${stepId}/restart`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ context: context || null }),
  });
  return handleResponse(res, 'Failed to restart step');
}

export async function updateAgentFile(agentId: string, filename: string, content: string) {
  const res = await authFetch(`${API_BASE}/agents/${agentId}/files/${encodeURIComponent(filename)}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ content }),
  });
  return handleResponse(res, 'Failed to update file');
}

// ── Project API ──────────────────────────────────────────────────────────

export async function fetchProjects(status?: string) {
  const query = status ? `?status=${status}` : '';
  const res = await authFetch(`${API_BASE}/projects/${query}`);
  return handleResponse(res, 'Failed to fetch projects');
}

export async function fetchProject(projectId: string) {
  const res = await authFetch(`${API_BASE}/projects/${projectId}`);
  return handleResponse(res, 'Failed to fetch project');
}

export async function createProject(data: { name: string; description?: string; repository?: string; templateId?: string; columns?: any[]; statusSemantics?: any }) {
  const res = await authFetch(`${API_BASE}/projects/`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(data),
  });
  return handleResponse(res, 'Failed to create project');
}

export async function updateProject(projectId: string, data: Record<string, any>) {
  const res = await authFetch(`${API_BASE}/projects/${projectId}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(data),
  });
  return handleResponse(res, 'Failed to update project');
}

export async function deleteProject(projectId: string) {
  const res = await authFetch(`${API_BASE}/projects/${projectId}`, { method: 'DELETE' });
  return handleResponse(res, 'Failed to delete project');
}

export async function archiveProject(projectId: string) {
  const res = await authFetch(`${API_BASE}/projects/${projectId}/archive`, { method: 'POST' });
  return handleResponse(res, 'Failed to archive project');
}

export async function fetchProjectTasks(projectId: string, filters?: { status?: string; priority?: string; agent?: string; tag?: string }) {
  const params = new URLSearchParams();
  if (filters?.status) params.set('status', filters.status);
  if (filters?.priority) params.set('priority', filters.priority);
  if (filters?.agent) params.set('agent', filters.agent);
  if (filters?.tag) params.set('tag', filters.tag);
  const query = params.toString();
  const res = await authFetch(`${API_BASE}/projects/${projectId}/tasks${query ? '?' + query : ''}`);
  return handleResponse(res, 'Failed to fetch tasks');
}

export async function fetchTask(projectId: string, taskId: string) {
  const res = await authFetch(`${API_BASE}/projects/${projectId}/tasks/${taskId}`);
  return handleResponse(res, 'Failed to fetch task');
}

export async function createTask(projectId: string, data: {
  title: string;
  description?: string;
  priority?: string;
  assignedAgent?: string;
  workflowId?: string;
  parentTaskId?: string;
  tags?: string[];
  estimatedHours?: number;
  columnId?: string;
}) {
  const res = await authFetch(`${API_BASE}/projects/${projectId}/tasks`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(data),
  });
  return handleResponse(res, 'Failed to create task');
}

export async function updateTask(projectId: string, taskId: string, data: Record<string, any>) {
  const res = await authFetch(`${API_BASE}/projects/${projectId}/tasks/${taskId}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(data),
  });
  return handleResponse(res, 'Failed to update task');
}

export async function deleteTask(projectId: string, taskId: string) {
  const res = await authFetch(`${API_BASE}/projects/${projectId}/tasks/${taskId}`, { method: 'DELETE' });
  return handleResponse(res, 'Failed to delete task');
}

export async function moveTask(projectId: string, taskId: string, columnId: string, position: number = 0) {
  const res = await authFetch(`${API_BASE}/projects/${projectId}/tasks/${taskId}/move`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ columnId, position }),
  });
  return handleResponse(res, 'Failed to move task');
}

export async function addDependency(projectId: string, taskId: string, fromTaskId: string, type: string = 'blocks') {
  const res = await authFetch(`${API_BASE}/projects/${projectId}/tasks/${taskId}/dependencies`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ fromTaskId, type }),
  });
  return handleResponse(res, 'Failed to add dependency');
}

export async function removeDependency(projectId: string, taskId: string, depId: string) {
  const res = await authFetch(`${API_BASE}/projects/${projectId}/tasks/${taskId}/dependencies/${depId}`, { method: 'DELETE' });
  return handleResponse(res, 'Failed to remove dependency');
}

export async function fetchDependencyGraph(projectId: string) {
  const res = await authFetch(`${API_BASE}/projects/${projectId}/dependency-graph`);
  return handleResponse(res, 'Failed to fetch dependency graph');
}

export async function fetchWorkflows(projectId: string) {
  const res = await authFetch(`${API_BASE}/projects/${projectId}/workflows`);
  return handleResponse(res, 'Failed to fetch workflows');
}

export async function createWorkflow(projectId: string, data: {
  name: string;
  pipelineId: string;
  isDefault?: boolean;
  taskFilter?: Record<string, any>;
  trigger?: string;
}) {
  const res = await authFetch(`${API_BASE}/projects/${projectId}/workflows`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(data),
  });
  return handleResponse(res, 'Failed to create workflow');
}

export async function updateWorkflow(projectId: string, workflowId: string, data: {
  name?: string;
  pipelineId?: string;
  isDefault?: boolean;
  taskFilter?: Record<string, any>;
  trigger?: string;
}) {
  const res = await authFetch(`${API_BASE}/projects/${projectId}/workflows/${workflowId}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(data),
  });
  return handleResponse(res, 'Failed to update workflow');
}

export async function importTasks(projectId: string, tasks: any[]) {
  const res = await authFetch(`${API_BASE}/projects/${projectId}/import`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ tasks }),
  });
  return handleResponse(res, 'Import failed');
}

export async function executeTask(projectId: string, taskId: string, data?: { workflowId?: string; pipelineId?: string; context?: string; modelOverride?: string; keyUserId?: string }) {
  const res = await authFetch(`${API_BASE}/projects/${projectId}/tasks/${taskId}/execute`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(data || {}),
  });
  return handleResponse(res, 'Failed to execute task');
}

export async function executeTaskWithAgent(
  projectId: string,
  taskId: string,
  data: { agentId: string; modelOverride?: string; keyUserId?: string },
): Promise<{ status: string; task_id: string; run_id: string; agent_id: string; pipeline_id: string }> {
  const res = await authFetch(`${API_BASE}/projects/${projectId}/tasks/${taskId}/execute-agent`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(data),
  });
  return handleResponse(res, 'Failed to execute task with agent');
}

export async function executeReadyTasks(projectId: string, maxTasks: number = 5) {
  const res = await authFetch(`${API_BASE}/projects/${projectId}/execute-ready?max_tasks=${maxTasks}`, {
    method: 'POST',
  });
  return handleResponse(res, 'Failed to execute ready tasks');
}

export async function fetchReadyTasks(projectId: string) {
  const res = await authFetch(`${API_BASE}/projects/${projectId}/ready-tasks`);
  return handleResponse(res, 'Failed to fetch ready tasks');
}

export async function planProject(projectId: string, data?: { pipelineId?: string; context?: string }) {
  const res = await authFetch(`${API_BASE}/projects/${projectId}/plan`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(data || {}),
  });
  return handleResponse(res, 'Failed to start planning');
}

export async function fetchTimeline(projectId: string, hoursPerDay: number = 8) {
  const res = await authFetch(`${API_BASE}/projects/${projectId}/timeline?hours_per_day=${hoursPerDay}`);
  return handleResponse(res, 'Failed to fetch timeline');
}

// ── Run deletion ─────────────────────────────────────────────────────────

export async function deleteRun(runId: string) {
  const res = await authFetch(`${API_BASE}/runs/${runId}`, { method: 'DELETE' });
  return handleResponse(res, 'Failed to delete run');
}

export async function bulkDeleteRuns(params: { status?: string; before?: number }) {
  const query = new URLSearchParams();
  if (params.status) query.set('status', params.status);
  if (params.before) query.set('before', String(params.before));
  const res = await authFetch(`${API_BASE}/runs/?${query}`, { method: 'DELETE' });
  return handleResponse(res, 'Failed to delete runs');
}

// ── Knowledge Graph API ──────────────────────────────────────────────────

export interface GraphNode {
  id: string;
  title: string;
  type: string;
  category: string;
  path: string | null;
  tags: string[];
  missing: boolean;
  degree: number;
  createdAt?: number;
  isShared?: boolean;
}

export interface GraphEdge {
  id: string;
  source: string;
  target: string;
  type: string;
  label?: string;
}

export interface GraphData {
  nodes: GraphNode[];
  edges: GraphEdge[];
  stats: {
    nodeCount: number;
    edgeCount: number;
    nodeTypeCounts: Record<string, number>;
    edgeTypeCounts: Record<string, number>;
  };
}

export async function fetchAgentGraph(agentId: string): Promise<GraphData> {
  const res = await authFetch(`${API_BASE}/memory/vaults/${agentId}/graph`);
  return handleResponse(res, 'Failed to fetch agent graph');
}

export async function rebuildAgentGraph(agentId: string) {
  const res = await authFetch(`${API_BASE}/memory/vaults/${agentId}/graph/rebuild`, { method: 'POST' });
  return handleResponse(res, 'Failed to rebuild graph');
}

export async function fetchNodeNeighbors(agentId: string, nodeId: string, maxHops: number = 1): Promise<{ nodes: GraphNode[]; edges: GraphEdge[] }> {
  const res = await authFetch(`${API_BASE}/memory/vaults/${agentId}/graph/neighbors/${encodeURIComponent(nodeId)}?max_hops=${maxHops}`);
  return handleResponse(res, 'Failed to fetch node neighbors');
}

export async function fetchSharedGraph(): Promise<GraphData> {
  const res = await authFetch(`${API_BASE}/memory/vaults/shared/graph`);
  return handleResponse(res, 'Failed to fetch shared graph');
}

export async function fetchVaultFiles(vaultId: string): Promise<any[]> {
  const res = await authFetch(`${API_BASE}/memory/vaults/${vaultId}`);
  return handleResponse(res, 'Failed to fetch vault files');
}

export async function deleteMemoryFile(agentId: string, filename: string): Promise<{ deleted: boolean }> {
  const encodedPath = filename.split('/').map(encodeURIComponent).join('/');
  const res = await authFetch(`${API_BASE}/agents/${agentId}/memory/${encodedPath}`, {
    method: 'DELETE',
  });
  return handleResponse(res, 'Failed to delete memory file');
}

// ── Workspace API ─────────────────────────────────────────────────────────

export async function fetchWorkspaceFiles(runId: string) {
  const res = await authFetch(`${API_BASE}/workspaces/${runId}`);
  return handleResponse(res, 'Failed to fetch workspace files');
}

export async function fetchWorkspaceFile(runId: string, path: string) {
  const encodedPath = path.split('/').map(encodeURIComponent).join('/');
  const res = await authFetch(`${API_BASE}/workspaces/${runId}/${encodedPath}`);
  return handleResponse(res, 'Failed to fetch file');
}

export async function fetchGitHistory(runId: string, limit: number = 50, offset: number = 0): Promise<{
  run_id: string;
  commits: Array<{
    hash: string;
    short_hash: string;
    author: string;
    email: string;
    timestamp: number;
    subject: string;
    step_id?: string;
    agent_id?: string;
    summary?: string;
    stats?: {
      files: number;
      insertions: number;
      deletions: number;
    };
  }>;
  total: number;
}> {
  const params = new URLSearchParams({ limit: String(limit), offset: String(offset) });
  const res = await authFetch(`${API_BASE}/workspaces/${runId}/git/history?${params}`);
  return handleResponse(res, 'Failed to fetch git history');
}

export interface GitStatus {
  run_id: string;
  is_repo: boolean;
  branch?: string;
  tracking_branch?: string;
  is_clean?: boolean;
  ahead?: number;
  behind?: number;
  uncommitted_changes?: number;
  changes?: Array<{ status: string; file: string }>;
  last_commit?: {
    hash: string;
    short_hash: string;
    timestamp: number;
    subject: string;
  };
  error?: string;
}

export async function fetchGitStatus(runId: string): Promise<GitStatus> {
  const res = await authFetch(`${API_BASE}/workspaces/${runId}/git/status`);
  return handleResponse(res, 'Failed to fetch git status');
}

export interface CommitDiff {
  commit: {
    hash: string;
    short_hash: string;
    author: string;
    timestamp: number;
    subject: string;
  };
  files: Array<{
    path: string;
    additions: number;
    deletions: number;
    status: 'added' | 'modified' | 'deleted';
  }>;
  diff: string;
}

export async function fetchCommitDiff(runId: string, commitHash: string): Promise<CommitDiff> {
  const res = await authFetch(`${API_BASE}/workspaces/${runId}/git/diff/${commitHash}`);
  return handleResponse(res, 'Failed to fetch commit diff');
}

export interface ConflictData {
  file: string;
  oursContent: string;
  theirsContent: string;
  baseContent?: string;
  conflictMarkers: string;
}

export interface MergeResponse {
  success: boolean;
  conflicts?: string[];
  error?: string;
}

export async function fetchConflictData(runId: string, file: string): Promise<ConflictData> {
  const encodedFile = encodeURIComponent(file);
  const res = await authFetch(`${API_BASE}/workspaces/${runId}/conflicts/${encodedFile}`);
  return handleResponse(res, 'Failed to fetch conflict data');
}

export async function resolveConflicts(
  runId: string,
  resolutions: Record<string, string> | { strategy: 'ours' | 'theirs'; resolveAll: boolean }
): Promise<MergeResponse> {
  const res = await authFetch(`${API_BASE}/workspaces/${runId}/merge`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(resolutions),
  });
  return handleResponse(res, 'Failed to resolve conflicts');
}

// ── Sandbox API ───────────────────────────────────────────────────────────

// Types imported from @/types/sandbox

export async function fetchAgentSandbox(agentId: string): Promise<SandboxInfo> {
  const res = await authFetch(`${API_BASE}/agents/${agentId}/sandbox`);
  return handleResponse(res, 'Failed to fetch sandbox');
}

export async function fetchAgentSandboxFile(
  agentId: string,
  path: string,
  options?: { maxSize?: number }
): Promise<SandboxFileContent> {
  const params = new URLSearchParams({ path });
  if (options?.maxSize) params.set('maxSize', String(options.maxSize));
  const res = await authFetch(`${API_BASE}/agents/${agentId}/sandbox/file?${params}`);
  return handleResponse(res, 'Failed to fetch sandbox file');
}

export async function fetchSandboxTree(agentId: string, path: string = '/'): Promise<FileTree> {
  const params = new URLSearchParams({ path });
  const res = await authFetch(`${API_BASE}/agents/${agentId}/sandbox/tree?${params}`);
  return handleResponse(res, 'Failed to fetch sandbox tree');
}

export async function resetAgentSandbox(agentId: string): Promise<ResetSandboxResponse> {
  const res = await authFetch(`${API_BASE}/agents/${agentId}/sandbox/reset`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ confirm: true }),
  });
  return handleResponse(res, 'Failed to reset sandbox');
}

// ── Agent Config API ─────────────────────────────────────────────────────

// Types imported from @/types/config

export interface UpdateConfigResponse {
  success: boolean;
  message: string;
}
export async function fetchAgentConfig(agentId: string): Promise<AgentConfig> {
  const res = await authFetch(`${API_BASE}/agents/${agentId}/config`);
  return handleResponse(res, 'Failed to fetch agent config');
}

export async function updateAgentConfig(agentId: string, config: AgentConfig): Promise<UpdateConfigResponse> {
  const res = await authFetch(`${API_BASE}/agents/${agentId}/config`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(config),
  });
  return handleResponse(res, 'Failed to update agent config');
}

// ── Work Ledger / Coordination API ────────────────────────────────────────

export interface WorkLockEntry {
  key: string;
  sessionId: string;
  description: string;
  acquiredAt: number;
  ttlSeconds: number;
  remainingSeconds: number;
}

export interface WorkLedgerResponse {
  agentId: string;
  locks: WorkLockEntry[];
  count: number;
}

export async function fetchAgentWorkLedger(agentId: string): Promise<WorkLedgerResponse> {
  const res = await authFetch(`${API_BASE}/agents/${agentId}/work-ledger`);
  return handleResponse(res, 'Failed to fetch work ledger');
}

export interface WakeStatsResponse {
  agentId: string;
  wakesToday: number;
  date: string;
}

export async function fetchAgentWakeStats(agentId: string): Promise<WakeStatsResponse> {
  const res = await authFetch(`${API_BASE}/agents/${agentId}/wake-stats`);
  return handleResponse(res, 'Failed to fetch wake stats');
}

// ── Inbox API ─────────────────────────────────────────────────────────────

// Types now imported from @/types/inbox
export async function fetchAgentInbox(
  agentId: string,
  filter?: 'all' | 'unread' | 'urgent' | 'review_request' | 'help_request',
  options?: { limit?: number; offset?: number; since?: number }
): Promise<InboxResponse> {
  const params = new URLSearchParams();
  if (filter) params.set('filter', filter);
  if (options?.limit) params.set('limit', String(options.limit));
  if (options?.offset) params.set('offset', String(options.offset));
  if (options?.since) params.set('since', String(options.since));
  const query = params.toString() ? `?${params}` : '';
  const res = await authFetch(`${API_BASE}/agents/${agentId}/inbox${query}`);
  return handleResponse(res, 'Failed to fetch inbox');
}

export async function sendAgentMessage(
  agentId: string,
  payload: SendMessageRequest
): Promise<SendMessageResponse> {
  const res = await authFetch(`${API_BASE}/agents/${agentId}/inbox`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  return handleResponse(res, 'Failed to send message');
}

export async function markAgentMessagesRead(
  agentId: string,
  messageIds: string[]
): Promise<MarkReadResponse> {
  const res = await authFetch(`${API_BASE}/agents/${agentId}/inbox/mark-read`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ messageIds }),
  });
  return handleResponse(res, 'Failed to mark messages as read');
}

export async function clearAgentInbox(agentId: string): Promise<ClearInboxResponse> {
  const res = await authFetch(`${API_BASE}/agents/${agentId}/inbox/clear`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ confirm: true }),
  });
  return handleResponse(res, 'Failed to clear inbox');
}

// ── Lifecycle API ─────────────────────────────────────────────────────────

// ── Lifecycle API ─────────────────────────────────────────────────────────

// Types now imported from @/types/lifecycle
export async function fetchAgentLifecycle(agentId: string): Promise<LifecycleResponse> {
  const res = await authFetch(`${API_BASE}/agents/${agentId}/lifecycle`);
  return handleResponse(res, 'Failed to fetch lifecycle');
}

export async function fetchAgentActivity(
  agentId: string,
  options?: { limit?: number; since?: number }
): Promise<ActivityResponse> {
  const params = new URLSearchParams();
  if (options?.limit) params.set('limit', String(options.limit));
  if (options?.since) params.set('since', String(options.since));
  const query = params.toString() ? `?${params}` : '';
  const res = await authFetch(`${API_BASE}/agents/${agentId}/activity${query}`);
  return handleResponse(res, 'Failed to fetch activity');
}

export interface ActivityStats {
  sessionsToday: number;
  sessionsThisWeek: number;
  totalTokens: number;
  totalCost: number;
  errorCount: number;
}

export async function fetchAgentActivityStats(agentId: string): Promise<ActivityStats> {
  const res = await authFetch(`${API_BASE}/agents/${agentId}/activity/stats`);
  return handleResponse(res, 'Failed to fetch activity stats');
}

// ── Queue API ─────────────────────────────────────────────────────────────

export type QueuePriority = 'normal' | 'high' | 'urgent';

export interface QueueItem {
  id: string;
  stepType: string;
  runId?: string;
  priority: QueuePriority;
  queuedAt: string;
  context?: string;
}

export interface QueueResponse {
  agentId: string;
  items: QueueItem[];
  totalItems: number;
}

export interface ClearQueueResponse {
  success: boolean;
  message: string;
  itemsDropped: number;
}

export interface CancelQueueItemResponse {
  success: boolean;
  message: string;
  itemId: string;
}

export async function fetchAgentQueue(agentId: string): Promise<QueueResponse> {
  const res = await authFetch(`${API_BASE}/agents/${agentId}/queue`);
  return handleResponse(res, 'Failed to fetch queue');
}

export async function cancelQueueItem(agentId: string, itemId: string): Promise<CancelQueueItemResponse> {
  const res = await authFetch(`${API_BASE}/agents/${agentId}/queue/${itemId}`, {
    method: 'DELETE',
  });
  return handleResponse(res, 'Failed to cancel queue item');
}

export async function clearAgentQueue(agentId: string): Promise<ClearQueueResponse> {
  const res = await authFetch(`${API_BASE}/agents/${agentId}/queue/clear`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ confirm: true }),
  });
  return handleResponse(res, 'Failed to clear queue');
}

// ── Pulse API ─────────────────────────────────────────────────────────────

export type PulseCheckStatus = 'success' | 'failed' | 'skipped';

export interface PulseCheck {
  name: string;
  status: PulseCheckStatus;
  duration: number;
  details?: string;
}

export interface PulseStatusResponse {
  enabled: boolean;
  intervalMinutes: number;
  timeoutMs: number;
  lastPulse: {
    timestamp: number;
    duration: number;
    summary: string;
    checksCompleted: number;
    checksFailed: number;
    checks: PulseCheck[];
  } | null;
  nextPulse: number | null;
  checks: {
    inbox: boolean;
    consolidateMemories: boolean;
    updateWorkspaceDocs: boolean;
    cleanupStaleFiles: boolean;
    postStatusSlack: boolean;
  };
}

export interface TriggerPulseResponse {
  success: boolean;
  message: string;
  pulseId: string;
}

export async function fetchAgentPulseStatus(agentId: string): Promise<PulseStatusResponse> {
  const res = await authFetch(`${API_BASE}/agents/${agentId}/pulse/status`);
  return handleResponse(res, 'Failed to fetch pulse status');
}

export async function triggerAgentPulse(agentId: string): Promise<TriggerPulseResponse> {
  const res = await authFetch(`${API_BASE}/agents/${agentId}/pulse/trigger`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
  });
  return handleResponse(res, 'Failed to trigger pulse');
}

// ── Fleet API ─────────────────────────────────────────────────────────────

export interface AgentStatus {
  id: string;
  name: string;
  emoji: string;
  role: string;
  state: AgentState;
  currentWork?: {
    step: string;
    runId: string;
  };
  queueLength: number;
  unreadCount: number;
  installedTools: number;
  lastPulse: number | null;
  pulseEnabled: boolean;
  slackConnected: boolean;
}

export interface AgentsStatusResponse {
  agents: AgentStatus[];
  summary: {
    total: number;
    idle: number;
    working: number;
    thinking: number;
    totalQueued: number;
  };
}

export async function fetchAgentsStatus(): Promise<AgentsStatusResponse> {
  const res = await authFetch(`${API_BASE}/agents/status`);
  return handleResponse(res, 'Failed to fetch agents status');
}

// ── File at Commit API ────────────────────────────────────────────────────

export interface FileAtCommit {
  run_id: string;
  path: string;
  commit: {
    hash: string;
    short_hash: string;
    author: string;
    timestamp: number;
    subject: string;
  };
  content: string;
  size: number;
  language: string;
}

export interface FileHistoryCommit {
  hash: string;
  short_hash: string;
  author: string;
  timestamp: number;
  subject: string;
  step_id?: string;
  agent_id?: string;
  summary?: string;
}

export interface FileHistoryResponse {
  run_id: string;
  path: string;
  commits: FileHistoryCommit[];
  total: number;
}

export async function fetchFileAtCommit(
  runId: string,
  commitHash: string,
  filePath: string
): Promise<FileAtCommit> {
  const res = await authFetch(
    `${API_BASE}/workspaces/${runId}/git/show/${commitHash}/${filePath}`
  );
  return handleResponse(res, 'Failed to fetch file at commit');
}

export async function fetchFileHistory(
  runId: string,
  filePath: string,
  limit: number = 20
): Promise<FileHistoryResponse> {
  const res = await authFetch(
    `${API_BASE}/workspaces/${runId}/git/file-history/${filePath}?limit=${limit}`
  );
  return handleResponse(res, 'Failed to fetch file history');
}

// ── Sessions API ──────────────────────────────────────────────────────────

import type { SessionList, SessionDetail } from '@/types/session';

export async function fetchAgentSessions(agentId: string, limit = 50): Promise<SessionList> {
  const res = await authFetch(`${API_BASE}/agents/${agentId}/sessions?limit=${limit}`);
  return handleResponse(res, 'Failed to fetch sessions');
}

export async function fetchAllSessions(params?: {
  agentIds?: string[];
  limit?: number;
  offset?: number;
  status?: string;
}): Promise<SessionList> {
  const searchParams = new URLSearchParams();
  if (params?.agentIds?.length) searchParams.set('agent_ids', params.agentIds.join(','));
  if (params?.limit) searchParams.set('limit', String(params.limit));
  if (params?.offset) searchParams.set('offset', String(params.offset));
  if (params?.status) searchParams.set('status', params.status);
  const query = searchParams.toString();
  const res = await authFetch(`${API_BASE}/sessions${query ? '?' + query : ''}`);
  return handleResponse(res, 'Failed to fetch all sessions');
}

export async function fetchSession(sessionId: string): Promise<SessionDetail> {
  const res = await authFetch(`${API_BASE}/sessions/${sessionId}`);
  return handleResponse(res, 'Failed to fetch session');
}

export async function stopSession(sessionId: string): Promise<{ session_id: string; status: string; message: string }> {
  const res = await authFetch(`${API_BASE}/sessions/${sessionId}/stop`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
  });
  return handleResponse(res, 'Failed to stop session');
}

// ── Chat API ──────────────────────────────────────────────────────────────

export interface ChatSessionResponse {
  sessionId: string;
  status: string;
  message?: string;
}

export interface SendChatMessageResponse {
  status: string;
  sessionId: string;
  messageId: string;
}

export async function startChatSession(
  agentId: string,
  model?: string,
  systemPromptSupplement?: string,
  thinkingLevel?: string,
): Promise<ChatSessionResponse> {
  const res = await authFetch(`${API_BASE}/agents/${agentId}/chat/start`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model,
      system_prompt_supplement: systemPromptSupplement,
      thinking_level: thinkingLevel && thinkingLevel !== 'off' ? thinkingLevel : undefined,
    }),
  });
  return handleResponse(res, 'Failed to start chat session');
}

export async function sendChatMessage(
  agentId: string,
  sessionId: string,
  message: string,
  signal?: AbortSignal,
  model?: string,
  attachmentIds?: string[],
): Promise<SendChatMessageResponse> {
  const body: Record<string, unknown> = { message, model };
  if (attachmentIds?.length) body.attachment_ids = attachmentIds;
  const res = await authFetch(`${API_BASE}/agents/${agentId}/chat/${sessionId}/message`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal,
  });
  return handleResponse(res, 'Failed to send message');
}

// ── Chat Attachment API ──────────────────────────────────────────────────

export interface ChatAttachmentResponse {
  id: string;
  filename: string;
  mimeType: string;
  sizeBytes: number;
  processingStatus: string;
  estimatedTokens: number | null;
  isImage: boolean;
  createdAt: number;
}

export async function uploadChatAttachment(
  agentId: string,
  sessionId: string,
  file: File,
): Promise<ChatAttachmentResponse> {
  const formData = new FormData();
  formData.append('file', file);
  const res = await authFetch(`${API_BASE}/agents/${agentId}/chat/${sessionId}/upload`, {
    method: 'POST',
    body: formData,
    // Do NOT set Content-Type — browser sets it with boundary automatically
  });
  return handleResponse(res, 'Failed to upload attachment');
}

export function getAttachmentContentUrl(attachmentId: string): string {
  return `${API_BASE}/chat/attachments/${attachmentId}/content`;
}

export async function updateChatModel(
  agentId: string,
  sessionId: string,
  model: string
): Promise<{ status: string; model: string }> {
  const res = await authFetch(`${API_BASE}/agents/${agentId}/chat/${sessionId}/model?model=${encodeURIComponent(model)}`, {
    method: 'PATCH',
  });
  return handleResponse(res, 'Failed to update model');
}

export async function getChatSession(sessionId: string): Promise<{
  id: string;
  agent_id: string;
  status: string;
  model: string;
  container_id: string | null;
  created_at: number;
  last_activity_at: number;
  message_count: number;
  key_resolution?: {
    source?: string;
    userId?: string | null;
    resolvedProviders?: string[];
    providerSources?: Record<string, { source: string; masked_key: string }>;
  } | null;
  messages: Array<{
    id: string;
    role: string;
    content: string;
    model: string | null;
    thinking: string | null;
    tool_calls: any[] | null;
    created_at: number;
    completed_at: number | null;
  }>;
}> {
  const res = await authFetch(`${API_BASE}/chat/sessions/${sessionId}`);
  return handleResponse(res, 'Failed to get chat session');
}

export async function listChatSessions(agentId: string, params?: {
  status?: string;
  limit?: number;
}): Promise<{
  sessions: Array<{
    id: string;
    status: string;
    model: string;
    created_at: number;
    message_count: number;
    key_resolution?: {
      source?: string;
      userId?: string | null;
      resolvedProviders?: string[];
      providerSources?: Record<string, { source: string; masked_key: string }>;
    } | null;
  }>;
  total: number;
  has_more: boolean;
}> {
  const searchParams = new URLSearchParams();
  if (params?.status) searchParams.set('status', params.status);
  if (params?.limit) searchParams.set('limit', String(params.limit));
  const query = searchParams.toString();
  
  const res = await authFetch(`${API_BASE}/agents/${agentId}/chat/sessions${query ? '?' + query : ''}`);
  return handleResponse(res, 'Failed to list chat sessions');
}

export async function stopChatResponse(agentId: string, sessionId: string): Promise<void> {
  const res = await authFetch(`${API_BASE}/agents/${agentId}/chat/${sessionId}/stop`, {
    method: 'POST',
  });
  return handleResponse(res, 'Failed to stop response');
}

export async function endChatSession(agentId: string, sessionId: string): Promise<void> {
  const res = await authFetch(`${API_BASE}/agents/${agentId}/chat/${sessionId}/end`, {
    method: 'POST',
  });
  return handleResponse(res, 'Failed to end session');
}

export async function restartChatSession(agentId: string, sessionId: string): Promise<{
  sessionId: string;
  status: string;
  message?: string;
}> {
  const res = await authFetch(`${API_BASE}/agents/${agentId}/chat/${sessionId}/restart`, {
    method: 'POST',
  });
  return handleResponse(res, 'Failed to restart session');
}

export async function getChatSessionStatus(agentId: string, sessionId: string): Promise<{
  sessionId: string;
  status: string;
  exists: boolean;
  messageCount?: number;
  model?: string;
}> {
  const res = await authFetch(`${API_BASE}/agents/${agentId}/chat/${sessionId}/status`);
  return handleResponse(res, 'Failed to get session status');
}

// ── Pulse Management API ──────────────────────────────────────────────────

export interface PulseTimelineResponse {
  windowStart: number;
  windowEnd: number;
  pulses: Array<{
    agentId: string;
    scheduledAt: number;
    source: 'recurring' | 'one-off';
    status: string;
  }>;
  conflicts: Array<{
    windowStart: number;
    windowEnd: number;
    agents: Array<{ agentId: string; scheduledAt: number; source: string }>;
    severity: 'warning' | 'critical';
  }>;
  summary: {
    totalPulses: number;
    byAgent: Record<string, number>;
    conflictCount: number;
  };
}

export interface PulseBlackout {
  type: 'recurring' | 'one-off';
  label?: string;
  startTime?: string;
  endTime?: string;
  daysOfWeek?: number[];
  start?: string;
  end?: string;
}

export interface PulseScheduleConfig {
  enabled: boolean;
  intervalMinutes: number;
  offsetMinutes: number;
  blackouts: PulseBlackout[];
  oneOffs: string[];
  maxConsecutiveSkips: number;
}

export interface AgentPulseScheduleResponse {
  schedule: PulseScheduleConfig;
  upcoming: Array<{
    agentId: string;
    scheduledAt: number;
    source: 'recurring' | 'one-off';
    status: string;
  }>;
}

export interface PulseScheduleUpdate {
  enabled?: boolean;
  intervalMinutes?: number;
  offsetMinutes?: number;
  blackouts?: PulseBlackout[];
}

export interface AutoSpreadResult {
  status: string;
  changes: Record<string, { old: number; new: number }>;
  totalAgents: number;
}

export async function fetchPulseTimeline(hours = 24): Promise<PulseTimelineResponse> {
  const res = await authFetch(`${API_BASE}/pulses/timeline?hours=${hours}`);
  return handleResponse(res, 'Failed to fetch pulse timeline');
}

export async function fetchAgentPulseSchedule(agentId: string): Promise<AgentPulseScheduleResponse> {
  const res = await authFetch(`${API_BASE}/pulses/agents/${agentId}/schedule`);
  return handleResponse(res, 'Failed to fetch pulse schedule');
}

export async function updateAgentPulseSchedule(agentId: string, update: PulseScheduleUpdate): Promise<{ status: string; schedule: PulseScheduleConfig }> {
  const res = await authFetch(`${API_BASE}/pulses/agents/${agentId}/schedule`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(update),
  });
  return handleResponse(res, 'Failed to update pulse schedule');
}

export async function addOneOffPulse(agentId: string, time: string): Promise<{ status: string; time: string }> {
  const res = await authFetch(`${API_BASE}/pulses/agents/${agentId}/schedule/one-off`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ time }),
  });
  return handleResponse(res, 'Failed to add one-off pulse');
}

export async function removeOneOffPulse(agentId: string, timestamp: string): Promise<{ status: string; time: string }> {
  const encodedTimestamp = encodeURIComponent(timestamp);
  const res = await authFetch(`${API_BASE}/pulses/agents/${agentId}/schedule/one-off/${encodedTimestamp}`, {
    method: 'DELETE',
  });
  return handleResponse(res, 'Failed to remove one-off pulse');
}

export async function autoSpreadOffsets(): Promise<AutoSpreadResult> {
  const res = await authFetch(`${API_BASE}/pulses/auto-spread`, {
    method: 'POST',
  });
  return handleResponse(res, 'Failed to auto-spread offsets');
}

// ── Pulse Routines ────────────────────────────────────────────────────────

export interface PulseRoutine {
  id: string;
  agentId: string;
  name: string;
  description: string | null;
  instructions: string;
  enabled: boolean;
  intervalMinutes: number;
  offsetMinutes: number;
  blackouts: PulseBlackout[];
  oneOffs: string[];
  timeoutMs: number | null;
  maxConcurrent: number;
  pulseColumns: string[] | null;
  tools: string[] | null;
  planningModel: string | null;
  executorModel: string | null;
  sortOrder: number;
  lastRunAt: number | null;
  totalRuns: number;
  color: string | null;
  createdAt: number;
  updatedAt: number;
}

export interface CreatePulseRoutineRequest {
  name: string;
  description?: string;
  instructions?: string;
  enabled?: boolean;
  intervalMinutes?: number;
  offsetMinutes?: number;
  blackouts?: PulseBlackout[];
  timeoutMs?: number;
  maxConcurrent?: number;
  pulseColumns?: string[];
  tools?: string[];
  color?: string;
  planningModel?: string;
  executorModel?: string;
}

export interface UpdatePulseRoutineRequest {
  name?: string;
  description?: string;
  instructions?: string;
  enabled?: boolean;
  intervalMinutes?: number;
  offsetMinutes?: number;
  blackouts?: PulseBlackout[];
  oneOffs?: string[];
  timeoutMs?: number;
  maxConcurrent?: number;
  pulseColumns?: string[];
  tools?: string[];
  color?: string;
  planningModel?: string;
  executorModel?: string;
}

export async function fetchPulseRoutines(agentId: string): Promise<{ routines: PulseRoutine[] }> {
  const res = await authFetch(`${API_BASE}/agents/${agentId}/pulse-routines`);
  return handleResponse(res, 'Failed to fetch pulse routines');
}

export async function createPulseRoutine(agentId: string, data: CreatePulseRoutineRequest): Promise<PulseRoutine> {
  const res = await authFetch(`${API_BASE}/agents/${agentId}/pulse-routines`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(data),
  });
  return handleResponse(res, 'Failed to create pulse routine');
}

export async function updatePulseRoutine(agentId: string, routineId: string, data: UpdatePulseRoutineRequest): Promise<PulseRoutine> {
  const res = await authFetch(`${API_BASE}/agents/${agentId}/pulse-routines/${routineId}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(data),
  });
  return handleResponse(res, 'Failed to update pulse routine');
}

export async function deletePulseRoutine(agentId: string, routineId: string): Promise<{ status: string }> {
  const res = await authFetch(`${API_BASE}/agents/${agentId}/pulse-routines/${routineId}`, {
    method: 'DELETE',
  });
  return handleResponse(res, 'Failed to delete pulse routine');
}

export async function togglePulseRoutine(agentId: string, routineId: string): Promise<{ id: string; enabled: boolean }> {
  const res = await authFetch(`${API_BASE}/agents/${agentId}/pulse-routines/${routineId}/toggle`, {
    method: 'PATCH',
  });
  return handleResponse(res, 'Failed to toggle pulse routine');
}

export async function triggerPulseRoutine(agentId: string, routineId: string): Promise<{ status: string }> {
  const res = await authFetch(`${API_BASE}/agents/${agentId}/pulse-routines/${routineId}/trigger`, {
    method: 'POST',
  });
  return handleResponse(res, 'Failed to trigger pulse routine');
}

export async function duplicatePulseRoutine(agentId: string, routineId: string): Promise<PulseRoutine> {
  const res = await authFetch(`${API_BASE}/agents/${agentId}/pulse-routines/${routineId}/duplicate`, {
    method: 'POST',
  });
  return handleResponse(res, 'Failed to duplicate pulse routine');
}

export async function reorderPulseRoutines(agentId: string, routineIds: string[]): Promise<{ status: string }> {
  const res = await authFetch(`${API_BASE}/agents/${agentId}/pulse-routines/reorder`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ routineIds }),
  });
  return handleResponse(res, 'Failed to reorder pulse routines');
}



// ── Project Agent Assignment ──────────────────────────────────────────────

export interface ProjectAgent {
  agent_id: string;
  role: 'lead' | 'member' | 'reviewer';
  project_id: string;
  assigned_at?: number;
}

export async function fetchProjectAgents(projectId: string): Promise<ProjectAgent[]> {
  const res = await authFetch(`${API_BASE}/projects/${projectId}/agents`);
  return handleResponse(res, 'Failed to fetch project agents');
}

export async function assignAgentToProject(
  projectId: string,
  agentId: string,
  role: ProjectAgent['role'],
): Promise<ProjectAgent> {
  const res = await authFetch(`${API_BASE}/projects/${projectId}/agents`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ agentId, role }),
  });
  return handleResponse(res, 'Failed to assign agent');
}

export async function updateAgentRole(
  projectId: string,
  agentId: string,
  role: ProjectAgent['role'],
): Promise<ProjectAgent> {
  const res = await authFetch(`${API_BASE}/projects/${projectId}/agents/${agentId}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ role }),
  });
  return handleResponse(res, 'Failed to update agent role');
}

export async function removeAgentFromProject(projectId: string, agentId: string): Promise<void> {
  const res = await authFetch(`${API_BASE}/projects/${projectId}/agents/${agentId}`, {
    method: 'DELETE',
  });
  return handleResponse(res, 'Failed to remove agent');
}

export async function fetchAgentProjects(agentId: string): Promise<Array<{
  project_id: string;
  project_name: string;
  project_status: string;
  role: string;
}>> {
  const res = await authFetch(`${API_BASE}/agents/${agentId}/projects`);
  return handleResponse(res, 'Failed to fetch agent projects');
}

// ── Task Branch & Transition ──────────────────────────────────────────────

export async function fetchTaskBranch(projectId: string, taskId: string): Promise<{
  task_id: string;
  project_id: string;
  branch: string;
  created: boolean;
}> {
  const res = await authFetch(`${API_BASE}/projects/${projectId}/tasks/${taskId}/branch`);
  return handleResponse(res, 'Failed to fetch task branch');
}

export async function claimTask(projectId: string, taskId: string, agentId: string): Promise<{
  status: string;
  task_id: string;
  agent_id: string;
  branch: string;
}> {
  const res = await authFetch(`${API_BASE}/projects/${projectId}/tasks/${taskId}/claim`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ agentId }),
  });
  return handleResponse(res, 'Failed to claim task');
}

export async function transitionTask(
  projectId: string,
  taskId: string,
  status: string,
  note?: string,
): Promise<{ status: string; from_status: string; to_status: string }> {
  const res = await authFetch(`${API_BASE}/projects/${projectId}/tasks/${taskId}/transition`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ status, note }),
  });
  return handleResponse(res, 'Failed to transition task');
}

// ============================================================================
// Onboarding — Agent-Guided Project Creation
// ============================================================================

export interface OnboardingMessage {
  id: string;
  session_id: string;
  role: 'user' | 'assistant' | 'system';
  content: string;
  agent_id: string | null;
  agent_name: string | null;
  agent_emoji: string | null;
  tool_calls: unknown[] | null;
  thinking: string | null;
  handoff_to_agent: string | null;
  created_at: number;
}

export interface OnboardingLandingPageState {
  html: string;
  caption?: string | null;
  last_agent_id?: string | null;
  version: number;
}

export interface OnboardingSession {
  id: string;
  status: 'active' | 'completed' | 'abandoned';
  project_id: string | null;
  current_agent_id: string;
  current_agent_name: string;
  current_agent_emoji: string;
  phase: 'intake' | 'strategy' | 'product' | 'architecture' | 'done';
  context: Record<string, unknown>;
  landing_page_state: OnboardingLandingPageState | null;
  chat_session_id: string | null;
  template_id: string | null;
  model: string;
  created_at: number;
  updated_at: number;
  completed_at: number | null;
  messages: OnboardingMessage[];
}

/** Lightweight summary returned by the list endpoint (no messages). */
export interface OnboardingSessionSummary {
  id: string;
  status: 'active' | 'completed' | 'abandoned';
  phase: string;
  project_id: string | null;
  current_agent_id: string;
  current_agent_name: string;
  current_agent_emoji: string;
  template_id: string | null;
  model: string;
  created_at: number;
  updated_at: number;
  completed_at: number | null;
  context: Record<string, unknown>;
}

export async function listOnboardingSessions(
  status?: 'active' | 'completed' | 'abandoned',
  limit = 20,
): Promise<OnboardingSessionSummary[]> {
  const params = new URLSearchParams({ limit: String(limit) });
  if (status) params.set('status', status);
  const res = await authFetch(`${API_BASE}/onboarding/sessions?${params}`);
  return handleResponse(res, 'Failed to list onboarding sessions');
}

export async function resumeOnboardingSession(sessionId: string): Promise<OnboardingSession> {
  const res = await authFetch(`${API_BASE}/onboarding/sessions/${sessionId}/resume`, {
    method: 'POST',
  });
  return handleResponse(res, 'Failed to resume onboarding session');
}

export async function createOnboardingSession(model?: string, templateId?: string): Promise<OnboardingSession> {
  const res = await authFetch(`${API_BASE}/onboarding/sessions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model, templateId }),
  });
  return handleResponse(res, 'Failed to create onboarding session');
}

export async function getOnboardingSession(sessionId: string): Promise<OnboardingSession> {
  const res = await authFetch(`${API_BASE}/onboarding/sessions/${sessionId}`);
  return handleResponse(res, 'Failed to fetch onboarding session');
}

export async function sendOnboardingMessage(
  sessionId: string,
  message: string,
  model?: string,
): Promise<{
  status: string;
  sessionId: string;
  chatSessionId: string;
  userMessageId: string;
  assistantMessageId: string;
}> {
  const res = await authFetch(`${API_BASE}/onboarding/sessions/${sessionId}/message`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ message, model }),
  });
  return handleResponse(res, 'Failed to send onboarding message');
}

export async function handoffOnboardingAgent(
  sessionId: string,
  nextAgentId: string,
  contextUpdate?: Record<string, unknown>,
  summary?: string,
): Promise<{
  status: string;
  sessionId: string;
  fromAgent: string;
  toAgent: string;
  newChatSessionId: string;
  phase: string;
}> {
  const res = await authFetch(`${API_BASE}/onboarding/sessions/${sessionId}/handoff`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      next_agent_id: nextAgentId,
      context_update: contextUpdate,
      summary,
    }),
  });
  return handleResponse(res, 'Failed to hand off onboarding agent');
}

export async function finalizeOnboardingSession(
  sessionId: string,
  opts: {
    projectName: string;
    description?: string;
    repository?: string;
    context?: Record<string, unknown>;
  },
): Promise<{ status: string; sessionId: string; projectId: string; projectName: string }> {
  const res = await authFetch(`${API_BASE}/onboarding/sessions/${sessionId}/finalize`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      project_name: opts.projectName,
      description: opts.description,
      repository: opts.repository,
      context: opts.context,
    }),
  });
  return handleResponse(res, 'Failed to finalize onboarding session');
}

/**
 * Stop the current agent response without abandoning the session.
 * Sends an abort signal to the running container — the session stays active
 * and can be resumed. This is the "Stop" button action.
 */
export async function stopOnboardingSession(
  sessionId: string,
): Promise<{ status: string; sessionId: string }> {
  const res = await authFetch(`${API_BASE}/onboarding/sessions/${sessionId}/stop`, {
    method: 'POST',
  });
  return handleResponse(res, 'Failed to stop onboarding session');
}

/** Soft-abandon: marks the session abandoned so it can be resumed later. */
export async function abandonOnboardingSession(
  sessionId: string,
): Promise<{ status: string; sessionId: string }> {
  const res = await authFetch(`${API_BASE}/onboarding/sessions/${sessionId}/abandon`, {
    method: 'PATCH',
  });
  return handleResponse(res, 'Failed to abandon onboarding session');
}

/** Hard-delete: permanently removes the session row. Cannot be undone. */
export async function deleteOnboardingSession(
  sessionId: string,
): Promise<{ status: string; sessionId: string }> {
  const res = await authFetch(`${API_BASE}/onboarding/sessions/${sessionId}`, {
    method: 'DELETE',
  });
  return handleResponse(res, 'Failed to delete onboarding session');
}

export async function updateOnboardingContext(
  sessionId: string,
  contextUpdate: Record<string, unknown>,
): Promise<{ status: string; context: Record<string, unknown> }> {
  const res = await authFetch(`${API_BASE}/onboarding/sessions/${sessionId}/context`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(contextUpdate),
  });
  return handleResponse(res, 'Failed to update onboarding context');
}

// ── Skills API V2 ─────────────────────────────────────────────────────────────

/** Full skill record as returned by the library endpoints */
export interface Skill {
  id: string;
  description: string;
  tags: string[];
  content: string;
  enabled: boolean;
  scope: 'global' | 'agent';
  owner_agent_id?: string;
  has_files: boolean;
  created_by: string;
  created_at: number;
  updated_at: number;
}

/** Skill record from an agent's granted-skills list */
export interface GrantedSkill {
  id: string;
  description: string;
  tags: string[];
  enabled: boolean;
  scope: 'global' | 'agent';
  owner_agent_id?: string;
  granted_by: string;
  granted_at: number;
}

export interface CreateSkillPayload {
  name: string;
  description: string;
  tags?: string[];
  content: string;
  enabled?: boolean;
  scope?: 'global' | 'agent';
  owner_agent_id?: string;
  has_files?: boolean;
}

export interface UpdateSkillPayload {
  description?: string;
  tags?: string[];
  content?: string;
  enabled?: boolean;
}

// ── Skill library CRUD ────────────────────────────────────────────────────────

export async function fetchSkills(): Promise<Skill[]> {
  const res = await authFetch(`${API_BASE}/skills/`);
  return handleResponse(res, 'Failed to fetch skills');
}

export async function fetchSkill(skillId: string): Promise<Skill> {
  const res = await authFetch(`${API_BASE}/skills/${encodeURIComponent(skillId)}`);
  return handleResponse(res, 'Failed to fetch skill');
}

export async function createSkill(payload: CreateSkillPayload): Promise<Skill> {
  const res = await authFetch(`${API_BASE}/skills/`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  return handleResponse(res, 'Failed to create skill');
}

export async function updateSkill(skillId: string, payload: UpdateSkillPayload): Promise<Skill> {
  const res = await authFetch(`${API_BASE}/skills/${encodeURIComponent(skillId)}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  return handleResponse(res, 'Failed to update skill');
}

export async function deleteSkill(skillId: string): Promise<void> {
  const res = await authFetch(`${API_BASE}/skills/${encodeURIComponent(skillId)}`, { method: 'DELETE' });
  await handleResponse(res, 'Failed to delete skill');
}

export async function setSkillEnabled(skillId: string, enabled: boolean): Promise<Skill> {
  const res = await authFetch(`${API_BASE}/skills/${encodeURIComponent(skillId)}/enabled?enabled=${enabled}`, {
    method: 'PATCH',
  });
  return handleResponse(res, 'Failed to toggle skill');
}

// ── Agent access control ──────────────────────────────────────────────────────

/** List skills granted to an agent */
export async function fetchAgentSkills(agentId: string): Promise<GrantedSkill[]> {
  const res = await authFetch(`${API_BASE}/skills/agents/${encodeURIComponent(agentId)}`);
  return handleResponse(res, 'Failed to fetch agent skills');
}

/** Grant an agent access to a skill */
export async function grantSkillToAgent(agentId: string, skillId: string, grantedBy = 'ui'): Promise<GrantedSkill> {
  const res = await authFetch(
    `${API_BASE}/skills/agents/${encodeURIComponent(agentId)}/${encodeURIComponent(skillId)}/grant`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ granted_by: grantedBy }),
    },
  );
  return handleResponse(res, 'Failed to grant skill');
}

/** Revoke an agent's access to a skill */
export async function revokeSkillFromAgent(agentId: string, skillId: string): Promise<void> {
  const res = await authFetch(
    `${API_BASE}/skills/agents/${encodeURIComponent(agentId)}/${encodeURIComponent(skillId)}`,
    { method: 'DELETE' },
  );
  await handleResponse(res, 'Failed to revoke skill');
}

// Legacy shim — kept so skills.generate.tsx createAgentSkill call still compiles
// while we migrate. Creates a skill with scope='agent' then grants it.
export async function createAgentSkill(agentId: string, payload: CreateSkillPayload): Promise<Skill> {
  const skill = await createSkill({ ...payload, scope: 'agent', owner_agent_id: agentId });
  await grantSkillToAgent(agentId, skill.id).catch(() => {});
  return skill;
}

// ── Skill generation ──────────────────────────────────────────────────────────

export interface StartSkillSessionPayload {
  agent_id: string;
  model: string;
  url?: string;
  prompt?: string;
  scope?: 'global' | 'agent';
  target_agent_id?: string;
}

export interface StartSkillSessionResult {
  session_id: string;
  initial_message: string;
  scope: string;
  target_agent_id?: string;
}

export async function startSkillGenSession(payload: StartSkillSessionPayload): Promise<StartSkillSessionResult> {
  const res = await authFetch(`${API_BASE}/skills/generate/session`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  return handleResponse(res, 'Failed to start skill generation session');
}

export interface ParseSkillPayload {
  raw?: string;
  url?: string;
}

export interface ParseSkillResult {
  content: string;
  name: string;
  description: string;
  tags: string[];
  enabled: boolean;
  name_conflict: boolean;
  valid: boolean;
  error?: string;
}

export async function parseSkill(payload: ParseSkillPayload): Promise<ParseSkillResult> {
  const res = await authFetch(`${API_BASE}/skills/parse`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  return handleResponse(res, 'Failed to parse skill');
}

export interface GitHubImportedSkill {
  path: string;
  raw_url: string;
  content: string;
  name: string;
  description: string;
  tags: string[];
  enabled: boolean;
  name_conflict: boolean;
  valid: boolean;
  error?: string;
}

export interface GitHubImportResult {
  type: 'file' | 'repo';
  repo?: string;
  skills: GitHubImportedSkill[];
}

export async function importGithubSkills(url: string): Promise<GitHubImportResult> {
  const res = await authFetch(`${API_BASE}/skills/github-import`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ url }),
  });
  return handleResponse(res, 'Failed to import from GitHub');
}

export interface ExtractSkillResult {
  found: boolean;
  content: string;
  name: string;
  description: string;
  tags: string[];
  name_conflict: boolean;
  valid: boolean;
  error?: string;
}

export async function extractSkillFromOutput(text: string): Promise<ExtractSkillResult> {
  const res = await authFetch(`${API_BASE}/skills/extract`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ text }),
  });
  return handleResponse(res, 'Failed to extract skill from output');
}

// ── Model Provider API ─────────────────────────────────────────────────────────

export interface ProviderModel {
  id: string;
  name: string;
  description?: string;
  reasoning?: boolean;
}

export interface ProviderExtraField {
  envVar: string;
  label: string;
  placeholder: string;
  description: string;
  required: boolean;
}

export interface ModelProvider {
  providerId: string;
  enabled: boolean;
  configured: boolean;
  maskedApiKey?: string;
  /** Masked values of configured extra fields, keyed by env var name */
  maskedExtraConfig?: Record<string, string>;
  /** Plain (unmasked) values of configured extra fields — non-secret config */
  plainExtraConfig?: Record<string, string>;
  name: string;
  description: string;
  apiKeyEnvVar: string;
  docsUrl: string;
  models: ProviderModel[];
  /** Extra fields this provider needs beyond the primary API key */
  extraFields: ProviderExtraField[];
  /** True for user-created custom OpenAI-compatible providers */
  isCustom?: boolean;
}

export async function fetchModelProviders(): Promise<ModelProvider[]> {
  const res = await authFetch(`${API_BASE}/settings/providers`);
  return handleResponse(res, 'Failed to fetch model providers');
}

export async function upsertModelProvider(
  providerId: string,
  config: { enabled: boolean; apiKey?: string; extraConfig?: Record<string, string> }
): Promise<ModelProvider> {
  const res = await authFetch(`${API_BASE}/settings/providers/${encodeURIComponent(providerId)}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ providerId, ...config }),
  });
  return handleResponse(res, 'Failed to save provider configuration');
}

export async function removeModelProvider(providerId: string): Promise<void> {
  const res = await authFetch(`${API_BASE}/settings/providers/${encodeURIComponent(providerId)}`, {
    method: 'DELETE',
  });
  return handleResponse(res, 'Failed to remove provider');
}

export async function createCustomProvider(params: {
  name: string;
  slug: string;
  baseUrl: string;
  apiKey?: string;
}): Promise<ModelProvider> {
  const res = await authFetch(`${API_BASE}/settings/providers`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(params),
  });
  return handleResponse(res, 'Failed to create custom provider');
}

// ── Model favorites ───────────────────────────────────────────────────────────

export interface FavoriteModel {
  modelId: string;
  modelName: string;
  providerName: string;
}

export async function fetchFavorites(): Promise<FavoriteModel[]> {
  const res = await authFetch(`${API_BASE}/settings/favorites`);
  const data = await handleResponse(res, 'Failed to fetch favorites');
  return data.favorites as FavoriteModel[];
}

export async function saveFavorites(favorites: FavoriteModel[]): Promise<void> {
  const res = await authFetch(`${API_BASE}/settings/favorites`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ favorites }),
  });
  await handleResponse(res, 'Failed to save favorites');
}

export async function fetchProviderModels(
  providerId: string,
): Promise<{ models: ProviderModel[]; source: 'live' | 'static' }> {
  const res = await authFetch(`${API_BASE}/settings/providers/${providerId}/models`);
  return handleResponse(res, 'Failed to fetch provider models');
}

// ── Agent Channels API ────────────────────────────────────────────────────────

export interface ChannelExtraField {
  key: string;
  label: string;
  placeholder: string;
  description: string;
  secret: boolean;
}

export interface AgentChannel {
  agentId: string;
  channel: string;
  name: string;
  description: string;
  docsUrl: string;
  configured: boolean;
  enabled: boolean;
  primaryTokenLabel: string;
  primaryTokenEnvVarSuffix: string;
  primaryTokenHint: string;
  maskedPrimaryToken?: string;
  secondaryTokenLabel: string;
  secondaryTokenEnvVarSuffix: string;
  secondaryTokenHint: string;
  maskedSecondaryToken?: string;
  extraFields: ChannelExtraField[];
  maskedExtra?: Record<string, string>;
}

export async function fetchAgentChannels(agentId: string): Promise<AgentChannel[]> {
  const res = await authFetch(`${API_BASE}/agents/${agentId}/channels`);
  return handleResponse(res, 'Failed to fetch agent channels');
}

export async function upsertAgentChannel(
  agentId: string,
  channel: string,
  config: {
    enabled: boolean;
    primaryToken?: string;
    secondaryToken?: string;
    extraConfig?: Record<string, string>;
  },
): Promise<AgentChannel> {
  const res = await authFetch(`${API_BASE}/agents/${agentId}/channels/${channel}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(config),
  });
  return handleResponse(res, 'Failed to save channel configuration');
}

export async function removeAgentChannel(agentId: string, channel: string): Promise<void> {
  const res = await authFetch(`${API_BASE}/agents/${agentId}/channels/${channel}`, {
    method: 'DELETE',
  });
  return handleResponse(res, 'Failed to remove channel configuration');
}

// ── Secrets API ───────────────────────────────────────────────────────────────

export interface SecretItem {
  id: string;
  name: string;
  description: string | null;
  secret_type: string;
  secret_type_label: string;
  env_key: string;
  masked_preview: string | null;
  granted_agents: string[];
  created_at: number;
  updated_at: number;
}

export interface SecretCreate {
  name: string;
  description?: string;
  secret_type: string;
  env_key: string;
  value: string;
}

export interface SecretUpdate {
  name?: string;
  description?: string;
  secret_type?: string;
  env_key?: string;
  value?: string;
}

export interface SecretType {
  value: string;
  label: string;
}

export async function fetchSecrets(): Promise<SecretItem[]> {
  const res = await authFetch(`${API_BASE}/secrets/`);
  return handleResponse(res, 'Failed to fetch secrets');
}

export async function createSecret(body: SecretCreate): Promise<SecretItem> {
  const res = await authFetch(`${API_BASE}/secrets/`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  return handleResponse(res, 'Failed to create secret');
}

export async function updateSecret(secretId: string, body: SecretUpdate): Promise<SecretItem> {
  const res = await authFetch(`${API_BASE}/secrets/${secretId}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  return handleResponse(res, 'Failed to update secret');
}

export async function deleteSecret(secretId: string): Promise<void> {
  const res = await authFetch(`${API_BASE}/secrets/${secretId}`, { method: 'DELETE' });
  if (res.status !== 204 && !res.ok) {
    const body = await res.json().catch(() => ({ detail: 'Failed to delete secret' }));
    throw new Error(body.detail || `Failed to delete secret (${res.status})`);
  }
}

export async function grantSecret(secretId: string, agentId: string): Promise<void> {
  const res = await authFetch(`${API_BASE}/secrets/${secretId}/grant/${encodeURIComponent(agentId)}`, {
    method: 'POST',
  });
  return handleResponse(res, 'Failed to grant secret to agent');
}

export async function revokeSecret(secretId: string, agentId: string): Promise<void> {
  const res = await authFetch(`${API_BASE}/secrets/${secretId}/grant/${encodeURIComponent(agentId)}`, {
    method: 'DELETE',
  });
  if (res.status !== 204 && !res.ok) {
    const body = await res.json().catch(() => ({ detail: 'Failed to revoke secret' }));
    throw new Error(body.detail || `Failed to revoke secret (${res.status})`);
  }
}

export async function fetchSecretTypes(): Promise<SecretType[]> {
  const res = await authFetch(`${API_BASE}/secrets/types`);
  const data = await handleResponse(res, 'Failed to fetch secret types');
  return data.types as SecretType[];
}

// ── MCP / mcpo API ────────────────────────────────────────────────────────────

export interface McpServerItem {
  id: string;
  name: string;
  description: string;
  config: Record<string, unknown>;
  discovered_tools: string[];
  status: 'configuring' | 'running' | 'error' | 'stopped';
  enabled: boolean;
  setup_agent_id: string | null;
  created_at: number;
  updated_at: number;
}

export interface McpToolGrant {
  server_id: string;
  tool_name: string;
  granted_by: string;
  granted_at: number;
  server_name: string;
  server_status: string;
}

export interface McpManifestEntry {
  server_id: string;
  server_name: string;
  tool_name: string;
  base_url: string;
}

export interface McpManifestResponse {
  grants: McpManifestEntry[];
  manifest_text: string;
}

export interface McpSessionResponse {
  session_id: string;
  initial_message: string;
}

export interface McpExtractResult {
  found: boolean;
  config: {
    id: string;
    name: string;
    description?: string;
    config: Record<string, unknown>;
  } | null;
  error: string | null;
}

export async function fetchMcpServers(): Promise<McpServerItem[]> {
  const res = await authFetch(`${API_BASE}/mcp/`);
  return handleResponse(res, 'Failed to fetch MCP servers');
}

export async function createMcpServer(body: {
  name: string;
  description?: string;
  config: Record<string, unknown>;
  enabled?: boolean;
}): Promise<McpServerItem> {
  const res = await authFetch(`${API_BASE}/mcp/`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  return handleResponse(res, 'Failed to create MCP server');
}

export async function updateMcpServer(
  serverId: string,
  body: {
    name?: string;
    description?: string;
    config?: Record<string, unknown>;
    enabled?: boolean;
  },
): Promise<McpServerItem> {
  const res = await authFetch(`${API_BASE}/mcp/${serverId}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  return handleResponse(res, 'Failed to update MCP server');
}

export async function deleteMcpServer(serverId: string): Promise<void> {
  const res = await authFetch(`${API_BASE}/mcp/${serverId}`, { method: 'DELETE' });
  return handleResponse(res, 'Failed to delete MCP server');
}

export async function setMcpServerEnabled(serverId: string, enabled: boolean): Promise<McpServerItem> {
  const res = await authFetch(`${API_BASE}/mcp/${serverId}/enabled?enabled=${enabled}`, {
    method: 'PATCH',
  });
  return handleResponse(res, 'Failed to toggle MCP server');
}

export async function restartMcpo(): Promise<{ status: string }> {
  const res = await authFetch(`${API_BASE}/mcp/restart`, { method: 'POST' });
  return handleResponse(res, 'Failed to restart mcpo');
}

export async function fetchAgentMcpTools(agentId: string): Promise<McpToolGrant[]> {
  const res = await authFetch(`${API_BASE}/mcp/agents/${agentId}/tools`);
  return handleResponse(res, 'Failed to fetch agent MCP tools');
}

export async function grantMcpServerToAgent(agentId: string, serverId: string): Promise<void> {
  const res = await authFetch(`${API_BASE}/mcp/agents/${agentId}/${serverId}/grant`, {
    method: 'POST',
  });
  return handleResponse(res, 'Failed to grant MCP server to agent');
}

export async function grantMcpToolToAgent(
  agentId: string,
  serverId: string,
  toolName: string,
): Promise<void> {
  const res = await authFetch(
    `${API_BASE}/mcp/agents/${agentId}/${serverId}/${encodeURIComponent(toolName)}/grant`,
    { method: 'POST' },
  );
  return handleResponse(res, 'Failed to grant MCP tool to agent');
}

export async function revokeMcpServerFromAgent(agentId: string, serverId: string): Promise<void> {
  const res = await authFetch(`${API_BASE}/mcp/agents/${agentId}/${serverId}`, { method: 'DELETE' });
  return handleResponse(res, 'Failed to revoke MCP server from agent');
}

export async function revokeMcpToolFromAgent(
  agentId: string,
  serverId: string,
  toolName: string,
): Promise<void> {
  const res = await authFetch(
    `${API_BASE}/mcp/agents/${agentId}/${serverId}/${encodeURIComponent(toolName)}`,
    { method: 'DELETE' },
  );
  return handleResponse(res, 'Failed to revoke MCP tool from agent');
}

export async function startMcpConfigSession(body: {
  agent_id: string;
  model: string;
  input: string;
  input_type?: string;
}): Promise<McpSessionResponse> {
  const res = await authFetch(`${API_BASE}/mcp/configure/session`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  return handleResponse(res, 'Failed to start MCP config session');
}

export async function extractMcpConfig(text: string): Promise<McpExtractResult> {
  const res = await authFetch(`${API_BASE}/mcp/extract`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ text }),
  });
  return handleResponse(res, 'Failed to extract MCP config');
}

// ── System Updates API ────────────────────────────────────────────────────────

export interface UpdateCheckResult {
  current_version: string;
  latest_version: string | null;
  update_available: boolean;
  release_url: string | null;
  release_name: string | null;
  release_body: string | null;
  published_at: string | null;
  checked_at: number;
}

export interface UpdateApplyResult {
  status: string;
  message: string;
  target_version: string;
}

/** Get the cached update check result (refreshed hourly by the server). */
export async function fetchUpdateCheck(): Promise<UpdateCheckResult> {
  const res = await authFetch(`${API_BASE}/system/updates/check`);
  return handleResponse(res, 'Failed to check for updates');
}

/** Force an immediate update check (bypasses cache). */
export async function forceUpdateCheck(): Promise<UpdateCheckResult> {
  const res = await authFetch(`${API_BASE}/system/updates/check`, { method: 'POST' });
  return handleResponse(res, 'Failed to check for updates');
}

/** Trigger a system update. Engine pulls new images and recreates containers. */
export async function applyUpdate(targetVersion?: string): Promise<UpdateApplyResult> {
  const res = await authFetch(`${API_BASE}/system/updates/apply`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ target_version: targetVersion }),
  });
  return handleResponse(res, 'Failed to apply update');
}

// ── Built-in tool overrides ───────────────────────────────────────────────────

export interface ToolOverride {
  agent_id: string;
  tool_name: string;
  /** false = disabled, true = explicitly enabled (rare — absence means enabled) */
  enabled: boolean;
  updated_at: number;
  updated_by: string;
}

/** Fetch all override records for an agent. Absent tools are implicitly enabled. */
export async function fetchToolOverrides(agentId: string): Promise<ToolOverride[]> {
  const res = await authFetch(`${API_BASE}/agents/${agentId}/tools/overrides`);
  return handleResponse(res, 'Failed to fetch tool overrides');
}

/** Bulk-upsert enable/disable states for a list of tools. */
export async function setToolOverrides(
  agentId: string,
  overrides: Array<{ tool_name: string; enabled: boolean }>,
): Promise<ToolOverride[]> {
  const res = await authFetch(`${API_BASE}/agents/${agentId}/tools/overrides`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ overrides }),
  });
  return handleResponse(res, 'Failed to update tool overrides');
}


// ═══════════════════════════════════════════════════════════════════════════
// PROJECT TEMPLATES
// ═══════════════════════════════════════════════════════════════════════════

export interface ProjectTemplateColumn {
  name: string;
  position: number;
  wip_limit: number | null;
  statuses: string[];
}

export interface StatusSemantics {
  initial: string[];
  terminal_done: string[];
  terminal_fail: string[];
  blocked: string[];
  in_progress: string[];
  claimable: string[];
}

export interface ProjectTemplate {
  id: string;
  slug: string;
  name: string;
  description: string;
  icon: string | null;
  isBuiltin: boolean;
  columns: ProjectTemplateColumn[];
  statusSemantics: StatusSemantics;
  defaultPipelineId: string | null;
  onboardingAgentChain: string[] | null;
  metadata: Record<string, any>;
  sortOrder: number;
  createdAt: number;
  updatedAt: number;
}

export async function fetchProjectTemplates(): Promise<ProjectTemplate[]> {
  const res = await authFetch(`${API_BASE}/project-templates/`);
  const data = await handleResponse(res, 'Failed to fetch templates');
  return data.templates ?? data;
}

export async function fetchProjectTemplate(idOrSlug: string): Promise<ProjectTemplate> {
  const res = await authFetch(`${API_BASE}/project-templates/${idOrSlug}`);
  return handleResponse(res, 'Failed to fetch template');
}

export async function createProjectTemplate(data: {
  name: string;
  slug: string;
  description?: string;
  icon?: string;
  columns: ProjectTemplateColumn[];
  statusSemantics: StatusSemantics;
  defaultPipelineId?: string;
  onboardingAgentChain?: string[];
  metadata?: Record<string, any>;
}): Promise<ProjectTemplate> {
  const res = await authFetch(`${API_BASE}/project-templates/`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(data),
  });
  return handleResponse(res, 'Failed to create template');
}

export async function updateProjectTemplate(
  templateId: string,
  data: Partial<{
    name: string;
    description: string;
    icon: string;
    columns: ProjectTemplateColumn[];
    statusSemantics: StatusSemantics;
    defaultPipelineId: string;
    onboardingAgentChain: string[];
    metadata: Record<string, any>;
  }>,
): Promise<ProjectTemplate> {
  const res = await authFetch(`${API_BASE}/project-templates/${templateId}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(data),
  });
  return handleResponse(res, 'Failed to update template');
}

export async function deleteProjectTemplate(templateId: string): Promise<void> {
  const res = await authFetch(`${API_BASE}/project-templates/${templateId}`, {
    method: 'DELETE',
  });
  return handleResponse(res, 'Failed to delete template');
}

export async function cloneProjectTemplate(templateId: string): Promise<ProjectTemplate> {
  const res = await authFetch(`${API_BASE}/project-templates/${templateId}/clone`, {
    method: 'POST',
  });
  return handleResponse(res, 'Failed to clone template');
}


// ═══════════════════════════════════════════════════════════════════════════
// PROJECT-AGENT ROUTINE MAPPINGS
// ═══════════════════════════════════════════════════════════════════════════

export interface RoutineMapping {
  id: string;
  projectId: string;
  agentId: string;
  routineId: string;
  columnIds: string[] | null;
  toolOverrides: string[] | null;
  enabled: boolean;
  createdAt: number;
  updatedAt: number;
  // Enriched fields from list endpoint
  routineName?: string;
  routineDescription?: string | null;
  routineDefaultTools?: string[] | null;
  routineDefaultColumns?: string[] | null;
}

export interface ProjectColumn {
  id: string;
  name: string;
  statuses: string[];
}

export async function fetchRoutineMappings(
  projectId: string,
  agentId: string,
): Promise<{ mappings: RoutineMapping[]; projectColumns: ProjectColumn[] }> {
  const res = await authFetch(`${API_BASE}/projects/${projectId}/agents/${agentId}/routines`);
  return handleResponse(res, 'Failed to fetch routine mappings');
}

export async function createRoutineMapping(
  projectId: string,
  agentId: string,
  data: { routineId: string; columnIds?: string[]; toolOverrides?: string[]; enabled?: boolean },
): Promise<RoutineMapping> {
  const res = await authFetch(`${API_BASE}/projects/${projectId}/agents/${agentId}/routines`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(data),
  });
  return handleResponse(res, 'Failed to create routine mapping');
}

export async function updateRoutineMapping(
  projectId: string,
  agentId: string,
  mappingId: string,
  data: { columnIds?: string[]; toolOverrides?: string[]; enabled?: boolean },
): Promise<RoutineMapping> {
  const res = await authFetch(`${API_BASE}/projects/${projectId}/agents/${agentId}/routines/${mappingId}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(data),
  });
  return handleResponse(res, 'Failed to update routine mapping');
}

export async function deleteRoutineMapping(
  projectId: string,
  agentId: string,
  mappingId: string,
): Promise<void> {
  const res = await authFetch(`${API_BASE}/projects/${projectId}/agents/${agentId}/routines/${mappingId}`, {
    method: 'DELETE',
  });
  return handleResponse(res, 'Failed to delete routine mapping');
}

export interface ResolvedRoutineConfig {
  routineId: string;
  routineName: string;
  mappingId: string;
  effectiveColumns: string[];
  effectiveStatuses: string[];
  effectiveTools: string[] | null;
  planningModel?: string;
  executorModel?: string;
}

export async function resolveRoutineConfigs(
  projectId: string,
  agentId: string,
): Promise<{ resolved: ResolvedRoutineConfig[] }> {
  const res = await authFetch(`${API_BASE}/projects/${projectId}/agents/${agentId}/routines/resolve`);
  return handleResponse(res, 'Failed to resolve routine configs');
}


// ═══════════════════════════════════════════════════════════════════════════
// BOARD-INITIATED SWARM EXECUTION
// ═══════════════════════════════════════════════════════════════════════════

export interface SwarmPreview {
  tasks: Array<{
    key: string;
    title: string;
    status: string;
    priority: string;
    dependencies: string[];
  }>;
  dag_depth: number;
  root_tasks: string[];
  total_tasks: number;
  warnings: string[];
}

export interface BoardSwarmResult {
  swarm_id: string;
  status: string;
  project_id: string;
  total_tasks: number;
  max_concurrent: number;
  root_tasks: string[];
  dag_depth: number;
  warnings: string[];
  tasks: SwarmPreview['tasks'];
  progress_channel: string;
  stream_url: string;
}

export async function previewProjectSwarm(
  projectId: string,
  data: { taskIds: string[]; agentId: string },
): Promise<SwarmPreview> {
  const res = await authFetch(`${API_BASE}/projects/${projectId}/swarm-preview`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(data),
  });
  return handleResponse(res, 'Failed to preview swarm');
}

export async function launchProjectSwarm(
  projectId: string,
  data: {
    taskIds?: string[];
    agentId: string;
    maxConcurrent?: number;
    deviationRules?: string;
    globalTimeoutSeconds?: number;
    model?: string;
  },
): Promise<BoardSwarmResult> {
  const res = await authFetch(`${API_BASE}/projects/${projectId}/swarm-execute`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(data),
  });
  return handleResponse(res, 'Failed to launch swarm');
}

export async function fetchProjectSwarms(
  projectId: string,
): Promise<{ swarms: any[]; project_id: string }> {
  const res = await authFetch(`${API_BASE}/projects/${projectId}/swarms`);
  return handleResponse(res, 'Failed to fetch project swarms');
}

// ── Code Knowledge Graph ────────────────────────────────────────────────────

export async function fetchCodeGraphStatus(projectId: string): Promise<any> {
  const res = await authFetch(`${API_BASE}/projects/${projectId}/knowledge-graph/status`);
  return handleResponse(res, 'Failed to fetch knowledge graph status');
}

export async function triggerCodeGraphIndex(
  projectId: string,
  force = false,
): Promise<{ job_id: string; status: string }> {
  const res = await authFetch(`${API_BASE}/projects/${projectId}/knowledge-graph/index`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ force }),
  });
  return handleResponse(res, 'Failed to start knowledge graph indexing');
}

export async function pollCodeGraphIndexProgress(
  projectId: string,
  jobId: string,
): Promise<any> {
  const res = await authFetch(`${API_BASE}/projects/${projectId}/knowledge-graph/index/${jobId}`);
  return handleResponse(res, 'Failed to poll index progress');
}

export async function fetchCodeGraphData(projectId: string): Promise<any> {
  const res = await authFetch(`${API_BASE}/projects/${projectId}/knowledge-graph/graph-data`);
  return handleResponse(res, 'Failed to fetch graph data');
}

export async function fetchCodeGraphCommunities(projectId: string): Promise<any> {
  const res = await authFetch(`${API_BASE}/projects/${projectId}/knowledge-graph/communities`);
  return handleResponse(res, 'Failed to fetch communities');
}

export async function fetchCodeGraphProcesses(projectId: string): Promise<any> {
  const res = await authFetch(`${API_BASE}/projects/${projectId}/knowledge-graph/processes`);
  return handleResponse(res, 'Failed to fetch processes');
}

export async function fetchCodeGraphSearch(
  projectId: string,
  query: string,
  limit = 20,
): Promise<any> {
  const res = await authFetch(`${API_BASE}/projects/${projectId}/knowledge-graph/query`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ query, limit }),
  });
  return handleResponse(res, 'Failed to search knowledge graph');
}
