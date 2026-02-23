---
title: DjinnBot
layout: hextra-home
---

<div class="hx-mt-6 hx-mb-6">
{{< hextra/hero-headline >}}
  Autonomous AI Teams<br class="sm:hx-block hx-hidden" /> That Build Software
{{< /hextra/hero-headline >}}
</div>

<div class="hx-mb-12">
{{< hextra/hero-subtitle >}}
  Deploy a full team of AI agents — product owner, architect, engineers, QA, SRE, and executive assistant — that collaborate to spec, design, implement, review, test, and deploy your software. Fully containerized. Self-hosted and free.
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
    title="5-Minute Setup"
    subtitle="One curl command installs everything. The setup wizard handles secrets, API keys, Docker, and optional SSL. No Kubernetes, no cloud accounts. Your AI team is running before your coffee gets cold."
    class="hx-aspect-auto md:hx-aspect-[1.1/1] max-md:hx-min-h-[340px]"
    icon="play"
    style="background: radial-gradient(ellipse at 50% 80%,rgba(45,112,234,0.15),hsla(0,0%,100%,0));"
  >}}
  {{< hextra/feature-card
    title="11 Specialized Agents"
    subtitle="Not generic chatbots — real characters with backstories, opinions, and domain expertise. Eric pushes back on vague specs. Finn rejects bad architecture. Grace tracks your commitments. Chieko finds the edge cases you forgot."
    class="hx-aspect-auto md:hx-aspect-[1.1/1] max-md:hx-min-h-[340px]"
    icon="user-group"
    style="background: radial-gradient(ellipse at 50% 80%,rgba(142,53,234,0.15),hsla(0,0%,100%,0));"
  >}}
  {{< hextra/feature-card
    title="Container Isolation"
    subtitle="Every agent runs in its own ephemeral Docker container with a complete engineering toolbox — Node 22, Python, Go, Rust, and 30+ dev tools. No host access. Destroyed after every step. Zero security concerns."
    class="hx-aspect-auto md:hx-aspect-[1.1/1] max-md:hx-min-h-[340px]"
    icon="shield-check"
    style="background: radial-gradient(ellipse at 50% 80%,rgba(234,90,45,0.15),hsla(0,0%,100%,0));"
  >}}
  {{< hextra/feature-card
    title="Swarm Execution"
    subtitle="Run multiple agents in parallel on DAG-aware task graphs. A planning agent decomposes the work, and a swarm executes it concurrently — respecting dependencies, streaming progress live, and converging on completion."
    icon="lightning-bolt"
  >}}
  {{< hextra/feature-card
    title="Persistent Memory"
    subtitle="Agents remember decisions, lessons, and patterns across runs via ClawVault with semantic search. Memory scoring surfaces the most relevant context. Explore connections in an interactive 3D knowledge graph."
    icon="database"
  >}}
  {{< hextra/feature-card
    title="Real-Time Dashboard"
    subtitle="Live SSE-streamed activity feeds, kanban boards, pipeline visualization, swarm DAG views, 3D memory graphs, per-user usage tracking, file uploads, and a full admin panel. Not a terminal dump."
    icon="desktop-computer"
  >}}
  {{< hextra/feature-card
    title="YAML Pipelines"
    subtitle="Define workflows as simple YAML — steps, agents, branching, loops, retries, structured output schemas, and per-step model overrides. Drop a file in pipelines/ and it's live. No code required."
    icon="document-text"
  >}}
  {{< hextra/feature-card
    title="Full Cost Visibility"
    subtitle="Every LLM API call logged with token counts, latency, cost, and key source. Per-user and per-agent usage dashboards. Admin-level analytics with provider breakdowns. Know exactly what your AI team costs."
    icon="chart-bar"
  >}}
  {{< hextra/feature-card
    title="Enterprise Auth"
    subtitle="Multi-user accounts, TOTP 2FA, API keys, OIDC SSO, per-user provider key sharing, and automatic SSL via Let's Encrypt. Not an afterthought — built into the core from day one."
    icon="lock-closed"
  >}}
  {{< hextra/feature-card
    title="Slack-Native"
    subtitle="Each agent gets its own Slack bot with AI agent features enabled. Watch your team discuss in threads. Mention agents for their perspective. Or skip Slack and use the built-in chat."
    icon="chat-alt-2"
  >}}
  {{< hextra/feature-card
    title="MCP Tools"
    subtitle="Agents use any MCP-compatible tool server via the built-in mcpo proxy. Tools are converted to native agent tools at runtime — no difference in the interface. Hot-reload, no restarts."
    icon="puzzle"
  >}}
  {{< hextra/feature-card
    title="Open Core"
    subtitle="Self-hosted is completely free. Use it, modify it, run it on your infrastructure. FSL-1.1-ALv2 license converts to Apache 2.0 after 2 years. No vendor lock-in, no usage limits, no phone-home."
    icon="code"
  >}}
{{< /hextra/feature-grid >}}

---

<div style="text-align: center; margin-top: 4rem; margin-bottom: 2rem;">

## How It Works

</div>

<div class="hx-mt-4 hx-mb-8" style="max-width: 52rem; margin: 0 auto;">

```mermaid
graph LR
    A["Create Project"] --> B["Plan"]
    B --> C["Agents Claim Tasks"]
    C --> D["Autonomous Work"]
    D --> E["Review & Test"]
    E --> F["Ship"]
    
    style A fill:#3b82f6,color:#fff,stroke:#2563eb
    style B fill:#8b5cf6,color:#fff,stroke:#7c3aed
    style C fill:#f59e0b,color:#000,stroke:#d97706
    style D fill:#059669,color:#fff,stroke:#047857
    style E fill:#ec4899,color:#fff,stroke:#db2777
    style F fill:#10b981,color:#fff,stroke:#059669
```

**1. Create a project** — describe what you want built via the dashboard's guided onboarding, or import an existing repo.

**2. Plan it** — the two-stage planning pipeline decomposes your project into tasks on a kanban board with priorities, dependencies, and hour estimates.

**3. Agents claim tasks** — each agent watches specific board columns matching their role. Yukihiro grabs implementation work from "Ready." Chieko grabs review tasks. Stas watches for deployment.

**4. Autonomous work** — on pulse cycles, agents wake up, claim a task, spin up an isolated container, write code, run tests, and open a PR. Or use **swarm execution** for parallel multi-agent processing.

**5. Review & test** — Finn reviews the PR. If changes are needed, the task cycles back. If approved, Chieko runs the test suite.

**6. Ship it** — Stas handles deployment. Watch the whole thing happen in real-time via the dashboard, Slack, or the live activity feed.

</div>

---

<div style="text-align: center; margin-top: 4rem; margin-bottom: 2rem;">

## The Default Team

</div>

<div class="hx-mt-4 hx-mb-8" style="max-width: 64rem; margin: 0 auto;">

<table>
<thead>
<tr><th>Agent</th><th>Role</th><th>What They Do</th></tr>
</thead>
<tbody>
<tr><td><strong>Eric</strong></td><td>Product Owner</td><td>Requirements, user stories, acceptance criteria, scope management</td></tr>
<tr><td><strong>Finn</strong></td><td>Solutions Architect</td><td>System architecture, tech decisions, code review, API design</td></tr>
<tr><td><strong>Shigeo</strong></td><td>UX Specialist</td><td>User flows, design systems, component specs, accessibility</td></tr>
<tr><td><strong>Yukihiro</strong></td><td>Senior SWE</td><td>Implementation, bug fixes, writing production code</td></tr>
<tr><td><strong>Chieko</strong></td><td>Test Engineer</td><td>QA strategy, regression detection, test automation</td></tr>
<tr><td><strong>Stas</strong></td><td>SRE</td><td>Infrastructure, deployment, monitoring, incident response</td></tr>
<tr><td><strong>Yang</strong></td><td>DevEx Specialist</td><td>CI/CD pipelines, tooling, developer workflow optimization</td></tr>
<tr><td><strong>Grace</strong></td><td>Executive Assistant</td><td>Meeting transcripts, commitment tracking, relationship management, proactive follow-ups</td></tr>
<tr><td><strong>Holt</strong></td><td>Marketing &amp; Sales</td><td>Sales strategy, outreach, deal management, positioning</td></tr>
<tr><td><strong>Luke</strong></td><td>SEO Specialist</td><td>Content strategy, keyword research, technical SEO</td></tr>
<tr><td><strong>Jim</strong></td><td>Finance Lead</td><td>Budget, pricing, runway management, financial modeling</td></tr>
</tbody>
</table>

Each agent has a 100-200 line personality file with backstory, core beliefs, productive flaws, and anti-patterns. They're not generic wrappers &mdash; they're characters with opinions. The engineering pipeline is fully autonomous. Grace handles organizational memory and executive tasks. Business agents work in chat and pulse modes.

</div>

---

<div style="text-align: center; margin-top: 4rem; margin-bottom: 2rem;">

## Why Not the Alternatives?

</div>

<div class="hx-mt-4 hx-mb-8" style="max-width: 64rem; margin: 0 auto;">

<table>
<thead>
<tr><th></th><th>DjinnBot</th><th>Single-Agent Tools</th><th>Agent Frameworks</th></tr>
</thead>
<tbody>
<tr><td><strong>Setup</strong></td><td>One <code>curl</code> command &mdash; 5 minutes</td><td>Install IDE extension</td><td>Hours of framework wiring</td></tr>
<tr><td><strong>Agents</strong></td><td>11 specialized agents with rich personas</td><td>One generic assistant</td><td>Build your own from scratch</td></tr>
<tr><td><strong>Security</strong></td><td>Container isolation, 2FA, encrypted secrets, auto SSL</td><td>Direct host access</td><td>Direct host access</td></tr>
<tr><td><strong>Memory</strong></td><td>Persistent semantic memory + 3D knowledge graph</td><td>Stateless or basic files</td><td>Stateless or basic files</td></tr>
<tr><td><strong>Collaboration</strong></td><td>Agents review, critique, coordinate via work ledger</td><td>Single agent, single perspective</td><td>Custom-coded coordination</td></tr>
<tr><td><strong>Parallelism</strong></td><td>Swarm execution on DAG-aware task graphs</td><td>Sequential only</td><td>Custom-coded scheduling</td></tr>
<tr><td><strong>Visibility</strong></td><td>Real-time dashboard, Slack, live feeds, usage tracking</td><td>Terminal output</td><td>Minimal web UI</td></tr>
<tr><td><strong>Autonomy</strong></td><td>Agents work 24/7 on configurable pulse schedules</td><td>Requires human in the loop</td><td>Requires human in the loop</td></tr>
<tr><td><strong>Cost tracking</strong></td><td>Per-call, per-agent, per-user LLM usage logs</td><td>None</td><td>None</td></tr>
</tbody>
</table>

DjinnBot is built for people who want autonomous AI teams working on real projects &mdash; not another chatbot, not another framework to wire together.

</div>
