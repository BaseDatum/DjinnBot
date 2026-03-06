/**
 * HtmlPreview — renders self-contained HTML in a sandboxed iframe.
 *
 * Used by the MarkdownRenderer to display `html-preview` code fence blocks
 * produced by the visual-explainer skill. The HTML is rendered via `srcdoc`
 * in a sandbox that allows scripts (for Mermaid, Chart.js, etc.) but blocks
 * navigation away from the page.
 *
 * Features:
 *  - Expand/collapse toggle to resize the preview
 *  - "Open in new tab" button that creates a blob URL
 *  - Respects the user's dark/light theme (CSS media queries in the HTML)
 */

import { useState, useCallback, useRef, useEffect } from 'react';
import { Maximize2, Minimize2, ExternalLink } from 'lucide-react';

interface HtmlPreviewProps {
  html: string;
  /** Default collapsed height in px */
  defaultHeight?: number;
}

export function HtmlPreview({ html, defaultHeight = 420 }: HtmlPreviewProps) {
  const [expanded, setExpanded] = useState(false);
  const iframeRef = useRef<HTMLIFrameElement>(null);
  const [iframeHeight, setIframeHeight] = useState(defaultHeight);

  // When expanded, try to match the iframe's content height
  useEffect(() => {
    if (!expanded) {
      setIframeHeight(defaultHeight);
      return;
    }
    // Give the iframe a moment to render, then measure
    const timer = setTimeout(() => {
      try {
        const doc = iframeRef.current?.contentDocument;
        if (doc?.body) {
          const h = doc.body.scrollHeight;
          setIframeHeight(Math.min(h + 32, window.innerHeight - 80));
        }
      } catch {
        // Cross-origin or sandbox restriction — fall back to large height
        setIframeHeight(Math.min(800, window.innerHeight - 80));
      }
    }, 200);
    return () => clearTimeout(timer);
  }, [expanded, defaultHeight]);

  const handleOpenNewTab = useCallback(() => {
    const blob = new Blob([html], { type: 'text/html' });
    const url = URL.createObjectURL(blob);
    window.open(url, '_blank');
    // Revoke after a delay so the new tab has time to load
    setTimeout(() => URL.revokeObjectURL(url), 5000);
  }, [html]);

  return (
    <div className="relative my-3 rounded-lg border border-border overflow-hidden bg-background">
      {/* Toolbar */}
      <div className="flex items-center justify-between px-3 py-1.5 bg-muted/30 border-b border-border">
        <span className="text-[10px] font-mono text-muted-foreground uppercase tracking-wider font-medium">
          HTML Preview
        </span>
        <div className="flex items-center gap-1">
          <button
            onClick={() => setExpanded(e => !e)}
            className="p-1 rounded hover:bg-accent/20 text-muted-foreground hover:text-foreground transition-colors"
            title={expanded ? 'Collapse' : 'Expand'}
          >
            {expanded ? <Minimize2 className="h-3.5 w-3.5" /> : <Maximize2 className="h-3.5 w-3.5" />}
          </button>
          <button
            onClick={handleOpenNewTab}
            className="p-1 rounded hover:bg-accent/20 text-muted-foreground hover:text-foreground transition-colors"
            title="Open in new tab"
          >
            <ExternalLink className="h-3.5 w-3.5" />
          </button>
        </div>
      </div>

      {/* Sandboxed iframe */}
      <iframe
        ref={iframeRef}
        srcDoc={html}
        sandbox="allow-scripts"
        className="w-full border-0 bg-white dark:bg-zinc-900"
        style={{
          height: iframeHeight,
          transition: 'height 0.2s ease',
        }}
        title="Visual explanation"
      />
    </div>
  );
}
