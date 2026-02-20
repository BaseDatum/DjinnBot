
---

## Memory Tools

You have a persistent memory vault that survives across sessions. Use it to learn and improve over time.

- Run `clawvault wake` at session start.
- Run `clawvault checkpoint` during heavy work.
- Run `clawvault sleep "summary" --next "next steps"` before ending.
- Use `clawvault context "<task>"` or `clawvault inject "<message>"` before complex decisions.

### Available Tools

#### `recall` - Search Your Memories
Search your vault for relevant context before making decisions or responding.

```
recall("search query", { limit: 5, profile: "default" })
```

**Profiles:**
- `default` - General purpose retrieval
- `planning` - Optimized for task planning context
- `incident` - Focused on errors and lessons learned
- `handoff` - Session continuity information

**Use recall when:**
- Starting a new task (what do I know about this?)
- Someone mentions a topic you've discussed before
- You need to remember past decisions or patterns
- Looking for lessons from previous mistakes

#### `remember` - Save to Your Vault
Store important information for future reference.

```
remember(type, "Title", "Content with details", { tags: ["relevant", "tags"] })
```

**Memory Types:**
- `lesson` - Something you learned from a mistake or success
- `decision` - Important choice and its rationale
- `pattern` - Recurring approach that works well
- `fact` - Important information about the project/team
- `preference` - How someone or something prefers to work
- `handoff` - Context for resuming work later

**Save memories when:**
- You make a mistake and learn how to avoid it
- You discover how a teammate prefers to work
- You identify a pattern that speeds up future work
- You make a significant decision with reasoning
- You complete important work worth remembering
- You receive feedback that changes how you operate

### Memory Best Practices

1. **Search before you act** — Check if you already know something relevant
2. **Be specific** — "Eric prefers bullet points in specs" > "Eric has preferences"
3. **Include context** — Why does this matter? When does it apply?
4. **Use wiki-links** — Connect related memories with [[Topic Name]] syntax
5. **Tag appropriately** — Makes future search more effective

### Example Memory Patterns

**Lesson from a mistake:**
```
remember("lesson", "API response validation", 
  "Always validate response shape before accessing nested fields. " +
  "Got a runtime error when API returned unexpected format. " +
  "Solution: Use optional chaining and provide defaults.",
  { tags: ["api", "error-handling", "typescript"] })
```

**Team preference:**
```
remember("preference", "Sky prefers concise updates",
  "Sky mentioned they prefer brief status updates rather than detailed explanations. " +
  "Lead with the outcome, add details only if asked.",
  { tags: ["communication", "sky"] })
```

**Technical pattern:**
```
remember("pattern", "Structured output for reliability",
  "When extracting structured data from LLM responses, use JSON schema validation. " +
  "This catches format errors before they propagate downstream.",
  { tags: ["llm", "structured-output", "reliability"] })
```

### Shared Memories

Add `shared: true` to share a memory with all agents:
```
remember("fact", "Project deadline", "Launch target is March 15", { shared: true })
```

Use shared memories for:
- Project-wide facts and decisions
- Team conventions everyone should know
- Deadlines and milestones
- Architecture decisions that affect everyone

### Linked Memory Protocol — The Law of Anchoring

> **An unlinked memory is a lost memory.**

Every memory you create about a specific project MUST be anchored to that project's root node in the knowledge graph. Without this link, the memory is an island — no other agent can traverse to it, and it effectively disappears into the vault.

**How graph traversal works:** When another agent recalls context about a project, they start from `[[Project: <Name>]]` and follow wiki-links to discover related nodes. If your memory doesn't contain `[[Project: <Name>]]`, it is unreachable by graph traversal.

#### The Anchor Pattern

**Step 1 — Create or update the project anchor (once per project, first agent to touch it):**
```javascript
remember("fact", "Project: MyApp",
  "Root anchor for project MyApp. Created during onboarding.\n" +
  "Goal: [[MyApp: Goal]]\n" +
  "Tech: [[MyApp: Tech stack — MyApp]]\n" +
  "Business: [[MyApp: Monetization]]\n" +
  "Scope: [[MyApp: V1 Scope]]",
  { shared: true, tags: ["project:myapp", "project-anchor"] }
)
```

**Step 2 — Every subsequent memory links back:**
```javascript
remember("decision", "MyApp: Monetization",
  "[[Project: MyApp]] will use a freemium model with $20/mo Pro tier.\n" +
  "Target users: indie developers and small teams.\n" +
  "First revenue milestone: $1k MRR in 6 months.\n" +
  "Related: [[MyApp: Target Customer]], [[MyApp: Timeline]].",
  { shared: true, tags: ["project:myapp", "monetization"] }
)
```

**Step 3 — Update the anchor to reference the new node:**
After creating a new project memory, add its title to the anchor's content so the graph stays two-directional.

#### Naming Convention

| Memory | Title Format |
|--------|-------------|
| Project root | `Project: <Name>` |
| Goal/vision | `<Name>: Goal` |
| Repository | `<Name>: Repository` |
| Tech stack | `<Name>: Tech stack — <Name>` |
| Business model | `<Name>: Monetization` |
| Target users | `<Name>: Target Customer` |
| V1 scope | `<Name>: V1 Scope` |
| Infrastructure | `<Name>: Infrastructure` |
| Timeline | `<Name>: Timeline` |
| Architecture | `<Name>: Architecture` |
| Any other fact | `<Name>: <Topic>` |

The `<Name>:` prefix is critical — it namespaces memories to the project and makes them findable by both search and graph traversal.
