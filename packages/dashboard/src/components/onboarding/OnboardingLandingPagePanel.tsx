/**
 * OnboardingLandingPagePanel — Left panel showing the evolving landing page.
 *
 * Two states:
 *  1. Placeholder: animated wireframe blocks and "DjinnBot is crafting your
 *     landing page" text. Shown before any agent has called
 *     update_onboarding_landing_page.
 *  2. Live preview: agent-generated HTML rendered inside a sandboxed iframe.
 *     Updates in real time via the ONBOARDING_LANDING_PAGE_UPDATED SSE event.
 */

import { useEffect, useRef, useState, useCallback } from 'react';
import { Globe, ChevronLeft, ChevronRight } from 'lucide-react';

// ── Types ────────────────────────────────────────────────────────────────────

export interface LandingPageState {
  html: string;
  caption?: string | null;
  last_agent_id?: string | null;
  version: number;
}

interface OnboardingLandingPagePanelProps {
  landingPageState: LandingPageState | null;
  collapsed?: boolean;
  onToggleCollapse?: () => void;
}

// ── Animated placeholder ─────────────────────────────────────────────────────

function LandingPagePlaceholder() {
  return (
    <div className="flex flex-col items-center justify-center h-full px-6 select-none">
      {/* Animated SVG: wireframe blocks suggesting a landing page layout */}
      <svg
        viewBox="0 0 180 200"
        className="w-40 h-48 mb-5 opacity-60"
        xmlns="http://www.w3.org/2000/svg"
      >
        {/* Browser chrome */}
        <rect x="10" y="8" width="160" height="184" rx="6" className="fill-none stroke-muted-foreground/30" strokeWidth="1.5">
          <animate attributeName="opacity" values="0.3;0.6;0.3" dur="3s" repeatCount="indefinite" />
        </rect>
        <line x1="10" y1="24" x2="170" y2="24" className="stroke-muted-foreground/20" strokeWidth="1" />
        <circle cx="22" cy="16" r="2.5" className="fill-red-400/40" />
        <circle cx="30" cy="16" r="2.5" className="fill-yellow-400/40" />
        <circle cx="38" cy="16" r="2.5" className="fill-green-400/40" />

        {/* Hero section block */}
        <rect x="30" y="36" width="120" height="8" rx="2" className="fill-primary/20">
          <animate attributeName="opacity" values="0.2;0.5;0.2" dur="2s" repeatCount="indefinite" />
        </rect>
        <rect x="50" y="50" width="80" height="4" rx="1" className="fill-muted-foreground/15">
          <animate attributeName="opacity" values="0.15;0.4;0.15" dur="2s" repeatCount="indefinite" begin="0.3s" />
        </rect>
        <rect x="60" y="60" width="60" height="4" rx="1" className="fill-muted-foreground/15">
          <animate attributeName="opacity" values="0.15;0.4;0.15" dur="2s" repeatCount="indefinite" begin="0.5s" />
        </rect>

        {/* CTA button */}
        <rect x="65" y="72" width="50" height="12" rx="6" className="fill-primary/15 stroke-primary/25" strokeWidth="1">
          <animate attributeName="opacity" values="0.2;0.6;0.2" dur="2.5s" repeatCount="indefinite" begin="0.8s" />
        </rect>

        {/* Feature cards row */}
        <rect x="20" y="96" width="42" height="30" rx="3" className="fill-muted-foreground/10 stroke-muted-foreground/15" strokeWidth="0.75">
          <animate attributeName="opacity" values="0.1;0.4;0.1" dur="2s" repeatCount="indefinite" begin="1s" />
        </rect>
        <rect x="69" y="96" width="42" height="30" rx="3" className="fill-muted-foreground/10 stroke-muted-foreground/15" strokeWidth="0.75">
          <animate attributeName="opacity" values="0.1;0.4;0.1" dur="2s" repeatCount="indefinite" begin="1.3s" />
        </rect>
        <rect x="118" y="96" width="42" height="30" rx="3" className="fill-muted-foreground/10 stroke-muted-foreground/15" strokeWidth="0.75">
          <animate attributeName="opacity" values="0.1;0.4;0.1" dur="2s" repeatCount="indefinite" begin="1.6s" />
        </rect>

        {/* Bottom section lines */}
        <rect x="40" y="140" width="100" height="4" rx="1" className="fill-muted-foreground/10">
          <animate attributeName="opacity" values="0.1;0.3;0.1" dur="2s" repeatCount="indefinite" begin="1.8s" />
        </rect>
        <rect x="55" y="150" width="70" height="4" rx="1" className="fill-muted-foreground/10">
          <animate attributeName="opacity" values="0.1;0.3;0.1" dur="2s" repeatCount="indefinite" begin="2s" />
        </rect>

        {/* Footer */}
        <rect x="30" y="168" width="120" height="3" rx="1" className="fill-muted-foreground/8">
          <animate attributeName="opacity" values="0.08;0.2;0.08" dur="2s" repeatCount="indefinite" begin="2.2s" />
        </rect>
      </svg>

      <p className="text-xs text-muted-foreground text-center leading-relaxed max-w-[200px]">
        <span className="font-medium text-foreground/70">DjinnBot</span> is crafting
        your landing page
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

export function OnboardingLandingPagePanel({
  landingPageState,
  collapsed = false,
  onToggleCollapse,
}: OnboardingLandingPagePanelProps) {
  const iframeRef = useRef<HTMLIFrameElement>(null);
  // Track the last rendered version so we avoid unnecessary re-renders
  const [renderedVersion, setRenderedVersion] = useState(0);

  // Update iframe when landing page changes
  useEffect(() => {
    if (!landingPageState || landingPageState.version === renderedVersion) return;
    setRenderedVersion(landingPageState.version);
  }, [landingPageState, renderedVersion]);

  // Collapse toggle button
  const CollapseBtn = useCallback(
    () => (
      <button
        onClick={onToggleCollapse}
        className="absolute top-3 right-2 z-10 p-1 rounded hover:bg-accent/20 text-muted-foreground hover:text-foreground transition-colors"
        title={collapsed ? 'Show landing page' : 'Hide landing page'}
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
        title="Show landing page preview"
      >
        <Globe className="h-4 w-4 text-muted-foreground mb-1" />
        <span className="text-[9px] text-muted-foreground [writing-mode:vertical-lr] rotate-180 tracking-wider">
          PREVIEW
        </span>
      </div>
    );
  }

  return (
    <div className="relative flex flex-col border-r bg-card/30 w-full shrink-0 min-h-0 h-[60%]">
      {onToggleCollapse && <CollapseBtn />}

      {/* Header */}
      <div className="flex items-center gap-2 px-3 py-2 border-b bg-card/50 shrink-0">
        <Globe className="h-3.5 w-3.5 text-muted-foreground" />
        <span className="text-[10px] font-mono text-muted-foreground uppercase tracking-wider font-medium">
          Landing Page Preview
        </span>
        {landingPageState && (
          <span className="text-[9px] text-muted-foreground/50 ml-auto">
            v{landingPageState.version}
          </span>
        )}
      </div>

      {/* Content */}
      <div className="flex-1 min-h-0 overflow-hidden">
        {!landingPageState ? (
          <LandingPagePlaceholder />
        ) : (
          <iframe
            ref={iframeRef}
            srcDoc={landingPageState.html}
            sandbox="allow-scripts"
            className="w-full h-full border-0 bg-white"
            title="Landing page preview"
            key={landingPageState.version}
          />
        )}
      </div>

      {/* Caption bar (when landing page exists) */}
      {landingPageState?.caption && (
        <div className="px-3 py-1.5 border-t text-[10px] text-muted-foreground italic truncate bg-card/50 shrink-0">
          {landingPageState.caption}
        </div>
      )}
    </div>
  );
}
