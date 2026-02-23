# Swarm Autopilot — Technical Design Document

**Author:** AI Architect  
**Status:** Draft  
**Date:** 2026-02-23  
**Components:** `packages/core`, `packages/server`, `packages/dashboard`

---

## 1. Problem Statement

DjinnBot's planning pipeline (`planning.yml`) generates a structured subtask DAG with explicit dependencies, priorities, estimated hours, and tags. The `DependencyResolver` can topologically sort these, compute critical paths, and cascade readiness. The `SwarmSessionManager` can execute DAGs in parallel with configurable concurrency, dependency cascading, and real-time progress streaming.

**These two systems are not connected.**

After planning completes, subtasks enter the kanban board and are executed sequentially by pulse agents waking up every 30 minutes. A project with 30 subtasks where 12 have no cross-dependencies still takes 12+ pulse cycles (~6 hours wall-clock), even though those 12 tasks could run simultaneously in ~45 minutes.

Additionally, every task uses the same LLM model (from `config.yml` or pipeline YAML defaults), regardless of complexity. A trivial config rename burns the same API budget as a complex architectural refactor.

### Quantified Impact

| Metric | Before (Pulse) | After (Autopilot) | Improvement |
|---|---|---|---|
| 30-task project, 5 waves of 6 | ~15h wall-clock | ~2.5h | **6x faster** |
| API cost (40% trivial tasks) | $X (uniform model) | ~0.4X | **~60% savings** |
| Human intervention required | Choose pipeline per task | Toggle once per project | **Near-zero** |

---

## 2. Design Overview

Swarm Autopilot is a new module that bridges planning output to swarm execution. It:

1. **Listens** for completed planning runs that produce `final_subtasks_json`
2. **Analyzes** the dependency graph to compute parallelizable waves
3. **Assigns** model tiers to each task based on characteristics
4. **Dispatches** each wave as a `SwarmRequest` through the existing `SwarmSessionManager`
5. **Chains** waves sequentially — wave N+1 starts when wave N completes
6. **Reports** progress through existing Redis pub/sub and SSE channels

```
Planning Pipeline                    Swarm Autopilot                 SwarmSessionManager
                                                                      
final_subtasks_json ───────────►  Wave Analysis  ─────────────────►  Wave 1 (3 concurrent)
                                  Model Tiering                        │ task A (gpt-4o-mini)
                                  Agent Assignment                     │ task B (claude-sonnet)
                                                                       │ task C (gpt-4o-mini)
                                                                       ▼
                                                  ◄── wave:completed ──
                                                                      
                                  Dispatch Wave 2 ─────────────────►  Wave 2 (3 concurrent)
                                                                       │ task D (claude-opus)
                                                                       │ task E (kimi-k2.5)
                                                                       │ task F (gpt-4o-mini)
                                                                       ▼
                                                                    ... until all waves done
```

---

## 3. Core Engine Module

### 3.1 New File: `packages/core/src/runtime/swarm-autopilot.ts`

```typescript
/**
 * SwarmAutopilot — Converts a planning DAG into a sequence of parallel
 * swarm waves, with per-task model tiering and agent assignment.
 */

export interface AutopilotConfig {
  /** Max concurrent executors per wave (default: 3, max: 8) */
  maxConcurrent: number;
  /** Model tier configuration */
  modelTiers: ModelTierConfig;
  /** Default agent for execution (typically "yukihiro") */
  defaultAgentId: string;
  /** Global timeout per executor in seconds */
  executorTimeoutSeconds: number;
  /** Deviation rules injected into every executor */
  deviationRules: string;
}

export interface ModelTierConfig {
  /** Tier 1: trivial tasks (config, docs, rename, typo). Cheap + fast. */
  tier1: string;  // e.g. "openrouter/openai/gpt-4o-mini"
  /** Tier 2: standard tasks (backend, frontend, api, testing). Balanced. */
  tier2: string;  // e.g. "openrouter/moonshotai/kimi-k2.5"
  /** Tier 3: complex tasks (architecture, security, refactor). Strong reasoning. */
  tier3: string;  // e.g. "xai/grok-4-1-fast-reasoning"
}

export interface WaveAnalysis {
  /** Ordered waves — each wave is a set of independent tasks */
  waves: WaveGroup[];
  /** Task IDs on the critical path */
  criticalPath: string[];
  /** Total estimated hours */
  totalEstimatedHours: number;
  /** Estimated wall-clock hours (critical path only) */
  estimatedWallClockHours: number;
  /** Parallelization factor (total hours / wall-clock hours) */
  parallelizationFactor: number;
}

export interface WaveGroup {
  /** Wave index (0-based) */
  index: number;
  /** Tasks in this wave (all independent of each other) */
  tasks: WaveTask[];
  /** Task IDs from prior waves that this wave depends on */
  dependsOnWaves: number[];
}

export interface WaveTask {
  /** Task ID from the kanban */
  taskId: string;
  /** Task title */
  title: string;
  /** Task description (becomes execution prompt base) */
  description: string;
  /** Assigned model tier (1, 2, or 3) */
  modelTier: 1 | 2 | 3;
  /** Resolved model string */
  model: string;
  /** Estimated hours */
  estimatedHours: number;
  /** Task tags */
  tags: string[];
  /** Priority */
  priority: string;
  /** Project ID */
  projectId: string;
}
```

### 3.2 Wave Computation Algorithm

Uses existing `DependencyResolver.topologicalSort()` extended with wave grouping:

```typescript
/**
 * Compute parallelizable waves from a dependency DAG.
 *
 * Algorithm: Modified Kahn's algorithm that groups tasks by their
 * "dependency depth" — tasks at the same depth have no mutual
 * dependencies and can run concurrently.
 *
 * Complexity: O(V + E) where V = tasks, E = dependency edges.
 */
export function computeWaves(
  tasks: Array<{ id: string; dependencies: string[] }>,
): string[][] {
  // Build in-degree map
  const inDegree = new Map<string, number>();
  const adj = new Map<string, string[]>();  // forward edges
  const reverseAdj = new Map<string, string[]>();  // for depth tracking

  for (const t of tasks) {
    inDegree.set(t.id, 0);
    adj.set(t.id, []);
    reverseAdj.set(t.id, []);
  }
  for (const t of tasks) {
    for (const dep of t.dependencies) {
      adj.get(dep)?.push(t.id);
      reverseAdj.get(t.id)?.push(dep);
      inDegree.set(t.id, (inDegree.get(t.id) || 0) + 1);
    }
  }

  // BFS by depth level — each level is one wave
  const waves: string[][] = [];
  let currentWave = [...inDegree.entries()]
    .filter(([, deg]) => deg === 0)
    .map(([id]) => id);

  while (currentWave.length > 0) {
    waves.push(currentWave);
    const nextWave: string[] = [];

    for (const taskId of currentWave) {
      for (const dependent of (adj.get(taskId) || [])) {
        const newDeg = (inDegree.get(dependent) || 1) - 1;
        inDegree.set(dependent, newDeg);
        if (newDeg === 0) {
          nextWave.push(dependent);
        }
      }
    }

    currentWave = nextWave;
  }

  return waves;
}
```

### 3.3 Model Tier Assignment

```typescript
/** Tag sets that indicate task complexity */
const TIER1_TAGS = new Set([
  'config', 'docs', 'documentation', 'rename', 'typo', 'cleanup',
  'formatting', 'lint', 'ci', 'devops', 'chore',
]);

const TIER3_TAGS = new Set([
  'architecture', 'security', 'refactor', 'performance', 'database',
  'migration', 'auth', 'encryption', 'infrastructure',
]);

export function assignModelTier(task: {
  estimatedHours: number | null;
  tags: string[];
  priority: string;
}): 1 | 2 | 3 {
  const hours = task.estimatedHours ?? 2;
  const tags = new Set(task.tags.map(t => t.toLowerCase()));

  // P0 tasks always get tier 3 (highest quality)
  if (task.priority === 'P0') return 3;

  // Check tag overlap
  const hasTier1Tags = [...tags].some(t => TIER1_TAGS.has(t));
  const hasTier3Tags = [...tags].some(t => TIER3_TAGS.has(t));

  // Short + trivial tags → tier 1
  if (hours <= 1 && hasTier1Tags) return 1;

  // Long + complex tags → tier 3
  if (hours >= 3 || hasTier3Tags) return 3;

  // Everything else → tier 2
  return 2;
}
```

### 3.4 Execution Prompt Generation

Each task's description is wrapped in a standardized execution prompt that includes project vision context:

```typescript
export function buildExecutionPrompt(
  task: WaveTask,
  projectVision: string,
  waveIndex: number,
  totalWaves: number,
): string {
  return [
    `# Task: ${task.title}`,
    ``,
    `## Project Context`,
    projectVision.slice(0, 2000),  // Cap at 2k chars
    ``,
    `## Wave ${waveIndex + 1} of ${totalWaves}`,
    `This task is part of an automated parallel execution wave.`,
    `Other tasks are running concurrently — do NOT modify files`,
    `outside your task's scope.`,
    ``,
    `## What To Build`,
    task.description,
    ``,
    `## Instructions`,
    `1. Read the relevant existing code first`,
    `2. Implement the changes described above`,
    `3. Write or update tests`,
    `4. Commit with message: "feat(${task.taskId}): <description>"`,
    `5. Verify acceptance criteria are met`,
  ].join('\n');
}
```

### 3.5 Autopilot Session Orchestrator

The top-level orchestrator that chains waves:

```typescript
export class SwarmAutopilot {
  constructor(
    private deps: {
      swarmManager: SwarmSessionManager;
      publishProgress: (autopilotId: string, event: AutopilotEvent) => Promise<void>;
      persistState: (autopilotId: string, state: AutopilotSessionState) => Promise<void>;
      getProjectVision: (projectId: string) => Promise<string>;
    },
    private config: AutopilotConfig,
  ) {}

  async execute(
    autopilotId: string,
    projectId: string,
    analysis: WaveAnalysis,
    tasks: WaveTask[],
  ): Promise<AutopilotResult> {
    const vision = await this.deps.getProjectVision(projectId);
    const taskMap = new Map(tasks.map(t => [t.taskId, t]));

    const waveResults: WaveResult[] = [];

    for (const wave of analysis.waves) {
      // Build SwarmRequest for this wave
      const swarmTasks: SwarmTaskDef[] = wave.tasks.map(wt => ({
        key: wt.taskId,
        title: wt.title,
        projectId: wt.projectId,
        taskId: wt.taskId,
        executionPrompt: buildExecutionPrompt(
          wt, vision, wave.index, analysis.waves.length
        ),
        dependencies: [],  // Within a wave, all tasks are independent
        model: wt.model,
        timeoutSeconds: this.config.executorTimeoutSeconds,
      }));

      const swarmId = `${autopilotId}_wave_${wave.index}`;

      // Publish wave start
      await this.deps.publishProgress(autopilotId, {
        type: 'autopilot:wave_started',
        autopilotId,
        waveIndex: wave.index,
        totalWaves: analysis.waves.length,
        taskCount: wave.tasks.length,
        timestamp: Date.now(),
      });

      // Dispatch via existing SwarmSessionManager
      const swarmState = await this.deps.swarmManager.startSwarm(swarmId, {
        agentId: this.config.defaultAgentId,
        tasks: swarmTasks,
        maxConcurrent: this.config.maxConcurrent,
        deviationRules: this.config.deviationRules,
        globalTimeoutSeconds: this.config.executorTimeoutSeconds * wave.tasks.length,
      });

      // Wait for swarm completion (poll state)
      const result = await this.waitForSwarm(swarmId);
      waveResults.push({
        waveIndex: wave.index,
        swarmId,
        ...result,
      });

      // Publish wave complete
      await this.deps.publishProgress(autopilotId, {
        type: 'autopilot:wave_completed',
        autopilotId,
        waveIndex: wave.index,
        completed: result.completed,
        failed: result.failed,
        skipped: result.skipped,
        durationMs: result.durationMs,
        timestamp: Date.now(),
      });

      // If wave had critical failures, decide whether to continue
      if (result.failed > 0 && wave.index < analysis.waves.length - 1) {
        // Continue with remaining waves — failed tasks' dependents
        // will be auto-skipped by the next wave's dependency check
      }
    }

    return { autopilotId, projectId, waveResults };
  }

  private async waitForSwarm(swarmId: string): Promise<SwarmSummary> {
    // Poll SwarmSessionManager.getSwarmState() every 2.5s
    // until terminal state (completed | failed | cancelled)
    // ... implementation mirrors existing swarm polling pattern
  }
}
```

---

## 4. Database Schema Changes

### 4.1 New Table: `autopilot_sessions`

```sql
CREATE TABLE autopilot_sessions (
    id              VARCHAR(64)  PRIMARY KEY,
    project_id      VARCHAR(64)  NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    status          VARCHAR(32)  NOT NULL DEFAULT 'pending',
        -- pending | analyzing | running | completed | failed | cancelled
    planning_run_id VARCHAR(64),          -- The planning run that produced the DAG
    total_tasks     INTEGER      NOT NULL DEFAULT 0,
    total_waves     INTEGER      NOT NULL DEFAULT 0,
    current_wave    INTEGER      NOT NULL DEFAULT 0,
    completed_tasks INTEGER      NOT NULL DEFAULT 0,
    failed_tasks    INTEGER      NOT NULL DEFAULT 0,
    config          TEXT         NOT NULL DEFAULT '{}',  -- JSON: AutopilotConfig snapshot
    wave_analysis   TEXT,                                -- JSON: WaveAnalysis snapshot
    model_tier_map  TEXT,                                -- JSON: { taskId: { tier, model } }
    cost_estimate   TEXT,                                -- JSON: { tier1Count, tier2Count, ... }
    created_at      BIGINT       NOT NULL,
    updated_at      BIGINT       NOT NULL,
    completed_at    BIGINT
);

CREATE INDEX idx_autopilot_project ON autopilot_sessions(project_id);
CREATE INDEX idx_autopilot_status ON autopilot_sessions(status);
```

### 4.2 New Table: `autopilot_waves`

```sql
CREATE TABLE autopilot_waves (
    id              VARCHAR(64)  PRIMARY KEY,
    autopilot_id    VARCHAR(64)  NOT NULL REFERENCES autopilot_sessions(id) ON DELETE CASCADE,
    wave_index      INTEGER      NOT NULL,
    swarm_id        VARCHAR(64),          -- Linked SwarmSession ID
    status          VARCHAR(32)  NOT NULL DEFAULT 'pending',
    task_count      INTEGER      NOT NULL DEFAULT 0,
    completed_count INTEGER      NOT NULL DEFAULT 0,
    failed_count    INTEGER      NOT NULL DEFAULT 0,
    started_at      BIGINT,
    completed_at    BIGINT,
    duration_ms     BIGINT
);

CREATE INDEX idx_autopilot_waves_session ON autopilot_waves(autopilot_id);
```

### 4.3 Project Table Addition

Add one column to the existing `projects` table:

```sql
ALTER TABLE projects ADD COLUMN autopilot_config TEXT;
-- JSON blob: { enabled, maxConcurrent, modelTiers, ... }
-- NULL = autopilot disabled (default)
```

### 4.4 SQLAlchemy Model: `packages/server/app/models/autopilot.py`

```python
"""Swarm Autopilot models."""
from typing import Optional
from sqlalchemy import String, Text, Integer, BigInteger, ForeignKey, Index
from sqlalchemy.orm import Mapped, mapped_column, relationship
from app.models.base import Base

class AutopilotSession(Base):
    __tablename__ = "autopilot_sessions"
    __table_args__ = (
        Index("idx_autopilot_project", "project_id"),
        Index("idx_autopilot_status", "status"),
    )

    id: Mapped[str] = mapped_column(String(64), primary_key=True)
    project_id: Mapped[str] = mapped_column(
        String(64), ForeignKey("projects.id", ondelete="CASCADE"), nullable=False
    )
    status: Mapped[str] = mapped_column(String(32), nullable=False, default="pending")
    planning_run_id: Mapped[Optional[str]] = mapped_column(String(64), nullable=True)
    total_tasks: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    total_waves: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    current_wave: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    completed_tasks: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    failed_tasks: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    config: Mapped[str] = mapped_column(Text, nullable=False, default="{}")
    wave_analysis: Mapped[Optional[str]] = mapped_column(Text, nullable=True)
    model_tier_map: Mapped[Optional[str]] = mapped_column(Text, nullable=True)
    cost_estimate: Mapped[Optional[str]] = mapped_column(Text, nullable=True)
    created_at: Mapped[int] = mapped_column(BigInteger, nullable=False)
    updated_at: Mapped[int] = mapped_column(BigInteger, nullable=False)
    completed_at: Mapped[Optional[int]] = mapped_column(BigInteger, nullable=True)

    waves: Mapped[list["AutopilotWave"]] = relationship(
        back_populates="session", cascade="all, delete-orphan",
        order_by="AutopilotWave.wave_index",
    )

class AutopilotWave(Base):
    __tablename__ = "autopilot_waves"
    __table_args__ = (Index("idx_autopilot_waves_session", "autopilot_id"),)

    id: Mapped[str] = mapped_column(String(64), primary_key=True)
    autopilot_id: Mapped[str] = mapped_column(
        String(64), ForeignKey("autopilot_sessions.id", ondelete="CASCADE"), nullable=False
    )
    wave_index: Mapped[int] = mapped_column(Integer, nullable=False)
    swarm_id: Mapped[Optional[str]] = mapped_column(String(64), nullable=True)
    status: Mapped[str] = mapped_column(String(32), nullable=False, default="pending")
    task_count: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    completed_count: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    failed_count: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    started_at: Mapped[Optional[int]] = mapped_column(BigInteger, nullable=True)
    completed_at: Mapped[Optional[int]] = mapped_column(BigInteger, nullable=True)
    duration_ms: Mapped[Optional[int]] = mapped_column(BigInteger, nullable=True)

    session: Mapped["AutopilotSession"] = relationship(back_populates="waves")
```

---

## 5. Server API Endpoints

### 5.1 New Router: `packages/server/app/routers/autopilot.py`

```
POST   /v1/projects/{project_id}/autopilot/analyze
  → Dry-run: compute waves + model tiers + cost estimate from current task DAG
  → Returns: WaveAnalysis + cost breakdown (no execution)

POST   /v1/projects/{project_id}/autopilot/launch
  → Execute: create AutopilotSession, dispatch wave 1
  → Body: { planning_run_id?, config_overrides? }
  → Returns: { autopilot_id, waves, estimated_duration }

GET    /v1/projects/{project_id}/autopilot/{autopilot_id}
  → Current state of an autopilot session (waves, progress, costs)

GET    /v1/projects/{project_id}/autopilot/{autopilot_id}/stream
  → SSE: real-time autopilot + swarm progress events

POST   /v1/projects/{project_id}/autopilot/{autopilot_id}/cancel
  → Cancel: stop current wave's swarm, mark remaining waves cancelled

GET    /v1/projects/{project_id}/autopilot/history
  → List past autopilot sessions for this project

PUT    /v1/projects/{project_id}/autopilot/config
  → Update project-level autopilot configuration
```

### 5.2 Analyze Endpoint (Dry Run)

```python
class AnalyzeResponse(BaseModel):
    waves: list[WaveGroupResponse]
    critical_path: list[str]
    total_tasks: int
    total_waves: int
    total_estimated_hours: float
    estimated_wall_clock_hours: float
    parallelization_factor: float
    model_assignments: dict[str, ModelAssignment]
    cost_estimate: CostEstimate

class WaveGroupResponse(BaseModel):
    index: int
    task_ids: list[str]
    task_titles: list[str]
    depends_on_waves: list[int]

class ModelAssignment(BaseModel):
    task_id: str
    title: str
    tier: int          # 1, 2, or 3
    model: str         # Resolved model string
    reason: str        # Why this tier was chosen

class CostEstimate(BaseModel):
    tier1_count: int
    tier2_count: int
    tier3_count: int
    tier1_model: str
    tier2_model: str
    tier3_model: str
    # Estimated token usage per tier (rough heuristic)
    estimated_total_tokens: int
    note: str          # "Actual cost depends on task complexity and token usage"
```

### 5.3 Launch Endpoint

```python
class LaunchRequest(BaseModel):
    planning_run_id: Optional[str] = None
    config_overrides: Optional[AutopilotConfigOverrides] = None

class AutopilotConfigOverrides(BaseModel):
    max_concurrent: Optional[int] = Field(None, ge=1, le=8)
    tier1_model: Optional[str] = None
    tier2_model: Optional[str] = None
    tier3_model: Optional[str] = None
    executor_timeout_seconds: Optional[int] = Field(None, ge=60, le=600)
```

### 5.4 SSE Stream Events

Reuses the existing SSE infrastructure pattern from `swarm_executor.py`:

```
event: autopilot:state         — Full session state snapshot (on connect)
event: autopilot:wave_started  — Wave N dispatch began
event: autopilot:wave_completed — Wave N finished (with stats)
event: autopilot:task_started  — Individual task within wave started
event: autopilot:task_completed — Individual task completed
event: autopilot:task_failed   — Individual task failed
event: autopilot:completed     — All waves done
event: autopilot:failed        — Autopilot terminated with errors
event: autopilot:cancelled     — User cancelled
```

### 5.5 Integration with Planning Pipeline Completion

In `packages/server/app/routers/runs.py`, extend the `RUN_COMPLETE` handler:

```python
# After planning pipeline produces final_subtasks_json:
if pipeline_id == "planning" and project.autopilot_config:
    config = json.loads(project.autopilot_config)
    if config.get("auto_launch", False):
        # Auto-dispatch autopilot when planning completes
        await _auto_launch_autopilot(project_id, run_id, config)
```

---

## 6. Dashboard UI Components

### 6.1 Component Tree

```
packages/dashboard/src/
├── components/
│   └── autopilot/
│       ├── AutopilotAnalysisView.tsx    — Dry-run visualization (pre-launch)
│       ├── AutopilotConfigPanel.tsx     — Project settings panel
│       ├── AutopilotLaunchDialog.tsx    — Confirm + override before launch
│       ├── AutopilotProgressView.tsx    — Live execution dashboard
│       ├── AutopilotWaveTimeline.tsx    — Wave-by-wave Gantt visualization
│       ├── AutopilotCostBreakdown.tsx   — Model tier cost summary
│       ├── AutopilotTaskList.tsx        — Task list with tier badges
│       └── ModelTierBadge.tsx           — Reusable tier indicator
├── hooks/
│   └── useAutopilotSSE.ts              — SSE hook for autopilot events
└── routes/
    └── projects/
        └── $projectId.autopilot.tsx     — Autopilot sub-route
```

### 6.2 AutopilotConfigPanel (Project Settings)

Lives in the project settings page alongside `VisionSettings`, `RepositorySettings`, etc. Uses the same `Card` pattern.

```
┌──────────────────────────────────────────────────────────────────┐
│ ⚡ Swarm Autopilot                                               │
│                                                                  │
│ Automatically parallelize tasks after planning completes.        │
│ Independent tasks run concurrently in waves, with model          │
│ selection optimized per task complexity.                         │
│                                                                  │
│ ┌──────────────────────┐                                        │
│ │ ○ Off  ● Manual  ○ Auto │  (Radio group)                      │
│ └──────────────────────┘                                        │
│   Off:    Disabled. Tasks execute via normal pulse.              │
│   Manual: Analyze + launch from the project board.               │
│   Auto:   Auto-launch after every planning pipeline completes.   │
│                                                                  │
│ ─── Concurrency ──────────────────────────────────────────────  │
│ Max concurrent executors: [3  ▼]  (1-8)                         │
│                                                                  │
│ ─── Model Tiers ──────────────────────────────────────────────  │
│                                                                  │
│  Tier 1 (trivial)    [openrouter/openai/gpt-4o-mini         ▼] │
│  config, docs, typo    Est. cost: ~$0.01/task                    │
│                                                                  │
│  Tier 2 (standard)   [openrouter/moonshotai/kimi-k2.5       ▼] │
│  backend, frontend     Est. cost: ~$0.05/task                    │
│                                                                  │
│  Tier 3 (complex)    [xai/grok-4-1-fast-reasoning            ▼] │
│  architecture, security Est. cost: ~$0.20/task                   │
│                                                                  │
│ ─── Executor ─────────────────────────────────────────────────  │
│ Timeout per task:    [300 ▼] seconds                             │
│ Default agent:       [yukihiro ▼]                                │
│                                                                  │
│                                           [Save Configuration]   │
└──────────────────────────────────────────────────────────────────┘
```

### 6.3 AutopilotAnalysisView (Pre-Launch Dry Run)

Shown when user clicks "Analyze for Autopilot" on the project board. Uses the `/analyze` endpoint. Lets user review before committing.

```
┌──────────────────────────────────────────────────────────────────────────┐
│ ⚡ Autopilot Analysis — MyProject                              [Launch] │
│                                                                         │
│ 24 tasks  →  5 waves  →  ~2.1h estimated (vs 11.5h sequential = 5.5x)  │
│                                                                         │
│ ┌─────────────────────────────────────────────────────────────────────┐ │
│ │                        WAVE DEPENDENCY DAG                         │ │
│ │                                                                     │ │
│ │  ┌─Wave 1──┐    ┌─Wave 2──┐    ┌─Wave 3──┐    ┌─Wave 4──┐         │ │
│ │  │ 6 tasks │───►│ 5 tasks │───►│ 7 tasks │───►│ 4 tasks │──► ...  │ │
│ │  │ ~25min  │    │ ~30min  │    │ ~35min  │    │ ~20min  │         │ │
│ │  └─────────┘    └─────────┘    └─────────┘    └─────────┘         │ │
│ │                                                                     │ │
│ │  ReactFlow DAG: task nodes colored by tier, grouped by wave        │ │
│ │  Tier 1 = green nodes, Tier 2 = blue nodes, Tier 3 = purple nodes │ │
│ └─────────────────────────────────────────────────────────────────────┘ │
│                                                                         │
│ ┌── Cost Breakdown ──────────────────────────────────────────────────┐ │
│ │  ● Tier 1 (trivial):   8 tasks  ×  gpt-4o-mini         ~$0.08   │ │
│ │  ● Tier 2 (standard): 11 tasks  ×  kimi-k2.5            ~$0.55   │ │
│ │  ● Tier 3 (complex):   5 tasks  ×  grok-4-1-reasoning   ~$1.00   │ │
│ │  ─────────────────────────────────────────────────────────────     │ │
│ │  Total estimated:                                         ~$1.63   │ │
│ └────────────────────────────────────────────────────────────────────┘ │
│                                                                         │
│ ┌── Task Assignments ────────────────────────────────────────────────┐ │
│ │  Wave 1                                                            │ │
│ │   ├─ [T1] Set up project scaffold         Tier 1  gpt-4o-mini     │ │
│ │   ├─ [T1] Configure CI pipeline           Tier 1  gpt-4o-mini     │ │
│ │   ├─ [T2] Create database schema          Tier 2  kimi-k2.5       │ │
│ │   ├─ [T2] Design API authentication       Tier 3  grok-4-1        │ │
│ │   └─ ...                                                           │ │
│ │  Wave 2                                                            │ │
│ │   ├─ [T2] Implement user registration     Tier 2  kimi-k2.5       │ │
│ │   └─ ...                                                           │ │
│ │                                                                    │ │
│ │  Each row has a dropdown to override the model tier assignment      │ │
│ └────────────────────────────────────────────────────────────────────┘ │
│                                                                         │
│                     [Cancel]  [Override & Analyze]  [Launch Autopilot]   │
└──────────────────────────────────────────────────────────────────────────┘
```

### 6.4 AutopilotProgressView (Live Execution)

Shown after launch. Reuses existing `SwarmDAG` and `SwarmTimeline` components for each wave, wrapped in a wave-level timeline.

```
┌──────────────────────────────────────────────────────────────────────────┐
│ ⚡ Autopilot Running — MyProject                              [Cancel] │
│                                                                         │
│ Wave 2 of 5  ·  8/24 tasks done  ·  3 running  ·  13 pending           │
│ ████████████░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░  33%                    │
│                                                                         │
│ ┌── Wave Timeline ───────────────────────────────────────────────────┐ │
│ │                                                                     │ │
│ │  Wave 1  ████████████████████ ✓ 6/6  (2m 14s)                     │ │
│ │  Wave 2  ████████░░░░░░░░░░  ⟳ 2/5  running...                    │ │
│ │  Wave 3  ░░░░░░░░░░░░░░░░░░  ○ 0/7  pending                      │ │
│ │  Wave 4  ░░░░░░░░░░░░░░░░░░  ○ 0/4  pending                      │ │
│ │  Wave 5  ░░░░░░░░░░░░░░░░░░  ○ 0/2  pending                      │ │
│ │                                                                     │ │
│ └─────────────────────────────────────────────────────────────────────┘ │
│                                                                         │
│ ┌── Current Wave: Wave 2 ────────────────────────────────────────────┐ │
│ │                                                                     │ │
│ │  ┌──────────────────────── SwarmDAG (existing) ─────────────────┐  │ │
│ │  │  [Task D ⟳]  ───►  [Task G ○]                               │  │ │
│ │  │  [Task E ⟳]                                                  │  │ │
│ │  │  [Task F ✓]                                                  │  │ │
│ │  └──────────────────────────────────────────────────────────────┘  │ │
│ │                                                                     │ │
│ │  ┌───── SwarmTimeline (existing) ────────────────────────────────┐ │ │
│ │  │  Task D  ████████░░░░  1m 22s                                │ │ │
│ │  │  Task E  ██████░░░░░░  58s                                   │ │ │
│ │  │  Task F  ████████████  1m 45s ✓                              │ │ │
│ │  │                                                               │ │ │
│ │  │  Wall: 1m 45s  ·  Sequential est: 4m 05s  ·  2.3x faster    │ │ │
│ │  └───────────────────────────────────────────────────────────────┘ │ │
│ └─────────────────────────────────────────────────────────────────────┘ │
│                                                                         │
│ ┌── Cost Tracker ────────────────────────────────────────────────────┐ │
│ │  ● Tier 1: 5/8 done  ·  $0.04 spent                              │ │
│ │  ● Tier 2: 2/11 done ·  $0.12 spent                              │ │
│ │  ● Tier 3: 1/5 done  ·  $0.22 spent                              │ │
│ │  Total: $0.38 / ~$1.63 estimated                                   │ │
│ └────────────────────────────────────────────────────────────────────┘ │
│                                                                         │
│ ─── Status Bar (existing SwarmStatusBar pattern) ────────────────────  │
│ ✓ 8 completed  ⟳ 3 running  ○ 13 pending  ✕ 0 failed     ● live     │
└──────────────────────────────────────────────────────────────────────────┘
```

### 6.5 ModelTierBadge (Reusable)

Small badge component used throughout autopilot UI:

```tsx
const TIER_STYLES = {
  1: { bg: 'bg-emerald-500/10', text: 'text-emerald-400', border: 'border-emerald-500/30', label: 'T1' },
  2: { bg: 'bg-blue-500/10',    text: 'text-blue-400',    border: 'border-blue-500/30',    label: 'T2' },
  3: { bg: 'bg-purple-500/10',  text: 'text-purple-400',  border: 'border-purple-500/30',  label: 'T3' },
};

function ModelTierBadge({ tier }: { tier: 1 | 2 | 3 }) {
  const s = TIER_STYLES[tier];
  return (
    <span className={`inline-flex items-center px-1.5 py-0.5 rounded text-[10px]
      font-medium border ${s.bg} ${s.text} ${s.border}`}>
      {s.label}
    </span>
  );
}
```

### 6.6 Project Board Integration

Add a button to the existing `ProjectBoardView.tsx` toolbar:

```tsx
// In ProjectBoardView toolbar, next to existing "Plan" button:
{project.autopilot_config && (
  <Button
    variant="outline"
    size="sm"
    onClick={() => navigate(`/projects/${project.id}/autopilot`)}
  >
    <Zap className="w-3.5 h-3.5 mr-1.5" />
    Autopilot
  </Button>
)}
```

### 6.7 SSE Hook: `useAutopilotSSE.ts`

Follows the exact same pattern as the existing `useSwarmSSE.ts`:

```typescript
export function useAutopilotSSE({ autopilotId, projectId }: {
  autopilotId: string;
  projectId: string;
}) {
  // SSE connection to /v1/projects/{projectId}/autopilot/{autopilotId}/stream
  // Returns: { state, connectionStatus, cancel }
  // State type: AutopilotSessionState with nested wave states
  // On 'autopilot:state' event: replace full state
  // On 'autopilot:wave_*' events: merge into current state
  // On 'autopilot:task_*' events: forward to the active wave's swarm state
}
```

---

## 7. Integration Points (Existing Code Changes)

### 7.1 `packages/core/src/main.ts`

Register autopilot event listener alongside existing swarm listener:

```typescript
// Listen for autopilot launch requests
redis.subscribe('djinnbot:events:new_autopilots', async (msg) => {
  const payload = JSON.parse(msg);
  await swarmAutopilot.execute(
    payload.autopilot_id,
    payload.project_id,
    payload.wave_analysis,
    payload.tasks,
  );
});
```

### 7.2 `packages/server/app/models/project.py`

Add `autopilot_config` column:

```python
class Project(Base, TimestampWithCompletedMixin):
    # ... existing fields ...
    autopilot_config: Mapped[Optional[str]] = mapped_column(Text, nullable=True)
```

### 7.3 `packages/server/app/main.py`

Register the new router:

```python
from app.routers import autopilot
app.include_router(autopilot.router, prefix="/v1/projects", tags=["autopilot"])
```

### 7.4 `packages/dashboard/src/routes/projects/$projectId.tsx`

Add autopilot tab/sub-route to the project page.

---

## 8. Event Flow Diagram

```
User clicks "Launch Autopilot" in dashboard
    │
    ▼
POST /v1/projects/{pid}/autopilot/launch
    │
    ▼
Server creates AutopilotSession in DB
Server publishes to Redis: djinnbot:events:new_autopilots
    │
    ▼
Engine picks up event → SwarmAutopilot.execute()
    │
    ├── For each wave:
    │     │
    │     ├── Publish autopilot:wave_started to Redis pub/sub
    │     │
    │     ├── Call SwarmSessionManager.startSwarm() with wave tasks
    │     │     │
    │     │     ├── Existing swarm execution (parallel executors)
    │     │     ├── Each executor: Container → agent runtime → LLM → git commit
    │     │     └── Swarm progress events flow through existing channels
    │     │
    │     ├── Wait for swarm completion
    │     │
    │     ├── Update AutopilotWave in DB
    │     │
    │     ├── Publish autopilot:wave_completed
    │     │
    │     └── Trigger _recompute_task_readiness for completed tasks
    │           (existing cascade logic marks downstream tasks as "ready")
    │
    ├── Publish autopilot:completed
    │
    └── Update AutopilotSession status in DB

Dashboard (SSE listener):
    ├── autopilot:state → render AutopilotProgressView
    ├── autopilot:wave_started → update wave timeline
    ├── swarm:task_started → update current wave's SwarmDAG
    ├── swarm:task_completed → update task node, cost tracker
    ├── autopilot:wave_completed → advance wave indicator
    └── autopilot:completed → show summary
```

---

## 9. Configuration Defaults

```json
{
  "enabled": false,
  "mode": "manual",
  "maxConcurrent": 3,
  "modelTiers": {
    "tier1": "openrouter/openai/gpt-4o-mini",
    "tier2": "openrouter/moonshotai/kimi-k2.5",
    "tier3": "xai/grok-4-1-fast-reasoning"
  },
  "executorTimeoutSeconds": 300,
  "defaultAgentId": "yukihiro",
  "autoLaunch": false
}
```

---

## 10. Rollout Plan

### Phase 1: Core + API (1-2 weeks)
- [ ] `swarm-autopilot.ts` — wave computation, model tiering, orchestrator
- [ ] Alembic migration for `autopilot_sessions`, `autopilot_waves`, project column
- [ ] `autopilot.py` router — analyze, launch, state, stream, cancel endpoints
- [ ] Engine integration — listen for autopilot events, chain waves
- [ ] Unit tests for wave computation and model tier assignment

### Phase 2: Dashboard (1 week)
- [ ] `AutopilotConfigPanel` in project settings
- [ ] `AutopilotAnalysisView` — dry-run visualization
- [ ] `AutopilotLaunchDialog` — confirm with overrides
- [ ] `useAutopilotSSE` hook
- [ ] `AutopilotProgressView` — live wave timeline + nested swarm views
- [ ] `ModelTierBadge` and `AutopilotCostBreakdown`
- [ ] Project board "Autopilot" button integration

### Phase 3: Auto-Launch + Polish (1 week)
- [ ] Auto-launch after planning pipeline completes (when `autoLaunch: true`)
- [ ] Autopilot history page (past sessions per project)
- [ ] Cost tracking integration (link to usage page)
- [ ] Error recovery — retry failed waves
- [ ] Documentation

---

## 11. Risks and Mitigations

| Risk | Mitigation |
|---|---|
| Parallel executors modify overlapping files | Each task gets its own git worktree on `feat/{taskId}`. No shared workspace within a wave. |
| Wave computation produces too many tiny waves | Set minimum wave size (2 tasks). Merge adjacent waves below threshold. |
| Model tiering assigns wrong tier to a task | Users can override per-task in the analysis view before launch. Tier assignment is a heuristic, not a constraint. |
| Autopilot launches with stale task data | Analyze endpoint reads live task state from DB at call time. Launch validates tasks are still in executable status. |
| Cost runaway from parallel execution | `maxConcurrent` caps parallelism. Cost estimate shown before launch. Cancel button always available. |
| Swarm executor fails mid-wave | Existing swarm cascade-skip logic handles this. Failed tasks' dependents in later waves are auto-skipped. |

---

## 12. Success Metrics

1. **Wall-clock reduction**: Measure actual execution time vs. estimated sequential time. Target: 3x+ improvement for projects with 15+ tasks.
2. **Cost savings**: Compare API spend with uniform model vs. tiered model. Target: 40%+ reduction for projects where >30% of tasks are trivially tiered.
3. **Adoption**: % of projects with autopilot enabled after 30 days. Target: >50% of active projects.
4. **Reliability**: % of autopilot sessions that complete without manual intervention. Target: >90%.
