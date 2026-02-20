---
title: Your First Run
weight: 2
---

Now that DjinnBot is running, let's kick off a pipeline and watch agents collaborate in real-time.

## Start a Pipeline via the Dashboard

1. Open **http://localhost:3000**
2. Click **New Run** in the top navigation
3. Select the **engineering** pipeline
4. Enter a task description, for example:

   > Build a REST API for a bookmarks manager with CRUD endpoints, tag support, and search. Use FastAPI and SQLite.

5. Click **Start Run**

## What Happens Next

The engineering pipeline assigns work through these stages:

```
SPEC (Eric) → DESIGN (Finn) → UX (Shigeo) → IMPLEMENT (Yukihiro)
                                                     ↕
                                               REVIEW (Finn)
                                                     ↕
                                                TEST (Chieko)
                                                     ↓
                                               DEPLOY (Stas)
```

1. **Eric** (Product Owner) reads your task description and produces requirements, user stories, and acceptance criteria
2. **Finn** (Architect) takes Eric's requirements and designs the architecture, API, database schema, and task breakdown
3. **Shigeo** (UX) creates UX specifications and design system guidelines
4. **Yukihiro** (SWE) implements each task from the breakdown — writing actual code in an isolated container
5. **Finn** reviews each implementation, approving or requesting changes
6. **Chieko** (QA) tests approved implementations, passing or sending back for fixes
7. **Stas** (SRE) handles deployment once all tasks pass

Each agent runs in its own Docker container with a full toolbox — they can read files, write code, run bash commands, use git, and more.

## Watch in Real-Time

The dashboard shows:

- **Pipeline progress** — which step is active, which are complete
- **Streaming output** — agent responses stream in real-time as they think and work
- **Thinking blocks** — expandable sections showing the agent's reasoning process
- **Tool calls** — every file read, write, bash command, and git operation
- **Step transitions** — when agents hand off to the next step

## Start a Pipeline via CLI

If you prefer the command line, install the CLI:

```bash
cd cli
pip install -e .
```

Then run:

```bash
# List available pipelines
djinnbot pipeline list

# Start a run
djinnbot pipeline start engineering \
  --task "Build a REST API for a bookmarks manager"

# Watch the output stream
djinnbot run stream <run-id>
```

## Start a Pipeline via API

```bash
curl -X POST http://localhost:8000/v1/runs \
  -H "Content-Type: application/json" \
  -d '{
    "pipeline_id": "engineering",
    "task_description": "Build a REST API for a bookmarks manager"
  }'
```

## Try Other Pipelines

| Pipeline | Best For | Agents Involved |
|----------|---------|----------------|
| `engineering` | Full projects from scratch | All engineering agents |
| `feature` | Adding a feature to existing code | Finn, Yukihiro, Chieko |
| `bugfix` | Diagnosing and fixing bugs | Yukihiro, Chieko |
| `planning` | Breaking down a project into tasks | Eric, Finn |

## Chat With Agents

Don't want to run a pipeline? Talk to any agent directly:

1. Go to the **Chat** page in the dashboard
2. Select an agent (e.g., Finn for architecture advice)
3. Start a conversation

Chat sessions use the same isolated containers and full toolbox. Agents can read and write code, search the web, and use all their tools — just like in a pipeline, but interactive.

## Next Steps

{{< cards >}}
  {{< card link="../dashboard-tour" title="Dashboard Tour" subtitle="Learn to navigate the full dashboard interface." >}}
  {{< card link="/docs/concepts/pipelines" title="Understanding Pipelines" subtitle="Learn how YAML pipelines work." >}}
  {{< card link="/docs/guides/slack-setup" title="Set Up Slack" subtitle="Give each agent its own Slack bot." >}}
{{< /cards >}}
