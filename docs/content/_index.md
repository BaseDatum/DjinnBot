---
title: DjinnBot
layout: hextra-home
---

<style>
/* ── Token efficiency metric cards ─────────────────────────── */
.token-grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(280px, 1fr));
  gap: 1.25rem;
  margin: 2rem 0;
}
.token-card {
  border: 1px solid rgba(128,128,128,0.2);
  border-radius: 12px;
  padding: 1.5rem;
  position: relative;
  overflow: hidden;
}
.token-card .label {
  font-size: 0.85rem;
  opacity: 0.7;
  margin-bottom: 0.25rem;
}
.token-card .task {
  font-weight: 600;
  font-size: 1rem;
  margin-bottom: 1rem;
  line-height: 1.4;
}
.token-bar {
  display: flex;
  align-items: center;
  gap: 0.75rem;
  margin-bottom: 0.5rem;
  font-size: 0.85rem;
}
.token-bar .bar {
  height: 8px;
  border-radius: 4px;
  flex-shrink: 0;
}
.token-bar .bar-other {
  background: #ef4444;
  opacity: 0.7;
}
.token-bar .bar-djinn {
  background: #10b981;
}
.token-bar .num {
  white-space: nowrap;
  min-width: 5rem;
}
.token-card .reduction {
  position: absolute;
  top: 1.25rem;
  right: 1.5rem;
  font-size: 1.5rem;
  font-weight: 800;
  color: #10b981;
}
.token-card .how {
  font-size: 0.8rem;
  opacity: 0.6;
  margin-top: 0.5rem;
}

/* ── Agent roster ──────────────────────────────────────────── */
.agent-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(300px, 1fr));
  gap: 1rem;
  margin: 2rem 0;
}
.agent-card {
  border: 1px solid rgba(128,128,128,0.2);
  border-radius: 10px;
  padding: 1rem 1.25rem;
  display: flex;
  flex-direction: column;
  gap: 0.25rem;
}
.agent-card .agent-name {
  font-weight: 700;
  font-size: 1rem;
}
.agent-card .agent-role {
  font-size: 0.8rem;
  font-weight: 600;
  opacity: 0.6;
  text-transform: uppercase;
  letter-spacing: 0.04em;
}
.agent-card .agent-desc {
  font-size: 0.88rem;
  opacity: 0.8;
  line-height: 1.45;
  margin-top: 0.25rem;
}

/* ── Comparison feature rows ───────────────────────────────── */
.compare-grid {
  display: grid;
  gap: 0.5rem;
  margin: 2rem 0;
}
.compare-row {
  display: grid;
  grid-template-columns: 1fr 1fr 1fr;
  gap: 1rem;
  padding: 1rem 1.25rem;
  border-radius: 10px;
  align-items: start;
}
.compare-row:nth-child(odd) {
  background: rgba(128,128,128,0.05);
}
.compare-row .col-label {
  font-weight: 700;
  font-size: 0.9rem;
}
.compare-row .col-val {
  font-size: 0.88rem;
  line-height: 1.45;
}
.compare-row .col-val.djinn {
  color: #10b981;
  font-weight: 600;
}
.compare-row .col-val.muted {
  opacity: 0.5;
}
.compare-header {
  display: grid;
  grid-template-columns: 1fr 1fr 1fr;
  gap: 1rem;
  padding: 0.5rem 1.25rem 0.75rem;
  border-bottom: 2px solid rgba(128,128,128,0.15);
  margin-bottom: 0.25rem;
}
.compare-header span {
  font-weight: 800;
  font-size: 0.8rem;
  text-transform: uppercase;
  letter-spacing: 0.05em;
  opacity: 0.6;
}
@media (max-width: 640px) {
  .compare-row, .compare-header {
    grid-template-columns: 1fr;
    gap: 0.25rem;
  }
  .compare-header span:not(:first-child) { display: none; }
  .compare-row .col-val::before {
    font-weight: 600;
    font-size: 0.75rem;
    opacity: 0.5;
    display: block;
  }
  .compare-row .col-val.djinn::before { content: "DjinnBot: "; }
  .compare-row .col-val.muted::before { content: "Others: "; }
}
</style>

<div class="hx-mt-6 hx-mb-6">
{{< hextra/hero-headline >}}
  Autonomous AI Teams<br class="sm:hx-block hx-hidden" /> That Can Do Anything
{{< /hextra/hero-headline >}}
</div>

<div class="hx-mb-12">
{{< hextra/hero-subtitle >}}
  Deploy a team of AI agents that collaborate autonomously — engineering, research, content, operations, finance, or any workflow you define. Each agent has a real persona, persistent memory, and a full toolbox inside an isolated container. Self-hosted and free.
{{< /hextra/hero-subtitle >}}
</div>

<div class="hx-mb-6">
{{< hextra/hero-button text="Join the Waitlist" link="https://app.djinn.bot" >}}
{{< hextra/hero-button text="Get Started" link="docs/getting-started/" style="alt" >}}
{{< hextra/hero-button text="GitHub" link="https://github.com/BaseDatum/djinnbot" style="alt" >}}
</div>

<div class="hx-mt-6"></div>

{{< hextra/feature-grid >}}
  {{< hextra/feature-card
    title="40x Token Efficiency"
    subtitle="Other tools waste 20,000 tokens reading files to understand a single function. DjinnBot does it in 500. The Code Knowledge Graph, Programmatic Tool Calling, and focused delegation keep context windows lean — so agents reason better and cost less."
    class="hx-aspect-auto md:hx-aspect-[1.1/1] max-md:hx-min-h-[340px]"
    icon="lightning-bolt"
    style="background: radial-gradient(ellipse at 50% 80%,rgba(16,185,129,0.15),hsla(0,0%,100%,0));"
  >}}
  {{< hextra/feature-card
    title="Full Cost Visibility"
    subtitle="Every LLM API call logged with model, tokens, latency, cost, and who triggered it. Per-user and per-agent dashboards. Provider-level breakdowns. You will never wonder where the money went."
    class="hx-aspect-auto md:hx-aspect-[1.1/1] max-md:hx-min-h-[340px]"
    icon="chart-bar"
    style="background: radial-gradient(ellipse at 50% 80%,rgba(142,53,234,0.15),hsla(0,0%,100%,0));"
  >}}
  {{< hextra/feature-card
    title="5-Minute Setup"
    subtitle="One curl command. The setup wizard handles secrets, API keys, Docker, and optional SSL. No Kubernetes, no cloud accounts, no YAML wrangling. Your AI team is running before your coffee gets cold."
    class="hx-aspect-auto md:hx-aspect-[1.1/1] max-md:hx-min-h-[340px]"
    icon="play"
    style="background: radial-gradient(ellipse at 50% 80%,rgba(45,112,234,0.15),hsla(0,0%,100%,0));"
  >}}
  {{< hextra/feature-card
    title="11 Agents, Any Workflow"
    subtitle="Not generic chatbots — real characters with backstories, opinions, and domain expertise. Ships with a full engineering team, an executive assistant, marketing, SEO, and finance leads. Customize the team or build your own agents for any domain."
    icon="user-group"
  >}}
  {{< hextra/feature-card
    title="Container Isolation"
    subtitle="Every agent runs in its own ephemeral Docker container with a full toolbox — Node 22, Python, Go, Rust, an anti-detection browser, and 30+ tools. No host access. Destroyed after every step."
    icon="shield-check"
  >}}
  {{< hextra/feature-card
    title="Swarm Execution"
    subtitle="Run multiple agents in parallel on DAG-aware task graphs. A planning agent decomposes the work, and a swarm executes it concurrently — respecting dependencies, streaming progress live."
    icon="beaker"
  >}}
  {{< hextra/feature-card
    title="Persistent Memory"
    subtitle="Agents remember decisions, lessons, and patterns across runs via ClawVault with semantic search. Memory scoring surfaces the most relevant context. Explore connections in an interactive 3D knowledge graph."
    icon="database"
  >}}
  {{< hextra/feature-card
    title="Real-Time Dashboard"
    subtitle="Live activity feeds, kanban boards, pipeline visualization, swarm DAG views, 3D memory graphs, file uploads, and a full admin panel. Not a terminal dump."
    icon="desktop-computer"
  >}}
  {{< hextra/feature-card
    title="YAML Pipelines"
    subtitle="Define any multi-agent workflow as simple YAML — steps, agents, branching, loops, retries, structured output, and per-step model overrides. Drop a file in pipelines/ and it's live."
    icon="document-text"
  >}}
  {{< hextra/feature-card
    title="Enterprise Auth"
    subtitle="Multi-user accounts, TOTP 2FA, API keys, OIDC SSO, per-user provider key sharing, and automatic SSL via Let's Encrypt. Built into the core from day one."
    icon="lock-closed"
  >}}
  {{< hextra/feature-card
    title="Slack-Native"
    subtitle="Each agent gets its own Slack bot. Watch your team discuss in threads. Mention agents for their perspective. Or skip Slack and use the built-in chat or CLI."
    icon="chat-alt-2"
  >}}
  {{< hextra/feature-card
    title="Open Core"
    subtitle="Self-hosted is completely free. FSL-1.1-ALv2 license converts to Apache 2.0 after 2 years. No vendor lock-in, no usage limits, no phone-home."
    icon="code"
  >}}
{{< /hextra/feature-grid >}}

---

<div style="text-align: center; margin-top: 4rem; margin-bottom: 0.5rem;">

## More Done, Less Context

</div>

<div class="hx-mt-2 hx-mb-8" style="max-width: 62rem; margin-left: auto; margin-right: auto;">

<p style="text-align: center; max-width: 40rem; margin: 0 auto 2rem; opacity: 0.8;">
Most agent tools burn through context windows dumping raw files and verbose schemas into every turn. DjinnBot is engineered to minimize token waste &mdash; so agents spend context on <em>reasoning</em>, not reading.
</p>

<div class="token-grid">

<div class="token-card">
  <div class="reduction">40x</div>
  <div class="task">Understand a function and every caller &amp; callee</div>
  <div class="token-bar">
    <span class="num" style="opacity:0.6">Others</span>
    <span class="bar bar-other" style="width:100%"></span>
    <span class="num" style="opacity:0.6">~20,000 tok</span>
  </div>
  <div class="token-bar">
    <span class="num" style="color:#10b981;font-weight:600">DjinnBot</span>
    <span class="bar bar-djinn" style="width:2.5%"></span>
    <span class="num" style="color:#10b981;font-weight:600">~500 tok</span>
  </div>
  <div class="how">1 call to <code>code_graph_context</code> vs. 15+ file reads</div>
</div>

<div class="token-card">
  <div class="reduction">37x</div>
  <div class="task">"What breaks if I change this service?"</div>
  <div class="token-bar">
    <span class="num" style="opacity:0.6">Others</span>
    <span class="bar bar-other" style="width:100%"></span>
    <span class="num" style="opacity:0.6">~30,000 tok</span>
  </div>
  <div class="token-bar">
    <span class="num" style="color:#10b981;font-weight:600">DjinnBot</span>
    <span class="bar bar-djinn" style="width:2.7%"></span>
    <span class="num" style="color:#10b981;font-weight:600">~800 tok</span>
  </div>
  <div class="how">1 call to <code>code_graph_impact</code> vs. codebase-wide grep + read</div>
</div>

<div class="token-card">
  <div class="reduction">12x</div>
  <div class="task">30 tool schemas in the system prompt</div>
  <div class="token-bar">
    <span class="num" style="opacity:0.6">Others</span>
    <span class="bar bar-other" style="width:100%"></span>
    <span class="num" style="opacity:0.6">~18,000 tok</span>
  </div>
  <div class="token-bar">
    <span class="num" style="color:#10b981;font-weight:600">DjinnBot</span>
    <span class="bar bar-djinn" style="width:8.3%"></span>
    <span class="num" style="color:#10b981;font-weight:600">~1,500 tok</span>
  </div>
  <div class="how">Compact one-line Python signatures via Programmatic Tool Calling</div>
</div>

<div class="token-card">
  <div class="reduction">24x</div>
  <div class="task">Read 5 files, grep for patterns, aggregate results</div>
  <div class="token-bar">
    <span class="num" style="opacity:0.6">Others</span>
    <span class="bar bar-other" style="width:100%"></span>
    <span class="num" style="opacity:0.6">~12,000 tok</span>
  </div>
  <div class="token-bar">
    <span class="num" style="color:#10b981;font-weight:600">DjinnBot</span>
    <span class="bar bar-djinn" style="width:4.2%"></span>
    <span class="num" style="color:#10b981;font-weight:600">~500 tok</span>
  </div>
  <div class="how">1 <code>exec_code</code> call &mdash; intermediate results stay in Python</div>
</div>

<div class="token-card">
  <div class="reduction">13x</div>
  <div class="task">Analyze a 500-line diff for security issues</div>
  <div class="token-bar">
    <span class="num" style="opacity:0.6">Others</span>
    <span class="bar bar-other" style="width:100%"></span>
    <span class="num" style="opacity:0.6">~4,000 tok</span>
  </div>
  <div class="token-bar">
    <span class="num" style="color:#10b981;font-weight:600">DjinnBot</span>
    <span class="bar bar-djinn" style="width:7.5%"></span>
    <span class="num" style="color:#10b981;font-weight:600">~300 tok</span>
  </div>
  <div class="how"><code>focused_analysis</code> delegates to a sub-model &mdash; main context stays clean</div>
</div>

</div>

Three systems make this possible:

**[Code Knowledge Graph](/docs/concepts/code-knowledge-graph)** &mdash; Tree-sitter parses every source file into a graph of functions, classes, call chains, and functional clusters stored in KuzuDB. Agents query the graph instead of reading files. One call returns what 15+ file reads would piece together.

**[Programmatic Tool Calling](/docs/concepts/programmatic-tool-calling)** &mdash; Instead of 30 full JSON schemas in every prompt, agents get compact Python function signatures and write code that calls tools, loops, and aggregates. Only the final result enters the context window.

**Focused Analysis** &mdash; When an agent needs to analyze a large diff or spec, `focused_analysis` delegates to a fast sub-model. The agent's context stays clean for high-level reasoning.

</div>

---

<div style="text-align: center; margin-top: 4rem; margin-bottom: 2rem;">

## How It Works

</div>

<div class="hx-mt-4 hx-mb-8" style="max-width: 52rem; margin: 0 auto;">

```mermaid
graph LR
    A["Define Work"] --> B["Plan"]
    B --> C["Agents Claim Tasks"]
    C --> D["Autonomous Work"]
    D --> E["Review & Iterate"]
    E --> F["Deliver"]
    
    style A fill:#3b82f6,color:#fff,stroke:#2563eb
    style B fill:#8b5cf6,color:#fff,stroke:#7c3aed
    style C fill:#f59e0b,color:#000,stroke:#d97706
    style D fill:#059669,color:#fff,stroke:#047857
    style E fill:#ec4899,color:#fff,stroke:#db2777
    style F fill:#10b981,color:#fff,stroke:#059669
```

**1. Define the work** &mdash; describe what you need via the dashboard's guided onboarding, chat, or API. Software projects, research tasks, content campaigns, operations workflows &mdash; anything.

**2. Plan it** &mdash; the planning pipeline decomposes your project into tasks on a kanban board with priorities, dependencies, and hour estimates. Or define tasks manually.

**3. Agents claim tasks** &mdash; each agent watches specific board columns matching their role. Engineers grab implementation work. Reviewers grab review tasks. Any agent can be configured to watch any column.

**4. Autonomous work** &mdash; on pulse cycles, agents wake up, claim a task, spin up an isolated container, and do the work &mdash; writing code, researching topics, generating content, browsing the web, or running any tools you've given them. Use **swarm execution** for parallel multi-agent processing.

**5. Review & iterate** &mdash; agents review each other's work. If changes are needed, the task cycles back. They coordinate via inbox messages and can wake each other for urgent blockers.

**6. Deliver** &mdash; watch the whole thing happen in real-time via the dashboard, Slack, CLI, or the live activity feed.

</div>

---

<div style="text-align: center; margin-top: 4rem; margin-bottom: 2rem;">

## The Default Team

</div>

<div class="hx-mt-2 hx-mb-8" style="max-width: 64rem; margin-left: auto; margin-right: auto;">

<div class="agent-grid">
  <div class="agent-card">
    <span class="agent-name">Eric</span>
    <span class="agent-role">Product Owner</span>
    <span class="agent-desc">Requirements, user stories, acceptance criteria, scope management</span>
  </div>
  <div class="agent-card">
    <span class="agent-name">Finn</span>
    <span class="agent-role">Solutions Architect</span>
    <span class="agent-desc">System architecture, tech decisions, code review, API design</span>
  </div>
  <div class="agent-card">
    <span class="agent-name">Shigeo</span>
    <span class="agent-role">UX Specialist</span>
    <span class="agent-desc">User flows, design systems, component specs, accessibility</span>
  </div>
  <div class="agent-card">
    <span class="agent-name">Yukihiro</span>
    <span class="agent-role">Senior SWE</span>
    <span class="agent-desc">Implementation, bug fixes, writing production code</span>
  </div>
  <div class="agent-card">
    <span class="agent-name">Chieko</span>
    <span class="agent-role">Test Engineer</span>
    <span class="agent-desc">QA strategy, regression detection, test automation</span>
  </div>
  <div class="agent-card">
    <span class="agent-name">Stas</span>
    <span class="agent-role">SRE</span>
    <span class="agent-desc">Infrastructure, deployment, monitoring, incident response</span>
  </div>
  <div class="agent-card">
    <span class="agent-name">Yang</span>
    <span class="agent-role">DevEx Specialist</span>
    <span class="agent-desc">CI/CD pipelines, tooling, developer workflow optimization</span>
  </div>
  <div class="agent-card">
    <span class="agent-name">Grace</span>
    <span class="agent-role">Executive Assistant</span>
    <span class="agent-desc">Meeting transcripts, commitment tracking, relationship management</span>
  </div>
  <div class="agent-card">
    <span class="agent-name">Holt</span>
    <span class="agent-role">Marketing & Sales</span>
    <span class="agent-desc">Sales strategy, outreach, deal management, positioning</span>
  </div>
  <div class="agent-card">
    <span class="agent-name">Luke</span>
    <span class="agent-role">SEO Specialist</span>
    <span class="agent-desc">Content strategy, keyword research, technical SEO</span>
  </div>
  <div class="agent-card">
    <span class="agent-name">Jim</span>
    <span class="agent-role">Finance Lead</span>
    <span class="agent-desc">Budget, pricing, runway management, financial modeling</span>
  </div>
</div>

<p style="text-align: center; max-width: 42rem; margin: 1rem auto 0; opacity: 0.75; font-size: 0.92rem;">
Each agent has a 100-200 line personality file with backstory, core beliefs, productive flaws, and anti-patterns. The default team covers engineering, ops, marketing, SEO, and finance &mdash; but you can create agents for any domain by adding a directory with a few markdown files.
</p>

</div>

---

<div style="text-align: center; margin-top: 4rem; margin-bottom: 2rem;">

## Why Not the Alternatives?

</div>

<div class="hx-mt-2 hx-mb-8" style="max-width: 62rem; margin-left: auto; margin-right: auto;">

<div class="compare-grid">
  <div class="compare-header">
    <span></span>
    <span>DjinnBot</span>
    <span>Everyone Else</span>
  </div>
  <div class="compare-row">
    <div class="col-label">Setup</div>
    <div class="col-val djinn">One curl command &mdash; 5 minutes</div>
    <div class="col-val muted">IDE extension install, or hours of framework wiring</div>
  </div>
  <div class="compare-row">
    <div class="col-label">Token Efficiency</div>
    <div class="col-val djinn">12-40x reduction via code graph, PTC, focused delegation</div>
    <div class="col-val muted">Raw file reads and full JSON schemas in every prompt</div>
  </div>
  <div class="compare-row">
    <div class="col-label">Cost Visibility</div>
    <div class="col-val djinn">Per-call, per-agent, per-user LLM usage logs with dollar amounts</div>
    <div class="col-val muted">None, or basic aggregate totals</div>
  </div>
  <div class="compare-row">
    <div class="col-label">Agents</div>
    <div class="col-val djinn">11 specialized agents with rich personas, or create your own</div>
    <div class="col-val muted">One generic assistant, or build from scratch</div>
  </div>
  <div class="compare-row">
    <div class="col-label">Security</div>
    <div class="col-val djinn">Container isolation, 2FA, encrypted secrets, auto SSL</div>
    <div class="col-val muted">Direct host access</div>
  </div>
  <div class="compare-row">
    <div class="col-label">Memory</div>
    <div class="col-val djinn">Persistent semantic memory with 3D knowledge graph</div>
    <div class="col-val muted">Stateless, or basic file-based context</div>
  </div>
  <div class="compare-row">
    <div class="col-label">Collaboration</div>
    <div class="col-val djinn">Agents review, critique, and coordinate via work ledger</div>
    <div class="col-val muted">Single agent, single perspective</div>
  </div>
  <div class="compare-row">
    <div class="col-label">Parallelism</div>
    <div class="col-val djinn">Swarm execution on DAG-aware task graphs</div>
    <div class="col-val muted">Sequential only, or custom scheduling code</div>
  </div>
  <div class="compare-row">
    <div class="col-label">Autonomy</div>
    <div class="col-val djinn">Agents work 24/7 on configurable pulse schedules</div>
    <div class="col-val muted">Requires human in the loop</div>
  </div>
</div>

<p style="text-align: center; max-width: 40rem; margin: 1.5rem auto 0; opacity: 0.75; font-size: 0.92rem;">
DjinnBot is built for people who want autonomous AI teams working on real projects &mdash; software, research, content, ops, or anything else &mdash; not another chatbot, not another framework to wire together.
</p>

</div>
