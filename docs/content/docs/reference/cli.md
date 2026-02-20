---
title: CLI Reference
weight: 2
---

The DjinnBot CLI provides command-line access to all platform features.

## Installation

```bash
cd cli
pip install -e .
djinnbot --help
```

The CLI connects to the API server at `http://localhost:8000` by default. Override with `--api-url` or the `DJINNBOT_API_URL` environment variable.

## Commands

### Status

```bash
djinnbot status
```

Show server health, Redis connection, and summary statistics.

### Pipelines

```bash
# List all pipelines
djinnbot pipeline list

# Show pipeline details
djinnbot pipeline show engineering

# Start a new run
djinnbot pipeline start engineering \
  --task "Build a task management CLI tool in Python"
```

### Runs

```bash
# List recent runs
djinnbot run list

# Show run details
djinnbot run show <run-id>

# Stream run output in real-time
djinnbot run stream <run-id>

# Cancel a running pipeline
djinnbot run cancel <run-id>

# Restart a failed run
djinnbot run restart <run-id>
```

### Steps

```bash
# List steps for a run
djinnbot step list <run-id>

# Show step details
djinnbot step show <run-id> <step-id>

# View step output
djinnbot step output <run-id> <step-id>
```

### Agents

```bash
# List all agents
djinnbot agent list

# Show agent details
djinnbot agent show eric

# View agent run history
djinnbot agent runs eric
```

### Memory

```bash
# List vaults
djinnbot memory list-vaults

# Search agent memory
djinnbot memory search eric "architecture decisions"

# View vault contents
djinnbot memory vault eric

# Search shared knowledge
djinnbot memory shared "deployment patterns"
```

## Output Format

The CLI uses [Rich](https://github.com/Textualize/rich) for terminal formatting — tables, syntax highlighting, progress bars, and colored output. Pipe to a file or use `--json` for machine-readable output.
