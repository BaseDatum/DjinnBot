---
title: Skills
weight: 5
---

Skills are on-demand instruction sets that agents can load when they need specialized knowledge. Instead of stuffing every possible instruction into an agent's system prompt, skills are discovered and loaded contextually.

## How Skills Work

1. On session start, the agent receives a **skill manifest** — a compact list of available skills with descriptions
2. When the agent encounters a task that matches a skill, it calls `load_skill("name")`
3. The full skill instructions are loaded into context
4. The agent follows the skill's procedures

This keeps system prompts lean while giving agents access to deep, specialized knowledge when needed.

## Skill File Format

Skills are markdown files with YAML frontmatter:

```markdown
---
name: github-pr
description: Opening and merging GitHub pull requests
tags: [github, git, pr, pull-request, merge]
enabled: true
---

# GitHub PR Skill

## When to Use
When you need to open a pull request, review PR changes, or merge branches.

## Steps
1. Ensure all changes are committed and pushed
2. Create PR with descriptive title and body
3. Link to relevant issue or task
...
```

## Skill Locations

Skills can be stored at two levels:

| Location | Scope | Path |
|----------|-------|------|
| Global | Available to all agents | `agents/_skills/*.md` |
| Agent-specific | Only for one agent | `agents/<id>/skills/*.md` |

Agent-specific skills override global skills with the same name.

## Automatic Matching

The engine automatically matches skills to pipeline steps by comparing skill tags against the step input text. If a step mentions "github" or "pull request," skills tagged with those keywords are auto-injected.

This means agents often get the right skills without explicitly calling `load_skill()`.

## Managing Skills

### Dashboard

The Skills page in the dashboard lets you:

- View all global and agent-specific skills
- Enable/disable skills without deleting them
- Edit skill content
- Create new skills

### Skill Generator

The dashboard includes a skill generator — an AI-assisted chat session that helps you create new skills through conversation. Describe what the skill should cover and it writes the instructions.

### API

```bash
# List skills
GET /v1/skills

# Get a specific skill
GET /v1/skills/{name}?agent_id=yukihiro

# Create a skill
POST /v1/skills
{
  "name": "my-skill",
  "description": "Does something useful",
  "tags": ["relevant", "tags"],
  "content": "# My Skill\n\n...",
  "scope": "global"
}

# Toggle enabled state
PATCH /v1/skills/{name}/enabled
{ "enabled": false }
```

## Creating Effective Skills

Good skills are:

- **Specific** — focused on one domain or task type
- **Procedural** — step-by-step instructions, not vague guidance
- **Tagged well** — keywords that match when agents encounter relevant tasks
- **Example-rich** — show concrete examples of commands, code, and output
