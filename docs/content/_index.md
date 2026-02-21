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

<div class="hx-mt-4 hx-mb-8" style="max-width: 64rem; margin: 0 auto;">

<table>
<thead>
<tr><th>Agent</th><th>Role</th><th>Pipeline Stage</th><th>What They Do</th></tr>
</thead>
<tbody>
<tr><td><strong>Eric</strong></td><td>Product Owner</td><td>SPEC</td><td>Requirements, user stories, acceptance criteria, scope management</td></tr>
<tr><td><strong>Finn</strong></td><td>Solutions Architect</td><td>DESIGN / REVIEW</td><td>System architecture, tech decisions, code review, API design</td></tr>
<tr><td><strong>Shigeo</strong></td><td>UX Specialist</td><td>UX</td><td>User flows, design systems, component specs, accessibility</td></tr>
<tr><td><strong>Yukihiro</strong></td><td>Senior SWE</td><td>IMPLEMENT / FIX</td><td>Implementation, bug fixes, writing production code</td></tr>
<tr><td><strong>Chieko</strong></td><td>Test Engineer</td><td>TEST</td><td>QA strategy, regression detection, test automation</td></tr>
<tr><td><strong>Stas</strong></td><td>SRE</td><td>DEPLOY</td><td>Infrastructure, deployment, monitoring, incident response</td></tr>
<tr><td><strong>Yang</strong></td><td>DevEx Specialist</td><td>DX (on-demand)</td><td>CI/CD pipelines, tooling, developer workflow optimization</td></tr>
<tr><td><strong>Holt</strong></td><td>Marketing &amp; Sales</td><td>On-demand</td><td>Sales strategy, outreach, deal management, positioning</td></tr>
<tr><td><strong>Luke</strong></td><td>SEO Specialist</td><td>On-demand</td><td>Content strategy, keyword research, technical SEO</td></tr>
<tr><td><strong>Jim</strong></td><td>Finance Lead</td><td>On-demand</td><td>Budget, pricing, runway management, financial modeling</td></tr>
</tbody>
</table>

The engineering pipeline is fully operational today. Marketing, sales, and finance agents work in chat and pulse modes, with structured pipeline support coming soon.

</div>

---

<div style="text-align: center; margin-top: 4rem; margin-bottom: 2rem;">

## Why Not OpenClaw / Other Tools?

</div>

<div class="hx-mt-4 hx-mb-8" style="max-width: 64rem; margin: 0 auto;">

<table>
<thead>
<tr><th></th><th>DjinnBot</th><th>OpenClaw</th><th>Typical Agent Frameworks</th></tr>
</thead>
<tbody>
<tr><td><strong>Setup time</strong></td><td><code>docker compose up</code> &mdash; 5 minutes</td><td>Kubernetes + cloud config &mdash; hours</td><td>Framework wiring + custom code &mdash; hours to days</td></tr>
<tr><td><strong>Interface</strong></td><td>Full dashboard, Slack bots, chat, CLI, API</td><td>Basic web UI</td><td>Terminal output or minimal web UI</td></tr>
<tr><td><strong>Security</strong></td><td>Every agent in isolated Docker container. No host access.</td><td>Direct host access, shell execution</td><td>Direct host access, shell execution</td></tr>
<tr><td><strong>Agent memory</strong></td><td>Persistent semantic memory with knowledge graph across runs</td><td>Stateless or basic file storage</td><td>Stateless or basic file storage</td></tr>
<tr><td><strong>Multi-agent collaboration</strong></td><td>Agents review, critique, and build on each other's work</td><td>Loose coordination</td><td>Single-agent or sequential handoff</td></tr>
<tr><td><strong>Customization</strong></td><td>YAML pipelines, markdown personas &mdash; no code</td><td>Code-level changes</td><td>Code-level changes</td></tr>
<tr><td><strong>Agent personas</strong></td><td>Rich characters with opinions, beliefs, and anti-patterns</td><td>Generic system prompts</td><td>Generic system prompts</td></tr>
<tr><td><strong>Tool system</strong></td><td>MCP tools converted to native tools at runtime</td><td>Manual tool configuration</td><td>Custom tool integrations</td></tr>
</tbody>
</table>

DjinnBot is built for people who want autonomous AI teams working on real projects &mdash; not another framework to wire together.

</div>
