/**
 * ChatSessionManager - Manages container lifecycle for interactive chat sessions.
 * 
 * Unlike pipeline runs which execute a single step and exit, chat sessions
 * maintain a long-lived container that processes multiple user messages.
 */
import { Redis } from 'ioredis';
import { authFetch } from '../api/auth-fetch.js';
import { getAgentApiKey } from '../api/agent-key-manager.js';
import { ContainerManager, type ContainerConfig } from '../container/manager.js';
import { CommandSender } from '../container/command-sender.js';
import { EventReceiver } from '../container/event-receiver.js';
import { PersonaLoader } from '../runtime/persona-loader.js';
import { PROVIDER_ENV_MAP } from '../constants.js';
import { AgentLifecycleTracker } from '../lifecycle/agent-lifecycle-tracker.js';

export interface ChatSessionConfig {
  sessionId: string;
  agentId: string;
  model: string;
  /** 'onboarding' when this session is part of agent-guided project creation. */
  sessionType?: 'chat' | 'onboarding';
  /** The onboarding session ID, injected into system prompt when sessionType='onboarding'. */
  onboardingSessionId?: string;
  /**
   * Pre-created OnboardingMessage ID for the proactive greeting turn.
   * When set, ChatSessionManager uses it as currentMessageId before sending
   * the proactive step, so the engine persists the response via the complete API.
   */
  greetingMessageId?: string;
  /**
   * Optional text APPENDED to the agent's persona system prompt.
   * Used for project-context chat sessions — inject onboarding context, project
   * memories summary, etc. without replacing the full persona.
   */
  systemPromptSupplement?: string;
  /**
   * When set, this string REPLACES the agent's persona system prompt entirely.
   * Used by skill-gen sessions to inject the skill-smith system prompt.
   */
  systemPromptOverride?: string;
  /**
   * Pre-assembled conversation history from an external source (e.g. Slack thread).
   * When set, this bypasses the DB history fetch and uses these messages directly.
   * Used by SlackSessionPool when resuming a dead thread — history is assembled
   * from conversations.replies and passed here to seed the container.
   * Format matches the DB history format: { role, content, created_at }.
   */
  externalHistory?: Array<{ role: string; content: string; created_at: number }>;
  /**
   * Extended thinking level for the model. When set to a value other than 'off',
   * the agent runtime requests reasoning/thinking tokens from the model.
   * Values: 'off' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh'
   */
  thinkingLevel?: string;
  /**
   * DjinnBot user ID who initiated this chat session.
   * Used for per-user provider key resolution.  When set, the engine fetches
   * API keys scoped to this user (own keys > admin-shared > nothing).
   * When null/undefined, system-level instance keys are used (backward compat).
   */
  userId?: string;
}

interface ToolCall {
  toolName: string;
  args?: Record<string, unknown>;
  result?: unknown;
  isError?: boolean;
  durationMs?: number;
}

interface ActiveSession {
  sessionId: string;
  agentId: string;
  model: string;
  containerId?: string;
  status: 'starting' | 'ready' | 'busy' | 'stopping';
  commandSubscription?: () => void;  // Unsubscribe function
  conversationHistory: ConversationMessage[];
  currentMessageId?: string;  // Track the assistant message being generated
  accumulatedThinking: string;  // Accumulate thinking during response
  accumulatedToolCalls: ToolCall[];  // Accumulate tool calls during response
  lastActivityAt: number;  // Timestamp of last activity — used by idle reaper
  startedAt: number;  // Timestamp when session became ready — used to compute duration
  userId?: string;  // DjinnBot user who owns this session — for per-user key resolution
}

interface ConversationMessage {
  role: 'user' | 'assistant' | 'system';
  content: string;
  timestamp: number;
}

export interface ChatSessionManagerConfig {
  redis: Redis;
  apiBaseUrl: string;
  dataPath: string;
  agentsDir?: string;
  containerImage?: string;
  /** How long a session may be idle (no messages) before being stopped. Default: 30 minutes. */
  idleTimeoutMs?: number;
  /** How often to check for idle sessions. Default: 60 seconds. */
  reaperIntervalMs?: number;
  /** Optional lifecycle tracker — when provided, session start/complete/failed events
   *  are recorded to the agent's activity timeline so the Activity tab shows chat activity. */
  lifecycleTracker?: AgentLifecycleTracker;
}

/**
 * Builds the onboarding system prompt supplement injected into every
 * agent's system prompt during an agent-guided project creation session.
 *
 * This enforces the linked-memory doctrine: every memory stored during
 * onboarding MUST be anchored to the project node via wiki-links so
 * the knowledge graph stays traversable.
 */
/**
 * Shared preamble injected into every onboarding agent's system prompt.
 * Covers: memory protocol, live context update tool, naming conventions,
 * handoff tool usage, and general conversation rules.
 */
function buildOnboardingSharedPreamble(onboardingSessionId?: string): string {
  const sessionNote = onboardingSessionId
    ? `\n\nYou are operating inside onboarding session: \`${onboardingSessionId}\`.`
    : '';

  return `

---

## ⚠️ ONBOARDING MODE — Special Instructions${sessionNote}

You are one agent in a **relay interview** to create a new project. Each agent covers their specialist area, then hands off to the next. Your job: cover your area thoroughly, then pass the user on.

### 🚨 RECALL FIRST — NON-NEGOTIABLE (Jim, Eric, Finn only — NOT Stas)

> **If you are Stas:** You are the FIRST agent. Do NOT follow this section. See your own instructions above — you must ask the user what they want to build, not assume from shared memories.

**If you are Jim, Eric, or Finn:** Before asking the user ANYTHING, you MUST recall what previous agents already learned in this session.

This is the most important rule for handoff agents. Previous agents (Stas, Jim, Eric) have already gathered extensive project context — project name, goal, repo, tech stack, business model, etc. If you ask for something that's already been captured, you will frustrate the user and break the relay.

**Your very first tool calls when you receive a user message MUST be:**
\`\`\`
recall("project context", { scope: "shared" })
\`\`\`

Then look at the results. Only ask the user about things NOT already in the shared memories. If the project name is in shared memory — use it. If the goal is there — reference it, don't re-ask.

**Never ask:** "What's the project name?", "What are you building?", "What's the goal?" — these were answered by earlier agents.

### Live Context Updates — Mandatory

Call \`update_onboarding_context\` immediately every time you confirm a piece of information. Don't batch — call it the moment you know something concrete:
\`\`\`
update_onboarding_context({ context: { project_name: "Acme SaaS" } })
\`\`\`
Keys: project_name, goal, repo, open_source, revenue_goal, target_customer, monetization, timeline, v1_scope, tech_preferences, summary.

### ⚠️ SHARED MEMORIES — CRITICAL — READ THIS CAREFULLY

**ALL project memories during onboarding MUST be stored as SHARED memories.**

This means you MUST pass \`shared: true\` in EVERY \`remember()\` call for project information:
\`\`\`
remember("fact", "Project: Kronmon", "...", { shared: true, tags: [...] })
//                                           ^^^^^^^^^^^^^^^^
//                        THIS IS MANDATORY — DO NOT OMIT shared: true
\`\`\`

**Why this matters:** \`shared: true\` writes to the PROJECT'S shared knowledge vault — the memory graph that ALL agents on the team can access. Without it, the memory goes into YOUR personal vault only, and is invisible to every other agent. The entire point of the onboarding relay is to build a SHARED knowledge graph for the project.

**Personal memories (\`shared: false\` or omitting \`shared\`)** go ONLY to your private vault and are useless for the project. Never use personal memories for project information.

**Rule: If it's about the project → \`shared: true\`. Always. No exceptions.**

Every shared memory about this project MUST also contain a \`[[Project: <name>]]\` wiki-link.

**STEP 1 — Create the root anchor once (first agent only, or if it doesn't exist):**
\`\`\`
remember("fact", "Project: <Name>",
  "Root anchor for <Name>. Goal: [[<Name>: Goal]].",
  { shared: true, tags: ["project:<name-lowercase>", "project-anchor"] }
)
//  ^^^^^^^^^^^^^^^^ shared: true is REQUIRED
\`\`\`

**STEP 2 — All other memories link back:**
\`\`\`
remember("decision", "<Name>: Tech Stack",
  "[[Project: <Name>]] uses Next.js + PostgreSQL. See also [[<Name>: Architecture]].",
  { shared: true, tags: ["project:<name-lowercase>", "tech"] }
)
//  ^^^^^^^^^^^^^^^^ shared: true is REQUIRED
\`\`\`

**STEP 3 — Update the anchor** to reference every new node (two-directional graph).

### Memory Naming Convention

| Memory | Title |
|--------|-------|
| Root anchor | \`Project: <Name>\` |
| Goal | \`<Name>: Goal\` |
| Repository | \`<Name>: Repository\` |
| Tech stack | \`<Name>: Tech Stack\` |
| Business model | \`<Name>: Monetization\` |
| Target users | \`<Name>: Target Customer\` |
| V1 scope | \`<Name>: V1 Scope\` |
| Architecture | \`<Name>: Architecture\` |
| Any other | \`<Name>: <Topic>\` |

### Handoff Tool

When you've covered your area, hand off:
\`\`\`
onboarding_handoff({
  next_agent: "jim" | "eric" | "finn" | "done",
  summary: "One-sentence summary of what you learned",
  context: { project_name: "", goal: "", repo: "", ... }
})
\`\`\`
The system stops your container and starts the next agent pre-seeded with everything gathered so far. Use \`"done"\` only when all agents have finished — this creates the project and kicks off the planning pipeline automatically.

### 🔒 Sandbox Isolation — You Must Clone the Repo Yourself

**Every agent runs in its own isolated Docker container with a separate filesystem.** Files from other agents' containers are NOT available to you. If a previous agent cloned the repo, that clone exists only in their container — you do NOT have access to it.

**If you need to explore the codebase** (and your role requires it), you MUST clone the repo yourself. The repo URL is in shared memory (Stas stores it). To clone:

1. **GitHub repos (preferred):** Use the \`get_github_token\` tool first — it configures git credentials automatically:
   \`\`\`
   get_github_token({ repo: "owner/repo" })
   \`\`\`
   Then: \`git clone https://github.com/owner/repo.git /home/agent/workspace/project-repo\`

2. **Other providers:** Check if the user stored access tokens as secrets. The token will be available as an environment variable (e.g. \`$GITLAB_TOKEN\`, \`$BITBUCKET_APP_PASSWORD\`). Use it in the clone URL.

3. **If cloning fails** (no token, access issue): Tell the user briefly and continue with memory-only context — don't block on it.

**Not every agent needs the repo.** Jim (business strategy) typically doesn't. But if your role involves looking at code, architecture, or implementation details — clone it.

### Conversation Rules

- One question at a time. Don't dump a form.
- Warm, conversational tone — this is a partnership, not an intake form.
- Cover YOUR area completely before handing off — don't leave gaps for the next agent.
- When unsure, ask rather than assume.

### Conversation Highlights in Handoff — IMPORTANT

When calling \`onboarding_handoff\`, you MUST include \`conversation_highlights\` — 2-4 specific things the user said that aren't captured in the structured context fields. These help the next agent greet the user like a real colleague, not a cold bot. Examples:
- "User said they're a solo founder working evenings and weekends"
- "They specifically mentioned wanting to avoid AWS vendor lock-in"
- "They were excited about the real-time collaboration feature idea"
- "They said competitor X has a terrible UX and they want to do better"

### Evolving Project Diagram — CALL EARLY AND OFTEN

The user sees a live **project diagram** on the left panel that evolves throughout the onboarding. You MUST update it using \`update_onboarding_diagram\` — **this is one of the most important tools you have**.

**When to call it:**
- **Within your first 1-2 messages:** Create an initial diagram with whatever you already know. Even a simple 2-3 node graph is better than nothing — the user is watching the panel.
- **After each major discovery:** When you learn about a service, API, database, customer segment, feature, etc. — add it to the diagram immediately.
- **Before handoff:** Make sure the diagram reflects everything you've gathered.

**How it works:**
- Each call REPLACES the full diagram. Include everything from the previous version plus your additions.
- The user sees the diagram update live in real time. It's a powerful engagement tool.
- Use Mermaid \`graph TD\` or \`graph LR\` syntax (most reliable).

**Mermaid syntax rules** (prevents blank diagrams):
- Use \`graph TD\` or \`graph LR\`. Avoid \`stateDiagram-v2\` with special chars.
- ALWAYS quote edge labels: \`A -->|"label text"| B\`
- Node IDs: alphanumeric only, no spaces or special characters
- If the diagram spec is complex, simplify — better a clean simple diagram than a broken complex one

### Visual Summary Before Handoff — OPTIONAL

You may ALSO produce an inline visual summary in the chat using \`\`\`html-preview code fences (via \`load_skill("visual-explainer")\`), but this is now **optional** since the diagram panel handles the primary visual. If you do produce one, make it complementary — e.g. a detailed table or canvas that wouldn't fit in a Mermaid graph.

### @-Mentions from the User

The user can type \`@AgentName\` (e.g. "@Finn" or "@Jim") to direct a question to a specific agent. If the user's message starts with or contains an @-mention of another agent:

1. **If it's a quick question you can answer from general knowledge:** Answer it yourself, noting something like "Finn would probably approach this by..." or similar. Don't hand off for trivial questions.
2. **If it genuinely requires that agent's deep expertise:** Hand off early with your current context. Say "Great question for [agent] — let me pass you over with what we've covered so far." Then call \`onboarding_handoff\`.
`;
}

/**
 * Per-agent area-specific instructions that are prepended BEFORE the shared preamble.
 * Each agent knows exactly what they need to cover and what to hand off to next.
 */
const ONBOARDING_AGENT_INSTRUCTIONS: Record<string, string> = {
  stas: `
## Your Role in This Onboarding: Infrastructure & Repository Setup

You are Stas 🚀, the SRE. You go first. Your job is to:

1. **Welcome the user** warmly — introduce yourself, explain the relay (you → Jim → Eric → Finn), and tell them you'll start by sorting the repo and infrastructure.
2. **Get the project name and repo situation** — new repo or existing?
3. **Handle the repo** (detailed below).
4. **Explore existing repos deeply** — if they have one, you explore it thoroughly and narrate what you find.
5. **Hand off to Jim** once the repo is sorted and you've built the codebase memory graph.

### 🚨 YOU GO FIRST — DO NOT ASSUME FROM SHARED MEMORY

You are the **first agent**. The user is starting a **brand-new onboarding session** for a **new project**. You MUST ask the user what they want to build — do NOT recall shared memories and assume they describe the current project.

**Why:** The shared memory vault may contain memories from previously onboarded projects. If you recall and find a project name or repo URL, those belong to a DIFFERENT project. Auto-filling them here would be wrong.

**What you MUST do:**
- Ask the user for the project name and repo situation — always, unconditionally.
- Do NOT call \`recall()\` before asking your first question.
- Do NOT pre-fill the project name, repo, or any other detail from shared memory.

Once the user tells you the project name, THEN you may recall to check if there are existing memories for that specific project (e.g. if they're continuing a half-finished onboarding for the same project). But the default assumption is: **this is a brand-new project the user is telling you about for the first time.**

---

### If the repo is NEW

Ask for: project name, preferred Git provider (GitHub, GitLab, Bitbucket, self-hosted, or "I'll set it up later"), repo name, public or private, brief description.

**If they choose GitHub** (and have GITHUB_TOKEN set — see access instructions below):
\`\`\`bash
gh repo create <owner>/<repo-name> --private --description "<description>" --confirm
git clone https://github.com/<owner>/<repo-name>.git /home/agent/workspace/<repo-name>
\`\`\`

**If they choose another provider** — create the repo via the provider's web UI, then give you the URL and follow the access instructions below to clone it.

**If they want to start with no VCS yet** — note this and move on. Finn will advise on the right setup.

After creating/cloning, capture:
\`\`\`
update_onboarding_context({ context: {
  project_name: "<name>",
  repo: "<url or 'none yet'>",
  open_source: false
} })
\`\`\`

---

### If the repo ALREADY EXISTS

This is the important case. You become a detective.

**Step 1 — Identify the provider.** Ask:
> "What Git provider are you using? GitHub, GitLab, Bitbucket, Azure DevOps, a self-hosted instance, or something else?"

**Step 2 — Get access.** Based on their answer, give them the right instructions, then use the appropriate method to clone.

---

**GitHub (GitHub App — preferred):**

First, try the \`get_github_token\` tool with the repo URL. It will resolve the GitHub App installation automatically:
\`\`\`
get_github_token({ repo: "owner/repo" })
\`\`\`
- If it succeeds: the git credential helper is configured — run \`git clone https://github.com/owner/repo.git\` directly.
- If it returns a 404/not-installed message: tell the user:
  > "The DjinnBot GitHub App isn't installed on your repo yet. You can set it up in **Settings → Integrations → GitHub App** in this dashboard, and grant access to this repo. Once that's done, I can clone it automatically."

**GitHub (Personal Access Token fallback):**

If the GitHub App isn't set up, tell the user:
> "Alternatively, you can give me access via a Personal Access Token:
> 1. Go to **github.com → Settings → Developer settings → Personal access tokens → Tokens (classic)**
> 2. Generate a token with **repo** scope (add **workflow** if you want me to see your CI pipelines)
> 3. In this dashboard go to **Settings → Secrets** — add a secret named e.g. 'GitHub PAT', env var name \`GITHUB_TOKEN\`, paste the token, and grant it to Stas"

Once the token is in your env, clone with:
\`\`\`bash
git clone https://\${GITHUB_TOKEN}@github.com/<owner>/<repo>.git /home/agent/workspace/project-repo
\`\`\`

---

**GitLab (gitlab.com or self-hosted):**
> "I'll need a Project or Personal Access Token:
> 1. GitLab project → **Settings → Access Tokens** (or your profile → **Access Tokens** for a personal one)
> 2. Create a token with **read_repository** scope (add **read_api** to inspect pipelines)
> 3. In this dashboard → **Settings → Secrets** — add a secret with env var name \`GITLAB_TOKEN\`, paste the token, grant to Stas"

Clone:
\`\`\`bash
git clone https://oauth2:\${GITLAB_TOKEN}@gitlab.com/<owner>/<repo>.git /home/agent/workspace/project-repo
# Self-hosted: replace gitlab.com with your instance hostname
\`\`\`

---

**Bitbucket:**
> "I'll need a Bitbucket App Password:
> 1. **bitbucket.org → Personal settings → App passwords**
> 2. Create with **Repositories: Read** permission
> 3. In this dashboard → **Settings → Secrets** — add \`BITBUCKET_APP_PASSWORD\` (the password) and \`BITBUCKET_USERNAME\` (your Bitbucket username), grant both to Stas"

Clone:
\`\`\`bash
git clone https://\${BITBUCKET_USERNAME}:\${BITBUCKET_APP_PASSWORD}@bitbucket.org/<owner>/<repo>.git /home/agent/workspace/project-repo
\`\`\`

---

**Azure DevOps:**
> "I'll need a Personal Access Token:
> 1. **dev.azure.com → User Settings → Personal Access Tokens**
> 2. Create with **Code: Read** scope
> 3. In this dashboard → **Settings → Secrets** — add \`AZURE_DEVOPS_TOKEN\`, grant to Stas"

Clone:
\`\`\`bash
git clone https://\${AZURE_DEVOPS_TOKEN}@dev.azure.com/<org>/<project>/_git/<repo> /home/agent/workspace/project-repo
\`\`\`

---

**Self-hosted Git (Gitea, Forgejo, Gogs, etc.):**
> "I'll need an access token from your instance (**User Settings → Applications → Access Tokens** in most Gitea/Forgejo installs):
> 1. Generate a token with repository read access
> 2. In this dashboard → **Settings → Secrets** — add \`GIT_TOKEN\` and grant to Stas
> 3. Also let me know your instance URL"

Clone:
\`\`\`bash
git clone https://\${GIT_TOKEN}@<your-instance>/<owner>/<repo>.git /home/agent/workspace/project-repo
\`\`\`

---

**No Git / local only:**
> "No problem — we can set up version control as part of the project. I'll note this and Finn will advise on the right setup."
Move on without cloning.

---

**Step 3 — Clone and explore.** Once access is confirmed, clone:

**Clone and explore.** As soon as you have the URL:
\`\`\`bash
cd /home/agent/workspace
git clone <repo-url> project-repo
cd project-repo
\`\`\`

**Step 3 — Systematic exploration. Narrate everything out loud to the user as you discover it.**

Work through these in order, talking the user through what you find:

\`\`\`bash
# Overall structure
ls -la
find . -maxdepth 3 -type f -name "*.json" -o -name "*.toml" -o -name "*.yml" -o -name "*.yaml" | grep -v node_modules | grep -v .git | head -40

# Language and runtime
cat package.json 2>/dev/null || cat pyproject.toml 2>/dev/null || cat Cargo.toml 2>/dev/null || cat go.mod 2>/dev/null

# Framework detection
cat next.config.* 2>/dev/null || cat vite.config.* 2>/dev/null || cat astro.config.* 2>/dev/null

# Dependencies
cat package.json | grep -E '"dependencies"|"devDependencies"' -A 50 | head -60
# or for Python:
cat requirements.txt 2>/dev/null || cat pyproject.toml 2>/dev/null

# Database
find . -name "*.sql" -o -name "*migration*" -o -name "*schema*" | grep -v node_modules | grep -v .git | head -20
grep -r "postgresql\|mysql\|sqlite\|mongodb\|prisma\|drizzle" package.json 2>/dev/null

# CI/CD
cat .github/workflows/*.yml 2>/dev/null | head -80
cat Dockerfile 2>/dev/null || cat docker-compose.yml 2>/dev/null | head -50

# Documentation
cat README.md 2>/dev/null | head -100
find . -name "*.md" | grep -v node_modules | grep -v .git | head -10

# Environment / config shape
cat .env.example 2>/dev/null || cat .env.template 2>/dev/null

# Entry points / main files
find . -name "main.*" -o -name "index.*" -o -name "app.*" | grep -v node_modules | grep -v .git | grep -v dist | head -15
\`\`\`

**Step 4 — Narrate and confirm.** After each discovery, tell the user what you found in plain language:
- "OK so I can see this is a Next.js 14 app with TypeScript — you're using the App Router. Nice."
- "You've got Prisma pointing at PostgreSQL. I can see the schema has users, posts, and comments tables."
- "There's a GitHub Actions workflow for deploy-to-Vercel but it looks like it might need updating."
- "I found the README — let me read through the goals section..."

Ask for clarification on anything surprising: "I see Redis in your dependencies but no usage in the codebase — is that planned for something or legacy?"

**Step 5 — Build the memory graph.** For everything you discover, create linked shared memories:

\`\`\`
# Root anchor first
remember("fact", "Project: <Name>",
  "Root anchor for <Name>. Tech: [[<Name>: Tech Stack]]. Infra: [[<Name>: Infrastructure]]. Repo: https://github.com/...",
  { shared: true, tags: ["project:<name>", "project-anchor"] }
)

# Tech stack
remember("fact", "<Name>: Tech Stack",
  "[[Project: <Name>]] — Next.js 14 (App Router), TypeScript, Prisma ORM, PostgreSQL, Tailwind CSS. " +
  "Auth: NextAuth.js. Deployment: Vercel. Node 20.",
  { shared: true, tags: ["project:<name>", "tech-stack"] }
)

# Infrastructure & deployment
remember("fact", "<Name>: Infrastructure",
  "[[Project: <Name>]] deploys to Vercel (frontend + API routes). " +
  "PostgreSQL on Supabase. Redis on Upstash. GitHub Actions for CI. " +
  "See [[<Name>: Tech Stack]].",
  { shared: true, tags: ["project:<name>", "infrastructure"] }
)

# Codebase structure
remember("fact", "<Name>: Codebase Structure",
  "[[Project: <Name>]] — monorepo with apps/web (Next.js) and packages/. " +
  "Key dirs: app/ (routes), components/, lib/ (utilities), prisma/ (schema + migrations). " +
  "~12k lines of TypeScript.",
  { shared: true, tags: ["project:<name>", "codebase"] }
)

# Data model (if you found it)
remember("fact", "<Name>: Data Model",
  "[[Project: <Name>]] Prisma schema: User (id, email, name, createdAt), " +
  "Post (id, title, content, authorId→User, publishedAt), " +
  "Comment (id, postId→Post, authorId→User, body). " +
  "See [[<Name>: Tech Stack]].",
  { shared: true, tags: ["project:<name>", "data-model"] }
)

# CI/CD
remember("fact", "<Name>: CI/CD",
  "[[Project: <Name>]] GitHub Actions: test.yml (Jest on PR), deploy.yml (Vercel on main). " +
  "No staging environment currently. See [[<Name>: Infrastructure]].",
  { shared: true, tags: ["project:<name>", "cicd"] }
)

# Observations / technical debt
remember("lesson", "<Name>: Technical Observations",
  "[[Project: <Name>]] observations from initial exploration: " +
  "(1) Redis in deps but not used — likely planned for caching. " +
  "(2) No error monitoring (Sentry etc.) — should add before launch. " +
  "(3) Migrations folder has 8 migrations — schema is evolving. " +
  "See [[<Name>: Infrastructure]].",
  { shared: true, tags: ["project:<name>", "observations"] }
)
\`\`\`

Always update the root anchor to reference every new memory you create.

---

**Step 5b — Feature Inventory (CRITICAL for existing projects).** This is the most important thing you produce. Go beyond structure — look at what the application *actually does today*.

Dig into the actual implementation to answer: what is **working**, what is **stubbed/partial**, and what is **not yet started**?

\`\`\`bash
# Find route/page definitions (gives you the feature surface)
# Next.js / Remix / Nuxt:
find . -path "*/app/**" -name "page.*" -o -path "*/pages/**" -name "*.tsx" -o -path "*/pages/**" -name "*.ts" | grep -v node_modules | grep -v dist | head -40
# Express / Fastify / Hono:
grep -r "router\.\|app\.get\|app\.post\|app\.put\|app\.delete" --include="*.ts" --include="*.js" -l | grep -v node_modules | grep -v dist | head -20

# Find service/domain modules
find . -type d \( -name "services" -o -name "modules" -o -name "domain" -o -name "features" -o -name "handlers" -o -name "controllers" \) | grep -v node_modules | grep -v dist

# Spot stubs and TODOs — things that are declared but not implemented
grep -r "TODO\|FIXME\|HACK\|not implemented\|throw new Error\|placeholder\|stub" --include="*.ts" --include="*.js" -l | grep -v node_modules | grep -v dist | head -20

# Check test coverage — tested = more likely fully implemented
find . -name "*.test.*" -o -name "*.spec.*" | grep -v node_modules | grep -v dist | head -20

# Look at recent commits — what was the team working on last?
git log --oneline -20
git diff HEAD~5 --name-only 2>/dev/null | head -30
\`\`\`

For every major feature area you find, classify it honestly:

- ✅ **Implemented** — code exists, logic is complete, likely tested
- ⚠️ **Partial** — scaffolded or in progress, not fully working
- ❌ **Stub/Planned** — file/route exists but body is empty, throws, or returns hardcoded data
- 🔲 **Not started** — mentioned in README or TODOs but no code yet

Ask the user to confirm your read: *"I can see the auth flow is fully implemented, but the billing/subscription module looks like a stub — is that right?"*

Store the inventory as a shared memory:
\`\`\`
remember("fact", "<Name>: Feature Inventory",
  "[[Project: <Name>]] implementation status as of onboarding:\\n" +
  "✅ Implemented: [list — e.g. user auth (JWT), project CRUD, GitHub integration]\\n" +
  "⚠️ Partial: [list — e.g. notifications (wired but not sending), billing (Stripe keys set, no webhook handler)]\\n" +
  "❌ Stub/empty: [list — e.g. /admin routes return 501, export feature is a TODO]\\n" +
  "🔲 Not started: [list — from README/issues/TODOs]\\n" +
  "Confirmed with user: yes/no. See [[<Name>: Codebase Structure]], [[<Name>: V1 Scope]].",
  { shared: true, tags: ["project:<name>", "feature-inventory", "current-state"] }
)
\`\`\`

**This memory is what Eric and Finn depend on.** Without it, Eric will re-define scope from scratch and Finn will write a plan that rebuilds what already exists. Get it right.

---

**Step 6 — Update live context:**
\`\`\`
update_onboarding_context({ context: {
  project_name: "<name>",
  repo: "<url>",
  tech_preferences: "Next.js 14, TypeScript, PostgreSQL, Prisma, Vercel",
  open_source: true/false
} })
\`\`\`

**Step 7 — Summarize to the user.** Give them a clear 3-5 sentence summary of what you found before handing off. Something like:
> "Alright, here's what I've got so far: This is a Next.js 14 TypeScript app with Prisma + PostgreSQL. You're deploying to Vercel via GitHub Actions. The codebase is solid — about 12k lines, clean structure. I've saved all of this to our shared memory so the whole team has context. I'm passing you to Jim now to talk through the business side — what you're building this for and what success looks like."

### When to Hand Off to Jim

After you've cloned, explored, narrated your findings, and built the memory graph → hand off to Jim.

### Your Diagram Contributions

You are the FIRST agent — create the initial project diagram early! Within your first 2 messages, call \`update_onboarding_diagram\` with at least the project name as a central node. As you discover the repo structure, services, deployment targets, and tech stack — add them to the diagram. By handoff time, the diagram should show the project's infrastructure topology.
`,

  jim: `
## Your Role in This Onboarding: Business Strategy & Financial Context

You are Jim 💰, the Finance & Strategy agent. You arrive after Stas has sorted the repo — the team already knows the tech. Your job is to understand *why* we're building this and *what success looks like* so the product and planning can be calibrated correctly.

### 🚨 RECALL FIRST — Before asking anything:
\`\`\`
recall("project context goal customer", { scope: "shared" })
\`\`\`
**This is mandatory. Do it before your first response.** Stas already captured: project name, repo, tech stack, infrastructure, etc. You MUST NOT ask the user for these. Reference them by name. Build on what's there.

### Cover these (skip any already answered):

- What problem does this project solve, and who has it most acutely?
- Who is the target customer? (Developer, consumer, SMB, enterprise?)
- Commercial product, internal tool, or open-source?
- If commercial: monetization model (subscription, usage-based, freemium, license)?
- Revenue or success goal for V1 — what does "it worked" look like? (MRR, user count, cost savings, something else?)
- Timeline — when does V1 need to ship? Any hard deadline?
- Main competitors, if any?
- Any budget or resource constraints?

### Store what you learn:
\`\`\`
remember("fact", "<Name>: Goal",
  "[[Project: <Name>]] — [problem statement]. Target customer: [who]. " +
  "Success metric: [what]. See also [[<Name>: Target Customer]], [[<Name>: Monetization]].",
  { shared: true, tags: ["project:<name>", "goal"] }
)
remember("fact", "<Name>: Monetization",
  "[[Project: <Name>]] business model: [model]. Revenue goal: [target]. " +
  "Timeline: [when]. See [[<Name>: Goal]].",
  { shared: true, tags: ["project:<name>", "monetization"] }
)
\`\`\`

### When to Hand Off to Eric

Once you have: target customer, monetization/success metric, and timeline → hand off to Eric for product scope.

### Your Diagram Contributions

Extend the existing diagram with business/strategy nodes: target customer segments, revenue model, success metrics, and competitive positioning. Add these as new nodes connected to the existing project structure. Call \`update_onboarding_diagram\` after each major business insight.
`,

  eric: `
## Your Role in This Onboarding: Product Scope & Feature Definition

You are Eric 📋, the Product Owner. You arrive knowing the tech (from Stas) and the business context (from Jim). Your job is to define exactly what gets built in V1 — **anchored to the current state of the codebase, not from scratch**.

### 🚨 RECALL FIRST — Before asking anything:
\`\`\`
recall("project context goal customer scope", { scope: "shared" })
recall("feature inventory current state implemented partial", { scope: "shared" })
\`\`\`
**This is mandatory. Do both recalls.** You need two things: (1) the project goal and business context from Jim, and (2) Stas's Feature Inventory — the list of what is already implemented, what is partial, and what is a stub.

### Clone the Repo (if the project has one)

You run in your own isolated container — Stas's clone is NOT available to you. If the project has an existing repo (check shared memory for the URL), clone it so you can verify the Feature Inventory against actual code when discussing scope:
\`\`\`
get_github_token({ repo: "owner/repo" })  // configures git credentials for GitHub
git clone https://github.com/owner/repo.git /home/agent/workspace/project-repo
\`\`\`
If cloning fails, continue with memory-only context — don't block the conversation on it.

**You are NOT defining scope from scratch.** You are defining the *delta* — what still needs to be built to reach a shippable V1, given what already exists.

### How to frame the conversation

Open by summarising what Stas found, then orient the user around what's left:

> "OK so from what Stas found, [feature X] is fully implemented, [feature Y] is partially there, and [feature Z] hasn't been started yet. Jim told me the goal is [goal] and the target customer is [customer]. So let's talk about what V1 actually needs to look like from here."

**Do not ask the user to list features that are already implemented.** You already know them from the Feature Inventory. Your job is to:

1. **Confirm the inventory is accurate** — "Stas found the auth flow is complete and billing is a stub — does that match your sense of where things are?"
2. **Identify what's truly missing** — of the things that need to exist for V1, what isn't there yet?
3. **Decide what partial work is good enough** vs. what needs reworking
4. **Draw the V1 line** — what's in, what's explicitly deferred

### Cover these (only ask about genuine gaps):

- For each partial/stub feature Stas found: is this needed for V1? If yes, what exactly is missing?
- What features are completely missing that V1 requires?
- What exists in the codebase that is **NOT** going into V1? (Things to freeze or ignore)
- Walk through the primary user journey — which steps are already working end-to-end?
- Must-have integrations that aren't already wired up?
- Launch criteria — what does "ready to ship" mean given the current state?
- Any hard requirements? (GDPR, HIPAA, performance SLAs, accessibility?)

### Store what you learn:

The V1 Scope memory must clearly separate what exists from what needs building:
\`\`\`
remember("fact", "<Name>: V1 Scope",
  "[[Project: <Name>]] V1 scope — delta from current implementation:\\n" +
  "✅ Already built (include as-is): [list from Feature Inventory]\\n" +
  "🔧 Needs completion: [list — partial features that need finishing, with what's missing]\\n" +
  "🆕 Build from scratch: [list — features missing entirely that V1 requires]\\n" +
  "🚫 Explicitly out of scope for V1: [list — defer these]\\n" +
  "Launch criteria: [what does ready-to-ship mean]. " +
  "See [[<Name>: Feature Inventory]], [[<Name>: Goal]], [[<Name>: User Journey]].",
  { shared: true, tags: ["project:<name>", "v1-scope"] }
)
remember("fact", "<Name>: User Journey",
  "[[Project: <Name>]] primary flow: [step 1] → [step 2] → [step 3] → [value delivered]. " +
  "Steps already working: [list]. Steps needing work: [list]. " +
  "See [[<Name>: V1 Scope]].",
  { shared: true, tags: ["project:<name>", "user-journey"] }
)
\`\`\`

### When to Hand Off to Finn

Once you have: a clear delta scope (built/partial/missing), user journey status, and launch criteria → hand off to Finn.

### Your Diagram Contributions

Extend the diagram with product/feature nodes: user journey steps (mark which are built vs. missing), feature scope areas, and how they connect to the existing infrastructure and business nodes. Call \`update_onboarding_diagram\` after mapping each feature area.
`,

  finn: `
## Your Role in This Onboarding: Architecture + Planning Context Synthesis

You are Finn 🏗️, the Solutions Architect. You are the **final agent** in the relay. You have two jobs:

**Job 1:** Fill in any remaining architectural gaps — with the repo open in front of you, not just from memory.

**Job 2:** Synthesize EVERYTHING into a cohesive planning context document that reflects the *current state* of the project, so the planning pipeline can pick up exactly where the codebase is today.

---

### 🚨 STEP 0: Recall + Clone the Repo (Do This Before Anything Else)

You run in your own isolated sandbox. The repo Stas cloned is not available to you — you need to clone it yourself. This is mandatory for any project that has an existing codebase.

**First, recall everything including the repo URL:**
\`\`\`
recall("project tech stack architecture deployment repo", { scope: "shared" })
recall("project goal scope customer v1 feature inventory", { scope: "shared" })
\`\`\`

**Then immediately clone the repo** (the URL is in shared memory from Stas):
\`\`\`bash
cd /home/agent/workspace
git clone <repo-url-from-memory> project-repo
cd project-repo
\`\`\`

If the repo requires auth (private GitHub repo), use:
\`\`\`bash
git clone https://\${GITHUB_TOKEN}@github.com/<owner>/<repo>.git project-repo
\`\`\`

If cloning fails (no token, access issue), tell the user briefly and continue with memory-only context — don't block on it.

**Once cloned, do a quick orientation before greeting the user:**
\`\`\`bash
git log --oneline -10          # What was the team working on last?
git status                     # Any uncommitted changes?
ls -la                         # Top-level structure
\`\`\`

Now greet the user. Reference the project by name. Mention that you have the repo open. Example:
> "Hey — I'm Finn, the architect. I've got Kronmon cloned and open here. I can see the last few commits were around [X]. Stas found [Y] is fully implemented and [Z] is still a stub. Let me ask a few architectural questions to fill the remaining gaps, then I'll put together the full planning context."

---

### Job 1: Architectural Questions

You have the repo. Use it. When discussing any architectural topic, check the actual code rather than relying solely on memories. This is the difference between "Stas thinks auth is implemented" and "I'm looking at the auth middleware right now."

\`\`\`bash
# Auth — find and read it
find . -name "auth*" -o -name "*middleware*" -o -name "*jwt*" | grep -v node_modules | grep -v dist | head -15
# Data model — find schema
find . -name "schema*" -o -name "*.prisma" -o -name "*models*" | grep -v node_modules | grep -v dist | head -10
# Entry points / API surface
find . -name "routes*" -o -name "router*" | grep -v node_modules | grep -v dist | head -10
# Deployment config
cat docker-compose.yml 2>/dev/null || cat fly.toml 2>/dev/null || cat vercel.json 2>/dev/null | head -40
# Environment variables expected
cat .env.example 2>/dev/null || cat .env.template 2>/dev/null
\`\`\`

Fill in only genuine gaps — don't re-ask what Stas or Jim or Eric already covered. Topics:

- **Tech stack confirmation** — does the current stack fit the V1 requirements? Any gaps or changes needed?
- **Data model** — look at the actual schema/models. What's there? What's missing for V1?
- **Auth** — look at the actual implementation. Complete, partial, or missing?
- **Deployment topology** — where does it run today, and is that right for V1?
- **CI/CD** — what's actually in .github/workflows or equivalent?
- **Key risks** — what in the current codebase could cause problems at V1 scale?

Store architectural findings with linked memories, same pattern as the other agents.

---

### Job 2: Synthesize the Planning Context Document

This is the most important thing you produce. Once you've explored the repo and filled architectural gaps, recall ALL project memories:

\`\`\`
recall("project:<project-name-lowercase>", { scope: "shared", limit: 20 })
\`\`\`

Then write the **Planning Context Document**. The critical rule: **this document must reflect where the project is TODAY, not where it will be.** The planning pipeline uses this to generate tasks — if it reads like a greenfield spec, it will plan as if nothing exists. It must be explicit about what's already done.

Store it:
\`\`\`
remember("fact", "<Name>: Planning Context",
  "[[Project: <Name>]] — PLANNING CONTEXT DOCUMENT\\n\\n" +
  "## Project Overview\\n" +
  "[2-3 sentence description of what this is and why it exists. " +
  "State whether this is a new project or an existing one being continued.]\\n\\n" +
  "## Current State (as of onboarding)\\n" +
  "This is an EXISTING project. Do not plan it from scratch.\\n" +
  "✅ Already implemented and working: [list — be specific, e.g. 'user auth (JWT + refresh tokens)', 'project CRUD API', 'GitHub webhook ingestion']\\n" +
  "⚠️ Partially implemented (needs completion): [list — e.g. 'notification system (wired but not sending)', 'billing (Stripe keys set, no webhook handler)']\\n" +
  "❌ Stub / not yet implemented: [list — e.g. 'admin dashboard returns 501', 'export feature is a TODO comment']\\n" +
  "🔲 Not started (required for V1): [list — features that are missing entirely]\\n\\n" +
  "## Tech Stack\\n" +
  "[Full stack: language, framework, database, auth, deployment, CI/CD — verified against actual repo]\\n\\n" +
  "## Target Customer & Goal\\n" +
  "[Who, what problem, success metric]\\n\\n" +
  "## V1 Scope — What Needs to Be Done\\n" +
  "The following work is required to reach a shippable V1:\\n" +
  "🔧 Complete partial work: [list with specifics of what's missing in each]\\n" +
  "🆕 Build from scratch: [list of new features required]\\n" +
  "🚫 Explicitly out of scope for V1: [list — the planning pipeline must not plan these]\\n\\n" +
  "## User Journey\\n" +
  "[Primary flow step by step — note which steps are already working end-to-end]\\n\\n" +
  "## Architecture\\n" +
  "[Deployment topology, data model summary, auth approach, key services — " +
  "verified against actual code where possible]\\n\\n" +
  "## Key Constraints & Risks\\n" +
  "[Timeline, budget, technical risks, migration concerns, dependencies]\\n\\n" +
  "## Instructions for the Planning Pipeline\\n" +
  "- This is an EXISTING codebase. Do NOT plan tasks for things marked ✅ Already implemented above.\\n" +
  "- Start task decomposition from the current state, not from zero.\\n" +
  "- Preserve existing patterns and conventions — don't rearchitect what works.\\n" +
  "[Any other project-specific guidance that would affect task decomposition: " +
  "migration concerns, third-party integrations, non-negotiable requirements, " +
  "areas where the existing code needs refactoring vs. extension]",
  { shared: true, tags: ["project:<name>", "planning-context", "onboarding-synthesis"] }
)
\`\`\`

### Final Handoff

When the document is stored, tell the user what you've prepared and what happens next:
> "I've put together the planning context — it captures the current state of Kronmon: what's already built, what needs finishing, and what's still to come. [Brief summary]. Ready to create the project?"

Then call handoff to signal completion. Use \`next_agent: "done"\` — this tells the system to create the project and kick off the planning pipeline automatically with all the context you've gathered:
\`\`\`
onboarding_handoff({
  next_agent: "done",
  summary: "Architecture and planning context complete. [One sentence summary].",
  context: {
    tech_preferences: "[stack]",
    planning_context: "[The full planning context document text — copy it here]",
    v1_scope: "[brief v1 summary]",
    architecture_summary: "[key architecture decisions]"
  }
})
\`\`\`

The \`planning_context\` field in the context will be passed directly to the planning pipeline as \`additional_context\`. Finn (the planning pipeline lead) will use this to break the project down into tasks.

### Your Diagram Contributions

As the final agent, refine the diagram into the **definitive technical architecture** — all services, databases, queues, external APIs, and deployment topology should be represented. Previous agents added infrastructure, business, and product nodes; your job is to wire them into a coherent architecture graph. Make the final \`update_onboarding_diagram\` call the most complete and polished version. This is what the user takes away.
`,
};

function buildOnboardingSystemSupplement(agentId: string, onboardingSessionId?: string): string {
  const agentInstructions = ONBOARDING_AGENT_INSTRUCTIONS[agentId] || '';
  return agentInstructions + buildOnboardingSharedPreamble(onboardingSessionId);
}

export class ChatSessionManager {
  private containerManager: ContainerManager;
  private commandSender: CommandSender;
  private eventReceiver: EventReceiver;
  private redis: Redis;
  private apiBaseUrl: string;
  private dataPath: string;
  private containerImage: string;
  private personaLoader: PersonaLoader;
  
  private activeSessions: Map<string, ActiveSession> = new Map();
  private commandRedis: Redis;  // Separate connection for pub/sub
  /** Dedicated Redis connection for publishing to session channels (djinnbot:sessions:*).
   *  Isolated from the main `this.redis` so token publishes are never queued behind
   *  XADD, EXPIRE, SET, or other engine operations on the shared connection. */
  private publishRedis: Redis;
  /** Dedicated Redis for CommandSender — isolated from the main `this.redis`
   *  which is blocked by XREADGROUP BLOCK loops in ChatListener and main.ts. */
  private commandSenderRedis: Redis;
  /** Dedicated Redis for ContainerManager — its PUBLISH (graceful shutdown)
   *  must not be queued behind blocking reads on the shared connection. */
  private containerManagerRedis: Redis;
  private commandSubscribers: Map<string, Redis> = new Map();  // Track all session subscribers
  private idleTimeoutMs: number;
  private reaperIntervalMs: number;
  private reaperTimer: ReturnType<typeof setInterval> | null = null;
  private lifecycleTracker?: AgentLifecycleTracker;

  // ─── External event hooks ────────────────────────────────────────────────────
  // Registered by SlackBridge to pipe session output into live Slack streamers.

  /** Called for each streaming text chunk from the container. */
  private outputHook?: (sessionId: string, chunk: string) => void;
  /** Called when a tool call starts inside the container. */
  private toolStartHook?: (sessionId: string, toolName: string, args: Record<string, unknown>) => void;
  /** Called when a tool call completes inside the container. */
  private toolEndHook?: (sessionId: string, toolName: string, result: string, isError: boolean, durationMs: number) => void;
  /** Called when the agent finishes its response (stepEnd). */
  private stepEndHook?: (sessionId: string, success: boolean) => void;

  /** Register hooks for external consumers (e.g. SlackBridge streaming). */
  registerHooks(hooks: {
    onOutput?: (sessionId: string, chunk: string) => void;
    onToolStart?: (sessionId: string, toolName: string, args: Record<string, unknown>) => void;
    onToolEnd?: (sessionId: string, toolName: string, result: string, isError: boolean, durationMs: number) => void;
    onStepEnd?: (sessionId: string, success: boolean) => void;
  }): void {
    this.outputHook = hooks.onOutput;
    this.toolStartHook = hooks.onToolStart;
    this.toolEndHook = hooks.onToolEnd;
    this.stepEndHook = hooks.onStepEnd;
  }

  constructor(config: ChatSessionManagerConfig) {
    this.redis = config.redis;
    this.apiBaseUrl = config.apiBaseUrl;
    this.dataPath = config.dataPath;
    this.containerImage = config.containerImage || process.env.AGENT_RUNTIME_IMAGE || 'ghcr.io/basedatum/djinnbot/agent-runtime:latest';
    this.idleTimeoutMs = config.idleTimeoutMs ?? 30 * 60 * 1000;  // 30 minutes
    this.reaperIntervalMs = config.reaperIntervalMs ?? 60 * 1000;  // 1 minute
    this.personaLoader = new PersonaLoader(config.agentsDir ?? process.env.AGENTS_DIR ?? './agents');
    
    // Dedicated Redis connections — the main `this.redis` is shared with
    // blocking XREADGROUP loops (ChatListener, listenForNewRuns) which starve
    // any PUBLISH/SET/XADD queued on the same connection for up to 5-10s.
    this.commandSenderRedis = new Redis(config.redis.options);
    this.containerManagerRedis = new Redis(config.redis.options);
    
    this.containerManager = new ContainerManager(this.containerManagerRedis);
    this.commandSender = new CommandSender(this.commandSenderRedis);
    this.eventReceiver = new EventReceiver(() => new Redis(config.redis.options));
    
    // Separate Redis for command subscription (blocking)
    this.commandRedis = new Redis(config.redis.options);
    
    // Dedicated Redis for publishing to session channels — isolated from the
    // shared this.redis so fire-and-forget token publishes are never queued
    // behind slow XADD/EXPIRE/SET operations on the main connection.
    this.publishRedis = new Redis(config.redis.options);
    
    // Wire optional lifecycle tracker for activity feed integration
    if (config.lifecycleTracker) {
      this.lifecycleTracker = config.lifecycleTracker;
    }

    // Start the idle session reaper
    this.startReaper();
  }

  /**
   * Fetch all configured provider API keys from the settings service and
   * return them as a map of env var name → key value, ready to spread into
   * a container's Env array.
   *
   * Merges DB-stored keys with env vars already present on the engine process.
   * The settings endpoint already does this server-side, so this is just a
   * pass-through; we keep process.env as an additional local fallback.
   */
  /** Per-provider key source metadata returned by the last fetchProviderEnvVars call. */
  private _lastKeySources: Record<string, { source: string; masked_key: string }> = {};

  private async fetchProviderEnvVars(userId?: string): Promise<Record<string, string>> {
    // Start with whatever is already in process.env (primary API keys only)
    const result: Record<string, string> = {};
    this._lastKeySources = {};
    // When fetching for a specific user, don't seed from process.env —
    // strict mode means only user-owned or admin-shared keys are used.
    if (!userId) {
      for (const envVar of Object.values(PROVIDER_ENV_MAP)) {
        const val = process.env[envVar];
        if (val) result[envVar] = val;
      }
    }

    // Overlay with DB-stored keys and extra env vars (these take precedence over local env)
    const userParam = userId ? `?user_id=${encodeURIComponent(userId)}` : '';
    try {
      const res = await authFetch(`${this.apiBaseUrl}/v1/settings/providers/keys/all${userParam}`);
      if (res.ok) {
        const data = await res.json() as {
          keys: Record<string, string>;
          extra?: Record<string, string>;
          key_sources?: Record<string, { source: string; masked_key: string }>;
        };
        // Capture per-provider key source metadata
        if (data.key_sources) {
          this._lastKeySources = data.key_sources;
        }
        // Primary API keys
        for (const [providerId, apiKey] of Object.entries(data.keys)) {
          if (!apiKey) continue;
          // Custom providers: derive env var from slug (e.g. "custom-lm-studio" → "CUSTOM_LM_STUDIO_API_KEY")
          if (providerId.startsWith('custom-')) {
            const slug = providerId.slice('custom-'.length).toUpperCase().replace(/-/g, '_');
            result[`CUSTOM_${slug}_API_KEY`] = apiKey;
          } else {
            const envVar = PROVIDER_ENV_MAP[providerId];
            if (envVar) result[envVar] = apiKey;
          }
        }
        // Extra env vars (e.g. AZURE_OPENAI_BASE_URL for Azure)
        for (const [envVar, value] of Object.entries(data.extra ?? {})) {
          if (value) result[envVar] = value;
        }
      }
    } catch (err) {
      console.warn('[ChatSessionManager] Failed to fetch provider keys from settings:', err);
      // Fall through — process.env keys still injected
    }

    return result;
  }

  /**
   * Fetch the current agentRuntimeImage from the settings API.
   * Falls back to the constructor-provided image (or env/default) on failure.
   */
  private async fetchRuntimeImage(): Promise<string> {
    try {
      const res = await authFetch(`${this.apiBaseUrl}/v1/settings/`);
      if (res.ok) {
        const data = await res.json() as { agentRuntimeImage?: string };
        const dbImage = data.agentRuntimeImage?.trim();
        if (dbImage) {
          return dbImage;
        }
      }
    } catch (err) {
      console.warn('[ChatSessionManager] Failed to fetch runtime image from settings:', err);
    }
    return this.containerImage;
  }

  /**
   * Fetch all secrets granted to *agentId* and return env var name → plaintext value.
   * Non-fatal: logs and returns an empty map if unavailable.
   */
  private async fetchAgentSecretEnvVars(agentId: string): Promise<Record<string, string>> {
    try {
      const res = await authFetch(`${this.apiBaseUrl}/v1/secrets/agents/${encodeURIComponent(agentId)}/env`);
      if (res.ok) {
        const data = await res.json() as { agent_id: string; env: Record<string, string> };
        return data.env ?? {};
      }
    } catch (err) {
      console.warn(`[ChatSessionManager] Failed to fetch secrets for agent ${agentId}:`, err);
    }
    return {};
  }

  /**
   * Start a new chat session - creates and starts a container.
   */
  async startSession(config: ChatSessionConfig): Promise<void> {
    const { sessionId, agentId, model, sessionType, onboardingSessionId, greetingMessageId, systemPromptSupplement, systemPromptOverride, externalHistory, thinkingLevel, userId } = config;
    
    const sessionTypeTag = sessionType === 'onboarding'
      ? ` [ONBOARDING, onbId=${onboardingSessionId ?? 'unknown'}${greetingMessageId ? `, greetingMsg=${greetingMessageId}` : ''}]`
      : (sessionType ? ` [${sessionType}]` : '');
    console.log(`[ChatSessionManager] Starting session ${sessionId} for agent ${agentId}${sessionTypeTag}`);
    
    if (this.activeSessions.has(sessionId)) {
      console.warn(`[ChatSessionManager] Session ${sessionId} already active`);
      return;
    }
    
    // Track session
    const session: ActiveSession = {
      sessionId,
      agentId,
      model,
      status: 'starting',
      conversationHistory: [],
      accumulatedThinking: '',
      accumulatedToolCalls: [],
      lastActivityAt: Date.now(),
      startedAt: Date.now(),
    };
    this.activeSessions.set(sessionId, session);
    
    // Ensure the session has a DB row. Dashboard/CLI sessions are created via
    // the API (POST /agents/{id}/chat/start) before the engine is signaled, but
    // Slack-originated sessions bypass that flow — they call startSession()
    // directly. Without a DB row the orphan-recovery path cannot discover the
    // session after an engine restart, leaving Docker containers running forever.
    await this.ensureSessionInDb(sessionId, agentId, model);
    
    // Update API
    await this.updateSessionStatus(sessionId, 'starting');
    
    try {
      // Build system prompt: override takes full precedence, otherwise load persona
      let systemPrompt = '';
      if (systemPromptOverride) {
        systemPrompt = systemPromptOverride;
        console.log(`[ChatSessionManager] Using system prompt override for ${sessionId} (${systemPrompt.length} chars)`);
      } else {
        try {
          const persona = await this.personaLoader.loadPersona(agentId, undefined, {
            sessionType: 'chat',
            runId: sessionId,
          });
          systemPrompt = persona.systemPrompt;
          console.log(`[ChatSessionManager] Loaded persona for ${agentId} (${systemPrompt.length} chars)`);
        } catch (err) {
          console.warn(`[ChatSessionManager] Failed to load persona for ${agentId}, using empty prompt:`, err);
        }

        // For onboarding sessions: append per-agent area instructions + shared protocol.
        if (sessionType === 'onboarding') {
          systemPrompt += buildOnboardingSystemSupplement(agentId, onboardingSessionId);
          console.log(`[ChatSessionManager] Onboarding supplement injected for ${agentId} (total prompt=${systemPrompt.length} chars)`);
        }

        // Append caller-supplied supplement (e.g. project context for project chat).
        if (systemPromptSupplement) {
          systemPrompt += `\n\n---\n\n${systemPromptSupplement}`;
        }

      }

      // Fetch existing chat history — use externalHistory (e.g. from Slack thread) if
      // provided, otherwise fall back to the DB fetch for standard chat sessions.
      let chatHistoryJson = '';
      const MAX_HISTORY_BYTES = 64 * 1024;  // 64 KB — conservative env var limit
      try {
        const historyData = externalHistory ?? await this.fetchChatHistory(sessionId);
        if (historyData.length > 0) {
          // Seed the in-memory conversation history (all messages)
          session.conversationHistory = historyData.map(m => ({
            role: m.role as 'user' | 'assistant' | 'system',
            content: m.content,
            timestamp: m.created_at,
          }));

          // Trim history from the front if total JSON size exceeds the env var limit,
          // keeping the most recent messages (tail) within the budget.
          let trimmed = historyData;
          let json = JSON.stringify(trimmed);
          while (json.length > MAX_HISTORY_BYTES && trimmed.length > 2) {
            trimmed = trimmed.slice(Math.ceil(trimmed.length / 4));
            json = JSON.stringify(trimmed);
          }
          if (json.length <= MAX_HISTORY_BYTES) {
            chatHistoryJson = json;
            const note = trimmed.length < historyData.length
              ? ` (trimmed to ${trimmed.length} most-recent)`
              : '';
            const source = externalHistory ? 'Slack thread' : 'DB';
            console.log(`[ChatSessionManager] Loaded ${historyData.length} historical messages from ${source} for ${sessionId}${note}`);
          } else {
            console.warn(`[ChatSessionManager] Chat history too large to pass as env var (${json.length} bytes), skipping history injection`);
          }
        }
      } catch (err) {
        console.warn(`[ChatSessionManager] Failed to load chat history for ${sessionId}:`, err);
      }

      // Fetch all provider API keys from settings (DB + env vars)
      // and the current runtime image (may have been changed via dashboard).
      // When userId is provided, keys are resolved per-user (strict mode).
      const [providerEnvVars, runtimeImage] = await Promise.all([
        this.fetchProviderEnvVars(userId),
        this.fetchRuntimeImage(),
      ]);

      // Record key resolution metadata on the chat session (non-blocking).
      // This mirrors what ContainerRunner does for pipeline runs.
      // Includes per-provider source (personal / admin_shared / instance) and masked keys.
      const resolvedProviders = Object.keys(providerEnvVars)
        .filter(k => k.endsWith('_API_KEY') || k.endsWith('_TOKEN'))
        .map(k => {
          for (const [pid, env] of Object.entries(PROVIDER_ENV_MAP)) {
            if (env === k) return pid;
          }
          return k;
        });
      authFetch(`${this.apiBaseUrl}/v1/chat/sessions/${sessionId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          key_resolution: JSON.stringify({
            userId: userId ?? null,
            source: userId ? 'executing_user' : 'system',
            resolvedProviders,
            providerSources: this._lastKeySources,
          }),
        }),
      }).catch(() => {}); // Non-fatal — don't block container creation

      // Create container config
      const containerConfig: ContainerConfig = {
        runId: sessionId,  // Use sessionId as runId for container
        agentId,
        workspacePath: `${this.dataPath}/workspaces/${agentId}`,
        image: runtimeImage,
        env: {
          AGENT_MODEL: model,
          // Inject all configured provider API keys as their canonical env var names
          ...providerEnvVars,
          ...(systemPrompt ? { AGENT_SYSTEM_PROMPT: systemPrompt } : {}),
          ...(chatHistoryJson ? { AGENT_CHAT_HISTORY: chatHistoryJson } : {}),
          // For onboarding sessions: inject the session ID so the agent can call
          // update_onboarding_context to update the live project profile sidebar.
          ...(sessionType === 'onboarding' && onboardingSessionId
            ? { ONBOARDING_SESSION_ID: onboardingSessionId }
            : {}),
          // Per-agent API key for authenticating to the DjinnBot API
          ...(getAgentApiKey(agentId) ? { AGENT_API_KEY: getAgentApiKey(agentId)! } : {}),
          // Extended thinking level — passed through to the agent runtime's Agent constructor.
          ...(thinkingLevel && thinkingLevel !== 'off' ? { AGENT_THINKING_LEVEL: thinkingLevel } : {}),
          // LLM call logging context — used by the runtime to tag each API call
          CHAT_SESSION_ID: sessionId,
          // User attribution — agent-runtime includes this in LLM call logs
          // so daily usage can be tracked per-user for share limit enforcement.
          ...(userId ? { DJINNBOT_USER_ID: userId } : {}),
          ...(() => {
            // Extract provider from model string (e.g. "anthropic/claude-sonnet-4" → "anthropic")
            const provider = model.includes('/') ? model.split('/')[0] : model;
            const ks = this._lastKeySources[provider];
            return ks ? { KEY_SOURCE: ks.source, KEY_MASKED: ks.masked_key } : {} as Record<string, string>;
          })(),
          // MCP / mcpo: inject base URL and API key so agents can call tools directly.
          // These are only set if the engine has mcpo configured.
          ...(process.env.MCPO_BASE_URL ? { MCPO_BASE_URL: process.env.MCPO_BASE_URL } : {}),
          ...(process.env.MCPO_API_KEY ? { MCPO_API_KEY: process.env.MCPO_API_KEY } : {}),
        },
      };
      
      // Wire up image pull callback — if the runtime image is missing the
      // ContainerManager will auto-pull it. We forward status to the user via SSE
      // and, on failure, create an admin notification.
      this.containerManager.onImagePull = (event, image, error) => {
        if (event === 'pull_start') {
          this.publishToChannel(sessionId, {
            type: 'session_status',
            timestamp: Date.now(),
            data: { message: 'Pulling the latest agent runtime...' },
          });
        } else if (event === 'pull_failed') {
          // Notify the user something went wrong
          this.publishToChannel(sessionId, {
            type: 'session_error',
            timestamp: Date.now(),
            data: { message: 'Something went wrong starting the session. The admins have been notified.' },
          });
          // Create an admin notification (fire-and-forget)
          this.createAdminNotification(
            'error',
            'Failed to pull agent runtime image',
            `Image "${image}" could not be pulled: ${error}`,
          );
        }
        // pull_success — no separate message needed, the session continues to start normally
      };

      // Create and start container
      await this.containerManager.createContainer(containerConfig);
      
      // Subscribe to container events BEFORE starting (important!)
      await this.eventReceiver.subscribeToRun(sessionId);
      this.setupEventHandlers(sessionId);
      
      // Start container and wait for ready
      await this.containerManager.startContainer(sessionId);
      
      session.status = 'ready';
      session.startedAt = Date.now();
      session.containerId = sessionId;  // Container uses sessionId as its ID
      
      // Subscribe to command channel for this session
      this.subscribeToCommands(sessionId);
      
      // Update API with container info
      await this.updateSessionContainer(sessionId, sessionId, 'running');
      
      console.log(`[ChatSessionManager] Session ${sessionId} ready`);

      // Record session started in the agent's activity timeline.
      // This makes the chat session visible in the Activity tab immediately
      // when the container is ready — before any user message is sent.
      if (this.lifecycleTracker) {
        const source = sessionType === 'onboarding' ? 'onboarding' : 'chat';
        this.lifecycleTracker.recordSessionStarted(agentId, sessionId, source, '', model)
          .catch(err => console.warn(`[ChatSessionManager] Failed to record session_started for ${sessionId}:`, err));
      }

      // For onboarding sessions: send a proactive first message so the agent
      // introduces itself and starts the interview without waiting for the user.
      if (sessionType === 'onboarding') {
        const greeting = [
          'The onboarding session has started and the user is now viewing this chat.',
          agentId === 'stas'
            ? 'Introduce yourself warmly, explain briefly what you\'ll be doing together (gathering project context to set up their project), and ask your first question. Keep it conversational — one question at a time.'
            : 'IMPORTANT: Before saying anything to the user, you MUST first call recall to read what previous agents already learned. Use recall({ query: "project context goal", scope: "shared" }) right now. Then introduce yourself referencing the project by name (from shared memory) and dive straight into your area — do NOT re-ask for anything the user already told a previous agent. Keep it conversational — one question at a time.',
        ].join(' ');

        // Small delay so SSE clients have time to connect before the first output arrives
        setTimeout(async () => {
          try {
            // Set currentMessageId so stepEnd persists the response to the DB.
            if (greetingMessageId) {
              const activeSession = this.activeSessions.get(sessionId);
              if (activeSession) {
                activeSession.currentMessageId = greetingMessageId;
                activeSession.status = 'busy';
              }
            }
            await this.commandSender.sendAgentStep(sessionId, greeting, {});
            console.log(`[ChatSessionManager] Sent proactive onboarding greeting to ${sessionId}`);
          } catch (err) {
            console.warn(`[ChatSessionManager] Failed to send proactive greeting to ${sessionId}:`, err);
          }
        }, 1500);
      }
      
    } catch (err) {
      console.error(`[ChatSessionManager] Failed to start session ${sessionId}:`, err);
      session.status = 'stopping';
      this.activeSessions.delete(sessionId);

      const errMsg = String(err);
      const isImagePullFailure = errMsg.includes('Failed to pull agent runtime image');

      // For image pull failures the user-facing SSE message was already sent
      // in the onImagePull callback. For other errors, send a generic error event.
      if (!isImagePullFailure) {
        this.publishToChannel(sessionId, {
          type: 'session_error',
          timestamp: Date.now(),
          data: { message: 'Something went wrong starting the session. Please try again.' },
        });
      }

      await this.updateSessionStatus(sessionId, 'failed', errMsg);
      throw err;
    }
  }

  /**
   * Fetch existing chat messages for a session from the API.
   * Returns messages in chronological order, filtering out empty assistant placeholders.
   */
  private async fetchChatHistory(sessionId: string): Promise<Array<{
    role: string;
    content: string;
    created_at: number;
    attachments?: string[];
  }>> {
    try {
      const res = await authFetch(`${this.apiBaseUrl}/v1/chat/sessions/${sessionId}`);
      if (!res.ok) {
        if (res.status === 404) return [];  // New session, no history
        throw new Error(`API returned ${res.status}`);
      }
      const data = await res.json() as {
        messages?: Array<{ role: string; content: string; created_at: number; completed_at?: number | null; attachments?: string[] | null }>;
      };
      // Only include messages with actual content (skip empty assistant placeholders)
      return (data.messages ?? [])
        .filter(m => m.content && m.content.trim().length > 0)
        .map(m => ({
          role: m.role,
          content: m.content,
          created_at: m.created_at,
          ...(m.attachments ? { attachments: m.attachments } : {}),
        }));
    } catch (err) {
      console.warn(`[ChatSessionManager] fetchChatHistory failed for ${sessionId}:`, err);
      return [];
    }
  }

  /**
   * Send a message in a chat session.
   *
   * @param attachments  Optional attachment metadata from the chat API.
   *   Forwarded to the container via the agentStep command so the runner
   *   can fetch file content and build multimodal content blocks.
   */
  async sendMessage(
    sessionId: string,
    message: string,
    model?: string,
    messageId?: string,
    attachments?: Array<{ id: string; filename: string; mimeType: string; sizeBytes: number; isImage: boolean; estimatedTokens?: number }>,
  ): Promise<void> {
    const session = this.activeSessions.get(sessionId);
    
    if (!session) {
      throw new Error(`Session ${sessionId} not found`);
    }
    
    if (session.status !== 'ready') {
      throw new Error(`Session ${sessionId} not ready (status: ${session.status})`);
    }
    
    console.log(`[ChatSessionManager] Sending message to session ${sessionId}${attachments?.length ? ` with ${attachments.length} attachment(s)` : ''}`);
    
    // Update model if changed
    if (model && model !== session.model) {
      session.model = model;
      // Note: Model change will take effect on next container restart
      // For immediate model change, container would need to be restarted
      console.warn(`[ChatSessionManager] Model updated to ${model}, but container still using previous model. Consider restarting session for immediate effect.`);
    }
    
    session.status = 'busy';
    session.lastActivityAt = Date.now();
    
    // Track the message ID for completion
    if (messageId) {
      session.currentMessageId = messageId;
      console.log(`[ChatSessionManager] Message ID linked for completion: ${messageId} (session=${sessionId})`);
    } else {
      console.warn(`[ChatSessionManager] sendMessage ${sessionId}: no messageId provided — response will NOT be persisted to DB`);
    }
    
    // Reset accumulators for this turn
    session.accumulatedThinking = '';
    session.accumulatedToolCalls = [];
    
    // Add to conversation history (kept for session resume / API persistence)
    session.conversationHistory.push({
      role: 'user',
      content: message,
      timestamp: Date.now(),
    });

    // Send only the new user message to the container.
    // The container's ContainerAgentRunner keeps a persistent Agent instance
    // alive across turns, so it accumulates conversation history (including
    // tool calls and results) natively via pi-agent-core.  Sending the full
    // flat-text history here would break multi-turn context.
    await this.commandSender.sendAgentStep(sessionId, message, {
      // model is set via AGENT_MODEL env var on container creation
      ...(attachments?.length ? { attachments } : {}),
    });
  }

  /**
   * Trigger a memory consolidation turn before session teardown.
   *
   * Sends a "last words" system message instructing the agent to use its
   * existing `remember` tool to save anything worth keeping from the
   * conversation — insights, decisions, relationship context, lessons.
   * The agent decides what to save (or nothing at all). This mirrors how
   * a person naturally consolidates memories after a meaningful exchange.
   *
   * Quality gate: only fires for sessions with ≥ minTurns human turns OR
   * sessions that used at least one tool (rich sessions). Trivial 1-line
   * exchanges are skipped to avoid wasting tokens.
   *
   * The consolidation runs as a regular agent turn with a hard 60 s timeout.
   * Failures are non-fatal — the session stops regardless.
   */
  async triggerConsolidation(sessionId: string, minTurns: number = 3): Promise<void> {
    const session = this.activeSessions.get(sessionId);
    if (!session) {
      console.log(`[ChatSessionManager] triggerConsolidation: session ${sessionId} not found, skipping`);
      return;
    }

    // Quality gate — skip trivial sessions
    const humanTurns = session.conversationHistory.filter(m => m.role === 'user').length;
    const hadToolUse = session.accumulatedToolCalls.length > 0;
    if (humanTurns < minTurns && !hadToolUse) {
      console.log(
        `[ChatSessionManager] triggerConsolidation: skipping ${sessionId} ` +
        `(${humanTurns} human turns, hadToolUse=${hadToolUse} — below threshold)`
      );
      return;
    }

    if (session.status !== 'ready') {
      console.log(`[ChatSessionManager] triggerConsolidation: session ${sessionId} not ready (${session.status}), skipping`);
      return;
    }

    console.log(
      `[ChatSessionManager] triggerConsolidation: running for ${sessionId} ` +
      `(${humanTurns} human turns, hadToolUse=${hadToolUse})`
    );

    const consolidationPrompt = [
      'This conversation is ending (idle timeout). Before the session closes:',
      '',
      'Review our conversation and use the `remember` tool to save anything genuinely',
      'worth keeping — insights about this person, decisions made, things you learned,',
      'preferences or context about the relationship. Think like a person who just finished',
      'a meaningful conversation and is jotting down the important bits.',
      '',
      'Guidelines:',
      '- Only save things that would actually be useful to remember in a future conversation',
      '- Use memory type "relationship" for things about who you talked to',
      '- Use memory type "lesson" for things you learned or mistakes corrected',
      '- Use memory type "decision" for choices made that might recur',
      '- Use memory type "fact" for specific information worth retaining',
      '- If nothing stands out as worth remembering, do nothing — just call complete()',
      '- Do NOT re-save things you already saved during this conversation',
      '- Keep shared=false (personal) unless the memory is team-relevant knowledge',
    ].join('\n');

    try {
      // Wait for the consolidation turn to finish (max 60 s)
      await Promise.race([
        this.commandSender.sendAgentStep(sessionId, consolidationPrompt, {}),
        new Promise<void>((_, reject) =>
          setTimeout(() => reject(new Error('consolidation timeout')), 60_000)
        ),
      ]);

      // Allow time for the agent to process and call remember
      // We poll for the session to return to 'ready' (agent finished its turn)
      const pollStart = Date.now();
      while (Date.now() - pollStart < 55_000) {
        const s = this.activeSessions.get(sessionId);
        if (!s || s.status === 'ready') break;
        await new Promise(r => setTimeout(r, 500));
      }

      console.log(`[ChatSessionManager] triggerConsolidation: ${sessionId} complete`);
    } catch (err) {
      console.warn(`[ChatSessionManager] triggerConsolidation: ${sessionId} failed (non-fatal):`, (err as Error).message);
    }
  }

  /**
   * Stop a chat session - stops the container.
   */
  async stopSession(sessionId: string): Promise<void> {
    const session = this.activeSessions.get(sessionId);
    // Capture session metadata before it may be removed from activeSessions
    const sessionAgentId = session?.agentId;
    const sessionStartedAt = session?.startedAt ?? Date.now();
    
    console.log(`[ChatSessionManager] Stopping session ${sessionId}${session ? '' : ' (untracked — stopping container directly)'}`);
    
    if (session) {
      session.status = 'stopping';
      
      // Unsubscribe from commands channel first, then quit the subscriber
      // connection outside of the current call stack.  quit() must be deferred
      // with setImmediate when stopSession is triggered from inside the
      // subscriber's own message handler (e.g. a chat:stop command) — calling
      // quit() synchronously on the same connection that is mid-delivery causes
      // EPIPE / "Connection is closed" errors in ioredis.
      if (session.commandSubscription) {
        session.commandSubscription();
      }
      const subscriber = this.commandSubscribers.get(sessionId);
      if (subscriber) {
        this.commandSubscribers.delete(sessionId);
        setImmediate(() => {
          subscriber.quit().catch(err => {
            console.warn(`[ChatSessionManager] Error quitting subscriber for ${sessionId}:`, err);
          });
        });
      }
      
      // Unsubscribe from events
      try {
        await this.eventReceiver.unsubscribeFromRun(sessionId);
      } catch (err) {
        console.warn(`[ChatSessionManager] Error unsubscribing events for ${sessionId}:`, err);
      }
    }
    
    try {
      // Stop container — ContainerManager now falls back to Docker name lookup
      // when the container isn't in its in-memory map (e.g. after engine restart).
      await this.containerManager.stopContainer(sessionId, true);
      
      // Update the ChatSession status
      await this.updateSessionStatus(sessionId, 'completed');

      // For onboarding sessions (id: onb_{agentId}_{onboardingSessionId}_{ts}):
      // also mark the OnboardingSession as abandoned so the UI doesn't show
      // it stuck in "active" forever after idle timeout or engine restart.
      if (sessionId.startsWith('onb_')) {
        this.updateOnboardingSessionStatus(sessionId, 'abandoned').catch(err =>
          console.warn(`[ChatSessionManager] Failed to mark onboarding session abandoned: ${err}`)
        );
      }

      // Record session completed in the agent's activity timeline.
      if (this.lifecycleTracker && sessionAgentId) {
        const durationMs = Date.now() - sessionStartedAt;
        this.lifecycleTracker.recordSessionCompleted(sessionAgentId, sessionId, {
          durationMs,
          success: true,
        }).catch(err => console.warn(`[ChatSessionManager] Failed to record session_completed for ${sessionId}:`, err));
      }
      
    } catch (err) {
      console.error(`[ChatSessionManager] Error stopping session ${sessionId}:`, err);
      await this.updateSessionStatus(sessionId, 'failed', String(err));

      // Record session failed in the agent's activity timeline.
      if (this.lifecycleTracker && sessionAgentId) {
        const durationMs = Date.now() - sessionStartedAt;
        this.lifecycleTracker.recordSessionCompleted(sessionAgentId, sessionId, {
          durationMs,
          success: false,
          error: String(err),
        }).catch(e => console.warn(`[ChatSessionManager] Failed to record session_failed for ${sessionId}:`, e));
      }
    } finally {
      this.activeSessions.delete(sessionId);
    }
    
    console.log(`[ChatSessionManager] Session ${sessionId} stopped`);
  }

  /**
   * Update model for an active session.
   * Note: This only updates the tracking. Container restart required for actual model change.
   */
  updateModel(sessionId: string, model: string): void {
    const session = this.activeSessions.get(sessionId);
    if (session) {
      session.model = model;
      console.log(`[ChatSessionManager] Updated model for ${sessionId}: ${model} (restart required for effect)`);
    }
  }

  /**
   * Check if a session is active.
   */
  isSessionActive(sessionId: string): boolean {
    return this.activeSessions.has(sessionId);
  }

  /**
   * Get active session info.
   */
  getSession(sessionId: string): ActiveSession | undefined {
    return this.activeSessions.get(sessionId);
  }

  /**
   * Recover orphaned sessions from before a restart.
   *
   * Queries the API for chat sessions that are in 'starting' or 'running'
   * state (which means the engine was managing them when it crashed/restarted).
   * Stops their Docker containers directly and marks them completed/abandoned.
   *
   * Called once on startup, before the chat listener begins accepting new sessions.
   */
  async recoverOrphanedSessions(): Promise<void> {
    console.log('[ChatSessionManager] Checking for orphaned sessions from previous run...');
    try {
      const res = await authFetch(`${this.apiBaseUrl}/v1/internal/chat/sessions?status=running&status=starting&limit=50`);
      if (!res.ok) {
        console.warn(`[ChatSessionManager] Orphan recovery: API returned ${res.status}`);
        return;
      }
      const data = await res.json() as { sessions?: Array<{ id: string; agent_id: string }> };
      const orphans = data.sessions ?? [];
      if (orphans.length === 0) {
        console.log('[ChatSessionManager] No orphaned sessions found');
        return;
      }
      console.log(`[ChatSessionManager] Found ${orphans.length} orphaned session(s) — stopping containers`);
      for (const s of orphans) {
        try {
          // Stop container by name (ContainerManager falls back to Docker name lookup)
          await this.containerManager.stopContainer(s.id, true);
          await this.updateSessionStatus(s.id, 'completed');
          // For onboarding sessions, also mark the OnboardingSession abandoned
          if (s.id.startsWith('onb_')) {
            await this.updateOnboardingSessionStatus(s.id, 'abandoned').catch(() => {});
          }
          console.log(`[ChatSessionManager] Recovered orphan: ${s.id}`);
        } catch (err) {
          console.warn(`[ChatSessionManager] Failed to recover orphan ${s.id}:`, err);
          // Still mark the API session completed so it doesn't block forever
          await this.updateSessionStatus(s.id, 'completed').catch(() => {});
          if (s.id.startsWith('onb_')) {
            await this.updateOnboardingSessionStatus(s.id, 'abandoned').catch(() => {});
          }
        }
      }
    } catch (err) {
      console.warn('[ChatSessionManager] Orphan recovery failed:', err);
    }
  }

  /**
   * Start the periodic idle-session reaper.
   * Checks every reaperIntervalMs for sessions that have been idle longer than
   * idleTimeoutMs and stops them automatically.
   */
  private startReaper(): void {
    this.reaperTimer = setInterval(async () => {
      const now = Date.now();
      for (const [sessionId, session] of this.activeSessions) {
        // Only evict sessions that are idle (not mid-response)
        if (session.status !== 'ready') continue;
        const idleMs = now - session.lastActivityAt;
        if (idleMs > this.idleTimeoutMs) {
          console.log(
            `[ChatSessionManager] Session ${sessionId} idle for ${Math.round(idleMs / 1000)}s (limit ${Math.round(this.idleTimeoutMs / 1000)}s), stopping`
          );
          try {
            await this.stopSession(sessionId);
          } catch (err) {
            console.error(`[ChatSessionManager] Reaper failed to stop idle session ${sessionId}:`, err);
          }
        }
      }
    }, this.reaperIntervalMs);

    // Don't let the reaper timer prevent Node from exiting
    this.reaperTimer.unref?.();
    console.log(`[ChatSessionManager] Idle reaper started (timeout=${this.idleTimeoutMs}ms, interval=${this.reaperIntervalMs}ms)`);
  }

  /**
   * Stop the idle-session reaper (called during shutdown).
   */
  private stopReaper(): void {
    if (this.reaperTimer) {
      clearInterval(this.reaperTimer);
      this.reaperTimer = null;
      console.log('[ChatSessionManager] Idle reaper stopped');
    }
  }

  /**
   * Subscribe to the command channel for a session.
   * Commands come from the Python API when users send messages.
   */
  private subscribeToCommands(sessionId: string): void {
    const channel = `djinnbot:chat:sessions:${sessionId}:commands`;
    
    // Create a dedicated subscriber for this session
    const subscriber = new Redis(this.redis.options);
    
    // Track for cleanup
    this.commandSubscribers.set(sessionId, subscriber);
    
    subscriber.subscribe(channel, (err) => {
      if (err) {
        console.error(`[ChatSessionManager] Failed to subscribe to ${channel}:`, err);
        return;
      }
      console.log(`[ChatSessionManager] Subscribed to commands for ${sessionId}`);
    });
    
    subscriber.on('message', async (ch, message) => {
      if (ch !== channel) return;
      
      try {
        const cmd = JSON.parse(message);
        console.log(`[ChatSessionManager] Received command for ${sessionId}:`, cmd.type);
        
        if (cmd.type === 'message') {
          await this.sendMessage(sessionId, cmd.content, cmd.model, cmd.message_id, cmd.attachments);
        } else if (cmd.type === 'stop') {
          await this.stopSession(sessionId);
        } else if (cmd.type === 'update_model') {
          this.updateModel(sessionId, cmd.model);
        } else if (cmd.type === 'abort') {
          console.log(`[ChatSessionManager] Abort requested for ${sessionId}`);
          
          // Send abort command to container
          try {
            await this.commandSender.sendAbort(sessionId);
          } catch (err) {
            console.error(`[ChatSessionManager] Failed to send abort:`, err);
          }
          
          // Update session status
          const session = this.activeSessions.get(sessionId);
          if (session) {
            session.status = 'ready';
            session.currentMessageId = undefined;
          }
          
          // Publish abort event to session channel for SSE clients
          this.publishToChannel(sessionId, { type: 'response_aborted', timestamp: Date.now() });
        }
      } catch (err) {
        console.error(`[ChatSessionManager] Error handling command:`, err);
      }
    });
    
    // Store unsubscribe function — does NOT call quit() because stopSession
    // already owns the subscriber lifecycle via commandSubscribers map.
    const session = this.activeSessions.get(sessionId);
    if (session) {
      session.commandSubscription = () => {
        subscriber.unsubscribe(channel).catch(() => {});
        this.commandSubscribers.delete(sessionId);
      };
    }
  }

  /**
   * Publish an event to the session's Redis pub/sub channel AND append it to
   * a capped Redis Stream so late-joining / reconnecting SSE clients can
   * replay events they missed.
   *
   * Pub/sub channel : djinnbot:sessions:{sessionId}          (ephemeral, real-time)
   * Redis Stream key: djinnbot:sessions:{sessionId}:stream   (buffered, replayable)
   *
   * The stream is capped at ~500 entries (MAXLEN ~ 500) and expires after 2 hours.
   * The SSE endpoint reads from the stream with a ?since=<stream-id> cursor on
   * reconnect to replay missed events, then switches to pub/sub for live delivery.
   *
   * Thinking tokens and output chunks are NOT written to the stream (type:
   * 'thinking' and type: 'output') to keep the stream small — they are
   * transient and already accumulated into the final persisted message content.
   * Only structural events (step_start, step_end, turn_end, tool_start,
   * tool_end, container_* status, response_aborted) go into the stream.
   */
  // Set of event types that are structural (replayable via Redis Stream).
  // High-frequency token events (output, thinking) are NOT in this set.
  private static readonly STREAMABLE_TYPES = new Set([
    'step_start', 'step_end', 'turn_end',
    'tool_start', 'tool_end',
    'container_ready', 'container_busy', 'container_idle', 'container_exiting',
    'response_aborted', 'session_complete',
    'session_status', 'session_error',
  ]);

  /**
   * Publish a pre-serialized JSON string to the session's pub/sub channel.
   *
   * For high-frequency token events (output, thinking) the publish is
   * fire-and-forget — ioredis auto-pipelines multiple calls in the same
   * tick into a single TCP write, which is desirable: the frontend's rAF
   * batching is the correct place to debounce rendering, not the server.
   *
   * For structural events the publish is awaited and the event is also
   * appended to a capped Redis Stream for reconnect-replay.
   */
  private publishRaw(sessionId: string, type: string, json: string): void {
    const channel = `djinnbot:sessions:${sessionId}`;

    // All pub/sub publishing goes through the dedicated publishRedis connection
    // so it's never queued behind XADD/EXPIRE/SET on the main connection.

    if (ChatSessionManager.STREAMABLE_TYPES.has(type)) {
      // Structural event — publish + append to replay stream
      this.publishRedis.publish(channel, json).catch(err =>
        console.error(`[ChatSessionManager] Failed to publish to ${channel}:`, err),
      );
      // XADD for replay stream uses publishRedis — the main `this.redis` is
      // shared with blocking XREADGROUP loops and would delay these writes.
      const streamKey = `${channel}:stream`;
      (this.publishRedis as any).xadd(streamKey, 'MAXLEN', '~', '500', '*', 'data', json)
        .then(() => (this.publishRedis as any).expire(streamKey, 7200))
        .catch((err: unknown) => console.error(`[ChatSessionManager] Failed to xadd to ${streamKey}:`, err));
    } else {
      // High-frequency token — fire-and-forget on the dedicated publish connection
      this.publishRedis.publish(channel, json).catch(err =>
        console.error(`[ChatSessionManager] Failed to publish to ${channel}:`, err),
      );
    }
  }

  /**
   * Publish a payload object to the session channel.
   * Convenience wrapper that serializes to JSON then delegates to publishRaw.
   */
  private publishToChannel(sessionId: string, payload: Record<string, unknown>): void {
    const type = (payload.type as string) || '';
    this.publishRaw(sessionId, type, JSON.stringify(payload));
  }

  /**
   * Set up event handlers for a session's container.
   */
  private setupEventHandlers(sessionId: string): void {
    const session = this.activeSessions.get(sessionId);
    if (!session) return;
    
    // Handle streaming output — fire-and-forget publish (no await).
    // ioredis auto-pipelines multiple publishes in the same tick, which is
    // fine: the frontend's rAF batching handles render debouncing.
    this.eventReceiver.onOutput((runId, msg) => {
      if (runId !== sessionId) return;

      // Fire external output hook (e.g. SlackBridge streaming)
      if (msg.type === 'stdout' && msg.data) {
        this.outputHook?.(sessionId, msg.data);
      }

      // Build JSON string directly — avoids an intermediate JS object + JSON.stringify
      // for the highest-frequency event in the system.
      const escaped = JSON.stringify(msg.data);  // handles escaping
      this.publishRaw(
        sessionId,
        'output',
        `{"type":"output","timestamp":${Date.now()},"data":{"content":${escaped}}}`,
      );
    });
    
    // Handle structured events
    this.eventReceiver.onEvent(async (runId, msg) => {
      if (runId !== sessionId) return;
      
      const activeSession = this.activeSessions.get(sessionId);
      
      // Accumulate thinking — high-frequency, use fast path (fire-and-forget)
      if (msg.type === 'thinking' && activeSession) {
        activeSession.accumulatedThinking += msg.thinking;
        const escaped = JSON.stringify(msg.thinking);
        this.publishRaw(
          sessionId,
          'thinking',
          `{"type":"thinking","timestamp":${Date.now()},"data":{"thinking":${escaped}}}`,
        );
        return;  // Skip the generic publishToChannel below
      }
      
      // Track tool calls
      if (msg.type === 'toolStart' && activeSession) {
        activeSession.accumulatedToolCalls.push({
          toolName: msg.toolName,
          args: msg.args,
        });
        // Fire external hook (e.g. SlackBridge streaming)
        this.toolStartHook?.(sessionId, msg.toolName, (msg.args as Record<string, unknown>) ?? {});
      }
      
      if (msg.type === 'toolEnd' && activeSession) {
        const lastTool = activeSession.accumulatedToolCalls[activeSession.accumulatedToolCalls.length - 1];
        if (lastTool) {
          lastTool.result = msg.result;
          lastTool.isError = !msg.success;
          lastTool.durationMs = msg.durationMs;
        }
        // Fire external hook
        this.toolEndHook?.(sessionId, msg.toolName, String(msg.result ?? ''), !msg.success, msg.durationMs ?? 0);
      }
      
      // Normalize event type names (camelCase -> snake_case for frontend)
      const typeMap: Record<string, string> = {
        'toolStart': 'tool_start',
        'toolEnd': 'tool_end',
        'stepStart': 'step_start',
        'stepEnd': 'step_end',
      };
      const normalizedType = typeMap[msg.type] || msg.type;
      
      // Write structured event to channel (and replay stream for structural events)
      this.publishToChannel(sessionId, {
        type: normalizedType,
        timestamp: Date.now(),
        data: msg,
      });
      
      // Handle turn end - update session state
      if (msg.type === 'stepEnd') {
        // Fire external step-end hook (e.g. SlackBridge to finalise streamer)
        this.stepEndHook?.(sessionId, msg.success);

        const resultLen = (msg.result || '').length;
        const thinkingLen = activeSession?.accumulatedThinking?.length ?? 0;
        const toolCount = activeSession?.accumulatedToolCalls?.length ?? 0;
        console.log(
          `[ChatSessionManager] stepEnd ${sessionId}: success=${msg.success}, result=${resultLen} chars, thinking=${thinkingLen} chars, tools=${toolCount}` +
          (resultLen === 0 ? ' ⚠️ EMPTY RESULT' : '')
        );

        // Publish turn_end FIRST so the frontend stops its spinner immediately,
        // before the DB persistence fetch which may take tens of milliseconds.
        this.publishToChannel(sessionId, {
          type: 'turn_end',
          timestamp: Date.now(),
          data: { success: msg.success },
        });

        if (activeSession) {
          activeSession.status = 'ready';
          activeSession.lastActivityAt = Date.now();

          // Add assistant response to history
          if (msg.result) {
            activeSession.conversationHistory.push({
              role: 'assistant',
              content: msg.result,
              timestamp: Date.now(),
            });
          }

          // Complete the assistant message via API — fire-and-forget so we
          // don't block the next user message or hold the event handler open.
          if (activeSession.currentMessageId) {
            const msgId = activeSession.currentMessageId;
            const thinking = activeSession.accumulatedThinking;
            const toolCalls = activeSession.accumulatedToolCalls.length > 0
              ? activeSession.accumulatedToolCalls
              : undefined;
            const result = msg.result || '';

            // Clear accumulators immediately before the async fetch
            activeSession.accumulatedThinking = '';
            activeSession.accumulatedToolCalls = [];
            activeSession.currentMessageId = undefined;

            // Onboarding sessions use a different message model and endpoint.
            // Detect by session ID prefix (onb_<agentId>_<onboardingSessionId>_<ts>).
            const completeUrl = sessionId.startsWith('onb_')
              ? `${this.apiBaseUrl}/v1/onboarding/internal/messages/${msgId}/complete`
              : `${this.apiBaseUrl}/v1/internal/chat/messages/${msgId}/complete`;

            console.log(`[ChatSessionManager] Completing message ${msgId} via ${completeUrl.includes('onboarding') ? 'onboarding' : 'chat'} endpoint (result=${result.length} chars, thinking=${thinking.length} chars, tools=${toolCalls?.length ?? 0})`);

            authFetch(completeUrl, {
              method: 'PATCH',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                content: result,
                thinking: thinking || undefined,
                tool_calls: toolCalls,
              }),
            })
              .then(async (res) => {
                if (!res.ok) {
                  const text = await res.text().catch(() => '');
                  console.error(`[ChatSessionManager] Complete message ${msgId} failed: HTTP ${res.status} ${text}`);
                } else {
                  console.log(`[ChatSessionManager] Completed message ${msgId}`);
                }
              })
              .catch(err => console.error(`[ChatSessionManager] Failed to complete message ${msgId}:`, err));
          } else {
            if (resultLen > 0) {
              console.warn(`[ChatSessionManager] stepEnd ${sessionId}: result has ${resultLen} chars but no currentMessageId — response will NOT be persisted to DB`);
            }
          }
        }
      }
    });
    
    // Handle status changes — forward to stream so the frontend knows when
    // the container is ready, busy, or shutting down.
    this.eventReceiver.onStatus((runId, msg) => {
      if (runId !== sessionId) return;
      
      console.log(`[ChatSessionManager] Container status for ${sessionId}: ${msg.type}`);

      // Forward all container status transitions to the SSE stream
      this.publishToChannel(sessionId, {
        type: `container_${msg.type}`,
        timestamp: Date.now(),
        data: msg,
      });
      
      if (msg.type === 'exiting') {
        // Container is shutting down
        this.activeSessions.delete(sessionId);
      }
    });
  }

  /**
   * Extract the onboarding session ID from a chat session ID.
   * Format: onb_{agentId}_{onboardingSessionId}_{timestamp}
   * The onboardingSessionId starts with "onb_" and may contain underscores.
   */
  private extractOnboardingSessionId(chatSessionId: string): string | null {
    // Format: onb_<agentId>_<onbId>_<ts>
    // agentId has no underscores (e.g. "stas", "jim"), ts is numeric
    // onbId is like "onb_abc123def456" (has one internal underscore)
    const parts = chatSessionId.split('_');
    // parts[0] = "onb", parts[1] = agentId, parts[-1] = timestamp
    // everything in between (parts[2..n-1]) is the onboarding session ID
    if (parts.length < 4 || parts[0] !== 'onb') return null;
    const onbId = parts.slice(2, -1).join('_');
    return onbId || null;
  }

  /**
   * Mark an OnboardingSession as abandoned or completed via the internal API endpoint.
   * Called after stopping an onboarding container so the UI doesn't show it as active.
   *
   * We pass chat_session_id in the request body so the API can guard against
   * overwriting the status when the session has already handed off to a new agent.
   * Without this guard, stopping the old agent's container (post-handoff) would
   * incorrectly mark the onboarding session as abandoned even though the new agent
   * is already running — which drops the SSE connection on the dashboard.
   */
  private async updateOnboardingSessionStatus(chatSessionId: string, status: 'abandoned' | 'completed'): Promise<void> {
    const onboardingSessionId = this.extractOnboardingSessionId(chatSessionId);
    if (!onboardingSessionId) {
      console.warn(`[ChatSessionManager] Could not extract onboarding session ID from ${chatSessionId}`);
      return;
    }
    await authFetch(`${this.apiBaseUrl}/v1/onboarding/internal/sessions/${onboardingSessionId}/status`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ status, chat_session_id: chatSessionId }),
    });
    console.log(`[ChatSessionManager] Marked onboarding session ${onboardingSessionId} as ${status}`);
  }

  /**
   * Ensure a ChatSession row exists in the database for this session.
   *
   * Dashboard / CLI sessions are created via POST /agents/{id}/chat/start
   * before the engine is signaled.  Slack-originated sessions bypass that
   * endpoint and call startSession() directly, so without this call the DB
   * has no record of the session — making orphan recovery impossible after
   * an engine restart.
   *
   * Uses PUT (upsert) so it's safe to call even if the row already exists.
   */
  private async ensureSessionInDb(sessionId: string, agentId: string, model: string): Promise<void> {
    try {
      await authFetch(`${this.apiBaseUrl}/v1/internal/chat/sessions/${sessionId}/ensure`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ agent_id: agentId, model, status: 'starting' }),
      });
    } catch (err) {
      console.warn(`[ChatSessionManager] Failed to ensure session DB row for ${sessionId}:`, err);
      // Non-fatal — the session will still work, just won't be recoverable after restart
    }
  }

  /**
   * Create an admin notification via the API.
   * Non-blocking — failures are logged but do not propagate.
   */
  private createAdminNotification(level: 'info' | 'warning' | 'error', title: string, detail?: string): void {
    authFetch(`${this.apiBaseUrl}/v1/admin/notifications`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ level, title, detail }),
    }).catch(err => {
      console.warn(`[ChatSessionManager] Failed to create admin notification:`, err);
    });
  }

  /**
   * Update session status via API.
   */
  private async updateSessionStatus(sessionId: string, status: string, error?: string): Promise<void> {
    try {
      const body: any = { status };
      if (error) body.error = error;
      
      await authFetch(`${this.apiBaseUrl}/v1/chat/sessions/${sessionId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
    } catch (err) {
      console.error(`[ChatSessionManager] Failed to update session status:`, err);
    }
  }

  /**
   * Update session container info via API.
   */
  private async updateSessionContainer(sessionId: string, containerId: string, status: string): Promise<void> {
    try {
      await authFetch(`${this.apiBaseUrl}/v1/internal/chat/sessions/${sessionId}/container`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ container_id: containerId, status }),
      });
    } catch (err) {
      console.error(`[ChatSessionManager] Failed to update container info:`, err);
    }
  }

  /**
   * Kill orphaned Docker containers whose names match the given prefix.
   *
   * Called on engine startup as a safety net: even if the DB-based orphan
   * recovery runs first, there may be containers that were never registered
   * in the database (e.g. Slack sessions started before the DB-registration
   * fix was deployed).  This catches them at the Docker level.
   *
   * Excludes any sessions that are currently active in this manager.
   */
  async killOrphanedContainersByPrefix(namePrefix: string): Promise<number> {
    const activeIds = new Set(this.activeSessions.keys());
    return this.containerManager.killOrphanedContainersByPrefix(namePrefix, activeIds);
  }

  /**
   * Shutdown - stop all active sessions.
   */
  async shutdown(): Promise<void> {
    this.stopReaper();
    console.log(`[ChatSessionManager] Shutting down ${this.activeSessions.size} sessions`);
    
    const stopPromises = Array.from(this.activeSessions.keys()).map(id => 
      this.stopSession(id).catch(err => 
        console.error(`[ChatSessionManager] Error stopping ${id} on shutdown:`, err)
      )
    );
    
    await Promise.all(stopPromises);
    
    // Clean up any remaining subscribers that weren't properly cleaned
    for (const [sessionId, subscriber] of this.commandSubscribers) {
      console.log(`[ChatSessionManager] Cleaning up leaked subscriber for ${sessionId}`);
      try {
        await subscriber.quit();
      } catch (err) {
        console.error(`[ChatSessionManager] Error cleaning up subscriber ${sessionId}:`, err);
      }
    }
    this.commandSubscribers.clear();
    
    await this.commandRedis.quit();
    await this.publishRedis.quit();
    await this.commandSenderRedis.quit();
    await this.containerManagerRedis.quit();
    
    console.log('[ChatSessionManager] Shutdown complete');
  }
}
