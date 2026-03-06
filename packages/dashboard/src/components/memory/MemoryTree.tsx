import { useRef, useEffect, useState } from 'react';
import { Tree, NodeRendererProps } from 'react-arborist';
import { FolderIcon, FileTextIcon } from 'lucide-react';
import { Badge } from '@/components/ui/badge';

function useContainerSize(ref: React.RefObject<HTMLElement | null>) {
  const [size, setSize] = useState({ width: 300, height: 500 });

  useEffect(() => {
    const el = ref.current;
    if (!el) return;

    const ro = new ResizeObserver((entries) => {
      for (const entry of entries) {
        const { width, height } = entry.contentRect;
        setSize((prev) =>
          prev.width === Math.floor(width) && prev.height === Math.floor(height)
            ? prev
            : { width: Math.floor(width), height: Math.floor(height) }
        );
      }
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, [ref]);

  return size;
}

interface MemoryFile {
  filename: string;
  category: string | null;
  title: string | null;
  created_at: number | null;
  size_bytes: number;
  preview: string | null;
}

interface TreeNode {
  id: string;
  name: string;
  children?: TreeNode[];
  data?: MemoryFile;
}

const CATEGORY_COLORS: Record<string, string> = {
  handoff: 'bg-blue-500/10 text-blue-400 border-blue-500/30',
  decision: 'bg-green-500/10 text-green-400 border-green-500/30',
  lesson: 'bg-yellow-500/10 text-yellow-400 border-yellow-500/30',
  pattern: 'bg-purple-500/10 text-purple-400 border-purple-500/30',
  fact: 'bg-zinc-500/10 text-zinc-400 border-zinc-500/30',
  preference: 'bg-orange-500/10 text-orange-400 border-orange-500/30',
};

function categoryColor(category: string | null): string {
  return CATEGORY_COLORS[category || ''] || CATEGORY_COLORS.fact;
}

// Transform flat file list into tree structure
export function buildTree(memories: MemoryFile[]): TreeNode[] {
  const root: Record<string, TreeNode> = {};
  
  for (const mem of memories) {
    const parts = mem.filename.split('/');
    if (parts.length === 1) {
      // Root-level file
      root[mem.filename] = {
        id: mem.filename,
        name: mem.filename,
        data: mem,
      };
    } else {
      // Nested file — ensure parent directory node exists
      const dir = parts[0];
      if (!root[dir]) {
        root[dir] = { id: dir, name: dir, children: [] };
      }
      root[dir].children!.push({
        id: mem.filename,
        name: parts.slice(1).join('/'),
        data: mem,
      });
    }
  }
  
  return Object.values(root);
}

function Node({ node, style, dragHandle }: NodeRendererProps<TreeNode>) {
  const isDir = !!node.children;
  const mem = node.data?.data as MemoryFile | undefined;
  
  return (
    <div
      ref={dragHandle}
      style={style}
      className={`flex items-center gap-1.5 px-2 py-1 cursor-pointer rounded text-sm ${
        node.isSelected ? 'bg-primary/10 text-primary' : 'hover:bg-muted'
      }`}
      onClick={() => node.isLeaf && node.select()}
    >
      {isDir ? (
        <>
          <FolderIcon className="h-4 w-4 text-muted-foreground shrink-0" />
          <span>{node.data.name}</span>
          <Badge variant="secondary" className="ml-auto text-xs h-5 min-w-5 flex items-center justify-center">
            {node.children?.length}
          </Badge>
        </>
      ) : (
        <>
          <FileTextIcon className="h-4 w-4 text-muted-foreground shrink-0" />
          <span className="truncate">{node.data.name}</span>
          {mem?.category && (
            <span className={`text-[10px] px-1.5 py-0.5 rounded border ml-auto shrink-0 ${categoryColor(mem.category)}`}>
              {mem.category}
            </span>
          )}
        </>
      )}
    </div>
  );
}

interface MemoryTreeProps {
  memories: MemoryFile[];
  selectedFile: string | null;
  onSelect: (filename: string) => void;
}

export function MemoryTree({ memories, selectedFile, onSelect }: MemoryTreeProps) {
  const treeData = buildTree(memories);
  const containerRef = useRef<HTMLDivElement>(null);
  const { width, height } = useContainerSize(containerRef);
  
  return (
    <div ref={containerRef} className="flex-1 overflow-hidden p-2">
      <Tree
        data={treeData}
        width={width}
        height={height}
        rowHeight={32}
        indent={24}
        selection={selectedFile ?? undefined}
        onSelect={(nodes) => {
          if (nodes.length > 0) {
            onSelect(nodes[0].id);
          }
        }}
      >
        {Node}
      </Tree>
    </div>
  );
}
