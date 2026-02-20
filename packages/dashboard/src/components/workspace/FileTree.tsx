import { useState } from 'react';
import { ChevronDown, ChevronRight, FileCode, FileJson, FileText, Folder } from 'lucide-react';

interface FileEntry {
  path: string;
  size: number;
  modified: number;
}

interface FileTreeProps {
  files: FileEntry[];
  selectedPath: string | null;
  changedPaths: Set<string>;
  onSelect: (path: string) => void;
}

interface TreeNode {
  name: string;
  path: string;
  isDir: boolean;
  children: TreeNode[];
  file?: FileEntry;
}

function buildTree(files: FileEntry[]): TreeNode[] {
  const root: TreeNode[] = [];
  
  for (const file of files) {
    const parts = file.path.split('/');
    let current = root;
    
    for (let i = 0; i < parts.length; i++) {
      const name = parts[i];
      const isLast = i === parts.length - 1;
      const path = parts.slice(0, i + 1).join('/');
      
      let node = current.find(n => n.name === name);
      if (!node) {
        node = { name, path, isDir: !isLast, children: [], file: isLast ? file : undefined };
        current.push(node);
      }
      current = node.children;
    }
  }
  
  const sort = (nodes: TreeNode[]) => {
    nodes.sort((a, b) => {
      if (a.isDir !== b.isDir) return a.isDir ? -1 : 1;
      return a.name.localeCompare(b.name);
    });
    nodes.forEach(n => sort(n.children));
  };
  sort(root);
  return root;
}

function getFileIcon(name: string) {
  if (name.endsWith('.json')) return FileJson;
  if (name.match(/\.(ts|tsx|js|jsx|py|rs|go|rb|java|c|cpp|h)$/)) return FileCode;
  return FileText;
}

function TreeNodeItem({ node, depth, selectedPath, changedPaths, onSelect }: {
  node: TreeNode; depth: number; selectedPath: string | null; changedPaths: Set<string>; onSelect: (path: string) => void;
}) {
  const [expanded, setExpanded] = useState(depth < 2);
  const isChanged = changedPaths.has(node.path);
  const isSelected = selectedPath === node.path;
  
  if (node.isDir) {
    return (
      <div>
        <button
          onClick={() => setExpanded(!expanded)}
          className="flex w-full items-center gap-1 px-1 py-0.5 text-xs text-zinc-400 hover:text-zinc-300 hover:bg-zinc-800/50 rounded"
          style={{ paddingLeft: `${depth * 12 + 4}px` }}
        >
          {expanded ? <ChevronDown className="h-3 w-3 flex-shrink-0" /> : <ChevronRight className="h-3 w-3 flex-shrink-0" />}
          <Folder className="h-3 w-3 flex-shrink-0 text-zinc-500" />
          <span className="truncate">{node.name}</span>
        </button>
        {expanded && node.children.map(child => (
          <TreeNodeItem key={child.path} node={child} depth={depth + 1} selectedPath={selectedPath} changedPaths={changedPaths} onSelect={onSelect} />
        ))}
      </div>
    );
  }
  
  const Icon = getFileIcon(node.name);
  return (
    <button
      onClick={() => onSelect(node.path)}
      className={`flex w-full items-center gap-1 px-1 py-0.5 text-xs rounded ${
        isSelected ? 'bg-zinc-700 text-zinc-200' : 'text-zinc-400 hover:text-zinc-300 hover:bg-zinc-800/50'
      }`}
      style={{ paddingLeft: `${depth * 12 + 4}px` }}
    >
      <Icon className="h-3 w-3 flex-shrink-0" />
      <span className="truncate">{node.name}</span>
      {isChanged && <span className="ml-auto h-1.5 w-1.5 rounded-full bg-amber-400 flex-shrink-0" />}
    </button>
  );
}

export function FileTree({ files, selectedPath, changedPaths, onSelect }: FileTreeProps) {
  const tree = buildTree(files);
  
  if (files.length === 0) {
    return <div className="p-4 text-xs text-zinc-500 text-center">No files yet</div>;
  }
  
  return (
    <div className="py-1">
      {tree.map(node => (
        <TreeNodeItem key={node.path} node={node} depth={0} selectedPath={selectedPath} changedPaths={changedPaths} onSelect={onSelect} />
      ))}
    </div>
  );
}
