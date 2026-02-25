---
title: Memory System
weight: 4
---

DjinnBot agents have persistent memory that survives across sessions. They remember decisions, learn from mistakes, and build knowledge over time. Unlike most AI tools that start every session from scratch, DjinnBot agents accumulate experience — and that experience makes them more effective with every interaction.

Memory is powered by [ClawVault](https://github.com/koi-labs-org/clawvault) with semantic search via [QMDR](https://github.com/uf-hy/qmdr).

## How It Works

Every agent has two memory vaults:

- **Personal vault** (`data/vaults/<agent-id>/`) — private memories only this agent can access
- **Shared vault** (`data/vaults/shared/`) — team-wide knowledge all agents can read and write

Memories are stored as markdown entries with metadata (type, tags, timestamps) and connected via wiki-links for graph traversal.

## Memory Lifecycle

```mermaid
graph LR
    Wake["Wake"] --> Recall["Recall"]
    Recall --> Work["Work"]
    Work --> Remember["Remember"]
    Remember --> Checkpoint["Checkpoint"]
    Checkpoint --> Sleep["Sleep"]
    
    style Wake fill:#3b82f6,color:#fff
    style Recall fill:#8b5cf6,color:#fff
    style Work fill:#f59e0b,color:#000
    style Remember fill:#059669,color:#fff
    style Checkpoint fill:#ec4899,color:#fff
    style Sleep fill:#6366f1,color:#fff
```

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
| `commitment` | Promises made with deadlines (used by Grace) |
| `relationship` | People, connections, affiliations (used by Grace) |

## Wiki-Link Knowledge Graph

Memories are connected using `[[wiki-link]]` syntax, creating a traversable knowledge graph:

```javascript
remember("decision", "MyApp: Tech Stack",
  "[[Project: MyApp]] will use FastAPI + PostgreSQL. " +
  "Considered Django (rejected: too opinionated) and Express (rejected: need Python). " +
  "See also [[MyApp: Architecture]], [[MyApp: API Design]].",
  { shared: true, tags: ["project:myapp", "architecture"] }
)
```

These links create a web of connected knowledge. When an agent recalls context about a project, they start from `[[Project: Name]]` and follow links to discover related information — tech stack decisions, architectural patterns, past bugs, team preferences, and more.

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

Subsequent memories link back to the anchor, keeping the graph connected and navigable.

## Adaptive Memory Scoring

Not all memories are equally useful. DjinnBot's adaptive scoring system learns which memories actually help agents accomplish tasks, and uses that signal to re-rank future `recall()` results. Scoring is driven entirely by **agent valuations** — explicit "useful / not useful" judgments from the `rate_memories` tool — not by step success or failure.

### How It Works

Four database tables work together:

| Table | Purpose |
|-------|---------|
| `memory_retrieval_log` | Raw append-only events. One row per memory surfaced during a `recall()` or `wake()` call. Used for analytics and access counting. |
| `memory_valuations` | Agent-authored usefulness ratings. The **primary scoring signal**. Created when an agent calls `rate_memories` after consuming recalled memories. |
| `memory_gaps` | Knowledge the agent needed but couldn't find. Aggregated in the dashboard to surface systemic knowledge holes. |
| `memory_scores` | Materialized aggregates per `(agent_id, memory_id)`. Updated atomically on retrieval and valuation events. Queried at recall time. |

### The Scoring Formula

The adaptive score for each memory is a weighted blend of three components:

```
adaptive_score = usefulness * w_usefulness + recency * w_recency + frequency * w_frequency
```

**Usefulness** (default weight: 0.60) — the dominant signal:
- Computed as `useful_count / valuation_count` from agent ratings
- Memories with fewer than `min_valuations_for_signal` (default: 3) ratings use a neutral score of 0.5 — a single "not useful" can't tank a memory
- **Rehabilitation decay**: old negative scores fade toward neutral (0.5) over `rehabilitation_half_life_days` (default: 90 days), preventing permanent punishment

**Recency** (default weight: 0.25):
- Exponential decay from `last_accessed` with a configurable half-life (default: 30 days)
- Floored at 0.30 — even a memory untouched for years retains some recency signal

**Frequency** (default weight: 0.15):
- `log(access_count + 1)` normalized against a cap (default: 50 retrievals = max signal)

A hard floor of 0.35 ensures no memory is ever completely suppressed.

### Score Blending at Recall Time

When `recall()` returns results, raw search scores (BM25 / vector similarity) are blended with adaptive scores:

```
blended = rawScore * (base_factor + boost_factor * adaptive_score)
```

With defaults (`base_factor=0.70`, `boost_factor=0.30`), a memory with a neutral adaptive score (0.5) leaves the raw score unchanged. Memories rated consistently useful get boosted; memories rated not-useful get slightly depressed but never zeroed out.

### The `rate_memories` Tool

Agents call this tool to submit valuations after consuming recalled memories:

```javascript
rate_memories({
  ratings: [
    { memoryId: "mem_abc123", useful: true },
    { memoryId: "mem_def456", useful: false }
  ],
  gap: "How we handle rate limiting in the API",  // optional
  gapQuery: "rate limiting middleware"              // optional
})
```

The boolean `useful` field is intentionally simple — agents are reliable at binary "helped / didn't help" judgments. Numeric scales add calibration noise.

### Configuration

All scoring parameters are configurable through the dashboard (**Settings > Memory Scoring**) or the API (`/v1/memory-scoring/config`). Changes take effect immediately — no restart needed.

| Parameter | Default | Description |
|-----------|---------|------------|
| `min_valuations_for_signal` | 3 | Minimum ratings before usefulness is trusted |
| `recency_half_life_days` | 30 | Days until recency signal drops to half |
| `rehabilitation_half_life_days` | 90 | Days until negative scores fade to neutral |
| `adaptive_score_floor` | 0.35 | Hard minimum for any memory's adaptive score |
| `frequency_log_cap` | 50 | Retrievals needed for max frequency signal |
| `blend_usefulness_weight` | 0.60 | Weight of agent usefulness ratings |
| `blend_recency_weight` | 0.25 | Weight of recency signal |
| `blend_frequency_weight` | 0.15 | Weight of access frequency |
| `blend_base_factor` | 0.70 | Baseline multiplier for raw search scores |
| `blend_boost_factor` | 0.30 | How much adaptive scores can boost/penalize |

Set `blend_boost_factor` to 0.0 to disable adaptive scoring entirely, or `adaptive_score_floor` to 0.5 to make all memories score equally.

## 3D Knowledge Graph Visualization

The dashboard includes an interactive 3D visualization of the memory knowledge graph, powered by Three.js and WebGL:

- **Nodes** represent individual memories, colored by type
- **Edges** represent wiki-link connections between memories
- **Clusters** emerge naturally around projects, people, and topics
- **Interactive** — rotate, zoom, click nodes to inspect memories, filter by agent or type

This visualization makes it easy to understand how your team's knowledge connects and identify gaps or orphaned memories. Access it from the **Memory** page in the dashboard.

## Automatic Memory Consolidation

During session teardown (particularly Slack sessions), DjinnBot automatically consolidates memories:

1. Reviews the session's conversation and decisions
2. Extracts key learnings, decisions, and action items
3. Stores them as structured memories with proper wiki-links
4. Avoids duplicating existing memories by searching first

This means that even casual Slack conversations contribute to the team's knowledge base without any manual effort.

## Semantic Search

Memory search uses embeddings for semantic similarity, not just keyword matching. When an agent calls `recall("how we handle authentication")`, it finds memories about auth patterns even if they don't contain the exact word "authentication."

The search pipeline:

{{% steps %}}

### Query expansion

The query is expanded to capture related concepts.

### Embedding

Query is converted to a vector via `text-embedding-3-small`.

### Retrieval

Nearest neighbors found in the SQLite-backed vector store.

### Reranking

Results are reranked using `gpt-4o-mini` for relevance, weighted by memory scores.

### Injection

Top results are injected into the agent's context.

{{% /steps %}}

All embedding and reranking runs through OpenRouter — no local GPU or model downloads required.

## Browsing Memory

You can browse and search agent memories through:

- **Dashboard** — the Memory page with 2D and 3D graph views, semantic search, and per-agent filtering
- **CLI** — `djinn memory search "architecture decisions" --agent finn`
- **API** — `GET /v1/memory/search?agent_id=eric&query=architecture`
