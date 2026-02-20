import { useState } from 'react';
import { ChevronDown, ChevronRight, FileCode, FileJson, FileText, Folder } from 'lucide-react';
import { FileNode } from '@/types/sandbox';

interface SandboxFileTreeProps {
  files: FileNode[];
  selectedPath: string | null;
  onSelect: (path: string) => void;
  changedPaths?: Set<string>;
}

interface TreeNode {
  name: string;
  path: string;
  isDir: boolean;
  children: TreeNode[];
  file?: {
    path: string;
    size: number;
    modified: number;
    isDir: boolean;
  };
}

function buildTree(files: FileNode[]): TreeNode[] {
  // FileNode from backend already has proper structure with children
  // Just convert to TreeNode format for rendering
  return files.map(node => ({
    name: node.name,
    path: node.path,
    isDir: node.type === 'directory',
    children: node.children ? buildTree(node.children) : [],
    file: node.type === 'file' ? {
      path: node.path,
      size: node.size || 0,
      modified: node.modified || 0,
      isDir: false
    } : undefined
  }));
}

function getFileIcon(name: string) {
  if (name.endsWith('.json')) return FileJson;
  if (name.match(/\.(ts|tsx|js|jsx|py|rs|go|rb|java|c|cpp|h)$/)) return FileCode;
  return FileText;
}

function TreeNodeItem({
  node,
  depth,
  selectedPath,
  onSelect,
  changedPaths,
}: {
  node: TreeNode;
  depth: number;
  selectedPath: string | null;
  onSelect: (path: string) => void;
  changedPaths?: Set<string>;
}) {
  const [expanded, setExpanded] = useState(depth < 3);
  const isSelected = selectedPath === node.path;
  const isChanged = changedPaths?.has(node.path);

  if (node.isDir) {
    return (
      <div>
        <button
          onClick={() => setExpanded(!expanded)}
          className="flex w-full items-center gap-1 px-1 py-0.5 text-xs text-zinc-400 hover:text-zinc-300 hover:bg-zinc-800/50 rounded"
          style={{ paddingLeft: `${depth * 12 + 4}px` }}
        >
          {expanded ? (
            <ChevronDown className="h-3 w-3 flex-shrink-0" />
          ) : (
            <ChevronRight className="h-3 w-3 flex-shrink-0" />
          )}
          <Folder className="h-3 w-3 flex-shrink-0 text-zinc-500" />
          <span className="truncate">{node.name}</span>
        </button>
        {expanded &&
          node.children.map((child) => (
            <TreeNodeItem
              key={child.path}
              node={child}
              depth={depth + 1}
              selectedPath={selectedPath}
              onSelect={onSelect}
              changedPaths={changedPaths}
            />
          ))}
      </div>
    );
  }

  const Icon = getFileIcon(node.name);
  return (
    <button
      onClick={() => onSelect(node.path)}
      className={`flex w-full items-center gap-1 px-1 py-0.5 text-xs rounded ${
        isSelected
          ? 'bg-zinc-700 text-zinc-200'
          : 'text-zinc-400 hover:text-zinc-300 hover:bg-zinc-800/50'
      }`}
      style={{ paddingLeft: `${depth * 12 + 20}px` }}
    >
      <Icon className="h-3 w-3 flex-shrink-0" />
      <span className="truncate">{node.name}</span>
      {isChanged && (
        <span className="ml-auto h-1.5 w-1.5 rounded-full bg-amber-400 flex-shrink-0" />
      )}
    </button>
  );
}

export function SandboxFileTree({
  files,
  selectedPath,
  onSelect,
  changedPaths = new Set(),
}: SandboxFileTreeProps) {
  const tree = buildTree(files);

  if (files.length === 0) {
    return (
      <div className="p-4 text-xs text-zinc-500 text-center">
        Sandbox is empty
      </div>
    );
  }

  return (
    <div className="py-1">
      {tree.map((node) => (
        <TreeNodeItem
          key={node.path}
          node={node}
          depth={0}
          selectedPath={selectedPath}
          onSelect={onSelect}
          changedPaths={changedPaths}
        />
      ))}
    </div>
  );
}
