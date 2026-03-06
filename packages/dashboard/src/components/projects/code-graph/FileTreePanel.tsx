/**
 * FileTreePanel — navigable file tree sidebar for the code knowledge graph.
 *
 * Features:
 *  - Builds tree from graph File/Folder nodes
 *  - Respects the package selector (filters to package prefix)
 *  - Clicking a file highlights its node + direct connections on the graph
 *  - Collapsible directories
 *  - File count badges per directory
 */

import { useState, useMemo, useCallback } from 'react';
import {
  ChevronRight, ChevronDown, File as FileIcon, Folder,
  FolderOpen, PanelLeftClose, PanelLeft,
} from 'lucide-react';
import type { APINode } from './graph-adapter';

interface TreeNode {
  name: string;
  fullPath: string;
  isDir: boolean;
  children: TreeNode[];
  nodeId?: string;     // graph node id for files
  nodeLabel?: string;  // graph node label
  fileCount: number;   // recursive file count for dirs
}

interface FileTreePanelProps {
  nodes: APINode[];
  packagePrefix: string | null;
  onFileSelect: (nodeId: string, filePath: string) => void;
  selectedFilePath: string | null;
}

function buildTree(nodes: APINode[], packagePrefix: string | null): TreeNode {
  const root: TreeNode = { name: 'root', fullPath: '', isDir: true, children: [], fileCount: 0 };

  // Filter to file nodes, apply package prefix
  const fileNodes = nodes.filter(n => {
    if (n.label !== 'File') return false;
    if (packagePrefix && !n.filePath.startsWith(packagePrefix)) return false;
    return true;
  });

  for (const node of fileNodes) {
    let path = node.filePath;
    // Strip package prefix for display
    if (packagePrefix && path.startsWith(packagePrefix)) {
      path = path.slice(packagePrefix.length);
    }

    const parts = path.split('/').filter(Boolean);
    let current = root;

    for (let i = 0; i < parts.length; i++) {
      const isLast = i === parts.length - 1;
      const partName = parts[i];
      const fullPath = parts.slice(0, i + 1).join('/');

      let child = current.children.find(c => c.name === partName);
      if (!child) {
        child = {
          name: partName,
          fullPath: packagePrefix ? packagePrefix + fullPath : fullPath,
          isDir: !isLast,
          children: [],
          nodeId: isLast ? node.id : undefined,
          nodeLabel: isLast ? node.label : undefined,
          fileCount: 0,
        };
        current.children.push(child);
      }
      if (isLast) {
        child.nodeId = node.id;
        child.nodeLabel = node.label;
      }
      current = child;
    }
  }

  // Sort: dirs first, then alpha
  const sortTree = (node: TreeNode) => {
    node.children.sort((a, b) => {
      if (a.isDir !== b.isDir) return a.isDir ? -1 : 1;
      return a.name.localeCompare(b.name);
    });
    node.children.forEach(sortTree);
  };
  sortTree(root);

  // Compute file counts
  const countFiles = (node: TreeNode): number => {
    if (!node.isDir) return 1;
    node.fileCount = node.children.reduce((sum, c) => sum + countFiles(c), 0);
    return node.fileCount;
  };
  countFiles(root);

  return root;
}

export function FileTreePanel({ nodes, packagePrefix, onFileSelect, selectedFilePath }: FileTreePanelProps) {
  const [collapsed, setCollapsed] = useState(false);
  const [expandedDirs, setExpandedDirs] = useState<Set<string>>(new Set());

  const tree = useMemo(() => buildTree(nodes, packagePrefix), [nodes, packagePrefix]);

  // Auto-expand top-level dirs
  useMemo(() => {
    const topLevel = new Set<string>();
    tree.children.forEach(c => {
      if (c.isDir) topLevel.add(c.fullPath);
    });
    setExpandedDirs(topLevel);
  }, [tree]);

  const toggleDir = useCallback((path: string) => {
    setExpandedDirs(prev => {
      const next = new Set(prev);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
  }, []);

  if (collapsed) {
    return (
      <div className="h-full w-10 bg-background border-r border-border flex flex-col items-center py-2 shrink-0">
        <button
          onClick={() => setCollapsed(false)}
          className="p-1.5 text-muted-foreground hover:text-foreground rounded transition-colors"
          title="Show File Tree"
        >
          <PanelLeft className="w-4 h-4" />
        </button>
      </div>
    );
  }

  return (
    <div className="h-full w-56 min-w-[200px] max-w-[280px] bg-background border-r border-border flex flex-col shrink-0">
      {/* Header */}
      <div className="flex items-center justify-between px-2.5 py-2 border-b border-border">
        <div className="flex items-center gap-1.5">
          <Folder className="w-3.5 h-3.5 text-muted-foreground" />
          <span className="text-xs font-semibold text-foreground">Files</span>
          <span className="text-[10px] text-muted-foreground">
            ({tree.fileCount})
          </span>
        </div>
        <button
          onClick={() => setCollapsed(true)}
          className="p-1 text-muted-foreground hover:text-foreground rounded transition-colors"
        >
          <PanelLeftClose className="w-3.5 h-3.5" />
        </button>
      </div>

      {/* Tree */}
      <div className="flex-1 overflow-y-auto overflow-x-hidden text-xs py-1">
        {tree.children.map(child => (
          <TreeItem
            key={child.fullPath}
            node={child}
            depth={0}
            expandedDirs={expandedDirs}
            onToggleDir={toggleDir}
            onFileSelect={onFileSelect}
            selectedFilePath={selectedFilePath}
          />
        ))}
        {tree.children.length === 0 && (
          <div className="px-3 py-4 text-muted-foreground text-center">
            No files found
          </div>
        )}
      </div>
    </div>
  );
}

function TreeItem({
  node,
  depth,
  expandedDirs,
  onToggleDir,
  onFileSelect,
  selectedFilePath,
}: {
  node: TreeNode;
  depth: number;
  expandedDirs: Set<string>;
  onToggleDir: (path: string) => void;
  onFileSelect: (nodeId: string, filePath: string) => void;
  selectedFilePath: string | null;
}) {
  const isExpanded = expandedDirs.has(node.fullPath);
  const isSelected = selectedFilePath === node.fullPath;
  const indent = depth * 12 + 4;

  if (node.isDir) {
    return (
      <>
        <button
          onClick={() => onToggleDir(node.fullPath)}
          className="w-full flex items-center gap-1 py-[3px] hover:bg-muted/50 transition-colors text-left"
          style={{ paddingLeft: indent }}
        >
          {isExpanded ? (
            <ChevronDown className="w-3 h-3 text-muted-foreground shrink-0" />
          ) : (
            <ChevronRight className="w-3 h-3 text-muted-foreground shrink-0" />
          )}
          {isExpanded ? (
            <FolderOpen className="w-3.5 h-3.5 text-blue-400 shrink-0" />
          ) : (
            <Folder className="w-3.5 h-3.5 text-blue-400 shrink-0" />
          )}
          <span className="truncate text-foreground">{node.name}</span>
          <span className="ml-auto pr-2 text-[10px] text-muted-foreground">{node.fileCount}</span>
        </button>
        {isExpanded && node.children.map(child => (
          <TreeItem
            key={child.fullPath}
            node={child}
            depth={depth + 1}
            expandedDirs={expandedDirs}
            onToggleDir={onToggleDir}
            onFileSelect={onFileSelect}
            selectedFilePath={selectedFilePath}
          />
        ))}
      </>
    );
  }

  return (
    <button
      onClick={() => node.nodeId && onFileSelect(node.nodeId, node.fullPath)}
      className={`w-full flex items-center gap-1 py-[3px] transition-colors text-left ${
        isSelected
          ? 'bg-primary/10 text-primary'
          : 'hover:bg-muted/50 text-foreground/80'
      }`}
      style={{ paddingLeft: indent + 16 }}
    >
      <FileIcon className="w-3 h-3 text-muted-foreground shrink-0" />
      <span className="truncate">{node.name}</span>
    </button>
  );
}
