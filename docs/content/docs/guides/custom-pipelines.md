---
title: Custom Pipelines
weight: 3
---

Create your own multi-agent workflows for any process — not just software development.

## Minimal Pipeline

Create a file in `pipelines/`:

```yaml
# pipelines/research.yml
id: research
name: Research Pipeline
version: 1.0.0
description: Research a topic and produce a report

defaults:
  model: anthropic/claude-sonnet-4
  tools: [read, write, bash]
  timeout: 600

agents:
  - id: eric
    name: Eric (PO)

steps:
  - id: RESEARCH
    agent: eric
    input: |
      Research this topic thoroughly:
      {{task_description}}

      Write a comprehensive report to REPORT.md.
    outputs: [report]
```

Drop this file in `pipelines/` and it's immediately available — no restart needed.

## Multi-Step with Handoffs

```yaml
id: content
name: Content Pipeline
version: 1.0.0
description: Research, write, and review content

defaults:
  model: openrouter/moonshotai/kimi-k2.5
  tools: [read, write, bash]
  timeout: 900

agents:
  - id: luke
    name: Luke (SEO)
  - id: holt
    name: Holt (Marketing)
  - id: finn
    name: Finn (Reviewer)

steps:
  - id: RESEARCH
    agent: luke
    input: |
      Research keywords and outline for:
      {{task_description}}

      Write outputs:
      - KEYWORD_RESEARCH.md
      - CONTENT_OUTLINE.md
    outputs: [keyword_research, content_outline]
    onComplete: WRITE

  - id: WRITE
    agent: holt
    input: |
      Write the content based on this research:
      {{keyword_research}}
      {{content_outline}}

      Write the full article to ARTICLE.md.
    outputs: [article]
    onComplete: REVIEW

  - id: REVIEW
    agent: finn
    input: |
      Review this content:
      {{article}}

      Output REVIEW_RESULT: APPROVED or CHANGES_REQUESTED
    outputs: [review_result, review_feedback]
    onResult:
      APPROVED:
        goto: DONE
      CHANGES_REQUESTED:
        goto: WRITE

  - id: DONE
    agent: luke
    input: |
      Finalize SEO metadata for:
      {{article}}
    outputs: [seo_metadata]
```

## Advanced Features

### Loops

Process a list of items with a single step:

```yaml
- id: IMPLEMENT
  agent: yukihiro
  input: |
    Current Task: {{current_item}}
    Completed: {{completed_items}}
  loop:
    over: task_breakdown_json    # JSON array from previous step
    onEachComplete: REVIEW       # Run after each item
    onAllComplete: FINALIZE      # Run when all items done
```

### Structured Output

Force agents to produce valid JSON matching a schema:

```yaml
- id: PLAN
  agent: eric
  outputSchema:
    name: task_list
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
            required: [title, priority]
      required: [tasks]
  input: |
    Break down this project into tasks:
    {{task_description}}
  outputs: [task_list_json]
```

### Per-Step Model Override

Use different models for different steps:

```yaml
- id: SPEC
  agent: eric
  model: anthropic/claude-opus-4    # Expensive but thorough
  input: ...

- id: IMPLEMENT
  agent: yukihiro
  model: openrouter/moonshotai/kimi-k2.5  # Fast and capable
  input: ...
```

### Notifications

Notify agents when something important happens:

```yaml
- id: DEPLOY
  agent: stas
  onResult:
    SUCCESS:
      notify:
        agent: eric
        message: "Deployment successful!"
    FAIL:
      notify:
        agent: yukihiro
        message: "Deployment failed, needs investigation"
      goto: FIX
```

## Pipeline Design Tips

1. **Start simple** — 2-3 steps is fine. Add complexity only when you need it.
2. **Use branching** — let agents route work based on quality checks (APPROVED/CHANGES_REQUESTED).
3. **Set timeouts** — prevent runaway steps from consuming resources.
4. **Enable retries** — transient failures (API errors, etc.) are common. `maxRetries: 3` handles them.
5. **Name outputs clearly** — `architecture_doc` is better than `output_1`.
