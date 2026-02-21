---
name: visual-explainer
description: Generate beautiful, self-contained HTML pages that visually explain systems, code changes, plans, and data. Use when the user asks for a diagram, architecture overview, diff review, plan review, comparison table, or any visual explanation of technical concepts. Also use proactively when you are about to render a complex ASCII table (4+ rows or 3+ columns) — present it as a styled HTML page instead.
tags: [diagram, architecture, flowchart, visual, mermaid, chart, table, visualization, explain, overview, schema, dashboard]
enabled: true
---

# Visual Explainer

Generate self-contained HTML files for technical diagrams, visualizations, and data tables. Never fall back to ASCII art when this skill is loaded.

**Proactive table rendering.** When you're about to present tabular data as an ASCII box-drawing table (comparisons, audits, feature matrices, status reports, any structured rows/columns), generate an HTML page instead. The threshold: if the table has 4+ rows or 3+ columns, it belongs in a visual. Don't wait for the user to ask — render it as HTML automatically. You can still include a brief text summary in the chat, but the table itself should be the HTML page.

## Sub-Files

This skill includes reference templates and CSS patterns. Load them with:
- `load_skill("visual-explainer", file="references/css-patterns.md")` — layouts, animations, theming, depth tiers
- `load_skill("visual-explainer", file="references/libraries.md")` — Mermaid theming, Chart.js, anime.js, font pairings
- `load_skill("visual-explainer", file="references/responsive-nav.md")` — sticky sidebar TOC for multi-section pages
- `load_skill("visual-explainer", file="templates/architecture.html")` — CSS Grid cards reference (terracotta/sage palette)
- `load_skill("visual-explainer", file="templates/mermaid-flowchart.html")` — Mermaid + ELK + handDrawn reference (teal/cyan palette)
- `load_skill("visual-explainer", file="templates/data-table.html")` — tables with KPIs and badges reference (rose/cranberry palette)

## Workflow

### 1. Think (5 seconds, not 5 minutes)

Before writing HTML, commit to a direction. Don't default to "dark theme with blue accents" every time.

**Who is looking?** A developer understanding a system? A PM seeing the big picture? A team reviewing a proposal? This shapes information density and visual complexity.

**What type of diagram?** Architecture, flowchart, sequence, data flow, schema/ER, state machine, mind map, data table, timeline, or dashboard. Each has distinct layout needs and rendering approaches (see Diagram Types below).

**What aesthetic?** Pick one and commit:
- Monochrome terminal (green/amber on black, monospace everything)
- Editorial (serif headlines, generous whitespace, muted palette)
- Blueprint (technical drawing feel, grid lines, precise)
- Neon dashboard (saturated accents on deep dark, glowing edges)
- Paper/ink (warm cream background, hand-drawn feel, sketchy borders)
- Hand-drawn / sketch (Mermaid `handDrawn` mode, wiggly lines, informal whiteboard feel)
- IDE-inspired (borrow a real color scheme: Dracula, Nord, Catppuccin, Solarized, Gruvbox, One Dark)
- Data-dense (small type, tight spacing, maximum information)
- Gradient mesh (bold gradients, glassmorphism, modern SaaS feel)

Vary the choice each time. If the last diagram was dark and technical, make the next one light and editorial.

### 2. Structure

**Read the reference template** before generating. Don't memorize it — read it each time to absorb the patterns.
- For text-heavy architecture overviews: `load_skill("visual-explainer", file="templates/architecture.html")`
- For flowcharts, sequence diagrams, ER, state machines, mind maps: `load_skill("visual-explainer", file="templates/mermaid-flowchart.html")`
- For data tables, comparisons, audits, feature matrices: `load_skill("visual-explainer", file="templates/data-table.html")`

**For CSS/layout patterns and SVG connectors**, load `load_skill("visual-explainer", file="references/css-patterns.md")`.

**For pages with 4+ sections** (reviews, recaps, dashboards), also load `load_skill("visual-explainer", file="references/responsive-nav.md")` for section navigation.

**Choosing a rendering approach:**

| Diagram type | Approach | Why |
|---|---|---|
| Architecture (text-heavy) | CSS Grid cards + flow arrows | Rich card content needs CSS control |
| Architecture (topology) | **Mermaid** | Connections need automatic edge routing |
| Flowchart / pipeline | **Mermaid** | Automatic node positioning and edge routing |
| Sequence diagram | **Mermaid** | Lifelines, messages, activation boxes |
| Data flow | **Mermaid** with edge labels | Connections need automatic edge routing |
| ER / schema diagram | **Mermaid** | Relationship lines need auto-routing |
| State machine | **Mermaid** | State transitions with labeled edges |
| Mind map | **Mermaid** | Hierarchical branching |
| Data table | HTML `<table>` | Semantic markup, accessibility, copy-paste |
| Timeline | CSS (central line + cards) | Simple linear layout |
| Dashboard | CSS Grid + Chart.js | Card grid with embedded charts |

**Mermaid theming:** Always use `theme: 'base'` with custom `themeVariables`. Use `look: 'handDrawn'` for sketch aesthetic or `look: 'classic'` for clean lines. Use `layout: 'elk'` for complex graphs. See `references/libraries.md` for full theming guide.

**Mermaid zoom controls:** Always add zoom controls (+/−/reset buttons) to every `.mermaid-wrap` container. See the zoom controls pattern in `references/css-patterns.md`.

### 3. Style

Apply these principles to every diagram:

**Typography is the diagram.** Pick a distinctive font pairing from Google Fonts. A display/heading font with character, plus a mono font for technical labels. Never use Inter, Roboto, Arial, or system-ui as the primary font.

**Color tells a story.** Use CSS custom properties for the full palette. Define at minimum: `--bg`, `--surface`, `--border`, `--text`, `--text-dim`, and 3-5 accent colors. Support both themes:

```css
/* Light-first: */
:root { /* light values */ }
@media (prefers-color-scheme: dark) { :root { /* dark values */ } }

/* Dark-first: */
:root { /* dark values */ }
@media (prefers-color-scheme: light) { :root { /* light values */ } }
```

**Surfaces whisper, they don't shout.** Build depth through subtle lightness shifts (2-4% between levels).

**Backgrounds create atmosphere.** Subtle gradients, faint grid patterns, or gentle radial glows.

**Visual weight signals importance.** Executive summaries should dominate; reference sections should be compact. Use `<details>/<summary>` for lower-priority content.

**Surface depth creates hierarchy.** Hero sections get elevated shadows; body content stays flat; code blocks feel recessed. See depth tiers in `references/css-patterns.md`.

**Animation earns its place.** Staggered fade-ins on page load. Mix animation types by role: `fadeUp` for cards, `fadeScale` for KPIs, `drawIn` for SVG connectors. Always respect `prefers-reduced-motion`.

### 4. Deliver

Output depends on your session context. Check your system prompt's "Session Context" section.

#### Dashboard Chat / Pipeline Sessions

Return the complete HTML document in your response inside a fenced code block tagged `html-preview`:

````
Here's a visual overview of the authentication flow:

```html-preview
<!DOCTYPE html>
<html lang="en">
<head>...</head>
<body>...</body>
</html>
```
````

**Always include a brief text summary** before the HTML block explaining what the visualization shows. The dashboard renders the HTML inline as an interactive preview.

#### Slack Sessions

Slack cannot render HTML inline. Use this approach:

1. **Generate the HTML** the same way as for dashboard chat.
2. **Write it to a temporary file** in your workspace:
   ```bash
   cat > /tmp/diagram.html << 'HTMLEOF'
   <!DOCTYPE html>
   <html>...</html>
   HTMLEOF
   ```
3. **Use Playwright to screenshot it:**
   ```bash
   node -e "
   const { chromium } = require('playwright');
   (async () => {
     const browser = await chromium.launch();
     const page = await browser.newPage({ viewport: { width: 1200, height: 800 } });
     await page.goto('file:///tmp/diagram.html');
     await page.waitForTimeout(1000);
     await page.screenshot({ path: '/home/agent/run-workspace/diagram.png', fullPage: true });
     await browser.close();
   })();
   "
   ```
4. **Share the screenshot path** in your response and offer to explain any section in more detail.
5. **Also include a Mermaid code block** (` ```mermaid `) if the diagram uses Mermaid, so the user has a text-based version.

For simple diagrams, you can skip the HTML and just provide a Mermaid code block or a well-formatted markdown table directly.

## Diagram Types

### Architecture / System Diagrams
**Text-heavy overviews** (card content matters more than connections): CSS Grid. Load `templates/architecture.html` for the pattern.

**Topology-focused** (connections matter more): **Use Mermaid.** `graph TD` or `graph LR` with custom `themeVariables`. Load `templates/mermaid-flowchart.html`.

### Flowcharts / Pipelines
**Use Mermaid.** `graph TD` for top-down or `graph LR` for left-right. Use `look: 'handDrawn'` for sketch aesthetic.

### Sequence Diagrams
**Use Mermaid.** `sequenceDiagram` syntax. Style actors and messages via CSS overrides.

### Data Flow Diagrams
**Use Mermaid.** `graph LR` or `graph TD` with edge labels for data descriptions.

### Schema / ER Diagrams
**Use Mermaid.** `erDiagram` syntax with entity attributes.

### State Machines / Decision Trees
**Use Mermaid.** `stateDiagram-v2` for states with labeled transitions.

**`stateDiagram-v2` label caveat:** Transition labels have a strict parser — colons, parentheses, `<br/>`, HTML entities cause silent parse failures. If labels need special characters, use `flowchart LR` instead with rounded nodes and quoted edge labels.

### Mind Maps
**Use Mermaid.** `mindmap` syntax for hierarchical branching.

### Data Tables / Comparisons / Audits
Use a real `<table>` element. Load `templates/data-table.html` for the pattern.

**Use proactively.** Any time you'd render an ASCII table, generate HTML instead. This includes: requirement audits, feature comparisons, status reports, configuration matrices, test summaries, dependency lists, API inventories.

### Timeline / Roadmap Views
Vertical or horizontal timeline with CSS pseudo-elements. Color progression from past (muted) to future (vivid).

### Dashboard / Metrics Overview
Card grid layout with Chart.js for real charts. KPI cards with trend indicators.

## File Structure

Every diagram is a single self-contained `.html` file. No external assets except CDN links (fonts, optional libraries).

```html
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Descriptive Title</title>
  <link href="https://fonts.googleapis.com/css2?family=...&display=swap" rel="stylesheet">
  <style>/* All CSS inline */</style>
</head>
<body>
  <!-- Semantic HTML -->
  <!-- Optional: <script> for Mermaid, Chart.js, or anime.js -->
</body>
</html>
```

## Quality Checks

Before delivering, verify:
- **The squint test**: Can you still perceive hierarchy with blurred eyes?
- **The swap test**: Would replacing your fonts/colors with a generic dark theme make this indistinguishable?
- **Both themes**: Both light and dark should look intentional.
- **Information completeness**: Does the diagram convey what was asked for?
- **No overflow**: Resize-safe. Every grid/flex child needs `min-width: 0`.
- **Mermaid zoom controls**: Every `.mermaid-wrap` must have +/−/reset buttons and Ctrl/Cmd+scroll zoom.
