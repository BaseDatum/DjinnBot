/**
 * Right-click context menu for nodes and canvas background.
 * Renders as a portal-positioned floating panel.
 */

import { useEffect, useRef } from 'react';
import { Plus, Link2, Eye, Trash2, Copy, ZoomIn, RefreshCw } from 'lucide-react';
import { cn } from '@/lib/utils';
import type { GraphNode } from './types';

interface MenuItem {
  icon: React.ReactNode;
  label: string;
  onClick: () => void;
  danger?: boolean;
  dividerBefore?: boolean;
}

interface GraphContextMenuProps {
  x: number;
  y: number;
  node: GraphNode | null;
  onClose: () => void;
  onFocusNode?: (node: GraphNode) => void;
  onLinkNode?: (node: GraphNode) => void;
  onDeleteNode?: (node: GraphNode) => void;
  onCreateNode?: () => void;
  onRebuild?: () => void;
  onZoomToFit?: () => void;
  onCopyId?: (id: string) => void;
}

export function GraphContextMenu({
  x,
  y,
  node,
  onClose,
  onFocusNode,
  onLinkNode,
  onDeleteNode,
  onCreateNode,
  onRebuild,
  onZoomToFit,
  onCopyId,
}: GraphContextMenuProps) {
  const menuRef = useRef<HTMLDivElement>(null);

  // Close on outside click or Escape
  useEffect(() => {
    const handleKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    const handleClick = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) onClose();
    };
    document.addEventListener('keydown', handleKey);
    document.addEventListener('mousedown', handleClick);
    return () => {
      document.removeEventListener('keydown', handleKey);
      document.removeEventListener('mousedown', handleClick);
    };
  }, [onClose]);

  // Clamp to viewport
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  const menuW = 200;
  const clampedX = Math.min(x, vw - menuW - 8);
  const clampedY = Math.min(y, vh - 300);

  const nodeItems: MenuItem[] = node
    ? [
        {
          icon: <Eye className="h-3.5 w-3.5" />,
          label: 'Focus neighborhood',
          onClick: () => { onFocusNode?.(node); onClose(); },
        },
        {
          icon: <ZoomIn className="h-3.5 w-3.5" />,
          label: 'Zoom to node',
          onClick: () => { onClose(); },
        },
        {
          icon: <Link2 className="h-3.5 w-3.5" />,
          label: 'Link to…',
          onClick: () => { onLinkNode?.(node); onClose(); },
          dividerBefore: true,
        },
        {
          icon: <Copy className="h-3.5 w-3.5" />,
          label: 'Copy ID',
          onClick: () => { onCopyId?.(node.id); onClose(); },
        },
        {
          icon: <Trash2 className="h-3.5 w-3.5" />,
          label: 'Delete memory',
          onClick: () => { onDeleteNode?.(node); onClose(); },
          danger: true,
          dividerBefore: true,
        },
      ]
    : [];

  const canvasItems: MenuItem[] = [
    {
      icon: <Plus className="h-3.5 w-3.5" />,
      label: 'New memory here',
      onClick: () => { onCreateNode?.(); onClose(); },
    },
    {
      icon: <ZoomIn className="h-3.5 w-3.5" />,
      label: 'Zoom to fit',
      onClick: () => { onZoomToFit?.(); onClose(); },
      dividerBefore: true,
    },
    {
      icon: <RefreshCw className="h-3.5 w-3.5" />,
      label: 'Rebuild graph',
      onClick: () => { onRebuild?.(); onClose(); },
    },
  ];

  const items = node ? [...nodeItems, ...canvasItems.slice(1)] : canvasItems;

  return (
    <div
      ref={menuRef}
      className="fixed z-50 min-w-[180px] rounded-lg border border-border bg-popover shadow-xl py-1 text-sm"
      style={{ left: clampedX, top: clampedY }}
    >
      {node && (
        <div className="px-3 py-1.5 border-b border-border mb-1">
          <p className="font-medium text-foreground truncate text-xs">{node.title || node.id}</p>
          <p className="text-muted-foreground text-[10px] mt-0.5">{node.category}</p>
        </div>
      )}
      {items.map((item, i) => (
        <div key={i}>
          {item.dividerBefore && <div className="my-1 border-t border-border/50" />}
          <button
            onClick={item.onClick}
            className={cn(
              'w-full flex items-center gap-2.5 px-3 py-1.5 text-left transition-colors',
              item.danger
                ? 'text-destructive hover:bg-destructive/10'
                : 'text-foreground hover:bg-accent'
            )}
          >
            <span className="text-muted-foreground">{item.icon}</span>
            {item.label}
          </button>
        </div>
      ))}
    </div>
  );
}
