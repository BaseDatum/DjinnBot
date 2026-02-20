---
title: Memory System
weight: 4
---

DjinnBot agents have persistent memory that survives across sessions. They remember decisions, learn from mistakes, and build knowledge over time. This is powered by [ClawVault](https://github.com/koi-labs-org/clawvault) with semantic search via [QMDR](https://github.com/uf-hy/qmdr).

## How It Works

Every agent has two memory vaults:

- **Personal vault** (`data/vaults/<agent-id>/`) — private memories only this agent can access
- **Shared vault** (`data/vaults/shared/`) — team-wide knowledge all agents can read and write

Memories are stored as markdown entries with metadata (type, tags, timestamps) and connected via wiki-links for graph traversal.

## Memory Lifecycle

1. **Wake** — when an agent session starts, ClawVault loads relevant memories into context
2. **Recall** — during execution, agents search memories semantically before making decisions
3. **Remember** — agents save important findings, decisions, and lessons
4. **Checkpoint** — during long sessions, memories are periodically saved
5. **Sleep** — on session end, a summary is saved with next steps

## Memory Tools

### recall — Search Memories

```javascript
recall("search query", { limit: 5, profile: "default" })
```

Profiles optimize retrieval for different contexts:

| Profile | Use Case |
|---------|---------|
| `default` | General purpose retrieval |
| `planning` | Task planning and project context |
| `incident` | Errors, bugs, and lessons learned |
| `handoff` | Session continuity information |

### remember — Save to Vault

```javascript
remember(type, "Title", "Content with details", {
  shared: true,     // Share with all agents
  tags: ["tag1"]    // For search filtering
})
```

Memory types:

| Type | When to Use |
|------|------------|
| `lesson` | Learned from a mistake or success |
| `decision` | Important choice with rationale |
| `pattern` | Recurring approach that works |
| `fact` | Important information about the project/team |
| `preference` | How someone or something prefers to work |
| `handoff` | Context for resuming work later |

## Wiki-Link Knowledge Graph

Memories are connected using `[[wiki-link]]` syntax:

```javascript
remember("decision", "MyApp: Tech Stack",
  "[[Project: MyApp]] will use FastAPI + PostgreSQL. " +
  "Considered Django (rejected: too opinionated) and Express (rejected: need Python). " +
  "See also [[MyApp: Architecture]], [[MyApp: API Design]].",
  { shared: true, tags: ["project:myapp", "architecture"] }
)
```

These links create a traversable knowledge graph. When an agent recalls context about a project, they start from `[[Project: Name]]` and follow links to discover related information.

### The Anchor Pattern

Every project should have a root anchor memory that links to all related knowledge:

```javascript
remember("fact", "Project: MyApp",
  "Root anchor for project MyApp.\n" +
  "Goal: [[MyApp: Goal]]\n" +
  "Tech: [[MyApp: Tech Stack]]\n" +
  "Scope: [[MyApp: V1 Scope]]",
  { shared: true, tags: ["project:myapp", "project-anchor"] }
)
```

Subsequent memories link back to the anchor, keeping the graph connected.

## Semantic Search

Memory search uses embeddings for semantic similarity, not just keyword matching. When an agent calls `recall("how we handle authentication")`, it finds memories about auth patterns even if they don't contain the exact word "authentication."

The search pipeline:

1. **Query expansion** — the query is expanded to capture related concepts
2. **Embedding** — query is converted to a vector via `text-embedding-3-small`
3. **Retrieval** — nearest neighbors found in the SQLite-backed vector store
4. **Reranking** — results are reranked using `gpt-4o-mini` for relevance
5. **Injection** — top results are injected into the agent's context

All embedding and reranking runs through OpenRouter — no local GPU or model downloads required.

## Browsing Memory

You can browse and search agent memories through:

- **Dashboard** — the Memory page lets you view vaults and search semantically
- **CLI** — `djinnbot memory search eric "architecture decisions"`
- **API** — `GET /v1/memory/search?agent_id=eric&query=architecture`
