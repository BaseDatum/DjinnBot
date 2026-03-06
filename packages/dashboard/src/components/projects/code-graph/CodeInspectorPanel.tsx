/**
 * CodeInspectorPanel — source code viewer that opens when a graph node is clicked.
 *
 * Features:
 *  - Syntax-highlighted code with line numbers (highlight.js via MarkdownRenderer)
 *  - Highlight the selected symbol's line range
 *  - Show symbol connections inline (incoming callers, outgoing calls)
 *  - Resizable panel width
 *  - "Focus in Graph" button to zoom the graph camera to this node
 */

import { useState, useEffect, useRef, useMemo } from 'react';
import {
  X, Code, Target, ChevronRight, Loader2,
  ArrowDownLeft, ArrowUpRight, GitBranch,
} from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import hljs from 'highlight.js';
import 'highlight.js/styles/github-dark.css';
import {
  fetchCodeGraphFileContent,
  fetchCodeGraphContext,
} from '@/lib/api';
import { NODE_COLORS } from './constants';

/** Map server language names to highlight.js aliases */
const HLJS_LANG_MAP: Record<string, string> = {
  typescript: 'typescript', javascript: 'javascript', python: 'python',
  go: 'go', rust: 'rust', java: 'java', c: 'c', cpp: 'cpp',
  csharp: 'csharp', ruby: 'ruby', php: 'php', swift: 'swift',
  kotlin: 'kotlin', scala: 'scala', bash: 'bash', yaml: 'yaml',
  json: 'json', toml: 'ini', markdown: 'markdown', html: 'xml',
  css: 'css', scss: 'scss', sql: 'sql', lua: 'lua', zig: 'cpp',
};

interface SelectedNode {
  id: string;
  name: string;
  label: string;
  filePath: string;
  startLine?: number;
  endLine?: number;
}

interface SymbolContext {
  symbol: { name: string; label: string; filePath: string };
  incoming: {
    calls: Array<{ name: string; filePath: string; confidence: number }>;
    imports: Array<{ name: string; filePath: string }>;
    extends: Array<{ name: string; filePath: string }>;
    implements: Array<{ name: string; filePath: string }>;
  };
  outgoing: {
    calls: Array<{ name: string; filePath: string; confidence: number }>;
    imports: Array<{ name: string; filePath: string }>;
  };
  processes: Array<{
    processId: string;
    processLabel: string;
    step: number;
    totalSteps: number;
  }>;
  community?: { id: string; label: string; cohesion: number };
}

interface CodeInspectorPanelProps {
  projectId: string;
  node: SelectedNode;
  onClose: () => void;
  onFocusNode: (nodeId: string) => void;
  onShowImpact?: (symbolName: string) => void;
}

export function CodeInspectorPanel({
  projectId,
  node,
  onClose,
  onFocusNode,
  onShowImpact,
}: CodeInspectorPanelProps) {
  const [fileContent, setFileContent] = useState<string | null>(null);
  const [detectedLanguage, setDetectedLanguage] = useState('text');
  const [totalLines, setTotalLines] = useState(0);
  const [loadingFile, setLoadingFile] = useState(false);
  const [context, setContext] = useState<SymbolContext | null>(null);
  const [loadingContext, setLoadingContext] = useState(false);
  const [showConnections, setShowConnections] = useState(true);
  const codeContainerRef = useRef<HTMLDivElement>(null);

  // Fetch file content
  useEffect(() => {
    if (!node.filePath) {
      setFileContent(null);
      return;
    }
    setLoadingFile(true);
    fetchCodeGraphFileContent(projectId, node.filePath)
      .then((data) => {
        setFileContent(data.content);
        setDetectedLanguage(data.language);
        setTotalLines(data.lines);
      })
      .catch(() => setFileContent(null))
      .finally(() => setLoadingFile(false));
  }, [projectId, node.filePath]);

  // Fetch symbol context
  useEffect(() => {
    if (!node.name || node.label === 'File' || node.label === 'Folder') {
      setContext(null);
      return;
    }
    setLoadingContext(true);
    fetchCodeGraphContext(projectId, node.name, node.filePath)
      .then((data) => {
        if (data && !data.error) setContext(data);
        else setContext(null);
      })
      .catch(() => setContext(null))
      .finally(() => setLoadingContext(false));
  }, [projectId, node.name, node.filePath, node.label]);

  // Scroll to highlighted line
  useEffect(() => {
    if (!fileContent || !node.startLine || !codeContainerRef.current) return;
    const timer = setTimeout(() => {
      const lineEl = codeContainerRef.current?.querySelector(`[data-line="${node.startLine}"]`);
      if (lineEl) {
        lineEl.scrollIntoView({ behavior: 'smooth', block: 'center' });
      }
    }, 100);
    return () => clearTimeout(timer);
  }, [fileContent, node.startLine]);

  const nodeColor = NODE_COLORS[node.label] || '#9ca3af';
  const startLine = node.startLine ?? 0;
  const endLine = node.endLine ?? startLine;
  const incomingCount = context
    ? (context.incoming?.calls?.length ?? 0) +
      (context.incoming?.imports?.length ?? 0) +
      (context.incoming?.extends?.length ?? 0) +
      (context.incoming?.implements?.length ?? 0)
    : 0;
  const outgoingCount = context
    ? (context.outgoing?.calls?.length ?? 0) +
      (context.outgoing?.imports?.length ?? 0)
    : 0;

  return (
    <div className="h-full flex flex-col bg-background overflow-hidden">
      {/* Header */}
      <div className="flex items-center gap-2 px-3 py-2.5 border-b border-border bg-muted/30">
        <Code className="w-4 h-4 text-primary" />
        <span className="text-sm font-semibold text-foreground truncate flex-1">Code Inspector</span>
        <button
          onClick={onClose}
          className="p-1 text-muted-foreground hover:text-foreground transition-colors rounded"
        >
          <X className="w-4 h-4" />
        </button>
      </div>

      {/* Node info bar */}
      <div className="px-3 py-2 border-b border-border/50 bg-muted/10">
        <div className="flex items-center gap-2">
          <span
            className="px-1.5 py-0.5 rounded text-[10px] font-semibold uppercase"
            style={{ backgroundColor: nodeColor, color: '#fff' }}
          >
            {node.label}
          </span>
          <span className="font-mono text-sm font-medium text-foreground truncate">
            {node.name}
          </span>
        </div>
        <div className="flex items-center gap-3 mt-1 text-[11px] text-muted-foreground">
          <span className="font-mono truncate">{node.filePath}</span>
          {startLine > 0 && (
            <span>L{startLine}{endLine > startLine ? `–${endLine}` : ''}</span>
          )}
          {totalLines > 0 && <span>{totalLines} lines</span>}
        </div>
        <div className="flex items-center gap-1.5 mt-2">
          <button
            onClick={() => onFocusNode(node.id)}
            className="flex items-center gap-1 px-2 py-1 text-[11px] font-medium text-primary bg-primary/10 hover:bg-primary/20 rounded transition-colors"
          >
            <Target className="w-3 h-3" /> Focus in Graph
          </button>
          {onShowImpact && node.label !== 'File' && node.label !== 'Folder' && (
            <button
              onClick={() => onShowImpact(node.name)}
              className="flex items-center gap-1 px-2 py-1 text-[11px] font-medium text-destructive bg-destructive/10 hover:bg-destructive/20 rounded transition-colors"
            >
              <GitBranch className="w-3 h-3" /> Blast Radius
            </button>
          )}
        </div>
      </div>

      {/* Connections summary */}
      {context && (incomingCount > 0 || outgoingCount > 0) && (
        <div className="border-b border-border/50">
          <button
            onClick={() => setShowConnections(p => !p)}
            className="w-full flex items-center gap-2 px-3 py-1.5 text-xs text-muted-foreground hover:bg-muted/50 transition-colors"
          >
            <ChevronRight className={`w-3 h-3 transition-transform ${showConnections ? 'rotate-90' : ''}`} />
            <span className="font-medium">Connections</span>
            <span className="ml-auto flex items-center gap-2">
              {incomingCount > 0 && (
                <span className="flex items-center gap-0.5">
                  <ArrowDownLeft className="w-3 h-3 text-blue-400" />
                  {incomingCount}
                </span>
              )}
              {outgoingCount > 0 && (
                <span className="flex items-center gap-0.5">
                  <ArrowUpRight className="w-3 h-3 text-emerald-400" />
                  {outgoingCount}
                </span>
              )}
            </span>
          </button>
          {showConnections && (
            <div className="px-3 pb-2 space-y-1.5 max-h-40 overflow-y-auto">
              {context.incoming?.calls?.map((c, i) => (
                <ConnectionRow key={`in-call-${i}`} direction="in" type="calls" name={c.name} filePath={c.filePath} />
              ))}
              {context.incoming?.extends?.map((c, i) => (
                <ConnectionRow key={`in-ext-${i}`} direction="in" type="extends" name={c.name} filePath={c.filePath} />
              ))}
              {context.incoming?.implements?.map((c, i) => (
                <ConnectionRow key={`in-impl-${i}`} direction="in" type="implements" name={c.name} filePath={c.filePath} />
              ))}
              {context.outgoing?.calls?.map((c, i) => (
                <ConnectionRow key={`out-call-${i}`} direction="out" type="calls" name={c.name} filePath={c.filePath} />
              ))}
              {context.processes && context.processes.length > 0 && (
                <div className="pt-1 border-t border-border/30">
                  {context.processes.map((p, i) => (
                    <div key={i} className="flex items-center gap-1.5 text-[11px] text-muted-foreground py-0.5">
                      <GitBranch className="w-3 h-3 text-rose-400" />
                      <span className="truncate">{p.processLabel}</span>
                      <span className="ml-auto text-[10px]">step {p.step}/{p.totalSteps}</span>
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}
        </div>
      )}
      {loadingContext && (
        <div className="px-3 py-1.5 border-b border-border/50 flex items-center gap-2 text-xs text-muted-foreground">
          <Loader2 className="w-3 h-3 animate-spin" /> Loading connections...
        </div>
      )}

      {/* Source code viewer with syntax highlighting */}
      <HighlightedCodeViewer
        ref={codeContainerRef}
        content={fileContent}
        language={detectedLanguage}
        loading={loadingFile}
        startLine={startLine}
        endLine={endLine}
        hasFilePath={!!node.filePath}
      />
    </div>
  );
}

/** Syntax-highlighted source code viewer using highlight.js */
import { forwardRef } from 'react';

interface HighlightedCodeViewerProps {
  content: string | null;
  language: string;
  loading: boolean;
  startLine: number;
  endLine: number;
  hasFilePath: boolean;
}

const HighlightedCodeViewer = forwardRef<HTMLDivElement, HighlightedCodeViewerProps>(
  function HighlightedCodeViewer({ content, language, loading, startLine, endLine, hasFilePath }, ref) {
    // Highlight the code using hljs
    const highlightedLines = useMemo(() => {
      if (!content) return [];
      const hljsLang = HLJS_LANG_MAP[language] || language;
      let result: string;
      try {
        if (hljs.getLanguage(hljsLang)) {
          result = hljs.highlight(content, { language: hljsLang }).value;
        } else {
          result = hljs.highlightAuto(content).value;
        }
      } catch {
        result = content.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
      }
      // Split on newlines, preserving the html spans that may wrap across lines
      return result.split('\n');
    }, [content, language]);

    if (loading) {
      return (
        <div ref={ref} className="flex-1 min-h-0 flex items-center justify-center h-32 text-muted-foreground text-sm">
          <Loader2 className="w-4 h-4 animate-spin mr-2" /> Loading source...
        </div>
      );
    }
    if (!content && hasFilePath) {
      return (
        <div ref={ref} className="flex-1 min-h-0 flex items-center justify-center h-32 text-muted-foreground text-sm">
          Unable to load file content
        </div>
      );
    }
    if (!content) {
      return (
        <div ref={ref} className="flex-1 min-h-0 flex items-center justify-center h-32 text-muted-foreground text-sm">
          Select a node with a file path to view source code
        </div>
      );
    }

    return (
      <div ref={ref} className="flex-1 min-h-0 overflow-auto font-mono text-[13px] leading-[1.6]">
        <table className="w-full border-collapse">
          <tbody>
            {highlightedLines.map((lineHtml, idx) => {
              const lineNum = idx + 1;
              const isHighlighted = startLine > 0 && lineNum >= startLine && lineNum <= endLine;
              return (
                <tr
                  key={lineNum}
                  data-line={lineNum}
                  className={isHighlighted ? 'bg-primary/10' : 'hover:bg-muted/30'}
                >
                  <td
                    className="sticky left-0 select-none text-right pr-3 pl-2 text-muted-foreground/50 text-[12px] bg-background"
                    style={{
                      minWidth: '3em',
                      borderRight: isHighlighted ? '3px solid hsl(var(--primary))' : '3px solid transparent',
                    }}
                  >
                    {lineNum}
                  </td>
                  <td
                    className="pr-4 whitespace-pre overflow-hidden hljs"
                    dangerouslySetInnerHTML={{ __html: lineHtml || '&nbsp;' }}
                  />
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    );
  }
);

function ConnectionRow({ direction, type, name, filePath }: {
  direction: 'in' | 'out';
  type: string;
  name: string;
  filePath: string;
}) {
  return (
    <div className="flex items-center gap-1.5 text-[11px] py-0.5">
      {direction === 'in' ? (
        <ArrowDownLeft className="w-3 h-3 text-blue-400 shrink-0" />
      ) : (
        <ArrowUpRight className="w-3 h-3 text-emerald-400 shrink-0" />
      )}
      <Badge variant="outline" className="text-[9px] h-3.5 px-1">{type}</Badge>
      <span className="font-medium text-foreground truncate">{name}</span>
      <span className="text-muted-foreground truncate ml-auto text-[10px]">{filePath?.split('/').pop()}</span>
    </div>
  );
}
