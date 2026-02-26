# End-to-End SDLC Test Plan — Pulse-Based Autonomous Delivery

**Goal:** Validate the full pulse-driven SDLC cycle against a real GitHub repo. No pipelines — agents wake on pulse schedules, discover work, claim tasks, implement via `spawn_executor`, open PRs, review, test, merge, and transition tasks through kanban columns autonomously.

**Core flow under test:**

```
[User creates tasks in Backlog/Ready]
        ↓
[Yukihiro pulse] → get_ready_tasks → claim_task → spawn_executor → git push → open_pull_request → transition "review"
        ↓
[Finn pulse] → get_ready_tasks(Review) → claim_task → code review → approve/request changes → transition "test" or back to "in_progress"
        ↓
[Chieko pulse] → get_ready_tasks(Test) → claim_task → run tests → approve: github_merge_pr + transition "done" / reject: transition "failed"
        ↓
[Yukihiro pulse] → sees "failed" task → fix bugs → push → transition "review" (cycle repeats)
```

**Test Repo:** A simple GitHub repo (you create it) with a basic project — Node.js Express or Python Flask. Minimal: README, a few source files, a test suite. Branch: `main` (or `multi-tenant` if testing that branch policy).

---

## Prerequisites

- [ ] DjinnBot stack running locally: `docker compose up -d`
- [ ] DB migrations applied (including `za6_add_task_work_type_and_workflow_policy` and `za7_add_llm_call_cost_approximate`)
- [ ] Test repo created on GitHub with base branch, basic scaffolding, and a passing test suite
- [ ] Model provider configured (OpenRouter key in `.env`)
- [ ] Dashboard at `http://localhost:3000`, API at `http://localhost:8000`
- [ ] At least 3 agents have pulse routines configured: **yukihiro** (Ready/Failed columns), **finn** (Planning/Review columns), **chieko** (Test column)

---

## Phase 0: Stack Health & Migration Verification

| # | Test | How | Pass Criteria |
|---|------|-----|---------------|
| 0.1 | Services healthy | `docker compose ps` | All containers healthy/running |
| 0.2 | Migrations applied | `SELECT * FROM alembic_version` | Head includes `za6`, `za7` |
| 0.3 | `workflow_policies` table | `\d workflow_policies` | Columns: `id, project_id, stage_rules, created_at, updated_at` |
| 0.4 | `tasks.work_type` column | `\d tasks` | `work_type VARCHAR` present |
| 0.5 | `tasks.completed_stages` column | `\d tasks` | `completed_stages TEXT` present |
| 0.6 | `llm_call_logs.cost_approximate` | `\d llm_call_logs` | `cost_approximate BOOLEAN` present |
| 0.7 | Agents loaded | `GET /v1/agents/` | yukihiro, finn, chieko, eric, etc. all present |
| 0.8 | Redis healthy | `redis-cli ping` | PONG |
| 0.9 | Engine running | `docker compose logs engine --tail 20` | No crash loops, pulse system initialized |

---

## Phase 1: Project Setup & Agent Assignment

| # | Test | How | Pass Criteria |
|---|------|-----|---------------|
| 1.1 | Create project | `POST /v1/projects/` with `name`, `description`, `repository` URL | 201, project returned with default kanban columns |
| 1.2 | Verify columns | `GET /v1/projects/{id}/columns` | Columns include: Backlog, Planning, Ready, In Progress, Review, Test, Done |
| 1.3 | Repo linked | `GET /v1/projects/{id}` | `repository` field set, `workspace_type: "git_worktree"` |
| 1.4 | Clone repo | `POST /v1/projects/{id}/repository/clone` (or verify auto-clone) | Workspace created at `/data/workspaces/{projectId}`, `.git` present |
| 1.5 | Assign yukihiro | `POST /v1/projects/{id}/agents` with `agentId: "yukihiro"` | 200 |
| 1.6 | Assign finn | `POST /v1/projects/{id}/agents` with `agentId: "finn"` | 200 |
| 1.7 | Assign chieko | `POST /v1/projects/{id}/agents` with `agentId: "chieko"` | 200 |
| 1.8 | Agents see project | For each agent: `GET /v1/agents/{id}/projects` | Project listed with role |
| 1.9 | Dashboard shows project | Open dashboard → Projects | Project visible with agents listed |

---

## Phase 2: Workflow Policy Configuration

| # | Test | How | Pass Criteria |
|---|------|-----|---------------|
| 2.1 | No policy initially | `GET /v1/projects/{id}/workflow-policy` | `{"exists": false}` |
| 2.2 | Set workflow policy | `PUT /v1/projects/{id}/workflow-policy` (see payload below) | 200, policy created |
| 2.3 | Read policy back | `GET /v1/projects/{id}/workflow-policy` | `exists: true`, stage rules match |
| 2.4 | Verify feature rules | Check `stageRules.feature` | implement=required, review=required, test=required |
| 2.5 | Verify bugfix rules | Check `stageRules.bugfix` | No spec/design/ux stages, implement+review+test required |
| 2.6 | Verify docs rules | Check `stageRules.docs` | Only implement required |

**Workflow policy payload:**
```json
{
  "stageRules": {
    "feature": [
      {"stage": "spec", "disposition": "optional"},
      {"stage": "design", "disposition": "optional"},
      {"stage": "implement", "disposition": "required"},
      {"stage": "review", "disposition": "required"},
      {"stage": "test", "disposition": "required"}
    ],
    "bugfix": [
      {"stage": "implement", "disposition": "required"},
      {"stage": "review", "disposition": "required"},
      {"stage": "test", "disposition": "required"}
    ],
    "test": [
      {"stage": "implement", "disposition": "required"},
      {"stage": "review", "disposition": "optional"}
    ],
    "docs": [
      {"stage": "implement", "disposition": "required"}
    ],
    "refactor": [
      {"stage": "implement", "disposition": "required"},
      {"stage": "review", "disposition": "required"},
      {"stage": "test", "disposition": "required"}
    ],
    "custom": [
      {"stage": "implement", "disposition": "required"},
      {"stage": "review", "disposition": "optional"}
    ]
  }
}
```

---

## Phase 3: Task Creation & Work Type Inference

Create a mix of tasks to exercise different work types and the full kanban flow.

| # | Test | How | Pass Criteria |
|---|------|-----|---------------|
| 3.1 | Feature task (explicit) | `POST /v1/projects/{id}/tasks` with `title: "Add GET /health endpoint"`, `workType: "feature"`, status in Ready column | 201, `work_type: "feature"` |
| 3.2 | Bugfix task (explicit) | `POST ...` with `title: "Fix crash on empty input"`, `workType: "bugfix"` | 201, `work_type: "bugfix"` |
| 3.3 | Auto-infer bugfix | `POST ...` with `title: "Fix null pointer in parser"` (no workType) | 201, `work_type` inferred as `"bugfix"` |
| 3.4 | Auto-infer from tags | `POST ...` with `title: "Improve logging"`, `tags: ["refactor"]` | 201, `work_type` inferred as `"refactor"` |
| 3.5 | Docs task | `POST ...` with `title: "Update README with API docs"`, `workType: "docs"` | 201, `work_type: "docs"` |
| 3.6 | Invalid type rejected | `POST ...` with `workType: "nonexistent"` | 422 error |
| 3.7 | Task with dependency | Create task B that depends on task A via `POST /v1/projects/{id}/tasks/{B}/dependencies` | Dependency created, B blocked |
| 3.8 | Workflow resolution (feature) | `GET /v1/projects/{id}/tasks/{featureTaskId}/workflow` | `has_policy: true`, `required_stages: ["implement","review","test"]`, `next_required_stage: "implement"` |
| 3.9 | Workflow resolution (bugfix) | `GET /v1/projects/{id}/tasks/{bugfixTaskId}/workflow` | No spec/design/ux in required, `next_valid_stages` starts at implement |
| 3.10 | Dashboard task board | Open project board | Tasks in correct columns with work type badges |

---

## Phase 4: Pulse Routine Setup & Verification

Ensure each agent's pulse routine is properly configured before triggering pulses.

| # | Test | How | Pass Criteria |
|---|------|-----|---------------|
| 4.1 | Yukihiro has routine | `GET /v1/agents/yukihiro/pulse-routines` | At least 1 routine with `stageAffinity: ["implement"]`, `pulseColumns` includes Ready/Failed |
| 4.2 | Finn has routine | `GET /v1/agents/finn/pulse-routines` | Routine with `pulseColumns` includes Planning/Review |
| 4.3 | Chieko has routine | `GET /v1/agents/chieko/pulse-routines` | Routine with `pulseColumns` includes Test |
| 4.4 | Create routine if missing | `POST /v1/agents/{id}/pulse-routines` with appropriate config | 201, routine created |
| 4.5 | Pulse timeline shows schedule | `GET /v1/pulses/timeline?hours=1` | Pulses scheduled for all 3 agents with staggered offsets |
| 4.6 | Routines have stage affinity | Check routine `stageAffinity` field | Yukihiro: `["implement"]`, Finn: `["review"]`, Chieko: `["test"]` |
| 4.7 | Routines have work type filter | Check `taskWorkTypes` field (if configured) | Filters match expected types per agent |

---

## Phase 5: Yukihiro Pulse — Claim, Implement, Open PR

This is the first real pulse test. Trigger Yukihiro's pulse manually and watch the full implementation flow.

| # | Test | How | Pass Criteria |
|---|------|-----|---------------|
| 5.1 | Trigger pulse manually | `POST /v1/agents/yukihiro/pulse` (or `POST /v1/agents/yukihiro/pulse-routines/{routineId}/trigger`) | 200, pulse session starts |
| 5.2 | Agent discovers projects | Watch engine logs / SSE | `get_my_projects` called, test project found |
| 5.3 | Agent reads vision | Watch logs | `get_project_vision` called |
| 5.4 | Agent finds ready tasks | Watch logs | `get_ready_tasks` called, feature task returned |
| 5.5 | Agent claims task | Watch logs | `claim_task` called, task assigned to yukihiro, branch `feat/{taskId}-...` created |
| 5.6 | Task moves to in_progress | `GET /v1/projects/{id}/tasks/{taskId}` | `status: "in_progress"`, `assigned_agent: "yukihiro"` |
| 5.7 | Branch exists in metadata | Check task metadata | `metadata.git_branch` set |
| 5.8 | spawn_executor runs | Watch engine logs | Executor container spawned, execution prompt sent |
| 5.9 | Code committed on branch | Check test repo: `git log feat/{branch}` | At least one commit from the agent |
| 5.10 | PR opened | Watch logs for `open_pull_request` call | PR created on GitHub targeting correct base branch |
| 5.11 | PR URL in task metadata | `GET /v1/projects/{id}/tasks/{taskId}` | `metadata.pr_url` set |
| 5.12 | Task transitions to review | `GET /v1/projects/{id}/tasks/{taskId}` | `status: "review"` |
| 5.13 | `completed_stages` updated | Check task | `completed_stages` includes `"implement"` |
| 5.14 | LLM calls logged | `GET /v1/llm-calls/?limit=10` | Calls from this pulse session logged with token counts |
| 5.15 | Cost tracked | Check LLM call entries | `cost` > 0, `cost_approximate` flag correct |
| 5.16 | Pulse session recorded | Check agent activity/lifecycle | Pulse session start/complete events logged |

---

## Phase 6: Finn Pulse — Code Review

Trigger Finn's pulse. He should find the task in Review, inspect the PR, and approve or request changes.

| # | Test | How | Pass Criteria |
|---|------|-----|---------------|
| 6.1 | Trigger Finn's pulse | `POST /v1/agents/finn/pulse` | 200, pulse starts |
| 6.2 | Finn finds review tasks | Watch logs | `get_ready_tasks` returns the feature task in Review column |
| 6.3 | Finn claims the task | Watch logs | `claim_task` called |
| 6.4 | Finn checks PR status | Watch logs | `get_task_pr_status` called, PR details retrieved |
| 6.5 | Finn reviews code | Watch logs | Agent reads code in workspace, evaluates against architecture |
| 6.6a | **If APPROVED**: transition to test | `GET /v1/projects/{id}/tasks/{taskId}` | `status: "test"` |
| 6.6b | **If CHANGES_REQUESTED**: stays in review or back to in_progress | Check task status | Yukihiro will see it on next pulse |
| 6.7 | `completed_stages` updated | Check task | `"review"` added to `completed_stages` (if approved) |
| 6.8 | Workflow resolution correct | `GET /v1/projects/{id}/tasks/{taskId}/workflow` | Shows review completed, next stage = test |

---

## Phase 7: Chieko Pulse — QA Testing

Trigger Chieko's pulse. She should find the task in Test, run the test suite, and approve or reject.

| # | Test | How | Pass Criteria |
|---|------|-----|---------------|
| 7.1 | Trigger Chieko's pulse | `POST /v1/agents/chieko/pulse` | 200, pulse starts |
| 7.2 | Chieko finds test tasks | Watch logs | `get_ready_tasks` returns the feature task in Test column |
| 7.3 | Chieko claims task | Watch logs | `claim_task` called, workspace provisioned on PR branch |
| 7.4 | Chieko runs test suite | Watch logs | Agent runs `npm test` or equivalent in workspace |
| 7.5 | Chieko checks PR status | Watch logs | `get_task_pr_status` called |
| 7.6a | **If PASS**: merge PR + done | Watch logs | `github_merge_pr` called, `transition_task` to "done" |
| 7.6b | **If FAIL**: transition to failed | `GET /v1/projects/{id}/tasks/{taskId}` | `status: "failed"`, comments on PR explain failures |
| 7.7 | `completed_stages` updated | Check task | `"test"` added (if passed) |
| 7.8 | Task fully done | `GET /v1/projects/{id}/tasks/{taskId}` | `status: "done"`, all required stages in `completed_stages` |
| 7.9 | Dependency unblocking | If task B depended on this task | B should now be unblocked (status moves from blocked to ready) |

---

## Phase 8: Rejection & Re-Work Cycle

If Chieko rejected (Phase 7.6b) or Finn requested changes (Phase 6.6b), verify the repair loop works.

| # | Test | How | Pass Criteria |
|---|------|-----|---------------|
| 8.1 | Failed task visible to Yukihiro | Trigger Yukihiro pulse | `get_ready_tasks` returns the failed task |
| 8.2 | Yukihiro reads QA feedback | Watch logs | `get_task_context` + `get_task_pr_status` called, reads review comments |
| 8.3 | Yukihiro fixes bugs | Watch logs | Goes to workspace, makes fixes, commits, pushes |
| 8.4 | Yukihiro transitions to review | Watch logs | `transition_task` to "review" |
| 8.5 | Finn re-reviews | Trigger Finn pulse | Finds task in Review, re-reviews |
| 8.6 | Chieko re-tests | Trigger Chieko pulse | Finds task in Test, re-runs tests |
| 8.7 | Task eventually completes | Poll task status | Reaches "done" after review/test passes |

**If the task was never rejected**, manually create this scenario:
1. Move the bugfix task to Ready: `POST /v1/projects/{id}/tasks/{bugfixTaskId}/transition` with `status: "ready"`
2. Trigger Yukihiro → implements → PR → review
3. Trigger Finn → requests changes (or manually transition to failed)
4. Trigger Yukihiro → fixes → re-submits
5. Verify the full loop completes

---

## Phase 9: Work Type Routing Verification

Verify that different work types route through the correct stages.

| # | Test | How | Pass Criteria |
|---|------|-----|---------------|
| 9.1 | Docs task skips review/test | Move docs task to Ready, trigger Yukihiro pulse | Yukihiro implements and transitions directly to "done" (review/test not required per policy) |
| 9.2 | Workflow confirms docs route | `GET /v1/projects/{id}/tasks/{docsTaskId}/workflow` | `required_stages: ["implement"]` only |
| 9.3 | Bugfix skips design | Move bugfix task to Ready, trigger Yukihiro pulse | Goes implement → review → test, no design stage |
| 9.4 | Refactor task follows full loop | If refactor task exists | implement → review → test (all required) |
| 9.5 | Agent checks workflow before transitioning | Watch Yukihiro logs | Calls `get_task_workflow` before deciding where to transition |

---

## Phase 10: Concurrent / Multi-Task Pulse Behavior

| # | Test | How | Pass Criteria |
|---|------|-----|---------------|
| 10.1 | Multiple tasks in Ready | Create 2-3 tasks in Ready column | All visible |
| 10.2 | Yukihiro picks highest priority | Trigger pulse with P0 and P2 tasks available | Claims P0 first |
| 10.3 | In-flight work checked first | Leave a task in_progress, trigger pulse | Yukihiro checks in-flight PRs before picking new work |
| 10.4 | Concurrency gating works | Trigger pulse while another pulse is active | Second pulse skipped (per-routine max concurrent = 1) |
| 10.5 | Wake-on-message | Send message to yukihiro via `POST /v1/agents/yukihiro/inbox` | If idle, triggers wake pulse within cooldown window |

---

## Phase 11: Task Workspace & Git Integration

| # | Test | How | Pass Criteria |
|---|------|-----|---------------|
| 11.1 | claim_task creates worktree | After claim, check engine logs | Git worktree created at `/home/agent/task-workspaces/{taskId}` on correct branch |
| 11.2 | Branch from correct base | Check the branch in GitHub | Branch created from the project's base branch (main/multi-tenant) |
| 11.3 | Push works | After spawn_executor completes | Commits visible on remote branch |
| 11.4 | PR targets correct branch | Check PR on GitHub | Base branch matches project config |
| 11.5 | Workspace cleanup | After task done + merged | Worktree cleaned up (or at least doesn't block future tasks) |
| 11.6 | Multiple task workspaces | Claim 2 tasks | Each gets its own worktree on its own branch, no conflicts |

---

## Phase 12: Dashboard Verification

| # | Test | How | Pass Criteria |
|---|------|-----|---------------|
| 12.1 | Project board shows task flow | Watch dashboard during pulses | Tasks move between columns in real-time (SSE) |
| 12.2 | Task detail shows work type | Click a task | Work type badge visible |
| 12.3 | Task detail shows workflow stages | Click a task | Stage progress indicator (completed/current/remaining) |
| 12.4 | Agent activity shows pulse | Agent detail page | Pulse sessions listed with timestamps |
| 12.5 | LLM call log shows costs | Admin > LLM Calls | Cost column with amounts, approximate flag where applicable |
| 12.6 | Session token stats | Run/session detail | Token usage breakdown accurate |
| 12.7 | Pulse timeline | Dashboard pulse view | Schedule visible for all agents, staggered correctly |

---

## Phase 13: Cost Tracking & Model Resolution

| # | Test | How | Pass Criteria |
|---|------|-----|---------------|
| 13.1 | LLM calls logged per pulse | `GET /v1/llm-calls/?limit=50` | Each pulse session produces LLM call entries |
| 13.2 | Cost calculated | Check `cost` field | > 0 for known models |
| 13.3 | `cost_approximate` flag | Check entries for inferred models | `cost_approximate: true` when model not in static registry |
| 13.4 | Token counts accurate | Check `input_tokens`, `output_tokens` | Non-zero, reasonable values |
| 13.5 | Model override respected | Trigger pulse with routine `executorModel` set | LLM calls use the specified model |

---

## Phase 14: Error Handling & Edge Cases

| # | Test | How | Pass Criteria |
|---|------|-----|---------------|
| 14.1 | No ready tasks | Pulse fires with empty Ready column | Agent reports "no ready tasks", pulse completes cleanly |
| 14.2 | Task already claimed | Two agents try to claim same task | Second gets 409 conflict |
| 14.3 | Transition to skipped stage | Try `transition_task` to a stage marked "skip" in policy | Error returned, transition blocked |
| 14.4 | spawn_executor timeout | Set very short timeout on routine | Executor killed, task not stuck in in_progress forever |
| 14.5 | No repo configured | Create project without repo, assign task, trigger pulse | Agent handles gracefully (can't claim workspace, reports error) |
| 14.6 | PR creation fails | Trigger PR open on a repo with no push access | Error returned, task stays in in_progress |
| 14.7 | Pulse cooldown | Trigger manual pulse twice rapidly | Second is suppressed by cooldown |
| 14.8 | Daily wake limit | Exceed `maxWakesPerDay` | Subsequent wakes suppressed with log message |

---

## Execution Strategy

### Recommended order:

1. **Phase 0** — Don't proceed until stack is healthy
2. **Phase 1-3** — Setup (project, policy, tasks) — all API calls, fast
3. **Phase 4** — Verify pulse routines exist
4. **Phase 5** — **THE MAIN EVENT**: Yukihiro implements a feature via pulse
5. **Phase 6** — Finn reviews
6. **Phase 7** — Chieko tests
7. **Phase 8** — Rejection loop (if it happens naturally, great; force it if not)
8. **Phase 9-10** — Work type routing and multi-task behavior
9. **Phase 11** — Git integration deep dive
10. **Phase 12-13** — Dashboard and cost tracking (spot-check throughout)
11. **Phase 14** — Edge cases last

### How to trigger pulses:

```bash
# Manual trigger for a specific agent
curl -X POST http://localhost:8000/v1/agents/yukihiro/pulse

# Manual trigger for a specific routine
curl -X POST http://localhost:8000/v1/agents/yukihiro/pulse-routines/{routineId}/trigger

# Watch engine logs for pulse activity
docker compose logs -f engine
```

### How to watch what's happening:

```bash
# Engine logs (pulse scheduling, container spawning)
docker compose logs -f engine

# API logs (task transitions, claims, PR creation)
docker compose logs -f api

# Agent runtime container logs (tool calls, LLM interactions)
docker logs $(docker ps -q --filter "name=djinnbot-agent") -f

# Redis event stream
redis-cli XRANGE djinnbot:events:new_runs - + COUNT 10
```

---

## Test Repo Suggestions

Keep it minimal — 50-100 lines of real code. The point is exercising DjinnBot, not the test project.

**Option A: Node.js Express**
```
test-project/
  package.json
  src/index.ts          # Express app with 2-3 routes
  src/utils.ts          # A utility module
  tests/index.test.ts   # Basic tests (jest/vitest)
  tsconfig.json
  .gitignore
```

**Option B: Python Flask**
```
test-project/
  pyproject.toml
  app/main.py           # Flask app with 2-3 routes
  app/utils.py
  tests/test_main.py    # pytest tests
  .gitignore
```

Include a passing test suite — Chieko needs something to run. Include at least one intentional gap (missing input validation, no error handling on an endpoint) so there's real work for the agents to find and fix.

---

## Key Things to Watch For

1. **Branch policy**: PULSE.md says "all work targets `multi-tenant`" — make sure your test repo has the correct base branch or update the PULSE.md templates to target `main`.

2. **Workspace provisioning**: `claim_task` → engine creates worktree → agent gets workspace path. This involves Redis round-trip (`djinnbot:workspace:{agentId}:{taskId}`) with 30s timeout. Watch for timeouts.

3. **spawn_executor context window**: The executor gets ONLY the execution prompt + deviation rules. If Yukihiro writes a bad prompt, the executor will struggle. This tests prompt quality.

4. **Workflow policy enforcement**: When Yukihiro calls `transition_task`, the API should check the workflow policy and reject transitions to skipped stages. Verify the `get_task_workflow` → `transition_task` flow.

5. **`completed_stages` tracking**: Each transition should append to the task's `completed_stages` JSON array. This is how the workflow resolver knows what's been done.

6. **Cost tracking**: The new `openrouter-pricing.ts` module and `cost_approximate` flag in `llm_call_logs` — verify these don't throw for unknown models and that costs flow through to the dashboard.

7. **Concurrency**: Two agents should never claim the same task. `claim_task` uses a DB row-level lock (`SELECT ... FOR UPDATE`). Test with near-simultaneous claims.
