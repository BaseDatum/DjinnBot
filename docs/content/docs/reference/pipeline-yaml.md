---
title: Pipeline YAML Reference
weight: 4
---

Complete reference for the pipeline definition format.

## Top-Level Fields

```yaml
id: string              # Unique pipeline identifier
name: string            # Display name
version: string         # Semantic version
description: string     # Pipeline description

defaults:               # Default values applied to all steps
  model: string         # Default LLM model
  tools: [string]       # Default tool list
  maxRetries: number    # Default retry count (default: 0)
  timeout: number       # Default timeout in seconds

agents:                 # Agent declarations
  - id: string
    name: string
    persona: string     # Path to persona files
    model: string       # Override default model
    tools: [string]     # Override default tools

steps:                  # Pipeline step definitions
  - ...
```

## Step Fields

```yaml
- id: string            # Unique step identifier (e.g., SPEC, DESIGN)
  agent: string         # Agent ID that handles this step

  input: |              # Prompt template (supports {{variables}} and {% if %})
    You are the Product Owner.
    Task: {{task_description}}

  outputs:              # Named outputs the agent produces
    - product_brief
    - requirements_doc

  # Flow control (use exactly one)
  onComplete: string    # Next step ID when this step succeeds
  onResult:             # Conditional routing based on agent output
    APPROVED:
      goto: string      # Go to step
    CHANGES_REQUESTED:
      goto: string
      notify:           # Optional notification
        agent: string
        message: string

  # Loop execution
  loop:
    over: string        # Output name containing JSON array to iterate
    onEachComplete: string  # Step to run after each item
    onAllComplete: string   # Step to run after all items

  # Overrides
  model: string         # Override default model for this step
  timeout: number       # Override default timeout

  # Structured output (mutually exclusive with tools)
  outputSchema:
    name: string
    strict: boolean
    schema:             # JSON Schema object
      type: object
      properties: ...
      required: [...]
```

## Template Variables

Available in `input` fields:

| Variable | Source |
|----------|-------|
| `{{task_description}}` | From the run creation request |
| `{{human_context}}` | Optional human guidance from run request |
| `{{project_name}}` | Project name from run request |
| `{{project_id}}` | Project ID (for tool calls like `create_task`) |
| `{{project_vision}}` | Project vision text (if set) |
| `{{additional_context}}` | Extra context from run request |
| `{{output_name}}` | Any named output from a previous step |
| `{{current_item}}` | Current item in a loop iteration |
| `{{completed_items}}` | JSON array of completed loop items |
| `{{progress_file}}` | Path to loop progress tracking file |

Jinja2 conditionals:

```yaml
input: |
  {% if review_feedback %}
  Address this feedback: {{review_feedback}}
  {% endif %}
```

## Result Routing

The `onResult` field maps agent output values to step transitions:

```yaml
onResult:
  APPROVED:
    goto: TEST
  CHANGES_REQUESTED:
    goto: IMPLEMENT
  FAIL:
    goto: FIX
    notify:
      agent: eric
      message: "Test failed, needs investigation"
```

The agent writes the result value to a file named `{OUTPUT}_RESULT.txt` (e.g., `REVIEW_RESULT.txt` containing `APPROVED`).

### Loop Result Routing

Within a loop, use `continueLoop: true` to advance to the next item:

```yaml
onResult:
  PASS:
    continueLoop: true    # Move to next loop item
  FAIL:
    goto: IMPLEMENT       # Go back to fix
```

## Available Tools

Tools that can be listed in the `tools` array:

| Tool | Description |
|------|------------|
| `read` | Read files from the workspace |
| `write` | Write files to the workspace |
| `edit` | Edit files with search/replace |
| `bash` | Execute shell commands |
| `grep` | Search file contents |
| `find` | Find files by pattern |
| `ls` | List directory contents |
| `web_search` | Search the web (via research tool) |

Agents also have access to built-in tools (memory, messaging, project management, code graph, focused analysis, run history) that are always available regardless of the `tools` list.

## Built-in Pipelines

DjinnBot ships with several built-in pipelines:

| Pipeline | Description |
|----------|-------------|
| `engineering` | Full SDLC pipeline: spec, design, implement, test, review, deploy |
| `planning` | Structured planning with Eric + Finn validation loop |
| `planning-agentic` | Single-agent planning with tool-based task creation and dependency wiring |
| `onboarding` | Interactive project onboarding that creates vision and runs planning |

The `planning-agentic` pipeline is particularly useful for large projects where structured output hits token limits. It uses a single powerful model (e.g., Claude Opus) with full tool access to incrementally create tasks, subtasks, and dependency edges via API calls.
