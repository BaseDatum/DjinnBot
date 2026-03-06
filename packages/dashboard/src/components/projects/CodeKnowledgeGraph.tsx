/**
 * CodeKnowledgeGraph — full-featured code exploration UI.
 *
 * Layout (when indexed):
 *   [FileTree] | [Graph Canvas] | [Code Inspector / Processes / Blast Radius]
 *
 * Features:
 *   P0: Code Inspector Panel — click a node → see source code with line highlighting
 *   P0: AI Chat hint — banner telling users they can chat with the agent about the code graph
 *   P1: Process Flow Mermaid Diagrams — visual execution flow charts
 *   P1: Blast Radius Visualization — impact analysis with depth-coloured graph highlights
 *   P2: File Tree Sidebar — navigable tree that highlights nodes + connections
 */

import { useState, useEffect, useCallback, useRef } from 'react';
import { Group as PanelGroup, Panel, Separator as PanelResizeHandle } from 'react-resizable-panels';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Skeleton } from '@/components/ui/skeleton';
import {
  RefreshCw, Brain, AlertTriangle, CheckCircle2, Clock,
  Search, MessageSquare, Workflow, GitBranch, GripVertical,
} from 'lucide-react';
import {
  fetchCodeGraphStatus,
  triggerCodeGraphIndex,
  pollCodeGraphIndexProgress,
  fetchCodeGraphSearch,
  fetchCodeGraphData,
} from '@/lib/api';
import { CodeGraphCanvas } from './code-graph/CodeGraphCanvas';
import { CodeInspectorPanel } from './code-graph/CodeInspectorPanel';
import { FileTreePanel } from './code-graph/FileTreePanel';
import { ProcessFlowPanel } from './code-graph/ProcessFlowPanel';
import { BlastRadiusOverlay } from './code-graph/BlastRadiusOverlay';
import type { APIGraphData } from './code-graph/graph-adapter';

interface CodeKnowledgeGraphProps {
  projectId: string;
}

interface GraphStatus {
  indexed: boolean;
  stale: boolean;
  is_git: boolean;
  node_count: number;
  relationship_count: number;
  community_count: number;
  process_count: number;
  last_indexed_at: number | null;
  status: string;
  error: string | null;
}

type RightPanelTab = 'inspector' | 'processes';

export function CodeKnowledgeGraph({ projectId }: CodeKnowledgeGraphProps) {
  // ── Core state ──────────────────────────────────────────────────────
  const [status, setStatus] = useState<GraphStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [indexing, setIndexing] = useState(false);
  const [indexProgress, setIndexProgress] = useState<{
    phase: string; percent: number; message: string;
  } | null>(null);
  const [indexError, setIndexError] = useState<string | null>(null);
  const [graphData, setGraphData] = useState<APIGraphData | null>(null);
  const [graphFullscreen, setGraphFullscreen] = useState(false);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  // ── Selection state ─────────────────────────────────────────────────
  const [selectedGraphNode, setSelectedGraphNode] = useState<{
    id: string; name: string; label: string; filePath: string; startLine?: number;
  } | null>(null);
  const [rightPanelTab, setRightPanelTab] = useState<RightPanelTab>('inspector');
  const [showInspector, setShowInspector] = useState(false);

  // ── Package selector (shared between graph & file tree) ─────────────
  const [selectedPackage, setSelectedPackage] = useState<string | null>(null);

  // ── Highlight state ─────────────────────────────────────────────────
  const [highlightedNodeIds, setHighlightedNodeIds] = useState<Set<string>>(new Set());
  const [blastRadiusMap, setBlastRadiusMap] = useState<Map<string, number>>(new Map());
  const [blastRadiusTarget, setBlastRadiusTarget] = useState<string | null>(null);

  // ── Graph focus function ref ────────────────────────────────────────
  const focusNodeFnRef = useRef<((nodeId: string) => void) | null>(null);

  // ── Search state ────────────────────────────────────────────────────
  const [searchQuery, setSearchQuery] = useState('');
  const [searchResults, setSearchResults] = useState<any[]>([]);
  const [, setSearching] = useState(false);

  // ── Data loading ────────────────────────────────────────────────────
  const loadStatus = useCallback(async () => {
    try {
      const s = await fetchCodeGraphStatus(projectId);
      setStatus(s);
      if (s.indexed) {
        const gData = await fetchCodeGraphData(projectId);
        setGraphData(gData as APIGraphData);
      }
    } catch (err) {
      console.error('Failed to load knowledge graph status:', err);
    } finally {
      setLoading(false);
    }
  }, [projectId]);

  useEffect(() => {
    loadStatus();
    return () => { if (pollRef.current) clearInterval(pollRef.current); };
  }, [loadStatus]);

  // ESC to exit fullscreen
  useEffect(() => {
    if (!graphFullscreen) return;
    const h = (e: KeyboardEvent) => { if (e.key === 'Escape') setGraphFullscreen(false); };
    window.addEventListener('keydown', h);
    return () => window.removeEventListener('keydown', h);
  }, [graphFullscreen]);

  // ── Indexing ────────────────────────────────────────────────────────
  const handleIndex = async () => {
    setIndexing(true);
    setIndexError(null);
    setIndexProgress({ phase: 'starting', percent: 0, message: 'Starting...' });
    try {
      const { job_id } = await triggerCodeGraphIndex(projectId);
      pollRef.current = setInterval(async () => {
        try {
          const progress = await pollCodeGraphIndexProgress(projectId, job_id);
          setIndexProgress({
            phase: progress.phase || 'indexing',
            percent: progress.percent || 0,
            message: progress.message || 'Indexing...',
          });
          if (progress.status === 'completed' || progress.status === 'failed') {
            if (pollRef.current) clearInterval(pollRef.current);
            setIndexing(false);
            setIndexProgress(null);
            if (progress.status === 'failed') setIndexError(progress.message || 'Indexing failed');
            await loadStatus();
          }
        } catch (err) {
          if (pollRef.current) clearInterval(pollRef.current);
          setIndexing(false);
          setIndexProgress(null);
          setIndexError(err instanceof Error ? err.message : 'Failed to track indexing progress');
        }
      }, 2000);
    } catch (err) {
      setIndexing(false);
      setIndexProgress(null);
      setIndexError(err instanceof Error ? err.message : 'Failed to start indexing');
    }
  };

  // ── Search ──────────────────────────────────────────────────────────
  const handleSearch = async () => {
    if (!searchQuery.trim()) return;
    setSearching(true);
    try {
      const data = await fetchCodeGraphSearch(projectId, searchQuery);
      setSearchResults(data.results || []);
    } catch { setSearchResults([]); }
    finally { setSearching(false); }
  };

  // ── Node selection handlers ─────────────────────────────────────────
  const handleNodeSelect = useCallback((node: typeof selectedGraphNode) => {
    setSelectedGraphNode(node);
    if (node) {
      setShowInspector(true);
      setRightPanelTab('inspector');
      // Clear file-tree/process highlights when user clicks a different node on the graph
      setHighlightedNodeIds(new Set());
    }
  }, []);

  const handleNodeSelectById = useCallback((nodeId: string) => {
    if (!graphData) return;
    const n = graphData.nodes.find(n => n.id === nodeId);
    if (n) {
      handleNodeSelect({ id: n.id, name: n.name, label: n.label, filePath: n.filePath, startLine: n.startLine });
      focusNodeFnRef.current?.(nodeId);
    }
  }, [graphData, handleNodeSelect]);

  // ── File tree selection → highlight node + direct connections ───────
  const handleFileTreeSelect = useCallback((nodeId: string, _filePath: string) => {
    if (!graphData) return;
    // Find all direct connections of this file node
    const connected = new Set<string>([nodeId]);
    for (const edge of graphData.edges) {
      if (edge.sourceId === nodeId) connected.add(edge.targetId);
      if (edge.targetId === nodeId) connected.add(edge.sourceId);
    }
    setHighlightedNodeIds(connected);
    // Also select the node (this may open the inspector panel, resizing the graph container)
    const n = graphData.nodes.find(n => n.id === nodeId);
    if (n) {
      handleNodeSelect({ id: n.id, name: n.name, label: n.label, filePath: n.filePath, startLine: n.startLine });
    }
    // Delay focusNode so the panel resize + Sigma's ResizeObserver can
    // settle first — otherwise viewportToFramedGraph uses stale dimensions.
    requestAnimationFrame(() => {
      focusNodeFnRef.current?.(nodeId);
    });
  }, [graphData, handleNodeSelect]);

  // ── Blast radius ────────────────────────────────────────────────────
  const handleShowImpact = useCallback((symbolName: string) => {
    setBlastRadiusTarget(symbolName);
    setBlastRadiusMap(new Map());
  }, []);

  const handleImpactHighlight = useCallback((map: Map<string, number>) => {
    setBlastRadiusMap(map);
    // Clear other highlights when blast radius active
    if (map.size > 0) setHighlightedNodeIds(new Set());
  }, []);

  // ── Helpers ─────────────────────────────────────────────────────────
  const formatTimeAgo = (ts: number) => {
    const diff = Date.now() - ts;
    const mins = Math.floor(diff / 60000);
    if (mins < 60) return `${mins}m ago`;
    const hrs = Math.floor(mins / 60);
    if (hrs < 24) return `${hrs}h ago`;
    return `${Math.floor(hrs / 24)}d ago`;
  };

  // ── Loading state ───────────────────────────────────────────────────
  if (loading) {
    return (
      <div className="p-4 md:px-6 space-y-4 max-w-6xl mx-auto">
        <Skeleton height={40} />
        <Skeleton height={400} />
      </div>
    );
  }

  // ── Render ──────────────────────────────────────────────────────────
  return (
    <div className={graphFullscreen ? 'flex flex-col h-screen' : 'flex flex-col h-full min-h-0'}>
      {/* Header */}
      <div className="shrink-0 flex items-center justify-between gap-4 px-4 md:px-6 py-3 border-b">
        <div className="flex items-center gap-3">
          <Brain className="h-5 w-5 text-primary" />
          <h2 className="text-lg font-semibold">Code Knowledge Graph</h2>
          {status?.indexed && (
            <Badge variant="outline" className="text-xs gap-1">
              <CheckCircle2 className="h-3 w-3 text-green-500" />
              {status.node_count} symbols
            </Badge>
          )}
          {status?.stale && (
            <Badge variant="outline" className="text-xs text-amber-600 border-amber-500/30 bg-amber-500/5 gap-1">
              <AlertTriangle className="h-3 w-3" /> Stale
            </Badge>
          )}
          {status?.indexed && status.last_indexed_at && (
            <span className="text-[11px] text-muted-foreground flex items-center gap-1">
              <Clock className="h-3 w-3" />
              {formatTimeAgo(status.last_indexed_at)}
            </span>
          )}
        </div>
        <div className="flex items-center gap-2">
          {/* Search */}
          {status?.indexed && (
            <div className="flex items-center gap-1.5">
              <div className="relative">
                <Search className="absolute left-2 top-2 h-3.5 w-3.5 text-muted-foreground" />
                <input
                  type="text"
                  value={searchQuery}
                  onChange={e => setSearchQuery(e.target.value)}
                  onKeyDown={e => e.key === 'Enter' && handleSearch()}
                  placeholder="Search symbols..."
                  className="w-48 pl-7 pr-2 py-1.5 rounded-md border bg-background text-xs"
                />
              </div>
            </div>
          )}
          <Button
            size="sm"
            onClick={handleIndex}
            disabled={indexing || status?.status === 'indexing'}
            className="gap-1.5"
          >
            <RefreshCw className={`h-3.5 w-3.5 ${indexing ? 'animate-spin' : ''}`} />
            {indexing ? 'Indexing...' : status?.indexed ? 'Update' : 'Build'}
          </Button>
        </div>
      </div>

      {/* Indexing Progress */}
      {indexProgress && (
        <div className="shrink-0 mx-4 md:mx-6 mt-3 rounded-lg border border-primary/20 bg-primary/5 p-3 space-y-2">
          <div className="flex items-center justify-between text-sm">
            <span>{indexProgress.message}</span>
            <span className="text-muted-foreground">{indexProgress.percent}%</span>
          </div>
          <div className="w-full bg-muted rounded-full h-1.5">
            <div className="bg-primary h-1.5 rounded-full transition-all" style={{ width: `${indexProgress.percent}%` }} />
          </div>
        </div>
      )}

      {/* Errors */}
      {(status?.error || indexError) && (
        <div className="shrink-0 mx-4 md:mx-6 mt-3 rounded-lg border border-destructive/30 bg-destructive/5 p-3 flex items-start gap-2">
          <AlertTriangle className="h-4 w-4 text-destructive shrink-0 mt-0.5" />
          <div className="text-sm text-destructive">{indexError || status?.error}</div>
        </div>
      )}

      {/* Not indexed */}
      {!status?.indexed && !indexing && (
        <div className="text-center py-16 text-muted-foreground space-y-2">
          <Brain className="h-12 w-12 mx-auto opacity-30" />
          <p className="text-sm">No knowledge graph built yet</p>
          <p className="text-xs max-w-md mx-auto">
            Click "Build" to index this codebase. The graph maps every function,
            class, and their relationships — enabling blast radius analysis,
            execution flow tracing, and AI-powered code understanding.
          </p>
        </div>
      )}

      {/* ── Main content when indexed ────────────────────────────────── */}
      {status?.indexed && graphData && graphData.nodes.length > 0 && (
        <>
          {/* AI Chat hint */}
          <div className="shrink-0 mx-4 md:mx-6 mt-3 flex items-center gap-2 px-3 py-2 rounded-lg border border-primary/20 bg-primary/5 text-xs">
            <MessageSquare className="w-4 h-4 text-primary shrink-0" />
            <span className="text-muted-foreground">
              Your project agent can explore this knowledge graph.
              Open the <span className="font-medium text-foreground">Chat</span> and ask about
              architecture, dependencies, or blast radius using the <code className="font-mono text-primary">code_graph_*</code> tools.
            </span>
          </div>

          {/* Three-pane layout with resizable panels */}
          <div className="flex flex-1 min-h-0 mt-3">
            {/* Left: File Tree */}
            <FileTreePanel
              nodes={graphData.nodes}
              packagePrefix={selectedPackage}
              onFileSelect={handleFileTreeSelect}
              selectedFilePath={selectedGraphNode?.filePath ?? null}
            />

            {/* Center + Right: resizable panel group */}
            <PanelGroup orientation="horizontal" className="flex-1 min-w-0">
              {/* Center: Graph Canvas */}
              <Panel defaultSize={showInspector ? 60 : 100} minSize={30}>
                <div className="w-full h-full relative">
                  <CodeGraphCanvas
                    graphData={graphData}
                    onNodeSelect={handleNodeSelect}
                    isFullscreen={graphFullscreen}
                    onToggleFullscreen={() => setGraphFullscreen(f => !f)}
                    highlightedNodeIds={highlightedNodeIds}
                    blastRadiusMap={blastRadiusMap}
                    onFocusNodeRef={fn => { focusNodeFnRef.current = fn; }}
                    selectedPackage={selectedPackage}
                    onSelectedPackageChange={setSelectedPackage}
                    onStageClick={() => {
                      setHighlightedNodeIds(new Set());
                      setBlastRadiusMap(new Map());
                      setBlastRadiusTarget(null);
                    }}
                  />

                  {/* Search results overlay */}
                  {searchResults.length > 0 && (
                    <div className="absolute top-12 left-3 z-20 w-72 max-h-64 overflow-y-auto rounded-lg border bg-background/95 backdrop-blur-sm p-2 space-y-0.5">
                      <div className="flex items-center justify-between px-1 pb-1">
                        <span className="text-xs font-medium">{searchResults.length} results</span>
                        <button onClick={() => setSearchResults([])} className="text-[10px] text-muted-foreground hover:text-foreground">Clear</button>
                      </div>
                      {searchResults.map((r: any, i: number) => (
                        <button
                          key={i}
                          className="w-full flex items-center gap-1.5 text-xs py-1 px-1.5 rounded hover:bg-muted text-left"
                          onClick={() => {
                            handleNodeSelect({ id: r.nodeId || '', name: r.name, label: r.label, filePath: r.filePath, startLine: r.startLine });
                            if (r.nodeId) focusNodeFnRef.current?.(r.nodeId);
                            setSearchResults([]);
                          }}
                        >
                          <Badge variant="outline" className="text-[9px] h-3.5 px-1">{r.label}</Badge>
                          <span className="font-mono truncate">{r.name}</span>
                        </button>
                      ))}
                    </div>
                  )}
                </div>
              </Panel>

              {/* Right panel: Inspector / Processes (resizable) */}
              {showInspector && (
                <>
                  <PanelResizeHandle className="w-1.5 bg-border/50 hover:bg-primary/30 active:bg-primary/50 transition-colors cursor-col-resize flex items-center justify-center">
                    <GripVertical className="w-3 h-3 text-muted-foreground/50" />
                  </PanelResizeHandle>
                  <Panel defaultSize={40} minSize={20}>
                    <div className="flex flex-col h-full bg-background overflow-hidden">
                      {/* Tab bar */}
                      <div className="flex items-center gap-1 px-2 py-1.5 border-b border-border bg-muted/20 shrink-0">
                        <button
                          onClick={() => setRightPanelTab('inspector')}
                          className={`flex items-center gap-1 px-2.5 py-1 rounded text-xs font-medium transition-colors ${
                            rightPanelTab === 'inspector' ? 'bg-primary/10 text-primary' : 'text-muted-foreground hover:text-foreground'
                          }`}
                        >
                          <Search className="w-3 h-3" /> Inspector
                        </button>
                        <button
                          onClick={() => setRightPanelTab('processes')}
                          className={`flex items-center gap-1 px-2.5 py-1 rounded text-xs font-medium transition-colors ${
                            rightPanelTab === 'processes' ? 'bg-primary/10 text-primary' : 'text-muted-foreground hover:text-foreground'
                          }`}
                        >
                          <Workflow className="w-3 h-3" /> Flows
                          <Badge variant="outline" className="text-[9px] h-3.5 px-1 ml-0.5">
                            {graphData.processes.length}
                          </Badge>
                        </button>
                        <button
                          onClick={() => setShowInspector(false)}
                          className="ml-auto p-1 text-muted-foreground hover:text-foreground rounded"
                        >
                          &times;
                        </button>
                      </div>

                      {/* Blast Radius */}
                      {blastRadiusTarget && (
                        <div className="p-2 border-b shrink-0">
                          <BlastRadiusOverlay
                            projectId={projectId}
                            symbolName={blastRadiusTarget}
                            onClose={() => { setBlastRadiusTarget(null); setBlastRadiusMap(new Map()); }}
                            onHighlightImpact={handleImpactHighlight}
                            onNodeSelect={handleNodeSelectById}
                          />
                        </div>
                      )}

                      {/* Tab content */}
                      <div className="flex-1 min-h-0 overflow-hidden">
                        {rightPanelTab === 'inspector' && selectedGraphNode && (
                          <CodeInspectorPanel
                            projectId={projectId}
                            node={selectedGraphNode}
                            onClose={() => { setSelectedGraphNode(null); setShowInspector(false); }}
                            onFocusNode={(id) => focusNodeFnRef.current?.(id)}
                            onShowImpact={handleShowImpact}
                          />
                        )}
                        {rightPanelTab === 'inspector' && !selectedGraphNode && (
                          <div className="flex flex-col items-center justify-center h-full text-center px-4">
                            <Search className="w-8 h-8 text-muted-foreground/30 mb-3" />
                            <p className="text-sm text-muted-foreground">Click a node on the graph to inspect its source code</p>
                          </div>
                        )}
                        {rightPanelTab === 'processes' && (
                          <div className="h-full overflow-y-auto p-3">
                            <ProcessFlowPanel
                              graphData={graphData}
                              highlightedNodeIds={highlightedNodeIds}
                              onHighlightNodes={setHighlightedNodeIds}
                              onNodeSelect={handleNodeSelectById}
                            />
                          </div>
                        )}
                      </div>
                    </div>
                  </Panel>
                </>
              )}
            </PanelGroup>

            {/* Collapsed right panel toggle */}
            {!showInspector && (
              <div className="w-10 bg-background border-l border-border flex flex-col items-center py-2 gap-2 shrink-0">
                <button
                  onClick={() => setShowInspector(true)}
                  className="p-1.5 text-muted-foreground hover:text-foreground rounded transition-colors"
                  title="Open Inspector"
                >
                  <Search className="w-4 h-4" />
                </button>
                <button
                  onClick={() => { setShowInspector(true); setRightPanelTab('processes'); }}
                  className="p-1.5 text-muted-foreground hover:text-foreground rounded transition-colors"
                  title="Execution Flows"
                >
                  <GitBranch className="w-4 h-4" />
                </button>
              </div>
            )}
          </div>
        </>
      )}
    </div>
  );
}
