/**
 * OnboardingDiagramPanel — Left panel showing the evolving project diagram.
 *
 * Two states:
 *  1. Placeholder: animated SVG with pulsing nodes/edges and "DjinnBot is
 *     preparing to visualize your project" text. Shown before any agent has
 *     called update_onboarding_diagram.
 *  2. Live diagram: Mermaid rendered inside a sandboxed iframe (same approach
 *     as HtmlPreview — avoids adding mermaid to the dashboard bundle). Updates
 *     in real time via the ONBOARDING_DIAGRAM_UPDATED SSE event.
 */

import { useEffect, useRef, useState, useCallback } from 'react';
import { Layers, ChevronLeft, ChevronRight } from 'lucide-react';

// ── Types ────────────────────────────────────────────────────────────────────

export interface DiagramState {
  mermaid: string;
  caption?: string | null;
  last_agent_id?: string | null;
  version: number;
}

interface OnboardingDiagramPanelProps {
  diagramState: DiagramState | null;
  collapsed?: boolean;
  onToggleCollapse?: () => void;
}

// ── Mermaid iframe template ──────────────────────────────────────────────────

function buildMermaidHtml(mermaidCode: string, caption?: string | null): string {
  // Self-contained HTML that loads Mermaid from CDN and renders the diagram.
  // Uses a mutation observer to detect when Mermaid finishes so we can
  // auto-resize the iframe.
  return `<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8">
<style>
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body {
    background: transparent;
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    min-height: 100vh;
    padding: 16px;
    font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
  }
  #diagram { width: 100%; text-align: center; }
  #diagram svg { max-width: 100%; height: auto; }
  .caption {
    margin-top: 12px;
    font-size: 11px;
    color: #888;
    text-align: center;
    font-style: italic;
  }
  /* Fade-in animation */
  .mermaid { opacity: 0; transition: opacity 0.5s ease; }
  .mermaid[data-processed="true"],
  .mermaid svg { opacity: 1; }

  @media (prefers-color-scheme: dark) {
    body { color: #e0e0e0; }
    .caption { color: #999; }
  }
</style>
</head>
<body>
  <div id="diagram">
    <pre class="mermaid">${mermaidCode.replace(/</g, '&lt;').replace(/>/g, '&gt;')}</pre>
  </div>
  ${caption ? `<div class="caption">${caption.replace(/</g, '&lt;')}</div>` : ''}
  <script type="module">
    import mermaid from 'https://cdn.jsdelivr.net/npm/mermaid@11/dist/mermaid.esm.min.mjs';
    mermaid.initialize({
      startOnLoad: true,
      theme: window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'default',
      flowchart: { curve: 'basis', padding: 15 },
      securityLevel: 'loose',
    });
  </script>
</body>
</html>`;
}

// ── Animated placeholder ─────────────────────────────────────────────────────

function DiagramPlaceholder() {
  return (
    <div className="flex flex-col items-center justify-center h-full px-6 select-none">
      {/* Animated SVG: pulsing nodes connecting with lines */}
      <svg
        viewBox="0 0 200 160"
        className="w-48 h-40 mb-5 opacity-60"
        xmlns="http://www.w3.org/2000/svg"
      >
        {/* Edges (animate dash offset for "drawing" effect) */}
        <line x1="100" y1="30" x2="55" y2="80" className="stroke-muted-foreground/30" strokeWidth="1.5" strokeDasharray="4 4">
          <animate attributeName="stroke-dashoffset" from="8" to="0" dur="1.5s" repeatCount="indefinite" />
        </line>
        <line x1="100" y1="30" x2="145" y2="80" className="stroke-muted-foreground/30" strokeWidth="1.5" strokeDasharray="4 4">
          <animate attributeName="stroke-dashoffset" from="8" to="0" dur="1.5s" repeatCount="indefinite" begin="0.3s" />
        </line>
        <line x1="55" y1="80" x2="80" y2="130" className="stroke-muted-foreground/30" strokeWidth="1.5" strokeDasharray="4 4">
          <animate attributeName="stroke-dashoffset" from="8" to="0" dur="1.5s" repeatCount="indefinite" begin="0.6s" />
        </line>
        <line x1="145" y1="80" x2="120" y2="130" className="stroke-muted-foreground/30" strokeWidth="1.5" strokeDasharray="4 4">
          <animate attributeName="stroke-dashoffset" from="8" to="0" dur="1.5s" repeatCount="indefinite" begin="0.9s" />
        </line>

        {/* Nodes (pulse animation) */}
        <circle cx="100" cy="30" r="8" className="fill-primary/20 stroke-primary/40" strokeWidth="1.5">
          <animate attributeName="r" values="7;9;7" dur="2s" repeatCount="indefinite" />
          <animate attributeName="opacity" values="0.4;0.8;0.4" dur="2s" repeatCount="indefinite" />
        </circle>
        <circle cx="55" cy="80" r="7" className="fill-primary/15 stroke-primary/30" strokeWidth="1.5">
          <animate attributeName="r" values="6;8;6" dur="2s" repeatCount="indefinite" begin="0.5s" />
          <animate attributeName="opacity" values="0.3;0.7;0.3" dur="2s" repeatCount="indefinite" begin="0.5s" />
        </circle>
        <circle cx="145" cy="80" r="7" className="fill-primary/15 stroke-primary/30" strokeWidth="1.5">
          <animate attributeName="r" values="6;8;6" dur="2s" repeatCount="indefinite" begin="1s" />
          <animate attributeName="opacity" values="0.3;0.7;0.3" dur="2s" repeatCount="indefinite" begin="1s" />
        </circle>
        <circle cx="80" cy="130" r="6" className="fill-primary/10 stroke-primary/25" strokeWidth="1.5">
          <animate attributeName="r" values="5;7;5" dur="2s" repeatCount="indefinite" begin="1.5s" />
          <animate attributeName="opacity" values="0.2;0.6;0.2" dur="2s" repeatCount="indefinite" begin="1.5s" />
        </circle>
        <circle cx="120" cy="130" r="6" className="fill-primary/10 stroke-primary/25" strokeWidth="1.5">
          <animate attributeName="r" values="5;7;5" dur="2s" repeatCount="indefinite" begin="0.8s" />
          <animate attributeName="opacity" values="0.2;0.6;0.2" dur="2s" repeatCount="indefinite" begin="0.8s" />
        </circle>
      </svg>

      <p className="text-xs text-muted-foreground text-center leading-relaxed max-w-[200px]">
        <span className="font-medium text-foreground/70">DjinnBot</span> is preparing to
        visualize your project
      </p>
      <div className="flex gap-1 mt-3">
        <span className="h-1.5 w-1.5 rounded-full bg-primary/40 animate-bounce [animation-delay:0ms]" />
        <span className="h-1.5 w-1.5 rounded-full bg-primary/40 animate-bounce [animation-delay:150ms]" />
        <span className="h-1.5 w-1.5 rounded-full bg-primary/40 animate-bounce [animation-delay:300ms]" />
      </div>
    </div>
  );
}

// ── Main component ───────────────────────────────────────────────────────────

export function OnboardingDiagramPanel({
  diagramState,
  collapsed = false,
  onToggleCollapse,
}: OnboardingDiagramPanelProps) {
  const iframeRef = useRef<HTMLIFrameElement>(null);
  // Track the last rendered version so we avoid unnecessary re-renders
  const [renderedVersion, setRenderedVersion] = useState(0);

  // Update iframe when diagram changes
  useEffect(() => {
    if (!diagramState || diagramState.version === renderedVersion) return;
    setRenderedVersion(diagramState.version);
  }, [diagramState, renderedVersion]);

  // Collapse toggle button
  const CollapseBtn = useCallback(
    () => (
      <button
        onClick={onToggleCollapse}
        className="absolute top-3 right-2 z-10 p-1 rounded hover:bg-accent/20 text-muted-foreground hover:text-foreground transition-colors"
        title={collapsed ? 'Show diagram' : 'Hide diagram'}
      >
        {collapsed ? <ChevronRight className="h-3.5 w-3.5" /> : <ChevronLeft className="h-3.5 w-3.5" />}
      </button>
    ),
    [collapsed, onToggleCollapse],
  );

  if (collapsed) {
    return (
      <div className="relative flex flex-col items-center justify-center w-10 border-r bg-card/30 shrink-0 cursor-pointer hover:bg-card/50 transition-colors"
        onClick={onToggleCollapse}
        title="Show diagram panel"
      >
        <Layers className="h-4 w-4 text-muted-foreground mb-1" />
        <span className="text-[9px] text-muted-foreground [writing-mode:vertical-lr] rotate-180 tracking-wider">
          DIAGRAM
        </span>
      </div>
    );
  }

  return (
    <div className="relative flex flex-col border-r bg-card/30 w-full shrink-0 min-h-0 h-[60%]">
      {onToggleCollapse && <CollapseBtn />}

      {/* Header */}
      <div className="flex items-center gap-2 px-3 py-2 border-b bg-card/50 shrink-0">
        <Layers className="h-3.5 w-3.5 text-muted-foreground" />
        <span className="text-[10px] font-mono text-muted-foreground uppercase tracking-wider font-medium">
          Project Diagram
        </span>
        {diagramState && (
          <span className="text-[9px] text-muted-foreground/50 ml-auto">
            v{diagramState.version}
          </span>
        )}
      </div>

      {/* Content */}
      <div className="flex-1 min-h-0 overflow-hidden">
        {!diagramState ? (
          <DiagramPlaceholder />
        ) : (
          <iframe
            ref={iframeRef}
            srcDoc={buildMermaidHtml(diagramState.mermaid, diagramState.caption)}
            sandbox="allow-scripts"
            className="w-full h-full border-0 bg-transparent"
            title="Project diagram"
            key={diagramState.version}
          />
        )}
      </div>

      {/* Caption bar (when diagram exists) */}
      {diagramState?.caption && (
        <div className="px-3 py-1.5 border-t text-[10px] text-muted-foreground italic truncate bg-card/50 shrink-0">
          {diagramState.caption}
        </div>
      )}
    </div>
  );
}
