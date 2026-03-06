---
title: Pipelines
weight: 3
---

Pipelines are YAML files that define multi-agent workflows. Each pipeline describes a series of steps, which agents handle them, and how results flow between steps.

## Pipeline Structure

Every pipeline YAML has four sections:

```yaml
# Metadata
id: engineering
name: Engineering Pipeline
version: 1.0.0
description: Full software development workflow

# Defaults applied to all steps
defaults:
  model: openrouter/moonshotai/kimi-k2.5
  tools: [read, write, bash]
  maxRetries: 3
  timeout: 4800

# Agent declarations
agents:
  - id: eric
    name: Eric (Product Owner)
    persona: docs/personas/eric.md
    tools: [web_search, read, write]

# Step definitions
steps:
  - id: SPEC
    agent: eric
    input: |
      You are the Product Owner.
      Task: {{task_description}}
      ...
    outputs: [product_brief, requirements_doc]
    onComplete: DESIGN
```

## Steps

Each step defines:

| Field | Description |
|-------|------------|
| `id` | Unique identifier (e.g., `SPEC`, `DESIGN`, `IMPLEMENT`) |
| `agent` | Which agent handles this step |
| `input` | The prompt template sent to the agent |
| `outputs` | Named outputs the agent produces |
| `onComplete` | Next step when this one succeeds |
| `onResult` | Conditional routing based on agent output |
| `loop` | Execute over a list of items |
| `model` | Override the default model for this step |
| `timeout` | Override the default timeout |
| `outputSchema` | JSON schema for structured output (no tools mode) |

### Template Variables

Step inputs can reference outputs from previous steps using `{{variable_name}}`:

```yaml
- id: DESIGN
  agent: finn
  input: |
    Requirements: {{requirements_doc}}
    User Stories: {{user_stories_json}}
```

Jinja2 conditionals are also supported:

```yaml
input: |
  {% if review_feedback %}
  Review Feedback: {{review_feedback}}
  {% endif %}
```

### Result Routing

Steps can branch based on agent output using `onResult`:

```yaml
- id: REVIEW
  agent: finn
  outputs: [review_result, review_feedback]
  onResult:
    APPROVED:
      goto: TEST
    CHANGES_REQUESTED:
      goto: IMPLEMENT
```

The agent writes a result value (e.g., `APPROVED` to `REVIEW_RESULT.txt`), and the engine routes to the matching branch.

### Loop Steps

Steps can iterate over a list produced by a previous step:

```yaml
- id: IMPLEMENT
  agent: yukihiro
  input: |
    Current Task: {{current_item}}
    Completed Tasks: {{completed_items}}
  loop:
    over: task_breakdown_json    # Iterate over this output
    onEachComplete: REVIEW       # After each item, go here
    onAllComplete: DEPLOY        # After all items, go here
```

The engine parses the JSON array and executes the step once per item, injecting `{{current_item}}`, `{{completed_items}}`, and `{{progress_file}}` template variables.

### Structured Output

Steps can enforce structured JSON output using `outputSchema`:

```yaml
- id: DECOMPOSE
  agent: eric
  outputSchema:
    name: task_breakdown
    strict: true
    schema:
      type: object
      properties:
        tasks:
          type: array
          items:
            type: object
            properties:
              title: { type: string }
              priority: { type: string, enum: [P0, P1, P2, P3] }
              estimatedHours: { type: number }
            required: [title, priority, estimatedHours]
      required: [tasks]
```

When `outputSchema` is specified, the step uses direct API calls with constrained JSON output instead of tool-based execution. This guarantees valid, parseable output.

## Built-in Pipelines

### engineering

The full software development lifecycle:

```
SPEC → DESIGN → UX → IMPLEMENT (loop) ↔ REVIEW ↔ TEST → DEPLOY
```

All 7 engineering agents participate. The IMPLEMENT step loops over a task breakdown, with each implementation reviewed and tested before moving on.

### feature

A lighter pipeline for adding features to existing code:

```
DESIGN → IMPLEMENT ↔ REVIEW → TEST
```

3 agents: Finn (design + review), Yukihiro (implement), Chieko (test).

### bugfix

For diagnosing and fixing bugs:

```
FIX → VALIDATE
```

2 agents: Yukihiro (diagnose + fix), Chieko (validate).

### planning

Decomposes a project into tasks with dependency chains:

```
DECOMPOSE → VALIDATE → DECOMPOSE_SUBTASKS → VALIDATE_SUBTASKS
```

Uses structured output mode — no tools, just constrained JSON. Eric breaks down the project, Finn validates and enriches. Then Eric creates bite-sized subtasks, and Finn validates those too. The output integrates directly with the project board.

### resolve

Takes a GitHub issue and turns it into a pull request:

```
ANALYZE → IMPLEMENT → VALIDATE → PR
```

Yukihiro (SWE) analyzes the issue, implements the fix, validates it works, and opens a PR. Useful for issue-driven development — point it at an issue and walk away.

### import

Onboards an existing GitHub repository into DjinnBot:

```
ANALYZE → MEMORIZE → PLAN
```

Agents analyze the codebase structure, create shared ClawVault memories about the architecture and patterns they find, and generate a prioritized task backlog on the project board. This is the fastest way to get agents productive on an existing codebase.

### execute

Runs a single task from a project board in an isolated container.

## Creating Custom Pipelines

Create a YAML file in `pipelines/` and it will automatically appear in the dashboard. No restart needed — the API reads pipeline definitions from disk.

A minimal custom pipeline:

```yaml
id: my-pipeline
name: My Custom Pipeline
version: 1.0.0
description: Does something useful

defaults:
  model: anthropic/claude-sonnet-4
  tools: [read, write, bash]
  timeout: 600

agents:
  - id: yukihiro
    name: Yukihiro (SWE)

steps:
  - id: DO_THING
    agent: yukihiro
    input: |
      Task: {{task_description}}
      Do the thing.
    outputs: [result]
```

You can reference any agent defined in `agents/` and use any combination of steps, branches, and loops.
