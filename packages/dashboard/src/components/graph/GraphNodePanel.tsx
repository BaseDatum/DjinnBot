/**
 * Persistent right-side panel showing node details, content, connections, and editor.
 * Reuses MemoryEditor and MarkdownRenderer — no duplication.
 */

import { useEffect, useState } from 'react';
import { X, Edit3, Eye, ExternalLink, AlertTriangle, Anchor, Share2 } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { MarkdownRenderer } from '@/components/MarkdownRenderer';
import { MemoryEditor } from '@/components/memory/MemoryEditor';
import { fetchMemoryFile, deleteMemoryFile } from '@/lib/api';
import { cn } from '@/lib/utils';
import type { GraphNode } from './types';
import { getCategoryColor, COLORS_DARK, COLORS_LIGHT } from './graphColors';

function stripFrontmatter(content: string): string {
  const match = content.match(/^---\n[\s\S]*?\n---\n?/);
  return match ? content.slice(match[0].length) : content;
}

function useDarkMode() {
  const [isDark, setIsDark] = useState(() => document.documentElement.classList.contains('dark'));
  useEffect(() => {
    const obs = new MutationObserver(() => setIsDark(document.documentElement.classList.contains('dark')));
    obs.observe(document.documentElement, { attributes: true, attributeFilter: ['class'] });
    return () => obs.disconnect();
  }, []);
  return isDark;
}

interface GraphNodePanelProps {
  agentId: string;
  node: GraphNode;
  connections: GraphNode[];
  degreeMap: Map<string, number>;
  onClose: () => void;
  onSelectNode: (node: GraphNode) => void;
  onLinkNode: (node: GraphNode) => void;
  onDeleted?: () => void;
}

type PanelMode = 'view' | 'edit';

export function GraphNodePanel({
  agentId,
  node,
  connections,
  degreeMap,
  onClose,
  onSelectNode,
  onLinkNode,
  onDeleted,
}: GraphNodePanelProps) {
  const isDark = useDarkMode();
  const palette = isDark ? COLORS_DARK : COLORS_LIGHT;

  const [mode, setMode] = useState<PanelMode>('view');
  const [content, setContent] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);

  const isShared = !!node.isShared;
  const canEdit = !!node.path && !isShared;
  const nodeColor = getCategoryColor(palette, node.category ?? 'default');

  // Fetch content when node changes
  useEffect(() => {
    setMode('view');
    setConfirmDelete(false);
    if (!node.path) { setContent(null); return; }
    setLoading(true);
    // For shared nodes, use shared vault id
    const vaultId = isShared ? 'shared' : agentId;
    const actualPath = isShared && node.path ? node.path : node.path;
    fetchMemoryFile(vaultId, actualPath!)
      .then((d: any) => setContent(d.content))
      .catch(() => setContent(null))
      .finally(() => setLoading(false));
  }, [node.id, node.path, agentId, isShared]);

  const handleDelete = async () => {
    if (!node.path) return;
    setDeleting(true);
    try {
      await deleteMemoryFile(agentId, node.path);
      onDeleted?.();
    } catch (err) {
      console.error('Delete failed:', err);
    } finally {
      setDeleting(false);
      setConfirmDelete(false);
    }
  };

  const formattedDate = node.createdAt
    ? new Date(node.createdAt).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' })
    : null;

  // Group connections by category
  const grouped = connections.reduce<Record<string, GraphNode[]>>((acc, n) => {
    const key = n.category ?? 'default';
    (acc[key] = acc[key] ?? []).push(n);
    return acc;
  }, {});

  return (
    <div className="h-full flex flex-col bg-background border-l border-border overflow-hidden">
      {/* Header */}
      <div className="flex items-start gap-2 p-3 border-b border-border">
        <div
          className="w-3 h-3 rounded-full mt-1.5 shrink-0"
          style={{ backgroundColor: nodeColor, boxShadow: `0 0 0 2px ${nodeColor}40` }}
        />
        <div className="flex-1 min-w-0">
          <h3 className="font-semibold text-sm leading-tight text-foreground line-clamp-2">
            {node.title || node.id}
          </h3>
          <div className="flex items-center gap-1.5 mt-1 flex-wrap">
            <Badge variant="secondary" className="text-[10px] h-4 px-1.5">{node.category}</Badge>
            {isShared && (
              <Badge variant="outline" className="text-[10px] h-4 px-1.5 border-violet-400 text-violet-400">
                <Share2 className="h-2.5 w-2.5 mr-1" />shared
              </Badge>
            )}
            {node.missing && (node.type === 'unresolved' || !node.path) ? (
              <Badge variant="outline" className="text-[10px] h-4 px-1.5 border-violet-400 text-violet-400">
                <Anchor className="h-2.5 w-2.5 mr-1" />anchor
              </Badge>
            ) : node.missing ? (
              <Badge variant="destructive" className="text-[10px] h-4 px-1.5">
                <AlertTriangle className="h-2.5 w-2.5 mr-1" />missing
              </Badge>
            ) : null}
            {formattedDate && (
              <span className="text-[10px] text-muted-foreground">{formattedDate}</span>
            )}
          </div>
        </div>
        <button
          onClick={onClose}
          className="text-muted-foreground hover:text-foreground transition-colors p-0.5 rounded"
        >
          <X className="h-4 w-4" />
        </button>
      </div>

      {/* Tags */}
      {node.tags?.length > 0 && (
        <div className="px-3 py-2 border-b border-border/50 flex flex-wrap gap-1">
          {node.tags.map((tag) => (
            <span key={tag} className="text-[10px] px-1.5 py-0.5 rounded bg-muted text-muted-foreground">
              #{tag}
            </span>
          ))}
        </div>
      )}

      {/* Action bar */}
      <div className="flex items-center gap-1 px-3 py-1.5 border-b border-border/50">
        {canEdit && (
          <div className="flex rounded border border-border overflow-hidden">
            <button
              onClick={() => setMode('view')}
              className={cn(
                'px-2 py-1 text-xs flex items-center gap-1 transition-colors',
                mode === 'view' ? 'bg-primary text-primary-foreground' : 'hover:bg-muted'
              )}
            >
              <Eye className="h-3 w-3" />Read
            </button>
            <button
              onClick={() => setMode('edit')}
              className={cn(
                'px-2 py-1 text-xs flex items-center gap-1 transition-colors',
                mode === 'edit' ? 'bg-primary text-primary-foreground' : 'hover:bg-muted'
              )}
            >
              <Edit3 className="h-3 w-3" />Edit
            </button>
          </div>
        )}
        <button
          onClick={() => onLinkNode(node)}
          className="ml-auto text-xs text-muted-foreground hover:text-foreground flex items-center gap-1 px-2 py-1 rounded hover:bg-muted transition-colors"
        >
          <ExternalLink className="h-3 w-3" />Link
        </button>
      </div>

      {/* Scrollable content area — when editing, the editor fills all available
           space instead of sitting inside a fixed-height box. */}
      <div className={cn(
        'flex-1 min-h-0',
        mode === 'edit' ? 'flex flex-col overflow-hidden' : 'overflow-auto'
      )}>
        {/* File content */}
        {node.path && (
          <div className={cn(
            'p-3 border-b border-border/50',
            mode === 'edit' && 'flex-1 min-h-0 flex flex-col'
          )}>
            {loading ? (
              <p className="text-xs text-muted-foreground animate-pulse">Loading…</p>
            ) : mode === 'edit' && content !== null ? (
              <div className="flex-1 min-h-0">
                <MemoryEditor
                  agentId={agentId}
                  filename={node.path}
                  initialContent={content}
                  onSave={(newContent) => { setContent(newContent); setMode('view'); }}
                  onCancel={() => setMode('view')}
                />
              </div>
            ) : content ? (
              <div className="prose prose-sm dark:prose-invert max-w-none text-xs leading-relaxed">
                <MarkdownRenderer content={stripFrontmatter(content)} />
              </div>
            ) : (
              <p className="text-xs text-muted-foreground italic">No content</p>
            )}
          </div>
        )}

        {/* Stats row */}
        <div className="px-3 py-2 border-b border-border/50 flex items-center gap-4 text-xs text-muted-foreground">
          <span><span className="font-medium text-foreground">{degreeMap.get(node.id) ?? 0}</span> connections</span>
          {node.path && <span className="font-mono truncate text-[10px]">{node.path}</span>}
        </div>

        {/* Connections grouped by category */}
        {Object.entries(grouped).length > 0 && (
          <div className="p-3">
            <h4 className="text-xs font-semibold text-foreground mb-2">
              Connections ({connections.length})
            </h4>
            <div className="space-y-3">
              {Object.entries(grouped).map(([cat, nodes]) => (
                <div key={cat}>
                  <div className="flex items-center gap-1.5 mb-1">
                    <div
                      className="w-2 h-2 rounded-full"
                      style={{ backgroundColor: getCategoryColor(palette, cat) }}
                    />
                    <span className="text-[10px] text-muted-foreground uppercase tracking-wide">{cat}</span>
                  </div>
                  <ul className="space-y-0.5 pl-3.5">
                    {nodes.map((conn) => (
                      <li key={conn.id}>
                        <button
                          onClick={() => onSelectNode(conn)}
                          className="text-xs text-left w-full text-primary hover:underline truncate block"
                        >
                          {conn.title || conn.id}
                        </button>
                      </li>
                    ))}
                  </ul>
                </div>
              ))}
            </div>
          </div>
        )}
      </div>

      {/* Delete zone */}
      {canEdit && (
        <div className="p-3 border-t border-border/50">
          {confirmDelete ? (
            <div className="flex items-center gap-2">
              <span className="text-xs text-destructive flex-1">Delete this memory?</span>
              <Button
                size="sm"
                variant="destructive"
                onClick={handleDelete}
                disabled={deleting}
                className="h-6 text-xs px-2"
              >
                {deleting ? 'Deleting…' : 'Confirm'}
              </Button>
              <Button
                size="sm"
                variant="outline"
                onClick={() => setConfirmDelete(false)}
                className="h-6 text-xs px-2"
              >
                Cancel
              </Button>
            </div>
          ) : (
            <button
              onClick={() => setConfirmDelete(true)}
              className="text-xs text-muted-foreground hover:text-destructive transition-colors"
            >
              Delete memory…
            </button>
          )}
        </div>
      )}
    </div>
  );
}
