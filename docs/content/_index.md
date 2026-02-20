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
  Deploy a full team of AI agents — product owner, architect, engineers, QA, SRE — that collaborate to spec, design, implement, review, test, and deploy your software. Fully containerized. Self-hosted and free.
{{< /hextra/hero-subtitle >}}
</div>

<div class="hx-mb-6">
{{< hextra/hero-button text="Get Started" link="docs/getting-started/" >}}
{{< hextra/hero-button text="GitHub" link="https://github.com/BaseDatum/djinnbot" style="alt" >}}
</div>

<div class="hx-mt-6"></div>

{{< hextra/feature-grid >}}
  {{< hextra/feature-card
    title="Plug and Play"
    subtitle="Clone, add an API key, docker compose up. No Kubernetes, no cloud accounts, no hour-long setup. Your AI team is running in under 5 minutes."
    class="hx-aspect-auto md:hx-aspect-[1.1/1] max-md:hx-min-h-[340px]"
    style="background: radial-gradient(ellipse at 50% 80%,rgba(45,112,234,0.15),hsla(0,0%,100%,0));"
  >}}
  {{< hextra/feature-card
    title="Real Team, Not a Chatbot"
    subtitle="Each agent has a rich persona with backstory, opinions, and domain expertise. Eric pushes back on vague specs. Finn rejects bad architecture. Chieko finds the edge cases you forgot."
    class="hx-aspect-auto md:hx-aspect-[1.1/1] max-md:hx-min-h-[340px]"
    style="background: radial-gradient(ellipse at 50% 80%,rgba(142,53,234,0.15),hsla(0,0%,100%,0));"
  >}}
  {{< hextra/feature-card
    title="Fully Containerized"
    subtitle="Every agent runs in its own isolated Docker container with a full engineering toolbox — Node, Python, Go, Rust, git, and dozens more. No host access, no security concerns."
    class="hx-aspect-auto md:hx-aspect-[1.1/1] max-md:hx-min-h-[340px]"
    style="background: radial-gradient(ellipse at 50% 80%,rgba(234,90,45,0.15),hsla(0,0%,100%,0));"
  >}}
  {{< hextra/feature-card
    title="Persistent Memory"
    subtitle="Agents remember decisions, lessons, and patterns across runs using ClawVault with semantic search. They learn from mistakes and improve over time."
  >}}
  {{< hextra/feature-card
    title="Beautiful Dashboard"
    subtitle="Real-time streaming output, project management with kanban boards, chat interface, pipeline visualization, and agent configuration — not a terminal dump."
  >}}
  {{< hextra/feature-card
    title="Slack-Native"
    subtitle="Each agent gets its own Slack bot. Watch your team discuss in threads. Or skip Slack entirely and use the built-in chat interface."
  >}}
  {{< hextra/feature-card
    title="YAML Pipelines"
    subtitle="Define workflows as simple YAML — steps, agents, branching, loops, retries. No code required for orchestration. Create custom pipelines for any workflow."
  >}}
  {{< hextra/feature-card
    title="MCP Tools"
    subtitle="Agents use any MCP-compatible tool server via the built-in mcpo proxy. Add GitHub, web search, or any custom tool with a single config entry."
  >}}
  {{< hextra/feature-card
    title="Open Core"
    subtitle="Self-hosted is completely free. Use it, modify it, run it on your own infrastructure. FSL-1.1-ALv2 license converts to Apache 2.0 after 2 years."
  >}}
{{< /hextra/feature-grid >}}

---

<div style="text-align: center; margin-top: 4rem; margin-bottom: 2rem;">

## How It Works

</div>

<div class="hx-mt-4 hx-mb-8" style="max-width: 52rem; margin: 0 auto;">

**1. Describe what you want built** — via the dashboard, API, CLI, or Slack.

**2. The pipeline engine assigns work to the right agents** — each step runs in an isolated container with a full engineering toolbox.

**3. Agents collaborate autonomously** — Eric writes the spec, Finn designs the architecture, Yukihiro implements it, Finn reviews the code, Chieko runs tests, Stas deploys it.

**4. You watch it happen in real-time** — streaming output, Slack threads, or the dashboard. Step in when you want, or let them run.

</div>

---

<div style="text-align: center; margin-top: 4rem; margin-bottom: 2rem;">

## The Default Team

</div>

<div class="hx-mt-4 hx-mb-8" style="max-width: 52rem; margin: 0 auto;">

| Agent | Role | What They Do |
|-------|------|-------------|
| **Eric** | Product Owner | Requirements, user stories, scope management |
| **Finn** | Solutions Architect | System design, tech decisions, code review |
| **Shigeo** | UX Specialist | User flows, design systems, accessibility |
| **Yukihiro** | Senior SWE | Implementation, bug fixes, coding |
| **Chieko** | Test Engineer | QA, testing, regression detection |
| **Stas** | SRE | Deployment, infrastructure, monitoring |
| **Yang** | DevEx Specialist | CI/CD, tooling, developer workflow |
| **Holt** | Marketing & Sales | Sales strategy, outreach, positioning |
| **Luke** | SEO Specialist | Content strategy, keyword research |
| **Jim** | Finance Lead | Budget, pricing, runway management |

The engineering pipeline is fully operational today. Marketing, sales, and finance agents work in chat and pulse modes, with structured pipeline support coming soon.

</div>

---

<div style="text-align: center; margin-top: 4rem; margin-bottom: 2rem;">

## Why Not OpenClaw / Other Tools?

</div>

<div class="hx-mt-4 hx-mb-8" style="max-width: 52rem; margin: 0 auto;">

| | DjinnBot | Typical Agent Frameworks |
|---|---------|------------------------|
| **Setup time** | `docker compose up` (5 min) | Kubernetes + cloud accounts + config files (hours) |
| **Interface** | Full dashboard, Slack bots, chat, CLI | Terminal output or basic web UI |
| **Security** | Every agent in isolated Docker container | Direct host access, shell execution |
| **Memory** | Persistent semantic memory across runs | Stateless or basic file storage |
| **Collaboration** | Agents review each other's work | Single-agent or loose coordination |
| **Customization** | YAML pipelines, markdown personas | Code-level changes required |

DjinnBot is built for people who want autonomous AI teams working on real projects — not another framework to wire together.

</div>
