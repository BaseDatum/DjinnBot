import type { DependencyEdge, Task, TaskStatus, DependencyType } from '../types/project.js';

export interface DependencyGraph {
  edges: DependencyEdge[];
  taskIds: Set<string>;
}

export class DependencyResolver {
  
  /**
   * Check if adding edge (from → to) would create a cycle.
   * Returns null if safe, or the cycle path as string[] if it would create a cycle.
   */
  static detectCycle(
    edges: DependencyEdge[],
    newFrom: string,
    newTo: string
  ): string[] | null {
    // Build adjacency list including the proposed new edge
    const adj = new Map<string, string[]>();
    
    for (const edge of edges) {
      if (!adj.has(edge.fromTaskId)) adj.set(edge.fromTaskId, []);
      adj.get(edge.fromTaskId)!.push(edge.toTaskId);
    }
    
    // Add proposed edge
    if (!adj.has(newFrom)) adj.set(newFrom, []);
    adj.get(newFrom)!.push(newTo);
    
    // DFS from newTo — if we can reach newFrom, there's a cycle
    const visited = new Set<string>();
    const path: string[] = [];
    
    function dfs(node: string): boolean {
      if (node === newFrom) {
        path.push(node);
        return true; // Found cycle
      }
      if (visited.has(node)) return false;
      visited.add(node);
      path.push(node);
      
      for (const neighbor of (adj.get(node) || [])) {
        if (dfs(neighbor)) return true;
      }
      
      path.pop();
      return false;
    }
    
    if (dfs(newTo)) {
      return path; // The cycle path
    }
    
    return null; // No cycle
  }
  
  /**
   * Topological sort of all tasks. Returns ordered task IDs.
   * Throws if graph contains a cycle (shouldn't happen if we validate on add).
   */
  static topologicalSort(taskIds: string[], edges: DependencyEdge[]): string[] {
    const inDegree = new Map<string, number>();
    const adj = new Map<string, string[]>();
    
    for (const id of taskIds) {
      inDegree.set(id, 0);
      adj.set(id, []);
    }
    
    for (const edge of edges) {
      adj.get(edge.fromTaskId)?.push(edge.toTaskId);
      inDegree.set(edge.toTaskId, (inDegree.get(edge.toTaskId) || 0) + 1);
    }
    
    // Kahn's algorithm
    const queue: string[] = [];
    for (const [id, degree] of Array.from(inDegree.entries())) {
      if (degree === 0) queue.push(id);
    }
    
    const sorted: string[] = [];
    while (queue.length > 0) {
      const node = queue.shift()!;
      sorted.push(node);
      
      for (const neighbor of (adj.get(node) || [])) {
        const newDegree = (inDegree.get(neighbor) || 1) - 1;
        inDegree.set(neighbor, newDegree);
        if (newDegree === 0) queue.push(neighbor);
      }
    }
    
    if (sorted.length !== taskIds.length) {
      throw new Error('Dependency graph contains a cycle');
    }
    
    return sorted;
  }
  
  /**
   * Get all tasks that are "ready" — all hard dependencies (type: 'blocks') are done.
   */
  static getReadyTasks(
    tasks: Map<string, Task>,
    edges: DependencyEdge[]
  ): string[] {
    const ready: string[] = [];
    
    for (const [taskId, task] of Array.from(tasks.entries())) {
      // Only consider tasks in backlog or planning status
      if (task.status !== 'backlog' && task.status !== 'planning') continue;
      
      // Check all hard dependencies
      const blockingDeps = edges.filter(e => e.toTaskId === taskId && e.type === 'blocks');
      const allDepsReady = blockingDeps.every(dep => {
        const depTask = tasks.get(dep.fromTaskId);
        return depTask && depTask.status === 'done';
      });
      
      if (allDepsReady) {
        ready.push(taskId);
      }
    }
    
    return ready;
  }
  
  /**
   * Get tasks that should be blocked because a dependency failed.
   * Returns task IDs that need to be moved to 'blocked' status.
   */
  static getCascadeBlocked(
    taskId: string,
    tasks: Map<string, Task>,
    edges: DependencyEdge[]
  ): string[] {
    const blocked: string[] = [];
    const visited = new Set<string>();
    
    function cascade(fromId: string) {
      const dependents = edges.filter(e => e.fromTaskId === fromId && e.type === 'blocks');
      for (const dep of dependents) {
        if (visited.has(dep.toTaskId)) continue;
        visited.add(dep.toTaskId);
        
        const task = tasks.get(dep.toTaskId);
        if (task && task.status !== 'done' && task.status !== 'failed') {
          blocked.push(dep.toTaskId);
          // Cascade further
          cascade(dep.toTaskId);
        }
      }
    }
    
    cascade(taskId);
    return blocked;
  }
  
  /**
   * Compute the critical path (longest chain to completion).
   * Returns the ordered list of task IDs on the critical path.
   */
  static criticalPath(
    tasks: Map<string, Task>,
    edges: DependencyEdge[]
  ): string[] {
    const taskIds = Array.from(tasks.keys());
    const sorted = this.topologicalSort(taskIds, edges.filter(e => e.type === 'blocks'));
    
    // Longest path in DAG using dynamic programming
    const dist = new Map<string, number>();
    const prev = new Map<string, string | null>();
    
    for (const id of taskIds) {
      dist.set(id, 0);
      prev.set(id, null);
    }
    
    for (const node of sorted) {
      const currentDist = dist.get(node) || 0;
      const neighbors = edges.filter(e => e.fromTaskId === node && e.type === 'blocks');
      
      for (const edge of neighbors) {
        const neighborDist = dist.get(edge.toTaskId) || 0;
        const newDist = currentDist + (tasks.get(edge.toTaskId)?.estimatedHours || 1);
        if (newDist > neighborDist) {
          dist.set(edge.toTaskId, newDist);
          prev.set(edge.toTaskId, node);
        }
      }
    }
    
    // Find the end of the critical path (node with max distance)
    let maxDist = 0;
    let maxNode: string | null = null;
    for (const [id, d] of Array.from(dist.entries())) {
      if (d > maxDist) {
        maxDist = d;
        maxNode = id;
      }
    }
    
    if (!maxNode) return [];
    
    // Trace back
    const path: string[] = [];
    let current: string | null = maxNode;
    while (current) {
      path.unshift(current);
      current = prev.get(current) || null;
    }
    
    return path;
  }

  /**
   * Validate an entire dependency graph (used for bulk imports from AI planner).
   * Returns null if valid, or error message if invalid.
   */
  static validateGraph(
    taskIds: string[],
    edges: Array<{ from: string; to: string; type: DependencyType }>
  ): string | null {
    // Check all referenced tasks exist
    const idSet = new Set(taskIds);
    for (const edge of edges) {
      if (!idSet.has(edge.from)) return `Dependency references unknown task: ${edge.from}`;
      if (!idSet.has(edge.to)) return `Dependency references unknown task: ${edge.to}`;
      if (edge.from === edge.to) return `Task cannot depend on itself: ${edge.from}`;
    }
    
    // Check for cycles using topological sort
    const fullEdges: DependencyEdge[] = edges.map((e, i) => ({
      id: `validate_${i}`,
      projectId: 'validate',
      fromTaskId: e.from,
      toTaskId: e.to,
      type: e.type,
    }));
    
    try {
      this.topologicalSort(taskIds, fullEdges);
    } catch {
      return 'Dependency graph contains a cycle';
    }
    
    return null;
  }
}
