import { useState, useEffect, useCallback, useRef } from 'react';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Skeleton } from '@/components/ui/skeleton';
import {
  RefreshCw,
  Brain,
  GitBranch,
  Workflow,
  AlertTriangle,
  CheckCircle2,
  Clock,
  ChevronDown,
  ChevronRight,
  Search,
} from 'lucide-react';
import {
  fetchCodeGraphStatus,
  triggerCodeGraphIndex,
  pollCodeGraphIndexProgress,
  fetchCodeGraphCommunities,
  fetchCodeGraphProcesses,
  fetchCodeGraphSearch,
  fetchCodeGraphData,
} from '@/lib/api';
import { CodeGraphCanvas } from './code-graph/CodeGraphCanvas';
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

interface Community {
  id: string;
  label: string;
  cohesion: number;
  symbolCount: number;
  members: Array<{ name: string; filePath: string }>;
}

interface Process {
  id: string;
  label: string;
  processType: string;
  stepCount: number;
  steps: Array<{ name: string; filePath: string; step: number }>;
}

export function CodeKnowledgeGraph({ projectId }: CodeKnowledgeGraphProps) {
  const [status, setStatus] = useState<GraphStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [indexing, setIndexing] = useState(false);
  const [indexProgress, setIndexProgress] = useState<{
    phase: string;
    percent: number;
    message: string;
  } | null>(null);
  const [communities, setCommunities] = useState<Community[]>([]);
  const [processes, setProcesses] = useState<Process[]>([]);
  const [expandedCommunities, setExpandedCommunities] = useState<Set<string>>(new Set());
  const [expandedProcesses, setExpandedProcesses] = useState<Set<string>>(new Set());
  const [searchQuery, setSearchQuery] = useState('');
  const [searchResults, setSearchResults] = useState<any[]>([]);
  const [searching, setSearching] = useState(false);
  const [indexError, setIndexError] = useState<string | null>(null);
  const [graphData, setGraphData] = useState<APIGraphData | null>(null);
  const [selectedGraphNode, setSelectedGraphNode] = useState<{
    id: string; name: string; label: string; filePath: string; startLine?: number;
  } | null>(null);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const loadStatus = useCallback(async () => {
    try {
      const s = await fetchCodeGraphStatus(projectId);
      setStatus(s);
      if (s.indexed) {
        const [commData, procData, gData] = await Promise.all([
          fetchCodeGraphCommunities(projectId),
          fetchCodeGraphProcesses(projectId),
          fetchCodeGraphData(projectId),
        ]);
        setCommunities(commData.communities || []);
        setProcesses(procData.processes || []);
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
    return () => {
      if (pollRef.current) clearInterval(pollRef.current);
    };
  }, [loadStatus]);

  const handleIndex = async () => {
    setIndexing(true);
    setIndexError(null);
    setIndexProgress({ phase: 'starting', percent: 0, message: 'Starting...' });
    try {
      const { job_id } = await triggerCodeGraphIndex(projectId);

      // Poll progress
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
            if (progress.status === 'failed') {
              setIndexError(progress.message || 'Indexing failed');
            }
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
      console.error('Failed to start indexing:', err);
    }
  };

  const handleSearch = async () => {
    if (!searchQuery.trim()) return;
    setSearching(true);
    try {
      const data = await fetchCodeGraphSearch(projectId, searchQuery);
      setSearchResults(data.results || []);
    } catch {
      setSearchResults([]);
    } finally {
      setSearching(false);
    }
  };

  const toggleCommunity = (id: string) => {
    setExpandedCommunities(prev => {
      const next = new Set(prev);
      next.has(id) ? next.delete(id) : next.add(id);
      return next;
    });
  };

  const toggleProcess = (id: string) => {
    setExpandedProcesses(prev => {
      const next = new Set(prev);
      next.has(id) ? next.delete(id) : next.add(id);
      return next;
    });
  };

  if (loading) {
    return (
      <div className="p-4 md:px-6 space-y-4 max-w-4xl mx-auto">
        <Skeleton height={40} />
        <div className="grid grid-cols-2 gap-4">
          <Skeleton height={200} />
          <Skeleton height={200} />
        </div>
      </div>
    );
  }

  const formatTimeAgo = (ts: number) => {
    const diff = Date.now() - ts;
    const mins = Math.floor(diff / 60000);
    if (mins < 60) return `${mins}m ago`;
    const hrs = Math.floor(mins / 60);
    if (hrs < 24) return `${hrs}h ago`;
    return `${Math.floor(hrs / 24)}d ago`;
  };

  return (
    <div className="p-4 md:px-6 space-y-4 max-w-4xl mx-auto">
      {/* Header + Action Bar */}
      <div className="flex items-center justify-between gap-4">
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
              <AlertTriangle className="h-3 w-3" />
              Stale
            </Badge>
          )}
        </div>
        <Button
          size="sm"
          onClick={handleIndex}
          disabled={indexing || status?.status === 'indexing'}
          className="gap-1.5"
        >
          <RefreshCw className={`h-3.5 w-3.5 ${indexing ? 'animate-spin' : ''}`} />
          {indexing ? 'Indexing...' : status?.indexed ? 'Update' : 'Build Knowledge Graph'}
        </Button>
      </div>

      {/* Indexing Progress */}
      {indexProgress && (
        <div className="rounded-lg border border-primary/20 bg-primary/5 p-4 space-y-2">
          <div className="flex items-center justify-between text-sm">
            <span>{indexProgress.message}</span>
            <span className="text-muted-foreground">{indexProgress.percent}%</span>
          </div>
          <div className="w-full bg-muted rounded-full h-2">
            <div
              className="bg-primary h-2 rounded-full transition-all"
              style={{ width: `${indexProgress.percent}%` }}
            />
          </div>
        </div>
      )}

      {/* Status error (from server) */}
      {status?.error && !indexError && (
        <div className="rounded-lg border border-destructive/30 bg-destructive/5 p-3 text-sm text-destructive">
          {status.error}
        </div>
      )}

      {/* Status bar */}
      {status?.indexed && (
        <div className="flex flex-wrap gap-3 text-xs text-muted-foreground">
          {status.last_indexed_at && (
            <span className="flex items-center gap-1">
              <Clock className="h-3 w-3" />
              Indexed {formatTimeAgo(status.last_indexed_at)}
            </span>
          )}
          <span>{status.node_count} symbols</span>
          <span>{status.relationship_count} relationships</span>
          <span>{status.community_count} communities</span>
          <span>{status.process_count} execution flows</span>
        </div>
      )}

      {/* Not indexed state */}
      {!status?.indexed && !indexing && (
        <div className="text-center py-12 text-muted-foreground space-y-2">
          <Brain className="h-12 w-12 mx-auto opacity-30" />
          <p className="text-sm">No knowledge graph built yet</p>
          <p className="text-xs">
            Click "Build Knowledge Graph" to index this codebase.
            The graph maps every function, class, and their relationships.
          </p>
        </div>
      )}

      {/* Indexing error */}
      {indexError && (
        <div className="rounded-lg border border-destructive/30 bg-destructive/5 p-3 flex items-start gap-2">
          <AlertTriangle className="h-4 w-4 text-destructive shrink-0 mt-0.5" />
          <div className="text-sm text-destructive">{indexError}</div>
        </div>
      )}

      {/* Main content when indexed */}
      {status?.indexed && (
        <div className="space-y-4">
          {/* Interactive Graph Visualisation */}
          {graphData && graphData.nodes.length > 0 && (
            <div className="h-[600px]">
              <CodeGraphCanvas
                graphData={graphData}
                onNodeSelect={setSelectedGraphNode}
              />
            </div>
          )}

          {/* Selected node detail bar */}
          {selectedGraphNode && (
            <div className="rounded-lg border bg-muted/30 p-3 flex items-center gap-3 text-sm">
              <Badge variant="outline" className="text-[10px]">{selectedGraphNode.label}</Badge>
              <span className="font-mono font-medium">{selectedGraphNode.name}</span>
              <span className="text-muted-foreground truncate text-xs">{selectedGraphNode.filePath}</span>
              {selectedGraphNode.startLine && (
                <span className="text-muted-foreground text-xs">:{selectedGraphNode.startLine}</span>
              )}
            </div>
          )}

          {/* Search */}
          <div className="flex gap-2">
            <div className="flex-1 relative">
              <Search className="absolute left-2.5 top-2.5 h-4 w-4 text-muted-foreground" />
              <input
                type="text"
                value={searchQuery}
                onChange={e => setSearchQuery(e.target.value)}
                onKeyDown={e => e.key === 'Enter' && handleSearch()}
                placeholder="Search symbols..."
                className="w-full pl-9 pr-3 py-2 rounded-md border bg-background text-sm"
              />
            </div>
            <Button size="sm" variant="outline" onClick={handleSearch} disabled={searching}>
              Search
            </Button>
          </div>

          {/* Search Results */}
          {searchResults.length > 0 && (
            <div className="rounded-lg border p-3 space-y-2">
              <h3 className="text-sm font-medium">Search Results</h3>
              {searchResults.map((r, i) => (
                <div key={i} className="flex items-center gap-2 text-xs py-1 border-b last:border-0">
                  <Badge variant="outline" className="text-[10px]">{r.label}</Badge>
                  <span className="font-mono font-medium">{r.name}</span>
                  <span className="text-muted-foreground truncate">{r.filePath}</span>
                  {r.startLine && (
                    <span className="text-muted-foreground">:{r.startLine}</span>
                  )}
                </div>
              ))}
            </div>
          )}

          {/* Two-column layout: Communities + Processes */}
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            {/* Communities */}
            <div className="rounded-lg border p-3 space-y-2">
              <div className="flex items-center gap-2 mb-2">
                <GitBranch className="h-4 w-4 text-primary" />
                <h3 className="text-sm font-medium">Communities</h3>
                <span className="text-xs text-muted-foreground">({communities.length})</span>
              </div>
              {communities.length === 0 ? (
                <p className="text-xs text-muted-foreground">No communities detected</p>
              ) : (
                <div className="space-y-1 max-h-80 overflow-y-auto">
                  {communities.map(c => (
                    <div key={c.id}>
                      <button
                        className="flex items-center gap-2 w-full text-left py-1.5 px-2 rounded hover:bg-muted text-sm"
                        onClick={() => toggleCommunity(c.id)}
                      >
                        {expandedCommunities.has(c.id) ? (
                          <ChevronDown className="h-3 w-3 shrink-0" />
                        ) : (
                          <ChevronRight className="h-3 w-3 shrink-0" />
                        )}
                        <span className="font-medium truncate">{c.label}</span>
                        <span className="text-xs text-muted-foreground ml-auto shrink-0">
                          {c.symbolCount} symbols
                        </span>
                      </button>
                      {expandedCommunities.has(c.id) && c.members && (
                        <div className="ml-6 space-y-0.5 pb-1">
                          {c.members.map((m, i) => (
                            <div key={i} className="text-xs text-muted-foreground truncate">
                              <span className="font-mono">{m.name}</span>
                              <span className="ml-1 opacity-60">{m.filePath}</span>
                            </div>
                          ))}
                        </div>
                      )}
                    </div>
                  ))}
                </div>
              )}
            </div>

            {/* Processes */}
            <div className="rounded-lg border p-3 space-y-2">
              <div className="flex items-center gap-2 mb-2">
                <Workflow className="h-4 w-4 text-primary" />
                <h3 className="text-sm font-medium">Execution Flows</h3>
                <span className="text-xs text-muted-foreground">({processes.length})</span>
              </div>
              {processes.length === 0 ? (
                <p className="text-xs text-muted-foreground">No execution flows detected</p>
              ) : (
                <div className="space-y-1 max-h-80 overflow-y-auto">
                  {processes.map(p => (
                    <div key={p.id}>
                      <button
                        className="flex items-center gap-2 w-full text-left py-1.5 px-2 rounded hover:bg-muted text-sm"
                        onClick={() => toggleProcess(p.id)}
                      >
                        {expandedProcesses.has(p.id) ? (
                          <ChevronDown className="h-3 w-3 shrink-0" />
                        ) : (
                          <ChevronRight className="h-3 w-3 shrink-0" />
                        )}
                        <span className="font-medium truncate">{p.label}</span>
                        <Badge
                          variant="outline"
                          className="text-[10px] ml-auto shrink-0"
                        >
                          {p.stepCount} steps
                        </Badge>
                      </button>
                      {expandedProcesses.has(p.id) && p.steps && (
                        <div className="ml-6 space-y-0.5 pb-1">
                          {p.steps.map((s, i) => (
                            <div key={i} className="text-xs flex items-center gap-1.5">
                              <span className="text-muted-foreground w-4 text-right">{s.step}.</span>
                              <span className="font-mono">{s.name}</span>
                              <span className="text-muted-foreground truncate opacity-60">{s.filePath}</span>
                            </div>
                          ))}
                        </div>
                      )}
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
