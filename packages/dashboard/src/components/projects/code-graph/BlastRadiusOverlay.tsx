/**
 * BlastRadiusOverlay — shows impact analysis results for a selected symbol.
 *
 * Fetches upstream (who depends on this) impact data from the API and
 * pushes coloured highlight sets to the parent graph canvas.
 *
 * Depth coloring:
 *  - Depth 1 (WILL BREAK): red
 *  - Depth 2 (LIKELY AFFECTED): orange
 *  - Depth 3+: yellow
 */

import { useState, useEffect, useCallback } from 'react';
import {
  X, AlertTriangle, Loader2, GitBranch, ChevronDown, ChevronRight,
} from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { fetchCodeGraphImpact } from '@/lib/api';

interface ImpactData {
  target: { name: string; label: string; filePath: string };
  risk: 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL';
  summary: {
    directDependents: number;
    affectedProcesses: number;
    affectedCommunities: number;
  };
  byDepth: Array<{
    depth: number;
    label: string;
    symbols: Array<{
      name: string;
      filePath: string;
      edgeType: string;
      confidence: number;
      nodeId?: string;
    }>;
  }>;
  affectedProcesses: Array<{
    processId: string;
    processLabel: string;
    affectedStep: number;
  }>;
}

// Depth → colour mapping for graph highlights
export const BLAST_RADIUS_COLORS: Record<number, string> = {
  1: '#ef4444', // red
  2: '#f97316', // orange
  3: '#eab308', // yellow
};

export function getBlastRadiusColor(depth: number): string {
  return BLAST_RADIUS_COLORS[depth] || '#eab308';
}

interface BlastRadiusOverlayProps {
  projectId: string;
  symbolName: string;
  onClose: () => void;
  /** Called with Map<nodeId, depth> for colouring on the graph */
  onHighlightImpact: (impactMap: Map<string, number>) => void;
  onNodeSelect: (nodeId: string) => void;
}

export function BlastRadiusOverlay({
  projectId,
  symbolName,
  onClose,
  onHighlightImpact,
  onNodeSelect,
}: BlastRadiusOverlayProps) {
  const [loading, setLoading] = useState(true);
  const [impact, setImpact] = useState<ImpactData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [expandedDepths, setExpandedDepths] = useState<Set<number>>(new Set([1, 2]));

  useEffect(() => {
    setLoading(true);
    setError(null);
    fetchCodeGraphImpact(projectId, symbolName, 'upstream', 3, 0.5)
      .then(data => {
        if (data.error) {
          setError(data.error);
          setImpact(null);
        } else {
          setImpact(data);
          // Build highlight map
          const map = new Map<string, number>();
          for (const depthGroup of data.byDepth || []) {
            for (const sym of depthGroup.symbols || []) {
              if (sym.nodeId) {
                map.set(sym.nodeId, depthGroup.depth);
              }
            }
          }
          onHighlightImpact(map);
        }
      })
      .catch(err => setError(err?.message || 'Failed to fetch impact'))
      .finally(() => setLoading(false));
  }, [projectId, symbolName, onHighlightImpact]);

  const toggleDepth = useCallback((d: number) => {
    setExpandedDepths(prev => {
      const next = new Set(prev);
      next.has(d) ? next.delete(d) : next.add(d);
      return next;
    });
  }, []);

  const riskColors: Record<string, string> = {
    LOW: 'text-emerald-500 bg-emerald-500/10 border-emerald-500/30',
    MEDIUM: 'text-amber-500 bg-amber-500/10 border-amber-500/30',
    HIGH: 'text-orange-500 bg-orange-500/10 border-orange-500/30',
    CRITICAL: 'text-red-500 bg-red-500/10 border-red-500/30',
  };

  return (
    <div className="rounded-lg border border-destructive/30 bg-destructive/5 overflow-hidden">
      {/* Header */}
      <div className="flex items-center gap-2 px-3 py-2 bg-destructive/10 border-b border-destructive/20">
        <AlertTriangle className="w-4 h-4 text-destructive" />
        <span className="text-sm font-semibold text-foreground">Blast Radius</span>
        <span className="font-mono text-xs text-muted-foreground">{symbolName}</span>
        <button
          onClick={() => { onHighlightImpact(new Map()); onClose(); }}
          className="ml-auto p-1 text-muted-foreground hover:text-foreground rounded"
        >
          <X className="w-3.5 h-3.5" />
        </button>
      </div>

      {loading && (
        <div className="flex items-center gap-2 px-3 py-4 text-sm text-muted-foreground">
          <Loader2 className="w-4 h-4 animate-spin" /> Analyzing impact...
        </div>
      )}

      {error && (
        <div className="px-3 py-3 text-sm text-destructive">{error}</div>
      )}

      {impact && (
        <div className="px-3 py-2 space-y-2">
          {/* Summary */}
          <div className="flex items-center gap-2 flex-wrap">
            <Badge variant="outline" className={`text-xs ${riskColors[impact.risk] || ''}`}>
              {impact.risk} RISK
            </Badge>
            <span className="text-xs text-muted-foreground">
              {impact.summary?.directDependents ?? 0} dependents
            </span>
            <span className="text-xs text-muted-foreground">
              {impact.summary?.affectedProcesses ?? 0} flows
            </span>
            <span className="text-xs text-muted-foreground">
              {impact.summary?.affectedCommunities ?? 0} communities
            </span>
          </div>

          {/* By depth */}
          {impact.byDepth?.map(group => (
            <div key={group.depth} className="border rounded">
              <button
                onClick={() => toggleDepth(group.depth)}
                className="w-full flex items-center gap-2 px-2 py-1.5 text-xs hover:bg-muted/50 transition-colors"
              >
                {expandedDepths.has(group.depth)
                  ? <ChevronDown className="w-3 h-3 text-muted-foreground" />
                  : <ChevronRight className="w-3 h-3 text-muted-foreground" />
                }
                <span
                  className="w-2 h-2 rounded-full"
                  style={{ backgroundColor: getBlastRadiusColor(group.depth) }}
                />
                <span className="font-medium">{group.label}</span>
                <Badge variant="outline" className="ml-auto text-[10px]">
                  {group.symbols?.length ?? 0}
                </Badge>
              </button>
              {expandedDepths.has(group.depth) && group.symbols?.length > 0 && (
                <div className="px-2 pb-1.5 space-y-0.5">
                  {group.symbols.map((sym, i) => (
                    <div
                      key={i}
                      className="flex items-center gap-1.5 text-[11px] py-0.5 hover:bg-muted/30 rounded px-1 cursor-pointer"
                      onClick={() => sym.nodeId && onNodeSelect(sym.nodeId)}
                    >
                      <span
                        className="w-1.5 h-1.5 rounded-full shrink-0"
                        style={{ backgroundColor: getBlastRadiusColor(group.depth) }}
                      />
                      <span className="font-mono font-medium text-foreground truncate">{sym.name}</span>
                      <Badge variant="outline" className="text-[9px] h-3.5 px-1">{sym.edgeType}</Badge>
                      <span className="ml-auto text-muted-foreground text-[10px] truncate">
                        {sym.filePath?.split('/').pop()}
                      </span>
                    </div>
                  ))}
                </div>
              )}
            </div>
          ))}

          {/* Affected processes */}
          {impact.affectedProcesses?.length > 0 && (
            <div className="border rounded">
              <div className="px-2 py-1.5 text-xs font-medium flex items-center gap-1.5">
                <GitBranch className="w-3 h-3 text-rose-400" />
                Affected Execution Flows
              </div>
              <div className="px-2 pb-1.5 space-y-0.5">
                {impact.affectedProcesses.map((p, i) => (
                  <div key={i} className="text-[11px] text-muted-foreground py-0.5 px-1">
                    {p.processLabel} <span className="text-[10px]">(step {p.affectedStep})</span>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
