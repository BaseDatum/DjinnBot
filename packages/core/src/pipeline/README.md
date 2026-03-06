# Pipeline Parser & Template System

This module provides YAML-based pipeline configuration with validation and template variable resolution.

## Files Created

### `parser.ts`
- **Zod schemas** for comprehensive pipeline validation
- **parsePipeline(yamlPath)** — Load and validate a pipeline YAML file
- **validatePipeline(config)** — Validate a pipeline config object
- **Cross-reference validation**:
  - Ensures `step.agent` references valid agent IDs
  - Ensures `step.onComplete` references valid step IDs
  - Ensures loop references are valid
  - Ensures `onResult.goto` and `notify.agent` references are valid
  - Checks for duplicate agent/step IDs

### `template.ts`
- **resolveTemplate(template, variables)** — Resolve `{{variable}}` placeholders
- **extractVariables(template)** — Extract all variable names from a template
- **createLoopVariables(...)** — Create loop-specific variables
- **mergeVariables(...sources)** — Merge multiple variable sources

### `index.ts`
- Barrel export for the module

### `/pipelines/engineering.yml`
- Complete engineering pipeline with 7 main steps + 1 on-demand step
- Uses all 7 agent personas (Eric, Finn, Shigeo, Yukihiro, Chieko, Stas, Yang)
- Implements the full workflow from SPEC → DESIGN → UX → IMPLEMENT (loop) → REVIEW → TEST → DEPLOY
- Includes proper loop configuration with `task_breakdown_json`
- Includes conditional routing based on review/test results
- Uses specified models (Claude Opus 4 for Eric, Kimi k2.5 for others)

## Usage

```typescript
import { parsePipeline, resolveTemplate } from './pipeline/index.js';

// Load and validate pipeline
const pipeline = parsePipeline('../../pipelines/engineering.yml');

// Resolve template variables in step inputs
const variables = {
  task_description: "Build a REST API",
  product_brief: "...",
  requirements_doc: "..."
};

const resolvedInput = resolveTemplate(pipeline.steps[1].input, variables);
```

## Validation Features

The parser validates:
- ✅ Required fields (id, name, version, agents, steps)
- ✅ Agent configs (id, name, persona, model, tools)
- ✅ Step configs (id, agent, input, outputs)
- ✅ Loop configs (over, onEachComplete, onAllComplete)
- ✅ Step result actions (continueLoop, retry, notify, goto)
- ✅ Cross-references (agent/step IDs must exist)
- ✅ No duplicate IDs

Throws clear, detailed errors on validation failure.
