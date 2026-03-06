/**
 * ProcessFlowPanel — execution flow visualizer with Mermaid flowcharts.
 *
 * Features:
 *  - Lists processes grouped by cross-community / intra-community
 *  - Click to open a Mermaid flowchart in a modal
 *  - "Highlight in Graph" toggles process node highlighting on the graph
 *  - Copy Mermaid code for export
 *  - Search/filter processes
 */

import { useState, useMemo, useCallback, useEffect, useRef } from 'react';
import {
  GitBranch, Search, Eye, Zap, Home, ChevronDown, ChevronRight,
  Lightbulb, X, Copy, ZoomIn, ZoomOut, Focus, Check,
} from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import mermaid from 'mermaid';
import type { APIGraphData } from './graph-adapter';

// Initialize mermaid
mermaid.initialize({
  startOnLoad: false,
  theme: 'dark',
  themeVariables: {
    primaryColor: '#1e293b',
    primaryTextColor: '#f1f5f9',
    primaryBorderColor: 'hsl(var(--primary))',
    lineColor: '#64748b',
    secondaryColor: '#1e293b',
    tertiaryColor: '#0f172a',
  },
  flowchart: {
    curve: 'basis',
    padding: 40,
    nodeSpacing: 80,
    rankSpacing: 100,
    htmlLabels: true,
  },
});

interface ProcessInfo {
  id: string;
  label: string;
  processType: string;
  stepCount: number;
}

interface ProcessStep {
  id: string;
  name: string;
  filePath: string;
  step: number;
}

interface ProcessFlowPanelProps {
  graphData: APIGraphData;
  highlightedNodeIds: Set<string>;
  onHighlightNodes: (nodeIds: Set<string>) => void;
  onNodeSelect: (nodeId: string) => void;
}

export function ProcessFlowPanel({
  graphData,
  highlightedNodeIds,
  onHighlightNodes,
  onNodeSelect,
}: ProcessFlowPanelProps) {
  const [searchQuery, setSearchQuery] = useState('');
  const [expandedSections, setExpandedSections] = useState<Set<string>>(new Set(['cross', 'intra']));
  const [focusedProcessId, setFocusedProcessId] = useState<string | null>(null);
  const [viewingProcess, setViewingProcess] = useState<{
    info: ProcessInfo;
    steps: ProcessStep[];
    edges: Array<{ from: string; to: string }>;
  } | null>(null);

  // Extract processes
  const processes = useMemo(() => {
    const cross: ProcessInfo[] = [];
    const intra: ProcessInfo[] = [];

    for (const p of graphData.processes) {
      const item: ProcessInfo = {
        id: p.id,
        label: p.label,
        processType: p.processType,
        stepCount: p.stepCount,
      };
      if (p.processType === 'cross_community') cross.push(item);
      else intra.push(item);
    }

    cross.sort((a, b) => b.stepCount - a.stepCount);
    intra.sort((a, b) => b.stepCount - a.stepCount);
    return { cross, intra };
  }, [graphData]);

  // Filter
  const filtered = useMemo(() => {
    if (!searchQuery.trim()) return processes;
    const q = searchQuery.toLowerCase();
    return {
      cross: processes.cross.filter(p => p.label.toLowerCase().includes(q)),
      intra: processes.intra.filter(p => p.label.toLowerCase().includes(q)),
    };
  }, [processes, searchQuery]);

  const toggleSection = useCallback((s: string) => {
    setExpandedSections(prev => {
      const next = new Set(prev);
      next.has(s) ? next.delete(s) : next.add(s);
      return next;
    });
  }, []);

  // Get process steps from graph data
  const getProcessSteps = useCallback((processId: string): {
    steps: ProcessStep[];
    edges: Array<{ from: string; to: string }>;
  } => {
    const stepEdges = graphData.edges.filter(
      e => e.type === 'STEP_IN_PROCESS' && e.targetId === processId
    );
    const stepNodeIds = new Set(stepEdges.map(e => e.sourceId));
    const steps: ProcessStep[] = stepEdges
      .map(e => {
        const node = graphData.nodes.find(n => n.id === e.sourceId);
        return node ? {
          id: node.id,
          name: node.name,
          filePath: node.filePath,
          step: e.step ?? 0,
        } : null;
      })
      .filter(Boolean) as ProcessStep[];

    steps.sort((a, b) => a.step - b.step);

    // Find CALLS edges between step nodes
    const callEdges = graphData.edges
      .filter(e => e.type === 'CALLS' && stepNodeIds.has(e.sourceId) && stepNodeIds.has(e.targetId))
      .map(e => ({ from: e.sourceId, to: e.targetId }));

    return { steps, edges: callEdges };
  }, [graphData]);

  // Toggle highlight for a process
  const handleToggleFocus = useCallback((processId: string) => {
    if (focusedProcessId === processId) {
      onHighlightNodes(new Set());
      setFocusedProcessId(null);
    } else {
      const { steps } = getProcessSteps(processId);
      onHighlightNodes(new Set(steps.map(s => s.id)));
      setFocusedProcessId(processId);
    }
  }, [focusedProcessId, getProcessSteps, onHighlightNodes]);

  // View process flow
  const handleViewProcess = useCallback((process: ProcessInfo) => {
    const { steps, edges } = getProcessSteps(process.id);
    setViewingProcess({ info: process, steps, edges });
  }, [getProcessSteps]);

  // Clear focus when highlights cleared externally
  useEffect(() => {
    if (highlightedNodeIds.size === 0 && focusedProcessId !== null) {
      setFocusedProcessId(null);
    }
  }, [highlightedNodeIds, focusedProcessId]);

  const totalCount = processes.cross.length + processes.intra.length;

  if (totalCount === 0) {
    return (
      <div className="flex flex-col items-center justify-center h-64 text-center px-4">
        <GitBranch className="w-8 h-8 text-muted-foreground/30 mb-3" />
        <p className="text-sm text-muted-foreground">No execution flows detected</p>
        <p className="text-xs text-muted-foreground/70 mt-1">
          Build the knowledge graph to detect execution flows
        </p>
      </div>
    );
  }

  return (
    <div className="space-y-3">
      {/* Search */}
      <div className="flex items-center gap-2 px-1">
        <div className="flex-1 flex items-center gap-2 px-2.5 py-1.5 rounded-md border bg-background text-sm">
          <Search className="w-3.5 h-3.5 text-muted-foreground" />
          <input
            type="text"
            value={searchQuery}
            onChange={e => setSearchQuery(e.target.value)}
            placeholder="Filter processes..."
            className="flex-1 bg-transparent border-none outline-none text-sm"
          />
        </div>
      </div>

      <div className="text-[11px] text-muted-foreground px-1">
        {totalCount} execution flows detected
      </div>

      {/* Cross-community */}
      {filtered.cross.length > 0 && (
        <ProcessSection
          title="Cross-Community"
          icon={<Zap className="w-3.5 h-3.5 text-amber-400" />}
          processes={filtered.cross}
          expanded={expandedSections.has('cross')}
          onToggle={() => toggleSection('cross')}
          focusedId={focusedProcessId}
          onToggleFocus={handleToggleFocus}
          onView={handleViewProcess}
        />
      )}

      {/* Intra-community */}
      {filtered.intra.length > 0 && (
        <ProcessSection
          title="Intra-Community"
          icon={<Home className="w-3.5 h-3.5 text-emerald-400" />}
          processes={filtered.intra}
          expanded={expandedSections.has('intra')}
          onToggle={() => toggleSection('intra')}
          focusedId={focusedProcessId}
          onToggleFocus={handleToggleFocus}
          onView={handleViewProcess}
        />
      )}

      {/* Flow modal */}
      {viewingProcess && (
        <ProcessFlowModal
          process={viewingProcess}
          onClose={() => setViewingProcess(null)}
          onFocusInGraph={(nodeIds) => {
            onHighlightNodes(new Set(nodeIds));
            setFocusedProcessId(viewingProcess.info.id);
            setViewingProcess(null);
          }}
          onNodeSelect={onNodeSelect}
        />
      )}
    </div>
  );
}

// ── Section ────────────────────────────────────────────────────────────────

function ProcessSection({
  title, icon, processes, expanded, onToggle, focusedId, onToggleFocus, onView,
}: {
  title: string;
  icon: React.ReactNode;
  processes: ProcessInfo[];
  expanded: boolean;
  onToggle: () => void;
  focusedId: string | null;
  onToggleFocus: (id: string) => void;
  onView: (p: ProcessInfo) => void;
}) {
  return (
    <div className="rounded-lg border">
      <button
        onClick={onToggle}
        className="w-full flex items-center gap-2 px-3 py-2 text-left hover:bg-muted/50 transition-colors"
      >
        {expanded ? <ChevronDown className="w-3.5 h-3.5 text-muted-foreground" /> : <ChevronRight className="w-3.5 h-3.5 text-muted-foreground" />}
        {icon}
        <span className="text-sm font-medium">{title}</span>
        <Badge variant="outline" className="ml-auto text-[10px]">{processes.length}</Badge>
      </button>
      {expanded && (
        <div className="pb-1">
          {processes.map(p => (
            <div
              key={p.id}
              className={`flex items-center gap-2 px-3 py-1.5 mx-1 rounded hover:bg-muted/50 group transition-colors ${
                focusedId === p.id ? 'bg-amber-500/10 ring-1 ring-amber-500/30' : ''
              }`}
            >
              <GitBranch className="w-3.5 h-3.5 text-muted-foreground shrink-0" />
              <div className="flex-1 min-w-0">
                <div className="text-xs text-foreground truncate">{p.label}</div>
                <div className="text-[10px] text-muted-foreground">{p.stepCount} steps</div>
              </div>
              <button
                onClick={() => onToggleFocus(p.id)}
                className={`p-1 rounded transition-all ${
                  focusedId === p.id
                    ? 'text-amber-400 bg-amber-500/20'
                    : 'text-muted-foreground opacity-0 group-hover:opacity-100 hover:bg-muted'
                }`}
                title={focusedId === p.id ? 'Remove highlight' : 'Highlight in graph'}
              >
                <Lightbulb className="w-3.5 h-3.5" />
              </button>
              <button
                onClick={() => onView(p)}
                className="flex items-center gap-1 px-2 py-1 text-[10px] font-medium text-primary bg-primary/10 hover:bg-primary/20 rounded opacity-0 group-hover:opacity-100 transition-all"
              >
                <Eye className="w-3 h-3" /> View
              </button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// ── Process Flow Modal ─────────────────────────────────────────────────────

function ProcessFlowModal({
  process,
  onClose,
  onFocusInGraph,
  onNodeSelect,
}: {
  process: { info: ProcessInfo; steps: ProcessStep[]; edges: Array<{ from: string; to: string }> };
  onClose: () => void;
  onFocusInGraph: (nodeIds: string[]) => void;
  onNodeSelect: (nodeId: string) => void;
}) {
  const diagramRef = useRef<HTMLDivElement>(null);
  const [zoom, setZoom] = useState(1);
  const [pan, setPan] = useState({ x: 0, y: 0 });
  const [isPanning, setIsPanning] = useState(false);
  const [panStart, setPanStart] = useState({ x: 0, y: 0 });
  const [copied, setCopied] = useState(false);

  // Generate mermaid code
  const mermaidCode = useMemo(() => {
    const { steps, edges } = process;
    if (steps.length === 0) return 'graph TD\n  empty[No steps detected]';

    const lines: string[] = ['graph TD'];
    const idMap = new Map<string, string>();

    steps.forEach((s, i) => {
      const safeId = `S${i}`;
      idMap.set(s.id, safeId);
      const label = `${s.name}\\n${s.filePath?.split('/').pop() || ''}`;
      lines.push(`  ${safeId}["${label}"]`);
    });

    // Use actual CALLS edges if available
    if (edges.length > 0) {
      for (const e of edges) {
        const from = idMap.get(e.from);
        const to = idMap.get(e.to);
        if (from && to && from !== to) {
          lines.push(`  ${from} --> ${to}`);
        }
      }
    } else {
      // Fallback: linear chain by step order
      for (let i = 0; i < steps.length - 1; i++) {
        const from = idMap.get(steps[i].id);
        const to = idMap.get(steps[i + 1].id);
        if (from && to) lines.push(`  ${from} --> ${to}`);
      }
    }

    return lines.join('\n');
  }, [process]);

  // Render diagram
  useEffect(() => {
    if (!diagramRef.current) return;
    const render = async () => {
      try {
        diagramRef.current!.innerHTML = '';
        const id = `mermaid-${Date.now()}`;
        const { svg } = await mermaid.render(id, mermaidCode);
        diagramRef.current!.innerHTML = svg;
      } catch (err) {
        console.error('Mermaid render error:', err);
        diagramRef.current!.innerHTML = `
          <div class="text-center p-8 text-muted-foreground text-sm">
            Unable to render diagram (${process.steps.length} steps)
          </div>`;
      }
    };
    render();
  }, [mermaidCode, process.steps.length]);

  // Keyboard
  useEffect(() => {
    const handleKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
      if (e.key === '+' || e.key === '=') setZoom(z => Math.min(z + 0.2, 10));
      if (e.key === '-') setZoom(z => Math.max(z - 0.2, 0.1));
    };
    window.addEventListener('keydown', handleKey);
    return () => window.removeEventListener('keydown', handleKey);
  }, [onClose]);

  // Wheel zoom
  useEffect(() => {
    const container = diagramRef.current?.parentElement;
    if (!container) return;
    const handleWheel = (e: WheelEvent) => {
      e.preventDefault();
      setZoom(z => Math.min(Math.max(0.1, z + e.deltaY * -0.001), 10));
    };
    container.addEventListener('wheel', handleWheel, { passive: false });
    return () => container.removeEventListener('wheel', handleWheel);
  }, []);

  const handleCopy = useCallback(async () => {
    await navigator.clipboard.writeText(mermaidCode);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  }, [mermaidCode]);

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 backdrop-blur-sm"
      onClick={e => { if (e.target === e.currentTarget) onClose(); }}
    >
      <div className="w-[90%] max-w-5xl max-h-[85vh] bg-card border rounded-xl shadow-2xl flex flex-col overflow-hidden">
        {/* Header */}
        <div className="flex items-center justify-between px-5 py-3 border-b">
          <div className="flex items-center gap-2">
            <GitBranch className="w-4 h-4 text-primary" />
            <h3 className="text-sm font-semibold">{process.info.label}</h3>
            <Badge variant="outline" className="text-[10px]">
              {process.info.stepCount} steps
            </Badge>
            <Badge variant="outline" className="text-[10px]">
              {process.info.processType.replace('_', ' ')}
            </Badge>
          </div>
          <button onClick={onClose} className="p-1 text-muted-foreground hover:text-foreground rounded">
            <X className="w-4 h-4" />
          </button>
        </div>

        {/* Diagram */}
        <div
          className="flex-1 min-h-[300px] overflow-hidden flex items-center justify-center relative"
          onMouseDown={e => { setIsPanning(true); setPanStart({ x: e.clientX - pan.x, y: e.clientY - pan.y }); }}
          onMouseMove={e => { if (isPanning) setPan({ x: e.clientX - panStart.x, y: e.clientY - panStart.y }); }}
          onMouseUp={() => setIsPanning(false)}
          onMouseLeave={() => setIsPanning(false)}
          style={{ cursor: isPanning ? 'grabbing' : 'grab' }}
        >
          <div
            ref={diagramRef}
            className="transition-transform origin-center w-fit h-fit"
            style={{ transform: `translate(${pan.x}px, ${pan.y}px) scale(${zoom})` }}
          />
        </div>

        {/* Steps list */}
        <div className="border-t max-h-32 overflow-y-auto">
          <div className="px-4 py-2 grid grid-cols-1 sm:grid-cols-2 gap-1">
            {process.steps.map((step, i) => (
              <button
                key={step.id}
                onClick={() => { onNodeSelect(step.id); onClose(); }}
                className="flex items-center gap-2 text-xs py-1 px-2 rounded hover:bg-muted/50 text-left transition-colors"
              >
                <span className="text-muted-foreground w-5 text-right shrink-0">{step.step || i + 1}.</span>
                <span className="font-mono font-medium truncate">{step.name}</span>
                <span className="text-muted-foreground truncate ml-auto text-[10px]">{step.filePath?.split('/').pop()}</span>
              </button>
            ))}
          </div>
        </div>

        {/* Footer */}
        <div className="flex items-center justify-center gap-2 px-4 py-3 border-t bg-muted/20">
          <div className="flex items-center gap-1 border rounded-md p-0.5">
            <button onClick={() => setZoom(z => Math.max(z - 0.25, 0.1))} className="p-1.5 hover:bg-muted rounded">
              <ZoomOut className="w-3.5 h-3.5" />
            </button>
            <span className="text-[11px] text-muted-foreground font-mono w-12 text-center">{Math.round(zoom * 100)}%</span>
            <button onClick={() => setZoom(z => Math.min(z + 0.25, 10))} className="p-1.5 hover:bg-muted rounded">
              <ZoomIn className="w-3.5 h-3.5" />
            </button>
          </div>
          <Button
            size="sm"
            variant="outline"
            onClick={() => { setZoom(1); setPan({ x: 0, y: 0 }); }}
          >
            Reset View
          </Button>
          <Button
            size="sm"
            onClick={() => onFocusInGraph(process.steps.map(s => s.id))}
            className="gap-1"
          >
            <Focus className="w-3.5 h-3.5" /> Highlight in Graph
          </Button>
          <Button
            size="sm"
            variant="secondary"
            onClick={handleCopy}
            className="gap-1"
          >
            {copied ? <Check className="w-3.5 h-3.5" /> : <Copy className="w-3.5 h-3.5" />}
            {copied ? 'Copied!' : 'Copy Mermaid'}
          </Button>
        </div>
      </div>
    </div>
  );
}
