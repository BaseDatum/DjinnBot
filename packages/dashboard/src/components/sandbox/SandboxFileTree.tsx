import { useState, useCallback } from 'react';
import { ChevronDown, ChevronRight, FileCode, FileJson, FileText, Folder, Loader2 } from 'lucide-react';
import { FileNode } from '@/types/sandbox';
import { fetchSandboxTree } from '@/lib/api';

interface SandboxFileTreeProps {
  files: FileNode[];
  agentId: string;
  selectedPath: string | null;
  onSelect: (path: string) => void;
  changedPaths?: Set<string>;
}

interface TreeNode {
  name: string;
  path: string;
  isDir: boolean;
  /** null = not yet loaded (lazy), [] = loaded but empty */
  children: TreeNode[] | null;
  file?: {
    path: string;
    size: number;
    modified: number;
    isDir: boolean;
  };
}

function buildTree(files: FileNode[]): TreeNode[] {
  // FileNode from backend already has proper structure with children
  // Just convert to TreeNode format for rendering.
  // children === undefined/null from backend means "not loaded yet" (beyond depth limit).
  return files.map(node => ({
    name: node.name,
    path: node.path,
    isDir: node.type === 'directory',
    children: node.children != null ? buildTree(node.children) : (node.type === 'directory' ? null : []),
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
  agentId,
  onChildrenLoaded,
}: {
  node: TreeNode;
  depth: number;
  selectedPath: string | null;
  onSelect: (path: string) => void;
  changedPaths?: Set<string>;
  agentId: string;
  onChildrenLoaded: (path: string, children: TreeNode[]) => void;
}) {
  const [expanded, setExpanded] = useState(depth < 3);
  const [loading, setLoading] = useState(false);
  const isSelected = selectedPath === node.path;
  const isChanged = changedPaths?.has(node.path);
  const needsLazyLoad = node.isDir && node.children === null;

  const handleToggle = useCallback(async () => {
    if (!expanded && needsLazyLoad) {
      // Lazy-load children from the /sandbox/tree endpoint
      setLoading(true);
      try {
        const tree = await fetchSandboxTree(agentId, node.path);
        const loaded = buildTree(tree.files);
        onChildrenLoaded(node.path, loaded);
      } catch (err) {
        console.error('Failed to load directory:', err);
      } finally {
        setLoading(false);
      }
    }
    setExpanded(!expanded);
  }, [expanded, needsLazyLoad, agentId, node.path, onChildrenLoaded]);

  if (node.isDir) {
    return (
      <div>
        <button
          onClick={handleToggle}
          className="flex w-full items-center gap-1 px-1 py-0.5 text-xs text-zinc-400 hover:text-zinc-300 hover:bg-zinc-800/50 rounded"
          style={{ paddingLeft: `${depth * 12 + 4}px` }}
        >
          {loading ? (
            <Loader2 className="h-3 w-3 flex-shrink-0 animate-spin" />
          ) : expanded ? (
            <ChevronDown className="h-3 w-3 flex-shrink-0" />
          ) : (
            <ChevronRight className="h-3 w-3 flex-shrink-0" />
          )}
          <Folder className="h-3 w-3 flex-shrink-0 text-zinc-500" />
          <span className="truncate">{node.name}</span>
        </button>
        {expanded && node.children &&
          node.children.map((child) => (
            <TreeNodeItem
              key={child.path}
              node={child}
              depth={depth + 1}
              selectedPath={selectedPath}
              onSelect={onSelect}
              changedPaths={changedPaths}
              agentId={agentId}
              onChildrenLoaded={onChildrenLoaded}
            />
          ))}
        {expanded && node.children && node.children.length === 0 && (
          <div
            className="text-xs text-zinc-600 italic"
            style={{ paddingLeft: `${(depth + 1) * 12 + 20}px` }}
          >
            (empty)
          </div>
        )}
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
  agentId,
  selectedPath,
  onSelect,
  changedPaths = new Set(),
}: SandboxFileTreeProps) {
  const [tree, setTree] = useState<TreeNode[]>(() => buildTree(files));

  // Update tree when files prop changes (e.g. refetch)
  const [prevFiles, setPrevFiles] = useState(files);
  if (files !== prevFiles) {
    setPrevFiles(files);
    setTree(buildTree(files));
  }

  // Callback to patch lazy-loaded children into the tree
  const handleChildrenLoaded = useCallback((parentPath: string, children: TreeNode[]) => {
    setTree(prev => patchTree(prev, parentPath, children));
  }, []);

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
          agentId={agentId}
          onChildrenLoaded={handleChildrenLoaded}
        />
      ))}
    </div>
  );
}

/** Recursively patch children into the tree at the given path. */
function patchTree(nodes: TreeNode[], targetPath: string, children: TreeNode[]): TreeNode[] {
  return nodes.map(node => {
    if (node.path === targetPath) {
      return { ...node, children };
    }
    if (node.children && targetPath.startsWith(node.path + '/')) {
      return { ...node, children: patchTree(node.children, targetPath, children) };
    }
    return node;
  });
}
