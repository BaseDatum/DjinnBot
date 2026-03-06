/**
 * Dialog to create a wiki-link between two memory nodes.
 * Searches available nodes, picks a type, then patches the source file
 * by appending a [[target]] wiki-link in the markdown body.
 */

import { useEffect, useMemo, useRef, useState } from 'react';
import { Search, Link2, ArrowRight } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { fetchMemoryFile, updateMemoryFile } from '@/lib/api';
import type { GraphNode } from './types';

const LINK_TYPES = [
  { value: 'related', label: 'Related to' },
  { value: 'references', label: 'References' },
  { value: 'supports', label: 'Supports' },
  { value: 'contradicts', label: 'Contradicts' },
  { value: 'blocks', label: 'Blocks' },
  { value: 'blocked_by', label: 'Blocked by' },
  { value: 'depends_on', label: 'Depends on' },
];

interface GraphLinkDialogProps {
  agentId: string;
  sourceNode: GraphNode;
  allNodes: GraphNode[];
  onClose: () => void;
  onLinked?: (sourceId: string, targetId: string) => void;
}

export function GraphLinkDialog({
  agentId,
  sourceNode,
  allNodes,
  onClose,
  onLinked,
}: GraphLinkDialogProps) {
  const [query, setQuery] = useState('');
  const [targetNode, setTargetNode] = useState<GraphNode | null>(null);
  const [linkType, setLinkType] = useState('related');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    inputRef.current?.focus();
    const handleKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    document.addEventListener('keydown', handleKey);
    return () => document.removeEventListener('keydown', handleKey);
  }, [onClose]);

  const candidates = useMemo(() => {
    const q = query.toLowerCase();
    return allNodes
      .filter((n) => n.id !== sourceNode.id && !n.isShared)
      .filter((n) =>
        !q ||
        n.title?.toLowerCase().includes(q) ||
        n.id.toLowerCase().includes(q) ||
        n.tags?.some((t) => t.toLowerCase().includes(q))
      )
      .slice(0, 30);
  }, [allNodes, query, sourceNode.id]);

  const handleLink = async () => {
    if (!targetNode || !sourceNode.path) return;
    setSaving(true);
    setError(null);

    try {
      // Load source file content
      const data: any = await fetchMemoryFile(agentId, sourceNode.path);
      const existing: string = data.content ?? '';

      // Derive a clean wiki-link slug from target title or id
      const targetSlug = (targetNode.title || targetNode.id)
        .toLowerCase()
        .replace(/[^a-z0-9\s-]/g, '')
        .replace(/\s+/g, '-')
        .replace(/^-|-$/g, '');

      // Append a link section at the end of the file
      const linkLine = `\n\n<!-- link:${linkType} -->\n[[${targetSlug}]]`;
      await updateMemoryFile(agentId, sourceNode.path, existing + linkLine);

      onLinked?.(sourceNode.id, targetNode.id);
      onClose();
    } catch (err: any) {
      setError(err?.message ?? 'Failed to create link');
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm">
      <div className="bg-background rounded-xl shadow-2xl w-[520px] max-h-[80vh] flex flex-col border border-border">
        {/* Header */}
        <div className="flex items-center gap-2 p-4 border-b border-border">
          <Link2 className="h-4 w-4 text-primary" />
          <h2 className="font-semibold text-sm">Link memory node</h2>
          <span className="text-muted-foreground text-xs ml-1">
            from <span className="text-foreground font-medium">{sourceNode.title || sourceNode.id}</span>
          </span>
          <button onClick={onClose} className="ml-auto text-muted-foreground hover:text-foreground text-lg leading-none">×</button>
        </div>

        <div className="p-4 space-y-4 flex-1 overflow-auto">
          {/* Target search */}
          <div>
            <label className="text-xs font-medium text-muted-foreground mb-1.5 block">Target node</label>
            <div className="relative">
              <Search className="absolute left-2.5 top-2.5 h-3.5 w-3.5 text-muted-foreground" />
              <input
                ref={inputRef}
                type="text"
                placeholder="Search by title, id, or tag…"
                value={query}
                onChange={(e) => { setQuery(e.target.value); setTargetNode(null); }}
                className="w-full pl-8 pr-3 py-2 text-sm border border-input rounded-md bg-background focus:outline-none focus:ring-1 focus:ring-ring"
              />
            </div>

            {/* Results list */}
            {candidates.length > 0 && !targetNode && (
              <div className="mt-1.5 border border-border rounded-md overflow-hidden max-h-52 overflow-y-auto">
                {candidates.map((node) => (
                  <button
                    key={node.id}
                    onClick={() => { setTargetNode(node); setQuery(node.title || node.id); }}
                    className="w-full text-left px-3 py-2 text-sm hover:bg-accent flex items-center gap-2 border-b border-border/50 last:border-0"
                  >
                    <span className="flex-1 truncate font-medium">{node.title || node.id}</span>
                    <span className="text-xs text-muted-foreground shrink-0">{node.category}</span>
                  </button>
                ))}
              </div>
            )}

            {targetNode && (
              <div className="mt-2 flex items-center gap-2 px-3 py-2 rounded-md bg-primary/10 border border-primary/20 text-sm">
                <span className="font-medium flex-1">{targetNode.title || targetNode.id}</span>
                <button onClick={() => { setTargetNode(null); setQuery(''); }} className="text-muted-foreground hover:text-foreground text-base">×</button>
              </div>
            )}
          </div>

          {/* Link type */}
          <div>
            <label className="text-xs font-medium text-muted-foreground mb-1.5 block">Relationship type</label>
            <div className="grid grid-cols-3 gap-1.5">
              {LINK_TYPES.map((t) => (
                <button
                  key={t.value}
                  onClick={() => setLinkType(t.value)}
                  className={`text-xs px-2 py-1.5 rounded border transition-colors text-left ${
                    linkType === t.value
                      ? 'border-primary bg-primary/10 text-primary font-medium'
                      : 'border-border hover:border-primary/40 hover:bg-muted'
                  }`}
                >
                  {t.label}
                </button>
              ))}
            </div>
          </div>

          {/* Preview */}
          {targetNode && (
            <div className="flex items-center gap-2 px-3 py-2 rounded-md bg-muted text-xs text-muted-foreground">
              <span className="font-medium text-foreground">{sourceNode.title || sourceNode.id}</span>
              <ArrowRight className="h-3 w-3 shrink-0" />
              <span className="italic text-muted-foreground">{LINK_TYPES.find((t) => t.value === linkType)?.label}</span>
              <ArrowRight className="h-3 w-3 shrink-0" />
              <span className="font-medium text-foreground">{targetNode.title || targetNode.id}</span>
            </div>
          )}

          {error && <p className="text-xs text-destructive">{error}</p>}
        </div>

        <div className="flex justify-end gap-2 p-4 border-t border-border">
          <Button variant="outline" onClick={onClose} size="sm">Cancel</Button>
          <Button
            onClick={handleLink}
            disabled={!targetNode || saving || !sourceNode.path}
            size="sm"
          >
            {saving ? 'Linking…' : 'Create link'}
          </Button>
        </div>
      </div>
    </div>
  );
}
