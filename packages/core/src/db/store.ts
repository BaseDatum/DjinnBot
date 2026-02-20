import Database from 'better-sqlite3';
import type { PipelineRun, StepExecution, LoopState, LoopItem, KnowledgeEntry } from '../types/state.js';
import type { Task, KanbanColumn } from '../types/project.js';

export interface StoreConfig {
  databasePath: string;
}

export class Store {
  private db: Database.Database;

  constructor(config: StoreConfig) {
    this.db = new Database(config.databasePath);
  }

  initialize(): void {
    // Enable WAL mode for concurrent access from multiple processes
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('busy_timeout = 5000');

    this.db.exec(`
      CREATE TABLE IF NOT EXISTS runs (
        id TEXT PRIMARY KEY,
        pipeline_id TEXT NOT NULL,
        project_id TEXT,
        task_description TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'pending',
        outputs TEXT NOT NULL DEFAULT '{}',
        current_step_id TEXT,
        human_context TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        completed_at INTEGER
      );

      CREATE TABLE IF NOT EXISTS steps (
        id TEXT NOT NULL,
        run_id TEXT NOT NULL,
        step_id TEXT NOT NULL,
        agent_id TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'pending',
        session_id TEXT,
        inputs TEXT NOT NULL DEFAULT '{}',
        outputs TEXT NOT NULL DEFAULT '{}',
        error TEXT,
        retry_count INTEGER NOT NULL DEFAULT 0,
        max_retries INTEGER NOT NULL DEFAULT 3,
        started_at INTEGER,
        completed_at INTEGER,
        human_context TEXT,
        PRIMARY KEY (run_id, step_id)
      );

      CREATE TABLE IF NOT EXISTS loop_state (
        run_id TEXT NOT NULL,
        step_id TEXT NOT NULL,
        items TEXT NOT NULL,
        current_index INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY (run_id, step_id)
      );

      CREATE TABLE IF NOT EXISTS knowledge (
        id TEXT PRIMARY KEY,
        run_id TEXT NOT NULL,
        agent_id TEXT NOT NULL,
        category TEXT NOT NULL,
        content TEXT NOT NULL,
        importance TEXT NOT NULL DEFAULT 'medium',
        created_at INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS outputs (
        run_id TEXT NOT NULL,
        step_id TEXT NOT NULL,
        key TEXT NOT NULL,
        value TEXT NOT NULL,
        PRIMARY KEY (run_id, key)
      );

      CREATE INDEX IF NOT EXISTS idx_runs_pipeline ON runs(pipeline_id);
      CREATE INDEX IF NOT EXISTS idx_steps_run ON steps(run_id);
      CREATE INDEX IF NOT EXISTS idx_knowledge_run ON knowledge(run_id);
      CREATE INDEX IF NOT EXISTS idx_outputs_run ON outputs(run_id);

      -- Project Management Tables --
      CREATE TABLE IF NOT EXISTS projects (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        description TEXT NOT NULL DEFAULT '',
        status TEXT NOT NULL DEFAULT 'active',
        repository TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        completed_at INTEGER
      );

      CREATE TABLE IF NOT EXISTS kanban_columns (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL,
        name TEXT NOT NULL,
        position INTEGER NOT NULL DEFAULT 0,
        wip_limit INTEGER,
        task_statuses TEXT NOT NULL DEFAULT '[]',
        FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE
      );

      CREATE TABLE IF NOT EXISTS tasks (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL,
        title TEXT NOT NULL,
        description TEXT NOT NULL DEFAULT '',
        status TEXT NOT NULL DEFAULT 'backlog',
        priority TEXT NOT NULL DEFAULT 'P2',
        assigned_agent TEXT,
        workflow_id TEXT,
        pipeline_id TEXT,
        run_id TEXT,
        parent_task_id TEXT,
        tags TEXT NOT NULL DEFAULT '[]',
        estimated_hours REAL,
        column_id TEXT NOT NULL,
        column_position INTEGER NOT NULL DEFAULT 0,
        metadata TEXT NOT NULL DEFAULT '{}',
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        completed_at INTEGER,
        FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE,
        FOREIGN KEY (column_id) REFERENCES kanban_columns(id)
      );

      CREATE TABLE IF NOT EXISTS dependency_edges (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL,
        from_task_id TEXT NOT NULL,
        to_task_id TEXT NOT NULL,
        type TEXT NOT NULL DEFAULT 'blocks',
        FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE,
        FOREIGN KEY (from_task_id) REFERENCES tasks(id) ON DELETE CASCADE,
        FOREIGN KEY (to_task_id) REFERENCES tasks(id) ON DELETE CASCADE,
        UNIQUE(from_task_id, to_task_id)
      );

      CREATE TABLE IF NOT EXISTS project_workflows (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL,
        name TEXT NOT NULL,
        pipeline_id TEXT NOT NULL,
        is_default INTEGER NOT NULL DEFAULT 0,
        task_filter TEXT NOT NULL DEFAULT '{}',
        trigger TEXT NOT NULL DEFAULT 'manual',
        FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE
      );

      CREATE TABLE IF NOT EXISTS task_runs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        task_id TEXT NOT NULL,
        run_id TEXT NOT NULL,
        pipeline_id TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'pending',
        started_at INTEGER,
        completed_at INTEGER,
        FOREIGN KEY (task_id) REFERENCES tasks(id) ON DELETE CASCADE
      );

      CREATE INDEX IF NOT EXISTS idx_tasks_project ON tasks(project_id);
      CREATE INDEX IF NOT EXISTS idx_tasks_status ON tasks(status);
      CREATE INDEX IF NOT EXISTS idx_tasks_column ON tasks(column_id);
      CREATE INDEX IF NOT EXISTS idx_deps_project ON dependency_edges(project_id);
      CREATE INDEX IF NOT EXISTS idx_deps_from ON dependency_edges(from_task_id);
      CREATE INDEX IF NOT EXISTS idx_deps_to ON dependency_edges(to_task_id);
      CREATE INDEX IF NOT EXISTS idx_workflows_project ON project_workflows(project_id);
      CREATE INDEX IF NOT EXISTS idx_task_runs_task ON task_runs(task_id);
      CREATE INDEX IF NOT EXISTS idx_kanban_project ON kanban_columns(project_id);
    `);
  }

  // === Runs ===

  createRun(run: Omit<PipelineRun, 'createdAt' | 'updatedAt'>): PipelineRun {
    const now = Date.now();
    const createdRun: PipelineRun = {
      ...run,
      createdAt: now,
      updatedAt: now,
    };

    const stmt = this.db.prepare(`
      INSERT INTO runs (id, pipeline_id, task_description, status, outputs, current_step_id, human_context, created_at, updated_at, completed_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    stmt.run(
      createdRun.id,
      createdRun.pipelineId,
      createdRun.taskDescription,
      createdRun.status,
      JSON.stringify(createdRun.outputs),
      createdRun.currentStepId,
      createdRun.humanContext ?? null,
      createdRun.createdAt,
      createdRun.updatedAt,
      createdRun.completedAt ?? null
    );

    return createdRun;
  }

  getRun(runId: string): PipelineRun | null {
    const stmt = this.db.prepare('SELECT * FROM runs WHERE id = ?');
    const row = stmt.get(runId) as any;
    if (!row) return null;
    return this.mapRunRow(row);
  }

  listRuns(pipelineId?: string): PipelineRun[] {
    let stmt;
    if (pipelineId) {
      stmt = this.db.prepare('SELECT * FROM runs WHERE pipeline_id = ? ORDER BY created_at DESC');
      const rows = stmt.all(pipelineId) as any[];
      return rows.map(row => this.mapRunRow(row));
    } else {
      stmt = this.db.prepare('SELECT * FROM runs ORDER BY created_at DESC');
      const rows = stmt.all() as any[];
      return rows.map(row => this.mapRunRow(row));
    }
  }

  updateRun(runId: string, updates: Partial<PipelineRun>): void {
    const allowedFields = ['pipelineId', 'taskDescription', 'status', 'outputs', 'currentStepId', 'humanContext', 'completedAt'] as const;
    const setClauses: string[] = [];
    const values: any[] = [];

    for (const key of allowedFields) {
      if (key in updates) {
        const sqlField = this.camelToSnake(key);
        setClauses.push(`${sqlField} = ?`);
        const value = updates[key];
        if (key === 'outputs') {
          values.push(JSON.stringify(value));
        } else {
          values.push(value ?? null);
        }
      }
    }

    if (setClauses.length === 0) return;

    setClauses.push('updated_at = ?');
    values.push(Date.now());
    values.push(runId);

    const stmt = this.db.prepare(`
      UPDATE runs SET ${setClauses.join(', ')} WHERE id = ?
    `);
    stmt.run(...values);
  }

  private mapRunRow(row: any): PipelineRun {
    return {
      id: row.id,
      pipelineId: row.pipeline_id,
      projectId: row.project_id || undefined,
      taskDescription: row.task_description,
      status: row.status,
      outputs: JSON.parse(row.outputs),
      currentStepId: row.current_step_id,
      humanContext: row.human_context,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      completedAt: row.completed_at,
    };
  }

  // === Steps ===

  createStep(step: Omit<StepExecution, 'startedAt' | 'completedAt'>): StepExecution {
    const createdStep: StepExecution = {
      ...step,
      startedAt: null,
      completedAt: null,
    };

    const stmt = this.db.prepare(`
      INSERT INTO steps (id, run_id, step_id, agent_id, status, session_id, inputs, outputs, error, retry_count, max_retries, started_at, completed_at, human_context)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    stmt.run(
      createdStep.id,
      createdStep.runId,
      createdStep.stepId,
      createdStep.agentId,
      createdStep.status,
      createdStep.sessionId,
      JSON.stringify(createdStep.inputs),
      JSON.stringify(createdStep.outputs),
      createdStep.error,
      createdStep.retryCount,
      createdStep.maxRetries,
      createdStep.startedAt,
      createdStep.completedAt,
      createdStep.humanContext
    );

    return createdStep;
  }

  getStep(runId: string, stepId: string): StepExecution | null {
    const stmt = this.db.prepare('SELECT * FROM steps WHERE run_id = ? AND step_id = ?');
    const row = stmt.get(runId, stepId) as any;
    if (!row) return null;
    return this.mapStepRow(row);
  }

  listSteps(runId: string): StepExecution[] {
    const stmt = this.db.prepare('SELECT * FROM steps WHERE run_id = ? ORDER BY started_at ASC');
    const rows = stmt.all(runId) as any[];
    return rows.map(row => this.mapStepRow(row));
  }

  updateStep(runId: string, stepId: string, updates: Partial<StepExecution>): void {
    const allowedFields = ['id', 'agentId', 'status', 'sessionId', 'inputs', 'outputs', 'error', 'retryCount', 'maxRetries', 'startedAt', 'completedAt', 'humanContext'] as const;
    const setClauses: string[] = [];
    const values: any[] = [];

    for (const key of allowedFields) {
      if (key in updates) {
        const sqlField = this.camelToSnake(key);
        setClauses.push(`${sqlField} = ?`);
        const value = updates[key];
        if (key === 'inputs' || key === 'outputs') {
          values.push(JSON.stringify(value));
        } else {
          values.push(value ?? null);
        }
      }
    }

    if (setClauses.length === 0) return;

    values.push(runId);
    values.push(stepId);

    const stmt = this.db.prepare(`
      UPDATE steps SET ${setClauses.join(', ')} WHERE run_id = ? AND step_id = ?
    `);
    stmt.run(...values);
  }

  getStepsByStatus(runId: string, status: string): StepExecution[] {
    const stmt = this.db.prepare('SELECT * FROM steps WHERE run_id = ? AND status = ?');
    const rows = stmt.all(runId, status) as any[];
    return rows.map(row => this.mapStepRow(row));
  }

  private mapStepRow(row: any): StepExecution {
    return {
      id: row.id,
      runId: row.run_id,
      stepId: row.step_id,
      agentId: row.agent_id,
      status: row.status,
      sessionId: row.session_id,
      inputs: JSON.parse(row.inputs),
      outputs: JSON.parse(row.outputs),
      error: row.error,
      retryCount: row.retry_count,
      maxRetries: row.max_retries,
      startedAt: row.started_at,
      completedAt: row.completed_at,
      humanContext: row.human_context,
    };
  }

  // === Loop State ===

  createLoopState(state: LoopState): void {
    const stmt = this.db.prepare(`
      INSERT INTO loop_state (run_id, step_id, items, current_index)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(run_id, step_id) DO UPDATE SET
        items = excluded.items,
        current_index = excluded.current_index
    `);

    stmt.run(
      state.runId,
      state.stepId,
      JSON.stringify(state.items),
      state.currentIndex
    );
  }

  getLoopState(runId: string, stepId: string): LoopState | null {
    const stmt = this.db.prepare('SELECT * FROM loop_state WHERE run_id = ? AND step_id = ?');
    const row = stmt.get(runId, stepId) as any;
    if (!row) return null;

    return {
      runId: row.run_id,
      stepId: row.step_id,
      items: JSON.parse(row.items),
      currentIndex: row.current_index,
    };
  }

  updateLoopItem(runId: string, stepId: string, itemId: string, updates: Partial<LoopItem>): void {
    const loopState = this.getLoopState(runId, stepId);
    if (!loopState) return;

    const itemIndex = loopState.items.findIndex(item => item.id === itemId);
    if (itemIndex === -1) return;

    loopState.items[itemIndex] = { ...loopState.items[itemIndex], ...updates };

    const stmt = this.db.prepare(`
      UPDATE loop_state SET items = ? WHERE run_id = ? AND step_id = ?
    `);
    stmt.run(JSON.stringify(loopState.items), runId, stepId);
  }

  advanceLoop(runId: string, stepId: string): LoopItem | null {
    const loopState = this.getLoopState(runId, stepId);
    if (!loopState) return null;

    // Find next pending item after current index
    for (let i = loopState.currentIndex; i < loopState.items.length; i++) {
      const item = loopState.items[i];
      if (item.status === 'pending') {
        // Update current index
        const updateStmt = this.db.prepare(`
          UPDATE loop_state SET current_index = ? WHERE run_id = ? AND step_id = ?
        `);
        updateStmt.run(i, runId, stepId);
        return item;
      }
    }

    return null;
  }

  // === Knowledge ===

  addKnowledge(entry: Omit<KnowledgeEntry, 'id' | 'createdAt'>): KnowledgeEntry {
    const knowledgeEntry: KnowledgeEntry = {
      ...entry,
      id: crypto.randomUUID(),
      createdAt: Date.now(),
    };

    const stmt = this.db.prepare(`
      INSERT INTO knowledge (id, run_id, agent_id, category, content, importance, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `);

    stmt.run(
      knowledgeEntry.id,
      knowledgeEntry.runId,
      knowledgeEntry.agentId,
      knowledgeEntry.category,
      knowledgeEntry.content,
      knowledgeEntry.importance,
      knowledgeEntry.createdAt
    );

    return knowledgeEntry;
  }

  getKnowledge(runId: string, options?: { category?: string; importance?: string }): KnowledgeEntry[] {
    let query = 'SELECT * FROM knowledge WHERE run_id = ?';
    const values: any[] = [runId];

    if (options?.category) {
      query += ' AND category = ?';
      values.push(options.category);
    }

    if (options?.importance) {
      query += ' AND importance = ?';
      values.push(options.importance);
    }

    query += ' ORDER BY created_at DESC';

    const stmt = this.db.prepare(query);
    const rows = stmt.all(...values) as any[];

    return rows.map(row => ({
      id: row.id,
      runId: row.run_id,
      agentId: row.agent_id,
      category: row.category,
      content: row.content,
      importance: row.importance,
      createdAt: row.created_at,
    }));
  }

  // === Accumulated Outputs ===

  setOutput(runId: string, stepId: string, key: string, value: string): void {
    const stmt = this.db.prepare(`
      INSERT INTO outputs (run_id, step_id, key, value)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(run_id, key) DO UPDATE SET
        step_id = excluded.step_id,
        value = excluded.value
    `);

    stmt.run(runId, stepId, key, value);
  }

  getOutputs(runId: string): Record<string, string> {
    const stmt = this.db.prepare('SELECT key, value FROM outputs WHERE run_id = ?');
    const rows = stmt.all(runId) as any[];

    const outputs: Record<string, string> = {};
    for (const row of rows) {
      outputs[row.key] = row.value;
    }
    return outputs;
  }

  getStepOutputs(runId: string, stepId: string): Record<string, string> {
    const stmt = this.db.prepare('SELECT key, value FROM outputs WHERE run_id = ? AND step_id = ?');
    const rows = stmt.all(runId, stepId) as any[];

    const outputs: Record<string, string> = {};
    for (const row of rows) {
      outputs[row.key] = row.value;
    }
    return outputs;
  }

  // === Project Management - Tasks ===

  /**
   * Get task by active run_id (for TaskRunTracker)
   */
  getTaskByRunId(runId: string): Task | null {
    const stmt = this.db.prepare('SELECT * FROM tasks WHERE run_id = ?');
    const row = stmt.get(runId) as any;
    if (!row) return null;
    return this.deserializeTask(row);
  }

  /**
   * Update task fields
   */
  updateTask(projectId: string, taskId: string, updates: Partial<Task>): void {
    const allowedFields = ['title', 'description', 'status', 'priority', 'assignedAgent', 
      'workflowId', 'pipelineId', 'runId', 'parentTaskId', 'tags', 'estimatedHours', 
      'columnId', 'columnPosition', 'metadata', 'completedAt', 'updatedAt'] as const;
    
    const setClauses: string[] = [];
    const values: any[] = [];

    for (const key of allowedFields) {
      if (key in updates) {
        const sqlField = this.camelToSnake(key);
        setClauses.push(`${sqlField} = ?`);
        const value = updates[key as keyof typeof updates];
        
        if (key === 'tags') {
          values.push(JSON.stringify(value));
        } else if (key === 'metadata') {
          values.push(JSON.stringify(value));
        } else {
          values.push(value ?? null);
        }
      }
    }

    if (setClauses.length === 0) return;

    // Always update updated_at
    if (!('updatedAt' in updates)) {
      setClauses.push('updated_at = ?');
      values.push(Date.now());
    }

    values.push(taskId);

    const stmt = this.db.prepare(`
      UPDATE tasks SET ${setClauses.join(', ')} WHERE id = ?
    `);
    stmt.run(...values);
  }

  /**
   * Update task_runs record
   */
  updateTaskRun(taskId: string, runId: string, updates: { status?: string; completedAt?: number; error?: string }): void {
    const setClauses: string[] = [];
    const values: any[] = [];

    if (updates.status !== undefined) {
      setClauses.push('status = ?');
      values.push(updates.status);
    }
    if (updates.completedAt !== undefined) {
      setClauses.push('completed_at = ?');
      values.push(updates.completedAt);
    }

    if (setClauses.length === 0) return;

    values.push(taskId, runId);

    const stmt = this.db.prepare(`
      UPDATE task_runs SET ${setClauses.join(', ')} WHERE task_id = ? AND run_id = ?
    `);
    stmt.run(...values);
  }

  /**
   * Get columns for a project
   */
  getColumnsByProject(projectId: string): KanbanColumn[] {
    const stmt = this.db.prepare('SELECT * FROM kanban_columns WHERE project_id = ? ORDER BY position ASC');
    const rows = stmt.all(projectId) as any[];
    
    return rows.map(row => ({
      id: row.id,
      projectId: row.project_id,
      name: row.name,
      position: row.position,
      wipLimit: row.wip_limit,
      taskStatuses: JSON.parse(row.task_statuses),
    }));
  }

  /**
   * Move task to a different column and position
   */
  moveTask(projectId: string, taskId: string, columnId: string, position: number): void {
    const stmt = this.db.prepare(`
      UPDATE tasks 
      SET column_id = ?, column_position = ?, updated_at = ?
      WHERE id = ? AND project_id = ?
    `);
    stmt.run(columnId, position, Date.now(), taskId, projectId);
  }

  /**
   * Get project repository URL from database.
   */
  getProjectRepository(projectId: string): string | null {
    const stmt = this.db.prepare('SELECT repository FROM projects WHERE id = ?');
    const row = stmt.get(projectId) as any;
    return row?.repository || null;
  }

  /**
   * Recompute task readiness after a task's status changes.
   *
   * When newStatus === 'done':
   *   - Find all tasks that have a 'blocks' edge FROM taskId
   *   - For each dependent task, check if ALL its blocking deps are now 'done'
   *   - If yes, transition that task to 'ready' and move it to the Ready column
   *
   * When newStatus === 'failed':
   *   - Recursively cascade 'blocked' to all downstream dependents
   *   - Move them to the Blocked column (or Failed column as fallback)
   */
  async recomputeTaskReadiness(projectId: string, taskId: string, newStatus: string): Promise<void> {
    console.log(`[Store] recomputeTaskReadiness: task=${taskId} newStatus=${newStatus}`);

    const columns = this.getColumnsByProject(projectId);

    if (newStatus === 'done') {
      // Find tasks that depend on the completed task (to_task_id = deps that must be done first)
      const dependentStmt = this.db.prepare(
        `SELECT to_task_id FROM dependency_edges WHERE from_task_id = ? AND project_id = ? AND type = 'blocks'`
      );
      const dependentRows = dependentStmt.all(taskId, projectId) as Array<{ to_task_id: string }>;

      for (const { to_task_id } of dependentRows) {
        // Get current status of this dependent task
        const taskRow = this.db.prepare(`SELECT status FROM tasks WHERE id = ?`).get(to_task_id) as any;
        if (!taskRow || !['backlog', 'planning', 'blocked'].includes(taskRow.status)) continue;

        // Check if ALL blocking deps for this task are now 'done'
        const blockingStmt = this.db.prepare(
          `SELECT t.status FROM dependency_edges de
           JOIN tasks t ON de.from_task_id = t.id
           WHERE de.to_task_id = ? AND de.type = 'blocks'`
        );
        const blockingRows = blockingStmt.all(to_task_id) as Array<{ status: string }>;
        const allDone = blockingRows.length === 0 || blockingRows.every(r => r.status === 'done');

        if (allDone) {
          const readyCol = columns.find(c => c.taskStatuses.includes('ready'));
          if (readyCol) {
            this.db.prepare(
              `UPDATE tasks SET status = 'ready', column_id = ?, updated_at = ? WHERE id = ?`
            ).run(readyCol.id, Date.now(), to_task_id);
            console.log(`[Store] Unblocked task ${to_task_id} → ready`);
          }
        }
      }
    } else if (newStatus === 'failed') {
      // Recursively cascade 'blocked' to all downstream dependents
      const blockedCol = columns.find(c => c.taskStatuses.includes('blocked'))
        || columns.find(c => c.taskStatuses.includes('failed'));

      const visited = new Set<string>();
      const cascade = (fromId: string) => {
        const rows = this.db.prepare(
          `SELECT to_task_id FROM dependency_edges WHERE from_task_id = ? AND project_id = ? AND type = 'blocks'`
        ).all(fromId, projectId) as Array<{ to_task_id: string }>;

        for (const { to_task_id } of rows) {
          if (visited.has(to_task_id)) continue;
          visited.add(to_task_id);

          const taskRow = this.db.prepare(`SELECT status FROM tasks WHERE id = ?`).get(to_task_id) as any;
          if (!taskRow || taskRow.status === 'done' || taskRow.status === 'failed') continue;

          if (blockedCol) {
            this.db.prepare(
              `UPDATE tasks SET status = 'blocked', column_id = ?, updated_at = ? WHERE id = ?`
            ).run(blockedCol.id, Date.now(), to_task_id);
            console.log(`[Store] Cascade blocked task ${to_task_id}`);
          }
          cascade(to_task_id);
        }
      };
      cascade(taskId);
    }
  }

  /**
   * Deserialize task row from database
   */
  private deserializeTask(row: any): Task {
    return {
      id: row.id,
      projectId: row.project_id,
      title: row.title,
      description: row.description,
      status: row.status,
      priority: row.priority,
      assignedAgent: row.assigned_agent,
      workflowId: row.workflow_id,
      pipelineId: row.pipeline_id,
      runId: row.run_id,
      parentTaskId: row.parent_task_id,
      tags: JSON.parse(row.tags),
      estimatedHours: row.estimated_hours,
      columnId: row.column_id,
      columnPosition: row.column_position,
      metadata: JSON.parse(row.metadata),
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      completedAt: row.completed_at,
    };
  }

  close(): void {
    this.db.close();
  }

  private camelToSnake(str: string): string {
    return str.replace(/[A-Z]/g, letter => `_${letter.toLowerCase()}`);
  }
}
