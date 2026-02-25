---
title: Core Concepts
weight: 2
---

Understand how DjinnBot works under the hood. These concepts form the foundation of everything the platform does — from agent personas to parallel swarm execution.

{{< cards >}}
  {{< card link="architecture" title="Architecture" subtitle="Services, event bus, swarm executor, and how containers fit together." icon="server" >}}
  {{< card link="agents" title="Agents" subtitle="Personas, coordination, built-in tool control, and the files that define an agent." icon="user-group" >}}
  {{< card link="pipelines" title="Pipelines" subtitle="YAML workflow definitions with steps, loops, branching, and structured output." icon="document-text" >}}
  {{< card link="memory" title="Memory System" subtitle="ClawVault, semantic search, memory scoring, 3D knowledge graphs, and consolidation." icon="database" >}}
  {{< card link="skills" title="Skills" subtitle="On-demand instruction sets agents load when they need them." icon="academic-cap" >}}
  {{< card link="mcp-tools" title="MCP Tools" subtitle="External tool servers converted to native agent tools via mcpo." icon="puzzle" >}}
  {{< card link="pulse" title="Pulse Mode" subtitle="Autonomous agent wake-up cycles with named routines and coordination." icon="clock" >}}
  {{< card link="containers" title="Agent Containers" subtitle="Isolated Docker environments with full engineering toolboxes." icon="shield-check" >}}
  {{< card link="storage" title="Storage Layer" subtitle="JuiceFS + RustFS distributed filesystem shared across all containers." icon="archive-box" >}}
  {{< card link="workspaces" title="Workspaces" subtitle="Git worktree isolation, persistent directories, and pipeline vs pulse strategies." icon="folder-open" >}}
  {{< card link="secrets" title="Secrets Management" subtitle="AES-256-GCM encrypted credentials with per-agent access control." icon="lock-closed" >}}
{{< /cards >}}
