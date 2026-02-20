# Djinnbot CLI

Python CLI for the djinnbot event-driven agent orchestration framework.

## Installation

```bash
cd cli
pip install -e .
```

## Usage

```bash
# Show help
djinnbot --help

# Show system status
djinnbot status

# List agents
djinnbot agents --list

# Run a pipeline
djinnbot pipelines --run my-pipeline

# Emit an event
djinnbot events --emit user.message
```

## Development

```bash
# Install in development mode
pip install -e ".[dev]"

# Run with hot reload
python -m djinnbot.main status
```
